import { EFFECT_MANIFEST } from './manifest.js';

const LIVE_COMMIT_SETTLE_DELAY_MS = 180;
const MIN_DECAY_DELTA = 0.05;
const MIN_PREDELAY_DELTA = 0.001;
const SEGMENT_KEYS = Object.freeze(['negative', 'positive']);
const LIVE_UPDATE_INTENT = 'live';
const COMMIT_UPDATE_INTENT = 'commit';
const LIVE_PARAMS = Object.freeze(['wet']);
const COMMIT_ONLY_PARAMS = Object.freeze(['decay', 'preDelay']);
const LIGHTWEIGHT_ROOMSIZE_RANGES = Object.freeze({
  small: Object.freeze({ min: 0.12, max: 0.42 }),
  mid: Object.freeze({ min: 0.28, max: 0.7 }),
  large: Object.freeze({ min: 0.52, max: 0.92 }),
});

function normalizeUpdateIntent(value) {
  return value === COMMIT_UPDATE_INTENT ? COMMIT_UPDATE_INTENT : LIVE_UPDATE_INTENT;
}

function collectParamExtents(segments = {}, paramName) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  SEGMENT_KEYS.forEach((segmentKey) => {
    const mapping = segments?.[segmentKey]?.parameterMappings?.[paramName];
    const segmentMin = Number(mapping?.min);
    const segmentMax = Number(mapping?.max);
    if (Number.isFinite(segmentMin)) min = Math.min(min, segmentMin);
    if (Number.isFinite(segmentMax)) max = Math.max(max, segmentMax);
  });
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return null;
  }
  return { min, max };
}

function normalizeWithinExtents(value, extents) {
  if (!extents || !Number.isFinite(value)) return null;
  const span = extents.max - extents.min;
  if (!Number.isFinite(span) || span <= 0) return null;
  return clamp01((value - extents.min) / span);
}

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
    const primaryParam = mergedControl?.audioParam || paramNames[0] || null;
    const rawSecondary = mergedControl?.secondaryParameters || [];
    const secondaryParams = rawSecondary
      .filter((param) => param && param !== primaryParam);

    segments[key] = {
      id: segmentSpec?.id || key,
      label: segmentSpec?.label || (index === 0 ? 'Negative' : 'Positive'),
      description: segmentSpec?.description || moduleSpec.description,
      parameterMappings,
      control: mergedControl,
      primaryParam,
      secondaryParams,
      transform:
        mergedControl?.signalRange?.transform ||
        baseControl?.signalRange?.transform ||
        'linear',
    };
  });

  return segments;
}

function createModule({ node, manifest, moduleSpec }) {
  const valueRange = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: 0, max: 100 };
  const segments = buildSegments(moduleSpec);
  const decayExtents = collectParamExtents(segments, 'decay');
  const preDelayExtents = collectParamExtents(segments, 'preDelay');
  const lightweightRoomSizeRange =
    LIGHTWEIGHT_ROOMSIZE_RANGES[moduleSpec.id] || LIGHTWEIGHT_ROOMSIZE_RANGES.mid;
  const tonePrimaryTargets = new Set();
  const toneMappedParams = new Set();

  SEGMENT_KEYS.forEach((key) => {
    const segment = segments[key];
    if (!segment) return;
    if (segment.primaryParam) tonePrimaryTargets.add(segment.primaryParam);
    Object.keys(segment.parameterMappings || {}).forEach((param) => toneMappedParams.add(param));
  });

  const tonePropertyTargets = tonePrimaryTargets.size
    ? Array.from(tonePrimaryTargets)
    : Array.from(toneMappedParams);
  const toneProperty = tonePropertyTargets.join(',') || '';

  let automationBridge = null;
  let commitTimer = null;
  let pendingCommitState = null;
  let lastSegmentKey = 'negative';
  let lastSegmentNormalized = 0;
  const discreteCache = {};

  const mapParamValue = (segmentKey, paramName, normalized) => {
    const segment = segments[segmentKey];
    if (!segment) return null;
    const paramRange = segment.parameterMappings?.[paramName];
    if (!paramRange) return null;
    const min = Number(paramRange.min);
    const max = Number(paramRange.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    let mapped = min + (max - min) * clamp01(normalized);
    if (paramName === 'wet') {
      return clamp01(mapped);
    }
    return mapped;
  };

  const applyPrimaryParam = (segmentKey, normalized) => {
    const segment = segments[segmentKey];
    if (!segment || !segment.primaryParam) return;
    const mappedValue = mapParamValue(segmentKey, segment.primaryParam, normalized);
    if (mappedValue == null) return;
    if (automationBridge?.ramp) {
      automationBridge.ramp(mappedValue);
    } else {
      setToneValue(node, segment.primaryParam, mappedValue);
    }
  };

  const applySecondaryParams = (
    segmentKey,
    normalized,
    { force = false, updateIntent = LIVE_UPDATE_INTENT } = {},
  ) => {
    const segment = segments[segmentKey];
    if (!segment || !segment.secondaryParams.length) return;
    const intent = normalizeUpdateIntent(updateIntent);

    let lightweightRoomSize = null;

    segment.secondaryParams.forEach((paramName) => {
      if (intent !== COMMIT_UPDATE_INTENT && COMMIT_ONLY_PARAMS.includes(paramName)) return;
      const value = mapParamValue(segmentKey, paramName, normalized);
      if (value == null) return;
      if (paramName === 'decay') {
        const decayNormalized = normalizeWithinExtents(value, decayExtents);
        if (Number.isFinite(decayNormalized)) {
          const current = Number.isFinite(lightweightRoomSize) ? lightweightRoomSize : 0;
          lightweightRoomSize = current + (decayNormalized * 0.75);
        }
        return;
      }
      if (paramName === 'preDelay') {
        const preDelayNormalized = normalizeWithinExtents(value, preDelayExtents);
        if (Number.isFinite(preDelayNormalized)) {
          const current = Number.isFinite(lightweightRoomSize) ? lightweightRoomSize : 0;
          lightweightRoomSize = current + (preDelayNormalized * 0.25);
        }
        return;
      }
      const minDelta =
        paramName === 'decay'
          ? MIN_DECAY_DELTA
          : paramName === 'preDelay'
            ? MIN_PREDELAY_DELTA
            : 0;
      if (
        !force &&
        minDelta > 0 &&
        Number.isFinite(discreteCache[paramName]) &&
        Math.abs(value - discreteCache[paramName]) < minDelta
      ) {
        return;
      }
      if (!force && discreteCache[paramName] === value) return;
      discreteCache[paramName] = value;
      setToneValue(node, paramName, value);
    });

    if (Number.isFinite(lightweightRoomSize)) {
      const normalizedRoomSize = clamp01(lightweightRoomSize);
      const roomSize =
        lightweightRoomSizeRange.min +
        (lightweightRoomSizeRange.max - lightweightRoomSizeRange.min) * normalizedRoomSize;
      if (force || discreteCache.roomSize !== roomSize) {
        discreteCache.roomSize = roomSize;
        setToneValue(node, 'roomSize', roomSize);
      }
      return;
    }
  };

  const queueCommitOnlyUpdate = (segmentKey, normalized, immediate = false) => {
    const segment = segments[segmentKey];
    if (!segment || !segment.secondaryParams.length) return;
    pendingCommitState = { segmentKey, normalized };

    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }

    if (immediate) {
      applySecondaryParams(segmentKey, normalized, {
        force: true,
        updateIntent: COMMIT_UPDATE_INTENT,
      });
      pendingCommitState = null;
      return;
    }

    commitTimer = setTimeout(() => {
      commitTimer = null;
      if (!pendingCommitState) return;
      applySecondaryParams(pendingCommitState.segmentKey, pendingCommitState.normalized, {
        force: true,
        updateIntent: COMMIT_UPDATE_INTENT,
      });
      pendingCommitState = null;
    }, LIVE_COMMIT_SETTLE_DELAY_MS);
  };

  const applyValue = (value, options = {}) => {
    const numeric = toNumber(value);
    if (numeric == null) return;

    try {
      const normalized = normalizeToRange(numeric, valueRange);
      const { key: segmentKey, segmentNormalized } = selectSegment(normalized);
      lastSegmentKey = segmentKey;
      lastSegmentNormalized = segmentNormalized;
      const updateIntent = normalizeUpdateIntent(options?.updateIntent);
      applyPrimaryParam(segmentKey, segmentNormalized);
      if (updateIntent === COMMIT_UPDATE_INTENT) {
        queueCommitOnlyUpdate(segmentKey, segmentNormalized, true);
      } else {
        queueCommitOnlyUpdate(segmentKey, segmentNormalized, false);
      }
    } catch (error) {
      console.warn('[ToneReverbEffect] Failed to apply value', error);
    }
  };

  const primaryTargetParam =
    tonePropertyTargets.length > 0 ? tonePropertyTargets[0] : null;
  const getTargetParam = () =>
    primaryTargetParam ? getToneProperty(node, primaryTargetParam) : null;

  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));


  return {
    id: moduleSpec.id,
    label: moduleSpec.label,
    description: moduleSpec.description,
    inputParam: manifest.inputParam,
    toneProperty,
    tonePropertyDescription: moduleSpec.description,
    valueRange,
    fixedParams,
    updatePolicy: {
      liveParams: [...LIVE_PARAMS],
      commitOnlyParams: [...COMMIT_ONLY_PARAMS],
    },
    getTargetParam,
    applyValue,
    configure() {
      applyFixedParams(node, moduleSpec.fixed);
      if (segments[lastSegmentKey]?.secondaryParams.length) {
        applySecondaryParams(lastSegmentKey, lastSegmentNormalized, {
          force: true,
          updateIntent: COMMIT_UPDATE_INTENT,
        });
      }
    },
    refreshQuality({ immediate = false } = {}) {
      queueCommitOnlyUpdate(lastSegmentKey, lastSegmentNormalized, immediate);
    },
    dispose() {
      if (commitTimer) {
        clearTimeout(commitTimer);
        commitTimer = null;
      }
      pendingCommitState = null;
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
    },
  };
}

export function createToneReverbEffect({ Tone, settings } = {}) {
  if (!Tone?.JCReverb) {
    throw new Error('[ToneReverbEffect] Tone.JCReverb constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];
  const ctorSettings = isSettingsArray ? ctorArgs[0] : ctorArgs[0];
  const node = new Tone.JCReverb({
    roomSize: 0.45,
    wet: Number.isFinite(Number(ctorSettings?.wet)) ? Number(ctorSettings.wet) : EFFECT_MANIFEST.defaults.wet,
  });

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
      modules.forEach((module) => module?.dispose?.());
      modules.splice(0, modules.length);
      if (typeof node.dispose === 'function') {
        node.dispose();
      }
    },
    manifest: EFFECT_MANIFEST,
  };
}

export default createToneReverbEffect;
