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
    if (property === 'start' && value && typeof node.start === 'function') {
      try { node.start(); } catch (_) {}
      return;
    }
    setToneValue(node, property, value);
  });
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

const MIN_CHORUS_DELTA = { frequency: 0.05, delayTime: 0.1, feedback: 0.005, wet: 0.005, depth: 0.005 };

function createModule({ node, manifest, moduleSpec }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: 0, max: 100 };
  const parameterMappings = moduleSpec.parameterMappings || {};
  const mappedParameters = Object.keys(parameterMappings);
  const primaryParam = moduleSpec.control?.audioParam || mappedParameters[0] || moduleSpec.target;
  let automationBridge = null;
  const discreteCache = Object.create(null);
  const equilibriumValue = Number.isFinite(moduleSpec.initialRange?.equilibrium)
    ? moduleSpec.initialRange.equilibrium
    : (Number(range.min) + Number(range.max)) / 2;

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
        console.warn('[ToneChorusEffect] No segment mappings found');
        return;
      }

      // All params: continuous updates
      const mapSegmentValue = (rangeDef) => {
        if (!rangeDef) return null;
        const min = Number(rangeDef.min);
        const max = Number(rangeDef.max);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
        return min + localNorm * (max - min);
      };

      const depthValue = mapSegmentValue(segment.parameterMappings.depth);
      const frequencyValue = mapSegmentValue(segment.parameterMappings.frequency);
      const delayTimeValue = mapSegmentValue(segment.parameterMappings.delayTime);
      const feedbackValue = mapSegmentValue(segment.parameterMappings.feedback);
      const wetValue = mapSegmentValue(segment.parameterMappings.wet);

      const applyIfChanged = (paramName, value) => {
        if (value == null) return;
        const minDelta = MIN_CHORUS_DELTA[paramName] ?? 0;
        const prev = discreteCache[paramName];
        if (Number.isFinite(prev) && Math.abs(value - prev) <= minDelta) return;
        discreteCache[paramName] = value;
        setToneValue(node, paramName, value);
      };

      if (depthValue != null) {
        const minDelta = MIN_CHORUS_DELTA.depth;
        const prev = discreteCache.depth;
        if (!Number.isFinite(prev) || Math.abs(depthValue - prev) > minDelta) {
          discreteCache.depth = depthValue;
          if (automationBridge?.ramp) {
            automationBridge.ramp(depthValue);
          } else {
            setToneValue(node, 'depth', depthValue);
          }
        }
      }

      applyIfChanged('frequency', frequencyValue);
      applyIfChanged('delayTime', delayTimeValue);
      applyIfChanged('feedback', feedbackValue);
      applyIfChanged('wet', wetValue);
    } catch (error) {
      console.warn('[ToneChorusEffect] Failed to apply value', error);
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
      // Start the Chorus LFO if available
      if (typeof node.start === 'function') {
        try { node.start(); } catch (_) {}
      }
      if (Number.isFinite(equilibriumValue)) {
        applyValue(equilibriumValue);
      }
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
    },
  };
}

export function createToneChorusEffect({ Tone, settings } = {}) {
  if (!Tone?.Chorus) {
    throw new Error('[ToneChorusEffect] Tone.Chorus constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.Chorus(...ctorArgs)
    : new Tone.Chorus(ctorArgs[0]);

  // Start the LFO immediately by default
  if (typeof node.start === 'function') {
    try { node.start(); } catch (_) {}
  }

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

export default createToneChorusEffect;
