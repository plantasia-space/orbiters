/**
 * Frequency resolve + clamp tests for the pure source manager lifted
 * out of CosmicLFO. No DOM, no state.
 */
import { describe, it, expect } from 'vitest';
import {
  MIN_FREQUENCY_HZ,
  MAX_FREQUENCY_HZ,
  toFiniteNumber,
  sanitizeFrequency,
  ensureHarmonicRange,
  applyMultiplier,
} from '../../../src/input/cosmic/FrequencySourceManager.ts';

describe('range bounds', () => {
  it('mirrors the shared cosmic-frequency param range', () => {
    expect(MIN_FREQUENCY_HZ).toBe(0.001);
    expect(MAX_FREQUENCY_HZ).toBe(21);
  });
});

describe('toFiniteNumber', () => {
  it('parses finite numbers and numeric strings', () => {
    expect(toFiniteNumber(3.5)).toBe(3.5);
    expect(toFiniteNumber('2')).toBe(2);
  });
  it('rejects null/undefined/NaN/Infinity', () => {
    expect(toFiniteNumber(null)).toBeNull();
    expect(toFiniteNumber(undefined)).toBeNull();
    expect(toFiniteNumber(NaN)).toBeNull();
    expect(toFiniteNumber(Infinity)).toBeNull();
  });
});

describe('sanitizeFrequency', () => {
  it('passes through an in-range frequency', () => {
    expect(sanitizeFrequency(5)).toBeCloseTo(5, 9);
  });
  it('clamps below the minimum', () => {
    expect(sanitizeFrequency(0)).toBe(MIN_FREQUENCY_HZ);
    expect(sanitizeFrequency(-3)).toBe(MIN_FREQUENCY_HZ);
  });
  it('clamps above the maximum', () => {
    expect(sanitizeFrequency(1000)).toBe(MAX_FREQUENCY_HZ);
  });
  it('falls back to the minimum for non-finite input', () => {
    expect(sanitizeFrequency(undefined)).toBe(MIN_FREQUENCY_HZ);
    expect(sanitizeFrequency('nope')).toBe(MIN_FREQUENCY_HZ);
  });
});

describe('ensureHarmonicRange', () => {
  it('returns an in-range frequency unchanged', () => {
    expect(ensureHarmonicRange(5)).toBeCloseTo(5, 9);
  });
  it('doubles up a sub-range frequency into the range', () => {
    const out = ensureHarmonicRange(0.0001); // below MIN 0.001
    expect(out).toBeGreaterThanOrEqual(MIN_FREQUENCY_HZ);
    expect(out).toBeLessThanOrEqual(MAX_FREQUENCY_HZ);
    // 0.0001 *2 repeatedly: 0.0002,0.0004,0.0008,0.0016 -> first >= 0.001
    expect(out).toBeCloseTo(0.0016, 6);
  });
  it('halves an above-range frequency into the range', () => {
    const out = ensureHarmonicRange(100); // above MAX 21
    expect(out).toBeGreaterThanOrEqual(MIN_FREQUENCY_HZ);
    expect(out).toBeLessThanOrEqual(MAX_FREQUENCY_HZ);
    // 100/2=50, /2=25, /2=12.5 -> first <= 21
    expect(out).toBeCloseTo(12.5, 6);
  });
  it('uses magnitude (negative folds like its absolute value)', () => {
    expect(ensureHarmonicRange(-100)).toBeCloseTo(12.5, 6);
  });
  it('returns null for zero and non-finite input', () => {
    expect(ensureHarmonicRange(0)).toBeNull();
    expect(ensureHarmonicRange(NaN)).toBeNull();
    expect(ensureHarmonicRange(null)).toBeNull();
  });
});

describe('applyMultiplier', () => {
  it('×2 accumulates the multiplier and harmonises the product', () => {
    const out = applyMultiplier(5, 1, 2); // 5*2 = 10, in range
    expect(out.multiplier).toBe(2);
    expect(out.frequency).toBeCloseTo(10, 9);
  });
  it('chains multipliers off the prior accumulated value', () => {
    const out = applyMultiplier(5, 2, 2); // newMult 4, 5*4=20 in range
    expect(out.multiplier).toBe(4);
    expect(out.frequency).toBeCloseTo(20, 9);
  });
  it('×0.5 halves toward the minimum and folds back into range', () => {
    const out = applyMultiplier(5, 1, 0.5); // 2.5, in range
    expect(out.multiplier).toBe(0.5);
    expect(out.frequency).toBeCloseTo(2.5, 9);
  });
  it('octave-folds a product that overshoots the max', () => {
    const out = applyMultiplier(20, 1, 2); // 40 -> /2 = 20, in range
    expect(out.multiplier).toBe(2);
    expect(out.frequency).toBeCloseTo(20, 9);
  });
  it('reports frequency:null (no commit) when no harmonic exists', () => {
    const out = applyMultiplier(0, 1, 2); // 0 -> ensureHarmonicRange null
    expect(out.frequency).toBeNull();
    expect(out.multiplier).toBe(2);
  });
});
