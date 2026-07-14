// @vitest-environment jsdom
/**
 * The `waveformData` EngineContext surface — the lean DATA surface the design-lib
 * timeline kit binds to: waveform url + duration/position/seek/loop, all in SECONDS, built by
 * createEngineContext over the active voice's AudioEngineAdapter (via audioEngineProvider).
 *
 * Proves: with an engine wired, the facade converts ms↔sec correctly, maps the engine's
 * {start,end} loop to {startSec,endSec} and back to setLoopRange(ms)/clearLoop; with NO engine
 * it is null-safe (url null, duration/position 0, loop null, setters/seek don't throw).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

function makeEngine(overrides = {}) {
  return {
    getMonitorSnapshot: () => ({ activeDimensionId: null, dimensions: [] }),
    getWaveformUrl: vi.fn(() => 'https://cdn/wave.json'),
    getDurationMs: vi.fn(() => 6160),
    getCurrentPositionMs: vi.fn(() => 1500),
    seekToMilliseconds: vi.fn(),
    getLoopRange: vi.fn(() => ({ start: 1000, end: 3000 })), // player.js returns ms
    setLoopRange: vi.fn(),
    clearLoop: vi.fn(),
    isLooping: vi.fn(() => true),
    ...overrides,
  };
}

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('waveformData surface — with an audio engine', () => {
  it('reads url + converts ms→sec for duration/position', () => {
    const engine = makeEngine();
    const { waveformData } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });
    expect(waveformData.getWaveformUrl()).toBe('https://cdn/wave.json');
    expect(waveformData.getDurationSec()).toBeCloseTo(6.16, 5);
    expect(waveformData.getPositionSec()).toBeCloseTo(1.5, 5);
  });

  it('seek converts sec→ms and clamps at 0', () => {
    const engine = makeEngine();
    const { waveformData } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });
    waveformData.seek(2.5);
    expect(engine.seekToMilliseconds).toHaveBeenCalledWith(2500);
    waveformData.seek(-4);
    expect(engine.seekToMilliseconds).toHaveBeenLastCalledWith(0);
  });

  it('maps the engine {start,end} loop (seconds) to {startSec,endSec}', () => {
    const engine = makeEngine();
    const { waveformData } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });
    expect(waveformData.getLoopRangeSec()).toEqual({ startSec: 1, endSec: 3 });
    expect(waveformData.isLoopActive()).toBe(true);
  });

  it('setLoopSec engages a range in ms; null clears', () => {
    const engine = makeEngine();
    const { waveformData } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });
    waveformData.setLoopSec({ startSec: 1.25, endSec: 3.5 });
    expect(engine.setLoopRange).toHaveBeenCalledWith(1250, 3500, { active: true });
    waveformData.setLoopSec(null);
    expect(engine.clearLoop).toHaveBeenCalledTimes(1);
  });

  it('null loop range → getLoopRangeSec null', () => {
    const engine = makeEngine({ getLoopRange: vi.fn(() => null) });
    const { waveformData } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });
    expect(waveformData.getLoopRangeSec()).toBeNull();
  });
});

describe('waveformData surface — unwired (no engine)', () => {
  it('is null-safe: url null, duration/position 0, loop null, setters/seek do not throw', () => {
    const { waveformData } = createEngineContext({ parameterManager: pm });
    expect(waveformData.getWaveformUrl()).toBeNull();
    expect(waveformData.getDurationSec()).toBe(0);
    expect(waveformData.getPositionSec()).toBe(0);
    expect(waveformData.getLoopRangeSec()).toBeNull();
    expect(waveformData.isLoopActive()).toBe(false);
    expect(() => {
      waveformData.seek(2);
      waveformData.setLoopSec({ startSec: 0, endSec: 1 });
      waveformData.setLoopSec(null);
    }).not.toThrow();
  });
});
