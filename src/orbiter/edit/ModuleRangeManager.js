import { sanitizeMappings, buildModuleMappingOverrides } from '../../audio/effects/mappingManager.js';

export class ModuleRangeManager {
  constructor({ findEffectManifest, findModuleManifest, clampNumber }) {
    this.findEffectManifest = findEffectManifest;
    this.findModuleManifest = findModuleManifest;
    this.clampNumber = clampNumber;
  }

  getEffectManifest(effectId) {
    return this.findEffectManifest(effectId);
  }

  getModuleManifest(effectId, moduleId) {
    const effectManifest = this.getEffectManifest(effectId);
    return this.findModuleManifest(effectManifest, moduleId);
  }

  /** Unit of measurement for a module's range (e.g. '%', 'Hz', 'dB', 'st'), or null. Mirrors
   *  RackPanelManager: module valueRange units first, then the effect's userParamSpec units. */
  getUnits(effectId, moduleId) {
    if (!effectId || !moduleId) return null;
    const moduleManifest = this.getModuleManifest(effectId, moduleId);
    const effectManifest = this.getEffectManifest(effectId);
    return moduleManifest?.valueRange?.units || effectManifest?.userParamSpec?.units || null;
  }

  getDomain(effectId, moduleId) {
    if (!effectId || !moduleId) return null;
    const manifest = this.getEffectManifest(effectId);
    const moduleManifest = this.getModuleManifest(effectId, moduleId);
    if (!moduleManifest?.valueRange) return null;
    const min = Number(moduleManifest.valueRange.min);
    const max = Number(moduleManifest.valueRange.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const lower = Math.min(min, max);
    const upper = Math.max(min, max);
    if (lower === upper) return null;
    return { min: lower, max: upper };
  }

  createDefaultRange(effectId, moduleId) {
    const domain = this.getDomain(effectId, moduleId);
    if (!domain) return { min: null, max: null, equilibrium: null };
    const effectManifest = this.getEffectManifest(effectId);
    const moduleManifest = this.getModuleManifest(effectId, moduleId);

    const initialRange = moduleManifest?.initialRange;
    if (initialRange) {
      const min = Number.isFinite(initialRange.min) ? Number(initialRange.min) : domain.min;
      const max = Number.isFinite(initialRange.max) ? Number(initialRange.max) : domain.max;
      const equilibrium = Number.isFinite(initialRange.equilibrium)
        ? Number(initialRange.equilibrium)
        : min + (max - min) / 2;

      return {
        min: this.clampNumber(min, domain.min, domain.max),
        max: this.clampNumber(max, domain.min, domain.max),
        equilibrium: this.clampNumber(equilibrium, domain.min, domain.max),
      };
    }

    const manifestEquilibrium = moduleManifest?.valueRange?.equilibrium;
    const min = domain.min;
    const max = domain.max;
    const equilibrium = Number.isFinite(manifestEquilibrium)
      ? Number(manifestEquilibrium)
      : min + (max - min) / 2;
    return { min, max, equilibrium };
  }

  ensureRangeWithinDomain(moduleState, domain) {
    if (!domain) {
      const range = moduleState.range || { min: null, max: null, equilibrium: null };
      moduleState.range = {
        min: Number.isFinite(range.min) ? Number(range.min) : null,
        max: Number.isFinite(range.max) ? Number(range.max) : null,
        equilibrium: Number.isFinite(range.equilibrium ?? range.init)
          ? Number(range.equilibrium ?? range.init)
          : null,
      };
      return moduleState.range;
    }

    const range = moduleState.range || {};
    const manifest = this.getEffectManifest(moduleState.effectId);
    const moduleManifest = this.getModuleManifest(moduleState.effectId, moduleState.moduleId);

    const initialRange = moduleManifest?.initialRange;
    const defaultMin = initialRange?.min ?? domain.min;
    const defaultMax = initialRange?.max ?? domain.max;
    const defaultEquilibrium =
      initialRange?.equilibrium ??
      moduleManifest?.valueRange?.equilibrium ??
      (domain.min + domain.max) / 2;

    const minVal = Number.isFinite(range.min)
      ? this.clampNumber(range.min, domain.min, domain.max)
      : this.clampNumber(defaultMin, domain.min, domain.max);

    const maxVal = Number.isFinite(range.max)
      ? this.clampNumber(range.max, domain.min, domain.max)
      : this.clampNumber(defaultMax, domain.min, domain.max);

    const eq = Number.isFinite(range.equilibrium ?? range.init)
      ? this.clampNumber(range.equilibrium ?? range.init, domain.min, domain.max)
      : this.clampNumber(defaultEquilibrium, domain.min, domain.max);

    moduleState.range = { min: minVal, max: maxVal, equilibrium: eq };
    return moduleState.range;
  }

  computeModuleMappings(effectId, moduleId, range) {
    if (!effectId || !moduleId || !range) return [];
    const manifest = this.getEffectManifest(effectId);
    const moduleManifest = this.getModuleManifest(effectId, moduleId);
    if (!moduleManifest) return [];
    const defaults = Array.isArray(moduleManifest.mappings) ? moduleManifest.mappings : [];
    if (!defaults.length) return [];
    const min = Number(range.min);
    const max = Number(range.max);
    const manifestEquilibrium = moduleManifest?.valueRange?.equilibrium;
    const equilibrium = Number.isFinite(range.equilibrium ?? range.init)
      ? Number(range.equilibrium ?? range.init)
      : Number.isFinite(manifestEquilibrium)
        ? Number(manifestEquilibrium)
        : Number.isFinite(min) && Number.isFinite(max)
          ? min + (max - min) / 2
          : null;
    const overrideRange = {
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      equilibrium: Number.isFinite(equilibrium) ? equilibrium : null,
    };
    return sanitizeMappings(buildModuleMappingOverrides(defaults, [], overrideRange));
  }
}
