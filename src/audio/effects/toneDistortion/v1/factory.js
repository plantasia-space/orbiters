import { EFFECT_MANIFEST } from './manifest.js';

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function transformNormalized(x, transform) {
  const n = clamp(Number.isFinite(x) ? x : 0, 0, 1);
  switch (transform) {
    case 'sqrt':
      return Math.sqrt(n);
    case 'pow2':
      return Math.pow(n, 2);
    case 'pow3':
      return Math.pow(n, 3);
    case 'exp': {
      // Smooth exponential 0..1 mapped to 0..1
      const e = Math.E;
      return (Math.exp(n) - 1) / (e - 1);
    }
    case 'linear':
    default:
      return n;
  }
}

function createModule({ node, manifest, moduleSpec }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: 0, max: 100 };
  const parameterMappings = moduleSpec.parameterMappings || {};
  const mappedParameters = Object.keys(parameterMappings);
  const primaryParam = moduleSpec.control?.audioParam || mappedParameters[0] || moduleSpec.target;
  let automationBridge = null;

  const getTargetParam = () => {
    const first = mappedParameters[0] || primaryParam;
    return first ? getToneProperty(node, first) : null;
  };

  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));

  const applyValue = (value) => {
    const numeric = toNumber(value);
    if (numeric == null) return;

    try {
      const normalized = (numeric - range.min) / (range.max - range.min);
      
      // Extract segments
      const isNegativeSegment = normalized < 0.5;
      const segment = isNegativeSegment ? moduleSpec.segments.negative : moduleSpec.segments.positive;
      const localNorm = isNegativeSegment ? normalized * 2 : (normalized - 0.5) * 2;

      if (!segment?.parameterMappings) {
        console.warn('[ToneDistortionEffect] No segment mappings found');
        return;
      }

      // All params: continuous updates
      const distortionRange = segment.parameterMappings.distortion;
      const wetRange = segment.parameterMappings.wet;

      const distortionValue = clamp(distortionRange.min + localNorm * (distortionRange.max - distortionRange.min), 0, 1);
      const wetValue = clamp(wetRange.min + localNorm * (wetRange.max - wetRange.min), 0, 1);

      // Apply all parameters continuously
      if (automationBridge?.ramp) {
        automationBridge.ramp(distortionValue);
      } else {
        setToneValue(node, 'distortion', distortionValue);
      }
      
      setToneValue(node, 'wet', wetValue);
    } catch (error) {
      console.warn('[ToneDistortionEffect] Failed to apply value', error);
    }
  };

  const userParam = {
    id: manifest.userParamSpec?.id ?? manifest.inputParam,
    label: manifest.userParamSpec?.label ?? 'Input',
    toneProperty: mappedParameters.join(',') || primaryParam || '',
    tonePropertyTargets: mappedParameters.length ? mappedParameters : (primaryParam ? [primaryParam] : []),
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
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
    },
  };
}

export function createToneDistortionEffect({ Tone, settings } = {}) {
  if (!Tone?.Distortion) {
    throw new Error('[ToneDistortionEffect] Tone.Distortion constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.Distortion(...ctorArgs)
    : new Tone.Distortion(ctorArgs[0]);

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

export default createToneDistortionEffect;
