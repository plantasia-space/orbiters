// @vitest-environment jsdom
/**
 * useOrbiterColors per-tile palette store. The colour VALUES (reading --color1/2 off
 * the tile's host via the CSS cascade) can't be exercised in jsdom (no custom-property cascade), so
 * those are verified in-browser. What IS deterministic here, and regression-prone, is the lifecycle:
 * ONE shared `orbiters:design-updated` document listener refcounted across N voices, removed only when
 * the last subscriber unmounts, and the per-voice store entry evicted on last leave.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EngineProvider } from '../../src/react/engine/EngineContext';
import { useOrbiterColors } from '../../src/react/parameters';

function mountWithVoice(voiceId) {
  let colors;
  function Probe() {
    colors = useOrbiterColors();
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  // The hook only reads `voiceId` off the engine context — a minimal value is enough.
  const value = { voiceId };
  act(() => root.render(createElement(EngineProvider, { value }, createElement(Probe))));
  return {
    root,
    get colors() {
      return colors;
    },
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe('useOrbiterColors — shared listener + per-voice store lifecycle', () => {
  it('adds ONE design-updated listener across voices, removes it only when ALL unmount', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const adds = () => added.mock.calls.filter((c) => c[0] === 'orbiters:design-updated').length;
    const removes = () => removed.mock.calls.filter((c) => c[0] === 'orbiters:design-updated').length;

    const a = mountWithVoice('v1');
    const b = mountWithVoice('v2');
    expect(adds()).toBe(1); // one shared document listener, refcounted across the two tiles
    expect(removes()).toBe(0);

    act(() => a.root.unmount());
    expect(removes()).toBe(0); // v2 still mounted → listener stays

    act(() => b.root.unmount());
    expect(removes()).toBe(1); // last subscriber gone → listener removed (no dangling listener)

    added.mockRestore();
    removed.mockRestore();
  });

  it('returns a [c1, c2] tuple (fallback in jsdom; real per-tile palette verified in-browser)', () => {
    const a = mountWithVoice('v1');
    expect(Array.isArray(a.colors)).toBe(true);
    expect(a.colors).toHaveLength(2);
    act(() => a.root.unmount());
  });
});
