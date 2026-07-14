/**
 * @file src/core/stackUtils.js
 * @description Shared helpers for describing rack UI components, axes, and stack configuration payloads.
 */
import { MAX_MODULES } from '../config/Constants.js';
import { sanitizeMappings } from '../audio/effects/mappingManager.js';
import {
  resolveEffectVersion,
  resolveModuleMetadata,
} from '../audio/effects/definitionRegistry.js';

export const UI_COMPONENT_SCOPES = Object.freeze({
  UNIQUE: 'unique',
  DIMENSION: 'dimension',
});

const AXES = Object.freeze(['x', 'y', 'z']);

const UNIQUE_COMPONENTS = Object.freeze([
  Object.freeze({
    id: 'premix-deck-i',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'premix-deck-i',
    uiIds: Object.freeze(['gSlider', 'premix-deck-i-display']),
    defaultValue: 0,
    description: 'Premix Deck I gain shared across all dimensions.',
  }),
  Object.freeze({
    id: 'transport-control',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'transportMenuButton',
    uiIds: Object.freeze(['transportMenuButton']),
    defaultValue: 'stop',
    description: 'Play/pause, stop, and capture transport controls.',
  }),
  // Per-OPTION transport actions, so the React transport buttons are MIDI-learn
  // targets that inherit + clear the legacy per-item mappings (the legacy ButtonGroup
  // registered each item under its bare action key, e.g. `play-toggle`). GLOBAL (UNIQUE)
  // momentary actions — a flat scoped key equal to the componentId.
  Object.freeze({
    id: 'play-toggle',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'play-toggle',
    uiIds: Object.freeze(['play-toggle']),
    defaultValue: false,
    description: 'Transport play / pause toggle.',
  }),
  Object.freeze({
    id: 'stop',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'stop',
    uiIds: Object.freeze(['stop']),
    defaultValue: false,
    description: 'Transport stop.',
  }),
  Object.freeze({
    id: 'record',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'record',
    uiIds: Object.freeze(['record']),
    defaultValue: false,
    description: 'Transport record (capture).',
  }),
  // The React calibrate button (header, Sensors panel) is a MIDI-learn target, the
  // same GLOBAL momentary-action pattern as play-toggle/stop above. Reuse the legacy WAC element
  // id `sensor-calibration` as the uiId so that `_clearLegacyWidgetMappingsForComponent` can
  // inherit/clear a persisted legacy mapping IF one exists (the old calibrate button was a plain
  // click, so usually none — this is just defensive, matching the sibling entries).
  Object.freeze({
    id: 'sensor-calibration',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'sensor-calibration',
    uiIds: Object.freeze(['sensor-calibration']),
    defaultValue: false,
    description: 'Re-zero the device-orientation sensor baseline (calibrate).',
  }),
  // Per-OPTION interaction-panel switches, so each React panel button is a MIDI-learn
  // target that inherits + clears the legacy menu-item mapping (the legacy ButtonGroup
  // registered each panel item under its bare `data-action` token). GLOBAL momentary actions.
  Object.freeze({
    id: 'sensors',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'sensors',
    uiIds: Object.freeze(['sensors']),
    defaultValue: false,
    description: 'Activate the Sensors interaction panel.',
  }),
  Object.freeze({
    id: 'cosmic-lfo',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'cosmic-lfo',
    uiIds: Object.freeze(['cosmic-lfo']),
    defaultValue: false,
    description: 'Activate the Cosmic LFO interaction panel.',
  }),
  Object.freeze({
    id: 'playback',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'playback',
    uiIds: Object.freeze(['playback']),
    defaultValue: false,
    description: 'Activate the Playback interaction panel.',
  }),
  Object.freeze({
    id: 'jamming',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'jamming',
    uiIds: Object.freeze(['jamming']),
    defaultValue: false,
    description: 'Activate the Jamming interaction panel.',
  }),
  Object.freeze({
    id: 'loop-toggle',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'loop-toggle',
    uiIds: Object.freeze(['loop-toggle']),
    defaultValue: false,
    description: 'Enable or disable loop playback.',
  }),
  Object.freeze({
    id: 'interaction-panel',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'interactionMenuButton',
    uiIds: Object.freeze(['interactionMenuButton']),
    defaultValue: 'midi',
    description: 'Interaction mode selector (MIDI, Sensors, Cosmic LFO, Playback, Jamming).',
  }),
  Object.freeze({
    id: 'information-menu',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'informationMenuButton',
    uiIds: Object.freeze(['informationMenuButton']),
    defaultValue: 'control-monitor',
    description: 'Information dropdown selector.',
  }),
  Object.freeze({
    id: 'waveform-visualization',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'waveform-container',
    uiIds: Object.freeze(['waveform-container']),
    defaultValue: null,
    description: 'Audio waveform display + time code (read-only).',
  }),
  Object.freeze({
    id: 'zoom-control',
    scope: UI_COMPONENT_SCOPES.UNIQUE,
    rootParam: 'zoom-container',
    uiIds: Object.freeze(['zoom-container']),
    defaultValue: 1,
    description: 'Waveform zoom slider.',
  }),
]);

function makeAxisComponent(axis, config) {
  return Object.freeze({
    ...config,
    id: `${axis}.${config.key}`,
    axis,
    scope: UI_COMPONENT_SCOPES.DIMENSION,
  });
}

const AXIS_CONTROL_BLUEPRINTS = Object.freeze([
  Object.freeze({
    key: 'param',
    rootParamFactory: (axis) => axis,
    uiIdsFactory: (axis) => Object.freeze([`${axis}-param-input`]),
    defaultValue: 0,
    description: (axis) => `Numeric input for the ${axis.toUpperCase()} axis.`,
  }),
  Object.freeze({
    key: 'knob',
    rootParamFactory: (axis) => `${axis}KnobContainer`,
    uiIdsFactory: (axis) => Object.freeze([`${axis}KnobContainer`]),
    defaultValue: Object.freeze({
      value: 0,
      normalized: 0,
    }),
    description: (axis) => `Rotary knob control for ${axis.toUpperCase()}.`,
  }),
  Object.freeze({
    key: 'sensor-toggle',
    rootParamFactory: (axis) => `${axis}`,
    uiIdsFactory: (axis) => Object.freeze([`toggleSensor${axis.toUpperCase()}`]),
    defaultValue: false,
    description: (axis) => `Enable device sensor input on ${axis.toUpperCase()}.`,
  }),
  Object.freeze({
    key: 'cosmic-toggle',
    rootParamFactory: () => 'cosmic-radio-xyz',
    uiIdsFactory: (axis) => Object.freeze([`${axis}CosmicLFO`]),
    defaultValue: false,
    description: (axis) => `Enable Cosmic LFO on ${axis.toUpperCase()}.`,
  }),
  Object.freeze({
    key: 'waveform',
    rootParamFactory: (axis) => `${axis}-waveform`,
    uiIdsFactory: (axis) =>
      Object.freeze([
        `${axis}-waveform-sine`,
        `${axis}-waveform-square`,
        `${axis}-waveform-sawtooth`,
        `${axis}-waveform-triangle`,
      ]),
    defaultValue: 'sine',
    description: (axis) => `Select LFO waveform for ${axis.toUpperCase()}.`,
  }),
  Object.freeze({
    key: 'exo-source',
    rootParamFactory: (axis) => `${axis}-exo-source`,
    uiIdsFactory: (axis) => Object.freeze([`${axis}-exo-lfo-dropdown`]),
    defaultValue: 'minimumCosmicLfo',
    description: (axis) => `Select cosmic frequency source for ${axis.toUpperCase()}.`,
  }),
  Object.freeze({
    key: 'cosmic-frequency',
    rootParamFactory: (axis) => `${axis}-cosmic-frequency`,
    uiIdsFactory: (axis) => Object.freeze([`${axis}CosmicManualKnob`]),
    defaultValue: 0.01,
    description: (axis) => `Manual cosmic LFO frequency for ${axis.toUpperCase()}.`,
  }),
  Object.freeze({
    key: 'cosmic-amplitude',
    rootParamFactory: (axis) => `${axis}-cosmic-amplitude`,
    uiIdsFactory: (axis) => Object.freeze([`${axis}CosmicAmplitudeKnob`]),
    defaultValue: 1,
    description: (axis) => `Cosmic LFO depth for ${axis.toUpperCase()}.`,
  }),
  Object.freeze({
    key: 'frequency-multiplier-low',
    rootParamFactory: (axis) => `${axis}Cosmic1`,
    uiIdsFactory: (axis) => Object.freeze([`${axis}Cosmic1`]),
    defaultValue: false,
    description: (axis) => `Multiply ${axis.toUpperCase()} LFO frequency by 0.5.`,
  }),
  Object.freeze({
    key: 'frequency-multiplier-high',
    rootParamFactory: (axis) => `${axis}Cosmic2`,
    uiIdsFactory: (axis) => Object.freeze([`${axis}Cosmic2`]),
    defaultValue: false,
    description: (axis) => `Multiply ${axis.toUpperCase()} LFO frequency by 2.0.`,
  }),
  Object.freeze({
    key: 'frequency-monitor',
    rootParamFactory: (axis) => `cosmic-lfo-${axis}-freq`,
    uiIdsFactory: (axis) => Object.freeze([`cosmic-lfo-${axis}-freq`]),
    defaultValue: 0,
    description: (axis) => `Read-only frequency display for ${axis.toUpperCase()}.`,
  }),
]);

const DIMENSION_COMPONENTS = Object.freeze(
  AXES.flatMap((axis) =>
    AXIS_CONTROL_BLUEPRINTS.map((blueprint) =>
      makeAxisComponent(axis, {
        key: blueprint.key,
        rootParam:
          typeof blueprint.rootParamFactory === 'function'
            ? blueprint.rootParamFactory(axis)
            : blueprint.rootParamFactory,
        uiIds:
          typeof blueprint.uiIdsFactory === 'function'
            ? blueprint.uiIdsFactory(axis)
            : blueprint.uiIdsFactory,
        defaultValue: blueprint.defaultValue,
        description:
          typeof blueprint.description === 'function'
            ? blueprint.description(axis)
            : blueprint.description,
      }),
    ),
  ),
);

const UI_COMPONENTS = Object.freeze([...UNIQUE_COMPONENTS, ...DIMENSION_COMPONENTS]);

const UI_COMPONENTS_BY_ID = new Map(UI_COMPONENTS.map((component) => [component.id, component]));

const STACK_REGISTRY = new Map();

function cloneDefaultValue(defaultValue) {
  if (Array.isArray(defaultValue)) {
    return defaultValue.map((item) => cloneDefaultValue(item));
  }
  if (defaultValue && typeof defaultValue === 'object') {
    return Object.keys(defaultValue).reduce((acc, key) => {
      acc[key] = cloneDefaultValue(defaultValue[key]);
      return acc;
    }, {});
  }
  return defaultValue;
}

function createDefaultUniqueState() {
  const uniqueState = {};
  UNIQUE_COMPONENTS.forEach((component) => {
    uniqueState[component.id] = cloneDefaultValue(component.defaultValue);
  });
  return uniqueState;
}

function createDefaultDimensionComponentState() {
  const dimensionState = {};
  DIMENSION_COMPONENTS.forEach((component) => {
    dimensionState[component.id] = cloneDefaultValue(component.defaultValue);
  });
  return dimensionState;
}

function createRegistryDimensionRecord(dimensionId, dimensionLabel = null) {
  return {
    dimensionId,
    dimensionLabel: dimensionLabel ?? dimensionId,
    components: createDefaultDimensionComponentState(),
  };
}

function ensureStackRegistryEntry(stackId) {
  if (!stackId || !isStackEnabled(stackId)) {
    if (stackId && STACK_REGISTRY.has(stackId)) {
      STACK_REGISTRY.delete(stackId);
    }
    return null;
  }
  if (!STACK_REGISTRY.has(stackId)) {
    STACK_REGISTRY.set(stackId, {
      stackId,
      uniqueState: createDefaultUniqueState(),
      dimensions: new Map(),
      activeDimensionId: null,
    });
  }
  return STACK_REGISTRY.get(stackId);
}

function maybeCloneDimensionRecord(record) {
  if (!record) return null;
  return {
    dimensionId: record.dimensionId,
    dimensionLabel: record.dimensionLabel,
    components: { ...record.components },
  };
}

function ensureDimensionRegistry(entry, dimensionId, dimensionLabel = null) {
  if (!entry || !dimensionId) return null;
  if (!entry.dimensions.has(dimensionId)) {
    entry.dimensions.set(dimensionId, createRegistryDimensionRecord(dimensionId, dimensionLabel));
  } else if (dimensionLabel && !entry.dimensions.get(dimensionId).dimensionLabel) {
    entry.dimensions.get(dimensionId).dimensionLabel = dimensionLabel;
  }
  return entry.dimensions.get(dimensionId);
}

function removeStaleDimensions(entry, validIds = new Set()) {
  if (!entry) return;
  entry.dimensions.forEach((_value, key) => {
    if (!validIds.has(key)) {
      entry.dimensions.delete(key);
    }
  });
  if (entry.activeDimensionId && !entry.dimensions.has(entry.activeDimensionId)) {
    entry.activeDimensionId = validIds.size ? [...validIds][0] : null;
  }
}

export function listUiComponents({ scope = null, axis = null } = {}) {
  return UI_COMPONENTS.filter((component) => {
    if (scope && component.scope !== scope) return false;
    if (axis && component.axis !== axis) return false;
    return true;
  }).map((component) => ({ ...component }));
}

export function getUiComponentMetadata(componentId) {
  const component = UI_COMPONENTS_BY_ID.get(componentId);
  if (!component) return null;
  return { ...component };
}

export function initializeStackRegistry(stackId, { dimensions = [], activeDimensionId = null } = {}) {
  const entry = ensureStackRegistryEntry(stackId);
  if (!entry) return null;
  const validIds = new Set();
  dimensions.forEach((dimension) => {
    const dimensionId = typeof dimension === 'string' ? dimension : dimension?.id;
    if (!dimensionId) return;
    validIds.add(dimensionId);
    const label = typeof dimension === 'object' ? dimension.label ?? null : null;
    ensureDimensionRegistry(entry, dimensionId, label);
  });
  if (validIds.size && !entry.activeDimensionId) {
    entry.activeDimensionId =
      activeDimensionId && validIds.has(activeDimensionId)
        ? activeDimensionId
        : [...validIds][0];
  } else if (activeDimensionId && validIds.has(activeDimensionId)) {
    entry.activeDimensionId = activeDimensionId;
  }
  removeStaleDimensions(entry, validIds);
  return maybeCloneDimensionRecord(entry.dimensions.get(entry.activeDimensionId));
}

export function syncDimensionsForStack(stackId, dimensions = [], { activeDimensionId = null } = {}) {
  const entry = ensureStackRegistryEntry(stackId);
  if (!entry) return null;
  const validIds = new Set();
  dimensions.forEach((definition) => {
    const dimensionId = typeof definition === 'string' ? definition : definition?.id;
    if (!dimensionId) return;
    validIds.add(dimensionId);
    ensureDimensionRegistry(entry, dimensionId, definition?.label ?? null);
  });
  removeStaleDimensions(entry, validIds);
  if (activeDimensionId && entry.dimensions.has(activeDimensionId)) {
    entry.activeDimensionId = activeDimensionId;
  } else if (!entry.dimensions.has(entry.activeDimensionId) && entry.dimensions.size) {
    entry.activeDimensionId = [...entry.dimensions.keys()][0];
  }
  return entry;
}

export function setStackRegistryActiveDimension(stackId, dimensionId) {
  const entry = ensureStackRegistryEntry(stackId);
  if (!entry || !dimensionId || !entry.dimensions.has(dimensionId)) {
    return entry ? entry.activeDimensionId : null;
  }
  entry.activeDimensionId = dimensionId;
  return entry.activeDimensionId;
}

export function getStackRegistryActiveDimension(stackId) {
  const entry = ensureStackRegistryEntry(stackId);
  if (!entry || !entry.activeDimensionId) return null;
  return maybeCloneDimensionRecord(entry.dimensions.get(entry.activeDimensionId));
}

export function getScopedState(stackId, componentId, { dimensionId = null } = {}) {
  const entry = ensureStackRegistryEntry(stackId);
  const component = UI_COMPONENTS_BY_ID.get(componentId);
  if (!component || !entry) return undefined;
  if (component.scope === UI_COMPONENT_SCOPES.UNIQUE) {
    return cloneDefaultValue(entry.uniqueState[componentId]);
  }
  const targetDimensionId = dimensionId ?? entry.activeDimensionId;
  if (!targetDimensionId) return undefined;
  const dimension = entry.dimensions.get(targetDimensionId);
  if (!dimension) return undefined;
  return cloneDefaultValue(dimension.components[componentId]);
}

export function setScopedState(stackId, componentId, value, { dimensionId = null } = {}) {
  const entry = ensureStackRegistryEntry(stackId);
  const component = UI_COMPONENTS_BY_ID.get(componentId);
  if (!component || !entry) return false;
  if (component.scope === UI_COMPONENT_SCOPES.UNIQUE) {
    entry.uniqueState[componentId] = cloneDefaultValue(value);
    return true;
  }
  const targetDimensionId = dimensionId ?? entry.activeDimensionId;
  if (!targetDimensionId) return false;
  const dimension = ensureDimensionRegistry(entry, targetDimensionId, null);
  dimension.components[componentId] = cloneDefaultValue(value);
  return true;
}

export function listStackRegistryEntries() {
  return Array.from(STACK_REGISTRY.values())
    .filter((entry) => isStackEnabled(entry.stackId))
    .map((entry) => ({
      stackId: entry.stackId,
      activeDimensionId: entry.activeDimensionId,
      dimensions: Array.from(entry.dimensions.values()).map((dimension) => ({
        dimensionId: dimension.dimensionId,
        dimensionLabel: dimension.dimensionLabel,
      })),
    }));
}

export const DEFAULT_STACK_SPECS = Object.freeze([
  Object.freeze({ id: 'deck-i', kind: 'deck', label: 'Deck I', enabled: true }),
  Object.freeze({ id: 'deck-ii', kind: 'deck', label: 'Deck II', enabled: false }),
  Object.freeze({ id: 'send-i', kind: 'send', label: 'Send I', enabled: false }),
  Object.freeze({ id: 'main', kind: 'output', label: 'Main', enabled: false }),
]);

const STACK_SPECS_BY_ID = new Map(DEFAULT_STACK_SPECS.map((spec) => [spec.id, spec]));
const ENABLED_STACK_IDS = new Set(
  DEFAULT_STACK_SPECS.filter((spec) => spec.enabled).map((spec) => spec.id)
);

export function getEnabledStackSpecs(specs = DEFAULT_STACK_SPECS) {
  if (!Array.isArray(specs)) return [];
  return specs.filter((spec) => spec && spec.enabled);
}

export function isStackEnabled(stackId) {
  return stackId != null && ENABLED_STACK_IDS.has(stackId);
}


export function createEmptyModuleState() {
  return {
    effectId: null,
    effectVersion: null,
    moduleId: null,
    moduleMetadata: null,
    inputParamId: null,
    range: { min: null, max: null, equilibrium: null },
    settings: undefined,
    mappings: [],
  };
}

export function cloneModuleState(module = {}, options = {}) {
  const {
    includeDimensionMetadata = true,
    hydrateMetadata = true,
  } = options;

  const range = module?.range || {};
  const effectId = module?.effectId ?? null;
  const moduleId = module?.moduleId ?? null;

  let effectVersion = module?.effectVersion ?? null;
  const incomingMetadata =
    module?.moduleMetadata && typeof module.moduleMetadata === 'object' && !Array.isArray(module.moduleMetadata)
      ? {
          label: module.moduleMetadata.label ?? null,
          description: module.moduleMetadata.description ?? null,
        }
      : null;

  let moduleMetadata = incomingMetadata;

  let dimensionId = includeDimensionMetadata ? module?.dimensionId ?? null : null;
  let dimensionLabel = includeDimensionMetadata ? module?.dimensionLabel ?? null : null;

  if (hydrateMetadata && effectId) {
    if (!effectVersion) {
      effectVersion = resolveEffectVersion(effectId) ?? null;
    }

    const manifestMetadata = resolveModuleMetadata(effectId, moduleId ?? null);
    if (manifestMetadata) {
      const resolvedLabel = manifestMetadata.label ?? moduleMetadata?.label ?? null;
      const resolvedDescription = manifestMetadata.description ?? moduleMetadata?.description ?? null;
      moduleMetadata =
        resolvedLabel || resolvedDescription
          ? {
              label: resolvedLabel,
              description: resolvedDescription,
            }
          : null;

      if (includeDimensionMetadata) {
        if (!dimensionId && manifestMetadata.dimensionId) {
          dimensionId = manifestMetadata.dimensionId;
        }
        if (!dimensionLabel && manifestMetadata.dimensionLabel) {
          dimensionLabel = manifestMetadata.dimensionLabel;
        }
      }
    }
  }

  const cloned = {
    effectId,
    effectVersion,
    moduleId,
    moduleMetadata: moduleMetadata ? { ...moduleMetadata } : null,
    inputParamId: module?.inputParamId ?? null,
    range: {
      min: Number.isFinite(range.min) ? Number(range.min) : null,
      max: Number.isFinite(range.max) ? Number(range.max) : null,
      equilibrium: Number.isFinite(range.equilibrium ?? range.init)
        ? Number(range.equilibrium ?? range.init)
        : null,
    },
    settings:
      module?.settings && typeof module.settings === 'object' && !Array.isArray(module.settings)
        ? { ...module.settings }
        : undefined,
    mappings: sanitizeMappings(module?.mappings),
    controlNormalized: Number.isFinite(module?.controlNormalized)
      ? Math.min(1, Math.max(0, Number(module.controlNormalized)))
      : null,
  };

  if (includeDimensionMetadata) {
    cloned.dimensionId = dimensionId ?? null;
    cloned.dimensionLabel = dimensionLabel ?? null;
  }

  return cloned;
}

function createDefaultRotationState() {
  return {
    value: 0,
    normalized: 0,
    min: null,
    max: null,
    step: null,
  };
}

function createDefaultAxisControls() {
  return {
    knob: {
      value: 0,
      normalized: 0,
    },
    sensor: {
      enabled: false,
    },
    cosmic: {
      enabled: false,
      waveform: 'sine',
      source: 'minimumCosmicLfo',
      multiplier: 1,
      frequency: 0,
      baseFrequency: 0.01,
      amplitude: 1,
    },
  };
}

export function createEmptyAxisState() {
  return {
    modules: Array.from({ length: MAX_MODULES }, () => createEmptyModuleState()),
    rotation: createDefaultRotationState(),
    controls: createDefaultAxisControls(),
  };
}

export function cloneAxisState(axis = {}) {
  const modules = Array.isArray(axis.modules) ? axis.modules : [];
  const clonedModules = modules.map((module) =>
    cloneModuleState(module, { includeDimensionMetadata: false })
  );
  while (clonedModules.length < MAX_MODULES) {
    clonedModules.push(createEmptyModuleState());
  }
  return {
    modules: clonedModules,
    rotation: {
      value: Number.isFinite(axis.rotation?.value) ? Number(axis.rotation.value) : 0,
      normalized: Number.isFinite(axis.rotation?.normalized) ? Number(axis.rotation.normalized) : 0,
      min: Number.isFinite(axis.rotation?.min) ? Number(axis.rotation.min) : null,
      max: Number.isFinite(axis.rotation?.max) ? Number(axis.rotation.max) : null,
      step: Number.isFinite(axis.rotation?.step) ? Number(axis.rotation.step) : null,
    },
    controls: {
      knob: {
        value: Number.isFinite(axis.controls?.knob?.value) ? Number(axis.controls.knob.value) : 0,
        normalized: Number.isFinite(axis.controls?.knob?.normalized) ? Number(axis.controls.knob.normalized) : 0,
      },
      sensor: {
        enabled: Boolean(axis.controls?.sensor?.enabled),
      },
      cosmic: {
        enabled: Boolean(axis.controls?.cosmic?.enabled),
        waveform: axis.controls?.cosmic?.waveform ?? 'sine',
        source: axis.controls?.cosmic?.source ?? 'minimumCosmicLfo',
        multiplier: Number.isFinite(axis.controls?.cosmic?.multiplier)
          ? Number(axis.controls.cosmic.multiplier)
          : 1,
        frequency: Number.isFinite(axis.controls?.cosmic?.frequency)
          ? Number(axis.controls.cosmic.frequency)
          : 0,
        baseFrequency: Number.isFinite(axis.controls?.cosmic?.baseFrequency)
          ? Number(axis.controls.cosmic.baseFrequency)
          : 0.01,
        amplitude: Number.isFinite(axis.controls?.cosmic?.amplitude)
          ? Number(axis.controls.cosmic.amplitude)
          : 1,
      },
    },
  };
}

export function createEmptyDimensionState({ dimensionId = null, dimensionLabel = null } = {}) {
  return {
    dimensionId,
    dimensionLabel,
    design: null,
    axes: {
      x: createEmptyAxisState(),
      y: createEmptyAxisState(),
      z: createEmptyAxisState(),
    },
  };
}

export function cloneDimensionState(dimension = {}) {
  return {
    dimensionId: dimension.dimensionId ?? null,
    dimensionLabel: dimension.dimensionLabel ?? null,
    design:
      dimension.design && typeof dimension.design === 'object'
        ? { ...dimension.design }
        : (dimension.design ?? null),
    axes: {
      x: cloneAxisState(dimension.axes?.x),
      y: cloneAxisState(dimension.axes?.y),
      z: cloneAxisState(dimension.axes?.z),
    },
  };
}

export function createEmptyStackState({ id, kind, enabled = false, label = null } = {}) {
  if (!id) {
    return {
      id: null,
      kind: kind ?? 'deck',
      label: label ?? null,
      enabled: false,
      dimensions: {},
    };
  }
  const spec = STACK_SPECS_BY_ID.get(id) ?? null;
  const resolvedKind = kind ?? spec?.kind ?? 'deck';
  const resolvedLabel = label ?? spec?.label ?? id;
  const resolvedEnabled = spec ? Boolean(spec.enabled) : Boolean(enabled);
  return {
    id,
    kind: resolvedKind,
    label: resolvedLabel,
    enabled: resolvedEnabled && isStackEnabled(id),
    dimensions: {},
  };
}

export function cloneStackState(stack = {}) {
  const dimensions = {};
  if (stack.dimensions && typeof stack.dimensions === 'object') {
    Object.entries(stack.dimensions).forEach(([dimensionId, dimension]) => {
      dimensions[dimensionId] = cloneDimensionState(dimension);
    });
  }
  const stackId = stack.id ?? null;
  const spec = stackId ? STACK_SPECS_BY_ID.get(stackId) ?? null : null;
  const resolvedKind = stack.kind ?? spec?.kind ?? 'deck';
  const resolvedLabel = stack.label ?? spec?.label ?? stackId;
  const enabled = stackId ? isStackEnabled(stackId) : false;
  return {
    id: stackId,
    kind: resolvedKind,
    label: resolvedLabel ?? null,
    enabled,
    dimensions,
  };
}

export function filterEnabledStacks(stacks = {}, { clone = false } = {}) {
  if (!stacks || typeof stacks !== 'object') return {};
  const filtered = {};
  getEnabledStackSpecs().forEach(({ id }) => {
    const stack = stacks?.[id];
    if (!stack) return;
    filtered[id] = clone ? cloneStackState(stack) : stack;
  });
  return filtered;
}

export function createDefaultStacks() {
  const stacks = {};
  getEnabledStackSpecs().forEach((spec) => {
    stacks[spec.id] = createEmptyStackState(spec);
  });
  return stacks;
}

export function cloneStacksState(stacks = {}) {
  const cloned = filterEnabledStacks(stacks, { clone: true });
  getEnabledStackSpecs().forEach((spec) => {
    if (!cloned[spec.id]) {
      cloned[spec.id] = createEmptyStackState(spec);
    }
  });
  return cloned;
}

export function ensureDimensionOnStack(
  stack,
  dimensionId,
  { dimensionLabel = null, createIfMissing = true } = {},
) {
  if (!stack || !dimensionId) return null;
  if (!stack.dimensions || typeof stack.dimensions !== 'object') {
    stack.dimensions = {};
  }
  if (!stack.dimensions[dimensionId] && createIfMissing) {
    stack.dimensions[dimensionId] = createEmptyDimensionState({
      dimensionId,
      dimensionLabel,
    });
  }
  const dimension = stack.dimensions[dimensionId] ?? null;
  if (dimension && dimensionLabel && !dimension.dimensionLabel) {
    dimension.dimensionLabel = dimensionLabel;
  }
  return dimension;
}

export function ensureAxisLength(axisState) {
  if (!axisState || !Array.isArray(axisState.modules)) return;
  while (axisState.modules.length < MAX_MODULES) {
    axisState.modules.push(createEmptyModuleState());
  }
}

export function normalizeStacksInput(inputStacks = {}, { fallbackStacks = null } = {}) {
  if (!inputStacks || typeof inputStacks !== 'object' || Array.isArray(inputStacks)) {
    return fallbackStacks ? cloneStacksState(fallbackStacks) : createDefaultStacks();
  }

  return cloneStacksState(inputStacks);
}

export function getDefaultActiveStackId(stacks = {}) {
  const entries = Object.entries(stacks ?? {});
  if (!entries.length) {
    const firstEnabled = getEnabledStackSpecs()[0];
    return firstEnabled ? firstEnabled.id : null;
  }
  const enabledEntry = entries.find(([stackId, stack]) => isStackEnabled(stackId) && stack?.enabled);
  if (enabledEntry) return enabledEntry[0];
  const fallback = getEnabledStackSpecs()[0];
  return fallback ? fallback.id : entries[0][0];
}
