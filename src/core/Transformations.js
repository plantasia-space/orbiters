/**
 * @file Transformations.js
 * @description Provides transformation functions for non-linear parameter mappings.
 * Each transformation includes an `inputTransform` and an `outputTransform`.
 * 
 * @version 2.0.0
 * @autor 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2024-12-08
 * @example
 * // Example of using logarithmic transformation with ParameterManager
 * import { logarithmic } from './Transformations.js';
 * import { ParameterManager } from './ParameterManager.js';
 * 
 * const paramManager = new ParameterManager();
 * 
 * paramManager.addParameter(
 *   'volume',
 *   0.5, // Initial normalized value
 *   0,   // Min raw value
 *   100, // Max raw value
 *   true, // isBidirectional
 *   logarithmic.inverse, // inputTransform
 *   logarithmic.forward // outputTransform
 * );
 */

/**
 * @typedef {Object} Transformation
 * @property {function(number): number} forward - Transforms a raw value to a normalized value.
 * @property {function(number): number} inverse - Transforms a normalized value back to a raw value.
 */

/**
 * Linear transformation (identity).
 * Suitable for parameters where linear scaling is appropriate.
 * 
 * @type {Transformation}
 * @memberof CoreModule 

 * @property {function(number): number} forward - Returns the input value unchanged.
 * @property {function(number): number} inverse - Returns the input value unchanged.
 */
export const linear = {
  forward: (x) => x,
  inverse: (normalized) => normalized,
};

/**
 * Logarithmic transformation.
 * Converts a normalized [0,1] value to a dB scale suitable for audio volume.
 * Handles edge cases by clamping input to avoid invalid logarithmic operations.
 * 
 * @type {Transformation}
 * @memberof CoreModule 

 * @property {function(number): number} forward - Maps normalized [0,1] to dB scale.
 * @property {function(number): number} inverse - Maps dB scale back to normalized [0,1].
 */
export const logarithmic = {
  /**
   * forward: from normalized [0..1] -> dB [-60..+6]
   * We use an exponent to make the mapping non-linear.
   */
  forward: (norm) => {
    const minDb = -60;
    const maxDb = 6;
    if (norm <= 0) return minDb; // treat 0 as the minimum
    // Adjust 'exponent' for the curve shape; higher values compress the low end more.
    const exponent = 2.0;
    const mappedNorm = Math.pow(norm, exponent);
    return minDb + (maxDb - minDb) * mappedNorm;
  },

  /**
   * inverse: from dB [-60..+6] -> normalized [0..1]
   */
  inverse: (db) => {
    const minDb = -60;
    const maxDb = 6;
    if (db <= minDb) return 0;
    const exponent = 2.0;
    const mappedNorm = (db - minDb) / (maxDb - minDb);
    return Math.pow(mappedNorm, 1 / exponent);
  },
};