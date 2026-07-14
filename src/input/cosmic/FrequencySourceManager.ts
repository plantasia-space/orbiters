/**
 * @file src/input/cosmic/FrequencySourceManager.ts
 * @description Frequency resolve + clamp logic lifted out of CosmicLFO.
 *
 * Pure helpers for turning a raw frequency candidate (manual entry, an exoplanet
 * data source, or a multiplier step) into a sanitised Hz value inside the cosmic
 * LFO's physical range. No DOM, no state — the impure source-selection /
 * persistence plumbing stays in the CosmicLFO facade.
 *
 * The range bounds come from the shared cosmic-frequency param module, so this and
 * the PM param stay in lock-step (single source of truth, strategy §7 KEEP).
 */

import {
  COSMIC_FREQ_MIN as MIN_FREQUENCY_HZ,
  COSMIC_FREQ_MAX as MAX_FREQUENCY_HZ,
} from '../cosmicFrequencyParam.js';

export { MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ };

/** Internal precision the cosmic frequencies are rounded to (mirrors PM). */
const PRECISION_DECIMALS = 9;

/** Coerce to a finite number, or null. */
export function toFiniteNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * Clamp a frequency into [MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ] and round to the
 * internal precision. Non-finite input falls back to the minimum.
 */
export function sanitizeFrequency(freq: unknown): number {
  const parsed = toFiniteNumber(freq);
  if (parsed == null) return MIN_FREQUENCY_HZ;
  let clamped = parsed;
  if (clamped < MIN_FREQUENCY_HZ) clamped = MIN_FREQUENCY_HZ;
  if (clamped > MAX_FREQUENCY_HZ) clamped = MAX_FREQUENCY_HZ;
  return Number(clamped.toFixed(PRECISION_DECIMALS));
}

/**
 * Octave-fold an arbitrary frequency (e.g. an exoplanet datum or a multiplier
 * product) into the audible LFO range by repeatedly halving/doubling, then clamp.
 * Returns null for non-finite or zero input (no harmonic exists).
 */
export function ensureHarmonicRange(value: unknown): number | null {
  const num = toFiniteNumber(value);
  if (num == null) return null;
  const absValue = Math.abs(num);
  if (absValue === 0) return null;

  let freq = absValue;
  while (freq < MIN_FREQUENCY_HZ) freq *= 2;
  while (freq > MAX_FREQUENCY_HZ) freq /= 2;

  if (freq < MIN_FREQUENCY_HZ) freq = MIN_FREQUENCY_HZ;
  if (freq > MAX_FREQUENCY_HZ) freq = MAX_FREQUENCY_HZ;
  return Number(freq.toFixed(PRECISION_DECIMALS));
}

export interface MultiplierResult {
  /** The new accumulated multiplier (e.g. prior × the applied step). */
  multiplier: number;
  /** The resulting sanitised frequency, or null if no harmonic could be derived. */
  frequency: number | null;
}

/**
 * Apply a trigger multiplier step (e.g. ×0.5 / ×2) to a source base frequency.
 * Returns the new accumulated multiplier and the harmonised+sanitised frequency,
 * or `frequency: null` when the product has no representable harmonic.
 */
export function applyMultiplier(
  sourceBaseFrequency: number,
  currentMultiplier: number,
  step: number,
): MultiplierResult {
  const newMultiplier = currentMultiplier * step;
  const harmonized = ensureHarmonicRange(sourceBaseFrequency * newMultiplier);
  if (harmonized == null) {
    return { multiplier: newMultiplier, frequency: null };
  }
  const sanitized = sanitizeFrequency(harmonized);
  if (sanitized < MIN_FREQUENCY_HZ || sanitized > MAX_FREQUENCY_HZ) {
    return { multiplier: newMultiplier, frequency: null };
  }
  return { multiplier: newMultiplier, frequency: sanitized };
}
