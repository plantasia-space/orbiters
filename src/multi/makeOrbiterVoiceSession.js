/**
 * @file src/multi/makeOrbiterVoiceSession.js
 * @description The per-voice factory `createMultiOrbiterApp` calls for each roster entry.
 * Every voice boots the FULL orbiter via `createOrbitersApp`, but instead of owning its own canvas +
 * WebGL context (the N-canvas spike, where only voice-0 could texture), all voices share the realm's
 * ONE renderer + ONE canvas via the `renderHost` (ViewportCompositor). The host hands this voice a
 * grid CELL (geometry only) and the shared renderer; the voice contributes its scene+camera and the
 * host renders it into that cell's scissor-rect viewport each frame. Audio mixes into the shared
 * `MultiOrbiterAudioHost` bus; lifecycle is owned by the shell (`installLifecycle:false`).
 *
 * Part B (G2): each voice now mounts its FULL orbiter interface into its own cell
 * (`mountChrome:true` + `uiContainer:cell`), bound to its own voice's engine context. The primary
 * (index 0) owns the realm-global UI side effects.
 */
import { createOrbitersApp } from '../orbitersApp.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { disposeVoiceMetronome } from '../audio/metronome.js';
import { createVoiceLoadOverlay } from './VoiceLoadOverlay.js';
import { LOAD_ERROR_EVENT } from '../boot/loadProgress.js';

// Per-voice boot deadline. A voice whose load silently stalls (e.g. a failed track fetch
// that never fires session-ready) used to hang the whole realm forever with zero feedback; now it
// gets this long to finish, then its tile shows an error state and the rest of the realm proceeds.
// Generous on purpose: with live per-tile progress a slow load is visible, not mysterious.
export const VOICE_LOAD_TIMEOUT_MS = 60_000;

/**
 * @param {object} ctx supplied by createMultiOrbiterApp.
 * @param {{voiceId: string, trackId: string, orbiterId?: string, entangledWorldId?: string}} ctx.entry
 * @param {number} ctx.index roster index.
 * @param {number} ctx.total roster length (grid sizing).
 * @param {*} ctx.outputNode the shared master bus (host.getInputNode()).
 * @param {*} ctx.renderHost the realm's ViewportCompositor (ONE renderer + canvas + render loop).
 * @returns {import('./createMultiOrbiterApp.js').VoiceSession}
 */
export function makeOrbiterVoiceSession({ entry, index, total, outputNode, renderHost }) {
  if (!renderHost) {
    throw new Error('makeOrbiterVoiceSession: a renderHost (ViewportCompositor) is required');
  }
  const cell = renderHost.createCell(index, total);

  // Each voice gets its OWN session event bus so world/texture signals don't cross-talk
  // between voices in the shared realm (single-orbiter keeps the default `window`). The
  // voice's load-progress events ride the same bus, so the tile overlay below is per-voice for free.
  const eventBus = new EventTarget();

  // Per-tile loading feedback — the same steps + download counters the single-orbiter
  // overlay shows, per voice, fading out as THIS voice becomes ready (progressive reveal).
  const loadOverlay = createVoiceLoadOverlay({ cell, eventBus });

  const app = createOrbitersApp({
    voiceId: entry.voiceId,
    outputNode,
    installLifecycle: false,
    // Share the realm's ONE canvas + renderer: the compositor paints this voice into `cell`'s viewport.
    canvasEl: renderHost.canvas,
    sharedRenderer: renderHost.renderer,
    // Each tile gets its FULL orbiter interface, mounted into its own cell and bound to
    // its own voice. The 3D scene is framed per-cell by the compositor (sharedRenderer), so chrome
    // here no longer triggers fullscreen viewport framing. The primary (index 0) owns realm-global
    // UI side effects (the data-ui-react body attr + .dark class).
    mountChrome: true,
    uiContainer: cell,
    isPrimary: index === 0,
    sharedRealm: true,
    eventBus,
    sessionDescriptor: {
      trackId: entry.trackId,
      orbiterId: entry.orbiterId,
      entangledWorldId: entry.entangledWorldId,
    },
  });

  // Register this voice's scene+camera with the compositor so its render loop draws it into `cell`.
  renderHost.addVoice({ voiceId: app.voiceId, cell, controller: app.worldController });

  // Click-to-focus is owned by the realm shell (createMultiOrbiterApp) as ONE
  // geometry-based pointerdown that focuses the tile UNDER the pointer — so a click ANYWHERE in a tile
  // (the planet / canvas centre included) focuses it, not just its interactive chrome. A per-cell
  // listener here couldn't see clicks on the shared canvas (the cell is `pointer-events:none`), which
  // was why clicking a tile's centre didn't focus it.

  // Observable per-voice boot. `start()` keeps its quick-kick contract (the collection
  // reconcile awaits it serially — it must not block on a full load), but it also arms a deadline
  // watcher, and `settled` resolves at ready-or-deadline. The realm shell's admission control
  // awaits `settled`, so one stuck voice frees its boot slot after the timeout instead of wedging
  // the queue forever (the old fire-and-forget start made completion unobservable).
  let settled = null;
  let sessionDisposed = false;
  let deadlineTimer = null;
  function watchReady() {
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ ok: false, timedOut: true }), VOICE_LOAD_TIMEOUT_MS);
    });
    return Promise.race([app.whenReady, deadline]).then((result) => {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
      if (sessionDisposed) return result;
      if (result?.timedOut) {
        // Surface it on the voice's own channel: the tile overlay shows the error state. If the
        // voice DOES finish later, its completion tick clears the overlay again (self-healing).
        try {
          eventBus.dispatchEvent(
            new CustomEvent(LOAD_ERROR_EVENT, { detail: { voiceId: app.voiceId, timedOut: true } }),
          );
        } catch (_) {}
        console.warn(`[multi] voice "${app.voiceId}" did not become ready within ${VOICE_LOAD_TIMEOUT_MS}ms`);
      }
      return result;
    });
  }
  function start() {
    if (!settled) {
      app.start();
      settled = watchReady();
    }
    return undefined;
  }

  return {
    voiceId: app.voiceId,
    parameterManager: app.parameterManager,
    start,
    // Resolves `{ok}` at ready-or-deadline; null until `start()` is called.
    get settled() {
      return settled;
    },
    suspend: app.suspend,
    resume: app.resume,
    dispose: () => {
      // A voice removed mid-boot must not fire its deadline later (spurious error on a dead bus).
      sessionDisposed = true;
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      try {
        app.dispose?.();
      } finally {
        // If this voice had sync on, clear it and reconcile the shared coordinator — removing
        // the only synced voice must release sync, not leave the coordinator stuck enabled.
        voiceRegistry.get(app.voiceId)?.deck?.dispose();
        // Tear down this voice's metronome stream here — a DISABLED stream never pumps, so it would
        // never notice the missing registry entry and self-dispose; teardown is the explicit owner.
        disposeVoiceMetronome(app.voiceId);
        renderHost.removeVoice(app.voiceId);
        loadOverlay.dispose();
      }
    },
  };
}
