import { EFFECT_MANIFEST } from './manifest.js';
import { syncCoordinator } from '../../../../sync/SyncCoordinator.js';

const SEGMENT_KEYS = Object.freeze(['negative', 'positive']);
const SECONDARY_UPDATE_DELAY_MS = 90;
const MIN_DELAYTIME_DELTA = 0.002; // ~2ms guard against redundant heavy updates
const INIT_ONLY_PARAMS = new Set(['delayTime']);
const DEFAULT_SYNC_BPM = 120;
const NOTE_SECONDS = {
  '32n': 0.0625,
  '16n': 0.125,
  '8n': 0.25,
  '4n': 0.5,
  '2n': 1,
  '1n': 2,
};

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
    if (property === 'sync') return;
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

function resolveTimeSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (NOTE_SECONDS[value]) return NOTE_SECONDS[value];
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function scaleDelaySecondsForBpm(value, bpm) {
  const seconds = resolveTimeSeconds(value);
  if (!Number.isFinite(seconds)) return null;
  const resolvedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_SYNC_BPM;
  return seconds * (DEFAULT_SYNC_BPM / resolvedBpm);
}

function getCurrentSyncBpm() {
  const bpm = Number(syncCoordinator?.bpm);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_SYNC_BPM;
}

function resolveSegmentMappings(parameterMappings = {}) {
  return Object.entries(parameterMappings).reduce((acc, [param, rangeDef]) => {
    if (!rangeDef) return acc;
    const min =
      param === 'delayTime' ? resolveTimeSeconds(rangeDef.min) : Number(rangeDef.min);
    const max =
      param === 'delayTime' ? resolveTimeSeconds(rangeDef.max) : Number(rangeDef.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return acc;
    acc[param] = { min, max };
    return acc;
  }, {});
}

function buildSegments(moduleSpec = {}) {
  const hasSegments = moduleSpec.segments && SEGMENT_KEYS.some((key) => moduleSpec.segments[key]);
  const segments = {};
  SEGMENT_KEYS.forEach((key, index) => {
    const spec = hasSegments ? moduleSpec.segments[key] : null;
    segments[key] = {
      id: spec?.id || `segment-${key}`,
      label: spec?.label || (index === 0 ? 'Negative' : 'Positive'),
      description: spec?.description || moduleSpec.description,
      parameterMappings: resolveSegmentMappings(
        spec?.parameterMappings || moduleSpec.parameterMappings || {},
      ),
    };
  });
  return segments;
}

function selectSegment(normalized) {
  const clamped = clamp01(normalized);
  if (clamped < 0.5) {
    const segmentNormalized = clamped / 0.5;
    return {
      key: 'negative',
      segmentNormalized: Number.isFinite(segmentNormalized) ? segmentNormalized : 0,
    };
  }
  const segmentNormalized = (clamped - 0.5) / 0.5;
  return {
    key: 'positive',
    segmentNormalized: Number.isFinite(segmentNormalized) ? segmentNormalized : 0,
  };
}

function mapSegmentParamValue(segment, paramName, normalized) {
  if (!segment?.parameterMappings) return null;
  const mapping = segment.parameterMappings[paramName];
  if (!mapping) return null;
  const min = Number(mapping.min);
  const max = Number(mapping.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return min + (max - min) * clamp01(normalized);
}

function createModule({ Tone, node, manifest, moduleSpec, getCurrentBpm }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: 0, max: 100 };
  const segments = buildSegments(moduleSpec);
  const segmentParamNames = Array.from(
    new Set(
      SEGMENT_KEYS.flatMap((key) => Object.keys(segments[key]?.parameterMappings || {})),
    ),
  );
  const primaryParam =
    moduleSpec.control?.audioParam || moduleSpec.target || segmentParamNames[0];
  const secondaryParams = (moduleSpec.control?.secondaryParameters || []).filter(
    (param) => param && param !== primaryParam && segmentParamNames.includes(param),
  );
  const equilibriumValue = Number.isFinite(moduleSpec.initialRange?.equilibrium)
    ? moduleSpec.initialRange.equilibrium
    : (Number(range.min) + Number(range.max)) / 2;

  let automationBridge = null;
  let secondaryTimer = null;
  let pendingSecondaryState = null;
  let secondaryInitialized = false;
  let lastDelaySeconds = null;
  let lastSegmentSelection = { key: 'negative', normalized: 0 };
  let isActive = false;

  const getTargetParam = () => {
    const first = primaryParam || segmentParamNames[0];
    return first ? getToneProperty(node, first) : null;
  };

  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));

  const applyPrimaryParam = (segmentKey, normalized) => {
    if (!primaryParam) return;
    const mappedValue = mapSegmentParamValue(segments[segmentKey], primaryParam, normalized);
    if (mappedValue == null) return;
    if (automationBridge?.ramp) {
      automationBridge.ramp(mappedValue);
    } else {
      setToneValue(node, primaryParam, mappedValue);
    }
  };

  const applySecondaryParams = (segmentKey, normalized, { force = false } = {}) => {
    if (!secondaryParams.length) return;
    secondaryParams.forEach((paramName) => {
      const value = mapSegmentParamValue(segments[segmentKey], paramName, normalized);
      if (value == null) return;
      if (!force && secondaryInitialized && INIT_ONLY_PARAMS.has(paramName)) return;
      if (paramName === 'delayTime') {
        const scaledDelaySeconds = scaleDelaySecondsForBpm(value, getCurrentBpm());
        if (!Number.isFinite(scaledDelaySeconds)) return;
        if (
          lastDelaySeconds !== null &&
          Math.abs(scaledDelaySeconds - lastDelaySeconds) < MIN_DELAYTIME_DELTA
        ) {
          return;
        }
        lastDelaySeconds = scaledDelaySeconds;
        setToneValue(node, paramName, scaledDelaySeconds);
        return;
      }
      setToneValue(node, paramName, value);
    });
  };

  const queueSecondaryUpdate = (segmentKey, normalized, immediate = false) => {
    if (!secondaryParams.length) return;
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
      applySecondaryParams(pendingSecondaryState.segmentKey, pendingSecondaryState.normalized);
      pendingSecondaryState = null;
    }, SECONDARY_UPDATE_DELAY_MS);
  };

  const applyValue = (value, options = {}) => {
    const numeric = toNumber(value);
    if (numeric == null) return;

    try {
      const normalized = normalizeToRange(numeric, range);
      const { key: segmentKey, segmentNormalized } = selectSegment(normalized);
      lastSegmentSelection = { key: segmentKey, normalized: segmentNormalized };
      applyPrimaryParam(segmentKey, segmentNormalized);
      queueSecondaryUpdate(segmentKey, segmentNormalized, options.immediateSecondary === true);
    } catch (error) {
      console.warn('[ToneFeedbackDelayEffect] Failed to apply value', error);
    }
  };

  const userParam = {
    id: manifest.userParamSpec?.id ?? manifest.inputParam,
    label: manifest.userParamSpec?.label ?? 'Input',
    toneProperty: primaryParam || segmentParamNames.join(','),
    tonePropertyTargets: primaryParam ? [primaryParam] : segmentParamNames,
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
      if (moduleSpec.fixed?.sync && typeof node.sync === 'function') {
        try {
          node.sync();
        } catch (error) {
          console.warn('[ToneFeedbackDelayEffect] Failed to sync delay', error);
        }
      }
      if (Number.isFinite(equilibriumValue)) {
        applyValue(equilibriumValue, { immediateSecondary: true });
      } else {
        queueSecondaryUpdate(lastSegmentSelection.key, lastSegmentSelection.normalized, true);
      }
    },
    onBpmChange() {
      if (!isActive) return;
      lastDelaySeconds = null;
      queueSecondaryUpdate(lastSegmentSelection.key, lastSegmentSelection.normalized, true);
    },
    setIsActive(active) {
      isActive = active === true;
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
    },
  };
}

export function createToneFeedbackDelayEffect({ Tone, settings, deck = null } = {}) {
  if (!Tone?.FeedbackDelay) {
    throw new Error('[ToneFeedbackDelayEffect] Tone.FeedbackDelay constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.FeedbackDelay(...ctorArgs)
    : new Tone.FeedbackDelay(ctorArgs[0]);
  const bpmState = {
    current: getCurrentSyncBpm(),
  };

  const modules = EFFECT_MANIFEST.modules.map((moduleSpec) =>
    createModule({
      Tone,
      node,
      manifest: EFFECT_MANIFEST,
      moduleSpec,
      getCurrentBpm: () => bpmState.current,
    }),
  );
  let activeModuleId = modules[0]?.id ?? null;

  const handleDeckChange = (snapshot, reason) => {
    if (reason !== 'bpm') return;
    const bpm = Number(snapshot?.bpm);
    bpmState.current = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_SYNC_BPM;
    const activeModule = modules.find((module) => module.id === activeModuleId);
    activeModule?.onBpmChange?.();
  };

  // Live tempo arrives via this voice's DECK (its transport tempo — the master while synced, the
  // deck's own while unsynced, so beat-synced delay times match what the deck actually plays). The
  // construction-time seed (getCurrentSyncBpm above) still reads the conductor directly.
  const unsubBpm = deck ? deck.onChange(handleDeckChange) : null;

  modules.forEach((module) => module.setIsActive?.(module.id === activeModuleId));

  modules[0]?.configure?.();

  return {
    id: EFFECT_MANIFEST.id,
    label: EFFECT_MANIFEST.label,
    version: EFFECT_MANIFEST.version,
    inputParam: EFFECT_MANIFEST.inputParam,
    node,
    modules,
    configureModule(moduleId) {
      activeModuleId = moduleId;
      modules.forEach((module) => module.setIsActive?.(module.id === moduleId));
      const module = modules.find((item) => item.id === moduleId);
      module?.configure?.();
    },
    dispose() {
      unsubBpm?.();
      modules.splice(0, modules.length);
      if (typeof node.dispose === 'function') {
        node.dispose();
      }
    },
    manifest: EFFECT_MANIFEST,
  };
}

export default createToneFeedbackDelayEffect;
