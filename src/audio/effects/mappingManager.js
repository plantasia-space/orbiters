/**
 * @file mappingManager.js
 * @description Utilities for serialising, sanitising, and applying module mapping overrides.
 */
const resolveNumericValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const isFiniteNumber = (value) => resolveNumericValue(value) !== null;

const RANGE_KEYS = new Set(['min', 'max']);

const isNormalizedRange = (range) => {
  if (!range || typeof range !== 'object') return false;
  const keys = Object.keys(range);
  if (!keys.length) return false;
  return keys.every((key) => RANGE_KEYS.has(key) && Number.isFinite(range[key]));
};

const sanitizeRange = (range) => {
  if (isNormalizedRange(range)) return range;
  if (!range || typeof range !== 'object') return undefined;
  const min = isFiniteNumber(range.min) ? Number(range.min) : undefined;
  const max = isFiniteNumber(range.max) ? Number(range.max) : undefined;
  if (typeof min === 'undefined' && typeof max === 'undefined') return undefined;
  return {
    ...(typeof min !== 'undefined' ? { min } : {}),
    ...(typeof max !== 'undefined' ? { max } : {}),
  };
};

const ALLOWED_MAPPING_KEYS = new Set(['target', 'curve', 'clamp', 'inputRange', 'outputRange']);

const isNormalizedMapping = (mapping) => {
  if (!mapping || typeof mapping !== 'object' || !mapping.target) return false;
  const keys = Object.keys(mapping);
  if (!keys.every((key) => ALLOWED_MAPPING_KEYS.has(key))) return false;
  if (typeof mapping.curve !== 'undefined' && typeof mapping.curve !== 'string') return false;
  if (typeof mapping.clamp !== 'undefined' && typeof mapping.clamp !== 'boolean') return false;
  if (mapping.inputRange && !isNormalizedRange(mapping.inputRange)) return false;
  if (mapping.outputRange && !isNormalizedRange(mapping.outputRange)) return false;
  return true;
};

const cloneMapping = (mapping) => {
  if (!mapping || typeof mapping !== 'object' || !mapping.target) return null;
  if (isNormalizedMapping(mapping)) {
    return mapping;
  }
  const cloned = {
    target: mapping.target,
  };
  if (typeof mapping.curve === 'string') cloned.curve = mapping.curve;
  if (typeof mapping.clamp === 'boolean') cloned.clamp = mapping.clamp;
  const inputRange = sanitizeRange(mapping.inputRange);
  if (inputRange) cloned.inputRange = inputRange;
  const outputRange = sanitizeRange(mapping.outputRange);
  if (outputRange) cloned.outputRange = outputRange;
  return cloned;
};

/**
 * Normalises persisted mapping objects by stripping unknown keys and coercing ranges
 * into `{ min, max }` tuples. Used when loading rack state from the session bus.
 * @param {Array<object>} mappings
 * @returns {Array<object>}
 */
export function sanitizeMappings(mappings = []) {
  if (!Array.isArray(mappings)) return [];
  return mappings
    .map((mapping) => cloneMapping(mapping))
    .filter(Boolean);
}

/**
 * Safely reads a module's mapping list, even if the module does not implement `getMappings`.
 * @param {{ getMappings?: Function }} module
 * @returns {Array<object>}
 */
export function extractModuleMappings(module) {
  if (!module || typeof module.getMappings !== 'function') return [];
  const list = module.getMappings();
  return sanitizeMappings(Array.isArray(list) ? list : []);
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number(min);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return numeric;
  if (min === max) return min;
  return Math.min(max, Math.max(min, numeric));
}

function isValidRange(range) {
  if (!range) return false;
  const min = resolveNumericValue(range.min);
  const max = resolveNumericValue(range.max);
  const equilibrium = resolveNumericValue(range.equilibrium ?? range.init);
  if (min === null || max === null || equilibrium === null) return false;
  return max !== min;
}

/**
 * Builds a pair of piecewise-linear mappings that respect a module's declared equilibrium.
 * Ensures neutral/bypass behaviour aligns with the Effect Design Standard.
 * @param {string} target
 * @param {{ min: number, max: number, equilibrium?: number }} range
 * @returns {Array<object>}
 */
function buildPiecewiseMappings(target, range) {
  if (!target) return [];

  const min = resolveNumericValue(range.min);
  const max = resolveNumericValue(range.max);
  let equilibrium = resolveNumericValue(range.equilibrium ?? range.init);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [];
  }

  if (!Number.isFinite(equilibrium)) {
    equilibrium = min + (max - min) / 2;
  }

  const mappings = [];

  if (Number.isFinite(equilibrium) && equilibrium !== min) {
    mappings.push({
      target,
      inputRange: { min, max: equilibrium },
      outputRange: { min, max: equilibrium },
      curve: 'linear',
      clamp: true,
    });
  }

  if (Number.isFinite(equilibrium) && equilibrium !== max) {
    mappings.push({
      target,
      inputRange: { min: equilibrium, max },
      outputRange: { min: equilibrium, max },
      curve: 'linear',
      clamp: true,
    });
  }

  if (!mappings.length) {
    mappings.push({
      target,
      inputRange: { min, max },
      outputRange: { min, max },
      curve: 'linear',
      clamp: true,
    });
  }

  return mappings;
}

/**
 * Maps a normalised rack control value (0–1) into the module's domain.
 * Supports either linear or perceptual/log transforms and honours quantisation hints.
 * @param {{ min: number, max: number, equilibrium?: number, quantize?: { step?: number } }} range
 * @param {number} controlValue - Normalised value from the rack.
 * @param {{ target?: string|null, transform?: 'linear'|'log', log?: boolean }} [options]
 * @returns {number} Mapped domain value ready to push into a Tone param.
 */
export function mapControlValueToRange(range, controlValue, options = {}) {
  if (!range) return 0;
  const { target = null, transform = 'linear', log: debug = false } = options || {};

  const min = resolveNumericValue(range.min);
  const max = resolveNumericValue(range.max);
  let equilibrium = resolveNumericValue(range.equilibrium ?? range.init);
  const quantizeStep = Number(range.quantize?.step ?? NaN);

  if (min === null || max === null) return equilibrium ?? 0;

  if (!Number.isFinite(equilibrium)) {
    equilibrium = min + (max - min) / 2;
  }

  const numericControl = Number(controlValue);
  const clampedControl = Number.isFinite(numericControl) ? clamp(numericControl, 0, 1) : 0.5;

  let mappedValue;

  // Helper for log10 with fallback
  const log10 = (v) => Math.log(v) / Math.log(10);
  const pow10 = (v) => Math.pow(10, v);

  if (transform === 'log') {
    // Perceptual/log mapping in log domain using equilibrium as the midpoint (0.5)
    const eps = 1e-6;
    const safeMin = Math.max(min, eps);
    const safeEq = Math.max(equilibrium, eps);
    const safeMax = Math.max(max, eps);

    const lmin = log10(safeMin);
    const leq = log10(safeEq);
    const lmax = log10(safeMax);

    if (clampedControl <= 0.5) {
      const proportion = clampedControl / 0.5; // 0.0 → 1.0
      const lv = lmin + (leq - lmin) * proportion;
      mappedValue = pow10(lv);
    } else {
      const proportion = (clampedControl - 0.5) / 0.5; // 0.0 → 1.0
      const lv = leq + (lmax - leq) * proportion;
      mappedValue = pow10(lv);
    }
  } else {
    // Piecewise linear mapping (from Rack-OLD.js)
    if (clampedControl <= 0.5) {
      const proportion = clampedControl / 0.5; // 0.0 → 1.0
      mappedValue = min + (equilibrium - min) * proportion;
    } else {
      const proportion = (clampedControl - 0.5) / 0.5; // 0.0 → 1.0
      mappedValue = equilibrium + (max - equilibrium) * proportion;
    }
  }

  if (Number.isFinite(quantizeStep) && quantizeStep > 0) {
    mappedValue = Math.round(mappedValue / quantizeStep) * quantizeStep;
  }

  if (debug) {
    const rotationValue = clampedControl * 360 - 180;
    console.log('[MappingManager] Applied mapping', {
      target: target ?? null,
      controlValue: Number.isFinite(numericControl) ? numericControl : null,
      normalizedInput: clampedControl,
      rotationValue,
      mappedValue,
      range: {
        min,
        max,
        equilibrium,
      },
      transform,
    });
  }

  return mappedValue;
}

/**
 * Converts a saved mapping's `[0,1]` input window back into the module's domain so persisted
 * overrides still behave correctly when the module's base range shifts.
 * @param {object} mapping
 * @param {{ min: number, max: number, equilibrium?: number }} range
 * @returns {object}
 */
function denormalizeMappingInputRange(mapping, range) {
  if (!mapping?.inputRange || !range) return mapping;
  const min = resolveNumericValue(mapping.inputRange.min);
  const max = resolveNumericValue(mapping.inputRange.max);
  if (min === null || max === null) return mapping;
  if (min < 0 || max > 1 || min > max) return mapping;
  const mappedMin = mapControlValueToRange(range, min, { target: mapping.target ?? null, log: false });
  const mappedMax = mapControlValueToRange(range, max, { target: mapping.target ?? null, log: false });
  if (!Number.isFinite(mappedMin) || !Number.isFinite(mappedMax)) return mapping;
  return {
    ...mapping,
    inputRange: {
      min: mappedMin,
      max: mappedMax,
    },
  };
}

/**
 * Produces the mapping list that should be applied to a module by combining:
 * - piecewise default mappings (derived from the module's range/equilibrium)
 * - any saved overrides specified by the session payload
 * Saved mappings win and are denormalised back into the module's domain.
 * @param {Array<object>} defaultMappings
 * @param {Array<object>} savedMappings
 * @param {{ min: number, max: number, equilibrium?: number }|null} rangeOverride
 * @returns {Array<object>}
 */
export function buildModuleMappingOverrides(defaultMappings = [], savedMappings = [], rangeOverride = null) {
  const defaults = Array.isArray(defaultMappings) ? defaultMappings.filter((item) => item?.target) : [];
  const saved = sanitizeMappings(savedMappings);
  if (saved.length) {
    const converted = isValidRange(rangeOverride)
      ? saved
          .map((mapping) => denormalizeMappingInputRange(mapping, rangeOverride))
          .filter(Boolean)
      : saved;

    return converted
      .slice()
      .sort((a, b) => {
        const minA = resolveNumericValue(a.inputRange?.min);
        const minB = resolveNumericValue(b.inputRange?.min);
        if (minA === null && minB === null) return 0;
        if (minA === null) return 1;
        if (minB === null) return -1;
        return minA - minB;
      });
  }

  if (!rangeOverride) return [];
  const firstTarget = defaults[0]?.target;
  if (!firstTarget) return [];

  if (!isValidRange(rangeOverride)) return [];

  const overrides = buildPiecewiseMappings(firstTarget, rangeOverride);

  defaults.slice(1).forEach((mapping) => {
    const cloned = cloneMapping(mapping);
    if (!cloned) return;
    overrides.push(denormalizeMappingInputRange(cloned, rangeOverride));
  });

  return overrides;
}

/**
 * Applies the resolved mappings to a module if it exposes the `setMappings` contract.
 * @param {{ setMappings?: Function, getDefaultMappings?: Function, getMappings?: Function }} module
 * @param {Array<object>} savedMappings
 * @param {{ min: number, max: number, equilibrium?: number }|null} rangeOverride
 */
export function applyMappingsToModule(module, savedMappings = [], rangeOverride = null) {
  if (!module || typeof module.setMappings !== 'function') return;
  const defaultMappings =
    (typeof module.getDefaultMappings === 'function' && module.getDefaultMappings()) ||
    (typeof module.getMappings === 'function' && module.getMappings()) ||
    [];
  const overrides = buildModuleMappingOverrides(defaultMappings, savedMappings, rangeOverride);
  if (!overrides.length) return;
  try {
    module.setMappings(overrides);
  } catch (error) {
    console.warn('[MappingManager] Failed to apply mapping overrides', error);
  }
}

/**
 * Formats a numeric value for display in the Engine Monitor.
 * Rounds to 2 decimal places and removes unnecessary trailing zeros.
 * @param {number|string|null} value
 * @param {string|null} [units]
 * @returns {string}
 */
export function formatMonitorValue(value, units = null) {
  if (value === null || value === undefined || value === '') return units ? `0 ${units}` : '0';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return units ? `0 ${units}` : '0';
  
  // Round to 2 decimal places
  const rounded = Math.round(numeric * 100) / 100;
  
  // Convert to string and remove trailing zeros after decimal point
  // BUT preserve the zero if it's the only digit (e.g., "0" should stay "0", not "")
  let formatted = String(rounded);
  if (formatted.includes('.')) {
    formatted = formatted.replace(/\.?0+$/, '');
  }
  
  // Append units if provided
  return units ? `${formatted} ${units}` : formatted;
}
