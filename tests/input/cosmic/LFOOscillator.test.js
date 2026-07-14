/**
 * Deterministic waveform unit tests for the pure oscillator kernel
 * lifted out of CosmicLFO. No DOM, no ParameterManager: just time -> value math.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateWaveform,
  advancePhase,
  deriveOutputRange,
  sample,
} from '../../../src/input/cosmic/LFOOscillator.ts';

const TWO_PI = 2 * Math.PI;

describe('evaluateWaveform', () => {
  it('sine: zero at 0/π, +1 at π/2, -1 at 3π/2', () => {
    expect(evaluateWaveform(0, 'sine')).toBeCloseTo(0, 9);
    expect(evaluateWaveform(Math.PI / 2, 'sine')).toBeCloseTo(1, 9);
    expect(evaluateWaveform(Math.PI, 'sine')).toBeCloseTo(0, 9);
    expect(evaluateWaveform((3 * Math.PI) / 2, 'sine')).toBeCloseTo(-1, 9);
  });

  it('square: +1 on the rising half, -1 on the falling half', () => {
    expect(evaluateWaveform(Math.PI / 2, 'square')).toBe(1);
    expect(evaluateWaveform((3 * Math.PI) / 2, 'square')).toBe(-1);
    // boundary: sin(0) >= 0 -> +1
    expect(evaluateWaveform(0, 'square')).toBe(1);
  });

  it('sawtooth: ramps -1 -> +1 across one period', () => {
    expect(evaluateWaveform(0, 'sawtooth')).toBeCloseTo(-1, 9);
    expect(evaluateWaveform(Math.PI, 'sawtooth')).toBeCloseTo(0, 9);
    expect(evaluateWaveform(TWO_PI * 0.999999, 'sawtooth')).toBeCloseTo(1, 4);
  });

  it('triangle: -1 at 0, +1 at π, back to -1 at 2π', () => {
    expect(evaluateWaveform(0, 'triangle')).toBeCloseTo(-1, 9);
    expect(evaluateWaveform(Math.PI / 2, 'triangle')).toBeCloseTo(0, 9);
    expect(evaluateWaveform(Math.PI, 'triangle')).toBeCloseTo(1, 9);
    expect(evaluateWaveform((3 * Math.PI) / 2, 'triangle')).toBeCloseTo(0, 9);
  });

  it('defaults to sine for unknown waveform and no arg', () => {
    expect(evaluateWaveform(Math.PI / 2)).toBeCloseTo(1, 9);
    // @ts-expect-error — exercising the default fallback at runtime
    expect(evaluateWaveform(Math.PI / 2, 'noise')).toBeCloseTo(1, 9);
  });

  it('wraps negative and large phases into [0, 2π)', () => {
    expect(evaluateWaveform(-Math.PI / 2, 'sine')).toBeCloseTo(-1, 9);
    expect(evaluateWaveform(TWO_PI + Math.PI / 2, 'sine')).toBeCloseTo(1, 9);
  });

  it('every waveform stays within [-1, 1] across a full period', () => {
    for (const wf of ['sine', 'square', 'sawtooth', 'triangle']) {
      for (let i = 0; i < 64; i++) {
        const v = evaluateWaveform((i / 64) * TWO_PI, wf);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('advancePhase', () => {
  it('advances by 2π·f·dt and wraps into [0, 2π)', () => {
    // 1 Hz for 0.25 s -> quarter turn = π/2
    expect(advancePhase(0, 1, 0.25)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('wraps past 2π', () => {
    // 1 Hz for 1 s -> full turn -> back near 0
    expect(advancePhase(0, 1, 1)).toBeCloseTo(0, 9);
  });

  it('never returns a negative phase', () => {
    const p = advancePhase(0.1, -1, 1); // negative frequency edge case
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(TWO_PI);
  });

  it('rejects a non-finite frequency (no NaN phase)', () => {
    // NaN / Infinity frequency must not poison the phase — treated as 0 Hz (no advance).
    expect(advancePhase(0.3, NaN, 0.25)).toBeCloseTo(0.3, 9);
    expect(advancePhase(0.3, Infinity, 0.25)).toBeCloseTo(0.3, 9);
  });

  it('resets a non-finite incoming phase or dt to a finite phase', () => {
    expect(Number.isFinite(advancePhase(NaN, 1, 0.25))).toBe(true);
    expect(Number.isFinite(advancePhase(0, 1, NaN))).toBe(true);
  });
});

describe('deriveOutputRange', () => {
  it('full amplitude spans the whole range', () => {
    expect(deriveOutputRange({ min: 0, max: 10 }, 1)).toEqual({ min: 0, max: 10 });
  });

  it('zero amplitude collapses to the midpoint', () => {
    expect(deriveOutputRange({ min: 0, max: 10 }, 0)).toEqual({ min: 5, max: 5 });
  });

  it('half amplitude halves the window around the midpoint', () => {
    expect(deriveOutputRange({ min: 0, max: 10 }, 0.5)).toEqual({ min: 2.5, max: 7.5 });
  });

  it('clamps amplitude > 1 to full span', () => {
    expect(deriveOutputRange({ min: -4, max: 4 }, 5)).toEqual({ min: -4, max: 4 });
  });

  it('falls back to [0,1] for a zero-width or invalid range', () => {
    expect(deriveOutputRange({ min: 3, max: 3 }, 1)).toEqual({ min: 0, max: 1 });
    expect(deriveOutputRange({ min: NaN, max: 1 }, 1)).toEqual({ min: 0, max: 1 });
  });

  it('tolerates an inverted range (min > max) — normalises to a well-formed window', () => {
    // Inverted full-amplitude range collapses to the normalised [lo, hi].
    expect(deriveOutputRange({ min: 10, max: 0 }, 1)).toEqual({ min: 0, max: 10 });
    // Half amplitude around the (same) midpoint, regardless of orientation.
    expect(deriveOutputRange({ min: 10, max: 0 }, 0.5)).toEqual({ min: 2.5, max: 7.5 });
  });

  it('treats a non-finite amplitude as zero depth (collapses to the midpoint)', () => {
    expect(deriveOutputRange({ min: 0, max: 10 }, NaN)).toEqual({ min: 5, max: 5 });
  });
});

describe('sample (full oscillator step)', () => {
  const range = { min: 0, max: 10 };

  it('advances phase and produces a value inside the raw range', () => {
    const out = sample({ phase: 0, frequencyHz: 1, dtSeconds: 0.25, waveform: 'sine', amplitude: 1, range });
    expect(out.phase).toBeCloseTo(Math.PI / 2, 9);
    // sine at π/2 = +1 -> top of the full-amplitude window = max
    expect(out.value).toBeCloseTo(10, 9);
  });

  it('zero amplitude pins output to the range midpoint regardless of waveform', () => {
    for (const wf of ['sine', 'square', 'sawtooth', 'triangle']) {
      const out = sample({ phase: 1.234, frequencyHz: 3, dtSeconds: 0.05, waveform: wf, amplitude: 0, range });
      expect(out.value).toBeCloseTo(5, 9);
    }
  });

  it('clamps into the raw range', () => {
    const out = sample({ phase: Math.PI / 2 - 1e-3, frequencyHz: 0, dtSeconds: 0, waveform: 'sine', amplitude: 1, range });
    expect(out.value).toBeGreaterThanOrEqual(range.min);
    expect(out.value).toBeLessThanOrEqual(range.max);
  });

  it('is deterministic: same input -> same output', () => {
    const input = { phase: 0.7, frequencyHz: 2.5, dtSeconds: 0.016, waveform: 'triangle', amplitude: 0.8, range };
    expect(sample(input)).toEqual(sample(input));
  });

  it('phase output can be fed back to integrate over multiple ticks', () => {
    let phase = 0;
    // 1 Hz, four 0.25 s ticks -> one full revolution back to ~0
    for (let i = 0; i < 4; i++) {
      phase = sample({ phase, frequencyHz: 1, dtSeconds: 0.25, waveform: 'sine', amplitude: 1, range }).phase;
    }
    expect(phase).toBeCloseTo(0, 9);
  });

  it('never emits NaN for a non-finite frequency', () => {
    const out = sample({ phase: 0, frequencyHz: NaN, dtSeconds: 0.25, waveform: 'sine', amplitude: 1, range });
    expect(Number.isFinite(out.phase)).toBe(true);
    expect(Number.isFinite(out.value)).toBe(true);
  });

  it('clamps into the raw range even when the range is inverted', () => {
    const out = sample({ phase: Math.PI / 2, frequencyHz: 0, dtSeconds: 0, waveform: 'sine', amplitude: 1, range: { min: 10, max: 0 } });
    expect(out.value).toBeGreaterThanOrEqual(0);
    expect(out.value).toBeLessThanOrEqual(10);
  });
});
