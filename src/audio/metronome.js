/**
 * @file src/audio/metronome.js
 * @description The metronome — a LOCAL MONITOR click on the beat while playing, with an accent on
 * the downbeat per the per-track meter. PER-PLAYER: each voice in a collection owns its own
 * independent click stream (its own on/off flag, its own meter, its own clock), so one, the other,
 * or both metronomes can sound at the same time — two players with different meters click their own
 * accents. Single-orbiter keeps one stream, byte-identical to the old device behavior.
 *
 * Clock, per player: a SYNCED player's click reads the shared clock — the same `getState().beatNow`
 * the launch grid reads — so its accent lands on the shared bar boundary and on the same beat on
 * every device in the room. An UNSYNCED player opted out of that clock: its click derives from its
 * OWN playback position and OWN native tempo (grid-marker aligned), so it monitors what that deck is
 * actually playing. Single-orbiter (no per-voice clock) keeps the device transport fallback.
 *
 * Routing / capture: the click plays to the raw AudioContext destination (the speakers), OUTSIDE the
 * Tone master graph — a monitor, not part of the mix. Screen/tab capture records the whole tab output,
 * so a routing trick can't hide it; instead we MUTE the metronome while capture is recording
 * (`setMuted`) so it never lands in a recording. That is the honest "monitor-only" behavior.
 *
 * Scheduling: a small look-ahead pump (like the shipped clock pump) arms each upcoming beat's click on
 * the audio clock a hair ahead of its deadline; it re-reads the live tempo each tick so a tempo change
 * only affects not-yet-armed beats. A seek (or any other discontinuity in the beat position) is
 * detected by comparing how far `beatNow` actually moved between two pump ticks against how far it
 * SHOULD have moved given how much real audio-clock time elapsed — continuous playback keeps those in
 * lockstep, a seek breaks it (the beat position jumps while the audio clock just keeps ticking at its
 * normal ~25ms pace) — and resets the armed-ahead cache, the same way a pause/resume already does, so
 * the click can't go stale/silent relative to the new position.
 *
 * Manual audio offset: while a shared session is live (`syncCoordinator.isEnabled`), the click is led
 * by the same per-device output-latency offset (`getManualAudioOffsetMs`) applied to playback, so the
 * click, the mix, and the visual grid all agree on when a beat actually sounds — the metronome isn't a
 * separate, uncorrected clock.
 */
import * as Tone from 'tone';
import { parseMeter, DEFAULT_METER_ID } from '../sync/meter.js';
import { syncCoordinator } from '../sync/SyncCoordinator.js';
import { getSharedClockState } from '../sync/init.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { isMetronomeEnabled, METRONOME_CHANGED_EVENT } from '../config/metronome.js';
import { getManualAudioOffsetMs } from '../config/audioOffset.js';
import { captureControl, CAPTURE_STATE_CHANGE_EVENT } from '../export/capture.js';

/** The meter to accent by: the FOCUSED voice's OWN per-track meter — this is one shared click stream
 * for the whole device, so it tracks whichever orbiter you're currently focused on, matching that
 * orbiter's own grid. Meter is always per-voice (owned by each voice's deck); falls back to the
 * default only before any voice is registered.
 */
function resolveActiveMeterId() {
  return voiceRegistry.getActive()?.deck?.meter ?? DEFAULT_METER_ID;
}

const PUMP_INTERVAL_MS = 25;
const LOOKAHEAD_SEC = 0.12;
const DISCONTINUITY_TOLERANCE_BEATS = 0.5; // slack for scheduling jitter; real seeks are far bigger

export class Metronome {
  /**
   * @param {{
   *   getMeterId?: () => string,
   *   getClockState?: () => ({ beatNow: number, secondsPerBeat: number } | null),
   *   getOutputLeadMs?: () => number,
   * }} [sources] per-player providers; omitted → the single-orbiter/device defaults (focused-voice
   *   meter, device transport/shared clock, sync-gated manual audio offset).
   */
  constructor({ getMeterId = null, getClockState = null, getOutputLeadMs = null } = {}) {
    this._enabled = false; // user toggle
    this._muted = false; // capture gate
    this._pumpId = null;
    this._nextBeat = null; // next quarter-beat position to arm; may be fractional for 6/8, 7/8, etc.
    this._nextBeatStep = null;
    this._lastBeatNow = null; // beatNow observed on the previous pump tick, for seek/jump detection
    this._lastAudioTime = null; // ctx.currentTime observed alongside _lastBeatNow
    this._armed = new Set(); // oscillators scheduled but not yet sounded (for cancel-on-mute)
    this._getMeterId = getMeterId ?? resolveActiveMeterId;
    this._getClockState = getClockState ?? (() => this._clockState());
    this._getOutputLeadMs = getOutputLeadMs
      ?? (() => (syncCoordinator?.isEnabled === true ? getManualAudioOffsetMs() : 0));
  }

  setEnabled(on) {
    this._enabled = !!on;
    this._sync();
  }

  isEnabled() {
    return this._enabled;
  }

  /** Capture gate: mute while a recording is in progress (the click must not land in the capture). */
  setMuted(on) {
    this._muted = !!on;
    this._sync();
  }

  _active() {
    return this._enabled && !this._muted;
  }

  _sync() {
    if (this._active() && this._pumpId == null) {
      this._nextBeat = null;
      this._nextBeatStep = null;
      this._lastBeatNow = null;
      this._lastAudioTime = null;
      this._pumpId = setInterval(() => this._pump(), PUMP_INTERVAL_MS);
    } else if (!this._active() && this._pumpId != null) {
      clearInterval(this._pumpId);
      this._pumpId = null;
      this._nextBeat = null;
      this._nextBeatStep = null;
      this._lastBeatNow = null;
      this._lastAudioTime = null;
      // Cancel clicks already armed on the audio clock (up to LOOKAHEAD ahead) so muting for a capture
      // takes effect immediately — nothing already scheduled leaks into the recording.
      this._cancelArmed();
    }
  }

  /** Silence + drop every click scheduled but not yet sounded. */
  _cancelArmed() {
    const ctx = this._rawContext();
    const now = ctx && typeof ctx.currentTime === 'number' ? ctx.currentTime : 0;
    this._armed.forEach((osc) => {
      try { osc.stop(now); } catch { /* already stopped */ }
    });
    this._armed.clear();
  }

  /**
   * The current beat position + tempo, or null when this device isn't playing.
   *
   * The click only fires while the focused voice's transport is running (so a paused deck is silent even
   * though the shared clock keeps advancing). WHERE the downbeat falls, though, comes from the shared
   * clock when a session is live — the SAME beat reference the launch grid uses
   * (`AudioEngineAdapter._computeBarDelayMs` reads `getState().beatNow`). Reading it here makes the
   * metronome accent land on the same bar boundary as launch quantization and on the same beat on every
   * device in the room. Solo (no shared session) reads the focused voice's own transport POSITION and the
   * master tempo (`syncCoordinator.bpm` — the one tempo owner), which is exactly what this device hears.
   */
  _clockState() {
    const transport = voiceRegistry.getActive()?.audioEngine?.transport;
    if (!transport || transport.isRunning !== true) return null;
    const shared = getSharedClockState();
    if (shared && shared.joined === true) {
      const sharedBpm = Number(shared.tempoBpm);
      const beatNow = Number(shared.beatNow);
      if (sharedBpm > 0 && Number.isFinite(beatNow)) {
        return { beatNow, secondsPerBeat: 60 / sharedBpm };
      }
    }
    const bpm = Number(syncCoordinator?.bpm);
    const seconds = Number(transport.getCurrentTimeMs?.()) / 1000;
    if (!(bpm > 0) || !Number.isFinite(seconds)) return null;
    return { beatNow: seconds / (60 / bpm), secondsPerBeat: 60 / bpm };
  }

  _rawContext() {
    const ctx = Tone.getContext?.() ?? Tone.context;
    return ctx?.rawContext ?? ctx;
  }

  _pump() {
    const st = this._getClockState();
    if (!st) {
      // Transport not running (paused/stopped) — nothing to arm; resync the phase on next start.
      this._nextBeat = null;
      this._lastBeatNow = null;
      this._lastAudioTime = null;
      return;
    }
    const ctx = this._rawContext();
    if (!ctx || typeof ctx.currentTime !== 'number') return;
    const nowAudio = ctx.currentTime;
    // A seek (or any other discontinuity) lands between two pump ticks without the transport ever
    // leaving `started`, so it can't be caught by the pause/resume reset above. Continuous playback
    // keeps beatNow and the audio clock in lockstep — compare how far beatNow actually moved since the
    // last tick against how far it SHOULD have moved given the elapsed audio time; a seek breaks that
    // lockstep (beatNow jumps while the audio clock just keeps ticking at its normal pace), so a
    // mismatch past a small tolerance means the armed-ahead cache no longer describes the current
    // position — drop it and recompute fresh.
    if (this._lastBeatNow != null && this._lastAudioTime != null) {
      const expectedBeatNow = this._lastBeatNow + (nowAudio - this._lastAudioTime) / st.secondsPerBeat;
      if (Math.abs(st.beatNow - expectedBeatNow) > DISCONTINUITY_TOLERANCE_BEATS) {
        this._nextBeat = null;
      }
    }
    this._lastBeatNow = st.beatNow;
    this._lastAudioTime = nowAudio;
    const meter = parseMeter(this._getMeterId());
    const beatsPerBar = Math.max(1e-9, meter.sharedBeatsPerBar);
    const step = Math.max(1e-9, meter.clickIntervalQuarterBeats);
    const clicksPerBar = Math.max(1, meter.clicksPerBar);
    if (this._nextBeatStep !== step) {
      this._nextBeat = null;
      this._nextBeatStep = step;
    }
    if (this._nextBeat == null) {
      this._nextBeat = (Math.floor((st.beatNow + 1e-6) / step) + 1) * step;
    }
    // While a shared session is live, lead the click by the same per-device output-latency offset
    // applied to playback (`AudioEngineAdapter._leadSeekPositionMs`/`_alignWrapPlaybackPosition`), so
    // the click agrees with the mix and the visual grid instead of being a separate, uncorrected clock.
    // Per-player streams gate this on THEIR voice's own sync; solo/unsynced it's a no-op.
    const outputLeadSec = this._getOutputLeadMs() / 1000;
    // Arm every denominator-note click whose audio time falls within the look-ahead window.
    for (let guard = 0; guard < 128; guard += 1) {
      const beatTime = nowAudio + (this._nextBeat - st.beatNow) * st.secondsPerBeat - outputLeadSec;
      if (beatTime > nowAudio + LOOKAHEAD_SEC) break;
      if (beatTime > nowAudio + 0.001) {
        const phaseInBar = ((this._nextBeat % beatsPerBar) + beatsPerBar) % beatsPerBar;
        const clickIndexInBar = ((Math.round(phaseInBar / step) % clicksPerBar) + clicksPerBar) % clicksPerBar;
        const accent = clickIndexInBar === 0;
        this._click(ctx, beatTime, accent);
      }
      this._nextBeat += step;
    }
  }

  /** A short square-wave click at `time` (audio-clock seconds); accent = brighter + louder. */
  _click(ctx, time, accent) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1760 : 1100;
    const peak = accent ? 0.3 : 0.16;
    const dur = accent ? 0.05 : 0.035;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(peak, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + dur + 0.02);
    // Track until it sounds so a mid-look-ahead mute (capture start) can cancel it.
    this._armed.add(osc);
    osc.onended = () => {
      this._armed.delete(osc);
      try { gain.disconnect(); } catch { /* ignore */ }
    };
  }

  dispose() {
    if (this._pumpId != null) clearInterval(this._pumpId);
    this._pumpId = null;
  }
}

/** The single-orbiter (no-collection) stream — default providers, byte-identical to the old device
 *  behavior. Kept as a named export for tests and the `window.orbitersMetronome` debug handle. */
export const metronome = new Metronome();

/** Whether THIS voice is itself synced — its deck's own flag in multi; single-orbiter uses the
 *  realm aggregate (byte-identical to the historical behavior). */
function voiceIsSynced(record) {
  return voiceRegistry.size > 1
    ? record?.deck?.syncEnabled === true
    : syncCoordinator?.isEnabled === true;
}

/** Per-player streams (voiceId → Metronome). The `null`/single-orbiter slot is `metronome` above. */
const voiceStreams = new Map();
let capturedMuted = false;

/** Providers for ONE player's stream — the deck is the one owner of "which meter, which clock":
 *  `deck.clock()` chooses the shared clock (synced, session live) or the deck's own playback
 *  (beats from its source position over ITS grid marker, at the tempo it actually plays). */
function makeVoiceSources(voiceId) {
  return {
    getMeterId: () => voiceRegistry.get(voiceId)?.deck?.meter ?? DEFAULT_METER_ID,
    getClockState: () => {
      const record = voiceRegistry.get(voiceId);
      if (!record) {
        // The voice was torn down (tile removed) — silence and drop its stream so no pump leaks.
        queueMicrotask(() => disposeVoiceMetronome(voiceId));
        return null;
      }
      return record.deck?.clock() ?? null;
    },
    getOutputLeadMs: () =>
      (voiceIsSynced(voiceRegistry.get(voiceId)) ? getManualAudioOffsetMs() : 0),
  };
}

/** The stream for a player, created on first use (voiceId null → the single-orbiter stream). */
export function ensureVoiceMetronome(voiceId) {
  if (voiceId == null) return metronome;
  let stream = voiceStreams.get(voiceId);
  if (!stream) {
    stream = new Metronome(makeVoiceSources(voiceId));
    stream.setMuted(capturedMuted);
    voiceStreams.set(voiceId, stream);
  }
  return stream;
}

/** Tear down one player's stream (tile removed). */
export function disposeVoiceMetronome(voiceId) {
  const stream = voiceStreams.get(voiceId);
  if (!stream) return;
  stream.setEnabled(false);
  stream.dispose();
  voiceStreams.delete(voiceId);
}

let installed = false;
/**
 * Wire the streams to their inputs: the per-player enabled toggles (store + change event) and the
 * capture gate (mute ALL streams while recording — no click may land in a capture). Idempotent;
 * call once at app boot. No-op outside the browser.
 */
export function installMetronome() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  try {
    window.orbitersMetronome = metronome;
  } catch { /* ignore */ }
  metronome.setEnabled(isMetronomeEnabled());
  window.addEventListener(METRONOME_CHANGED_EVENT, (e) => {
    const voiceId = e?.detail?.voiceId ?? null;
    ensureVoiceMetronome(voiceId).setEnabled(e?.detail?.enabled ?? isMetronomeEnabled(voiceId));
  });
  const syncMuted = () => {
    capturedMuted = captureControl?.getState?.() === 'recording';
    metronome.setMuted(capturedMuted);
    voiceStreams.forEach((stream) => stream.setMuted(capturedMuted));
  };
  window.addEventListener(CAPTURE_STATE_CHANGE_EVENT, syncMuted);
  syncMuted();
}
