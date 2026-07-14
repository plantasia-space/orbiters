import {
  createDefaultStacks,
  cloneStacksState,
  ensureDimensionOnStack,
  ensureAxisLength,
  cloneModuleState,
} from '../core/stackUtils.js';

const AXES = ['x', 'y', 'z'];
const DEFAULT_STACK_ID = 'deck-i';
const DEFAULT_DIMENSION_ID = 'EW::I';

function deriveMappingDefaultsFromCombined(combined, fallbackMappings = {}) {
  const result = {};
  const params = combined?.orbiter?.orbiterParams || {};
  AXES.forEach((axis) => {
    const fallback = fallbackMappings[axis] ? { ...fallbackMappings[axis] } : { axis };
    const source = params[axis];
    result[axis] = source && typeof source === 'object' ? { ...fallback, ...source, axis } : fallback;
  });
  return result;
}

function populateStacksFromEffects(effects = {}, {
  stackId = DEFAULT_STACK_ID,
  dimensionId = DEFAULT_DIMENSION_ID,
} = {}) {
  const stacks = createDefaultStacks();
  const stack = stacks[stackId] || stacks[DEFAULT_STACK_ID];
  if (!stack) return stacks;
  const dimension = ensureDimensionOnStack(stack, dimensionId, {
    dimensionLabel: dimensionId,
    createIfMissing: true,
  });
  AXES.forEach((axis) => {
    const effectAxis = effects[axis];
    const axisState = dimension.axes[axis];
    ensureAxisLength(axisState);
    const modules = Array.isArray(effectAxis?.modules) ? effectAxis.modules : [];
    axisState.modules.forEach((moduleState, index) => {
      const incoming = modules[index];
      axisState.modules[index] = incoming
        ? cloneModuleState(incoming, { includeDimensionMetadata: false })
        : cloneModuleState({}, { includeDimensionMetadata: false });
    });
  });
  return stacks;
}

function effectsFromStacks(stacks = {}, {
  stackId = DEFAULT_STACK_ID,
  dimensionId = DEFAULT_DIMENSION_ID,
  includeAllDimensions = false,
} = {}) {
  const stack = stacks[stackId] || stacks[DEFAULT_STACK_ID];
  const result = {
    x: { dimensionId: null, modules: [] },
    y: { dimensionId: null, modules: [] },
    z: { dimensionId: null, modules: [] },
  };
  if (!stack || !stack.dimensions || typeof stack.dimensions !== 'object') {
    return result;
  }

  const dimensionEntries = includeAllDimensions
    ? Object.entries(stack.dimensions)
    : [[dimensionId, stack.dimensions?.[dimensionId]]].filter(([, state]) => state);

  dimensionEntries.forEach(([dimId, dimensionState]) => {
    if (!dimensionState || typeof dimensionState !== 'object') return;
    const dimensionLabel = dimensionState.dimensionLabel ?? dimId;

    AXES.forEach((axis) => {
      const axisState = dimensionState.axes?.[axis];
      if (!axisState || typeof axisState !== 'object') return;
      const modules = Array.isArray(axisState.modules) ? axisState.modules : [];
      const rotationNormalized = Number.isFinite(axisState.rotation?.normalized)
        ? Math.min(1, Math.max(0, Number(axisState.rotation.normalized)))
        : null;

      const target = result[axis];
      modules.forEach((module) => {
        if (!module || !module.effectId) return;
        const cloned = cloneModuleState(module, { includeDimensionMetadata: false });
        cloned.dimensionId = dimId;
        cloned.dimensionLabel = dimensionLabel;
        const existingNormalized = Number.isFinite(module.controlNormalized)
          ? Math.min(1, Math.max(0, Number(module.controlNormalized)))
          : null;
        const resolvedNormalized = rotationNormalized !== null ? rotationNormalized : existingNormalized;
        if (resolvedNormalized !== null) {
          cloned.controlNormalized = resolvedNormalized;
        }
        target.modules.push(cloned);
      });

      if (target.dimensionId == null) {
        target.dimensionId = dimId;
      }
      if (!target.dimensionLabel && dimensionLabel) {
        target.dimensionLabel = dimensionLabel;
      }
    });
  });

  return result;
}

function deriveStacksDefaultsFromCombined(combined, fallbackStacks = null) {
  if (combined?.orbiter?.stacks && typeof combined.orbiter.stacks === 'object') {
    return cloneStacksState(combined.orbiter.stacks);
  }
  if (combined?.orbiter?.effects) {
    return populateStacksFromEffects(combined.orbiter.effects);
  }
  if (fallbackStacks && typeof fallbackStacks === 'object') {
    return cloneStacksState(fallbackStacks);
  }
  return createDefaultStacks();
}

function createStubOrbiterFromCombined(combined, { stacksDefaults = null } = {}) {
  const stacks = deriveStacksDefaultsFromCombined(combined, stacksDefaults);
  const effects = effectsFromStacks(stacks, { includeAllDimensions: true });
  const orbiterData = combined?.orbiter
    ? { ...combined.orbiter, stacks, effects }
    : { stacks, effects };
  return {
    play: () => {},
    pause: () => {},
    stop: () => {},
    getAmplitude: () => 0,
    trackData: combined?.track || null,
    orbiterData,
    orbiterParams: combined?.orbiter?.orbiterParams ? { ...combined.orbiter.orbiterParams } : {},
    orbiterColors: combined?.orbiter?.orbiterColors ? { ...combined.orbiter.orbiterColors } : {},
    stacks,
    effects,
  };
}

function createFallbackStubOrbiter(fallbackCombined, { stacksDefaults = null } = {}) {
  const stacks = deriveStacksDefaultsFromCombined(fallbackCombined, stacksDefaults);
  const effects = effectsFromStacks(stacks, { includeAllDimensions: true });
  const orbiterData = fallbackCombined?.orbiter
    ? { ...fallbackCombined.orbiter, stacks, effects }
    : { stacks, effects };
  return {
    play: () => {},
    pause: () => {},
    stop: () => {},
    getAmplitude: () => 0,
    trackData: fallbackCombined?.track || null,
    orbiterData,
    orbiterParams: fallbackCombined?.orbiter?.orbiterParams
      ? { ...fallbackCombined.orbiter.orbiterParams }
      : {},
    orbiterColors: fallbackCombined?.orbiter?.orbiterColors
      ? { ...fallbackCombined.orbiter.orbiterColors }
      : {},
    stacks,
    effects,
  };
}

export {
  createFallbackStubOrbiter,
  createStubOrbiterFromCombined,
  deriveStacksDefaultsFromCombined,
  deriveMappingDefaultsFromCombined,
  effectsFromStacks,
};
