import { EFFECT_MANIFEST } from './manifest.js';
import { syncCoordinator } from '../../../../sync/SyncCoordinator.js';

const SECONDARY_UPDATE_DELAY_MS = 90;
const MIN_FEEDBACK_DELTA = 0.003;
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
    if (property === 'delayTime' && typeof value === 'string' && NOTE_SECONDS[value]) return;
    setToneValue(node, property, value);
  });
}

function getCurrentSyncBpm() {
  const bpm = Number(syncCoordinator?.bpm);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_SYNC_BPM;
}

function resolveSyncedDelaySeconds(notation, bpm) {
  const noteSeconds = NOTE_SECONDS[notation];
  if (!Number.isFinite(noteSeconds)) return null;
  const resolvedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_SYNC_BPM;
  return noteSeconds * (DEFAULT_SYNC_BPM / resolvedBpm);
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

function mapParamValue(paramRange, normalized) {
  if (!paramRange) return null;
  const min = Number(paramRange.min);
  const max = Number(paramRange.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return min + (max - min) * clamp01(normalized);
}

function createModule({ node, manifest, moduleSpec, getCurrentBpm }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || { min: 0, max: 100 };
  const parameterMappings = moduleSpec.parameterMappings || {};
  const mappedParameters = Object.keys(parameterMappings);
  const primaryParam = moduleSpec.control?.audioParam || mappedParameters[0] || null;
  const secondaryParams = (moduleSpec.control?.secondaryParameters || []).filter(
    (param) => param && param !== primaryParam && mappedParameters.includes(param),
  );
  const equilibriumValue = Number.isFinite(moduleSpec.initialRange?.equilibrium)
    ? moduleSpec.initialRange.equilibrium
    : (Number(range.min) + Number(range.max)) / 2;

  let automationBridge = null;
  let secondaryTimer = null;
  let pendingSecondaryNormalized = null;
  let secondaryInitialized = false;
  const discreteCache = Object.create(null);
  let isActive = false;
  const delayNotation =
    typeof moduleSpec.fixed?.delayTime === 'string' && NOTE_SECONDS[moduleSpec.fixed.delayTime]
      ? moduleSpec.fixed.delayTime
      : (NOTE_SECONDS[moduleSpec.id] ? moduleSpec.id : null);

  const getTargetParam = () => {
    const first = primaryParam || mappedParameters[0];
    return first ? getToneProperty(node, first) : null;
  };

  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));

  const applySyncedDelayTime = () => {
    if (!delayNotation) return;
    const delaySeconds = resolveSyncedDelaySeconds(delayNotation, getCurrentBpm());
    if (!Number.isFinite(delaySeconds)) return;
    setToneValue(node, 'delayTime', delaySeconds);
  };

  const applyMappedParam = (paramName, normalized, { force = false } = {}) => {
    const mappedValue = mapParamValue(parameterMappings[paramName], normalized);
    if (mappedValue == null) return;
    const minDelta = paramName === 'feedback' ? MIN_FEEDBACK_DELTA : 0;
    const previous = discreteCache[paramName];
    if (
      !force &&
      Number.isFinite(previous) &&
      (Math.abs(mappedValue - previous) <= minDelta || mappedValue === previous)
    ) {
      return;
    }
    discreteCache[paramName] = mappedValue;

    if (automationBridge?.ramp && primaryParam && paramName === primaryParam) {
      automationBridge.ramp(mappedValue);
    } else {
      setToneValue(node, paramName, mappedValue);
    }
  };

  const applyPrimaryParam = (normalized) => {
    if (!primaryParam) return;
    applyMappedParam(primaryParam, normalized);
  };

  const applySecondaryParams = (normalized, { force = false } = {}) => {
    if (!secondaryParams.length) return;
    secondaryParams.forEach((paramName) => {
      applyMappedParam(paramName, normalized, { force });
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
      applySecondaryParams(normalized, { force: true });
      pendingSecondaryNormalized = null;
      return;
    }

    if (secondaryTimer) return;
    secondaryTimer = setTimeout(() => {
      secondaryTimer = null;
      if (!Number.isFinite(pendingSecondaryNormalized)) return;
      applySecondaryParams(pendingSecondaryNormalized);
      pendingSecondaryNormalized = null;
    }, SECONDARY_UPDATE_DELAY_MS);
  };

  const applyValue = (value, options = {}) => {
    const numeric = toNumber(value);
    if (numeric == null) return;

    try {
      const normalized = normalizeToRange(numeric, range);
      applyPrimaryParam(normalized);
      queueSecondaryUpdate(normalized, options.immediateSecondary === true);
    } catch (error) {
      console.warn('[TonePingPongDelayEffect] Failed to apply value', error);
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
      applySyncedDelayTime();
      if (Number.isFinite(equilibriumValue)) {
        applyValue(equilibriumValue, { immediateSecondary: true });
      }
    },
    onBpmChange() {
      if (!isActive) return;
      applySyncedDelayTime();
    },
    setIsActive(active) {
      isActive = active === true;
      if (isActive) {
        applySyncedDelayTime();
      }
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
    },
  };
}

export function createTonePingPongDelayEffect({ Tone, settings, deck = null } = {}) {
  if (!Tone?.PingPongDelay) {
    throw new Error('[TonePingPongDelayEffect] Tone.PingPongDelay constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.PingPongDelay(...ctorArgs)
    : new Tone.PingPongDelay(ctorArgs[0]);
  const bpmState = {
    current: getCurrentSyncBpm(),
  };

  const modules = EFFECT_MANIFEST.modules.map((moduleSpec) =>
    createModule({
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

export default createTonePingPongDelayEffect;
