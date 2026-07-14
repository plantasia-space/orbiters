// @vitest-environment jsdom
/**
 * The `monitor` EngineContext surface — the per-dimension audio label+value
 * readout. A facade over `AudioEngineAdapter.getMonitorSnapshot`, fed the REAL normalized value per
 * (dimension, axis) from `ParameterManager.getNormalizedValue` (the same getter the engine uses to
 * drive the racks). `subscribe` keys on PM x/y/z changes + dimension switches, coalesced to one
 * callback per animation frame, and cancels any in-flight frame on unsubscribe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('monitor surface — snapshot', () => {
  it('available reflects the provider; getSnapshot returns the engine snapshot or an empty one', () => {
    const snap = {
      activeDimensionId: 'EW::I',
      dimensions: [{ dimensionId: 'EW::I', dimensionLabel: 'EW::I', axes: { x: [], y: [], z: [] } }],
    };
    const engine = { getMonitorSnapshot: vi.fn(() => snap) };
    const { monitor } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });

    expect(monitor.available()).toBe(true);
    expect(monitor.getSnapshot()).toBe(snap);

    const { monitor: unwired } = createEngineContext({ parameterManager: pm }); // no audio engine
    expect(unwired.available()).toBe(false);
    expect(unwired.getSnapshot()).toEqual({ activeDimensionId: null, dimensions: [] });
  });

  it('feeds getMonitorSnapshot a live-normalized reader backed by PM.getNormalizedValue(axis, dim)', () => {
    // The engine echoes the value it is handed for (EW::I, x) so we can assert the wiring.
    const engine = {
      getMonitorSnapshot: (getNormalized) => ({
        activeDimensionId: null,
        dimensions: [],
        probe: getNormalized('EW::I', 'x'),
      }),
    };
    const { monitor } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });
    pm.getNormalizedValue = vi.fn((axis, dim) => (axis === 'x' && dim === 'EW::I' ? 0.42 : null));

    // surface passes (dimensionId, axis); it must call PM as (axis, dimensionId).
    expect(monitor.getSnapshot().probe).toBe(0.42);
    expect(pm.getNormalizedValue).toHaveBeenCalledWith('x', 'EW::I');
  });
});

describe('monitor surface — subscribe (frame-coalesced)', () => {
  let savedRaf;
  let savedCancel;
  beforeEach(() => {
    savedRaf = globalThis.requestAnimationFrame;
    savedCancel = globalThis.cancelAnimationFrame;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = savedRaf;
    globalThis.cancelAnimationFrame = savedCancel;
  });

  it('fires the listener on dimension-changed; stops after unsubscribe', () => {
    // synchronous rAF → deterministic
    globalThis.requestAnimationFrame = (cb) => {
      cb(0);
      return 1;
    };
    globalThis.cancelAnimationFrame = vi.fn();

    const engine = { getMonitorSnapshot: () => ({ activeDimensionId: null, dimensions: [] }) };
    const { monitor } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });
    const listener = vi.fn();
    const unsubscribe = monitor.subscribe(listener);

    document.dispatchEvent(new Event('orbiters:dimension-changed'));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    document.dispatchEvent(new Event('orbiters:dimension-changed'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('cancels the pending frame on unsubscribe and never fires the stale callback', () => {
    // Capture the rAF callback WITHOUT running it, so a frame is genuinely in flight at unsubscribe.
    let frameCb = null;
    const FRAME_ID = 7;
    globalThis.requestAnimationFrame = (cb) => {
      frameCb = cb;
      return FRAME_ID;
    };
    globalThis.cancelAnimationFrame = vi.fn();

    const engine = { getMonitorSnapshot: () => ({ activeDimensionId: null, dimensions: [] }) };
    const { monitor } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });
    const listener = vi.fn();
    const unsubscribe = monitor.subscribe(listener);

    document.dispatchEvent(new Event('orbiters:dimension-changed')); // schedules a frame, not yet run
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(FRAME_ID);

    frameCb?.(0); // even if the browser still runs it, the cancelled guard must suppress the listener
    expect(listener).not.toHaveBeenCalled();
  });
});
