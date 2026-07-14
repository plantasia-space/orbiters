/**
 * @file src/input/cosmic/LFOOscillator.ts
 * @description The pure modulation kernel lifted out of CosmicLFO.
 *
 * No DOM, no ParameterManager, no scoped state — just time -> value math:
 * phase advance, waveform evaluation, amplitude-scaled output range, and the
 * combined `sample()` step CosmicLFO drives once per visual tick. Deterministic
 * and side-effect free so it can be unit-tested directly (the repo's first real
 * oscillator tests) and reused beyond the cosmic context.
 *
 * CosmicLFO (the .js facade) owns all the impure parts — scoped state, the push
 * to ParameterManager / the InputSource seam, knob/dropdown DOM — and calls into
 * this for the maths.
 */

const TWO_PI = 2 * Math.PI;

/**
 * Hard frequency bounds for phase advance, in Hz. FrequencySourceManager normally
 * resolves + clamps the frequency before it reaches `sample()`, but this kernel is
 * pure and reusable, so it defends itself: a NaN/Infinity/negative frequencyHz can
 * otherwise poison `phase` (→ NaN) and propagate a NaN value to every subscriber.
 * Bounds mirror the cosmic param range (COSMIC_FREQ_MIN/MAX = 0.001..21) but are
 * inlined to keep this module dependency-free; the upper bound is generous so
 * non-cosmic reuse isn't capped.
 */
const MIN_FREQUENCY_HZ = 0;
const MAX_FREQUENCY_HZ = 100_000;

/** Clamp a frequency into the safe band, mapping non-finite input to 0 (no advance). */
function safeFrequencyHz(frequencyHz: number): number {
  if (!Number.isFinite(frequencyHz)) return MIN_FREQUENCY_HZ;
  return Math.max(MIN_FREQUENCY_HZ, Math.min(MAX_FREQUENCY_HZ, frequencyHz));
}

/** The four waveforms the cosmic LFO supports. `sine` is the default fallback. */
export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle';

/** A parameter's raw value range, e.g. an axis's `{ min, max }`. */
export interface Range {
  min: number;
  max: number;
}

/** Inputs for one oscillator step. `phase` is in radians (any real; wrapped internally). */
export interface SampleInput {
  /** Current accumulated phase in radians. */
  phase: number;
  /** Oscillation frequency in Hz (already resolved + clamped by FrequencySourceManager). */
  frequencyHz: number;
  /** Time elapsed since the previous sample, in seconds. */
  dtSeconds: number;
  /** Active waveform. */
  waveform: Waveform;
  /** Modulation depth, 0..1 (clamped). */
  amplitude: number;
  /** The target parameter's raw range; the output is mapped into and clamped to it. */
  range: Range;
}

export interface SampleResult {
  /** The advanced, wrapped phase (radians, 0..2π) — feed back in next tick. */
  phase: number;
  /** The mapped, clamped parameter value. */
  value: number;
}

/**
 * Evaluate a normalised waveform at a given phase, returning a value in [-1, 1].
 * Phase is wrapped to [0, 2π) first, so any real phase is accepted.
 */
export function evaluateWaveform(phase: number, waveform: Waveform = 'sine'): number {
  const wrapped = ((phase % TWO_PI) + TWO_PI) % TWO_PI;
  switch (waveform) {
    case 'square':
      return Math.sin(wrapped) >= 0 ? 1 : -1;
    case 'sawtooth':
      return (wrapped / TWO_PI) * 2 - 1;
    case 'triangle':
      return wrapped < Math.PI
        ? (wrapped / Math.PI) * 2 - 1
        : 1 - ((wrapped - Math.PI) / Math.PI) * 2;
    case 'sine':
    default:
      return Math.sin(wrapped);
  }
}

/**
 * Advance phase by `frequencyHz` over `dtSeconds`, wrapped into [0, 2π).
 * `frequencyHz` is clamped to the safe band and non-finite input is rejected
 * (treated as 0 Hz → no advance), so a bad frequency can never produce a NaN
 * phase. A non-finite incoming `phase` or `dtSeconds` resets to 0.
 */
export function advancePhase(phase: number, frequencyHz: number, dtSeconds: number): number {
  const basePhase = Number.isFinite(phase) ? phase : 0;
  const dt = Number.isFinite(dtSeconds) ? dtSeconds : 0;
  const twoPiFreq = TWO_PI * safeFrequencyHz(frequencyHz);
  const next = (basePhase + twoPiFreq * dt) % TWO_PI;
  return next < 0 ? next + TWO_PI : next;
}

/**
 * Collapse a parameter's raw range to the amplitude-scaled output window,
 * centred on the range midpoint. amplitude is clamped to [0, 1]; an invalid or
 * zero-width range falls back to [0, 1].
 */
export function deriveOutputRange(range: Range, amplitude: number): Range {
  const rawMin = Number(range?.min ?? 0);
  const rawMax = Number(range?.max ?? 1);
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax) || rawMin === rawMax) {
    return { min: 0, max: 1 };
  }
  // Tolerate an inverted range (min > max): normalise to [lo, hi] so the depth
  // window is always well-formed. A non-finite amplitude falls back to 0 depth.
  const lo = Math.min(rawMin, rawMax);
  const hi = Math.max(rawMin, rawMax);
  const span = hi - lo;
  const mid = lo + span / 2;
  const amp = Number.isFinite(amplitude) ? amplitude : 0;
  const depth = (span / 2) * Math.max(0, Math.min(1, amp));
  return { min: Math.max(lo, mid - depth), max: Math.min(hi, mid + depth) };
}

/**
 * One oscillator step: advance phase, evaluate the waveform, map [-1, 1] into the
 * amplitude-scaled output window, and clamp to the parameter's raw range.
 *
 * This is the exact kernel CosmicLFO ran inline per dimension per visual tick.
 */
export function sample(input: SampleInput): SampleResult {
  const { frequencyHz, dtSeconds, waveform, amplitude, range } = input;
  const phase = advancePhase(input.phase, frequencyHz, dtSeconds);
  const outputRange = deriveOutputRange(range, amplitude);
  const wave = evaluateWaveform(phase, waveform); // -1..1
  const mapped = outputRange.min + (wave + 1) * 0.5 * (outputRange.max - outputRange.min);
  // Clamp to the raw range regardless of its orientation (tolerate min > max).
  const lo = Math.min(range.min, range.max);
  const hi = Math.max(range.min, range.max);
  const value = Math.min(hi, Math.max(lo, mapped));
  return { phase, value };
}
