/**
 * Headless math tests for the time-stretch playback sink: playhead projection
 * (engine inputTime lead compensation), reverse as a negative read rate with
 * identity engine mapping, loop scheduling/wrapping, tape (varispeed) semitone
 * emulation, and natural-end detection on the CORRECTED (audible) position.
 *
 * The engine node and Tone are stubbed — these tests cover the sink's math,
 * not the worklet.
 */
import { describe, it, expect, vi } from 'vitest';
import { StretchPlayerPlayback } from '../../src/audio/playback/stretchPlayer.js';

function makeSink({ durationMs = 10000 } = {}) {
  const sink = new StretchPlayerPlayback({ trackData: {} });
  const clock = { now: 0 };
  sink.Tone = {
    now: () => clock.now,
    start: async () => {},
    getContext: () => ({ lookAhead: 0 }),
  };
  sink.node = {
    scheduled: [],
    inputTime: 0,
    schedule(change) {
      this.scheduled.push(change);
    },
    stop() {},
    dropBuffers() {},
    addBuffers: async () => durationMs / 1000,
    connect() {},
    disconnect() {},
    setUpdateInterval() {},
  };
  sink._output = { gain: { rampTo: vi.fn() } };
  sink.durationMs = durationMs;
  sink.isLoaded = true;
  sink._bufferEndSec = durationMs / 1000;
  return { sink, clock };
}

const lastSchedule = (sink, key) =>
  [...sink.node.scheduled].reverse().find((change) => key in change);

describe('StretchPlayerPlayback projection', () => {
  it('advances the playhead at the stretch rate', async () => {
    const { sink, clock } = makeSink();
    await sink.triggerPlay();
    sink.setPlaybackRate(2, { immediate: true });
    clock.now = 1; // 1s after the (lookAhead 0) start
    expect(sink.getCurrentPositionMs()).toBeCloseTo(2000, -1);
  });

  it('subtracts the estimated engine read-ahead from the playhead', async () => {
    const { sink, clock } = makeSink();
    await sink.triggerPlay();
    // Engine reports inputTime 0.3s ahead of the audible position, repeatedly.
    for (const t of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
      clock.now = t;
      sink.node.inputTime = t + 0.3;
      sink._handleWorkletUpdate();
    }
    clock.now = 1;
    const positionMs = sink.getCurrentPositionMs();
    // Without compensation the playhead would read ~1300ms; with the EMA
    // converging toward the 0.3s lead it should sit near the audible 1000ms.
    expect(positionMs).toBeLessThan(1120);
    expect(positionMs).toBeGreaterThan(880);
  });

  it('ignores a stale engine sample arriving right after a seek', async () => {
    const { sink, clock } = makeSink();
    await sink.triggerPlay();
    clock.now = 5;
    await sink.setPosition(8000);
    // A worklet update still carrying the pre-seek position lands 100ms later —
    // it must not snap the playhead back.
    clock.now = 5.1;
    sink.node.inputTime = 5.1;
    sink._handleWorkletUpdate();
    expect(sink.getCurrentPositionMs()).toBeCloseTo(8100, -2);
  });

  it('wraps the projection inside the loop between engine updates', async () => {
    const { sink, clock } = makeSink();
    sink.setLoopRange(1000, 3000, { active: true });
    await sink.triggerPlay();
    // Jump far past the loop end with no fresh engine update.
    clock.now = 6;
    const positionMs = sink.getCurrentPositionMs();
    expect(positionMs).toBeGreaterThanOrEqual(1000);
    expect(positionMs).toBeLessThanOrEqual(3000);
  });
});

describe('StretchPlayerPlayback tape emulation and pitch', () => {
  it('sends semitones tracking the rate ratio in varispeed mode only', () => {
    const { sink } = makeSink();
    sink.setRateMode('varispeed');
    sink.setPlaybackRate(2, { immediate: true });
    expect(lastSchedule(sink, 'semitones').semitones).toBeCloseTo(12, 5);

    sink.setRateMode('stretch');
    expect(lastSchedule(sink, 'semitones').semitones).toBeCloseTo(0, 5);
  });

  it('stacks the independent pitch shift on top of the tape shift', () => {
    const { sink } = makeSink();
    sink.setRateMode('varispeed');
    sink.setPlaybackRate(0.5, { immediate: true });
    sink.setPitchSemitones(3);
    expect(lastSchedule(sink, 'semitones').semitones).toBeCloseTo(-12 + 3, 5);
  });

  it('reports pitch handling so effects can fall back on other sinks', () => {
    const { sink } = makeSink();
    expect(sink.setPitchSemitones(5)).toBe(true);
    sink.node = null;
    expect(sink.setPitchSemitones(5)).toBe(false);
  });
});

describe('StretchPlayerPlayback reverse', () => {
  it('reverses via a negative read rate — no buffer flip, no position mirror', async () => {
    const { sink } = makeSink({ durationMs: 10000 });
    sink.currentOffsetMs = 2000;
    await sink.setPlaybackReverse(true);

    expect(sink.isPlaybackReverse()).toBe(true);
    // Engine space == forward-material space: position is unchanged and the
    // mapping is plain identity (the worklet reads the one buffer backwards).
    expect(sink.currentOffsetMs).toBe(2000);
    expect(sink._engineSecFromUiMs(2000)).toBeCloseTo(2, 5);
    // Direction rides the SIGN of the rate, not a flipped buffer.
    expect(sink._signedRate()).toBeLessThan(0);

    // Loop bounds are scheduled directly (no mirroring).
    sink.setLoopRange(1000, 3000, { active: true });
    const loop = lastSchedule(sink, 'loopStart');
    expect(loop.loopStart).toBeCloseTo(1, 5);
    expect(loop.loopEnd).toBeCloseTo(3, 5);
  });

  it('plays backwards: engine time descends from the start offset', async () => {
    const { sink, clock } = makeSink({ durationMs: 10000 });
    await sink.setPlaybackReverse(true);
    sink.currentOffsetMs = 8000;
    await sink.triggerPlay();
    const started = lastSchedule(sink, 'input');
    expect(started.input).toBeCloseTo(8, 5); // true forward-material seconds
    expect(started.rate).toBeLessThan(0); // negative rate = reverse read
    clock.now = 1;
    // 1s of reverse at |rate| 1 → the playhead falls from 8s to 7s.
    expect(sink.getCurrentPositionMs()).toBeCloseTo(7000, -1);
  });

  it('detects the natural end at the START of the buffer when reversed', async () => {
    const { sink, clock } = makeSink({ durationMs: 1000 });
    const stops = [];
    sink.addStopListener((payload) => stops.push(payload));
    await sink.setPlaybackReverse(true);
    sink.currentOffsetMs = 1000;
    await sink.triggerPlay();

    // Playhead still above 0 → keep going.
    clock.now = 0.5;
    sink.node.inputTime = 0.5;
    sink._handleWorkletUpdate();
    expect(sink.isPlaying()).toBe(true);
    expect(stops).toHaveLength(0);

    // Playhead reaches the buffer start → ended fires once.
    clock.now = 1.0;
    sink.node.inputTime = 0;
    sink._handleWorkletUpdate();
    expect(sink.isPlaying()).toBe(false);
    expect(stops).toEqual([{ reason: 'ended' }]);
  });
});

describe('StretchPlayerPlayback lifecycle', () => {
  it('exposes granular controls only while the worklet node exists', () => {
    const { sink } = makeSink();
    sink.node.setGranularParams = vi.fn();
    const surface = sink.getGranularWorkletSurface();
    const listener = vi.fn();
    const unsubscribe = surface.addGrainListener(listener);

    expect(surface.setParams({ wet: 0.5 })).toBe(true);
    expect(sink.node.setGranularParams).toHaveBeenCalledWith({ wet: 0.5 });
    sink._granularListeners.forEach((notify) => notify({ time: 1 }, 0.9));
    expect(listener).toHaveBeenCalledWith({ time: 1 }, 0.9);
    unsubscribe();

    sink.node = null;
    expect(sink.getGranularWorkletSurface()).toBeNull();
  });

  it('detects the natural end on the corrected (audible) position', async () => {
    const { sink, clock } = makeSink({ durationMs: 1000 });
    const stops = [];
    sink.addStopListener((payload) => stops.push(payload));
    await sink.triggerPlay();

    // Raw inputTime crosses the end while the audible position (raw − lead)
    // has not — playback must keep going.
    clock.now = 0.7;
    sink._inputLeadOutSec = 0.3;
    sink.node.inputTime = 1.0;
    sink._handleWorkletUpdate();
    expect(sink.isPlaying()).toBe(true);
    expect(stops).toHaveLength(0);

    // The audible position crosses the end → ended fires once.
    clock.now = 1.0;
    sink.node.inputTime = 1.3;
    sink._handleWorkletUpdate();
    expect(sink.isPlaying()).toBe(false);
    expect(stops).toEqual([{ reason: 'ended' }]);
  });

  it('the speed gate ramps only on a stop transition, not every rate update', async () => {
    const { sink } = makeSink({ durationMs: 10000 });
    await sink.triggerPlay();
    sink._output.gain.rampTo.mockClear();

    // Several non-zero rate updates while already audible → no gate ramps (the
    // moon drives the rate every frame; ramping each time would churn the gain).
    sink.setPlaybackRate(0.8, { immediate: true });
    sink.setPlaybackRate(0.6, { immediate: true });
    sink.setPlaybackRate(0.5, { immediate: true });
    expect(sink._output.gain.rampTo).not.toHaveBeenCalled();

    // Commanded speed drops to ~0 → exactly one glide to silence.
    sink.setPlaybackRate(0.005, { immediate: true });
    expect(sink._output.gain.rampTo).toHaveBeenCalledTimes(1);
    expect(sink._output.gain.rampTo).toHaveBeenLastCalledWith(0, expect.any(Number));

    // Speed returns → exactly one glide back to unity.
    sink.setPlaybackRate(0.5, { immediate: true });
    expect(sink._output.gain.rampTo).toHaveBeenCalledTimes(2);
    expect(sink._output.gain.rampTo).toHaveBeenLastCalledWith(1, expect.any(Number));
  });

  it('disarms the engine loop when clearLoop is called', () => {
    const { sink } = makeSink();
    sink.setLoopRange(1000, 3000, { active: true });
    expect(lastSchedule(sink, 'loopStart').loopEnd).toBeGreaterThan(0);
    sink.clearLoop();
    const disarm = lastSchedule(sink, 'loopStart');
    expect(disarm.loopStart).toBe(0);
    expect(disarm.loopEnd).toBe(0);
    expect(sink.isLooping()).toBe(false);
  });
});
