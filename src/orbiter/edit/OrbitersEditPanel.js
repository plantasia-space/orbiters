import { AVAILABLE_EFFECT_DEFINITIONS, getDimensionCatalogMap } from '../../audio/effects/index.js';
import { getT } from '../../i18n/index.js';
import { DEFAULT_COLOR_C } from './designUtils.js';
import {
  createDefaultStacks,
  cloneStacksState,
  ensureDimensionOnStack,
  ensureAxisLength,
  cloneModuleState,
  getDefaultActiveStackId,
  initializeStackRegistry,
  syncDimensionsForStack,
  setStackRegistryActiveDimension,
  getScopedState,
  setScopedState,
  listUiComponents,
  UI_COMPONENT_SCOPES,
} from '../../core/stackUtils.js';
import { clearMonitorDisplay } from '../../utils/monitorUtils.js';
import { DesignPanel } from './DesignPanel.js';
import { CUSTOM_THEME_VALUE } from './ThemePresetController.js';
import { ModuleRangeManager } from './ModuleRangeManager.js';
import { DimensionModuleCatalog } from './DimensionModuleCatalog.js';
import { StackChangeEmitter } from './StackChangeEmitter.js';
import { RackPanelManager } from './RackPanelManager.js';
// The one narrow vanilla↔React boundary: in Studio mode this panel publishes itself as
// the bridge for the React Orbiter Studio (which renders it under the play-UI providers) instead of
// mounting its own root. The store is React-free (a type-only import of the bridge shape, erased at
// build), so importing it on the default lil-gui path adds no React to the bundle.
import { setEditBridge, notifyEditBridge } from './react/editBridgeStore';
import {
  isVisualFeedbackEnabled,
  setVisualFeedbackEnabled,
} from '../../visual/visualFeedbackSettings.js';

const AXES = ['x', 'y', 'z'];
const SPEED_LABEL = 'speed';
const SPEED_EFFECT_ID = 'tone.tempoPitch';
const NEBULA_EFFECT_ID = 'tone.reverb';
const JC_EFFECT_ID = 'tone.jcreverb';
const SINGLETON_EFFECT_IDS = new Set([SPEED_EFFECT_ID, NEBULA_EFFECT_ID, JC_EFFECT_ID]);
const SINGLETON_EFFECT_LABEL_KEYS = new Map([
  [SPEED_EFFECT_ID, 'editPanel.singletonLabels.speed'],
  [NEBULA_EFFECT_ID, 'editPanel.singletonLabels.nebulaReverb'],
  [JC_EFFECT_ID, 'editPanel.singletonLabels.jcReverb'],
]);

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function buildEffectCatalog() {
  return AVAILABLE_EFFECT_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    version: definition.version,
    authoring: definition.authoring || null,
    manifest: definition.manifest,
  }));
}

function findEffectManifest(effectId) {
  return AVAILABLE_EFFECT_DEFINITIONS.find((definition) => definition.id === effectId)?.manifest || null;
}

function findModuleManifest(effectManifest, moduleId) {
  if (!effectManifest) return null;
  return effectManifest.modules?.find((module) => module.id === moduleId) || null;
}

function moduleLabel(effectLabel, moduleLabel) {
  return `${effectLabel} › ${moduleLabel}`;
}

export class OrbitersEditPanel {
  /**
   * @param {object} [options]
   * @param {object} [options.design] - The live design object the panel edits in place.
   * @param {object} [options.stacks] - The dimension stacks the racks are built from.
   * @param {(design: Record<string, unknown>) => void} [options.onDesignChange]
   * @param {(payload: Record<string, unknown>) => void} [options.onStacksChange]
   * @param {(axis: string, updated: Record<string, unknown>) => void} [options.onRackChange]
   * @param {() => void} [options.onAnyChange] - Any change worth saving: emits the session.
   * @param {string|null} [options.voiceId] - The voice being edited.
   */
  constructor({
    design,
    stacks,
    onDesignChange,
    onStacksChange,
    onRackChange,
    onAnyChange,
    // The voice being edited — the per-module visual switches are its orbiter's
    // choice, and edit mode is the one place that knows which voice that is.
    voiceId = null,
  } = {}) {
    this.voiceId = voiceId;
    this.t = getT();
    this._languageChangeHandler = () => {
      this.t = getT();
      this.dimensionList = this.dimensionList.map((dimension) => {
        if (dimension && dimension.id != null) {
          return dimension;
        }
        return {
          ...dimension,
          label: this.t('editPanel.dimension.none'),
        };
      });
      this._rebuildDimensionOptions();
      if (this.gui) {
        this.mount().catch((error) => {
          console.error('[OrbitersEditPanel] Failed to remount after language change:', error);
        });
      } else if (this._studioRegistered) {
        // Studio mode has no lil-gui to remount; just re-render the React panel off new i18n.
        notifyEditBridge();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('languageChanged', this._languageChangeHandler);
    }

    this.design = {
      colorPrimary: '#ffffff',
      colorSecondary: '#151515',
      // Color C — selected/active "success" highlight; defaults to the long-standing green.
      colorC: DEFAULT_COLOR_C,
      roundedCorners: 12,
      ringColor: null,
      ringAmplitudeMultiplier: 1,
      ringRadiusMultiplier: 1,
      ringEnabled: true,
      fontFamily: 'Inter, sans-serif',
      fontId: null,
      fontImportUrl: null,
      themeId: null,
      themeLabel: null,
      themeVariant: null,
      frameBorderWidth: 2,
      ...(design || {}),
    };
    if (typeof this.design.ringColor !== 'string' || !this.design.ringColor.trim()) {
      this.design.ringColor = this.design.colorSecondary;
    }
    if (!Number.isFinite(this.design.ringAmplitudeMultiplier)) {
      this.design.ringAmplitudeMultiplier = 1;
    }
    if (!Number.isFinite(this.design.ringRadiusMultiplier)) {
      this.design.ringRadiusMultiplier = 1;
    }
    this.design.ringEnabled = this.design.ringEnabled !== false;

    this.onDesignChange = onDesignChange;
    this.onRackChange = onRackChange;
    this.onStacksChange = onStacksChange;
    this.onAnyChange = onAnyChange;

    this.gui = null;
    this.folderRefs = {};
    this.dragState = null;
    // React-panel handles (only set when the React panel is mounted behind the flag).
    this._reactContainer = null;
    this._reactUnmount = null;
    this._reactRefresh = null;
    this.globalDesign = { ...this.design };
    this.designByDimension = new Map();
    this.designPanel = new DesignPanel({
      design: this.design,
      getTranslation: () => this.t
    });

    this.effectCatalog = buildEffectCatalog();
    this.effectsById = this.effectCatalog.reduce((acc, effect) => {
      acc[effect.id] = effect;
      return acc;
    }, {});
    this.dimensions = this._buildDimensions();
    this.dimensionList = Array.from(this.dimensions.values());
    if (!this.dimensionList.length) {
      this.dimensionList = [{ id: null, label: this.t('editPanel.dimension.none'), effects: [] }];
    }
    this.defaultDimensionId = this.dimensionList[0]?.id ?? null;
    this._rebuildDimensionOptions();

    const componentCatalog = listUiComponents();
    this.componentCatalog = componentCatalog;
    this.componentMetadataById = componentCatalog.reduce((acc, component) => {
      acc[component.id] = component;
      return acc;
    }, {});

    this.stacks = this._initializeStacks(stacks);
    this.activeStackId = getDefaultActiveStackId(this.stacks) ?? 'deck-i';
    this.activeDimensionId = this.defaultDimensionId;
    this._initializeRegistryForStacks();
    setStackRegistryActiveDimension(this.activeStackId, this.activeDimensionId);

    this._onResizeBound = null;
    this._elState = new WeakMap();
    this._rackSyncDepth = 0;

    this.dimensionControllerState = { dimensionId: this.activeDimensionId };
    this.stackControllerState = { stackId: this.activeStackId };

    this.moduleRangeManager = new ModuleRangeManager({
      findEffectManifest,
      findModuleManifest,
      clampNumber,
    });
    this.dimensionCatalog = new DimensionModuleCatalog({
      getDimensions: () => this.dimensions,
      moduleLabel,
      resolveIncludedModule: (moduleKey) => this._resolveIncludedModule(moduleKey),
    });
    this.stackEmitter = new StackChangeEmitter({
      isRackSyncing: () => this._isRackSyncing(),
      getStacks: () => this.stacks,
      getActiveStackId: () => this.activeStackId,
      getActiveDimensionId: () => this.activeDimensionId,
      onStacksChange: this.onStacksChange,
      onRackChange: this.onRackChange,
      onAnyChange: this.onAnyChange,
      ensureRackState: (axis) => this._ensureRackState(axis),
    });
    this.rackManager = new RackPanelManager({
      panel: this,
      clampNumber,
      moduleRangeManager: this.moduleRangeManager,
      dimensionCatalog: this.dimensionCatalog,
      stackEmitter: this.stackEmitter,
    });

    this._rebuildActiveRackLens();
    this._enforceSingletonConstraints();
    this._hydrateDesignCacheFromStacks(this.stacks);
    this._syncDesignFromCache({ force: true });
  }

  _withRackSync(callback) {
    this._rackSyncDepth += 1;
    try {
      return callback();
    } finally {
      this._rackSyncDepth = Math.max(0, this._rackSyncDepth - 1);
    }
  }

  _isRackSyncing() {
    return this._rackSyncDepth > 0;
  }

  _buildDimensions() {
    return getDimensionCatalogMap({ includeDeprecated: false });
  }

  _resolveIncludedModule(moduleKey) {
    if (typeof moduleKey !== 'string' || !moduleKey.includes('::')) {
      return null;
    }
    const [effectId, moduleId] = moduleKey.split('::');
    if (!effectId || !moduleId) return null;

    const effect = this.effectsById?.[effectId];
    const manifest = effect?.manifest ?? findEffectManifest(effectId);
    const module = findModuleManifest(manifest, moduleId);
    if (!effect || !module) return null;

    return {
      effectId,
      effectLabel: effect.label ?? manifest?.label ?? effectId,
      module,
      legacyLabel: effect.authoring?.legacyLabel ?? null,
    };
  }

  _rebuildDimensionOptions() {
    this.dimensionOptions = this.dimensionList.reduce((acc, pkg) => {
      const optionLabel =
        pkg && pkg.id != null
          ? pkg.label
          : this.t('editPanel.dimension.none');
      acc[optionLabel] = pkg?.id ?? this.defaultDimensionId;
      return acc;
    }, {});
  }

  _normalizeLabel(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  _getSingletonLabel(effectId) {
    const key = SINGLETON_EFFECT_LABEL_KEYS.get(effectId) || 'editPanel.singletonLabels.default';
    return this.t(key);
  }

  _resolveSingletonKey(effectId, moduleId = null) {
    if (!effectId) return null;
    if (SINGLETON_EFFECT_IDS.has(effectId)) {
      return effectId;
    }

    const effect = this.effectsById?.[effectId];
    const effectLabel = this._normalizeLabel(effect?.label ?? effect?.manifest?.label);
    if (effectLabel === SPEED_LABEL) {
      return SPEED_EFFECT_ID;
    }

    if (moduleId) {
      const manifest = effect?.manifest ?? findEffectManifest(effectId);
      const moduleManifest = findModuleManifest(manifest, moduleId);
      const moduleLabel = this._normalizeLabel(moduleManifest?.label);
      if (moduleLabel === SPEED_LABEL) {
        return SPEED_EFFECT_ID;
      }
    }

    return null;
  }

  _isSingletonEffect(effectId, moduleId = null) {
    const key = this._resolveSingletonKey(effectId, moduleId) ?? effectId;
    return key ? SINGLETON_EFFECT_IDS.has(key) : false;
  }

  _getActiveSingletonSlots(effectKey) {
    if (!effectKey || !SINGLETON_EFFECT_IDS.has(effectKey)) return [];
    const slots = [];
    AXES.forEach((axis) => {
      const rack = this.racks?.[axis];
      if (!rack?.modules) return;
      rack.modules.forEach((moduleState, index) => {
        if (!moduleState?.effectId || !moduleState?.moduleId) return;
        const moduleKey = this._resolveSingletonKey(moduleState.effectId, moduleState.moduleId);
        if (moduleKey === effectKey) {
          slots.push({
            axis,
            index,
            key: `${moduleState.effectId}::${moduleState.moduleId}`,
          });
        }
      });
    });
    return slots;
  }

  _shouldAllowSingletonSelection(effectId, axis, index, moduleId = null) {
    const singletonKey = this._resolveSingletonKey(effectId, moduleId);
    if (!singletonKey) return true;
    const activeSlots = this._getActiveSingletonSlots(singletonKey);
    if (!activeSlots.length) return true;
    return activeSlots.some((slot) => slot.axis === axis && slot.index === index);
  }

  _resetModuleState(moduleState) {
    if (!moduleState) return;
    moduleState.effectId = null;
    moduleState.moduleId = null;
    moduleState.inputParamId = null;
    moduleState.range = { min: null, max: null, equilibrium: null };
    moduleState.settings = undefined;
    moduleState.mappings = [];
  }

  _enforceSingletonConstraint(effectId, { keep } = {}) {
    if (!effectId || !SINGLETON_EFFECT_IDS.has(effectId)) return new Set();

    const activeSlots = this._getActiveSingletonSlots(effectId);
    if (activeSlots.length <= 1) return new Set();

    let keeper = null;
    if (keep) {
      const rack = this.racks?.[keep.axis];
      const moduleState = rack?.modules?.[keep.index];
      if (moduleState?.effectId === effectId) {
        keeper = { axis: keep.axis, index: keep.index };
      }
    }
    if (!keeper && activeSlots.length) {
      [keeper] = activeSlots;
    }

    const changedAxes = new Set();
    activeSlots.forEach((slot) => {
      const shouldKeep = keeper && slot.axis === keeper.axis && slot.index === keeper.index;
      if (shouldKeep) return;
      const rack = this.racks?.[slot.axis];
      const moduleState = rack?.modules?.[slot.index];
      if (!moduleState) return;
      const moduleKey = this._resolveSingletonKey(moduleState.effectId, moduleState.moduleId);
      if (moduleKey !== effectId) return;
      this._resetModuleState(moduleState);
      changedAxes.add(slot.axis);
    });

    return changedAxes;
  }

  _enforceSingletonConstraints({ keep } = {}) {
    const changedAxes = new Set();
    SINGLETON_EFFECT_IDS.forEach((effectId) => {
      const result = this._enforceSingletonConstraint(effectId, { keep });
      result.forEach((axis) => changedAxes.add(axis));
    });
    return changedAxes;
  }

  describeModuleOption({
    effectId,
    moduleId,
    axis,
    index,
    currentKey = null,
    optionKey = null,
    baseLabel,
    excluded = false,
  }) {
    if (!effectId) return baseLabel;

    let label = baseLabel;
    if (excluded) {
      label = this.t('editPanel.moduleOption.inUse', { label: baseLabel });
    }

    const singletonKey = this._resolveSingletonKey(effectId, moduleId);
    if (!singletonKey || !SINGLETON_EFFECT_IDS.has(singletonKey)) {
      return label;
    }

    const isCurrent = currentKey === optionKey;
    const allowed = this._shouldAllowSingletonSelection(effectId, axis, index, moduleId);

    const singletonLabel = this._getSingletonLabel(singletonKey);

    if (!allowed && !isCurrent) {
      return this.t('editPanel.moduleOption.uniqueUnavailable', { label, singletonLabel });
    }

    return this.t('editPanel.moduleOption.unique', { label, singletonLabel });
  }

  async mount() {
    // React is the only edit UI: publish this panel as the bridge for the React Orbiter Studio.
    await this._registerStudioBridge();
  }

  /**
   * Studio mode (`?reactEditPanel=1`, which implies `?ui=react`): instead of mounting its
   * own React root (the old floating panel), this panel publishes ITSELF as the bridge so the
   * React Orbiter Studio renders it in the shell's right placeholder — under the play-UI providers
   * (EngineProvider / NumericKeyboard / Icon). The React controls drive the SAME handlers, so the
   * iframe autosave snapshot keeps reflecting edits (single source of truth). `refresh` becomes a
   * store notify so external pushes (setDesign / updateStacksConfig / updateRackConfig) re-render.
   * Dynamically imported so the store/React stay out of the bundle on the default lil-gui path.
   */
  _registerStudioBridge() {
    this.dispose();
    this._studioRegistered = true;
    this._reactRefresh = notifyEditBridge;
    setEditBridge(this);
  }

  /**
   * Single design-change sink shared by the lil-gui DesignPanel and the React panel:
   * applies an optional patch to the live design object, records it, and emits. The lil-gui path
   * mutates `this.design` via its own controllers then calls this with no patch; React passes a patch.
   */
  applyDesignChange(patch = null) {
    if (patch && typeof patch === 'object') {
      Object.assign(this.design, patch);
    }
    this._recordActiveDesign({ hasOverride: Boolean(this.activeDimensionId) });
    this.onDesignChange?.({ ...this.design });
    this.onAnyChange?.();
  }

  /**
   * Whether the module on this axis of the ACTIVE dimension answers in the world.
   * The switch writes to the visual store and emits — it never touches the module's
   * audio settings, so the effect keeps playing through the change.
   *
   * @param {'x'|'y'|'z'} axis
   * @param {boolean} enabled
   */
  applyVisualFeedbackChange(axis, enabled) {
    setVisualFeedbackEnabled(this.voiceId, this.activeDimensionId, axis, enabled);
    this.onAnyChange?.();
  }

  /**
   * @param {'x'|'y'|'z'} axis
   * @returns {boolean}
   */
  readVisualFeedback(axis) {
    return isVisualFeedbackEnabled(this.voiceId, this.activeDimensionId, axis);
  }

  dispose() {
    if (this._studioRegistered) {
      // Studio mode: we never created a root — just retract the published bridge so the
      // React Studio renders nothing (and any stale handlers can't be driven).
      setEditBridge(null);
      this._studioRegistered = false;
    }
    if (this._reactUnmount) {
      try { this._reactUnmount(); } catch (_) {}
    }
    this._reactUnmount = null;
    this._reactRefresh = null;
    if (this._reactContainer?.parentElement) {
      try { this._reactContainer.parentElement.removeChild(this._reactContainer); } catch (_) {}
    }
    this._reactContainer = null;
    if (this._onResizeBound) {
      window.removeEventListener('resize', this._onResizeBound);
      this._onResizeBound = null;
    }
    if (this.gui) {
      try { this.gui.destroy?.(); } catch (_) {}
      const el = this.gui?.domElement;
      if (el?.parentElement) {
        try { el.parentElement.removeChild(el); } catch (_) {}
      }
    }
    this.gui = null;
    this.folderRefs = {};
    this.rackManager?.dispose();
    if (this.designPanel) {
      this.designPanel.folder = null;
      this.designPanel.controllers = {};
      this.designPanel.fontController = null;
      this.designPanel.fontOptions = null;
    }
    this.designByDimension.clear();
  }

  updateStacksConfig(nextStacks = {}, { syncDimensionController = true } = {}) {
    const incomingStacks = nextStacks?.stacks ? nextStacks.stacks : nextStacks;
    const nextActiveStackId = nextStacks?.activeStackId ?? this.activeStackId;
    const nextActiveDimensionId = nextStacks?.activeDimensionId ?? this.activeDimensionId;

    this.stacks = this._initializeStacks(incomingStacks);
    this.activeStackId = nextActiveStackId;
    this.activeDimensionId = this.dimensions.has(nextActiveDimensionId) ? nextActiveDimensionId : this.defaultDimensionId;
    const previousDimension = this.activeDimensionId;
    if (!this.dimensions.has(previousDimension)) {
      this.activeDimensionId = this.defaultDimensionId;
    }
    this._hydrateDesignCacheFromStacks(this.stacks);
    this.dimensionControllerState.dimensionId = this.activeDimensionId;
    if (this.dimensionController) {
      if (syncDimensionController && typeof this.dimensionController.setValue === 'function') {
        this.dimensionController.setValue(this.activeDimensionId);
      }
      this.dimensionController.updateDisplay?.();
    }
    this._syncRegistryDimensions({ activeDimensionId: this.activeDimensionId });
    setStackRegistryActiveDimension(this.activeStackId, this.activeDimensionId);
    this._rebuildActiveRackLens();
    AXES.forEach((axis) => this._rebuildModuleControllers(axis));
    const activeDimension = this._ensureActiveDimension();
    if (activeDimension?.design && typeof activeDimension.design === 'object') {
      this.setDesign(activeDimension.design, { silent: true, forceSync: true, recordOverride: true });
    } else {
      const fallback = this._resolveCachedDesign();
      this.setDesign(fallback || null, { silent: true, forceSync: true, recordOverride: false });
    }
  }

  updateRackConfig(axis, config = {}, { syncDimensionController = true } = {}) {
    if (!AXES.includes(axis)) return;
    const dimensionId = config?.dimensionId ?? this.activeDimensionId ?? this.defaultDimensionId;
    if (this.activeDimensionId !== dimensionId) {
      this.activeDimensionId = dimensionId;
      this.dimensionControllerState.dimensionId = dimensionId;
      this._syncDesignFromCache({ force: true });
      if (this.dimensionController) {
        if (syncDimensionController && typeof this.dimensionController.setValue === 'function') {
          this.dimensionController.setValue(this.activeDimensionId);
        }
        this.dimensionController.updateDisplay?.();
      }
      setStackRegistryActiveDimension(this.activeStackId, this.activeDimensionId);
    }
    const dimension = this._ensureActiveDimension();
    const axisState = dimension.axes[axis];
    ensureAxisLength(axisState);
    const incomingModules = Array.isArray(config?.modules) ? config.modules : [];
    axisState.modules.forEach((moduleState, index) => {
      const incoming = incomingModules[index];
      if (incoming) {
        axisState.modules[index] = cloneModuleState(incoming, { includeDimensionMetadata: false });
      } else {
        this._resetModuleState(axisState.modules[index]);
      }
    });
    this._rebuildActiveRackLens();
    this._rebuildModuleControllers(axis);
    // External rack pushes must re-render the React panel (no-op when lil-gui is active).
    this._reactRefresh?.();
  }

  loadExternalStacks({ stacks, selection } = {}) {
    if (!stacks || typeof stacks !== 'object') {
      return false;
    }

    const normalizedStacks = this._initializeStacks(stacks);
    const nextActiveStackId =
      selection?.activeStackId ??
      getDefaultActiveStackId(normalizedStacks) ??
      this.activeStackId ??
      Object.keys(normalizedStacks)[0];
    const nextActiveDimensionId =
      selection?.activeDimensionId ?? this.activeDimensionId ?? this.defaultDimensionId;

    this.updateStacksConfig(
      {
        stacks: normalizedStacks,
        activeStackId: nextActiveStackId,
        activeDimensionId: nextActiveDimensionId,
      },
      { syncDimensionController: true }
    );

    return true;
  }

  getScopedComponentState(componentId, { stackId = this.activeStackId, dimensionId = null } = {}) {
    const metadata = this._getComponentMetadata(componentId);
    if (!metadata) return undefined;
    const targetStackId = stackId ?? this.activeStackId;
    this._ensureStackRegistry(targetStackId);
    if (metadata.scope === UI_COMPONENT_SCOPES.UNIQUE) {
      return getScopedState(targetStackId, componentId);
    }
    const resolvedDimensionId = dimensionId ?? this.activeDimensionId ?? this.defaultDimensionId;
    if (!resolvedDimensionId) return undefined;
    return getScopedState(targetStackId, componentId, { dimensionId: resolvedDimensionId });
  }

  setScopedComponentState(
    componentId,
    value,
    { stackId = this.activeStackId, dimensionId = null } = {},
  ) {
    const metadata = this._getComponentMetadata(componentId);
    if (!metadata) return false;
    const targetStackId = stackId ?? this.activeStackId;
    this._ensureStackRegistry(targetStackId);
    if (metadata.scope === UI_COMPONENT_SCOPES.UNIQUE) {
      return setScopedState(targetStackId, componentId, value);
    }
    const resolvedDimensionId = dimensionId ?? this.activeDimensionId ?? this.defaultDimensionId;
    if (!resolvedDimensionId) return false;
    return setScopedState(targetStackId, componentId, value, { dimensionId: resolvedDimensionId });
  }

  _initializeStacks(initialStacks) {
    const stacks = initialStacks
      ? cloneStacksState(initialStacks)
      : createDefaultStacks();

    Object.values(stacks).forEach((stack) => {
      if (!stack.dimensions || typeof stack.dimensions !== 'object') {
        stack.dimensions = {};
      }
      Object.values(stack.dimensions).forEach((dimension) => {
        if (!dimension.axes || typeof dimension.axes !== 'object') {
          dimension.axes = {
            x: { modules: [] },
            y: { modules: [] },
            z: { modules: [] },
          };
        }
        AXES.forEach((axis) => {
          ensureAxisLength(dimension.axes[axis]);
        });
      });
    });

    return stacks;
  }

  _hydrateDesignCacheFromStacks(stacks = this.stacks) {
    if (!stacks || typeof stacks !== 'object') return;
    const seen = new Set();
    Object.values(stacks).forEach((stack) => {
      if (!stack || typeof stack !== 'object' || !stack.dimensions) return;
      Object.values(stack.dimensions).forEach((dimension) => {
        if (!dimension || typeof dimension !== 'object') return;
        const { dimensionId, design: designState } = dimension;
        if (!dimensionId) return;
        seen.add(dimensionId);
        if (designState && typeof designState === 'object') {
          this.designByDimension.set(dimensionId, { ...designState });
        } else {
          this.designByDimension.delete(dimensionId);
        }
      });
    });
    Array.from(this.designByDimension.keys()).forEach((dimensionId) => {
      if (!seen.has(dimensionId)) {
        this.designByDimension.delete(dimensionId);
      }
    });
  }

  _resolveCachedDesign(dimensionId = this.activeDimensionId) {
    if (dimensionId && this.designByDimension.has(dimensionId)) {
      return this.designByDimension.get(dimensionId);
    }
    return this.globalDesign;
  }

  _recordActiveDesign({ hasOverride = true } = {}) {
    if (this.activeDimensionId) {
      if (hasOverride) {
        this.designByDimension.set(this.activeDimensionId, { ...this.design });
      } else {
        this.designByDimension.delete(this.activeDimensionId);
      }
      if (!hasOverride) {
        this.globalDesign = { ...this.design };
      }
    } else {
      this.globalDesign = { ...this.design };
    }

    const activeDimension = this._ensureActiveDimension();
    if (activeDimension) {
      activeDimension.design = hasOverride ? { ...this.design } : null;
    }
  }

  _syncDesignFromCache({ force = false } = {}) {
    const cached = this._resolveCachedDesign();
    const hasOverride = Boolean(this.activeDimensionId && this.designByDimension.has(this.activeDimensionId));
    this.setDesign(cached || null, {
      silent: true,
      forceSync: force,
      recordOverride: hasOverride,
    });
  }

  _dimensionDefinitions() {
    return this.dimensionList.map((dimension) => ({
      id: dimension.id,
      label: dimension.label ?? dimension.id,
    }));
  }

  _ensureStackRegistry(stackId) {
    if (!stackId) return;
    initializeStackRegistry(stackId, {
      dimensions: this._dimensionDefinitions(),
      activeDimensionId: this.activeDimensionId,
    });
  }

  _initializeRegistryForStacks() {
    Object.values(this.stacks).forEach((stack) => {
      this._ensureStackRegistry(stack.id);
    });
  }

  _syncRegistryDimensions({ activeDimensionId = this.activeDimensionId } = {}) {
    Object.values(this.stacks).forEach((stack) => {
      syncDimensionsForStack(stack.id, this._dimensionDefinitions(), {
        activeDimensionId,
      });
    });
  }

  _getComponentMetadata(componentId) {
    if (!componentId) return null;
    return this.componentMetadataById?.[componentId] ?? null;
  }

  _lookupDimensionLabel(dimensionId) {
    if (!dimensionId) return null;
    const record = this.dimensions.get(dimensionId);
    return record?.label ?? dimensionId;
  }

  _ensureActiveStack() {
    if (!this.stacks) {
      this.stacks = createDefaultStacks();
    }
    if (!this.stacks[this.activeStackId]) {
      const defaults = createDefaultStacks();
      this.stacks[this.activeStackId] = defaults[this.activeStackId] || {
        id: this.activeStackId,
        kind: 'deck',
        label: this.activeStackId,
        enabled: true,
        dimensions: {},
      };
    }
    this._ensureStackRegistry(this.activeStackId);
    syncDimensionsForStack(this.activeStackId, this._dimensionDefinitions(), {
      activeDimensionId: this.activeDimensionId,
    });
    return this.stacks[this.activeStackId];
  }

  _ensureActiveDimension() {
    const stack = this._ensureActiveStack();
    const dimensionLabel = this._lookupDimensionLabel(this.activeDimensionId);
    const dimension = ensureDimensionOnStack(stack, this.activeDimensionId, {
      dimensionLabel,
      createIfMissing: true,
    });
    if (dimension?.design && typeof dimension.design === 'object') {
      this.designByDimension.set(dimension.dimensionId, { ...dimension.design });
    } else if (this.designByDimension.has(dimension.dimensionId)) {
      dimension.design = { ...this.designByDimension.get(dimension.dimensionId) };
    }

    AXES.forEach((axis) => {
      ensureAxisLength(dimension.axes[axis]);
    });
    if (stack?.id) {
      setStackRegistryActiveDimension(stack.id, dimension.dimensionId);
    }
    return dimension;
  }

  _rebuildActiveRackLens() {
    const dimension = this._ensureActiveDimension();
    this.racks = {};
    AXES.forEach((axis) => {
      const axisState = dimension.axes[axis];
      ensureAxisLength(axisState);
      this.racks[axis] = {
        dimensionId: dimension.dimensionId,
        modules: axisState.modules,
      };
    });
  }

  setDesign(nextDesign = null, { silent = true, forceSync = false, recordOverride = null } = {}) {
    const normalizeColor = (value, fallback) => {
      if (typeof value !== 'string') return fallback;
      const trimmed = value.trim();
      return trimmed.length ? trimmed : fallback;
    };

    const clampNumberValue = (value, min, max, fallback) => {
      if (!Number.isFinite(value)) return fallback;
      return clampNumber(value, min, max);
    };

    const previousSnapshot = {
      colorPrimary: this.design.colorPrimary,
      colorSecondary: this.design.colorSecondary,
      colorC: this.design.colorC,
      roundedCorners: this.design.roundedCorners,
      frameBorderWidth: this.design.frameBorderWidth,
      ringColor: this.design.ringColor,
      ringAmplitudeMultiplier: this.design.ringAmplitudeMultiplier,
      ringRadiusMultiplier: this.design.ringRadiusMultiplier,
      ringEnabled: this.design.ringEnabled,
      fontId: this.design.fontId,
      fontFamily: this.design.fontFamily,
      fontImportUrl: this.design.fontImportUrl,
      fontLabel: this.design.fontLabel,
      themeId: this.design.themeId,
      themeLabel: this.design.themeLabel,
      themeVariant: this.design.themeVariant,
    };

    this.designPanel?.setDesignReference(this.design);

    const cachedFallback = this._resolveCachedDesign();
    const source =
      nextDesign && typeof nextDesign === 'object'
        ? nextDesign
        : cachedFallback || this.design || this.globalDesign;

    this.design.colorPrimary = normalizeColor(
      source?.colorPrimary ?? cachedFallback?.colorPrimary ?? this.design.colorPrimary,
      this.design.colorPrimary,
    );
    this.design.colorSecondary = normalizeColor(
      source?.colorSecondary ?? cachedFallback?.colorSecondary ?? this.design.colorSecondary,
      this.design.colorSecondary,
    );
    this.design.colorC = normalizeColor(
      source?.colorC ?? cachedFallback?.colorC ?? this.design.colorC,
      this.design.colorC,
    );
    this.design.ringColor = normalizeColor(
      source?.ringColor ?? cachedFallback?.ringColor ?? this.design.ringColor,
      this.design.ringColor,
    );
    this.design.roundedCorners = clampNumberValue(
      Number(source?.roundedCorners ?? cachedFallback?.roundedCorners ?? this.design.roundedCorners),
      0,
      64,
      this.design.roundedCorners,
    );
    this.design.frameBorderWidth = clampNumberValue(
      Number(source?.frameBorderWidth ?? cachedFallback?.frameBorderWidth ?? this.design.frameBorderWidth),
      0,
      12,
      this.design.frameBorderWidth,
    );
    this.design.ringAmplitudeMultiplier = clampNumberValue(
      Number(source?.ringAmplitudeMultiplier ?? cachedFallback?.ringAmplitudeMultiplier ?? this.design.ringAmplitudeMultiplier),
      0,
      10,
      this.design.ringAmplitudeMultiplier,
    );
    this.design.ringRadiusMultiplier = clampNumberValue(
      Number(source?.ringRadiusMultiplier ?? cachedFallback?.ringRadiusMultiplier ?? this.design.ringRadiusMultiplier),
      0,
      5,
      this.design.ringRadiusMultiplier,
    );
    const ringEnabledSource = (source && Object.prototype.hasOwnProperty.call(source, 'ringEnabled'))
      ? source.ringEnabled
      : (cachedFallback && Object.prototype.hasOwnProperty.call(cachedFallback, 'ringEnabled'))
        ? cachedFallback.ringEnabled
        : this.design.ringEnabled;
    this.design.ringEnabled = ringEnabledSource !== false;
    if (Object.prototype.hasOwnProperty.call(source || {}, 'fontId') || this.design.fontId === undefined) {
      this.design.fontId = source?.fontId ?? cachedFallback?.fontId ?? this.design.fontId ?? null;
    }
    if (source?.fontFamily || cachedFallback?.fontFamily) {
      this.design.fontFamily = String(source?.fontFamily ?? cachedFallback?.fontFamily ?? this.design.fontFamily);
    }
    if (Object.prototype.hasOwnProperty.call(source || {}, 'fontImportUrl') ||
        Object.prototype.hasOwnProperty.call(cachedFallback || {}, 'fontImportUrl')) {
      this.design.fontImportUrl = (source?.fontImportUrl ?? cachedFallback?.fontImportUrl) || null;
    }
    if (Object.prototype.hasOwnProperty.call(source || {}, 'fontLabel') ||
        Object.prototype.hasOwnProperty.call(cachedFallback || {}, 'fontLabel')) {
      this.design.fontLabel = source?.fontLabel ?? cachedFallback?.fontLabel ?? this.design.fontLabel ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(source || {}, 'themeId') ||
        Object.prototype.hasOwnProperty.call(cachedFallback || {}, 'themeId')) {
      const themeIdSource = source?.themeId ?? cachedFallback?.themeId ?? this.design.themeId ?? null;
      this.design.themeId = themeIdSource === CUSTOM_THEME_VALUE ? null : themeIdSource ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(source || {}, 'themeLabel') ||
        Object.prototype.hasOwnProperty.call(cachedFallback || {}, 'themeLabel')) {
      this.design.themeLabel = source?.themeLabel ?? cachedFallback?.themeLabel ?? this.design.themeLabel ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(source || {}, 'themeVariant') ||
        Object.prototype.hasOwnProperty.call(cachedFallback || {}, 'themeVariant')) {
      this.design.themeVariant = source?.themeVariant ?? cachedFallback?.themeVariant ?? this.design.themeVariant ?? null;
    }

    const changed =
      previousSnapshot.colorPrimary !== this.design.colorPrimary ||
      previousSnapshot.colorSecondary !== this.design.colorSecondary ||
      previousSnapshot.colorC !== this.design.colorC ||
      previousSnapshot.roundedCorners !== this.design.roundedCorners ||
      previousSnapshot.frameBorderWidth !== this.design.frameBorderWidth ||
      previousSnapshot.ringColor !== this.design.ringColor ||
      previousSnapshot.ringAmplitudeMultiplier !== this.design.ringAmplitudeMultiplier ||
      previousSnapshot.ringRadiusMultiplier !== this.design.ringRadiusMultiplier ||
      previousSnapshot.ringEnabled !== this.design.ringEnabled ||
      previousSnapshot.fontId !== this.design.fontId ||
      previousSnapshot.fontFamily !== this.design.fontFamily ||
      previousSnapshot.fontImportUrl !== this.design.fontImportUrl ||
      previousSnapshot.fontLabel !== this.design.fontLabel ||
      previousSnapshot.themeId !== this.design.themeId ||
      previousSnapshot.themeLabel !== this.design.themeLabel ||
      previousSnapshot.themeVariant !== this.design.themeVariant;

    const shouldSync = changed || forceSync;

    const hasOverride =
      recordOverride !== null
        ? recordOverride
        : Boolean(nextDesign && typeof nextDesign === 'object' && this.activeDimensionId);

    if (this.activeDimensionId) {
      if (hasOverride) {
        this.designByDimension.set(this.activeDimensionId, { ...this.design });
      } else {
        this.designByDimension.delete(this.activeDimensionId);
      }
    } else {
      this.globalDesign = { ...this.design };
    }
    if (!hasOverride) {
      this.globalDesign = { ...this.design };
    }
    const activeDimension = this._ensureActiveDimension();
    if (activeDimension) {
      activeDimension.design = hasOverride ? { ...this.design } : null;
    }

    if (!shouldSync) {
      return false;
    }

    this.designPanel?.syncFromDesign();
    this._syncDesignControllers();

    if (!silent) {
      this.onDesignChange?.({ ...this.design });
      this.onAnyChange?.();
    }

    // External design pushes must re-render the React panel (no-op when lil-gui is active).
    this._reactRefresh?.();
    return true;
  }

  _syncDesignControllers() {
    this.designPanel?.syncControllers();
  }

  _handleActiveDimensionChange(nextDimensionId) {
    const targetId = this.dimensions.has(nextDimensionId) ? nextDimensionId : this.defaultDimensionId;
    if (this.activeDimensionId === targetId) {
      return;
    }
    
    const previousDimensionId = this.activeDimensionId;
    this.activeDimensionId = targetId;
    this.dimensionControllerState.dimensionId = targetId;
    
    
    
    // Clear monitor before switching dimension
    clearMonitorDisplay();
    
    this._syncDesignFromCache({ force: true });
    this._rebuildActiveRackLens();
    AXES.forEach((axis) => this._rebuildModuleControllers(axis));
    
    // Notify WorldModeController about dimension change via onStacksChange
    if (this.onStacksChange) {
      this.onStacksChange({
        stacks: this.stacks,
        activeStackId: this.activeStackId,
        activeDimensionId: this.activeDimensionId,
      });
    }
    
    this.rackManager?.emitStacksChange();
  }

  _rebuildModuleControllers(axis) {
    this.rackManager?.rebuildModuleControllers(axis);
  }

  _ensureRackState(axis) {
    const dimension = this._ensureActiveDimension();
    const axisState = dimension.axes[axis];
    ensureAxisLength(axisState);
    this.racks[axis] = {
      dimensionId: dimension.dimensionId,
      modules: axisState.modules,
    };
    return this.racks[axis];
  }

}
