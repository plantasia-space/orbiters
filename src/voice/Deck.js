/**
 * @file src/voice/Deck.js
 * @description The per-player DECK — the ONE owner of everything "what does this player play, and to
 * whose clock": sync-enable, warp, transport tempo, native track tempo, meter, grid marker, follow
 * ratio, and the beat-clock seam. It folds the former SyncView (per-voice notification fan),
 * WrapGridState (grid/meter/ratio state), voiceSyncEnable and voiceWrapEnable (registry-record
 * flags) into one module, so the "is THIS voice synced → which clock → which tempo" rule exists at
 * exactly one site instead of being hand-assembled per feature.
 *
 * The tempo model (the DJ-deck model, per Bruna):
 *  - Every deck has ONE continuous **transport tempo** (`tempo`, the header "BPM" number). While
 *    synced it tracks the shared master; while unsynced it is the deck's own. Toggling sync only
 *    changes WHO DRIVES the number, never the number itself at the seam — un-syncing HOLDS the last
 *    session tempo (no revert, no audible jump); syncing on as the first enabler ESTABLISHES the
 *    master from this deck's tempo; syncing on later ADOPTS the running master.
 *  - **Warp** means "time-stretch the audio to the transport tempo" and is independent of sync: a
 *    synced deck warps to the shared tempo, an unsynced deck warps to its OWN tempo (a varispeed /
 *    pitch-fader), warp OFF plays natural (no grid). Solo (non-collection) keeps the historical
 *    rule — it follows only while the sync session is enabled — so single-orbiter playback is
 *    byte-identical.
 *  - The transport tempo is session-only state. What persists per track is the NATIVE tempo
 *    (`nativeTempo`, the analyzed/edited track BPM — the grid reference), via the kit panel's
 *    commit seam. Persisting the transport tempo is exactly how sibling tempos used to poison a
 *    track's saved settings.
 *
 * Notification: the deck emits ONE deck-scoped change stream, `onChange(snapshot, reason)`
 * ("deck-changed"). The coordinator's session channel (`syncCoordinator.onBpmChange/onStatusChange`)
 * is the master/session stream ("master-changed") — audience is named by the owner you subscribe to,
 * never by which of two pipes a caller happened to pick.
 */
import { voiceRegistry } from './VoiceRegistry.js';
import { syncCoordinator } from '../sync/SyncCoordinator.js';
import { getSourceAudioTimeSec, wrapSourcePositionMs } from '../sync/wrap/WrapGridMap.js';
import {
  resolvePrimaryGridMarkerTimeSecFromTrackData,
  resolveTrackBpmFromTrackData,
} from 'entangled-worlds-orbiters-shared/clock/track-metadata';
import { resolveTrackMeterFromTrackData, normalizeMeterId, sharedBeatsPerBar } from '../sync/meter.js';
import { getLaunchGridBars } from '../sync/launchGrid.js';

export const WRAP_GRID_CHANGE_EVENT = 'orbiters:wrap-grid-change';

function clampGridStartTimeSec(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, numeric);
}

function buildGridMarker(sourceTimeSec = 0) {
  const resolvedSourceTimeSec = clampGridStartTimeSec(sourceTimeSec);
  return Object.freeze({
    id: 'grid-marker-1',
    beat: 1,
    kind: 'downbeat',
    label: 'Grid marker',
    sourceTimeSec: resolvedSourceTimeSec,
  });
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Resolve a voice's deck: the given id, or the active/only voice (single-orbiter passes null —
 *  `useEngineVoiceId` is null there — and the one registered voice is the active one).
 *  @param {string|null} [voiceId]
 *  @returns {Deck|null} */
export function deckFor(voiceId = null) {
  const record = voiceRegistry.get(voiceId) ?? voiceRegistry.get(voiceRegistry.activeId);
  return record?.deck ?? null;
}

/** How many decks in THIS realm currently want sync (the in-tab "session" size — the SYNC badge
 *  counts these in-tab partners, not just cross-tab BroadcastChannel peers). */
export function syncEnabledDeckCount() {
  return voiceRegistry.all().filter((v) => v?.deck?.syncEnabled === true).length;
}

/** Drive the shared coordinator from the realm aggregate (its existing idempotent enable/disable),
 *  then re-fan per-voice status so each deck hears its OWN new enable state (enable/disable emit
 *  nothing when the aggregate is unchanged). */
export function recomputeSyncAggregate() {
  const anyOn = voiceRegistry.all().some((v) => v?.deck?.syncEnabled === true);
  if (anyOn) syncCoordinator.enable();
  else syncCoordinator.disable();
  syncCoordinator.notifyVoiceSyncChanged?.();
}

export class Deck {
  #voiceId = null;
  #collection = false;
  #syncEnabled = false;
  #warp = true;
  // Mobile speed lock: while set, this deck's audio cannot time-stretch (the engine pins it to native
  // rate). Warp's only job is that stretch, so a locked deck is forced warp-off and can't re-enable it.
  #speedLocked = false;
  // The transport tempo is only a construction-time placeholder (master default, no native known
  // yet) until the track's tempo arrives or someone deliberately sets it. See the ctor note.
  #tempoIsPlaceholder = false;
  /** The continuous transport tempo (the "BPM" number). Master-driven while synced. */
  #tempo = null;
  /** The track's native/analyzed BPM — the grid reference; the value that persists per track. */
  #nativeTempo = null;
  #meter;
  #gridMarkerTimeSec = 0;
  /** This deck's OWN launch grid, in bars (0 = none). Seeded from the realm boot value
   *  (`launchGrid.js` — the URL-pinnable default); per-deck from then on, like meter. */
  #launchGridBars = getLaunchGridBars();
  #sharedClockSource = null;
  #positionSource = null;
  #listeners = new Set();
  #lastStatusDetail = null;
  #disposed = false;

  /**
   * @param {{
   *   voiceId?: string|null,
   *   trackData?: object|null,
   *   gridMarkerTimeSec?: number|null,
   *   collection?: boolean,
   * }} [options] `collection` marks a multi-realm deck (chosen by the CONSTRUCTION PATH, never by
   * the live registry size — sibling voices register asynchronously, so size at construction lies).
   * A collection deck seeds its transport tempo from its OWN track (ratio 1 — nothing audibly
   * changes at load) and follows its own tempo while unsynced. A solo deck mirrors the master and
   * follows only while the sync session is enabled (historical single-orbiter behavior).
   */
  constructor({ voiceId = null, trackData = null, gridMarkerTimeSec = null, collection = false } = {}) {
    this.#voiceId = voiceId ?? null;
    this.#collection = collection === true;
    this.#gridMarkerTimeSec = gridMarkerTimeSec == null
      ? (resolvePrimaryGridMarkerTimeSecFromTrackData(trackData) ?? 0)
      : clampGridStartTimeSec(gridMarkerTimeSec);
    // Native is strictly per-voice for a collection deck — borrowing the shared singleton here
    // would adopt a SIBLING's tempo (the contamination class) and mask a genuinely tempo-less
    // track. A solo deck keeps the singleton fallback: there it describes its own track.
    this.#nativeTempo = resolveTrackBpmFromTrackData(trackData)
      ?? (this.#collection
        ? null
        : toPositiveNumber(syncCoordinator?.trackBpm ?? syncCoordinator?.detectedTrackBpm));
    // Transport tempo seed: a collection deck starts on ITS OWN track's tempo (so the header number
    // is honest from first paint and the warp ratio is exactly 1); a solo deck mirrors the master.
    this.#tempo = this.#collection
      ? (this.#nativeTempo ?? toPositiveNumber(syncCoordinator?.bpm))
      : toPositiveNumber(syncCoordinator?.bpm);
    // Decks are usually constructed BEFORE their trackData exists (two-phase seed), so a collection
    // deck seeded without a native tempo holds only a PLACEHOLDER (the master default). Remember
    // that: when the track's real tempo arrives it must be adopted — a placeholder is not "a tempo
    // that's already playing". Cleared by any deliberate write (user edit, synced adoption).
    this.#tempoIsPlaceholder = this.#collection && this.#nativeTempo == null;
    // This deck's OWN meter (a property of its track), resolved from ITS OWN trackData only — never
    // the shared singleton, so loading voice B never inherits voice A's meter. Meter is ALWAYS
    // per-deck: sync aligns clock/tempo/phase only (a 6/8 track can sync to a 4/4 one).
    this.#meter = resolveTrackMeterFromTrackData(trackData);
    // No tempo → no grid reference: warp has nothing to stretch to, so it starts OFF and stays
    // locked until a tempo is set. Never a silent ratio-1 "stretch" that looks like a broken warp.
    if (this.#nativeTempo == null) this.#warp = false;
  }

  get voiceId() { return this.#voiceId; }
  get isCollection() { return this.#collection; }

  /** Two-phase seed: the deck is constructed at voice registration (so its flags are toggleable
   *  before audio exists), and the audio adapter seeds it from the loaded trackData here — native
   *  tempo, meter, grid marker, and (collection, still riding native) the transport tempo. */
  seedFromTrackData(trackData) {
    const wasRidingNative = this.#tempo == null
      || this.#tempo === this.#nativeTempo
      || this.#tempoIsPlaceholder;
    const hadTempo = this.#nativeTempo != null;
    const native = resolveTrackBpmFromTrackData(trackData);
    if (native != null) this.#nativeTempo = native;
    if (!hadTempo && this.#nativeTempo != null) this.#restoreWarpAfterTempo();
    this.#meter = resolveTrackMeterFromTrackData(trackData);
    const gridSec = resolvePrimaryGridMarkerTimeSecFromTrackData(trackData);
    if (gridSec != null) this.#gridMarkerTimeSec = clampGridStartTimeSec(gridSec);
    if (this.#collection && !this.#syncEnabled && wasRidingNative && this.#nativeTempo != null) {
      this.#tempo = this.#nativeTempo;
      this.#tempoIsPlaceholder = false;
    } else if (!this.#collection && this.#nativeTempo != null && syncCoordinator?.isEnabled !== true) {
      // LOAD — same rule for a SOLO deck: its transport tempo IS the session master (it mirrors it),
      // so adopting the track's tempo means seeding the master. Guarded there by "has anyone
      // deliberately chosen a tempo yet?" — a BPM the user typed while loading is respected, a boot
      // seed is not. The fan returns the value here through `receiveMasterChange`, so there is no
      // second tempo owner.
      syncCoordinator.seedTrackTempo?.(this.#nativeTempo);
    }
    this.#emit('bpm');
  }

  // ── sync enable ──────────────────────────────────────────────────────────

  get syncEnabled() { return this.#syncEnabled; }

  /** Toggle this deck's sync. First enabler in an in-tab realm ESTABLISHES the master from this
   *  deck's tempo (a room instead adopts a peer's tempo on join); a later enabler ADOPTS the running
   *  master via the coordinator's adopt-on-sync re-emit. Disabling HOLDS the current tempo — the
   *  deck keeps playing at the tempo it was synced to (no revert, no jump). */
  setSyncEnabled(enabled) {
    const on = Boolean(enabled);
    if (on === this.#syncEnabled) return;
    // Capture BEFORE the aggregate flips: enabling fans the adopt-on-sync master synchronously and
    // this deck (synced by then) adopts it — reading after would establish the master with itself.
    const establishing = on
      && syncCoordinator.isRoom !== true
      && !voiceRegistry.all().some((v) => v?.deck !== this && v?.deck?.syncEnabled === true);
    const establishTempo = establishing ? this.#tempo : null;
    this.#syncEnabled = on;
    recomputeSyncAggregate();
    if (establishing && Number.isFinite(establishTempo) && establishTempo > 0) {
      syncCoordinator.setTempo(establishTempo, { sourceType: 'manual', byVoiceId: this.#voiceId });
    }
  }

  // ── warp ─────────────────────────────────────────────────────────────────

  /** Whether this deck's audio time-stretches to its transport tempo (independent of sync). */
  get warp() { return this.#warp; }

  /** Whether this deck's track has no tempo yet — warp is locked off until one is set. */
  get tempoMissing() { return this.#nativeTempo == null; }

  setWarp(enabled) {
    const on = enabled !== false;
    // Can't warp while the speed lock is engaged — the stretch it would ask for is blocked anyway.
    if (this.#speedLocked && on) return;
    // Can't warp without a tempo — there is no grid reference to stretch to.
    if (this.#nativeTempo == null && on) return;
    if (on === this.#warp) return;
    this.#warp = on;
    // Re-fan status so both rate owners re-apply immediately (rate-only, no position seek).
    syncCoordinator.notifyVoiceWrapChanged?.();
    this.#emit('sync-status');
  }

  /** Whether the mobile speed lock is engaged for this deck (audio pinned to native rate). */
  get speedLocked() { return this.#speedLocked; }

  /** Engaged/released by the audio engine when the mobile speed lock resolves. Engaging forces warp
   *  OFF (its stretch is a no-op under the lock, and this keeps the metronome/grid on the deck's real
   *  native tempo instead of a transport tempo the audio isn't playing). Always re-fans status so the
   *  Warp control can disable/re-enable itself. */
  setSpeedLocked(locked) {
    const on = locked === true;
    if (on === this.#speedLocked) return;
    this.#speedLocked = on;
    if (on && this.#warp) {
      this.#warp = false;
      syncCoordinator.notifyVoiceWrapChanged?.();
    }
    this.#emit('sync-status');
  }

  // ── tempo ────────────────────────────────────────────────────────────────

  /** The transport tempo — what the header number shows, and what warp stretches to. */
  get tempo() { return this.#tempo; }

  /** A user edit of the deck's tempo (the header number, by any input method). Synced (or solo):
   *  proposes the shared master — the coordinator's single gate decides. Unsynced collection deck:
   *  the deck's own transport tempo, session-only (deliberately NOT persisted — the track's saved
   *  tempo is `nativeTempo`; persisting transport tempos is how sibling tempos poisoned tracks). */
  setTempo(bpm, { sourceType = 'manual' } = {}) {
    const next = toPositiveNumber(bpm);
    if (next == null) return;
    if (this.#syncEnabled || !this.#collection) {
      syncCoordinator.setTempo(next, { sourceType, byVoiceId: this.#voiceId });
      return;
    }
    if (next === this.#tempo) return;
    this.#tempo = next;
    this.#tempoIsPlaceholder = false;
    this.#emit('bpm');
  }

  /** This deck's OWN native track tempo (its grid reference — never the shared singleton). */
  get nativeTempo() { return this.#nativeTempo; }

  /** Set the native track tempo (a per-track edit from the kit panel; the persisted value). While
   *  the deck is on its own transport (unsynced collection), the transport follows the new native
   *  1:1 (ratio stays 1) unless the user has detached it by editing the number. */
  setNativeTempo(bpm) {
    const next = toPositiveNumber(bpm);
    if (next == null || next === this.#nativeTempo) return;
    const wasRidingNative = this.#tempo === this.#nativeTempo;
    const wasMissing = this.#nativeTempo == null;
    this.#nativeTempo = next;
    if (wasRidingNative && this.#collection && !this.#syncEnabled) this.#tempo = next;
    if (wasMissing) this.#restoreWarpAfterTempo();
    this.#emit('bpm');
  }

  /** A tempo just arrived on a deck that had none: lift the no-tempo lock back to the warp default
   *  (on). The mobile speed lock still wins — it keeps warp off until it releases. */
  #restoreWarpAfterTempo() {
    if (this.#speedLocked || this.#warp) return;
    this.#warp = true;
    syncCoordinator.notifyVoiceWrapChanged?.();
  }

  /** Whether this deck currently time-stretches at all: warp on, and (for a solo deck) the sync
   *  session live — the ONE site of the follow rule. */
  get following() {
    return this.#warp && (this.#syncEnabled || (this.#collection
      ? true
      : syncCoordinator?.isEnabled === true));
  }

  /** The playback-rate projection: transport / native when following, else exactly 1 (natural). */
  get followRatio() {
    if (!this.following) return 1;
    const tempo = toPositiveNumber(this.#tempo);
    const native = toPositiveNumber(this.#nativeTempo);
    return tempo != null && native != null ? tempo / native : 1;
  }

  // ── meter / grid ─────────────────────────────────────────────────────────

  /** This deck's own per-track meter id — a cheap field read for the hot paths. */
  get meter() { return this.#meter; }

  setMeter(meter) {
    const next = normalizeMeterId(meter);
    if (next === this.#meter) return;
    this.#meter = next;
    this.#emit('meter');
  }

  /** This deck's OWN launch grid in bars (0 = none) — per-deck, never shared between players. */
  get launchGridBars() { return this.#launchGridBars; }

  setLaunchGridBars(bars) {
    const n = Number(bars);
    if (!Number.isFinite(n) || n < 0 || n === this.#launchGridBars) return;
    this.#launchGridBars = n;
    this.#emit('launch-grid');
  }

  /** The launch grid expressed in quarter-note beats over this deck's OWN meter (0 = none). */
  get launchGridQuarterBeats() {
    return this.#launchGridBars > 0 ? this.#launchGridBars * sharedBeatsPerBar(this.#meter) : 0;
  }

  getGridMarker() { return buildGridMarker(this.#gridMarkerTimeSec); }
  getGridMarkers() { return Object.freeze([this.getGridMarker()]); }
  getGridMarkerTimeSec() { return this.#gridMarkerTimeSec; }

  setGridMarkerTimeSec(gridMarkerTimeSec) {
    const next = clampGridStartTimeSec(gridMarkerTimeSec);
    if (Math.abs(next - this.#gridMarkerTimeSec) <= 0.0005) return;
    this.#gridMarkerTimeSec = next;
    this.#emit('grid-marker');
  }

  // ── clock seam ───────────────────────────────────────────────────────────

  /** Inject the shared-clock snapshot source (the realm-wide shared clock; a function so the beat
   *  read stays live — never cache the beat). */
  setSharedClockSource(fn) {
    this.#sharedClockSource = typeof fn === 'function' ? fn : null;
  }

  /** Inject this deck's own playback-position source: () => ({ playing, positionMs }). Wired by the
   *  audio adapter once playback exists. */
  setPositionSource(fn) {
    this.#positionSource = typeof fn === 'function' ? fn : null;
  }

  /** The raw shared-clock snapshot (or null when no source / not joined) — for consumers that need
   *  the full joined-state payload (quantized launch), not just a beat. */
  getSharedClockState() {
    if (!this.#sharedClockSource) return null;
    try { return this.#sharedClockSource(); } catch (_) { return null; }
  }

  /**
   * The deck's beat clock — the choice every per-player feature used to hand-assemble, behind ONE
   * seam. Returns `{ beatNow, secondsPerBeat }` or null when there is nothing to click to:
   *  - synced with a live shared session → the SHARED clock (same beat reference as launch
   *    quantization, room-wide);
   *  - otherwise → this deck's OWN playback: beat position from its source position relative to ITS
   *    grid marker (beats live on the source grid, so this is rate-invariant), wall tempo = the
   *    transport tempo it is actually playing at (native × followRatio).
   */
  clock() {
    if (this.#syncEnabled) {
      const shared = this.getSharedClockState();
      if (shared && shared.joined === true) {
        const sharedBpm = Number(shared.tempoBpm);
        const beatNow = Number(shared.beatNow);
        if (sharedBpm > 0 && Number.isFinite(beatNow)) {
          return { beatNow, secondsPerBeat: 60 / sharedBpm };
        }
      }
    }
    const pos = this.#positionSource ? this.#positionSource() : null;
    if (!pos || pos.playing !== true) return null;
    const native = toPositiveNumber(this.#nativeTempo);
    const posSec = Number(pos.positionMs) / 1000;
    if (native == null || !Number.isFinite(posSec)) return null;
    const wallBpm = native * this.followRatio;
    return {
      beatNow: (posSec - this.#gridMarkerTimeSec) * (native / 60),
      secondsPerBeat: 60 / wallBpm,
    };
  }

  // ── alignment math (one owner of beat→playhead mapping) ──────────────────

  getCurrentSyncBeat() {
    if (typeof syncCoordinator?.getCurrentBeat === 'function') {
      return syncCoordinator.getCurrentBeat() + 1;
    }
    return 1;
  }

  computeAlignedSourcePositionMs({ durationMs = 0, loopRange = null, outputLeadMs = 0 } = {}) {
    const native = toPositiveNumber(this.#nativeTempo);
    if (native == null) return null;
    const sourceTimeSec = getSourceAudioTimeSec({
      syncBeat: this.getCurrentSyncBeat(),
      gridStartTimeSec: this.#gridMarkerTimeSec,
      trackBpm: native,
    });
    const alignedMs = wrapSourcePositionMs({ sourceTimeSec, durationMs, loopRange });
    return this.leadSourcePositionMs(alignedMs, { durationMs, loopRange, outputLeadMs });
  }

  /** Snap a source position (ms) to the NEAREST boundary of this deck's OWN launch grid — bar
   *  lines of `launchGridQuarterBeats` quarter-beats at the native tempo, anchored on the grid
   *  marker. Used by an unsynced launch: Play comes in on the deck's own bar (there is no clock to
   *  wait on while stopped — the deck's beat IS its position, so the snap moves the playhead, not
   *  the start time). Returns null when there is nothing to snap to (not following / no grid / no
   *  native tempo), so the caller starts untouched.
   *  @param {number} positionMs
   *  @param {{ launchGridQuarterBeats?: number, durationMs?: number, loopRange?: {start:number,end:number}|null }} [opts]
   *  @returns {number|null} */
  snapToOwnGridMs(positionMs, { launchGridQuarterBeats = 0, durationMs = 0, loopRange = null } = {}) {
    if (!this.following) return null; // warp off = no grid
    const quarterBeats = Number(launchGridQuarterBeats);
    const native = toPositiveNumber(this.#nativeTempo);
    if (!(quarterBeats > 0) || native == null) return null;
    const posSec = Number(positionMs) / 1000;
    if (!Number.isFinite(posSec)) return null;
    const barSec = quarterBeats * (60 / native);
    let snappedSec = this.#gridMarkerTimeSec
      + Math.round((posSec - this.#gridMarkerTimeSec) / barSec) * barSec;
    // The nearest boundary can land before the track start — take the first one at/after 0 instead.
    if (snappedSec < 0) snappedSec += Math.ceil(-snappedSec / barSec) * barSec;
    return wrapSourcePositionMs({ sourceTimeSec: snappedSec, durationMs, loopRange });
  }

  /** Manual audio offset — advance a source position (ms) by `outputLeadMs` of WALL time so this
   *  device's audio leaves the speaker that many ms earlier. Wall-ms → source-ms scales by the
   *  follow ratio; a zero lead is a NO-OP (the position is returned untouched, not even re-wrapped),
   *  so plain seeks stay byte-identical when the offset is off. */
  leadSourcePositionMs(sourceMs, { durationMs = 0, loopRange = null, outputLeadMs = 0 } = {}) {
    const base = Number(sourceMs);
    if (!outputLeadMs || !Number.isFinite(base)) return base;
    const rate = Number(this.followRatio) > 0 ? Number(this.followRatio) : 1;
    return wrapSourcePositionMs({ sourceTimeSec: (base + outputLeadMs * rate) / 1000, durationMs, loopRange });
  }

  // ── coordinator feeds ────────────────────────────────────────────────────

  /** The coordinator fans every master tempo change to EVERY deck; the adopt gate lives HERE (the
   *  one gate): a deck adopts the master into its transport tempo only while it follows the master
   *  (synced, or solo). An unsynced collection deck ignores it — its tempo is its own. */
  receiveMasterChange(detail) {
    if (this.#disposed) return;
    const master = toPositiveNumber(detail?.bpm);
    if (master == null) return;
    if (!(this.#syncEnabled || !this.#collection)) return;
    if (master === this.#tempo) return;
    this.#tempo = master;
    this.#tempoIsPlaceholder = false;
    this.#emit('bpm');
  }

  /** Session/status change from the coordinator (enable/disable/mode/peers). The deck merges its
   *  OWN flags into the detail it retains (late subscribers read this deck's truth), but re-emits
   *  deck-changed only when its own enable/warp state actually moved — peer/mode churn is chrome's
   *  business (the coordinator's session channel), not the audio path's. */
  receiveStatusChange(detail) {
    if (this.#disposed) return;
    const previous = this.#lastStatusDetail;
    this.#lastStatusDetail = detail == null ? null : {
      ...detail,
      enabled: this.#collection ? this.#syncEnabled : detail?.enabled === true,
      wrapEnabled: this.#warp,
    };
    const changed =
      previous?.enabled !== this.#lastStatusDetail?.enabled ||
      previous?.wrapEnabled !== this.#lastStatusDetail?.wrapEnabled;
    if (changed) this.#emit('sync-status');
  }

  /** Last status detail this deck retained (null until the first feed) — late-subscriber truth. */
  getStatusDetail() { return this.#lastStatusDetail; }

  // ── notification ─────────────────────────────────────────────────────────

  /** Subscribe to deck-changed. Listener gets (snapshot, reason); reasons: 'bpm' | 'sync-status' |
   *  'meter' | 'grid-marker'. Returns an unsubscribe fn. */
  onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** The deck's public snapshot. Keys `bpm`/`trackBpm`/`baseRate`/`syncEnabled`/`wrapEnabled` are
   *  the legacy wire names (the `orbiters:wrap-grid-change` payload React stores/tests already
   *  read); the class getters (`tempo`/`nativeTempo`/`followRatio`/`warp`) are the canonical API. */
  getSnapshot() {
    const gridMarker = buildGridMarker(this.#gridMarkerTimeSec);
    return {
      voiceId: this.#voiceId,
      following: this.following,
      syncEnabled: this.#collection ? this.#syncEnabled : syncCoordinator?.isEnabled === true,
      wrapEnabled: this.#warp,
      launchGridBars: this.#launchGridBars,
      gridMarkerTimeSec: this.#gridMarkerTimeSec,
      gridMarker,
      gridMarkers: Object.freeze([gridMarker]),
      gridStartTimeSec: this.#gridMarkerTimeSec,
      bpm: this.#tempo,
      trackBpm: this.#nativeTempo,
      tempoMissing: this.#nativeTempo == null,
      baseRate: this.followRatio,
      meter: this.#meter,
    };
  }

  #emit(reason) {
    if (this.#disposed) return;
    const snapshot = this.getSnapshot();
    this.#listeners.forEach((listener) => {
      try {
        listener(snapshot, reason);
      } catch (error) {
        console.error('[Deck] listener error', error);
      }
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(WRAP_GRID_CHANGE_EVENT, {
        detail: { ...snapshot, reason },
      }));
    }
  }

  /** Voice teardown: release sync membership (so removing the only synced deck releases the
   *  session), then go inert. */
  dispose() {
    if (this.#disposed) return;
    const wasSynced = this.#syncEnabled;
    this.#syncEnabled = false;
    this.#disposed = true;
    this.#listeners.clear();
    this.#lastStatusDetail = null;
    this.#sharedClockSource = null;
    this.#positionSource = null;
    if (wasSynced) recomputeSyncAggregate();
  }
}
