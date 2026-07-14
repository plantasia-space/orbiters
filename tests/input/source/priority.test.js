// @vitest-environment jsdom
// (Constants.js touches `navigator` at import time — needs a browser-like global.)
import { describe, it, expect } from 'vitest';
import { getPriority, DEFAULT_PRIORITY } from '../../../src/config/Constants.js';

/**
 * PRIORITY_MAP is the single source of truth for input arbitration priorities.
 * These pin the keys the seam relies on, and guard the `getPriority` 0-fix (a priority of
 * 0 — camera-reset — must NOT be coerced to DEFAULT_PRIORITY by a `||` falsy check).
 */
describe('getPriority — single source of truth', () => {
  it('respects a priority of 0 (camera-reset wins over everything)', () => {
    expect(getPriority('camera-reset')).toBe(0);
  });

  it('resolves the keys the seam adapters use', () => {
    expect(getPriority('camera')).toBe(1);
    expect(getPriority('MIDI')).toBe(1);
    expect(getPriority('sensor-x')).toBe(8);
    expect(getPriority('sensor-y')).toBe(9);
    expect(getPriority('sensor-z')).toBe(10);
    expect(getPriority('sensor-distance')).toBe(10.5);
    expect(getPriority('cosmic-x')).toBe(11);
    expect(getPriority('cosmic-y')).toBe(12);
    expect(getPriority('cosmic-z')).toBe(13);
  });

  it('keeps sensors above cosmic on every axis (the intended order the map asserts)', () => {
    // lower number = higher priority
    for (const axis of ['x', 'y', 'z']) {
      expect(getPriority(`sensor-${axis}`)).toBeLessThan(getPriority(`cosmic-${axis}`));
    }
  });

  it('has dropped the stale cosmic-lfo-A/B/C slot keys', () => {
    expect(getPriority('cosmic-lfo-A')).toBe(DEFAULT_PRIORITY);
  });

  it('falls back to DEFAULT_PRIORITY for unknown controller types', () => {
    expect(getPriority('does-not-exist')).toBe(DEFAULT_PRIORITY);
  });

  it('has dropped the dead "orbit" key', () => {
    expect(getPriority('orbit')).toBe(DEFAULT_PRIORITY);
  });
});
