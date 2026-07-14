import { EFFECT_MANIFEST } from './manifest.js';

const SEGMENT_KEYS = Object.freeze(['negative', 'positive']);
const MIN_POSITIVE = 1e-4;

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
  if (!path) return null;
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

function normalizeToRange(value, range = { min: 0, max: 1 }) {
  const min = Number(range?.min) ?? 0;
  const max = Number(range?.max) ?? 1;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return 0;
  return clamp01((value - min) / (max - min));
}

function selectSegment(normalized) {
  const clamped = clamp01(normalized);
  if (clamped <= 0.5) {
    const proportion = clamped / 0.5;
    return { key: 'negative', segmentNormalized: proportion };
  }
  const proportion = (clamped - 0.5) / 0.5;
  return { key: 'positive', segmentNormalized: proportion };
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
    const paramNames = Object.keys(parameterMappings || {});
    const primaryParam =
      mergedControl?.audioParam ||
      paramNames[0] ||
      moduleSpec.target ||
      null;

    segments[key] = {
      id: segmentSpec?.id || key,
      label: segmentSpec?.label || (index === 0 ? 'Negative' : 'Positive'),
      description: segmentSpec?.description || moduleSpec.description,
      parameterMappings,
      control: mergedControl,
      primaryParam,
      transform:
        mergedControl?.signalRange?.transform ||
        baseControl?.signalRange?.transform ||
        'linear',
      useSegmentNormalized: Boolean(segmentSpec?.parameterMappings),
    };
  });

  return segments;
}

function mapParamValue(range, normalized) {
  if (!range) return null;
  const min = Number(range.min);
  const max = Number(range.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return min + (max - min) * clamp01(normalized);
}

function clampForTransform(value, transform, signalRange = {}) {
  if (transform !== 'log') return value;
  const min = Number(signalRange.min);
  const floor = Number.isFinite(min) && min > 0 ? min : MIN_POSITIVE;
  if (!Number.isFinite(value) || value <= floor) {
    return floor;
  }
  return value;
}

function deriveRampTime(control = {}) {
  const smoothing = control.smoothing || {};
  let ramp = Number(smoothing.defaultRamp);
  if (!Number.isFinite(ramp) || ramp <= 0) {
    ramp = 0.05;
  }
  const minRamp = Number(smoothing.minRamp);
  const maxRamp = Number(smoothing.maxRamp);
  if (Number.isFinite(minRamp) && ramp < minRamp) {
    ramp = minRamp;
  }
  if (Number.isFinite(maxRamp) && ramp > maxRamp) {
    ramp = maxRamp;
  }
  return ramp;
}

function rampToneParam(node, paramName, value, segment) {
  if (!paramName) return;
  const target = clampForTransform(value, segment.transform, segment.control?.signalRange);
  const param = getToneProperty(node, paramName);
  if (!param) {
    setToneValue(node, paramName, target);
    return;
  }

  const rampTime = deriveRampTime(segment.control);

  if (typeof param.rampTo === 'function') {
    param.rampTo(target, rampTime);
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
    if (segment.transform === 'log' && typeof audioParam.exponentialRampToValueAtTime === 'function') {
      const safe = clampForTransform(target, segment.transform, segment.control?.signalRange);
      audioParam.setValueAtTime?.(safe, now);
      audioParam.exponentialRampToValueAtTime(safe, now + rampTime);
      return;
    }
    if (typeof audioParam.linearRampToValueAtTime === 'function') {
      audioParam.linearRampToValueAtTime(target, now + rampTime);
      return;
    }
  }

  if ('value' in param) {
    param.value = target;
    return;
  }

  setToneValue(node, paramName, target);
}

function applySecondaryParam(node, paramName, value) {
  if (!paramName) return;
  const param = getToneProperty(node, paramName);
  if (param && typeof param.rampTo === 'function') {
    param.rampTo(value, 0.05);
    return;
  }
  setToneValue(node, paramName, value);
}

function createModule({ node, manifest, moduleSpec }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: 0, max: 1 };
  const segments = buildSegments(moduleSpec);
  const toneTargets = new Set();

  SEGMENT_KEYS.forEach((key) => {
    const segment = segments[key];
    if (!segment) return;
    Object.keys(segment.parameterMappings || {}).forEach((param) => {
      toneTargets.add(param);
    });
  });

  const defaultTarget = moduleSpec.control?.audioParam || toneTargets.values().next().value || null;
  const getTargetParam = () => getToneProperty(node, defaultTarget);

  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));

  let automationBridge = null;
  let lastPrimaryValue = null;

  const applyValue = (value) => {
    const numeric = toNumber(value);
    if (numeric == null) return;

    try {
      const normalized = normalizeToRange(numeric, range);
      const { key: segmentKey, segmentNormalized } = selectSegment(normalized);
      const segment = segments[segmentKey];
      if (!segment || !segment.parameterMappings) return;
      const drive = segment.useSegmentNormalized ? segmentNormalized : normalized;

      Object.entries(segment.parameterMappings).forEach(([paramName, paramRange]) => {
        const mappedValue = mapParamValue(paramRange, drive);
        if (mappedValue == null) return;
        if (segment.primaryParam && paramName === segment.primaryParam) {
          lastPrimaryValue = mappedValue;
          if (automationBridge?.ramp) {
            const safe = clampForTransform(
              mappedValue,
              segment.transform,
              segment.control?.signalRange,
            );
            automationBridge.ramp(safe);
          } else {
            rampToneParam(node, paramName, mappedValue, segment);
          }
        } else {
          applySecondaryParam(node, paramName, mappedValue);
        }
      });
    } catch (error) {
      console.warn('[ToneBiquadFilterEffect] Failed to apply value', error);
    }
  };

  const userParam = {
    id: manifest.userParamSpec?.id ?? manifest.inputParam,
    label: manifest.userParamSpec?.label ?? 'Input',
    toneProperty: Array.from(toneTargets).join(',') || defaultTarget || '',
    tonePropertyTargets: toneTargets.size
      ? Array.from(toneTargets)
      : defaultTarget
        ? [defaultTarget]
        : [],
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
      if (automationBridge?.setImmediate && lastPrimaryValue != null) {
        const segment = segments.positive || segments.negative;
        const safe = clampForTransform(
          lastPrimaryValue,
          segment?.transform || 'linear',
          segment?.control?.signalRange,
        );
        automationBridge.setImmediate(safe);
      }
    },
  };
}

export function createToneBiquadFilterEffect({ Tone, settings } = {}) {
  if (!Tone?.BiquadFilter) {
    throw new Error('[ToneBiquadFilterEffect] Tone.BiquadFilter constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.BiquadFilter(...ctorArgs)
    : new Tone.BiquadFilter(ctorArgs[0]);

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

export default createToneBiquadFilterEffect;
