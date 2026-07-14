import { getT } from '../../i18n/index.js';

const AXES = ['x', 'y', 'z'];
const LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export class RackPanelManager {
  constructor({
    panel,
    clampNumber,
    moduleRangeManager,
    dimensionCatalog,
    stackEmitter,
  }) {
    this.panel = panel;
    this.clampNumber = clampNumber;

    this.moduleRangeManager = moduleRangeManager;
    this.dimensionCatalog = dimensionCatalog;
    this.stackEmitter = stackEmitter;

    this.rackControllers = {};
    this.getTranslation = () => {
      if (this.panel && typeof this.panel.t === 'function') {
        return this.panel.t;
      }
      return getT();
    };
  }

  dispose() {
    AXES.forEach((axis) => {
      const controllers = this.rackControllers[axis];
      if (!controllers) return;
      controllers.modules.forEach((moduleCtrl) => {
        try {
          moduleCtrl.controllers?.module?.destroy?.();
          moduleCtrl.controllers?.min?.destroy?.();
          moduleCtrl.controllers?.max?.destroy?.();
          moduleCtrl.controllers?.equilibrium?.destroy?.();
        } catch (_) {}
      });
    });
    this.rackControllers = {};
  }

  buildRackPanel(axis, gui) {
    const rackState = this.panel._ensureRackState(axis);
    const folder = gui.addFolder(axis.toUpperCase());
    this.rackControllers[axis] = {
      folder,
      modules: [],
    };

    this.rebuildModuleControllers(axis);
    folder.open();
    return { folder, rackState };
  }

  rebuildModuleControllers(axis) {
    const controllers = this.rackControllers[axis];
    if (!controllers) return;

    this.panel._withRackSync(() => {
      controllers.modules.forEach((moduleCtrl) => {
        try {
          moduleCtrl.controllers?.module?.destroy?.();
          moduleCtrl.controllers?.min?.destroy?.();
          moduleCtrl.controllers?.max?.destroy?.();
          moduleCtrl.controllers?.equilibrium?.destroy?.();
        } catch (_) {}
      });
      controllers.modules = [];

      const rackState = this.panel._ensureRackState(axis);
      
      // Compact the modules array: remove empty slots and move modules up
      this._compactModules(axis, rackState);
      
      // Only show slots that have modules OR the first empty slot
      const visibleSlotCount = this._getVisibleSlotCount(rackState);
      
      for (let index = 0; index < visibleSlotCount; index++) {
        const moduleState = rackState.modules[index];
        const slot = this._createModuleSlotControls(axis, index, moduleState);
        controllers.modules.push(slot);
      }
    });
  }

  handleModuleSelectionChange(axis, index, moduleKey) {
    if (this.panel._isRackSyncing()) return;
    const rackState = this.panel._ensureRackState(axis);
    const moduleState = rackState.modules[index];

    if (moduleKey === 'none') {
      this.panel._resetModuleState(moduleState);
      const changedAxes = this.panel._enforceSingletonConstraints();
      const axesToUpdate = new Set([axis, ...changedAxes]);
      axesToUpdate.forEach((ax) => {
        this.rebuildModuleControllers(ax);
      });
      this.stackEmitter.emit(axis);
      return;
    }

    const [effectId, moduleId] = moduleKey.split('::');
    if (!effectId || !moduleId) return;

    if (moduleState.effectId === effectId && moduleState.moduleId === moduleId) return;

    moduleState.effectId = effectId;
    moduleState.moduleId = moduleId;
    moduleState.inputParamId = this.panel.effectsById[effectId]?.manifest?.inputParam || null;
    moduleState.range = this.moduleRangeManager.createDefaultRange(effectId, moduleId);
    moduleState.settings = undefined;
    moduleState.mappings = this.moduleRangeManager.computeModuleMappings(effectId, moduleId, moduleState.range);

    const changedAxes = this.panel._enforceSingletonConstraints({ keep: { axis, index } });
    const axesToUpdate = new Set([axis, ...changedAxes]);
    axesToUpdate.forEach((ax) => {
      this.rebuildModuleControllers(ax);
    });
    this.stackEmitter.emit(axis);
  }

  handleRangeChange(axis, index, key, rawValue, { shouldBroadcast = true } = {}) {
    if (this.panel._isRackSyncing()) return;
    const rackState = this.panel._ensureRackState(axis);
    const moduleState = rackState.modules[index];
    const domain = this.moduleRangeManager.getDomain(moduleState.effectId, moduleState.moduleId);
    if (!domain) return;

    const range = this.moduleRangeManager.ensureRangeWithinDomain(moduleState, domain);
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;

    const clamped = this.clampNumber(numeric, domain.min, domain.max);
    if (key === 'min') {
      range.min = clamped;
    } else if (key === 'max') {
      range.max = clamped;
    } else if (key === 'equilibrium' || key === 'init') {
      range.equilibrium = clamped;
    }

    moduleState.range = range;
    moduleState.mappings = this.moduleRangeManager.computeModuleMappings(
      moduleState.effectId,
      moduleState.moduleId,
      range,
    );
    if (shouldBroadcast) {
      this.stackEmitter.emit(axis);
    }
    this._updateModuleRangeControllers(axis, index, range, domain);
  }

  emitStacksChange(axis = null) {
    this.stackEmitter.emit(axis);
  }

  _compactModules(axis, rackState) {
    // Move all non-empty modules to the beginning of the array
    const nonEmptyModules = [];
    const emptyModules = [];
    
    rackState.modules.forEach((moduleState) => {
      if (moduleState.effectId && moduleState.moduleId) {
        nonEmptyModules.push(moduleState);
      } else {
        emptyModules.push(moduleState);
      }
    });
    
    // Rebuild the array: non-empty modules first, then empty slots
    rackState.modules.length = 0;
    rackState.modules.push(...nonEmptyModules, ...emptyModules);
  }

  _getVisibleSlotCount(rackState) {
    // Find the index of the last non-empty module
    let lastFilledIndex = -1;
    for (let i = 0; i < rackState.modules.length; i++) {
      if (rackState.modules[i].effectId && rackState.modules[i].moduleId) {
        lastFilledIndex = i;
      }
    }
    
    // Show all filled slots plus one empty slot for adding a new module
    // But don't exceed MAX_MODULES
    const visibleCount = Math.min(lastFilledIndex + 2, rackState.modules.length);
    
    // Always show at least one slot (slot A)
    return Math.max(1, visibleCount);
  }

  _createModuleSlotControls(axis, index, moduleState) {
    const controllers = this.rackControllers[axis];
    const label = index < LABELS.length ? `${LABELS[index]}` : `${index + 1}`;

    const dimensionId = this.panel._ensureRackState(axis).dimensionId;

    const moduleKey =
      moduleState.effectId && moduleState.moduleId
        ? `${moduleState.effectId}::${moduleState.moduleId}`
        : 'none';

    const effectManifest = moduleState.effectId
      ? this.moduleRangeManager.getEffectManifest(moduleState.effectId)
      : null;
    const moduleManifest = moduleState.effectId && moduleState.moduleId
      ? this.moduleRangeManager.getModuleManifest(moduleState.effectId, moduleState.moduleId)
      : null;
    const units = moduleManifest?.valueRange?.units || effectManifest?.userParamSpec?.units || null;

    const formatAxisValue = (value) => (value > 0 ? `+${value}` : `${value}`);
    const axisLabels = {
      min: formatAxisValue(-180),
      equilibrium: formatAxisValue(0),
      max: formatAxisValue(180),
    };
    const excludeKeys = new Set();
    const rackState = this.panel._ensureRackState(axis);
    rackState.modules.forEach((modState, modIndex) => {
      if (!modState?.effectId || !modState?.moduleId) return;
      const key = `${modState.effectId}::${modState.moduleId}`;
      if (modIndex === index) return;
      excludeKeys.add(key);
    });

    if (moduleKey !== 'none') {
      excludeKeys.delete(moduleKey);
    }

    const moduleOptions = this.dimensionCatalog.buildModuleOptions(dimensionId, {
      exclude: excludeKeys,
      includeKey: moduleKey !== 'none' ? moduleKey : null,
      resolveLabel: ({ effectId, module, label, excluded, key }) =>
        this.panel.describeModuleOption({
          effectId,
          moduleId: module.id,
          axis,
          index,
          currentKey: moduleKey,
          optionKey: key,
          baseLabel: label,
          excluded,
        }),
    });

    const slotState = {
      moduleKey,
      min: moduleState.range?.min ?? null,
      max: moduleState.range?.max ?? null,
      equilibrium: moduleState.range?.equilibrium ?? null,
    };

    const slotControllers = {};
    const t = this.getTranslation();
    const moduleName = t('editPanel.rack.moduleSelect', { slot: label });
    const unitSuffix = units ? t('editPanel.rack.unitSuffix', { unit: units }) : '';

    slotControllers.module = controllers.folder
      .add(slotState, 'moduleKey', moduleOptions)
      .name(moduleName)
      .onChange((value) => this.handleModuleSelectionChange(axis, index, value));

    const domain = this.moduleRangeManager.getDomain(moduleState.effectId, moduleState.moduleId);
    if (domain) {
      const range = this.moduleRangeManager.ensureRangeWithinDomain(moduleState, domain);
      slotState.min = range.min;
      slotState.max = range.max;
      slotState.equilibrium = range.equilibrium;

      const step = Math.max((domain.max - domain.min) / 100, 0.001);

      const minLabel = t('editPanel.rack.minLabel', { slot: label, value: axisLabels.min, unit: unitSuffix });
      const minController = controllers.folder
        .add(slotState, 'min', domain.min, domain.max, step)
        .name(minLabel);
      minController.onChange((value) =>
        this.handleRangeChange(axis, index, 'min', value, { shouldBroadcast: false })
      );
      minController.onFinishChange((value) =>
        this.handleRangeChange(axis, index, 'min', value, { shouldBroadcast: true })
      );
      slotControllers.min = minController;

      const maxLabel = t('editPanel.rack.maxLabel', { slot: label, value: axisLabels.max, unit: unitSuffix });
      const maxController = controllers.folder
        .add(slotState, 'max', domain.min, domain.max, step)
        .name(maxLabel);
      maxController.onChange((value) =>
        this.handleRangeChange(axis, index, 'max', value, { shouldBroadcast: false })
      );
      maxController.onFinishChange((value) =>
        this.handleRangeChange(axis, index, 'max', value, { shouldBroadcast: true })
      );
      slotControllers.max = maxController;

      const equilibriumLabel = t('editPanel.rack.equilibriumLabel', {
        slot: label,
        value: axisLabels.equilibrium,
        unit: unitSuffix
      });
      const equilibriumController = controllers.folder
        .add(slotState, 'equilibrium', domain.min, domain.max, step)
        .name(equilibriumLabel);
      equilibriumController.onChange((value) =>
        this.handleRangeChange(axis, index, 'equilibrium', value, { shouldBroadcast: false })
      );
      equilibriumController.onFinishChange((value) =>
        this.handleRangeChange(axis, index, 'equilibrium', value, { shouldBroadcast: true })
      );
      slotControllers.equilibrium = equilibriumController;
    }

    return {
      label,
      units,
      state: slotState,
      controllers: slotControllers,
      domain,
      axisLabels,
    };
  }

  _updateModuleRangeControllers(axis, index, range, domain) {
    const axisControllers = this.rackControllers[axis];
    const slot = axisControllers?.modules?.[index];
    if (!slot) return;

    slot.domain = domain;
    slot.state.min = range.min;
    slot.state.max = range.max;
    slot.state.equilibrium = range.equilibrium;

    const { min: minController, max: maxController, equilibrium: equilibriumController } = slot.controllers;

    if (minController && domain) {
      if (typeof minController.min === 'function') minController.min(domain.min);
      if (typeof minController.max === 'function') minController.max(domain.max);
      minController.updateDisplay?.();
    }
    if (maxController && domain) {
      if (typeof maxController.min === 'function') maxController.min(domain.min);
      if (typeof maxController.max === 'function') maxController.max(domain.max);
      maxController.updateDisplay?.();
    }
    if (equilibriumController && domain) {
      if (typeof equilibriumController.min === 'function') equilibriumController.min(domain.min);
      if (typeof equilibriumController.max === 'function') equilibriumController.max(domain.max);
      equilibriumController.updateDisplay?.();
    }
  }
}
