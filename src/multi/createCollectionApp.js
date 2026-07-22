/**
 * @file src/multi/createCollectionApp.js
 * @description Boots the multi-stage Orbiter Studio loaded from a collection (decisions/0004).
 * Ties the React stage layout (`MultiStageStudio`) to the existing multi-orbiter realm
 * (`createMultiOrbiterApp` + `ViewportCompositor`, fed the stages as its cells) so a whole collection
 * composes in ONE DOM / ONE AudioContext with NO host bridge:
 *
 *   - roster + permissions + saved layout come from the collection-data client (stubbed today);
 *   - the React layout owns the stage geometry — the compositor reads each stage's rect, so resize is free;
 *   - focus is `voiceRegistry` (the stage ↔ voice mapping lives here; the layout stays voice-agnostic);
 *   - changing the visible stage count reconciles the realm's voices to that count (direct add/remove,
 *     no reload, no audio cut for surviving voices);
 *   - edit affordances are gated on `canEdit`; persist is a one-shot authed write.
 *
 * The realm-level audio unlock is the app-wide one armed in `installEnvGuards` (first user gesture) — one
 * unlock for the whole realm, never per-voice.
 */
import { createMultiOrbiterApp } from './createMultiOrbiterApp.js';
import { createViewportCompositor } from './renderHost.js';
import { clampSubtype, defaultSubtype } from './stageGeometry.js';
import { buildDesiredArrangement, moveEntryBefore, planReconcile, swapDescriptor } from './stageArrangement.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { MIDIControllerInstance } from '../input/midi/MIDIController.js';
import { saveCollectionLayout } from '../api/collectionDataService.js';
import { primeTrackReleaseCache, primeOrbiterReleaseCache, primeWorldReleaseCache, fetchTrackRelease, fetchOrbiterRelease, fetchEntangledWorldRelease } from '../api/dataManager/loaders.js';
import { mountMultiStageStudio } from '../ui/react/studio/MultiStageStudio.tsx';
import { hideLoadingScreen } from '../boot/loadingScreen.js';
import { LOAD_PROGRESS_EVENT, LOAD_ERROR_EVENT } from '../boot/loadProgress.js';
import { isAutofocusEnabled } from '../input/midi/autofocusSettings.js';
import { KeyboardController } from '../input/KeyboardController.js';

// Every voice in the realm plays over a TRACK audio spine, and the TRACK is the only entity that
// carries related entities — a track has a world and an orbiter. Orbiters and worlds each stand on
// their own and carry no audio: a world release is visuals only, and an orbiter is an instrument,
// not a recording. The linked ids on an orbiter release name the session its author built and
// tested it against — an editing reference, never a playback input — so they are not read here.
// That makes "bootable" (can this card start a stage by itself) exactly "is it a track". Every
// other card is still fully draggable onto an OCCUPIED stage, where it swaps only its own dimension
// of that live session (see `swapStage`).
function isBootableEntry(entry) {
  return Boolean(entry?.trackId);
}

// Bounded background release warm-up (see `prefetchReleases`). At `hydrationLevel=1` the collection
// fetch carries cards only, so a release is fetched lazily on drag-to-stage. To keep an early drag from
// paying mycelium's slow per-item hydration, warm the cache for the first few drawer entries after the
// studio is up — capped in count and concurrency so it can never stampede the server or crowd out a
// real drag's fetch.
const PREFETCH_LIMIT = 6;
const PREFETCH_CONCURRENCY = 2;

// Shell MIDI targets (slot focus/add, pager, drawer), persisted per collection. Enabled by
// default; the env var is the build-time kill switch (Vite inlines it, so flipping it means a
// rebuild — same trade every VITE_ flag makes).
const COLLECTION_SHELL_MIDI_ENABLED = import.meta.env?.VITE_DISABLE_COLLECTION_SHELL_MIDI !== 'true';

/** Render a plain full-screen message (no-access / not-found / empty) instead of a broken realm. */
export function renderMessage(text) {
  hideLoadingScreen(); // the boot loader (z-9999) would otherwise cover the message
  const el = document.createElement('div');
  el.id = 'collection-message';
  el.style.cssText =
    'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:rgba(255,255,255,0.8);background:#000;font-size:1rem;';
  el.textContent = text;
  if (typeof document !== 'undefined') document.body.appendChild(el);
  return { start: () => {}, dispose: () => el.remove() };
}

/**
 * @param {object} opts
 * @param {{collectionId:(string|null), roster:Array, permissions:{canView:boolean,canEdit:boolean}, layout:(object|null)}} opts.collectionData
 * @param {Function} opts.makeVoiceSession per-voice factory (Main supplies `makeOrbiterVoiceSession`).
 * @returns {{ start: () => Promise<void>, dispose: () => void }}
 */
export function createCollectionApp({ collectionData, makeVoiceSession }) {
  const {
    roster: rawRoster = [],
    permissions = { canView: true, canEdit: false },
    layout: savedLayout = null,
    // Queue mode: tracks play once and auto-advance to the next entry
    // instead of looping — sequencing lives HERE in the multi-orbiter layer.
    sequential = false,
  } = collectionData || {};

  // The hydrationLevel=2 collection payload already contains each item's hydrated release
  // response — seed the release caches up front so a voice booted from ANY entry (drag-to-stage →
  // addVoice) gets its release as a warm cache hit instead of re-fetching the identical
  // multi-second payload. The drawer/stage entries stay lean (no fat payload retained).
  let primedCount = 0;
  const seededRoster = (Array.isArray(rawRoster) ? rawRoster : []).map((entry) => {
    if (entry?.hydrated) {
      if (entry.trackId && primeTrackReleaseCache(entry.trackId, entry.hydrated)) primedCount += 1;
      else if (entry.orbiterId && primeOrbiterReleaseCache(entry.orbiterId, entry.hydrated)) primedCount += 1;
      else if (entry.entangledWorldId && primeWorldReleaseCache(entry.entangledWorldId, entry.hydrated)) primedCount += 1;
      const { hydrated, ...lean } = entry;
      return lean;
    }
    return entry;
  });
  if (primedCount > 0) {
    console.info(`[collection] primed ${primedCount}/${seededRoster.length} release payloads from the collection fetch — voices booted from these entries skip their own release fetches`);
  }

  // Every entity type shows in the drawer; `bootable` is the studio-facing mirror of
  // `isBootableEntry` — can this card seed an EMPTY stage. It follows from the entity type alone, so
  // it never changes after this. Every card is draggable regardless: a non-bootable card still swaps
  // its dimension into an occupied stage.
  const roster = seededRoster.map((entry) => ({ ...entry, bootable: isBootableEntry(entry) }));

  if (!permissions.canView) return renderMessage("You don't have access to this collection.");
  if (roster.length === 0) {
    return renderMessage('This collection is empty.');
  }

  // Stage index → the voiceId occupying it (null for an empty stage). The realm keys voices by voiceId,
  // so this mapping is deterministic from the arrangement.
  const slotVoiceIds = [];
  // Stage index → the SOURCE (drawer/roster) voiceId of the occupant (null for an empty stage). A dragged
  // placement's realm voiceId is minted (`entry::N`), so it never equals a drawer card's id; the studio
  // needs this raw id to mark the active drawer card + know which stages are filled.
  const slotSourceIds = [];
  // The reconcile target: how many stages to show. The studio's count switcher is the source of the
  // number; this is its single record here, set ONLY when the switcher reports a change. Arrange actions
  // (load/clear/reorder) reconcile to this without changing it, so a count change queued but not yet run
  // is never undone by a subsequent drop.
  let targetSubtype = defaultSubtype(savedLayout, roster.length);
  // The arrangement: which entry occupies each stage. A default stage front-fills from the roster; an
  // EXPLICIT assignment (drag-to-stage) or clear is recorded here as a placement entry (with its own
  // minted `voiceId`, or `null` for "deliberately empty"), so a cleared stage stays empty on the next
  // reconcile instead of re-filling from the roster.
  const stageOverrides = new Map();
  // The drawer's entry list (its own order, reorderable). Starts as roster order; the arrange front-fill
  // still reads the roster, so reordering the drawer is display + persist order only (matches root).
  const drawerEntries = roster.slice();
  // Monotonic suffix so each drag-to-stage placement gets a DISTINCT voiceId over the entry's shared
  // audio ids — a second instance of the same entry can play on another stage (product decision) without
  // colliding on the realm's voiceId key.
  let placementCounter = 0;
  const mintVoiceId = (entry) => `${entry.voiceId}::${(placementCounter += 1)}`;

  // Queue mode: stages pre-fill from the queue order (you came here to LISTEN, not to
  // arrange) — unlike collection mode, where stages deliberately start empty and the
  // user drags cards. Seeded as ordinary placements so every later interaction
  // (drag, clear, reorder) behaves exactly as in collection mode.
  if (sequential) {
    const seedable = roster.filter(isBootableEntry);
    for (let i = 0; i < targetSubtype && i < seedable.length; i++) {
      const entry = seedable[i];
      stageOverrides.set(i, { ...entry, voiceId: mintVoiceId(entry), sourceVoiceId: entry.voiceId });
    }
  }
  // voiceId → unsubscribe, for the config-resolved listener below. A freshly added voice's
  // `dataManager.activeConfigRequest.orbiterId` (what `resolveFocusMidiPersistenceIds` reads) is not
  // populated yet when `addVoice` returns — the session's own config fetch is still in flight. Without
  // this, a slot's focus-MIDI target would register with a permanently-null persistence id whenever
  // nothing ELSE happens to push studio state again after that voice's config lands.
  const slotConfigUnsubscribes = new Map();

  let app = null;
  let studio = null;
  let studioHandle = null;
  let unsubscribeActive = null;
  let disposed = false;
  // Serializes reconciles so rapid actions (count clicks, drops) can't interleave an `await addVoice`
  // with a shrink (the race that would orphan a voice). Each reconcile targets the CURRENT arrangement.
  let reconcileChain = Promise.resolve();

  // The real orbiter a live voice resolves to — the same identity the MIDI persistence layer keys
  // on and what "the same track" means when it's loaded onto more than one stage at once.
  function orbiterIdForVoice(voiceId) {
    return voiceRegistry.get(voiceId)?.dataManager?.activeConfigRequest?.orbiterId || null;
  }

  // `additive` toggles the stage in/out of the multi-selection instead of collapsing to
  // single focus. A later change removed the letter focus button that used to call this with additive=true
  // (it overlapped stage chrome); the equivalent gesture lives on CameraController's shift-pointerdown
  // on the tile itself, which calls voiceRegistry.toggleSelection directly rather than through here.
  // Kept as a capability of this function (onFocusStage is exposed to callers as `(index, additive,
  // fromMidi)`) even though nothing currently calls it with additive=true.
  function focusStage(index, additive = false, fromMidi = false) {
    const voiceId = slotVoiceIds[index];
    if (!voiceId) return;
    try {
      if (additive) {
        voiceRegistry.toggleSelection(voiceId);
        return;
      }
      if (fromMidi) {
        // A track's MIDI mapping means "select THIS TRACK" — and the same track can be
        // dragged onto more than one stage at once (duplicate placements are allowed). A trigger
        // selects EVERY currently-loaded instance together (gang-focus) instead of an arbitrary
        // single one, which is what made the last-loaded instance silently win before this. The
        // TRIGGERED instance is always the primary (voiceRegistry.getActive()) — every single-focus
        // surface (keyboard, media keys, camera/sensor scoping) reads getActive(), and it must agree
        // with the tile the trigger actually fired from, not an arbitrary co-loaded sibling.
        const orbiterId = orbiterIdForVoice(voiceId);
        const coLoaded = orbiterId
          ? slotVoiceIds.filter((id) => id && id !== voiceId && orbiterIdForVoice(id) === orbiterId)
          : [];
        voiceRegistry.setActive(voiceId);
        coLoaded.forEach((id) => {
          try {
            voiceRegistry.addToSelection(id);
          } catch (_) {}
        });
        if (isAutofocusEnabled()) {
          studioHandle?.focusIndex?.(index);
        }
        return;
      }
      voiceRegistry.setActive(voiceId);
    } catch (_) {}
  }

  // A stable snapshot of the drawer list for the studio — re-sliced ONLY when the order actually changes
  // (in reorderEntries), so a stage-only push doesn't hand the card rail a new array identity each time.
  let entriesSnapshot = drawerEntries.slice();
  const entryBySourceVoiceId = new Map(drawerEntries.map((entry) => [entry.voiceId, entry]));

  // The slot-focus MIDI mapping is orbiter-owned like every other mapping in this app
  // (the backend requires `entityId` to be a real, owned orbiter — there is no collection-scoped
  // identity to persist against). So each slot's binding lives with THAT slot's own real
  // occupant, not one anchor shared across all four buttons — swapping the track in slot A only
  // affects slot A's mapping, and never bleeds into slot B/C/D or another collection that happens
  // to share an occupant.
  function resolveFocusMidiPersistenceIds() {
    return slotVoiceIds.map((voiceId) => orbiterIdForVoice(voiceId));
  }

  /** Stage index → that stage's drawer/roster entry (title, image, …), looked up via the SOURCE
   *  voiceId — null for an empty stage. */
  function resolveStageEntries() {
    return slotSourceIds.map((sourceVoiceId) => (sourceVoiceId ? entryBySourceVoiceId.get(sourceVoiceId) ?? null : null));
  }

  // Cards with an in-flight drop/load (source voiceId → count of concurrent loads) — the studio
  // shows the orbit loader on those cards, so a drop that takes seconds visibly works instead of
  // looking ignored. Counted, not flagged: the same card can be loading onto two stages at once.
  const cardLoadCounts = new Map();
  function beginCardLoad(sourceVoiceId) {
    if (!sourceVoiceId) return;
    cardLoadCounts.set(sourceVoiceId, (cardLoadCounts.get(sourceVoiceId) ?? 0) + 1);
    pushStudioState();
  }
  function endCardLoad(sourceVoiceId) {
    if (!sourceVoiceId || !cardLoadCounts.has(sourceVoiceId)) return;
    const next = cardLoadCounts.get(sourceVoiceId) - 1;
    if (next > 0) cardLoadCounts.set(sourceVoiceId, next);
    else cardLoadCounts.delete(sourceVoiceId);
    if (!disposed) pushStudioState();
  }

  /** Push the live stage→source-voice map + drawer order back to the studio so its UI (active card, drop
   *  hints, filled stages) reflects the realm. A fresh stage array each call so React sees the change; the
   *  entries snapshot keeps its identity between reorders. */
  function pushStudioState() {
    studio?.update?.({
      stageVoiceIds: slotSourceIds.slice(),
      stageEntries: resolveStageEntries(),
      focusMidiPersistenceIds: resolveFocusMidiPersistenceIds(),
      entries: entriesSnapshot,
      loadingSourceIds: [...cardLoadCounts.keys()],
    });
    // Publish the stage order so the mobile A/B/C/D picker labels each orbiter by its DESKTOP
    // slot (stage index), not registration order — otherwise slot B on the phone could drive orbiter C.
    voiceRegistry.setSlotOrder(slotVoiceIds);
  }

  // Set the target count (when given) and queue a reconcile to it. Arrange actions call it with no
  // argument to reconcile the current arrangement at the existing target. Before boot it only records
  // the target; start() runs the first reconcile once the realm + stages exist.
  function enqueueReconcile(nextCount) {
    if (nextCount != null) targetSubtype = clampSubtype(nextCount);
    if (!app || !studioHandle) return;
    reconcileChain = reconcileChain
      .then(() => reconcileTo())
      .catch((error) => console.warn('[collection] stage reconcile failed', error));
    return reconcileChain;
  }

  /**
   * Reconcile the realm's voices to the current arrangement over `targetSubtype` stages, idempotently,
   * against the CURRENTLY committed stage DOM. `planReconcile` computes the minimal remove/add set:
   * remove-pass first (so untouched stages keep their voice — no audio cut for survivors — and a replaced
   * stage frees before it re-adds), then add-pass for each stage whose desired entry has a committed cell.
   * Because it reconciles to the current committed arrangement (not a queued delta) and only adds when the
   * stage cell exists, interleaved actions converge without orphaning a voice into a removed stage.
   */
  // ── Auto-advance (cruise) ───────────────────────────────────────────────────
  // Per live voice: a listener for the natural end (the adapter reports it as state 'stopped'
  // with source 'player-stop'; a manual stop uses 'stop'). On end — while cruise is engaged —
  // the SAME stage loads the next drawer entry and plays it once booted.
  const sequentialUnsubscribes = new Map();
  // Cruise mode (Traktor-style): the explicit "software drives the deck" switch, offered in BOTH
  // modes. Auto-advance runs ONLY while engaged — normal playback never plays the next track by
  // itself. Queue mode arrives engaged (opening your queue IS the ask to keep listening);
  // collection mode arrives disengaged (you came to arrange decks).
  let cruiseEnabled = sequential;

  function toggleCruise() {
    cruiseEnabled = !cruiseEnabled;
    // Engaging cruise turns looping OFF on the live voices — auto-advance needs natural track
    // ends. Disengaging doesn't force loop back on: each track's own loop state is the user's
    // to drive from the transport.
    if (cruiseEnabled) {
      slotVoiceIds.forEach((id) => {
        if (!id) return;
        try {
          voiceRegistry.get(id)?.audioEngine?.setLoopEnabled?.(false);
        } catch (_) {}
      });
    }
    studio?.update?.({ cruise: { enabled: cruiseEnabled, onToggle: toggleCruise } });
  }

  // Drop-semantics toggle (the drawer toolbar): ON (default) = a track replaces the deck with its
  // FULL session, the world and orbiter it carries — loading a track means loading the track as its
  // author released it, so that is the default. OFF = a drop on an occupied stage swaps ONLY the
  // card's own dimension into the playing deck. Only a track has a session of its own, so an
  // orbiter and a world swap either way.
  let loadDefaultsEnabled = true;

  function toggleLoadDefaults() {
    loadDefaultsEnabled = !loadDefaultsEnabled;
    studio?.update?.({ loadDefaults: { enabled: loadDefaultsEnabled, onToggle: toggleLoadDefaults } });
  }
  // Stage index → true when the next voice added there should start playing (set by
  // an auto-advance; consumed by the add-pass in reconcileTo).
  const pendingAutoplayStages = new Set();

  function whenVoiceAudioEngine(voiceId, callback, tries = 40) {
    if (disposed) return;
    const engine = voiceRegistry.get(voiceId)?.audioEngine;
    if (engine) {
      callback(engine);
      return;
    }
    if (tries > 0) setTimeout(() => whenVoiceAudioEngine(voiceId, callback, tries - 1), 500);
  }

  // Fires `callback` once `voiceId` carries a NEW engine (a track/orbiter swap disposes the old one
  // and everything listening on it) whose resolved request matches `targetSession`. Requiring the
  // triad match — not just a fresh engine — makes rapid consecutive swaps safe: only the LAST swap's
  // poll can ever fire (earlier targets never become the resolved request), and a failed swap that
  // fell back to a stub session matches nothing.
  function whenVoiceEngineRebuilt(voiceId, prevEngine, targetSession, callback, tries = 40) {
    if (disposed) return;
    const voice = voiceRegistry.get(voiceId);
    if (!voice) return; // the voice left its stage — nothing to re-arm
    const engine = voice.audioEngine;
    const request = voice.dataManager?.activeConfigRequest;
    const matches =
      engine &&
      engine !== prevEngine &&
      request &&
      (request.trackId ?? null) === (targetSession.trackId ?? null) &&
      (request.orbiterId ?? null) === (targetSession.orbiterId ?? null) &&
      (request.entangledWorldId ?? null) === (targetSession.entangledWorldId ?? null);
    if (matches) {
      callback();
      return;
    }
    if (tries > 0) {
      setTimeout(() => whenVoiceEngineRebuilt(voiceId, prevEngine, targetSession, callback, tries - 1), 500);
    }
  }

  function advanceFromStage(index, endedVoiceId) {
    if (disposed || !cruiseEnabled || slotVoiceIds[index] !== endedVoiceId) return;
    const sourceId = slotSourceIds[index];
    const pos = sourceId ? drawerEntries.findIndex((e) => e.voiceId === sourceId) : -1;
    // The next BOOTABLE entry — a card that can't seed a stage (a world: no audio anywhere in the
    // platform) must not stall the cruise; skip past it.
    let next = null;
    for (let i = pos >= 0 ? pos + 1 : drawerEntries.length; i < drawerEntries.length; i++) {
      if (isBootableEntry(drawerEntries[i])) {
        next = drawerEntries[i];
        break;
      }
    }
    if (!next) return; // end of the queue — stop (finite; the host owns "keep playing")
    pendingAutoplayStages.add(index);
    // Auto-advance always means "the next deck", never an in-place swap — full replace even though
    // the stage is occupied by the just-ended voice.
    replaceStage(index, next);
  }

  function setupSequentialVoice(voiceId, index) {
    whenVoiceAudioEngine(voiceId, (engine) => {
      if (disposed || slotVoiceIds[index] !== voiceId) return;
      // Queue mode plays tracks once by nature; in collection mode looping only yields to an
      // ENGAGED cruise (a fresh deck otherwise keeps its track's own loop behavior).
      if (sequential || cruiseEnabled) {
        try {
          engine.setLoopEnabled?.(false);
        } catch (_) {}
      }
      const off = engine.addPlaybackStateListener?.((event) => {
        if (event?.state === 'stopped' && event?.source === 'player-stop') {
          advanceFromStage(index, voiceId);
        }
      });
      if (typeof off === 'function') sequentialUnsubscribes.set(voiceId, off);
      if (pendingAutoplayStages.delete(index)) {
        try {
          void engine.play?.();
        } catch (_) {}
      }
    });
  }

  async function reconcileTo() {
    if (disposed || !app || !studioHandle) return;
    const target = targetSubtype;

    const desired = buildDesiredArrangement(stageOverrides, target);
    const { removes, adds } = planReconcile(slotVoiceIds, desired);
    const occupiedBefore = slotVoiceIds.filter((id) => typeof id === 'string' && id.length > 0);
    const extendFullSelection =
      occupiedBefore.length > 1 &&
      occupiedBefore.every((id) => voiceRegistry.isSelected(id));

    for (const { index, voiceId } of removes) {
      app.removeVoice(voiceId);
      slotConfigUnsubscribes.get(voiceId)?.();
      slotConfigUnsubscribes.delete(voiceId);
      sequentialUnsubscribes.get(voiceId)?.();
      sequentialUnsubscribes.delete(voiceId);
      stageSwapTargets.delete(index);
      slotVoiceIds[index] = null;
      slotSourceIds[index] = null;
    }
    if (slotVoiceIds.length > target) slotVoiceIds.length = target;
    if (slotSourceIds.length > target) slotSourceIds.length = target;

    let deferred = false;
    for (const { index, entry } of adds) {
      if (!studioHandle.acquireCell(index)) {
        deferred = true; // stage cell not committed yet (a grow's new stage) — retry after the next frame
        continue;
      }
      // Only a track can seed a stage, so a placement always arrives with its own spine — there is
      // nothing left to resolve before the voice boots (a track placement never had a pre-verify).
      const voiceId = await app.addVoice(entry, index);
      if (disposed) return;
      slotVoiceIds[index] = voiceId ?? null;
      slotSourceIds[index] = voiceId ? entry.sourceVoiceId ?? entry.voiceId : null;
      // The auto-advance end-listener arms in BOTH modes (a cheap subscription) — cruise itself
      // gates whether a natural end actually advances the stage.
      if (voiceId) setupSequentialVoice(voiceId, index);
      // Re-push studio state once this voice's own config resolves, so its slot's
      // focus-MIDI persistence id (still null right now) picks up the real orbiterId. Each voice
      // dispatches on its OWN per-voice `eventBus` (not `window` — see the per-voice event bus gap
      // noted in MIDIController), so this listens on that voice's own channel.
      const voiceEventBus = voiceId ? voiceRegistry.get(voiceId)?.eventBus : null;
      if (voiceId && voiceEventBus) {
        const onConfigResolved = () => {
          if (!disposed) pushStudioState();
        };
        voiceEventBus.addEventListener('dataManager:configUpdated', onConfigResolved);
        slotConfigUnsubscribes.set(voiceId, () =>
          voiceEventBus.removeEventListener('dataManager:configUpdated', onConfigResolved),
        );
      }
      if (extendFullSelection && voiceId && !voiceRegistry.isSelected(voiceId)) {
        try {
          // addToSelection (NOT toggleSelection) so growing the layout extends the selection onto the new
          // stage WITHOUT repointing the primary — the user's focused tile stays put through a grow.
          voiceRegistry.addToSelection(voiceId);
        } catch {
          // Voice may have been removed by a later reconcile while this add was resolving.
        }
      }
    }
    // Removing the active voice re-points the realm's active to a surviving voice automatically
    // (VoiceRegistry.unregister), which flows to the layout via onActiveChange — so no manual re-focus
    // is needed here. A drop focuses its own stage (loadStage), after this reconcile lands its voice.
    pushStudioState();
    // A stranded add (its stage cell wasn't committed yet — the compound boot-window grow+drop race)
    // has no other trigger to retry, so schedule one more reconcile on the next frame. Idempotent, and
    // self-terminating once the cell commits (no skip → no reschedule).
    if (deferred && !disposed && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => enqueueReconcile());
    }
  }

  // Arrange mutators — wired to the studio for EVERYONE who can view (viewing grants full session-local
  // interaction). Only persisting the arrangement is edit-gated (see `onPersist`). A drag onto a stage
  // mints a NEW instance, so the same entry can sound on two stages at once (never vacates the other).
  /** Replace stage `index` with a fresh instance of `entry` (full boot — new placement, new voice) and
   *  focus that stage. Focusing the DROPPED stage (rather than root's advance-to-next-free, which suited
   *  sequential NFC fill) fits the explicit drag-drop model here and keeps the realm's active voice ↔ the
   *  layout focus in agreement. A drop of the entry already on that stage is a no-op + focus. */
  function replaceStage(index, entry) {
    const current = stageOverrides.get(index) ?? null;
    const currentSource = current ? current.sourceVoiceId ?? current.voiceId : null;
    if (currentSource === entry.voiceId) {
      focusStage(index); // already there — just focus it
      return;
    }
    // A fresh instance: distinct minted voiceId, same audio + display fields; remember the source entry's
    // id so a repeat drop onto this stage is recognised as a no-op. A full replace supersedes any
    // swap still in flight on this stage — including one still awaiting its pre-verify (the stage's
    // old voice stays live until the reconcile, so without bumping the attempt token that stale
    // swap would still dispatch and its track-swap bookkeeping would overwrite THIS placement).
    stageSwapTargets.delete(index);
    swapAttempts.set(index, (swapAttempts.get(index) ?? 0) + 1);
    stageOverrides.set(index, { ...entry, voiceId: mintVoiceId(entry), sourceVoiceId: entry.voiceId });
    // The card loads until its reconcile settles (addVoice resolves once the voice is up; the stage
    // itself narrates the boot through its own per-tile overlay).
    beginCardLoad(entry.voiceId);
    // Focus the dropped stage once its voice is live (its minted id lands in slotVoiceIds after the
    // reconcile). Pre-boot the chain resolves immediately and focusStage no-ops on the empty slot.
    Promise.resolve(enqueueReconcile()).then(() => {
      endCardLoad(entry.voiceId);
      if (!disposed) focusStage(index);
    });
    maybePersist();
  }

  /** A card dropped on stage `index`. An OCCUPIED stage (its voice's session already resolved) takes an
   *  in-place swap of the card's own dimension — unless "load full sessions" is engaged and the card can
   *  seed a session of its own, in which case the drop replaces the whole deck with the card's original
   *  session. An empty (or still-booting) stage takes the boot path, which only bootable cards may seed. */
  function loadStage(index, entry) {
    if (!entry || index < 0) return;
    const voiceId = slotVoiceIds[index];
    const current = voiceId ? voiceRegistry.get(voiceId)?.dataManager?.activeConfigRequest : null;
    const canBoot = isBootableEntry(entry);
    if (voiceId && current?.trackId && !(loadDefaultsEnabled && canBoot)) {
      void swapStage(index, voiceId, entry, current);
      return;
    }
    if (!canBoot) return;
    replaceStage(index, entry);
  }

  // Stage index → the latest swap attempt's token. A swap's pre-verify awaits the network, so an
  // older drop's verify can resolve AFTER a newer drop on the same stage — the newest drop must win
  // the stage outright (the older one aborts instead of dispatching a triad built from a stale view
  // of the session, which would silently revert the newer swap's dimension).
  const swapAttempts = new Map();
  // Stage index → the last swap triad DISPATCHED to that stage's voice, alive until that load cycle
  // reports done (or fails). A swap's kept dimensions must build on what the stage is BECOMING, not
  // only on what its resolver has already applied: the resolution behind the previous swap can take
  // seconds (version-pinned release fetches), and a world dropped right after an orbiter drop would
  // otherwise read the pre-swap request and re-dispatch the OLD orbiter inside the new triad.
  const stageSwapTargets = new Map();

  /** Swap ONLY the dropped card's dimension (track / orbiter / world) of the live session on stage
   *  `index`, keeping the other two. A world swap reuses the audio engine, so playback genuinely
   *  continues; a track/orbiter swap rebuilds the engine and the stage loads STOPPED (deliberate —
   *  the user presses play, no auto-resume). */
  async function swapStage(index, voiceId, entry, current) {
    // Build on the stage's in-flight target when one exists (a previous swap dispatched but not yet
    // finished loading) — otherwise on the live resolved request.
    const swap = swapDescriptor(stageSwapTargets.get(index) ?? current, entry);
    if (!swap) return;
    if (swap.noop) {
      focusStage(index); // the exact triad is already playing (or already on its way) — just focus it
      return;
    }
    const attempt = (swapAttempts.get(index) ?? 0) + 1;
    swapAttempts.set(index, attempt);
    beginCardLoad(entry.voiceId);
    // Verify the incoming entity's release BEFORE dispatching (cache-first, usually warm). A dead
    // target (archived/private) must never reach the engine's session-error fallback — that would
    // tear the live session down into a stub. On failure the stage simply keeps playing what it has,
    // and the drop stays retryable. An orbiter is verified as itself and nothing more — a swap
    // keeps the stage's CURRENT track, and an orbiter never carries a track of its own.
    try {
      if (swap.dim === 'track') await fetchTrackRelease(entry.trackId, { hydrate: 2 });
      else if (swap.dim === 'orbiter') await fetchOrbiterRelease(entry.orbiterId, { useFallback: false });
      else await fetchEntangledWorldRelease(entry.entangledWorldId);
    } catch (error) {
      console.warn('[collection] swap target is not available — stage keeps its session', error);
      endCardLoad(entry.voiceId);
      return;
    }
    // The verify awaited — the stage may have been cleared, replaced, superseded by a newer drop,
    // or the app disposed meanwhile.
    if (disposed || slotVoiceIds[index] !== voiceId || swapAttempts.get(index) !== attempt) {
      endCardLoad(entry.voiceId);
      return;
    }
    const voice = voiceRegistry.get(voiceId);
    if (!voice?.eventBus) {
      endCardLoad(entry.voiceId);
      return;
    }
    // Rebuild the triad against the freshest view of the stage — the in-flight target if a previous
    // swap is still loading (its resolution may not have applied yet), else the live resolved
    // request. Building on anything staler would silently revert another dimension's recent swap.
    const live = stageSwapTargets.get(index) ?? voice.dataManager?.activeConfigRequest ?? current;
    const fresh = swapDescriptor(live, entry);
    if (!fresh || fresh.noop) {
      endCardLoad(entry.voiceId);
      if (fresh?.noop) focusStage(index);
      return;
    }
    const prevEngine = voice.audioEngine ?? null;
    // The stage's pending target: what this dispatch is turning the session into. Later swaps on
    // this stage build on it; it dies when this load cycle settles (the resolved request is
    // authoritative again) or when a newer dispatch replaces it.
    const swapTarget = {
      trackId: fresh.session.trackId,
      orbiterId: fresh.session.orbiterId,
      entangledWorldId: fresh.session.entangledWorldId,
      trackVersion: fresh.requested.trackVersion,
      orbiterVersion: fresh.requested.orbiterVersion,
      entangledWorldVersion: fresh.requested.entangledWorldVersion,
    };
    stageSwapTargets.set(index, swapTarget);
    // The card's loader runs until THIS load cycle finishes: the voice reports done (or an error)
    // on its own bus at the end of every bootstrap, swaps included. The timeout is a backstop for
    // a voice removed mid-swap, whose bus never reports again.
    let cardLoadSettled = false;
    let cardLoadTimer = null;
    const settleCardLoad = () => {
      if (cardLoadSettled) return;
      cardLoadSettled = true;
      voice.eventBus.removeEventListener(LOAD_PROGRESS_EVENT, onSwapLoadProgress);
      voice.eventBus.removeEventListener(LOAD_ERROR_EVENT, settleCardLoad);
      if (cardLoadTimer) clearTimeout(cardLoadTimer);
      // Only THIS swap's target may be retired — a newer dispatch owns the entry now.
      if (stageSwapTargets.get(index) === swapTarget) stageSwapTargets.delete(index);
      endCardLoad(entry.voiceId);
    };
    const onSwapLoadProgress = (event) => {
      if (!event?.detail?.done) return;
      // Every bootstrap cycle on this voice reports done — including an EARLIER layered swap's.
      // Only settle when THIS swap's cycle finished (the live request carries the target triad),
      // or when a newer dispatch superseded this one (its own listener owns the rest). Settling on
      // any done would clear the pending target early and a follow-up drop would build from a
      // stale view of the stage.
      const liveRequest = voiceRegistry.get(voiceId)?.dataManager?.activeConfigRequest;
      const realized =
        liveRequest &&
        (liveRequest.trackId ?? null) === swapTarget.trackId &&
        (liveRequest.orbiterId ?? null) === swapTarget.orbiterId &&
        (liveRequest.entangledWorldId ?? null) === swapTarget.entangledWorldId;
      const superseded = stageSwapTargets.get(index) !== swapTarget;
      if (realized || superseded) settleCardLoad();
    };
    voice.eventBus.addEventListener(LOAD_PROGRESS_EVENT, onSwapLoadProgress);
    voice.eventBus.addEventListener(LOAD_ERROR_EVENT, settleCardLoad);
    cardLoadTimer = setTimeout(settleCardLoad, 45000);
    voice.eventBus.dispatchEvent(
      new CustomEvent('orbiters:session-load', {
        detail: {
          session: { ...fresh.session, requested: fresh.requested, source: 'studio-swap' },
          payload: { source: 'studio-swap' },
        },
      }),
    );
    if (fresh.dim === 'track') {
      // A track swap re-seats the stage's IDENTITY (the drawer underline + the persisted order follow
      // the new track). Mutate the placement in place keeping its minted voiceId so the next reconcile
      // sees zero delta — the live voice already carries the new session. Orbiter/world swaps are
      // session-local by design: the placement (and anything persisted) stays the original card.
      const existing = stageOverrides.get(index);
      if (existing) {
        stageOverrides.set(index, { ...entry, voiceId: existing.voiceId, sourceVoiceId: entry.voiceId });
      }
      slotSourceIds[index] = entry.voiceId;
      pushStudioState();
      maybePersist();
    }
    focusStage(index);
    // A rebuild (track/orbiter swap) disposes the old engine — and the auto-advance end-listener
    // with it. Re-arm on the NEW engine once it carries the swapped session; no autoplay (the stage
    // loads stopped, and cruise advances only from a natural end). A world swap keeps the engine,
    // so its listener survives untouched.
    if (fresh.dim !== 'world') {
      whenVoiceEngineRebuilt(voiceId, prevEngine, fresh.session, () => {
        if (slotVoiceIds[index] !== voiceId) return;
        sequentialUnsubscribes.get(voiceId)?.();
        sequentialUnsubscribes.delete(voiceId);
        setupSequentialVoice(voiceId, index);
      });
    }
  }

  /** Clear stage `index` (the per-stage remove control). Also aborts any swap still in flight on
   *  the stage (attempt bump) — its voice stays live until the reconcile removes it. */
  function clearStage(index) {
    if (index < 0) return;
    stageSwapTargets.delete(index);
    swapAttempts.set(index, (swapAttempts.get(index) ?? 0) + 1);
    stageOverrides.set(index, null);
    enqueueReconcile();
    maybePersist();
  }

  /** Reorder the drawer list (drag one card before another / to the end). Display + persist order only —
   *  it does not move loaded stages (matches root's drawer reorder). */
  function reorderEntries(sourceVoiceId, beforeVoiceId) {
    const next = moveEntryBefore(drawerEntries, sourceVoiceId, beforeVoiceId);
    if (next === drawerEntries) return;
    drawerEntries.length = 0;
    drawerEntries.push(...next);
    entryBySourceVoiceId.clear();
    drawerEntries.forEach((entry) => entryBySourceVoiceId.set(entry.voiceId, entry));
    entriesSnapshot = drawerEntries.slice(); // the order actually changed → new identity for the card rail
    pushStudioState();
    maybePersist();
  }

  /** Leave the collection Studio (the persistent nav's "Go back"). Full-page history back — collection
   *  mode is entered by a redirect from the site, so back returns there. */
  function handleBack() {
    if (typeof window !== 'undefined') window.history.back();
  }

  // Persist the arrangement AUTOMATICALLY after an edit (matching root — no Save button). Editor-gated and
  // fire-and-forget; still a stub-ack until the real write endpoint lands. The persisted `order` is the
  // SOURCE (roster) id per stage, not the minted realm id — `entry::N` can't map back to a roster entry on
  // restore, but source ids round-trip (a repeat id = a duplicate stage).
  function maybePersist() {
    // Queue mode: the same persistence moments (reorder, load, clear) write the new
    // order back to the user's queue instead of a collection layout.
    if (sequential && typeof collectionData?.persistQueueOrder === 'function') {
      collectionData.persistQueueOrder(
        drawerEntries.map((entry) => entry.trackId).filter(Boolean),
      );
      return;
    }
    if (!permissions.canEdit || !collectionData.collectionId) return;
    Promise.resolve(
      saveCollectionLayout(collectionData.collectionId, {
        order: slotSourceIds.slice(),
        entryOrder: drawerEntries.map((entry) => entry.voiceId),
      }),
    ).catch((error) => console.warn('[collection] failed to persist layout', error));
  }

  /**
   * Warm the release cache for the first few drawer entries in the background, so an early
   * drag-to-stage is an instant cache hit rather than paying mycelium's slow per-item hydration.
   * `fetchTrackRelease` is cache-first and writes into the SAME `Constants` release cache the drag
   * path (addVoice → makeVoiceSession) consults, so a warmed entry needs no refetch. Fire-and-forget
   * and bounded (cap + concurrency); abandoned on dispose — an in-flight fetch simply lands in the
   * shared cache and its result is ignored.
   */
  function prefetchReleases() {
    // Warm in drawer order (the first PREFETCH_LIMIT entries that have a release worth warming).
    // When saved arrangements land, this is the seam to warm saved-stage items first — not
    // implemented yet. A track entry warms the spine it would boot; an orbiter entry warms its own
    // release for the swap it can be dropped into. A world's release stays cold, as before.
    const queue = drawerEntries
      .filter((entry) => entry.trackId || entry.orbiterId)
      .slice(0, PREFETCH_LIMIT);
    let cursor = 0;
    const runNext = async () => {
      while (!disposed && cursor < queue.length) {
        const entry = queue[cursor++];
        try {
          if (entry.trackId) await fetchTrackRelease(entry.trackId, { hydrate: 2 });
          else if (entry.orbiterId) await fetchOrbiterRelease(entry.orbiterId);
        } catch (_) {
          // a warm-up miss is non-fatal — the drag path re-fetches and the per-tile loader narrates it
        }
      }
    };
    for (let i = 0; i < PREFETCH_CONCURRENCY; i += 1) runNext();
  }

  async function start() {
    // The keyboard singleton normally boots with the first VOICE (Interaction.js) — an empty
    // collection would otherwise have no M key at all, locking the user out of MIDI-learn for
    // the shell targets until some orbiter loads. Initialize it voice-less here; the first
    // voice boot just updates its dependencies (same singleton, one document listener).
    KeyboardController.initialize({});
    studio = mountMultiStageStudio({
      rosterLength: roster.length,
      savedLayout,
      onFocusStage: focusStage,
      onSubtypeChange: (next) => enqueueReconcile(next),
      onBack: handleBack,
      // The drawer's entries + the arrange handlers are given to EVERYONE who can view — viewing grants
      // full session-local interaction (open drawer, drag onto stages, rearrange, remove, reorder).
      entries: drawerEntries.slice(),
      stageEntries: resolveStageEntries(),
      focusMidiPersistenceIds: resolveFocusMidiPersistenceIds(),
      onLoadStage: loadStage,
      onClearStage: clearStage,
      cruise: { enabled: cruiseEnabled, onToggle: toggleCruise },
      // Only a track can start a stage. A collection with none would otherwise open onto stages that
      // silently refuse every card — the studio says so on arrival instead.
      noPlayableEntries: !roster.some(isBootableEntry),
      loadDefaults: { enabled: loadDefaultsEnabled, onToggle: toggleLoadDefaults },
      onReorderEntries: reorderEntries,
      registerMidiTarget: (binding) => MIDIControllerInstance?.registerMidiLearnTarget(binding),
      unregisterMidiTarget: (id) => MIDIControllerInstance?.unregisterMidiLearnTarget(id),
      // Shell actions (slot focus/add, pager, drawer) persist under THIS collection's slice.
      shellMidiCollectionId: COLLECTION_SHELL_MIDI_ENABLED ? collectionData.collectionId || null : null,
      // Persist is automatic + editor-gated (see maybePersist) — no Save control, matching root.
    });

    // Wait for the initial stages to commit so the realm's `acquireCell` finds real DOM.
    studioHandle = await studio.ready;
    if (disposed) return;

    // The collection UI (placeholders + drawer) is on screen — dismiss the boot loader. Single-orbiter
    // hides it when its voice boots, but collection mode STARTS EMPTY (no voice), so the collection app
    // owns the dismissal, otherwise the z-9999 loader covers the studio forever.
    hideLoadingScreen();

    // Boot an EMPTY realm — every stage starts as a placeholder (matching root's mixed-collection).
    // Nothing is auto-loaded from the collection; the roster only populates the drawer, and a voice is
    // added to the realm only when the user drags a card onto a stage (loadStage → reconcile → addVoice).
    app = createMultiOrbiterApp({
      roster: [],
      makeVoiceSession,
      createRenderHost: () =>
        createViewportCompositor({ cellSource: { acquireCell: studioHandle.acquireCell } }),
    });

    // Reflect the realm's focused voice back onto the layout (Roman highlight). Ignore a null active
    // (fired while unregistering the last/only voice) — `indexOf(null)` would otherwise match the first
    // empty slot and land the highlight on a voiceless stage.
    unsubscribeActive = voiceRegistry.onActiveChange((activeId) => {
      if (activeId == null) return;
      const idx = slotVoiceIds.indexOf(activeId);
      if (idx >= 0) studioHandle.setActiveIndex(idx);
    });

    // Seed the studio's arrange UI (all placeholders) and apply any drop/count change that landed during
    // the boot window (queued but couldn't run until the realm existed).
    pushStudioState();
    enqueueReconcile();

    await app.start();

    // The studio is interactive and the (empty) realm is up — now warm the release cache in the
    // background so the first drags are instant. Fire-and-forget; abandoned on dispose.
    prefetchReleases();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribeActive?.();
    slotConfigUnsubscribes.forEach((off) => off());
    slotConfigUnsubscribes.clear();
    app?.dispose();
    studio?.dispose();
  }

  return { start, dispose };
}
