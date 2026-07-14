// AudioClickBackend — the real ClockBackend for the clock kill-gate harness.
//
// This is a TypeScript port of the prototype `AudioContextBackend.js` + its demo `RealAudioBackend.js`,
// trimmed to exactly what the gate needs: anchor on the Web Audio hardware clock and SOUND a short
// metronome click at a precise future audio time. It satisfies the shared `ClockBackend` contract
// (`entangled-worlds-orbiters-shared/clock`): `nowSec()` + `armAt(audioTimeSec, payload)` -> cancel handle.
//
// Why a real backend matters here: the kill-gate must prove the click is PHYSICALLY steady on real
// hardware over the real Connect server. The Transport arms each beat AHEAD of its deadline; HERE is
// where `osc.start(audioTime)` makes the sample-clock — not a JS timer — fire the sound. The cancel
// handle silences a voice that hasn't started yet (pause/seek/loop change), matching the base contract.
//
// It ALSO records, per armed click, the intended vs scheduled audio time so the harness can export
// scheduling-side jitter data (see ClockKillgate.recordSample). True acoustic capture (a mic recording
// the speaker) is a separate manual step — this logs the scheduling truth, not the acoustic truth.

import type { ClockBackend, CancelHandle } from 'entangled-worlds-orbiters-shared/clock';

/** What the Transport hands `armAt` as `payload` (see Transport.tick: `{ atSec, data }`). */
export interface ClickPayload {
  atSec: number;
  data?: { accent?: boolean; freq?: number; gain?: number } | null;
}

/** One recorded scheduling event — the harness samples these for offline jitter analysis. */
export interface ScheduledClick {
  /** The transport beat's intended atSec (timeline seconds). */
  atSec: number;
  /** Absolute audio-context time the click was scheduled to sound at. */
  scheduledAudioSec: number;
  /** Audio-context time when armAt was called (how far ahead it was armed). */
  armedAtAudioSec: number;
  /** Whether this was a downbeat accent. */
  accent: boolean;
}

export class AudioClickBackend implements ClockBackend {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly comp: DynamicsCompressorNode;

  scheduledCount = 0;
  cancelledCount = 0;
  /** Rolling log of scheduled clicks for export (bounded so the harness can run for hours). */
  readonly scheduled: ScheduledClick[] = [];
  private readonly maxLog: number;

  constructor(ctx: AudioContext, opts: { maxLog?: number } = {}) {
    this.ctx = ctx;
    this.maxLog = opts.maxLog ?? 100_000;

    // One master bus + a gentle compressor (clicks are peaky).
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.12;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);
  }

  /** The anchor: sample-accurate audio hardware time, in seconds. Monotonic. */
  nowSec(): number {
    return this.ctx.currentTime;
  }

  /**
   * The hardware audio-output latency snapshot, read LIVE off the owned AudioContext at call time.
   *
   * Why this matters to the gate: the acoustic offset between two clients = (clock/offset bias) +
   * (difference in audio OUTPUT latency). The kill-gate's first acoustic recording could not split
   * those because these fields were never captured. We read them here, from the context's owner, so
   * the export records real numbers (or an explicit `null` where the platform doesn't expose a field —
   * `outputLatency` is non-standard and absent on some browsers, e.g. Safari) — never `undefined`.
   *
   *  - `outputLatencySec`  AudioContext.outputLatency: time from a sample being handed to the OS audio
   *                        graph to it leaving the speaker. The dominant per-client acoustic-offset term.
   *  - `baseLatencySec`    AudioContext.baseLatency: the context's internal processing/buffer latency.
   *  - `sampleRate`        the context sample rate (always present once the context exists).
   */
  latencySnapshot(): { outputLatencySec: number | null; baseLatencySec: number | null; sampleRate: number } {
    const ctx = this.ctx as AudioContext & { outputLatency?: number; baseLatency?: number };
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      outputLatencySec: num(ctx.outputLatency),
      baseLatencySec: num(ctx.baseLatency),
      // sampleRate is a required AudioContext property; present whenever the context exists.
      sampleRate: ctx.sampleRate,
    };
  }

  setVolume(v: number): void {
    const g = Math.max(0, Math.min(1, v));
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
  }

  /**
   * Arm a real metronome click at `audioTimeSec`. Returns a cancel handle that silences the voice if it
   * has not started yet. Pure audio I/O — the Transport detects occurrence + fires its own callback.
   */
  armAt(audioTimeSec: number, payload: unknown): CancelHandle {
    const p = (payload ?? {}) as Partial<ClickPayload>;
    const data = p.data ?? {};
    const accent = !!data.accent;
    const ctx = this.ctx;

    // Record the scheduling-side truth for export (intended vs scheduled, and how far ahead we armed).
    this.scheduledCount += 1;
    if (this.scheduled.length < this.maxLog) {
      this.scheduled.push({
        atSec: typeof p.atSec === 'number' ? p.atSec : audioTimeSec,
        scheduledAudioSec: audioTimeSec,
        armedAtAudioSec: this.nowSec(),
        accent,
      });
    }

    const voice = this.buildClick(ctx, audioTimeSec, accent, data);

    let stopped = false;
    return () => {
      // Already sounded (or about to within a hair): cancelling is a no-op, matching the base contract.
      if (stopped || ctx.currentTime >= audioTimeSec) return false;
      stopped = true;
      this.cancelledCount += 1;
      try {
        voice.gain.gain.cancelScheduledValues(ctx.currentTime);
        voice.gain.gain.setValueAtTime(0, ctx.currentTime);
        voice.osc.stop(ctx.currentTime);
      } catch {
        /* node may already be stopped; ignore */
      }
      return true;
    };
  }

  /** Build + schedule one short percussive click. Accent (downbeat) is brighter + louder. */
  private buildClick(
    ctx: AudioContext,
    at: number,
    accent: boolean,
    data: { freq?: number; gain?: number },
  ): { osc: OscillatorNode; gain: GainNode } {
    const gain = ctx.createGain();
    gain.connect(this.master);

    const freq = accent ? (data.freq ?? 1760) : (data.freq ?? 1100);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, at);

    const peak = (data.gain ?? 0.5) * (accent ? 1 : 0.7);
    const dur = accent ? 0.05 : 0.035;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0005, at + dur);
    osc.connect(gain);
    osc.start(at);
    osc.stop(at + dur + 0.01);
    return { osc, gain };
  }
}
