// @vitest-environment jsdom
/**
 * usePagedWindow: the one sliding-window carousel shared by the loop-size presets
 * (KitWaveformPanel) and the numeric keypad's grid-tied duration presets. `next`/`prev` must
 * slide by exactly ONE item, never jump by a whole window's worth.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
// usePagedWindow was promoted into the design library (shared with entangled-worlds); this
// suite now exercises it through the package boundary.
import { usePagedWindow } from 'plantasia.space-design/react';

let win;
let root;
function mount(items, windowSize) {
  function Probe() {
    win = usePagedWindow(items, windowSize);
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(createElement(Probe)));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

const ITEMS = Array.from({ length: 11 }, (_, i) => i);

describe('usePagedWindow', () => {
  it('starts at the first window and reports no earlier page', () => {
    mount(ITEMS, 4);
    expect(win.visible).toEqual([0, 1, 2, 3]);
    expect(win.canPrev).toBe(false);
    expect(win.canNext).toBe(true);
  });

  it('next() slides by exactly ONE item, not by the window size', () => {
    mount(ITEMS, 4);
    act(() => win.next());
    expect(win.visible).toEqual([1, 2, 3, 4]);
    act(() => win.next());
    expect(win.visible).toEqual([2, 3, 4, 5]);
  });

  it('prev() slides back by ONE item and clamps at the start', () => {
    mount(ITEMS, 4);
    act(() => win.next());
    act(() => win.prev());
    expect(win.visible).toEqual([0, 1, 2, 3]);
    act(() => win.prev()); // already at start — stays put
    expect(win.visible).toEqual([0, 1, 2, 3]);
    expect(win.canPrev).toBe(false);
  });

  it('next() clamps at the last possible window (partial-window-safe)', () => {
    mount(ITEMS, 4);
    for (let i = 0; i < 20; i++) act(() => win.next());
    expect(win.visible).toEqual([7, 8, 9, 10]); // last full window of 11 items
    expect(win.canNext).toBe(false);
  });

  it('reveal(index) slides so that index becomes visible', () => {
    mount(ITEMS, 4);
    act(() => win.reveal(9));
    expect(win.visible).toContain(9);
    expect(win.visible).toEqual([7, 8, 9, 10]); // clamped to the last window
  });

  it('a list shorter than the window just shows everything, no paging', () => {
    mount([0, 1], 4);
    expect(win.visible).toEqual([0, 1]);
    expect(win.canPrev).toBe(false);
    expect(win.canNext).toBe(false);
  });
});
