import { EFFECT_MANIFEST } from './manifest.js';

const SECONDARY_UPDATE_DELAY_MS = 60;

function resolvePath(target, path) {
  const segments = Array.isArray(path) ? path : String(path).split('.');
  const leaf = segments.pop();
  let context = target;
  for (const segment of segments) {
    if (context == null) break;
    context = context[segment];
  }
  return { context, leaf };
}

function setToneValue(node, path, value, rampSeconds = 0) {
  const { context, leaf } = resolvePath(node, path);
  if (!context || !leaf) return;
  const property = context[leaf];
  if (property && typeof property === 'object' && 'value' in property) {
    if (rampSeconds > 0 && typeof property.rampTo === 'function') {
      property.rampTo(value, rampSeconds);
    } else {
      property.value = value;
    }
  } else {
    context[leaf] = value;
  }
}

function getToneProperty(node, path) {
  const { context, leaf } = resolvePath(node, path);
  if (!context || !leaf) return null;
  const property = context[leaf];
  if (property && typeof property === 'object' && 'value' in property) {
    return property;
  }
  return property ?? null;
}

function applyFixedParams(node, fixed) {
  if (!fixed) return;
  Object.entries(fixed).forEach(([property, value]) => {
    if (typeof value === 'undefined') return;
    setToneValue(node, property, value);
  });
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeToRange(value, range = { min: 0, max: 100 }) {
  const min = Number(range?.min) ?? 0;
  const max = Number(range?.max) ?? 100;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return 0;
  return clamp01((value - min) / (max - min));
}

function clampBits(value) {
  if (!Number.isFinite(value)) return 1;
  if (value <= 1) return 1;
  if (value >= 16) return 16;
  return Math.round(value);
}

function createModule({ node, manifest, moduleSpec }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: 0, max: 100 };
  const parameterMappings = moduleSpec.parameterMappings || {};
  const mappedParameters = Object.keys(parameterMappings);
  const primaryParam = moduleSpec.control?.audioParam || mappedParameters[0] || moduleSpec.target;
  const secondaryParams = (moduleSpec.control?.secondaryParameters || []).filter(
    (param) => param && param !== primaryParam && parameterMappings[param],
  );

  let automationBridge = null;
  let secondaryTimer = null;
  let pendingSecondaryNormalized = null;
  let secondaryInitialized = false;
  let lastNormalized = 0;
  const discreteCache = {};

  const getTargetParam = () => {
    const first = primaryParam || mappedParameters[0];
    return first ? getToneProperty(node, first) : null;
  };

  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));

  const mapParamValue = (paramName, normalized) => {
    const paramRange = parameterMappings[paramName];
    if (!paramRange) return null;
    const min = Number(paramRange.min);
    const max = Number(paramRange.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    let mapped = min + (max - min) * normalized;
    if (paramName === 'bits') {
      mapped = clampBits(mapped);
    } else if (paramName === 'wet') {
      mapped = clamp01(mapped);
    }
    return mapped;
  };

  const applyPrimaryParam = (normalized) => {
    if (!primaryParam || !parameterMappings[primaryParam]) return;
    const mappedValue = mapParamValue(primaryParam, normalized);
    if (mappedValue == null) return;
    if (automationBridge?.ramp) {
      automationBridge.ramp(mappedValue);
    } else {
      setToneValue(node, primaryParam, mappedValue);
    }
  };

  const applySecondaryParams = (normalized, { force = false } = {}) => {
    if (!secondaryParams.length) return;
    secondaryParams.forEach((paramName) => {
      const value = mapParamValue(paramName, normalized);
      if (value == null) return;
      if (!force && discreteCache[paramName] === value) return;
      discreteCache[paramName] = value;
      setToneValue(node, paramName, value);
    });
  };

  const queueSecondaryUpdate = (normalized, immediate = false) => {
    if (!secondaryParams.length) return;
    pendingSecondaryNormalized = normalized;
    if (immediate || !secondaryInitialized) {
      secondaryInitialized = true;
      if (secondaryTimer) {
        clearTimeout(secondaryTimer);
        secondaryTimer = null;
      }
      applySecondaryParams(pendingSecondaryNormalized, { force: true });
      pendingSecondaryNormalized = null;
      return;
    }

    if (secondaryTimer) return;
    secondaryTimer = setTimeout(() => {
      secondaryTimer = null;
      if (pendingSecondaryNormalized == null) return;
      applySecondaryParams(pendingSecondaryNormalized);
      pendingSecondaryNormalized = null;
    }, SECONDARY_UPDATE_DELAY_MS);
  };

  const applyValue = (value, options = {}) => {
    const numeric = toNumber(value);
    if (numeric == null) return;

    try {
      const normalized = normalizeToRange(numeric, range);
      lastNormalized = normalized;
      applyPrimaryParam(normalized);
      queueSecondaryUpdate(normalized, options.immediateSecondary === true);
    } catch (error) {
      console.warn('[ToneBitCrusherEffect] Failed to apply value', error);
    }
  };

  const userParam = {
    id: manifest.userParamSpec?.id ?? manifest.inputParam,
    label: manifest.userParamSpec?.label ?? 'Input',
    toneProperty: primaryParam || mappedParameters.join(','),
    tonePropertyTargets: primaryParam ? [primaryParam] : mappedParameters,
    description: moduleSpec.description,
    valueRange: range,
    applyValue,
    getTargetParam,
  };

  return {
    id: moduleSpec.id,
    label: moduleSpec.label,
    description: moduleSpec.description,
    inputParam: manifest.inputParam,
    toneProperty: userParam.toneProperty,
    tonePropertyDescription: moduleSpec.description,
    valueRange: range,
    fixedParams,
    getTargetParam,
    applyValue,
    configure() {
      applyFixedParams(node, moduleSpec.fixed);
      queueSecondaryUpdate(lastNormalized, true);
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
    },
  };
}

export function createToneBitCrusherEffect({ Tone, settings } = {}) {
  if (!Tone?.BitCrusher) {
    throw new Error('[ToneBitCrusherEffect] Tone.BitCrusher constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.BitCrusher(...ctorArgs)
    : new Tone.BitCrusher(ctorArgs[0]);

  const modules = EFFECT_MANIFEST.modules.map((moduleSpec) =>
    createModule({ node, manifest: EFFECT_MANIFEST, moduleSpec }),
  );

  modules[0]?.configure?.();

  return {
    id: EFFECT_MANIFEST.id,
    label: EFFECT_MANIFEST.label,
    version: EFFECT_MANIFEST.version,
    inputParam: EFFECT_MANIFEST.inputParam,
    node,
    modules,
    configureModule(moduleId) {
      const module = modules.find((item) => item.id === moduleId);
      module?.configure?.();
    },
    dispose() {
      modules.splice(0, modules.length);
      if (typeof node.dispose === 'function') {
        node.dispose();
      }
    },
    manifest: EFFECT_MANIFEST,
  };
}

export default createToneBitCrusherEffect;
