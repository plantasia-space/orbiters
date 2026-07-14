// @vitest-environment jsdom
/**
 * The `transport` EngineContext surface (T5) — a narrow facade over
 * TransportControl. The React Transport region reaches play / stop / toggle + state
 * through this surface, never `window.transportControl`. TransportControl has no
 * subscribe of its own, so the facade's `subscribe` wraps the
 * `orbiters:transport-state-change` window event it already broadcasts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

function makeTransport() {
  let state = 'stopped';
  return {
    getState: () => state,
    isPlaying: () => state === 'playing',
    play: vi.fn(() => {
      state = 'playing';
    }),
    pause: vi.fn(() => {
      state = 'paused';
    }),
    stop: vi.fn(() => {
      state = 'stopped';
    }),
    toggle: vi.fn(() => {
      state = state === 'playing' ? 'paused' : 'playing';
    }),
  };
}

function emitState(state) {
  window.dispatchEvent(new CustomEvent('orbiters:transport-state-change', { detail: { state } }));
}

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('transport surface — facade over TransportControl', () => {
  it('forwards play / stop / toggle and reads state', () => {
    const tc = makeTransport();
    const { transport } = createEngineContext({ parameterManager: pm, transportController: tc });

    expect(transport.available).toBe(true);
    expect(transport.getState()).toBe('stopped');
    expect(transport.isPlaying()).toBe(false);

    transport.toggle();
    expect(tc.toggle).toHaveBeenCalledTimes(1);
    expect(transport.getState()).toBe('playing');
    expect(transport.isPlaying()).toBe(true);

    transport.stop();
    expect(tc.stop).toHaveBeenCalledTimes(1);
    expect(transport.getState()).toBe('stopped');

    transport.play();
    expect(tc.play).toHaveBeenCalledTimes(1);
  });

  it('is unavailable and no-ops (defaults to stopped) with no controller', () => {
    const { transport } = createEngineContext({ parameterManager: pm });
    expect(transport.available).toBe(false);
    expect(transport.getState()).toBe('stopped');
    expect(transport.isPlaying()).toBe(false);
    expect(() => transport.toggle()).not.toThrow();
    expect(() => transport.stop()).not.toThrow();
  });

  it('swallows a controller action that rejects — no throw, no unhandled rejection', async () => {
    const tc = makeTransport();
    tc.play = vi.fn(() => Promise.reject(new Error('engine down')));
    const { transport } = createEngineContext({ parameterManager: pm, transportController: tc });

    const rejections = [];
    const onRejection = (err) => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    try {
      expect(() => transport.play()).not.toThrow();
      // Let the rejected microtask settle — without the facade's .catch this would
      // surface as an unhandled rejection here.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toHaveLength(0);
    expect(tc.play).toHaveBeenCalledTimes(1);
  });
});

describe('transport surface — subscribe wraps the window state event', () => {
  it('notifies on a valid state event and stops after unsubscribe', () => {
    const tc = makeTransport();
    const { transport } = createEngineContext({ parameterManager: pm, transportController: tc });

    const listener = vi.fn();
    const unsubscribe = transport.subscribe(listener);

    emitState('playing');
    emitState('paused');
    expect(listener).toHaveBeenNthCalledWith(1, 'playing');
    expect(listener).toHaveBeenNthCalledWith(2, 'paused');

    unsubscribe();
    emitState('stopped');
    expect(listener).toHaveBeenCalledTimes(2); // no more after unsubscribe
  });

  it('ignores events with a missing / bogus state', () => {
    const tc = makeTransport();
    const { transport } = createEngineContext({ parameterManager: pm, transportController: tc });
    const listener = vi.fn();
    transport.subscribe(listener);

    window.dispatchEvent(new CustomEvent('orbiters:transport-state-change', { detail: {} }));
    window.dispatchEvent(new CustomEvent('orbiters:transport-state-change', { detail: { state: 'bogus' } }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('transport surface — count-in', () => {
  function emitCountIn(detail) {
    window.dispatchEvent(new CustomEvent('orbiters:quantize-countin', { detail }));
  }

  it('reads the live count-in snapshot from the audio engine, defaulting to inactive', () => {
    const { transport } = createEngineContext({ parameterManager: pm });
    // no audio engine wired → inactive default
    expect(transport.getCountIn()).toEqual({ active: false });

    const state = { active: true, targetTime: 123, bpm: 120 };
    const audioEngine = { getMonitorSnapshot: vi.fn(), getCountInState: () => state };
    const { transport: t2 } = createEngineContext({
      parameterManager: pm,
      audioEngineProvider: () => audioEngine,
    });
    expect(t2.getCountIn()).toBe(state);
  });

  it('subscribeCountIn forwards the window event detail and stops after unsubscribe', () => {
    const { transport } = createEngineContext({ parameterManager: pm });
    const listener = vi.fn();
    const unsubscribe = transport.subscribeCountIn(listener);

    const armed = { active: true, targetTime: 1, bpm: 120 };
    emitCountIn(armed);
    emitCountIn({ active: false });
    expect(listener).toHaveBeenNthCalledWith(1, armed);
    expect(listener).toHaveBeenNthCalledWith(2, { active: false });

    unsubscribe();
    emitCountIn(armed);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('subscribeCountIn tolerates an event with no detail (→ inactive)', () => {
    const { transport } = createEngineContext({ parameterManager: pm });
    const listener = vi.fn();
    transport.subscribeCountIn(listener);
    window.dispatchEvent(new CustomEvent('orbiters:quantize-countin'));
    expect(listener).toHaveBeenCalledWith({ active: false });
  });

  // Per-voice count-in. Each tile's AudioEngineAdapter mirrors its count-in on its OWN
  // eventBus, and its Transport surface subscribes to the SAME bus — so one voice's count-in never
  // drives another voice's countdown. (Single-orbiter omits eventBus → window → byte-identical above.)
  it('subscribeCountIn is isolated per voice: a count-in on bus A does not reach bus B', () => {
    const busA = new EventTarget();
    const busB = new EventTarget();
    const { transport: tA } = createEngineContext({ parameterManager: pm, eventBus: busA });
    const { transport: tB } = createEngineContext({ parameterManager: pm, eventBus: busB });
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    tA.subscribeCountIn(listenerA);
    tB.subscribeCountIn(listenerB);

    const armed = { active: true, targetTime: 1, bpm: 120 };
    busA.dispatchEvent(new CustomEvent('orbiters:quantize-countin', { detail: armed }));

    expect(listenerA).toHaveBeenCalledWith(armed);
    expect(listenerB).not.toHaveBeenCalled();
    // The window (single-orbiter default) is also untouched by a per-voice bus dispatch.
    const windowListener = vi.fn();
    const { transport: tWin } = createEngineContext({ parameterManager: pm });
    tWin.subscribeCountIn(windowListener);
    busA.dispatchEvent(new CustomEvent('orbiters:quantize-countin', { detail: armed }));
    expect(windowListener).not.toHaveBeenCalled();
  });
});
