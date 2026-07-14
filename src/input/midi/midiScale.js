/**
 * @file src/input/midi/midiScale.js
 * @description MIDI value scaling shared by the inbound (CC → param value) and outbound
 * (param value → CC feedback) directions, honouring a parameter's `scale`.
 *
 * A `logarithmic` parameter (e.g. the manual Cosmic LFO frequency, 0.001–21 Hz) maps
 * MIDI linearly in LOG space: `value = min·(max/min)^norm`. This makes equal CC steps
 * equal knob-POSITION steps, matching an arrow `log` knob. A LINEAR map instead crams
 * the whole bottom half of a log knob into the first CC step (`cc≈1` jumped the
 * freq knob to its visual midpoint). Log requires a strictly positive range; it falls
 * back to linear otherwise. The parameter's `scale` (declared once on the PM param) is
 * the single source of truth for both directions.
 */

export function isLogScale(scale, min, max) {
  return (
    scale === 'logarithmic' &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min > 0 &&
    max > 0 &&
    max !== min
  );
}

/**
 * MIDI-normalized [0,1] → parameter value.
 * @param {number} norm - normalized MIDI value (0..1).
 * @param {number} min
 * @param {number} max
 * @param {string} [scale] - 'logarithmic' for log mapping; anything else is linear.
 * @returns {number}
 */
export function midiNormToValue(norm, min, max, scale) {
  const n = Math.min(1, Math.max(0, Number(norm) || 0));
  if (isLogScale(scale, min, max)) {
    return min * Math.pow(max / min, n);
  }
  return min + n * (max - min);
}

/**
 * Parameter value → MIDI-normalized [0,1] (the inverse of {@link midiNormToValue}).
 * @returns {number|null} normalized value in [0,1], or null if the inputs are unusable.
 */
export function valueToMidiNorm(value, min, max, scale) {
  const v = Number(value);
  if (!Number.isFinite(v) || !Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return null;
  }
  let norm;
  if (isLogScale(scale, min, max)) {
    const clamped = Math.min(max, Math.max(min, v));
    norm = Math.log(clamped / min) / Math.log(max / min);
  } else {
    norm = (v - min) / (max - min);
  }
  return Math.min(1, Math.max(0, norm));
}
