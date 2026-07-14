import { EFFECT_MANIFEST } from './manifest.js';

const SEGMENT_KEYS = Object.freeze(['negative', 'positive']);

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

function getToneProperty(target, path) {
  if (!target || !path) return null;
  const { context, leaf } = resolvePath(target, path);
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
    const { context, leaf } = resolvePath(node, property);
    if (!context || !leaf) return;
    const prop = context[leaf];
    if (prop && typeof prop === 'object' && 'value' in prop) {
      prop.value = value;
    } else {
      context[leaf] = value;
    }
  });
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

    segments[key] = {
      id: segmentSpec?.id || key,
      label: segmentSpec?.label || (index === 0 ? 'Negative' : 'Positive'),
      description: segmentSpec?.description || moduleSpec.description,
      parameterMappings,
      control: mergedControl,
    };
  });

  return segments;
}

function mapParamValue(mapping, normalized) {
  if (!mapping) return null;
  const min = Number(mapping.min);
  const max = Number(mapping.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const amount = clamp01(normalized);
  const transform = mapping.transform || 'linear';
  let shaped = amount;
  switch (transform) {
    case 'easeIn':
      shaped = Math.pow(amount, 2);
      break;
    case 'easeOut':
      shaped = Math.sqrt(amount);
      break;
    case 'easeInOut':
      shaped = amount < 0.5 ? 2 * Math.pow(amount, 2) : 1 - Math.pow(-2 * amount + 2, 2) / 2;
      break;
    case 'linear':
    default:
      shaped = amount;
      break;
  }
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

function rampPan(param, value, control = {}) {
  if (!param) return;
  const rampTime = deriveRampTime(control);

  if (typeof param.rampTo === 'function') {
    param.rampTo(value, rampTime);
    return;
  }

  const audioParam = param._param || param;
  const context =
    audioParam?.context ||
    audioParam?._context ||
    audioParam?._param?.context ||
    null;

  if (context && typeof audioParam.cancelScheduledValues === 'function') {
    const now = context.currentTime;
    audioParam.cancelScheduledValues(now);
    if (typeof audioParam.linearRampToValueAtTime === 'function') {
      audioParam.linearRampToValueAtTime(value, now + rampTime);
      return;
    }
  }

  if ('value' in param) {
    param.value = value;
  }
}

function createModule({ node, manifest, moduleSpec }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: -100, max: 100 };
  const channelStrip = node._targetChannelStrip;
  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));
  const segments = buildSegments(moduleSpec);
  const targetPath = moduleSpec.control?.audioParam || moduleSpec.target || 'pan';
  let automationBridge = null;
  let lastValue = null;

  const resolvePanParam = () => {
    if (channelStrip?.pan) return channelStrip.pan;
    return getToneProperty(node, targetPath);
  };

  const applyPanValue = (value, segment) => {
    lastValue = value;
    if (automationBridge?.ramp) {
      automationBridge.ramp(value);
      return;
    }

    const panParam = resolvePanParam();
    if (panParam) {
      rampPan(panParam, value, segment?.control);
      return;
    }

    if (channelStrip && typeof channelStrip.set === 'function') {
      channelStrip.set({ pan: value });
    } else if (channelStrip) {
      channelStrip.pan = value;
    }
  };

  const applyValue = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const normalized = normalizeToRange(numeric, range);
    const { key: segmentKey, segmentNormalized } = selectSegment(normalized);
    const segment = segments[segmentKey];
    if (!segment) return;
    const mappedValue = mapParamValue(segment.parameterMappings?.pan, segmentNormalized);
    if (mappedValue == null) return;
    applyPanValue(mappedValue, segment);
  };

  const getTargetParam = () => resolvePanParam();

  const userParam = {
    id: manifest.userParamSpec?.id ?? manifest.inputParam,
    label: manifest.userParamSpec?.label ?? 'Pan',
    toneProperty: 'pan',
    tonePropertyTargets: ['pan'],
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
      if (automationBridge?.setImmediate && lastValue != null) {
        automationBridge.setImmediate(lastValue);
      }
    },
  };
}

export function createTonePannerEffect({ Tone, settings, channelStrip = null } = {}) {
  if (!Tone?.Gain) {
    throw new Error('[TonePannerEffect] Tone.Gain constructor is required.');
  }

  const node = new Tone.Gain(1);
  node._targetChannelStrip = channelStrip;

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

export default createTonePannerEffect;
