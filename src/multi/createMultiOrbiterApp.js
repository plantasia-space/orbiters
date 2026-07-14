/**
 * @file src/multi/createMultiOrbiterApp.js
 * @description The multi-orbiter composition owner + shell. For multi-orbiter views
 * (feed, mixed collection) this boots N orbiter "voices" in ONE iframe/realm sharing ONE
 * `AudioContext` and ONE master limiter (`MultiOrbiterAudioHost`). It is the composition layer over
 * A1 (shared master bus) + A2 (de-singletonized per-voice state on the realm `voiceRegistry`); it
 * adds NO new audio capability — it instantiates the per-voice unit N times against one host.
 *
 * Chosen only via `?multi=1` + a valid `?roster=` (see urlParams + decisions/0001-A3-build-plan.md);
 * the single-orbiter boot path is untouched.
 *
 *   voice[0] (primary)  → full orbiter session (scene + React UI + audio), the focused/active voice
 *   voice[1..n] (audio) → audio-only session (no scene, no second React root) mixed into the host
 *
 * The shell owns the ONE set of page-lifecycle handlers (today each `createOrbitersApp` installs its
 * own; N of those would double-register and the `{once:true}` beforeunload would drop all-but-one
 * voice). On teardown each voice disposes its own adapter and UNREGISTERS its own voiceId from the
 * realm registry — never `voiceRegistry.clear()`, which would wipe the whole realm.
 *
 * The per-voice session factory is injected (`makeVoiceSession`) so the owner's orchestration —
 * one host, N voices, shared lifecycle, clean teardown — is unit-testable without a real
 * AudioContext or DOM; Main.js supplies the real factory.
 *
 * @typedef {Object} VoiceSession a per-voice handle the factory returns.
 * @property {string} voiceId the voice's stable registry key.
 * @property {() => (void|Promise<void>)} [start] kick the voice's boot.
 * @property {() => void} [suspend] release visual/idle resources (no-op for audio-only voices).
 * @property {() => void} [resume] restore after suspend.
 * @property {() => void} [dispose] tear down the voice's own resources (adapter, etc.).
 */
import { MultiOrbiterAudioHost } from '../audio/MultiOrbiterAudioHost.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { hideLoadingScreen } from '../boot/loadingScreen.js';
import { isCaptureWindow, bootCaptureWindow } from '../export/captureWindow.js';

// Admission control — how many voice boot pipelines run at once. Each boot is a full
// pipeline (release fetch → GLB download+transcode → audio download+decode); fanning ALL of them
// out at once thrashed network/CPU/GPU on mobile instead of parallelizing. Two in flight keeps the
// pipe busy while the focused (first) tile finishes first — and gives the one-by-one progressive
// reveal instead of "nothing… nothing… everything".
export const MAX_CONCURRENT_VOICE_BOOTS = 2;

/**
 * @param {object} opts
 * @param {Array<object>} opts.roster ordered voice descriptors (see getRosterFromUrl). Non-empty.
 * @param {(ctx: {entry: object, index: number, isPrimary: boolean, host: MultiOrbiterAudioHost, outputNode: *, renderHost: *}) => (VoiceSession|null)} opts.makeVoiceSession
 *   builds one voice session bound to the shared host. Index 0 is the primary (full) voice.
 * @param {() => MultiOrbiterAudioHost} [opts.createHost] host factory (injectable for tests).
 * @param {(() => *)|null} [opts.createRenderHost] render-host factory (ViewportCompositor:
 *   ONE renderer + canvas + render loop for the realm). Injectable + DOM-free for tests (default null →
 *   no shared renderer; the audio-only / unit-test paths don't need one).
 * @param {Window|EventTarget|null} [opts.windowTarget] lifecycle event target (defaults to window).
 * @param {Document|EventTarget|null} [opts.documentTarget] visibility event target (defaults to document).
 * @returns {{ host: MultiOrbiterAudioHost, voices: VoiceSession[], start: () => Promise<void>, dispose: () => void }}
 */
export function createMultiOrbiterApp({
  roster,
  makeVoiceSession,
  createHost = () => new MultiOrbiterAudioHost(),
  createRenderHost = null,
  windowTarget = typeof window !== 'undefined' ? window : null,
  documentTarget = typeof document !== 'undefined' ? document : null,
}) {
  // An EMPTY roster is allowed: the realm boots with its shared host + renderHost + lifecycle and zero
  // voices, and voices are added later via `addVoice` (collection mode starts with empty stages and fills
  // them on drag). A non-array is still a programming error.
  if (!Array.isArray(roster)) {
    throw new Error('createMultiOrbiterApp: roster must be an array');
  }
  if (typeof makeVoiceSession !== 'function') {
    throw new Error('createMultiOrbiterApp: makeVoiceSession must be a function');
  }

  const host = createHost();
  // The realm's ONE renderer + canvas + render loop. Like the audio host, it is a shared
  // realm resource (one per tab) the shell owns and tears down. Null when not provided (audio-only
  // / unit tests) — the per-voice factory decides whether it requires one.
  const renderHost = typeof createRenderHost === 'function' ? createRenderHost() : null;
  const voices = [];
  let started = false;
  let disposed = false;
  let lifecycleInstalled = false;

  // Build one voice session bound to the shared master bus. A factory that returns null (a voice that
  // failed to construct) yields null so one bad entry can't sink the realm. `index` is the voice's slot
  // position; `total` is the current voice count (grid sizing for the default √n host — collection mode
  // ignores it, its layout owns geometry).
  function buildVoice(entry, index, total) {
    return (
      makeVoiceSession({
        entry,
        index,
        total,
        isPrimary: index === 0,
        host,
        outputNode: host.getInputNode(),
        renderHost,
      }) || null
    );
  }

  for (let index = 0; index < roster.length; index++) {
    const session = buildVoice(roster[index], index, roster.length);
    if (session) voices.push(session);
  }

  // Body-portalled chrome (header menus, Cosmic/Interaction menus, dialogs) used to theme
  // via a documentElement mirror of the focused tile's colors, because those portals rendered on
  // <body> outside every cell. `PortalContainerProvider` (src/ui/react/PortalContainerProvider.tsx)
  // replaced that: every voice now portals into its OWN themed container, so no realm-level mirror
  // is needed — the visible focus marker itself is owned per-tile in React (MultiOrbiterFocusFrame).

  // Click-to-focus is no longer a realm-level geometry hit-test. Each voice's cell is its own
  // interactive surface (pointer-events:auto), and the voice's CameraController focuses it on pointerdown
  // (voiceRegistry.setActive) — DOM hit-testing routes the event to the right cell, respecting clipping
  // and stacking. The document-capture listener + renderHost.voiceIdAtPoint are gone.

  function forEachVoice(method) {
    for (let i = 0; i < voices.length; i++) {
      const fn = voices[i]?.[method];
      if (typeof fn === 'function') {
        try {
          fn.call(voices[i]);
        } catch (error) {
          console.warn(`[multi] voice "${voices[i]?.voiceId}" ${method}() failed`, error);
        }
      }
    }
  }

  // ONE shared set of page-lifecycle handlers (the shell owns lifecycle, not the per-voice apps).
  function installLifecycle() {
    if (lifecycleInstalled || !windowTarget || !documentTarget) return;
    lifecycleInstalled = true;

    documentTarget.addEventListener(
      'visibilitychange',
      () => {
        if (documentTarget.visibilityState === 'hidden') forEachVoice('suspend');
        else forEachVoice('resume');
      },
      { passive: true },
    );
    windowTarget.addEventListener('pagehide', () => forEachVoice('suspend'), { passive: true });
    windowTarget.addEventListener(
      'pageshow',
      (event) => {
        if (event?.persisted) forEachVoice('resume');
      },
      { passive: true },
    );
    // NOT {once:true}: dispose must run for EVERY voice, and a bfcache restore can fire pageshow
    // after a pagehide without a real unload.
    windowTarget.addEventListener('beforeunload', () => dispose(), { passive: true });
  }

  async function start() {
    if (started || disposed) return;
    started = true;
    installLifecycle();
    // The per-tile overlays own loading feedback from here on — the ONE global boot
    // overlay (which N voices used to fight over) hands off as soon as the tiles exist. Voices
    // never touch it in the shared realm (their reporters are per-voice).
    if (typeof document !== 'undefined') {
      hideLoadingScreen();
    }
    // Staged boot instead of unbounded fan-out. Roster order (voice 0 = the default
    // focus) with MAX_CONCURRENT_VOICE_BOOTS pipelines in flight: the focused tile completes
    // first and tiles reveal progressively. `voice.start()` resolves at ready-or-deadline
    // (makeOrbiterVoiceSession), so a stuck voice releases its boot slot after its timeout and
    // can never wedge the queue. The per-voice try/catch keeps one failure from sinking siblings.
    const queue = voices.slice();
    async function bootWorker() {
      while (queue.length > 0 && !disposed) {
        const voice = queue.shift();
        let result = null;
        try {
          await voice.start?.();
          // A full orbiter voice exposes `settled` (ready-or-deadline); await it so this boot slot
          // is held until the voice actually finishes (or times out). Sessions without it (audio-
          // only voices, test fakes) keep the old kick-and-continue behavior.
          if (voice?.settled) result = await voice.settled;
        } catch (error) {
          console.error(`[multi] voice "${voice?.voiceId}" failed to start`, error);
        }
        // The realm is usable as soon as ONE voice actually comes up. `data-ui-ready` used to be
        // set (on the shared <body>) by whichever voice's global loading-state write happened to
        // land; with per-voice reporters the shell owns it explicitly — and only on success, so a
        // realm where every voice errored doesn't present itself as ready.
        if (result?.ok && typeof document !== 'undefined' && document.body) {
          document.body.setAttribute('data-ui-ready', 'true');
        }
      }
    }
    const workerCount = Math.min(MAX_CONCURRENT_VOICE_BOOTS, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => bootWorker()));

    // A STANDALONE realm capture window — `?…&capture=<aspect>` on the collection / multi URL —
    // arms the capture machinery ONCE here (window sizing + auto-record when the realm is ready), the
    // realm-level analogue of the single-orbiter arming in `orbitersApp`. Skipped when the engine is
    // EMBEDDED in a host page (the feed realm sets `window.ORBITER_APP_URL`): there RECORD opens a
    // separate standalone orbiter window rather than capturing the host page. Collection starts empty,
    // so `bootCaptureWindow` waits on `data-ui-ready` — set when the first stage is filled (`addVoice`).
    const embedded = typeof window !== 'undefined' && Boolean(window.ORBITER_APP_URL);
    if (isCaptureWindow() && !embedded) {
      bootCaptureWindow();
    }
  }

  /**
   * Add one voice to the running realm at slot `index` (default: append). Direct realm mutation — no
   * reload, no audio cut for the OTHER voices; the new voice's own audio ramps in as it boots. Used by
   * collection mode when a slot is filled or the visible slot count grows (decisions/0004). Returns the
   * new voice's id, or null if it failed to construct / the realm is disposed.
   */
  async function addVoice(entry, index = voices.length) {
    if (disposed || !entry) return null;
    const session = buildVoice(entry, index, voices.length + 1);
    if (!session) return null;
    voices.push(session);
    if (started) {
      try {
        await session.start?.();
      } catch (error) {
        console.error(`[multi] voice "${session?.voiceId}" failed to start`, error);
      }
      // The realm is ready as soon as ANY voice comes up — the initial boot queue marks this, but a
      // voice added by a drag (collection mode starts empty) must too, so a capture window waiting on
      // `data-ui-ready` fires once the first stage is filled. Gate on the voice actually SETTLING ok
      // (the same contract the boot queue uses) so a failed/never-ready drag can't trip a capture into
      // recording a broken stage — done off `settled` so it never blocks the reconcile's `await`.
      Promise.resolve(session.settled)
        .then((result) => {
          if (result?.ok && session.voiceId && typeof document !== 'undefined' && document.body) {
            document.body.setAttribute('data-ui-ready', 'true');
          }
        })
        .catch(() => {});
    }
    return session.voiceId ?? null;
  }

  /**
   * Remove one voice from the running realm by id. Disposes the voice's own resources (adapter, scene,
   * UI) and unregisters it from the realm registry — sibling voices are untouched. Used by collection
   * mode when a slot is cleared or the visible slot count shrinks.
   */
  function removeVoice(voiceId) {
    if (!voiceId) return false;
    const idx = voices.findIndex((v) => v?.voiceId === voiceId);
    if (idx === -1) return false;
    const [voice] = voices.splice(idx, 1);
    try {
      voice?.dispose?.();
    } catch (error) {
      console.warn(`[multi] voice "${voiceId}" dispose() failed`, error);
    }
    if (voiceRegistry.has(voiceId)) voiceRegistry.unregister(voiceId);
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i];
      try {
        voice?.dispose?.();
      } catch (error) {
        console.warn(`[multi] voice "${voice?.voiceId}" dispose() failed`, error);
      }
      // Per-voice unregister — the host never clears the realm (that would wipe sibling voices).
      if (voice?.voiceId && voiceRegistry.has(voice.voiceId)) {
        voiceRegistry.unregister(voice.voiceId);
      }
    }
    // Tear down the shared renderer after the voices (each voice unregistered itself from it above).
    try {
      renderHost?.dispose?.();
    } catch (error) {
      console.warn('[multi] renderHost dispose() failed', error);
    }
    host.dispose();
  }

  return { host, voices, start, dispose, addVoice, removeVoice, renderHost };
}
