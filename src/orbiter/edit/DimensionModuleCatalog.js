export class DimensionModuleCatalog {
  constructor({ getDimensions, moduleLabel, resolveIncludedModule }) {
    this.getDimensions = typeof getDimensions === 'function' ? getDimensions : () => new Map();
    this.moduleLabel = typeof moduleLabel === 'function' ? moduleLabel : (effect, module) => `${effect} › ${module}`;
    this.resolveIncludedModule =
      typeof resolveIncludedModule === 'function' ? resolveIncludedModule : () => null;
  }

  listModules(dimensionId) {
    const dimensions = this.getDimensions();
    const pkg = dimensionId ? dimensions.get(dimensionId) : null;
    if (!pkg) return [];
    return pkg.effects.flatMap((effect) => {
      const manifest = effect.manifest || {};
      const modules = manifest.modules || [];
      return modules.map((module) => ({
        dimensionId: pkg.id,
        effect,
        effectId: effect.id,
        effectLabel: effect.label,
        module,
      }));
    });
  }

  buildModuleOptions(
    dimensionId,
    { exclude = new Set(), includeKey = null, resolveLabel = null } = {},
  ) {
    const modules = this.listModules(dimensionId);
    const options = { None: 'none' };
    const seenKeys = new Set();

    modules.forEach(({ effectId, effectLabel, module }) => {
      const key = `${effectId}::${module.id}`;
      seenKeys.add(key);
      const excluded = exclude.has(key) && key !== includeKey;

      let label = this.moduleLabel(effectLabel, module.label);
      if (typeof resolveLabel === 'function') {
        label = resolveLabel({
          effectId,
          effectLabel,
          module,
          key,
          label,
          excluded,
          isIncluded: includeKey === key,
        });
      } else if (excluded) {
        label = `${label} (in use)`;
      }
      options[label] = key;
    });

    if (includeKey && !seenKeys.has(includeKey)) {
      const includedModule = this.resolveIncludedModule(includeKey, dimensionId);
      if (includedModule?.effectId && includedModule?.module?.id) {
        const key = `${includedModule.effectId}::${includedModule.module.id}`;
        let label = this.moduleLabel(includedModule.effectLabel, includedModule.module.label);
        if (includedModule.legacyLabel) {
          label = `${label} (${includedModule.legacyLabel.toLowerCase()})`;
        }
        if (typeof resolveLabel === 'function') {
          label = resolveLabel({
            effectId: includedModule.effectId,
            effectLabel: includedModule.effectLabel,
            module: includedModule.module,
            key,
            label,
            excluded: false,
            isIncluded: true,
          });
        }
        options[label] = key;
      }
    }

    return options;
  }
}
