// @vitest-environment jsdom
/**
 * Launch-quantize grid (the single owned source of the launch boundary, in bars).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getLaunchGridBars,
  getLaunchGridBeats,
  getLaunchGridQuarterBeats,
  setLaunchGridBars,
  setLaunchGridBeats,
  subscribeLaunchGrid,
  DEFAULT_LAUNCH_GRID_BARS,
  DEFAULT_LAUNCH_GRID_BEATS,
} from '../../src/sync/launchGrid.js';
import { getLaunchGridFromUrl } from '../../src/utils/urlParams.js';

afterEach(() => setLaunchGridBars(DEFAULT_LAUNCH_GRID_BARS));

describe('launchGrid', () => {
  it('defaults to NONE (quantized launching is opt-in) and derives beats from the meter once set', () => {
    expect(DEFAULT_LAUNCH_GRID_BARS).toBe(0);
    expect(getLaunchGridBars()).toBe(0);
    expect(getLaunchGridBeats()).toBe(0);
    expect(getLaunchGridQuarterBeats('4/4')).toBe(0);
    setLaunchGridBars(1);
    expect(getLaunchGridBeats()).toBe(4);
    expect(getLaunchGridQuarterBeats('4/4')).toBe(4);
    expect(getLaunchGridQuarterBeats('3/4')).toBe(3);
    expect(getLaunchGridQuarterBeats('6/8')).toBe(3);
    expect(getLaunchGridQuarterBeats('7/8')).toBe(3.5);
  });

  it('set updates the grid for valid positive bar values (incl. fractional)', () => {
    expect(setLaunchGridBars(2)).toBe(2);
    expect(getLaunchGridBars()).toBe(2);
    expect(getLaunchGridQuarterBeats('6/8')).toBe(6);
    expect(setLaunchGridBars(0.5)).toBe(0.5);
    expect(getLaunchGridBars()).toBe(0.5);
    expect(getLaunchGridQuarterBeats('4/4')).toBe(2);
  });

  it('accepts 0 as "none" (no snap — launch fires immediately)', () => {
    setLaunchGridBars(1);
    expect(setLaunchGridBars(0)).toBe(0);
    expect(getLaunchGridBars()).toBe(0);
    expect(getLaunchGridQuarterBeats('7/8')).toBe(0);
  });

  it('ignores null/undefined and non-finite / negative values (never a stray disable)', () => {
    setLaunchGridBars(1);
    for (const bad of [-1, Number.NaN, Infinity, 'x', null, undefined]) {
      expect(setLaunchGridBars(bad)).toBe(1);
      expect(getLaunchGridBars()).toBe(1);
    }
  });

  it('notifies subscribers only on a real change, and unsubscribe stops them', () => {
    const seen = [];
    const unsub = subscribeLaunchGrid((b) => seen.push(b));
    setLaunchGridBars(2); // change → notify
    setLaunchGridBars(2); // same value → no notify
    setLaunchGridBars(-1); // ignored (negative) → no notify, no change
    unsub();
    setLaunchGridBars(1); // after unsubscribe → not seen
    expect(seen).toEqual([2]);
    expect(getLaunchGridBars()).toBe(1);
  });

  it('keeps legacy beat setters 4/4-compatible while storing bars', () => {
    expect(setLaunchGridBeats(2)).toBe(2);
    expect(getLaunchGridBars()).toBe(0.5);
    expect(getLaunchGridQuarterBeats('6/8')).toBe(1.5);
  });
});

describe('getLaunchGridFromUrl', () => {
  const parse = (q) => getLaunchGridFromUrl(new URLSearchParams(q));

  it('parses a non-negative number (0 = none)', () => {
    expect(parse('launchGrid=2')).toBe(2);
    expect(parse('launchGrid=0.5')).toBe(0.5);
    expect(parse('launchGrid=0')).toBe(0); // none / no snap
  });

  it('returns null when absent or invalid (negative / non-numeric)', () => {
    expect(parse('')).toBeNull();
    expect(parse('launchGrid=-1')).toBeNull();
    expect(parse('launchGrid=abc')).toBeNull();
  });
});
