/**
 * MIDI value scaling (inbound CC ↔ outbound feedback), with the log-scale
 * regression that motivated it: a linear map crammed the bottom half of the cosmic
 * freq knob (log, 0.001–21 Hz) into the first CC step.
 */
import { describe, it, expect } from 'vitest';
import { midiNormToValue, valueToMidiNorm, isLogScale } from '../../src/input/midi/midiScale.js';

const FMIN = 0.001;
const FMAX = 21;
const geoMid = Math.sqrt(FMIN * FMAX); // ~0.1449 — the visual midpoint of a log knob

describe('midiScale — linear (default)', () => {
  it('maps endpoints and midpoint linearly', () => {
    expect(midiNormToValue(0, -180, 180, 'linear')).toBeCloseTo(-180, 6);
    expect(midiNormToValue(1, -180, 180, 'linear')).toBeCloseTo(180, 6);
    expect(midiNormToValue(0.5, -180, 180, 'linear')).toBeCloseTo(0, 6);
  });

  it('round-trips value → norm → value', () => {
    const norm = valueToMidiNorm(45, -180, 180, 'linear');
    expect(midiNormToValue(norm, -180, 180, 'linear')).toBeCloseTo(45, 6);
  });

  it('treats undefined scale as linear', () => {
    expect(midiNormToValue(0.25, 0, 100, undefined)).toBeCloseTo(25, 6);
  });
});

describe('midiScale — logarithmic', () => {
  it('maps endpoints exactly and the midpoint to the geometric mean', () => {
    expect(midiNormToValue(0, FMIN, FMAX, 'logarithmic')).toBeCloseTo(FMIN, 6);
    expect(midiNormToValue(1, FMIN, FMAX, 'logarithmic')).toBeCloseTo(FMAX, 6);
    expect(midiNormToValue(0.5, FMIN, FMAX, 'logarithmic')).toBeCloseTo(geoMid, 4);
  });

  it('REGRESSION: one CC step from the bottom stays near min, not the knob midpoint', () => {
    const oneStep = 1 / 127;
    const log = midiNormToValue(oneStep, FMIN, FMAX, 'logarithmic');
    const linear = midiNormToValue(oneStep, FMIN, FMAX, 'linear');
    // Linear put cc≈1 at the geometric midpoint of the log knob (the reported bug).
    expect(linear).toBeGreaterThan(geoMid * 0.9);
    // Log keeps it just above the minimum — well below the midpoint.
    expect(log).toBeLessThan(FMIN * 1.2);
    expect(log).toBeGreaterThan(FMIN);
  });

  it('round-trips value → norm → value across the range', () => {
    for (const v of [FMIN, 0.01, 0.1449, 1, 5, FMAX]) {
      const norm = valueToMidiNorm(v, FMIN, FMAX, 'logarithmic');
      expect(midiNormToValue(norm, FMIN, FMAX, 'logarithmic')).toBeCloseTo(v, 4);
    }
  });

  it('falls back to linear for a non-positive range (log undefined)', () => {
    expect(isLogScale('logarithmic', -1, 10)).toBe(false);
    expect(midiNormToValue(0.5, -1, 1, 'logarithmic')).toBeCloseTo(0, 6); // linear midpoint
  });

  it('clamps out-of-range inputs', () => {
    expect(midiNormToValue(2, FMIN, FMAX, 'logarithmic')).toBeCloseTo(FMAX, 6);
    expect(valueToMidiNorm(1000, FMIN, FMAX, 'logarithmic')).toBeCloseTo(1, 6);
    expect(valueToMidiNorm(FMIN / 10, FMIN, FMAX, 'logarithmic')).toBeCloseTo(0, 6);
  });

  it('returns null for unusable feedback inputs', () => {
    expect(valueToMidiNorm(NaN, FMIN, FMAX, 'logarithmic')).toBeNull();
    expect(valueToMidiNorm(1, 5, 5, 'logarithmic')).toBeNull();
  });
});
