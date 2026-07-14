// @vitest-environment jsdom
/**
 * The `dims` EngineContext surface (strategy §3) — list / active / setActive /
 * subscribe, built by createEngineContext from a fake dimension provider (the
 * OrbitersEditMode slice) and the `orbiters:dimension-changed` DOM event.
 *
 * Proves: with a provider wired, list+active come from the provider and setActive
 * delegates to it (full hydration path); subscribe keys on the DOM event so a
 * switch from anywhere (React or the legacy chrome) notifies React. Without a
 * provider, list() is empty and active() falls back to the PM param — so the shell
 * stays safe in non-edit modes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

const DIMENSION_EVENT = 'orbiters:dimension-changed';

function makeProvider(initial = 'EW::I') {
  let active = initial;
  return {
    setActiveCalls: [],
    getAvailableDimensions: () => [
      { id: 'EW::I', label: 'One' },
      { id: 'EW::II', label: 'Two' },
    ],
    getActiveDimensionId: () => active,
    setActiveDimension(id) {
      this.setActiveCalls.push(id);
      active = id;
    },
  };
}

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('dims surface — with a dimension provider', () => {
  it('lists + reads active from the provider and delegates setActive', () => {
    const provider = makeProvider('EW::I');
    const { dims } = createEngineContext({ parameterManager: pm, midiController: null, dimensionProvider: provider });

    expect(dims.list()).toEqual([
      { id: 'EW::I', label: 'One' },
      { id: 'EW::II', label: 'Two' },
    ]);
    expect(dims.active()).toBe('EW::I');

    dims.setActive('EW::II');
    expect(provider.setActiveCalls).toEqual(['EW::II']);
    expect(dims.active()).toBe('EW::II');
  });

  it('subscribe fires on the orbiters:dimension-changed event and unsubscribes cleanly', () => {
    const provider = makeProvider();
    const { dims } = createEngineContext({ parameterManager: pm, midiController: null, dimensionProvider: provider });

    const listener = vi.fn();
    const unsubscribe = dims.subscribe(listener);

    document.dispatchEvent(new CustomEvent(DIMENSION_EVENT, { detail: { activeDimensionId: 'EW::II' } }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    document.dispatchEvent(new CustomEvent(DIMENSION_EVENT, { detail: { activeDimensionId: 'EW::I' } }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Per-voice dimension scoping. The dimension-changed event stays on the shared
  // document (active-voice listeners depend on it), but the per-tile React surface filters by voiceId,
  // so a sibling tile's switch is ignored (e.g. tile A's switch must not clear tile B's monitor).
  it('subscribe filters OTHER voices but accepts own + unstamped dimension switches', () => {
    const { dims } = createEngineContext({ parameterManager: pm, dimensionProvider: makeProvider(), voiceId: 'v1' });
    const listener = vi.fn();
    dims.subscribe(listener);

    document.dispatchEvent(new CustomEvent(DIMENSION_EVENT, { detail: { activeDimensionId: 'EW::II', voiceId: 'v2' } }));
    expect(listener).not.toHaveBeenCalled(); // v2's switch ignored

    document.dispatchEvent(new CustomEvent(DIMENSION_EVENT, { detail: { activeDimensionId: 'EW::II', voiceId: 'v1' } }));
    expect(listener).toHaveBeenCalledTimes(1); // own switch accepted

    document.dispatchEvent(new CustomEvent(DIMENSION_EVENT, { detail: { activeDimensionId: 'EW::I' } }));
    expect(listener).toHaveBeenCalledTimes(2); // unstamped (legacy) accepted
  });
});

describe('dims surface — without a provider (non-edit modes)', () => {
  it('list() is empty and active() falls back to the PM axis param', () => {
    // 'x' multidimensional param so the fallback active-read has something to read.
    pm.addMultidimensionalParameter('x', ['EW::I', 'EW::II'], 0, -180, 180, { isBidirectional: true });
    pm.setActiveDimension('EW::II');

    const { dims } = createEngineContext({ parameterManager: pm, midiController: null });
    expect(dims.list()).toEqual([]);
    expect(dims.active()).toBe('EW::II');
    // subscribe is a no-op subscription but still returns an unsubscribe.
    expect(typeof dims.subscribe(() => {})).toBe('function');
  });
});
