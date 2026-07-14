import { EFFECT_MANIFEST } from './manifest.js';

const SEGMENT_KEYS = Object.freeze(['negative', 'positive']);
const SECONDARY_UPDATE_DELAY_MS = 75;

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
  if (!node || !path) return null;
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeToRange(value, range = { min: 0, max: 1 }) {
  const min = Number(range?.min) ?? 0;
  const max = Number(range?.max) ?? 1;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return 0;
  return clamp01((value - min) / (max - min));
}

function selectSegment(normalized) {
  const clamped = clamp01(normalized);
  if (clamped < 0.5) {
    return { key: 'negative', segmentNormalized: clamped / 0.5 };
  }
  return { key: 'positive', segmentNormalized: (clamped - 0.5) / 0.5 };
}

function transformNormalized(value, transform) {
  const n = clamp01(value);
  switch (transform) {
    case 'easeIn':
      return Math.pow(n, 2);
    case 'easeOut':
      return Math.sqrt(n);
    case 'easeInOut':
      return n < 0.5 ? 2 * Math.pow(n, 2) : 1 - Math.pow(-2 * n + 2, 2) / 2;
    case 'pow2':
      return Math.pow(n, 2);
    case 'sqrt':
      return Math.sqrt(n);
    case 'linear':
    default:
      return n;
  }
}

function mergeControls(base = {}, override = {}) {
  if (!base && !override) return {};
  return {
    ...base,
    ...override,
    smoothing: {
      ...(base?.smoothing || {}),
      ...(override?.smoothing || {}),
    },
    signalRange: {
      ...(base?.signalRange || {}),
      ...(override?.signalRange || {}),
    },
    secondaryParameters: override?.secondaryParameters || base?.secondaryParameters || [],
  };
}

function buildSegments(moduleSpec = {}) {
  const hasCustomSegments =
    moduleSpec.segments && SEGMENT_KEYS.some((key) => moduleSpec.segments[key]);
  const baseMappings = moduleSpec.parameterMappings || {};
  const baseControl = moduleSpec.control || {};
  const segments = {};

  SEGMENT_KEYS.forEach((key, index) => {
    const segmentSpec = hasCustomSegments ? moduleSpec.segments[key] : null;
    const parameterMappings = segmentSpec?.parameterMappings || baseMappings;
    const mergedControl = mergeControls(baseControl, segmentSpec?.control);
    const secondaryParams = (mergedControl.secondaryParameters || []).filter(Boolean);

    segments[key] = {
      id: segmentSpec?.id || key,
      label: segmentSpec?.label || (index === 0 ? 'Negative' : 'Positive'),
      description: segmentSpec?.description || moduleSpec.description,
      parameterMappings,
      control: mergedControl,
      secondaryParams,
    };
  });

  return segments;
}

function mapParamValue(segment, paramName, normalized) {
  if (!segment?.parameterMappings) return null;
  const mapping = segment.parameterMappings[paramName];
  if (!mapping) return null;
  const min = Number(mapping.min);
  const max = Number(mapping.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const transform = mapping.transform || segment.control?.signalRange?.transform || 'linear';
  const shaped = transformNormalized(normalized, transform);
  return min + (max - min) * shaped;
}

function deriveRampTime(control = {}) {
  const smoothing = control.smoothing || {};
  let ramp = Number(smoothing.defaultRamp);
  if (!Number.isFinite(ramp) || ramp <= 0) ramp = 0.05;
  const minRamp = Number(smoothing.minRamp);
  const maxRamp = Number(smoothing.maxRamp);
  if (Number.isFinite(minRamp) && ramp < minRamp) ramp = minRamp;
  if (Number.isFinite(maxRamp) && ramp > maxRamp) ramp = maxRamp;
  return ramp;
}

function createModule({ node, manifest, moduleSpec }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: -100, max: 100 };
  const segments = buildSegments(moduleSpec);
  const primaryParam = moduleSpec.control?.audioParam || moduleSpec.target || 'roomSize';
  let automationBridge = null;
  let lastPrimaryValue = null;
  let secondaryTimer = null;
  let secondaryInitialized = false;
  let pendingSecondaryState = null;
  const discreteCache = Object.create(null);

  const getTargetParam = () => getToneProperty(node, primaryParam);

  const applyPrimaryParam = (segmentKey, normalized) => {
    const segment = segments[segmentKey];
    if (!segment) return;
    const mapped = mapParamValue(segment, primaryParam, normalized);
    if (mapped == null) return;
    lastPrimaryValue = mapped;
    if (automationBridge?.ramp) {
      automationBridge.ramp(mapped);
      return;
    }
    const target = getTargetParam();
    if (target && typeof target.rampTo === 'function') {
      target.rampTo(mapped, deriveRampTime(segment.control));
    } else if (target && typeof target === 'object' && 'value' in target) {
      target.value = mapped;
    } else {
      setToneValue(node, primaryParam, mapped);
    }
  };

  const applySecondaryParams = (segmentKey, normalized, { force = false } = {}) => {
    const segment = segments[segmentKey];
    if (!segment?.secondaryParams?.length) return;
    segment.secondaryParams.forEach((paramName) => {
      const value = mapParamValue(segment, paramName, normalized);
      if (value == null) return;
      if (!force && discreteCache[paramName] === value) return;
      discreteCache[paramName] = value;
      setToneValue(node, paramName, value);
    });
  };

  const queueSecondaryUpdate = (segmentKey, normalized, immediate = false) => {
    const segment = segments[segmentKey];
    if (!segment?.secondaryParams?.length) return;
    pendingSecondaryState = { segmentKey, normalized };

    if (immediate || !secondaryInitialized) {
      secondaryInitialized = true;
      if (secondaryTimer) {
        clearTimeout(secondaryTimer);
        secondaryTimer = null;
      }
      applySecondaryParams(segmentKey, normalized, { force: true });
      pendingSecondaryState = null;
      return;
    }

    if (secondaryTimer) return;
    secondaryTimer = setTimeout(() => {
      secondaryTimer = null;
      if (!pendingSecondaryState) return;
      applySecondaryParams(
        pendingSecondaryState.segmentKey,
        pendingSecondaryState.normalized,
      );
      pendingSecondaryState = null;
    }, SECONDARY_UPDATE_DELAY_MS);
  };

  const applyValue = (value, options = {}) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const normalized = normalizeToRange(numeric, range);
    const { key: segmentKey, segmentNormalized } = selectSegment(normalized);
    applyPrimaryParam(segmentKey, segmentNormalized);
    queueSecondaryUpdate(segmentKey, segmentNormalized, options.immediateSecondary === true);
  };

  const userParam = {
    id: manifest.userParamSpec?.id ?? manifest.inputParam,
    label: manifest.userParamSpec?.label ?? 'Temple',
    toneProperty: primaryParam,
    tonePropertyTargets: [primaryParam],
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
    fixedParams: Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
      property,
      value,
    })),
    getTargetParam,
    applyValue,
    configure() {
      applyFixedParams(node, moduleSpec.fixed);
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
      if (automationBridge?.setImmediate && lastPrimaryValue != null) {
        automationBridge.setImmediate(lastPrimaryValue);
      }
    },
  };
}

export function createToneJCReverbEffect({ Tone, settings } = {}) {
  if (!Tone?.JCReverb) {
    throw new Error('[ToneJCReverbEffect] Tone.JCReverb constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.JCReverb(...ctorArgs)
    : new Tone.JCReverb(ctorArgs[0]);

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

export default createToneJCReverbEffect;
