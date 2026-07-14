/**
 * The collection layout's ported geometry (decisions/0004). These lock the values copied from
 * root's `orbiter-grid.tsx` so the UX stays identical: snap magnets + thresholds, min/max ratios, the
 * per-count slot rectangles, and the divider set. Pure functions — no DOM.
 */
import { describe, it, expect } from 'vitest';
import { snapRatio, clampRatio, slotStylesFor, dividersFor } from '../../src/multi/stageGeometry.js';

describe('snapRatio / clampRatio — ported snap behaviour', () => {
  it('clamps to [0.2, 0.8]', () => {
    expect(clampRatio(0.05)).toBe(0.2);
    expect(clampRatio(0.95)).toBe(0.8);
    expect(clampRatio(0.5)).toBe(0.5);
  });

  it('snaps to a magnet when within the 0.045 threshold', () => {
    expect(snapRatio(0.52)).toBe(0.5); // |0.52-0.5|=0.02 ≤ 0.045 → snaps to 0.5
    expect(snapRatio(0.26)).toBe(0.25); // near the 0.25 magnet
    expect(snapRatio(0.7)).toBeCloseTo(2 / 3, 5); // near the 2/3 magnet
  });

  it('does NOT snap when outside the threshold (returns the clamped value)', () => {
    expect(snapRatio(0.58)).toBe(0.58); // |0.58-0.5|=0.08 > 0.045, and |0.58-2/3|≈0.086 > 0.045
    expect(snapRatio(0.44)).toBe(0.44); // between 1/3 and 0.5, outside both thresholds
  });
});

describe('slotStylesFor — per-count rectangles', () => {
  it('1 slot fills the container', () => {
    expect(slotStylesFor(1, 0.5, 0.5, 0.5)).toEqual([
      { left: '0', top: '0', width: '100%', height: '100%' },
    ]);
  });

  it('2 slots split left/right by splitXPrimary with a 4px half-gap', () => {
    const [a, b] = slotStylesFor(2, 0.5, 0.5, 0.5);
    expect(a).toEqual({ left: '0', top: '0', width: 'calc(50% - 4px)', height: '100%' });
    expect(b).toEqual({ left: 'calc(50% + 4px)', top: '0', width: 'calc(50% - 4px)', height: '100%' });
  });

  it('3 slots = full-width top row + two bottom cells split by splitXSecondary', () => {
    const styles = slotStylesFor(3, 0.5, 0.5, 0.5);
    expect(styles).toHaveLength(3);
    expect(styles[0]).toEqual({ left: '0', top: '0', width: '100%', height: 'calc(50% - 4px)' });
    expect(styles[2].left).toBe('calc(50% + 4px)');
    expect(styles[2].top).toBe('calc(50% + 4px)');
  });

  it('4 slots = independent top (splitXPrimary) and bottom (splitXSecondary) rows', () => {
    const styles = slotStylesFor(4, 0.6, 0.3, 0.7);
    expect(styles).toHaveLength(4);
    // top row height driven by splitY=0.6; top-row width split by splitXPrimary=0.3
    expect(styles[0]).toEqual({ left: '0', top: '0', width: 'calc(30% - 4px)', height: 'calc(60% - 4px)' });
    // bottom row split independently by splitXSecondary=0.7
    expect(styles[3].left).toBe('calc(70% + 4px)');
    expect(styles[3].top).toBe('calc(60% + 4px)');
  });
});

describe('dividersFor — handle set per count', () => {
  it('1 slot has no dividers', () => {
    expect(dividersFor(1, 0.5, 0.5, 0.5)).toHaveLength(0);
  });
  it('2 slots: one vertical (x) divider', () => {
    const d = dividersFor(2, 0.5, 0.5, 0.5);
    expect(d.map((x) => x.axis)).toEqual(['x']);
    expect(d[0].ratio).toBe('xPrimary');
  });
  it('3 slots: a full-width y divider + a bottom-row x divider', () => {
    const d = dividersFor(3, 0.5, 0.5, 0.5);
    expect(d.map((x) => x.ratio)).toEqual(['y', 'xSecondary']);
  });
  it('4 slots: y divider + independent top/bottom x dividers', () => {
    const d = dividersFor(4, 0.5, 0.5, 0.5);
    expect(d.map((x) => x.ratio)).toEqual(['y', 'xPrimary', 'xSecondary']);
  });
});
