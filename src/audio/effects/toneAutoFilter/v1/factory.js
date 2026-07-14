import { EFFECT_MANIFEST } from './manifest.js';

const SEGMENT_KEYS = Object.freeze(['negative', 'positive']);
const SECONDARY_UPDATE_DELAY_MS = 75;
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

function selectSegment(normalized, splitPoint) {
  const clamped = clamp01(normalized);
  if (typeof splitPoint !== 'number') {
    if (clamped <= 0.5) {
      return { key: 'negative', segmentNormalized: clamped / 0.5 };
    }
    return { key: 'positive', segmentNormalized: (clamped - 0.5) / 0.5 };
  }

  const split = clamp01(splitPoint);
  if (split === 0) {
    return { key: 'positive', segmentNormalized: clamped };
  }
  if (split === 1) {
    return { key: 'negative', segmentNormalized: 1 - clamped };
  }
  if (clamped < split) {
    return {
      key: 'negative',
      segmentNormalized: (split - clamped) / split,
    };
  }
  return {
    key: 'positive',
    segmentNormalized: (clamped - split) / (1 - split),
  };
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
    const paramNames = Object.keys(parameterMappings || {});
    const primaryParam =
      mergedControl?.audioParam ||
      paramNames[0] ||
      moduleSpec.target ||
      null;
    const rawSecondary = mergedControl?.secondaryParameters || [];
    const secondaryParams = rawSecondary.filter(
      (param) => param && param !== primaryParam,
    );

    const primaryRange = parameterMappings?.[primaryParam] || null;
    const primaryTransform =
      primaryRange?.transform ||
      mergedControl?.signalRange?.transform ||
      'linear';

    segments[key] = {
      id: segmentSpec?.id || key,
      label: segmentSpec?.label || (index === 0 ? 'Negative' : 'Positive'),
      description: segmentSpec?.description || moduleSpec.description,
      parameterMappings,
      control: mergedControl,
      primaryParam,
      primaryTransform,
      primaryRange,
      secondaryParams,
      transform:
        mergedControl?.signalRange?.transform ||
        baseControl?.signalRange?.transform ||
        'linear',
      useSegmentNormalized: Boolean(segmentSpec?.parameterMappings),
    };
  });

  return segments;
}

function interpolateRangeValue(paramRange, normalized) {
  const min = Number(paramRange.min);
  const max = Number(paramRange.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const curve = paramRange.transform || 'linear';
  const amount = clamp01(normalized);
  if (curve === 'log') {
    const safeStart = min > 0 ? min : MIN_POSITIVE;
    const safeEnd = max > 0 ? max : MIN_POSITIVE;
    const logStart = Math.log(safeStart);
    const logEnd = Math.log(safeEnd);
    const value = Math.exp(logStart + (logEnd - logStart) * amount);
    return Number.isFinite(value) ? value : safeEnd;
  }
  return min + (max - min) * amount;
}

function mapParamValue(segment, paramName, normalized) {
  if (!segment?.parameterMappings) return null;
  const paramRange = segment.parameterMappings[paramName];
  if (!paramRange) return null;
  return interpolateRangeValue(paramRange, normalized);
}

function clampForTransform(value, transform, range = {}) {
  if (transform !== 'log') return value;
  const min = Number(range.min);
  const max = Number(range.max);
  const positives = [];
  if (Number.isFinite(min) && min > 0) positives.push(min);
  if (Number.isFinite(max) && max > 0) positives.push(max);
  const floor = positives.length ? Math.min(...positives) : MIN_POSITIVE;
  if (!Number.isFinite(value) || value < floor) return floor;
  return value;
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

function rampToneParam(
  node,
  paramName,
  value,
  transform = 'linear',
  range = {},
  control = {},
) {
  if (!paramName) return;
  const target = clampForTransform(
    value,
    transform,
    range,
  );
  const param = getToneProperty(node, paramName);
  if (!param || typeof param !== 'object') {
    setToneValue(node, paramName, target);
    return;
  }
  const rampTime = deriveRampTime(control);

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
    if (
      transform === 'log' &&
      typeof audioParam.exponentialRampToValueAtTime === 'function'
    ) {
      const safe = clampForTransform(
        target,
        transform,
        range,
      );
      if (typeof audioParam.setValueAtTime === 'function') {
        audioParam.setValueAtTime(safe, now);
      }
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

function createModule({ node, manifest, moduleSpec }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: 0, max: 100 };
  const segments = buildSegments(moduleSpec);
  const toneTargets = new Set();

  SEGMENT_KEYS.forEach((key) => {
    const segment = segments[key];
    if (!segment) return;
    Object.keys(segment.parameterMappings || {}).forEach((param) => {
      toneTargets.add(param);
    });
  });

  const defaultTarget =
    moduleSpec.control?.audioParam ||
    toneTargets.values().next().value ||
    null;
  const getTargetParam = () => getToneProperty(node, defaultTarget);

  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));

  let automationBridge = null;
  let secondaryTimer = null;
  let secondaryInitialized = false;
  let pendingSecondaryState = null;
  const discreteCache = Object.create(null);
  let lastPrimaryValue = null;
  let lastSegmentKey = 'negative';
  let lastSegmentNormalized = 0;

  const applyPrimaryParam = (segment, normalized) => {
    if (!segment?.primaryParam) return;
    const mappedValue = mapParamValue(segment, segment.primaryParam, normalized);
    if (mappedValue == null) return;
    const clampRange = segment.primaryRange || segment.control?.signalRange || {};
    if (automationBridge?.ramp) {
      const safe = clampForTransform(
        mappedValue,
        segment.primaryTransform,
        clampRange,
      );
      automationBridge.ramp(safe);
    } else {
      rampToneParam(
        node,
        segment.primaryParam,
        mappedValue,
        segment.primaryTransform,
        clampRange,
        segment.control,
      );
    }
    lastPrimaryValue = mappedValue;
  };

  const applySecondaryParams = (segmentKey, normalized, { force = false } = {}) => {
    const segment = segments[segmentKey];
    if (!segment || !segment.secondaryParams.length) return;
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
    if (!segment || !segment.secondaryParams.length) return;
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
    const numeric = toNumber(value);
    if (numeric == null) return;
    try {
      const normalized = normalizeToRange(numeric, range);
      const { key: segmentKey, segmentNormalized } = selectSegment(normalized);
      const segment = segments[segmentKey];
      if (!segment) return;
      const drive = segment.useSegmentNormalized ? segmentNormalized : normalized;
      lastSegmentKey = segmentKey;
      lastSegmentNormalized = drive;
      applyPrimaryParam(segment, drive);
      queueSecondaryUpdate(segmentKey, drive, options.immediateSecondary === true);
    } catch (error) {
      console.warn('[ToneAutoFilterEffect] Failed to apply value', error);
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
      if (
        typeof node.start === 'function' &&
        (node.state !== 'started' && !node._ewAutoFilterStarted)
      ) {
        try {
          node.start();
          node._ewAutoFilterStarted = true;
        } catch (error) {
          console.warn('[ToneAutoFilterEffect] Failed to start LFO', error);
        }
      }
      if (lastSegmentKey) {
        queueSecondaryUpdate(lastSegmentKey, lastSegmentNormalized, true);
      }
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
      if (automationBridge?.setImmediate && lastPrimaryValue != null) {
        const segment = segments[lastSegmentKey] || segments.positive || segments.negative;
        const safe = clampForTransform(
          lastPrimaryValue,
          segment?.primaryTransform || 'linear',
          segment?.primaryRange || segment?.control?.signalRange || {},
        );
        automationBridge.setImmediate(safe);
      }
    },
  };
}

export function createToneAutoFilterEffect({ Tone, settings } = {}) {
  if (!Tone?.AutoFilter) {
    throw new Error('[ToneAutoFilterEffect] Tone.AutoFilter constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.AutoFilter(...ctorArgs)
    : new Tone.AutoFilter(ctorArgs[0]);

  if (typeof node.start === 'function') {
    try {
      node.start();
      node._ewAutoFilterStarted = true;
    } catch (error) {
      console.warn('[ToneAutoFilterEffect] Failed to start AutoFilter', error);
    }
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

export default createToneAutoFilterEffect;
