// @vitest-environment jsdom
/**
 * The `waveform` EngineContext surface — the engine-backed LOOP on/off the
 * transport bar's loop button drives, built by createEngineContext from a fake audio engine.
 *
 * (Removed the Peaks.js view: the full loop CHROME — in/out/snap/size/grid — now lives in
 * the kit Playback panel via `waveformData` + useLoopControls. This surface is only the shared
 * engaged-state toggle, so the transport button and the kit panel stay linked to the same engine
 * loop via the `ui:loop-toggle` document event.)
 *
 * Proves: with an audio engine wired, `setLoopActive` engages an existing range or creates a
 * full-track loop and broadcasts the toggle, and `getLoopActive` reads the engine's EFFECTIVE
 * state; with NO engine it is null-safe — getLoopActive=false and the calls don't throw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

function makeEngine(overrides = {}) {
  return {
    getMonitorSnapshot: () => ({ activeDimensionId: null, dimensions: [] }),
    hasLoopRange: vi.fn(() => false),
    setLoopEnabled: vi.fn(),
    setLoopRange: vi.fn(),
    getDurationMs: vi.fn(() => 0),
    isLoopActive: vi.fn(() => false),
    ...overrides,
  };
}

/** Capture every `ui:loop-toggle` dispatched on document for the duration of `fn`. */
function captureLoopToggles(fn) {
  const events = [];
  const handler = (e) => events.push(e.detail);
  document.addEventListener('ui:loop-toggle', handler);
  try {
    fn();
  } finally {
    document.removeEventListener('ui:loop-toggle', handler);
  }
  return events;
}

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('waveform surface — with an audio engine', () => {
  it('setLoopActive(true) engages an EXISTING range + broadcasts the toggle', () => {
    const engine = makeEngine({ hasLoopRange: vi.fn(() => true) });
    const { waveform } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });

    const events = captureLoopToggles(() => waveform.setLoopActive(true));
    expect(engine.setLoopEnabled).toHaveBeenCalledWith(true);
    expect(engine.setLoopRange).not.toHaveBeenCalled();
    // Single-orbiter (no voiceId) omits the voiceId field → detail is byte-identical to
    // before. A multi tile stamps its voiceId (covered in the waveformData broadcast test below).
    expect(events).toEqual([{ enabled: true, source: 'transport' }]);
  });

  it('setLoopActive(true) with NO range creates a full-track loop', () => {
    const engine = makeEngine({ hasLoopRange: vi.fn(() => false), getDurationMs: vi.fn(() => 12000) });
    const { waveform } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });

    waveform.setLoopActive(true);
    expect(engine.setLoopRange).toHaveBeenCalledWith(0, 12000, { active: true });
    expect(engine.setLoopEnabled).not.toHaveBeenCalled();
  });

  it('setLoopActive(false) disengages + broadcasts', () => {
    const engine = makeEngine();
    const { waveform } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });

    const events = captureLoopToggles(() => waveform.setLoopActive(false));
    expect(engine.setLoopEnabled).toHaveBeenCalledWith(false);
    expect(events).toEqual([{ enabled: false, source: 'transport' }]);
  });

  it('getLoopActive reads the engine EFFECTIVE loop state', () => {
    const engine = makeEngine({ isLoopActive: vi.fn(() => true) });
    const { waveform } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => engine });
    expect(waveform.getLoopActive()).toBe(true);
  });
});

describe('waveform surface — unwired (no engine)', () => {
  it('is null-safe: getLoopActive=false and the calls do not throw', () => {
    const { waveform } = createEngineContext({ parameterManager: pm });
    expect(waveform.getLoopActive()).toBe(false);
    expect(() => {
      waveform.setLoopActive(true);
      waveform.setLoopActive(false);
    }).not.toThrow();
  });
});

describe('waveform surface — subscribeLoopActive is DURABLE across mount timing', () => {
  it('fires on ui:loop-toggle even with NO engine yet (the header-loop fix), stops after unsubscribe', () => {
    // No engine at all — the header loop toggle must still track loop on/off, so `subscribeLoopActive`
    // keys on the document event broadcast regardless of mount timing.
    const { waveform } = createEngineContext({ parameterManager: pm });
    const listener = vi.fn();
    const unsubscribe = waveform.subscribeLoopActive(listener);

    // Emits the current state immediately on subscribe (here false — no engine wired), then
    // tracks every ui:loop-toggle. So the initial emit + the two events = 3 calls.
    expect(listener).toHaveBeenNthCalledWith(1, false);
    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: true, source: 'waveform' } }));
    expect(listener).toHaveBeenLastCalledWith(true);
    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: false, source: 'waveform' } }));
    expect(listener).toHaveBeenLastCalledWith(false);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: true } }));
    expect(listener).toHaveBeenCalledTimes(3); // no more after unsubscribe
  });

  // Per-voice loop isolation. The loop-toggle stays on the shared document event, but a
  // tile bound to voiceId 'v1' ignores a toggle STAMPED for 'v2' (and vice versa). Unstamped (legacy /
  // single-orbiter null) toggles still reach every tile — byte-identical for single-orbiter.
  it('subscribeLoopActive filters OTHER voices but accepts own + unstamped toggles', () => {
    const { waveform } = createEngineContext({ parameterManager: pm, voiceId: 'v1' });
    const listener = vi.fn();
    waveform.subscribeLoopActive(listener); // initial emit (1)

    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: true, voiceId: 'v2' } }));
    expect(listener).toHaveBeenCalledTimes(1); // v2's toggle ignored

    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: true, voiceId: 'v1' } }));
    expect(listener).toHaveBeenCalledTimes(2); // own toggle accepted

    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: false } }));
    expect(listener).toHaveBeenCalledTimes(3); // unstamped (legacy) accepted
  });

  it('emits the audio engine effective loop state immediately on subscribe', () => {
    // Loop is on by default before the first play applies it; the header toggle must reflect that
    // from interface load, read off the audio engine.
    const audioEngine = makeEngine({ isLoopActive: () => true });
    const { waveform } = createEngineContext({ parameterManager: pm, audioEngineProvider: () => audioEngine });
    const listener = vi.fn();
    waveform.subscribeLoopActive(listener);
    expect(listener).toHaveBeenNthCalledWith(1, true);
  });

  it('coerces a missing/empty detail to false', () => {
    const { waveform } = createEngineContext({ parameterManager: pm });
    const listener = vi.fn();
    waveform.subscribeLoopActive(listener);
    listener.mockClear(); // drop the immediate on-subscribe emit; assert the event coercion only
    document.dispatchEvent(new CustomEvent('ui:loop-toggle')); // no detail
    expect(listener).toHaveBeenLastCalledWith(false);
  });
});

// The kit-panel loop facade (waveformData.broadcastLoopToggle / subscribeLoopToggle)
// shares the transport button's voiceId-stamped document event. Cross-tile isolation + source passthrough.
describe('waveformData loop-toggle — per-voice broadcast + subscribe', () => {
  it('broadcastLoopToggle stamps this voice and source:waveform', () => {
    const { waveformData } = createEngineContext({ parameterManager: pm, voiceId: 'v1' });
    const seen = [];
    const onDoc = (e) => seen.push(e.detail);
    document.addEventListener('ui:loop-toggle', onDoc);
    waveformData.broadcastLoopToggle(true);
    document.removeEventListener('ui:loop-toggle', onDoc);
    expect(seen).toEqual([{ enabled: true, source: 'waveform', voiceId: 'v1' }]);
  });

  it('subscribeLoopToggle filters OTHER voices, passes {enabled, source} for own + unstamped', () => {
    const { waveformData } = createEngineContext({ parameterManager: pm, voiceId: 'v1' });
    const listener = vi.fn();
    const off = waveformData.subscribeLoopToggle(listener);

    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: true, source: 'transport', voiceId: 'v2' } }));
    expect(listener).not.toHaveBeenCalled(); // v2's toggle ignored

    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: true, source: 'transport', voiceId: 'v1' } }));
    expect(listener).toHaveBeenLastCalledWith({ enabled: true, source: 'transport' }); // own, source passed through

    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: false, source: 'waveform' } }));
    expect(listener).toHaveBeenLastCalledWith({ enabled: false, source: 'waveform' }); // unstamped accepted

    off();
    document.dispatchEvent(new CustomEvent('ui:loop-toggle', { detail: { enabled: true, voiceId: 'v1' } }));
    expect(listener).toHaveBeenCalledTimes(2); // no more after unsubscribe
  });
});
