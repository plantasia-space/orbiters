import { EFFECT_MANIFEST } from './manifest.js';
import { PERFORMANCE_THROTTLE_MS } from '../../../../config/Constants.js';

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

function createModule({ node, manifest, moduleSpec }) {
  const valueRange = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: -100, max: 100 };
  
  // Extract segments from moduleSpec
  const segments = {};
  SEGMENT_KEYS.forEach((key) => {
    const segmentSpec = moduleSpec.segments?.[key];
    if (!segmentSpec) return;
    
    const parameterMappings = segmentSpec.parameterMappings || {};
    const paramNames = Object.keys(parameterMappings);
    const primaryParam = moduleSpec.control?.audioParam || paramNames[0];
    const secondaryParams = (moduleSpec.control?.secondaryParameters || [])
      .filter((param) => param && param !== primaryParam);

    segments[key] = {
      parameterMappings,
      primaryParam,
      secondaryParams,
    };
  });

  let automationBridge = null;
  let secondaryTimer = null;
  let secondaryInitialized = false;
  let pendingSecondaryState = null;
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
    return min + (max - min) * clamp01(normalized);
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

  const applySecondaryParams = (segmentKey, normalized, { force = false } = {}) => {
    const segment = segments[segmentKey];
    if (!segment || !segment.secondaryParams.length) return;

    segment.secondaryParams.forEach((paramName) => {
      const value = mapParamValue(segmentKey, paramName, normalized);
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
    }, PERFORMANCE_THROTTLE_MS);
  };

  const applyValue = (value, options = {}) => {
    const numeric = toNumber(value);
    if (numeric == null) return;

    try {
      const normalized = normalizeToRange(numeric, valueRange);
      const { key: segmentKey, segmentNormalized } = selectSegment(normalized);
      lastSegmentKey = segmentKey;
      lastSegmentNormalized = segmentNormalized;
      applyPrimaryParam(segmentKey, segmentNormalized);
      queueSecondaryUpdate(segmentKey, segmentNormalized, options.immediateSecondary === true);
    } catch (error) {
      console.warn('[ToneAutoPannerEffect] Failed to apply value', error);
    }
  };

  const primaryParam = segments.negative?.primaryParam || segments.positive?.primaryParam || 'depth';
  const getTargetParam = () => getToneProperty(node, primaryParam);

  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));


  return {
    id: moduleSpec.id,
    label: moduleSpec.label,
    description: moduleSpec.description,
    inputParam: manifest.inputParam,
    toneProperty: primaryParam,
    tonePropertyDescription: moduleSpec.description,
    valueRange,
    fixedParams,
    getTargetParam,
    applyValue,
    configure() {
      applyFixedParams(node, moduleSpec.fixed);
      // Ensure the AutoPanner LFO is running
      if (typeof node.start === 'function') {
        try { node.start(); } catch (_) {}
      }
      // Initialize secondary parameters
      if (segments[lastSegmentKey]?.secondaryParams.length) {
        queueSecondaryUpdate(lastSegmentKey, lastSegmentNormalized, true);
      }
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
    },
  };
}

export function createToneAutoPannerEffect({ Tone, settings } = {}) {
  if (!Tone?.AutoPanner) {
    throw new Error('[ToneAutoPannerEffect] Tone.AutoPanner constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.AutoPanner(...ctorArgs)
    : new Tone.AutoPanner(ctorArgs[0]);

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

export default createToneAutoPannerEffect;
