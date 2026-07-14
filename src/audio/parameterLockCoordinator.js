/**
 * @file audio/parameterLockCoordinator.js
 * @description The ONE owner of ParameterManager dimension locks for a voice.
 *
 * Several independent causes can lock knob dimensions (the mobile speed lock,
 * engine-requiring modules blocked on a streaming backend, …) and the same
 * dimension can be claimed by more than one cause at once. ParameterManager's
 * dimension locks are a plain set — if each cause locked and unlocked
 * directly, one cause clearing would release a dimension another cause still
 * needs. This coordinator holds the per-cause target lists, computes their
 * union, and applies only the DELTA against what it previously locked, so a
 * dimension stays locked exactly as long as at least one cause claims it.
 */
export class ParameterLockCoordinator {
  /**
   * @param {{ getManager: () => ({ lockParameterDimension?: Function, unlockParameterDimension?: Function } | null | undefined) }} options
   *   `getManager` is read on every apply: the adapter's manager reference can
   *   be swapped during a voice's life, and a coordinator bound to a stale one
   *   would lock the wrong instance.
   */
  constructor({ getManager }) {
    this._getManager = typeof getManager === 'function' ? getManager : () => null;
    this._causes = new Map();
    this._applied = new Map();
  }

  /**
   * Replace the WHOLE cause map atomically and apply the resulting delta once.
   * Every caller states all its causes together (an empty/omitted list clears
   * a cause) — a per-cause setter would apply intermediate unions, and after a
   * period with no manager those intermediates would briefly lock a cause's
   * stale targets before the next call corrected them.
   * @param {Record<string, { axis: string, dimensionId: string }[]>} causes
   */
  setCauses(causes = {}) {
    this._causes = new Map();
    for (const [name, targets] of Object.entries(causes)) {
      const list = Array.isArray(targets) ? targets : [];
      if (list.length) {
        this._causes.set(name, list);
      }
    }
    this.#apply();
  }

  #apply() {
    const manager = this._getManager();
    if (!manager || typeof manager.lockParameterDimension !== 'function') {
      // No manager yet: keep bookkeeping untouched so the first apply after
      // one appears starts from an honest baseline.
      return;
    }
    const desired = new Map();
    for (const targets of this._causes.values()) {
      for (const target of targets) {
        const axis = target?.axis;
        const dimensionId = target?.dimensionId;
        if (!axis || !dimensionId) continue;
        desired.set(`${axis}::${dimensionId}`, { axis, dimensionId });
      }
    }
    for (const [key, target] of desired) {
      if (!this._applied.has(key)) {
        const { axis, dimensionId } = target;
        manager.lockParameterDimension(axis, dimensionId);
      }
    }
    for (const [key, { axis, dimensionId }] of this._applied) {
      if (!desired.has(key)) {
        manager.unlockParameterDimension?.(axis, dimensionId);
      }
    }
    this._applied = desired;
  }
}

export default ParameterLockCoordinator;
