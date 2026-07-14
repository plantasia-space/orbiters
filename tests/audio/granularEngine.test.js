// @vitest-environment node
/**
 * Headless coverage of the granular engine core: look-ahead scheduling tracks
 * density, grain voices are pooled (bounded node churn), the polyphony cap
 * holds, the decoupled pointer freezes and resyncs on seeks, reversed grains
 * use pooled scratch slices, multi-module attachment merge resolves wet as
 * max / dry as min. Engine lifetime (refcount, observation) is covered at the
 * adapter's source-engine host seam (sourceEngineHost.test.js).
 */
import { describe, it, expect, vi } from 'vitest';
import { GranularEngine, GRANULAR_PARAM_DEFAULTS } from '../../src/audio/granular/GranularEngine.js';

function createFakeParam(initial = 0) {
  return {
    value: initial,
    events: [],
    setValueAtTime(value, time) { this.events.push({ type: 'set', value, time }); this.value = value; },
    linearRampToValueAtTime(value, time) { this.events.push({ type: 'linear', value, time }); this.value = value; },
    setTargetAtTime(value, time, tc) { this.events.push({ type: 'target', value, time, tc }); this.value = value; },
    cancelScheduledValues(time) { this.events.push({ type: 'cancel', time }); },
  };
}

function createFakeContext({ sampleRate = 48000 } = {}) {
  const ctx = {
    currentTime: 0,
    sampleRate,
    created: { gains: 0, panners: 0, sources: 0, buffers: 0 },
    liveSources: [],
    createGain() {
      this.created.gains += 1;
      return { gain: createFakeParam(1), connect: vi.fn(), disconnect: vi.fn() };
    },
    createStereoPanner() {
      this.created.panners += 1;
      return { pan: createFakeParam(0), connect: vi.fn(), disconnect: vi.fn() };
    },
    createBufferSource() {
      this.created.sources += 1;
      const source = {
        buffer: null,
        playbackRate: createFakeParam(1),
        onended: null,
        started: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start(when, offset, duration) {
          this.started = { when, offset, duration };
          ctx.liveSources.push(source);
        },
        end() {
          const index = ctx.liveSources.indexOf(source);
          if (index >= 0) ctx.liveSources.splice(index, 1);
          source.onended?.();
        },
      };
      return source;
    },
    createBuffer(channels, frames, rate) {
      this.created.buffers += 1;
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return {
        numberOfChannels: channels,
        length: frames,
        sampleRate: rate,
        duration: frames / rate,
        getChannelData: (channel) => data[channel],
      };
    },
  };
  return ctx;
}

function createSourceBuffer(ctx, durationSec = 10, channels = 2) {
  const buffer = ctx.createBuffer(channels, Math.floor(durationSec * ctx.sampleRate), ctx.sampleRate);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) data[i] = i;
  }
  return buffer;
}

function createEngine({ ctx, buffer, overrides = {}, transport = {} } = {}) {
  const state = {
    positionMs: 0,
    playing: true,
    dryLevels: [],
    ...transport,
  };
  const engine = new GranularEngine({
    context: ctx,
    getBuffer: () => buffer,
    getPositionMs: () => state.positionMs,
    isPlaying: () => state.playing,
    onDryLevelChange: (level) => state.dryLevels.push(level),
    // Ticks are driven manually via engine.tick() — no real timers.
    scheduleTimer: () => null,
    cancelTimer: () => {},
    random: () => 0.5,
    ...overrides,
  });
  return { engine, state };
}

function runTicks(engine, ctx, { seconds, stepSec = 0.025 }) {
  const ticks = Math.round(seconds / stepSec);
  for (let i = 0; i < ticks; i += 1) {
    engine.tick();
    ctx.currentTime += stepSec;
  }
}

describe('GranularEngine — scheduling', () => {
  it('delegates rendering to the worklet surface without creating native grain nodes', () => {
    const ctx = createFakeContext();
    const listeners = new Set();
    const worklet = {
      setParams: vi.fn(() => true),
      addGrainListener: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const engine = new GranularEngine({ context: ctx, worklet });
    const visual = vi.fn();
    engine.addGrainListener(visual);
    engine.attach().setParams({ wet: 0.8, density: 10 });

    // The native output leg exists (the backend can swap under a live engine)
    // but stays idle: no grain sources, gain parked at 0.
    expect(engine.outputNode.gain.value).toBe(0);
    expect(worklet.setParams).toHaveBeenCalledWith(expect.objectContaining({ wet: 0.8, density: 10 }));
    expect(ctx.created.sources).toBe(0);

    const spawn = { time: 1, positionSec: 0.5 };
    listeners.forEach((listener) => listener(spawn, 0.9));
    expect(visual).toHaveBeenCalledWith(spawn, 0.9);

    engine.dispose();
    expect(worklet.setParams).toHaveBeenLastCalledWith(GRANULAR_PARAM_DEFAULTS);
    expect(listeners.size).toBe(0);
  });

  it('schedules no grains and mutes output at wet 0 (bypass)', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine } = createEngine({ ctx, buffer });
    const attachment = engine.attach();
    attachment.setParams({ wet: 0, density: 20 });
    runTicks(engine, ctx, { seconds: 0.5 });
    expect(engine.stats.grainsScheduled).toBe(0);
    expect(engine.outputNode.gain.value).toBe(0);
  });

  it('grain rate tracks density over a simulated second', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine } = createEngine({ ctx, buffer });
    engine.attach().setParams({ wet: 0.8, density: 10, grainSize: 0.1 });
    runTicks(engine, ctx, { seconds: 1 });
    expect(engine.stats.grainsScheduled).toBeGreaterThanOrEqual(8);
    expect(engine.stats.grainsScheduled).toBeLessThanOrEqual(13);
    expect(engine.outputNode.gain.value).toBeCloseTo(0.8, 5);
  });

  it('stops scheduling and mutes while the transport is stopped, resumes after', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine, state } = createEngine({ ctx, buffer });
    engine.attach().setParams({ wet: 0.8, density: 10 });
    runTicks(engine, ctx, { seconds: 0.3 });
    const scheduledWhilePlaying = engine.stats.grainsScheduled;
    expect(scheduledWhilePlaying).toBeGreaterThan(0);

    state.playing = false;
    runTicks(engine, ctx, { seconds: 0.5 });
    expect(engine.stats.grainsScheduled).toBe(scheduledWhilePlaying);
    expect(engine.outputNode.gain.value).toBe(0);

    state.playing = true;
    runTicks(engine, ctx, { seconds: 0.3 });
    expect(engine.stats.grainsScheduled).toBeGreaterThan(scheduledWhilePlaying);
  });

  it('enforces the active-grain cap and counts skipped grains', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine } = createEngine({
      ctx,
      buffer,
      overrides: { maxActiveGrains: 5, maxOverlap: 50 },
    });
    // Grains are never ended, so the cap must hold the line.
    engine.attach().setParams({ wet: 0.9, density: 80, grainSize: 0.4 });
    runTicks(engine, ctx, { seconds: 1 });
    expect(engine.stats.grainsScheduled).toBe(5);
    expect(ctx.liveSources.length).toBe(5);
    expect(engine.stats.grainsSkipped).toBeGreaterThan(0);
  });

  it('clamps density so density × grainSize stays within the overlap budget', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine } = createEngine({ ctx, buffer, overrides: { maxOverlap: 6 } });
    engine.attach().setParams({ wet: 0.5, density: 80, grainSize: 0.5 });
    expect(engine.getParams().density).toBeCloseTo(12, 5);
  });
});

describe('GranularEngine — pooling', () => {
  it('reuses grain voices instead of creating nodes per grain', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine } = createEngine({ ctx, buffer });
    engine.attach().setParams({ wet: 0.8, density: 20, grainSize: 0.05 });
    for (let i = 0; i < 40; i += 1) {
      engine.tick();
      ctx.currentTime += 0.025;
      // End every live grain each step — voices should recycle.
      [...ctx.liveSources].forEach((source) => source.end());
    }
    expect(engine.stats.grainsScheduled).toBeGreaterThan(15);
    expect(engine.stats.voicesCreated).toBeLessThanOrEqual(4);
  });

  it('reverse grains copy a reversed slice into pooled scratch buffers', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx, 10);
    const { engine, state } = createEngine({ ctx, buffer });
    state.positionMs = 2000;
    engine.attach().setParams({ wet: 0.8, density: 10, grainSize: 0.1, reverseProbability: 1 });

    engine.tick();
    const source = ctx.liveSources[0];
    expect(source).toBeTruthy();
    // Reversed grains play a scratch slice from its start, not the source offset.
    expect(source.buffer).not.toBe(buffer);
    expect(source.started.offset).toBe(0);
    // The slice really is reversed: first scratch sample = last source sample of the grain.
    const frames = Math.floor(0.1 * ctx.sampleRate);
    const startFrame = Math.floor(2 * ctx.sampleRate);
    expect(source.buffer.getChannelData(0)[0]).toBe(buffer.getChannelData(0)[startFrame + frames - 1]);

    // Scratch buffers recycle once their grain ends: over many ticks with all
    // grains ended between quanta, creation stays bounded by per-tick concurrency.
    for (let i = 0; i < 10; i += 1) {
      [...ctx.liveSources].forEach((s) => s.end());
      ctx.currentTime += 0.025;
      engine.tick();
    }
    expect(engine.stats.grainsScheduled).toBeGreaterThan(3);
    expect(engine.stats.scratchBuffersCreated).toBeLessThanOrEqual(3);
  });
});

describe('GranularEngine — pointer', () => {
  it('freezes the pointer at pointerSpeed 0 and resyncs on a seek', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx, 10);
    const { engine, state } = createEngine({ ctx, buffer });
    state.positionMs = 3000;
    engine.attach().setParams({ wet: 0.8, density: 10, grainSize: 0.1, pointerSpeed: 0 });

    engine.tick();
    ctx.currentTime += 0.025;
    // Playhead advances, frozen pointer must not.
    for (let i = 0; i < 20; i += 1) {
      state.positionMs += 25;
      engine.tick();
      ctx.currentTime += 0.025;
    }
    const lastGrain = ctx.liveSources[ctx.liveSources.length - 1];
    expect(lastGrain.started.offset).toBeCloseTo(3, 2);

    // Seek: pointer snaps back to transport truth.
    state.positionMs = 8000;
    engine.tick();
    ctx.currentTime += 0.025;
    engine.tick();
    const afterSeek = ctx.liveSources[ctx.liveSources.length - 1];
    expect(afterSeek.started.offset).toBeCloseTo(8, 1);
  });

  it('follows the playhead exactly at pointerSpeed 1', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx, 10);
    const { engine, state } = createEngine({ ctx, buffer });
    state.positionMs = 5000;
    engine.attach().setParams({ wet: 0.8, density: 10, grainSize: 0.1 });
    engine.tick();
    const grain = ctx.liveSources[ctx.liveSources.length - 1];
    expect(grain.started.offset).toBeCloseTo(5, 2);
  });
});

describe('GranularEngine — grain spawn events', () => {
  it('emits one grain event per scheduled grain with the visual seam fields', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx, 10);
    const spawns = [];
    const nows = [];
    const { engine, state } = createEngine({ ctx, buffer });
    engine.addGrainListener((spawn, audioNowSec) => {
      spawns.push(spawn);
      nows.push(audioNowSec);
    });
    state.positionMs = 4000;
    engine.attach().setParams({ wet: 0.8, density: 10, grainSize: 0.1, grainPitch: 1.5, reverseProbability: 1 });
    engine.tick();

    expect(spawns.length).toBe(engine.stats.grainsScheduled);
    const spawn = spawns[0];
    expect(spawn.positionSec).toBeCloseTo(4, 2);
    expect(spawn.positionNorm).toBeCloseTo(0.4, 2);
    expect(spawn.durationSec).toBeCloseTo(0.1, 5);
    expect(spawn.pitch).toBeCloseTo(1.5, 5);
    expect(spawn.reversed).toBe(true);
    expect(Number.isFinite(spawn.time)).toBe(true);
    expect(spawn.pan).toBe(0);
    // The audio clock rides along so listeners can align scheduled-ahead
    // grain times with their own clock.
    expect(nows[0]).toBe(ctx.currentTime);
  });

  it('a throwing listener never breaks the scheduler or its siblings', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx, 10);
    const { engine } = createEngine({ ctx, buffer });
    const seen = [];
    engine.addGrainListener(() => { throw new Error('visual layer exploded'); });
    engine.addGrainListener((spawn) => seen.push(spawn));
    engine.attach().setParams({ wet: 0.8, density: 10 });
    expect(() => runTicks(engine, ctx, { seconds: 0.3 })).not.toThrow();
    expect(engine.stats.grainsScheduled).toBeGreaterThan(0);
    expect(seen.length).toBe(engine.stats.grainsScheduled);
  });

  it('unsubscribing stops the events; listeners on a disposed engine are inert', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx, 10);
    const { engine } = createEngine({ ctx, buffer });
    const spawns = [];
    const unsubscribe = engine.addGrainListener((spawn) => spawns.push(spawn));
    engine.attach().setParams({ wet: 0.8, density: 10 });
    engine.tick();
    const beforeUnsubscribe = spawns.length;
    expect(beforeUnsubscribe).toBeGreaterThan(0);

    unsubscribe();
    ctx.currentTime += 0.025;
    engine.tick();
    expect(spawns.length).toBe(beforeUnsubscribe);

    engine.dispose();
    expect(engine.addGrainListener(() => {})).toBeTypeOf('function');
  });
});

describe('GranularEngine — peekParams', () => {
  it('returns the live merged params without copying; recompute replaces the object', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine } = createEngine({ ctx, buffer });
    const attachment = engine.attach();
    attachment.setParams({ wet: 0.4 });

    const first = engine.peekParams();
    expect(first.wet).toBeCloseTo(0.4, 5);
    // Same reference until the next recompute — the per-frame read allocates nothing.
    expect(engine.peekParams()).toBe(first);

    attachment.setParams({ wet: 0.9 });
    const second = engine.peekParams();
    expect(second).not.toBe(first);
    expect(second.wet).toBeCloseTo(0.9, 5);
  });
});

describe('GranularEngine — attachments', () => {
  it('resolves wet as max and dry level as min across attachments', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine, state } = createEngine({ ctx, buffer });
    const a = engine.attach();
    const b = engine.attach();
    a.setParams({ wet: 0.3, dryLevel: 0.9 });
    b.setParams({ wet: 0.7, dryLevel: 0.4 });
    expect(engine.getParams().wet).toBeCloseTo(0.7, 5);
    expect(engine.getParams().dryLevel).toBeCloseTo(0.4, 5);
    expect(state.dryLevels[state.dryLevels.length - 1]).toBeCloseTo(0.4, 5);

    b.detach();
    expect(engine.getParams().wet).toBeCloseTo(0.3, 5);
    expect(state.dryLevels[state.dryLevels.length - 1]).toBeCloseTo(0.9, 5);
  });

  it('replace-writes clear an attachment\'s previous parameter subset', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine } = createEngine({ ctx, buffer });
    const attachment = engine.attach();
    attachment.setParams({ wet: 0.5, panSpread: 0.8 });
    expect(engine.getParams().panSpread).toBeCloseTo(0.8, 5);
    attachment.setParams({ wet: 0.5, grainPitch: 1.5 }, { replace: true });
    expect(engine.getParams().panSpread).toBe(GRANULAR_PARAM_DEFAULTS.panSpread);
    expect(engine.getParams().grainPitch).toBeCloseTo(1.5, 5);
  });

  it('restores the dry leg on dispose', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const { engine, state } = createEngine({ ctx, buffer });
    engine.attach().setParams({ wet: 0.5, dryLevel: 0.3 });
    engine.dispose();
    expect(state.dryLevels[state.dryLevels.length - 1]).toBe(1);
  });
});

describe('GranularEngine — backend rebind (setWorklet)', () => {
  function createWorkletSurface() {
    const listeners = new Set();
    return {
      listeners,
      setParams: vi.fn(() => true),
      addGrainListener: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
  }

  it('a native engine rebinds to a worklet: scheduler stops, params and events move over', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    // Built beside a streaming/native sink — like a module mounted before the
    // full-track unlock swaps the backend.
    const { engine, state } = createEngine({ ctx, buffer });
    engine.attach().setParams({ wet: 0.8, density: 10, dryLevel: 0.4 });
    runTicks(engine, ctx, { seconds: 0.3 });
    const nativeGrains = engine.stats.grainsScheduled;
    expect(nativeGrains).toBeGreaterThan(0);

    const worklet = createWorkletSurface();
    engine.setWorklet(worklet);

    // The merged params reach the new renderer; the native leg is silenced,
    // its dry crossfade handed back.
    expect(worklet.setParams).toHaveBeenCalledWith(expect.objectContaining({ wet: 0.8, density: 10 }));
    expect(engine.outputNode.gain.value).toBe(0);
    expect(state.dryLevels[state.dryLevels.length - 1]).toBe(1);

    // Native scheduling is over — ticks are inert now.
    runTicks(engine, ctx, { seconds: 0.5 });
    expect(engine.stats.grainsScheduled).toBe(nativeGrains);

    // Grain events flow from the worklet to already-registered listeners.
    const visual = vi.fn();
    engine.addGrainListener(visual);
    const spawn = { time: 1, positionSec: 0.5 };
    worklet.listeners.forEach((listener) => listener(spawn, 0.9));
    expect(visual).toHaveBeenCalledWith(spawn, 0.9);

    // New attachments drive the worklet, not the dead native path.
    engine.attach().setParams({ wet: 0.9 });
    expect(worklet.setParams).toHaveBeenLastCalledWith(expect.objectContaining({ wet: 0.9 }));
  });

  it('a worklet engine rebinds to native: old worklet parked, grains schedule natively', () => {
    const ctx = createFakeContext();
    const buffer = createSourceBuffer(ctx);
    const worklet = createWorkletSurface();
    const { engine } = createEngine({ ctx, buffer, overrides: { worklet } });
    engine.attach().setParams({ wet: 0.8, density: 10 });
    expect(ctx.created.sources).toBe(0);

    engine.setWorklet(null);

    // The outgoing worklet is parked at defaults and unsubscribed.
    expect(worklet.setParams).toHaveBeenLastCalledWith(GRANULAR_PARAM_DEFAULTS);
    expect(worklet.listeners.size).toBe(0);

    runTicks(engine, ctx, { seconds: 0.5 });
    expect(engine.stats.grainsScheduled).toBeGreaterThan(0);
    expect(engine.outputNode.gain.value).toBeCloseTo(0.8, 5);
  });

  it('rebinding to the same surface is a no-op', () => {
    const ctx = createFakeContext();
    const worklet = createWorkletSurface();
    const engine = new GranularEngine({ context: ctx, worklet });
    engine.attach().setParams({ wet: 0.5 });
    const calls = worklet.setParams.mock.calls.length;
    engine.setWorklet(worklet);
    expect(worklet.setParams.mock.calls.length).toBe(calls);
    expect(worklet.addGrainListener).toHaveBeenCalledTimes(1);
  });
});
