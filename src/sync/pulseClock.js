/**
 * @file sync/pulseClock.js
 * @description The ONE SHARED PULSE for a realm (tempo + beat + phase),
 * wrapping the proven leaderless `BeatTimeline` engine (clock-killgate–validated). This is the single
 * pulse owner that replaces SyncCoordinator's hand-rolled conductor tempo: one engine for the in-tab
 * case (a no-network `LocalRelay`) AND the cross-room case (the Connect socket via the tee — wired in a
 * later slice), so both topologies compute the SAME tempo/beat/phase from one code path.
 *
 * The facade owns the engine's SINGLE `onChange` callback and fans it out as a real `onTempoChange`
 * subscription, DEDUPED on tempo so the engine's non-tempo `onChange` firings (peer hello / transport)
 * never trigger a spurious per-voice projection. It also tracks `sourceType` (which the engine does not
 * store) so the per-voice projection keeps the `module` vs `remote` distinction it depends on.
 *
 * `getState()` stays the read-only seam the audio path consumes (same shape as the old
 * localClock/sharedClock): `{ joined, beatNow, phaseNow, tempoBpm, quantum } | null`. The audio path
 * never imports `BeatTimeline` — it only reads this snapshot.
 *
 * One-owner rule: this pulse NEVER writes `Tone.Transport`. Tempo flows IN via `setTempo` (from the
 * tempoPitch knob authority, delegated through `SyncCoordinator`) and OUT via `onTempoChange` (to the
 * per-voice projection).
 *
 * WIRING: `sync/init.js` constructs the in-tab pulse (`createLocalPulseClock`) by default and hands it
 * to `SyncCoordinator.init`, which delegates tempo to it. The cross-room (Connect tee) constructor +
 * the room default-on land in a later slice.
 */
import { BeatTimeline } from 'entangled-worlds-orbiters-shared/clock/sync';
import { getLaunchGridQuarterBeats, DEFAULT_LAUNCH_GRID_BEATS } from './launchGrid.js';

const mod = (n, m) => ((n % m) + m) % m;

/** Tempo dedupe / re-propose epsilon (bpm). Below this a change is "the same tempo". */
export const TEMPO_EPSILON = 1e-3;

/**
 * A fixed shared session epoch so every same-device context anchors the SAME beat grid with zero
 * coordination (matches the old localClock constant). Beat numbers stay small enough for ample float
 * precision (~3e7 beats ⇒ ULP ≪ 1µs).
 */
export const DEFAULT_SESSION_EPOCH_MS = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z

/**
 * `LocalRelay` — the no-network `RelaySeam` for the in-tab pulse. The in-tab case needs none of the
 * server-time offset machinery: a fixed epoch + `Date.now()` is already a shared session clock, so
 * same-device contexts agree on the beat GRID. One in-tab realm uses ONE singleton ⇒ no peers ⇒ `send`
 * is a no-op; cross-tab / cross-device tempo REPLICATION is the room (network) slice, not this relay.
 * This is the no-network analogue of `ConnectRelay`.
 *
 * Implements the engine's `RelaySeam` (entangled-worlds-orbiters-shared/clock/sync):
 * `{ sessionEpochMs, upMs, downMs, serverNowMs(), register(node), send(fromId, msg, toId?) }`.
 */
export class LocalRelay {
  /**
   * @param {{ now?: () => number, sessionEpochMs?: number }} [opts]
   */
  constructor({ now = () => Date.now(), sessionEpochMs = DEFAULT_SESSION_EPOCH_MS } = {}) {
    this._now = now;
    this.sessionEpochMs = sessionEpochMs; // stable for the tab's life
    this.upMs = 0; // no network leg
    this.downMs = 0;
    this._node = null;
  }

  serverNowMs() {
    return this._now();
  }

  register(node) {
    this._node = node;
  }

  // No peers on one in-tab singleton — nothing to broadcast.
  send() {}
}

/**
 * The read-only snapshot the audio path consumes for its bar-quantized START. Returns null until the
 * pulse is "joined" (a shared session is live), so a solo orbiter never quantizes.
 * @param {BeatTimeline} beat
 * @param {boolean} joined
 * @param {number} quantum — the launch grid in beats
 * @returns {{ joined: true, beatNow: number, phaseNow: number, tempoBpm: number, quantum: number } | null}
 */
export function readPulseState(beat, joined, quantum) {
  if (!joined) return null;
  // 0 = none (no snap) is a valid grid — preserve it; only non-finite / negative garbage falls back.
  const q = Number(quantum);
  const grid = Number.isFinite(q) && q >= 0 ? q : DEFAULT_LAUNCH_GRID_BEATS;
  const beatNow = beat.beatNow();
  return { joined: true, beatNow, phaseNow: grid > 0 ? mod(beatNow, grid) : 0, tempoBpm: beat.tempoBpm, quantum: grid };
}

/**
 * Build the pulse facade over a `BeatTimeline`. The engine itself is reuse-only (untouched); this wraps
 * it with the contract every caller depends on.
 *
 * @param {{
 *   relay: import('entangled-worlds-orbiters-shared/clock/sync').RelaySeam,
 *   audioClock?: { nowSec: () => number },
 *   quantum?: number,
 *   trueOffsetMs?: number,
 *   isJoined: (beat: BeatTimeline) => boolean,   // is a shared session live? (in-tab: ≥2 voices; room: joined+peers)
 *   getQuantum?: () => number,                    // live launch grid; defaults to the shared grid
 *   id?: string,
 * }} cfg
 * @returns {{
 *   beat: BeatTimeline,
 *   getState: () => ReturnType<typeof readPulseState>,
 *   getTempoBpm: () => number,
 *   getCurrentBeat: () => number,
 *   setTempo: (bpm: number, opts?: { sourceType?: string }) => void,
 *   onTempoChange: (fn: (e: { tempoBpm: number, sourceType: string }) => void) => (() => void),
 *   setEnabled: (on: boolean) => void,
 *   dispose: () => void,
 * }}
 */
export function createPulseClock({
  relay,
  audioClock,
  quantum = DEFAULT_LAUNCH_GRID_BEATS,
  trueOffsetMs = 0,
  isJoined,
  getQuantum,
  id,
} = {}) {
  if (typeof isJoined !== 'function') {
    throw new TypeError('createPulseClock: isJoined(beat) is required');
  }
  const peerId = id ?? `orbiter-${Math.random().toString(36).slice(2, 9)}`;
  const clock = audioClock ?? {
    nowSec: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
  };
  // Constructor self-registers with the relay and anchors anchorSessionMs = relay.sessionEpochMs.
  const beat = new BeatTimeline({ id: peerId, relay, audioClock: clock, quantum, trueOffsetMs });

  const quantumFn = getQuantum ?? (() => getLaunchGridQuarterBeats());

  // --- the single onChange owner → deduped tempo fan-out -------------------------------------------
  const tempoSubs = new Set();
  let lastTempo = beat.tempoBpm;
  // A LOCAL setTempo stamps its caller intent in pendingSource; a tempo change observed with no pending
  // local intent is a REMOTE adoption (peer beat:timeline, last-writer-wins).
  let pendingSource = null;

  beat.onChange = () => {
    const t = beat.tempoBpm;
    if (Math.abs(t - lastTempo) <= TEMPO_EPSILON) return; // non-tempo onChange (hello/transport/anchor) — ignore
    lastTempo = t;
    const sourceType = pendingSource ?? 'remote';
    for (const fn of tempoSubs) {
      try {
        fn({ tempoBpm: t, sourceType });
      } catch (e) {
        console.warn('[pulse-clock] onTempoChange subscriber threw:', e);
      }
    }
  };

  return {
    beat, // exposed for join/anchor wiring (network slice) + tests

    getState: () => readPulseState(beat, isJoined(beat), quantumFn()),

    getTempoBpm: () => beat.tempoBpm,
    getCurrentBeat: () => beat.beatNow(),

    /**
     * Propose a shared tempo (leaderless). Epsilon-guarded: never re-proposes a tempo equal to the
     * current one, which prevents an onChange → projection → setTempo feedback loop.
     */
    setTempo(bpm, { sourceType: st = 'manual' } = {}) {
      const n = Number(bpm);
      if (!Number.isFinite(n) || n <= 0) return;
      if (Math.abs(n - beat.tempoBpm) <= TEMPO_EPSILON) return; // already at this tempo — no re-propose
      pendingSource = st;
      try {
        beat.setTempo(n); // fires onChange synchronously inside _commit
      } finally {
        pendingSource = null;
      }
    },

    /** Subscribe to deduped tempo changes. Returns an unsubscribe fn. */
    onTempoChange(fn) {
      tempoSubs.add(fn);
      return () => tempoSubs.delete(fn);
    },

    setEnabled(on) {
      beat.setEnabled(on);
    },

    /**
     * Relinquish our timeline ownership on ROOM join so a joiner ADOPTS the established room tempo
     * instead of imposing its own boot `setTempo`. Reset BOTH:
     *  - the stamp to the "no claim" sentinel (`time:-1`, the engine constructor default) so any real
     *    peer timeline wins `newerTs`; and
     *  - the local timeline back to the engine default — so that when BOTH we and the peer carry `-1`
     *    (a room where nobody has set a tempo yet), the `-1` id-tiebreak can't preserve a tempo the room
     *    never had (our boot value), it just keeps the shared default until someone sets one. A real peer
     *    tempo still overwrites this the moment the first reply lands.
     */
    relinquishClaim() {
      beat._ts = { time: -1, id: peerId };
      // Matches BeatTimeline's constructor default (tempoBpm 120, beat 0 at the session epoch).
      beat.timeline = { tempoBpm: 120, anchorBeat: 0, anchorSessionMs: relay.sessionEpochMs };
      // Invalidate the onChange dedupe baseline so the FIRST post-join adoption ALWAYS emits — even if
      // the room tempo equals our (now-stale) lastTempo. Without this, a joiner whose boot setTempo
      // advanced lastTempo while the display mirror was still gated off (sync not enabled yet) would
      // dedupe-skip an adoption equal to that hidden value, leaving the on-screen BPM stuck
      // ("join an ongoing session, the number doesn't adopt"). NaN makes any |room - NaN| <= eps false.
      lastTempo = NaN;
    },

    dispose() {
      tempoSubs.clear();
      beat.onChange = null;
    },
  };
}

/**
 * Convenience constructor for the IN-TAB pulse (no network): a `LocalRelay` + the facade. Several
 * orbiter voices in one realm share this ONE instance, so they lock to one pulse with zero traffic.
 *
 * @param {{
 *   audioClock?: { nowSec: () => number },
 *   isJoined: (beat: BeatTimeline) => boolean,
 *   getQuantum?: () => number,
 *   now?: () => number,
 *   sessionEpochMs?: number,
 *   id?: string,
 * }} cfg
 */
export function createLocalPulseClock({ audioClock, isJoined, getQuantum, now, sessionEpochMs, id } = {}) {
  const relay = new LocalRelay({ now, sessionEpochMs });
  const pulse = createPulseClock({ relay, audioClock, isJoined, getQuantum, id });
  return { ...pulse, relay };
}
