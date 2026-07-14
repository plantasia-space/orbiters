import { cloneStacksState, cloneModuleState } from '../../core/stackUtils.js';

const AXES = ['x', 'y', 'z'];

export class StackChangeEmitter {
  constructor({
    isRackSyncing,
    getStacks,
    getActiveStackId,
    getActiveDimensionId,
    onStacksChange,
    onRackChange,
    onAnyChange,
    ensureRackState,
  }) {
    this.isRackSyncing = typeof isRackSyncing === 'function' ? isRackSyncing : () => false;
    this.getStacks = typeof getStacks === 'function' ? getStacks : () => ({});
    this.getActiveStackId = typeof getActiveStackId === 'function' ? getActiveStackId : () => null;
    this.getActiveDimensionId = typeof getActiveDimensionId === 'function' ? getActiveDimensionId : () => null;
    this.onStacksChange = typeof onStacksChange === 'function' ? onStacksChange : null;
    this.onRackChange = typeof onRackChange === 'function' ? onRackChange : null;
    this.onAnyChange = typeof onAnyChange === 'function' ? onAnyChange : null;
    this.ensureRackState = typeof ensureRackState === 'function' ? ensureRackState : () => null;
  }

  emit(changedAxis = null) {
    if (this.isRackSyncing()) return;
    const payload = {
      stacks: cloneStacksState(this.getStacks()),
      activeStackId: this.getActiveStackId(),
      activeDimensionId: this.getActiveDimensionId(),
    };
    this.onStacksChange?.(payload);
    if (this.onRackChange) {
      if (changedAxis && AXES.includes(changedAxis)) {
        const rackState = this.ensureRackState(changedAxis);
        this.onRackChange(changedAxis, {
          dimensionId: rackState?.dimensionId ?? null,
          modules: Array.isArray(rackState?.modules)
            ? rackState.modules.map((module) =>
                cloneModuleState(module, { includeDimensionMetadata: false })
              )
            : [],
        });
      } else {
        AXES.forEach((axis) => {
          const rackState = this.ensureRackState(axis);
          this.onRackChange(axis, {
            dimensionId: rackState?.dimensionId ?? null,
            modules: Array.isArray(rackState?.modules)
              ? rackState.modules.map((module) =>
                  cloneModuleState(module, { includeDimensionMetadata: false })
                )
              : [],
          });
        });
      }
    }
    this.onAnyChange?.();
  }
}
