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

export function createEditModeStacks() {
  return createDefaultStacks();
}

export function ensureStacksDimensions(stacks, dimensionId, dimensionLabel) {
  if (!stacks || !dimensionId) return;
  Object.values(stacks).forEach((stack) => {
    const dimension = ensureDimensionOnStack(stack, dimensionId, {
      dimensionLabel,
      createIfMissing: true,
    });
    AXES.forEach((axis) => ensureAxisLength(dimension.axes[axis]));
  });
}

export function cloneStacks(stacks) {
  return cloneStacksState(stacks);
}

export function getPrimaryStack(stacks) {
  if (!stacks) return null;
  return stacks['deck-i'] || null;
}

export function getActiveDimension(stacks, dimensionId) {
  const primary = getPrimaryStack(stacks);
  if (!primary) return null;
  return primary.dimensions?.[dimensionId] ?? null;
}

export function normalizeStacks(stacks) {
  return cloneStacksState(stacks ?? {});
}
