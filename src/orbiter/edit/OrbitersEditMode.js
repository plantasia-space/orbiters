import { AXIS_ROTATION_CONSTRAINTS } from '../../config/Constants.js';
import {
  createEditModeStacks,
  cloneStacks as cloneEditStacks,
  ensureStacksDimensions,
} from '../../defaults/editModeStacks.js';
import {
  createDefaultStacks,
  cloneStacksState,
  ensureDimensionOnStack,
  ensureAxisLength,
  cloneModuleState,
  createEmptyModuleState,
} from '../../core/stackUtils.js';
import { cosmicFrequencyParamId, COSMIC_FREQ_MIN, COSMIC_FREQ_MAX } from '../../input/cosmicFrequencyParam.js';
import { applyDesignSettings } from '../../ui/designManager.js';
import { OrbitersEditPanel } from './OrbitersEditPanel.js';
import { getDimensionCatalogMap } from '../../audio/effects/index.js';
import { voiceRegistry } from '../../voice/VoiceRegistry.js';
import { clearMonitorDisplay } from '../../utils/monitorUtils.js';
import OrbitersPlayMode from '../play/OrbitersPlayMode.js';
import { DEFAULT_DESIGN, normalizeColorValue } from './designUtils.js';
import { getVisualFeedbackDescriptor } from '../../visual/visualFeedbackSettings.js';

const AXES = ['x', 'y', 'z'];
const DEFAULT_STACK_ID = 'deck-i';
const DEFAULT_DIMENSION_ID = 'EW::I';
const AXIS_MIN = AXIS_ROTATION_CONSTRAINTS.min;
const AXIS_MAX = AXIS_ROTATION_CONSTRAINTS.max;
const AXIS_EQ = AXIS_ROTATION_CONSTRAINTS.equilibrium ?? 0;
const AXIS_STEP = AXIS_ROTATION_CONSTRAINTS.step ?? 0.01;

function createAxisMappingDefaults() {
  return {
    label: '',
    min: AXIS_MIN,
    max: AXIS_MAX,
    value: AXIS_EQ,
    initValue: AXIS_EQ,
    minLimit: AXIS_MIN,
    maxLimit: AXIS_MAX,
    step: AXIS_STEP,
  };
}

function shouldDebugDimensionFlow() {
  try {
    if (typeof window === 'undefined') return false;
    if (!('__DEBUG_DIMENSION_ROUTE' in window)) {
      Object.defineProperty(window, '__DEBUG_DIMENSION_ROUTE', {
        value: false,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    return Boolean(window.__DEBUG_DIMENSION_ROUTE);
  } catch (_) {
    return false;
  }
}

function debugDimensionFlow(label, payload = {}) {
  if (!shouldDebugDimensionFlow()) return;
  try {
    console.groupCollapsed(`[DimensionFlow] ${label}`);
    
    console.groupEnd();
  } catch (_) {}
}

export class OrbitersEditMode {
  constructor({ worldManager, emitParameterUpdate, parameterManager = null, themeRoot = null, voiceId = null } = {}) {
    this.worldManager = worldManager;
    this.emitParameterUpdate = emitParameterUpdate;
    this.isActive = false;
    this.lastContext = null;
    // The owning voice's ParameterManager, injected via the mode controller (DI).
    this.paramManager = parameterManager;
    // This voice's id, stamped onto the dimension-changed event so the per-tile React
    // surfaces (monitor/dims/info/…) re-read only on THEIR voice's switch — not a sibling tile's. Null
    // for single-orbiter (the filter is then a no-op → byte-identical).
    this._voiceId = voiceId;
    // The DOM element this voice's orbiter theme is scoped to (its grid cell; null →
    // documentElement for single-orbiter, byte-identical).
    this.themeRoot = themeRoot;
    this.panel = null;
    this._worldLoader = null;

    this.globalDesign = { ...DEFAULT_DESIGN };
    this.designByDimension = {};
    this.design = this.globalDesign;

    this.dimensionAxisState = new Map();
    this._isHydratingDimension = false;

    this.stacks = createEditModeStacks();
    this.activeStackId = getDefaultActiveStackId(this.stacks) ?? DEFAULT_STACK_ID;
    this.activeDimensionId = DEFAULT_DIMENSION_ID;
    this.defaultDimensionId = DEFAULT_DIMENSION_ID;

    this.dimensions = getDimensionCatalogMap({ includeDeprecated: false });
    this.dimensionList = Array.from(this.dimensions.values());
    if (!this.dimensions.has(this.activeDimensionId)) {
      this.activeDimensionId = this.dimensionList[0]?.id || this.activeDimensionId;
    }
    this.defaultDimensionId = this.dimensionList[0]?.id || this.defaultDimensionId;

    ensureStacksDimensions(this.stacks, this.activeDimensionId, this.activeDimensionId);
    this._ensureDimensionState(this.activeDimensionId);
    this._hydrateMappingsFromDimension(this.activeDimensionId);
    this._hydrateDesignFromStacks();
    this.design = this._getDesignRef(this.activeDimensionId, { createIfMissing: true });
    this._syncStacksDesign(this.activeDimensionId, this.design);

    this._isEmittingState = false;
    this._lastBroadcastSignature = null;
    this._lastEmittedDimensionId = null;
    this._pendingPanelStacks = null;

    this._enforceAllAxisConstraints(this.activeDimensionId);
  }

  setParameterEmitter(fn) {
    this.emitParameterUpdate = fn;
  }

  getAvailableDimensions() {
    if (!Array.isArray(this.dimensionList)) return [];
    return this.dimensionList.map((entry) => ({
      id: entry.id,
      label: entry.label ?? entry.id,
    }));
  }

  getActiveDimensionId() {
    return this.activeDimensionId;
  }

  _ensureDimensionState(dimensionId = this.activeDimensionId) {
    const key = dimensionId ?? this.defaultDimensionId ?? DEFAULT_DIMENSION_ID;
    if (!this.dimensionAxisState.has(key)) {
      const axes = {};
      AXES.forEach((axis) => {
        axes[axis] = { ...createAxisMappingDefaults() };
      });
      this.dimensionAxisState.set(key, axes);
    }
    return this.dimensionAxisState.get(key);
  }

  _getAxisState(dimensionId, axis) {
    if (!AXES.includes(axis)) return null;
    const dimensionState = this._ensureDimensionState(dimensionId);
    return dimensionState ? dimensionState[axis] : null;
  }

  _getActiveAxisState(axis) {
    return this._getAxisState(this.activeDimensionId, axis);
  }

  _snapshotDimensionState(dimensionId = this.activeDimensionId) {
    const snapshot = { dimensionId, axes: {} };
    const axesState = this.dimensionAxisState.get(dimensionId);
    if (!axesState) return snapshot;
    AXES.forEach((axis) => {
      const state = axesState[axis];
      if (!state) return;
      snapshot.axes[axis] = {
        value: state.value,
        min: state.min,
        max: state.max,
        initValue: state.initValue,
        modules: state.modules
          ? state.modules.map((mod) => ({
              effectId: mod.effectId,
              moduleId: mod.moduleId,
            }))
          : [],
      };
    });
    return snapshot;
  }

  _initializeMultidimensionalParameters() {
    if (!this.paramManager) return;

    const dimensionIds = this.dimensionList.map((d) => d.id);
    AXES.forEach((axis) => {
      this.paramManager.addMultidimensionalParameter(axis, dimensionIds, AXIS_EQ, AXIS_MIN, AXIS_MAX, {
        isBidirectional: true,
        step: AXIS_STEP,
        scope: 'DIMENSION',
      });
      // Option B (strategy §7 KEEP): promote the manual Cosmic LFO frequency to a
      // dimensional PM param so a React knob + MIDI can drive it uniformly with the axis
      // knobs. Its consumer is `<CosmicLfoPanel>` (Phase 2) via the InputSource
      // seam; registering it now is harmless while the WAC cosmic knob is still active
      // (nothing reads/writes it on the WAC path).
      this.paramManager.addMultidimensionalParameter(
        cosmicFrequencyParamId(axis),
        dimensionIds,
        0.01,
        COSMIC_FREQ_MIN,
        COSMIC_FREQ_MAX,
        {
          isBidirectional: true,
          step: 0.0001,
          scope: 'DIMENSION',
          scale: 'logarithmic',
        },
      );
      // Cosmic LFO depth/amplitude (0..1) as a dimensional PM param so the React Depth
      // knob is a real registered control rather than a phantom flat param auto-created
      // on subscribe. The audio read of it is the deferred InputSource bridge.
      this.paramManager.addMultidimensionalParameter(
        `${axis}-cosmic-amplitude`,
        dimensionIds,
        1,
        0,
        1,
        {
          isBidirectional: true,
          step: 0.01,
          scope: 'DIMENSION',
        },
      );
    });
  }

  _hydrateParameterValues() {
    if (!this.paramManager) return;
    this.dimensions.forEach((dimension, dimensionId) => {
      const state = this.dimensionAxisState.get(dimensionId);
      if (!state) return;
      AXES.forEach((axis) => {
        const mapping = state[axis];
        if (!mapping) return;
        this.paramManager.setDimensionValue(axis, dimensionId, mapping.value, null, 0);
      });
    });
  }

  _subscribeToParameters() {
    if (!this.paramManager) return;
    AXES.forEach((axis) => {
      this.paramManager.subscribe(this, axis, 10, null);
    });
  }

  onParameterChanged(paramName, value, dimensionId) {
    if (this._isHydratingDimension) return;
    const mapping = this._getAxisState(dimensionId, paramName);
    if (mapping) {
      mapping.value = value;
      mapping.initValue = value;
      if (!this._isSwitchingDimension) {
        this._syncAxisStateToStacks(paramName, dimensionId);
      }
    }
  }

  setActiveDimension(newDimensionId) {
    if (this.activeDimensionId === newDimensionId) {
      return false;
    }

    const oldDimensionId = this.activeDimensionId;
    this.activeDimensionId = newDimensionId;
    clearMonitorDisplay();

    const dimensionLabel = this.dimensions?.get(newDimensionId)?.label ?? newDimensionId;
    ensureStacksDimensions(this.stacks, newDimensionId, dimensionLabel);
    this._hydrateMappingsFromDimension(newDimensionId);
    this.design = this._getDesignRef(newDimensionId, { createIfMissing: true });
    this._syncStacksDesign(newDimensionId, this.design);
    this.applyDesign();
    if (this.panel) {
      const hasOverride = Boolean(this.designByDimension[newDimensionId]);
      this.panel.setDesign(this.design, { silent: true, recordOverride: hasOverride });
      this.panel.updateStacksConfig(
        {
          stacks: this.stacks,
          activeStackId: this.activeStackId,
          activeDimensionId: this.activeDimensionId,
        },
        { syncDimensionController: true },
      );
    }

    if (this.paramManager) {
      this._isSwitchingDimension = true;
      try {
        this.paramManager.setActiveDimension(newDimensionId);
        debugDimensionFlow('setActiveDimension:applied', {
          dimensionId: newDimensionId,
          snapshot: this._snapshotDimensionState(newDimensionId),
        });
      } finally {
        this._isSwitchingDimension = false;
      }
    }

    this._dispatchDimensionChange({ source: 'external', force: true });
    this.emitState(true);
    return oldDimensionId !== newDimensionId;
  }

  applyExternalState({
    stacks = null,
    selection = null,
    mappingDefaults = null,
    designDefaults = null,
    designByDimension = null,
  } = {}) {
    if (designDefaults && typeof designDefaults === 'object') {
      const merged = this._cloneDesign({ ...this.globalDesign, ...designDefaults });
      this._setDesignForDimension(null, merged);
    }
    const incomingDesignByDimension =
      designByDimension && typeof designByDimension === 'object' ? designByDimension : null;

    if (mappingDefaults && typeof mappingDefaults === 'object') {
      AXES.forEach((axis) => {
        const incoming = mappingDefaults[axis];
        const state = this._getActiveAxisState(axis);
        if (state && incoming && typeof incoming === 'object') {
          Object.assign(state, incoming);
        }
        this._enforceAxisConstraints(axis, this.activeDimensionId);
      });
    }

    if (selection && typeof selection === 'object') {
      if (selection.activeStackId) {
        this.activeStackId = selection.activeStackId;
      }
      if (selection.activeDimensionId) {
        this.activeDimensionId = selection.activeDimensionId;
      }
    }

    const previousHydrationState = this._isHydratingDimension;
    this._isHydratingDimension = true;
    try {
      if (stacks && typeof stacks === 'object') {
        this._applyStackDefaults({
          stacks,
          selection: {
            activeStackId: this.activeStackId,
            activeDimensionId: this.activeDimensionId,
            ...(selection || {}),
          },
        });
      }

      this._initializeMultidimensionalParameters();
      this._hydrateMappingsFromDimension(this.activeDimensionId);
      const targetDimensionId = this.activeDimensionId ?? this.defaultDimensionId ?? null;
      if (targetDimensionId) {
        this._hydrateParameterValues();
      }
    } finally {
      this._isHydratingDimension = previousHydrationState;
    }

    this._hydrateDesignFromStacks();
    if (incomingDesignByDimension) {
      Object.entries(incomingDesignByDimension).forEach(([dimensionId, design]) => {
        if (!dimensionId) return;
        this.designByDimension[dimensionId] = this._cloneDesign(design);
        this._syncStacksDesign(dimensionId, this.designByDimension[dimensionId]);
      });
    }
    this.design = this._getDesignRef(this.activeDimensionId, { createIfMissing: true });
    this._syncStacksDesign(this.activeDimensionId, this.design);
    this.applyDesign();
    const panelPayload = {
      stacks: cloneEditStacks(this.stacks),
      selection: {
        activeStackId: this.activeStackId,
        activeDimensionId: this.activeDimensionId,
      },
    };
    if (this.panel && typeof this.panel.loadExternalStacks === 'function') {
      this.panel.loadExternalStacks(panelPayload);
      const hasOverride = Boolean(this.designByDimension[this.activeDimensionId]);
      this.panel.setDesign(this.design, { silent: true, recordOverride: hasOverride });
      this._pendingPanelStacks = null;
    } else {
      this._pendingPanelStacks = panelPayload;
    }
  }

  async activate(context = {}) {
    this.isActive = true;
    this.lastContext = context;

    if (context?.designDefaults) {
      const merged = this._cloneDesign({ ...this.globalDesign, ...context.designDefaults });
      this._setDesignForDimension(null, merged);
    }
    if (context?.designByDimension && typeof context.designByDimension === 'object') {
      Object.entries(context.designByDimension).forEach(([dimensionId, design]) => {
        if (!dimensionId) return;
        this.designByDimension[dimensionId] = this._cloneDesign(design);
      });
    }

    if (context?.mappingDefaults) {
      AXES.forEach((axis) => {
        const state = this._getActiveAxisState(axis);
        const incoming = context.mappingDefaults[axis];
        if (state && incoming && typeof incoming === 'object') {
          Object.assign(state, incoming);
        }
        this._enforceAxisConstraints(axis, this.activeDimensionId);
      });
    }

    this._enforceAllAxisConstraints(this.activeDimensionId);

    const stacksDefaults =
      context.stacksDefaults ||
      context.stubOrbiter?.orbiterData?.stacks ||
      context.trackData?.orbiter?.stacks ||
      null;
    this._applyStackDefaults(stacksDefaults);
    this._hydrateDesignFromStacks();
    this.design = this._getDesignRef(this.activeDimensionId, { createIfMissing: true });
    this._syncStacksDesign(this.activeDimensionId, this.design);

    this._initializeMultidimensionalParameters();
    this._hydrateParameterValues();
    this._subscribeToParameters();

    await this._loadWorld(context);

    this._lastBroadcastSignature = null;
    this._initializeMultidimensionalParameters();

    await this._ensurePanel();
    if (this.panel && typeof this.panel.updateStacksConfig === 'function') {
      this.panel.updateStacksConfig(this.stacks);
    }
    this.applyDesign();
    this._hydrateMappingsFromDimension(this.activeDimensionId);

    if (this.paramManager) {
      this.paramManager.setActiveDimension(this.activeDimensionId);
    }

    this.emitState(true);
    return true;
  }

  async deactivate() {
    this.isActive = false;
    if (this._worldLoader) {
      try {
        await this._worldLoader.deactivate(this.lastContext);
      } catch (err) {
        console.warn('[OrbitersEditMode] Failed to deactivate world loader', err);
      }
      this._worldLoader = null;
    }
    this.panel?.dispose();
    this.panel = null;
    this._lastBroadcastSignature = null;
  }

  async refresh(context = {}) {
    this.lastContext = context || this.lastContext || {};
    await this._loadWorld(this.lastContext);
    this.applyDesign();
    this.emitState(true);
    return true;
  }

  broadcastParameters(payload) {
    if (typeof this.emitParameterUpdate === 'function') {
      this.emitParameterUpdate(payload);
    }
  }

  emitState(force = false) {
    if (this._isEmittingState) {
      return;
    }

    const {
      stacks: serializedStacks,
      activeStackId,
      activeDimensionId,
    } = this._serializeStacksForPayload();
    // Which modules answer in the world rides along as the session's OWN key — it
    // is a visual choice and must never reach a module's audio settings, where the
    // rack would read it as a reason to rebuild the effect. Omitted when nothing was
    // switched off: an absent key means everything is on.
    const visualFeedback = getVisualFeedbackDescriptor(this._voiceId);
    const payload = {
      schemaVersion: 1,
      stacks: serializedStacks,
      selection: {
        activeStackId,
        activeDimensionId,
      },
      ...(visualFeedback ? { visualFeedback } : {}),
    };

    const signature = JSON.stringify(payload);
    if (!force && signature === this._lastBroadcastSignature) {
      return;
    }

    this._isEmittingState = true;
    try {
      this._lastBroadcastSignature = signature;
      this.broadcastParameters(payload);
    } finally {
      this._isEmittingState = false;
    }
  }

  applyDesign() {
    const normalizedPrimary = this._normalizeColor(this.design.colorPrimary, '#ffffff');
    const normalizedSecondary = this._normalizeColor(this.design.colorSecondary, '#151515');
    const normalizedColorC = this._normalizeColor(
      this.design.colorC,
      DEFAULT_DESIGN.colorC,
    );
    this.design.colorPrimary = normalizedPrimary;
    this.design.colorSecondary = normalizedSecondary;
    this.design.colorC = normalizedColorC;
    const ringEnabled = this.design.ringEnabled !== false;
    this.design.ringEnabled = ringEnabled;

    applyDesignSettings(this.design, this.themeRoot);

    // Scope the live color vars to THIS voice's theme root (its tile), not the global
    // documentElement — otherwise editing one tile's dimension colors would recolor every tile.
    const root = this.themeRoot || document.documentElement;
    root.style.setProperty('--color1', normalizedPrimary);
    root.style.setProperty('--color2', normalizedSecondary);
    root.style.setProperty('--color3', normalizedColorC);

    const effectiveRingColor = this.design.ringColor
      ? this._normalizeColor(this.design.ringColor, normalizedSecondary)
      : null;
    const amplitudeMultiplier = Number.isFinite(this.design.ringAmplitudeMultiplier)
      ? Math.max(0, Number(this.design.ringAmplitudeMultiplier))
      : 1;
    const radiusMultiplier = Number.isFinite(this.design.ringRadiusMultiplier)
      ? Math.max(0, Number(this.design.ringRadiusMultiplier))
      : 1;

    this.design.ringAmplitudeMultiplier = amplitudeMultiplier;
    this.design.ringRadiusMultiplier = radiusMultiplier;
    this.design.ringColor = effectiveRingColor;

    // The oscilloscope is per-voice; drive the active (focused) voice's instance.
    const oscilloscope = voiceRegistry.getActive()?.oscilloscope;
    oscilloscope?.setEnabled(ringEnabled);
    oscilloscope?.setAmplitudeMultiplier(amplitudeMultiplier);
    oscilloscope?.setRadiusMultiplier(radiusMultiplier);
    oscilloscope?.setCustomColor(effectiveRingColor);
    if (!effectiveRingColor) {
      oscilloscope?.updateOrbitColor();
    }

    if (this.lastContext?.trackData?.orbiter) {
      const colors =
        this.lastContext.trackData.orbiter.orbiterColors ||
        (this.lastContext.trackData.orbiter.orbiterColors = {});
      colors.color1 = normalizedPrimary;
      colors.color2 = normalizedSecondary;
      colors.color3 = normalizedColorC;
      const designMeta =
        this.lastContext.trackData.orbiter.orbiterDesign ||
        (this.lastContext.trackData.orbiter.orbiterDesign = {});
      designMeta.fontId = this.design.fontId ?? null;
      designMeta.fontFamily = this.design.fontFamily;
      designMeta.fontImportUrl = this.design.fontImportUrl ?? null;
      designMeta.ringEnabled = ringEnabled;
      designMeta.ringColor = this.design.ringColor ?? null;
      designMeta.ringAmplitudeMultiplier = this.design.ringAmplitudeMultiplier;
      designMeta.ringRadiusMultiplier = this.design.ringRadiusMultiplier;
    }

    if (this.lastContext?.stubOrbiter) {
      const stubColors =
        this.lastContext.stubOrbiter.orbiterColors ||
        (this.lastContext.stubOrbiter.orbiterColors = {});
      stubColors.color1 = normalizedPrimary;
      stubColors.color2 = normalizedSecondary;
      stubColors.color3 = normalizedColorC;
      const stubDesign =
        this.lastContext.stubOrbiter.orbiterDesign ||
        (this.lastContext.stubOrbiter.orbiterDesign = {});
      stubDesign.fontId = this.design.fontId ?? null;
      stubDesign.fontFamily = this.design.fontFamily;
      stubDesign.fontImportUrl = this.design.fontImportUrl ?? null;
      stubDesign.ringEnabled = ringEnabled;
      stubDesign.ringColor = this.design.ringColor ?? null;
      stubDesign.ringAmplitudeMultiplier = this.design.ringAmplitudeMultiplier;
      stubDesign.ringRadiusMultiplier = this.design.ringRadiusMultiplier;
    }

  }

  _normalizeColor(value, fallback) {
    return normalizeColorValue(value, fallback);
  }

  _cloneDesign(source = null) {
    const base = { ...DEFAULT_DESIGN };
    if (!source || typeof source !== 'object') {
      return base;
    }

    const next = { ...base };

    if (source.colorPrimary) {
      const primary = String(source.colorPrimary).trim();
      if (primary) next.colorPrimary = primary;
    }
    if (source.colorSecondary) {
      const secondary = String(source.colorSecondary).trim();
      if (secondary) next.colorSecondary = secondary;
    }
    if (source.colorC) {
      const colorC = String(source.colorC).trim();
      if (colorC) next.colorC = colorC;
    }
    if (Number.isFinite(source.roundedCorners)) {
      next.roundedCorners = Math.max(0, Number(source.roundedCorners));
    }
    if (Number.isFinite(source.frameBorderWidth)) {
      next.frameBorderWidth = Math.max(0, Number(source.frameBorderWidth));
    }
    if (source.fontFamily) {
      next.fontFamily = String(source.fontFamily);
    }
    if (Object.prototype.hasOwnProperty.call(source, 'fontId')) {
      next.fontId = source.fontId;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'fontImportUrl')) {
      next.fontImportUrl = source.fontImportUrl ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'fontLabel')) {
      next.fontLabel = source.fontLabel ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'themeId')) {
      next.themeId = source.themeId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'themeLabel')) {
      next.themeLabel = source.themeLabel ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'themeVariant')) {
      next.themeVariant = source.themeVariant ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'ringEnabled')) {
      next.ringEnabled = Boolean(source.ringEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(source, 'ringColor')) {
      next.ringColor = this._normalizeColor(source.ringColor, base.ringColor ?? base.colorSecondary);
    }
    if (Number.isFinite(source.ringAmplitudeMultiplier)) {
      next.ringAmplitudeMultiplier = Math.max(0, Number(source.ringAmplitudeMultiplier));
    }
    if (Number.isFinite(source.ringRadiusMultiplier)) {
      next.ringRadiusMultiplier = Math.max(0, Number(source.ringRadiusMultiplier));
    }

    return next;
  }

  _setDesignForDimension(dimensionId, design) {
    const normalized = this._cloneDesign(design);
    if (!dimensionId) {
      this.globalDesign = normalized;
      this.design = this.globalDesign;
    } else {
      this.designByDimension[dimensionId] = normalized;
      this.design = this.designByDimension[dimensionId];
    }
    this._syncStacksDesign(dimensionId, this.design);
  }

  _syncStacksDesign(dimensionId, design) {
    if (!this.stacks || typeof this.stacks !== 'object') return;
    if (!dimensionId) {
      Object.values(this.stacks).forEach((stack) => {
        if (!stack || !stack.dimensions) return;
        Object.entries(stack.dimensions).forEach(([dimId, dimensionState]) => {
          if (!dimensionState) return;
          if (!this.designByDimension[dimId]) {
            dimensionState.design = null;
          }
        });
      });
      return;
    }
    const designSnapshot = design ? { ...design } : null;
    Object.values(this.stacks).forEach((stack) => {
      if (!stack || !stack.dimensions) return;
      Object.entries(stack.dimensions).forEach(([dimId, dimensionState]) => {
        if (!dimensionState || dimId !== dimensionId) return;
        dimensionState.design = designSnapshot ? { ...designSnapshot } : null;
      });
    });
  }

  _hydrateDesignFromStacks() {
    const hydrated = {};
    if (this.stacks && typeof this.stacks === 'object') {
      Object.values(this.stacks).forEach((stack) => {
        if (!stack || !stack.dimensions) return;
        Object.entries(stack.dimensions).forEach(([dimensionId, dimensionState]) => {
          if (!dimensionState?.design || hydrated[dimensionId]) return;
          hydrated[dimensionId] = this._cloneDesign(dimensionState.design);
        });
      });
    }
    this.designByDimension = hydrated;
  }

  _createDefaultAxisControls() {
    return {
      knob: { value: 0, normalized: 0 },
      sensor: { enabled: false },
      cosmic: {
        enabled: false,
        waveform: 'sine',
        source: 'minimumCosmicLfo',
        multiplier: 1,
        frequency: 0,
      },
    };
  }

  _enforceAllAxisConstraints(dimensionId = this.activeDimensionId) {
    AXES.forEach((axis) => this._enforceAxisConstraints(axis, dimensionId));
  }

  _enforceAxisConstraints(axis, dimensionId = this.activeDimensionId) {
    const mapping = this._getAxisState(dimensionId, axis);
    if (!mapping) return;
    const clamp = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return AXIS_EQ;
      return Math.min(AXIS_MAX, Math.max(AXIS_MIN, numeric));
    };
    mapping.min = AXIS_MIN;
    mapping.max = AXIS_MAX;
    mapping.minLimit = AXIS_MIN;
    mapping.maxLimit = AXIS_MAX;
    mapping.step = AXIS_STEP;
    mapping.value = clamp(mapping.value);
    mapping.initValue = clamp(mapping.initValue);
    mapping.defaultValue = clamp(mapping.defaultValue);
  }

  _ensureActiveStack() {
    if (!this.stacks || typeof this.stacks !== 'object') {
      this.stacks = createEditModeStacks();
    }
    if (!this.stacks[this.activeStackId]) {
      const defaults = createDefaultStacks();
      this.stacks[this.activeStackId] =
        defaults[this.activeStackId] || {
          id: this.activeStackId,
          kind: 'deck',
          label: this.activeStackId,
          enabled: true,
          dimensions: {},
        };
    }
    return this.stacks[this.activeStackId];
  }

  _syncAxisStateToStacks(axisKey, dimensionId = this.activeDimensionId) {
    const dimension = this._ensureActiveDimension(dimensionId);
    const axisState = dimension?.axes?.[axisKey];
    if (!axisState) return;

    ensureAxisLength(axisState);

    const normalized = this.paramManager?.getNormalizedValue(axisKey, dimensionId);
    const normalizedValue = Number.isFinite(normalized) ? Math.min(1, Math.max(0, Number(normalized))) : null;
    const mappingState = this._getAxisState(dimensionId, axisKey) ?? {};
    const rawValue = Number.isFinite(mappingState.value) ? Number(mappingState.value) : null;
    const min = Number.isFinite(mappingState.min) ? Number(mappingState.min) : null;
    const max = Number.isFinite(mappingState.max) ? Number(mappingState.max) : null;
    const step = Number.isFinite(mappingState.step) ? Number(mappingState.step) : null;

    if (!axisState.rotation || typeof axisState.rotation !== 'object') {
      axisState.rotation = {
        value: rawValue,
        normalized: normalizedValue ?? 0,
        min,
        max,
        step,
      };
    } else {
      axisState.rotation.value = rawValue;
      axisState.rotation.normalized = normalizedValue ?? axisState.rotation.normalized ?? 0;
      axisState.rotation.min = min ?? axisState.rotation.min ?? null;
      axisState.rotation.max = max ?? axisState.rotation.max ?? null;
      axisState.rotation.step = step ?? axisState.rotation.step ?? null;
    }

    if (!axisState.controls || typeof axisState.controls !== 'object') {
      axisState.controls = this._createDefaultAxisControls();
    }
    if (!axisState.controls.knob || typeof axisState.controls.knob !== 'object') {
      axisState.controls.knob = { value: 0, normalized: 0 };
    }
    axisState.controls.knob.value = rawValue ?? axisState.controls.knob.value ?? 0;
    axisState.controls.knob.normalized =
      normalizedValue ?? axisState.controls.knob.normalized ?? 0;
  }

  _ensureActiveDimension(targetDimensionId = this.activeDimensionId) {
    const stack = this._ensureActiveStack();
    const dimensionId = targetDimensionId ?? this.activeDimensionId ?? this.defaultDimensionId;
    const dimensionLabel = this.dimensions?.get(dimensionId)?.label ?? dimensionId;
    const dimension = ensureDimensionOnStack(stack, dimensionId, {
      dimensionLabel,
      createIfMissing: true,
    });
    AXES.forEach((axis) => {
      const axisState = dimension.axes[axis];
      ensureAxisLength(axisState);
      if (!axisState.rotation || typeof axisState.rotation !== 'object') {
        axisState.rotation = {
          value: null,
          normalized: 0,
          min: null,
          max: null,
          step: null,
        };
      }
      if (!axisState.controls || typeof axisState.controls !== 'object') {
        axisState.controls = this._createDefaultAxisControls();
      } else if (!axisState.controls.knob || typeof axisState.controls.knob !== 'object') {
        axisState.controls.knob = { value: 0, normalized: 0 };
      }
      if (!axisState.controls.cosmic || typeof axisState.controls.cosmic !== 'object') {
        axisState.controls.cosmic = this._createDefaultAxisControls().cosmic;
      }

      const cosmicControls = axisState.controls.cosmic;
      if (!cosmicControls.source) {
        cosmicControls.source = 'minimumCosmicLfo';
      }
    });
    return dimension;
  }

  _dispatchDimensionChange({ source = 'internal', force = false } = {}) {
    if (typeof document === 'undefined') {
      return;
    }
    const currentId = this.activeDimensionId ?? this.defaultDimensionId ?? null;
    if (!currentId) {
      return;
    }
    if (!force && this._lastEmittedDimensionId === currentId) {
      return;
    }
    this._lastEmittedDimensionId = currentId;

    const record = this.dimensions?.get(currentId) || null;
    const label = record?.label ?? currentId;

    try {
      document.dispatchEvent(
        new CustomEvent('orbiters:dimension-changed', {
          detail: {
            activeDimensionId: currentId,
            label,
            dimension: {
              id: currentId,
              label,
            },
            source,
            // The voice this switch belongs to (null single-orbiter) so per-tile React
            // surfaces ignore sibling tiles' dimension switches.
            voiceId: this._voiceId,
          },
        }),
      );
    } catch (error) {
      console.warn('[OrbitersEditMode] Failed to dispatch dimension change event:', error);
    }
  }

  _handleDesignChange(updated) {
    if (!updated || typeof updated !== 'object') {
      return;
    }
    const targetDimensionId = this.activeDimensionId ?? null;
    const current = this._cloneDesign(this._getDesignRef(targetDimensionId, { createIfMissing: true }));
    const merged = this._cloneDesign({ ...current, ...updated });
    if (this._designEquals(current, merged)) {
      return;
    }
    this._setDesignForDimension(targetDimensionId, merged);
    this.applyDesign();
    if (this.panel) {
      const hasOverride = Boolean(targetDimensionId && this.designByDimension[targetDimensionId]);
      this.panel.setDesign(this.design, { silent: true, recordOverride: hasOverride });
    }
    this.emitState(true);
  }

  _handleMappingChange(axis, updated) {
    if (!AXES.includes(axis)) return;
    const targetDimensionId = this.activeDimensionId ?? this.defaultDimensionId ?? null;
    const axisState = this._getAxisState(targetDimensionId, axis);
    if (!axisState || !updated || typeof updated !== 'object') return;
    Object.assign(axisState, updated);

    this._enforceAxisConstraints(axis, targetDimensionId);

    if (updated.value !== undefined && Number.isFinite(updated.value)) {
      axisState.initValue = updated.value;
    } else if (updated.initValue !== undefined && Number.isFinite(updated.initValue)) {
      axisState.initValue = updated.initValue;
      if (!Number.isFinite(axisState.value)) {
        axisState.value = axisState.initValue;
      }
    }

    if (this.paramManager && Number.isFinite(axisState.value)) {
      this.paramManager.setDimensionValue(axis, targetDimensionId, axisState.value);
    }
  }

  _handleRackChange(axis, updated) {
    if (!AXES.includes(axis)) return;
    const dimension = this._ensureActiveDimension();
    const axisState = dimension.axes[axis];
    ensureAxisLength(axisState);
    const incomingModules = Array.isArray(updated?.modules) ? updated.modules : [];
    axisState.modules.forEach((moduleState, index) => {
      const incoming = incomingModules[index];
      if (incoming) {
        axisState.modules[index] = cloneModuleState(incoming, { includeDimensionMetadata: false });
      } else {
        axisState.modules[index] = createEmptyModuleState();
      }
    });
    this.emitState();
  }

  _applyStackDefaults(source = null) {
    let nextStacks = null;
    if (source && typeof source === 'object') {
      if (source.stacks && typeof source.stacks === 'object') {
        nextStacks = cloneEditStacks(source.stacks);
      } else if (!Array.isArray(source)) {
        nextStacks = cloneEditStacks(source);
      }

      if (source?.selection?.activeStackId) {
        this.activeStackId = source.selection.activeStackId;
      }
      if (source?.selection?.activeDimensionId) {
        this.activeDimensionId = source.selection.activeDimensionId;
      }
    }

    if (nextStacks) {
      this.stacks = nextStacks;
    } else if (!this.stacks || typeof this.stacks !== 'object') {
      this.stacks = createEditModeStacks();
    }

    ensureStacksDimensions(this.stacks, this.activeDimensionId, this.activeDimensionId);
    const primaryStack = this.stacks[this.activeStackId];
    if (primaryStack && primaryStack.dimensions) {
      const dimensionIds = Object.keys(primaryStack.dimensions);
      if (dimensionIds.length && !primaryStack.dimensions[this.activeDimensionId]) {
        this.activeDimensionId = dimensionIds[0];
      }
    }

    const dimensionIds = new Set();
    const activeDimensions = this.stacks?.[this.activeStackId]?.dimensions || {};
    Object.keys(activeDimensions).forEach((dimensionId) => {
      if (dimensionId) {
        dimensionIds.add(dimensionId);
      }
    });
    if (!dimensionIds.size && this.activeDimensionId) {
      dimensionIds.add(this.activeDimensionId);
    }

    dimensionIds.forEach((dimensionId) => {
      this._ensureDimensionState(dimensionId);
      this._hydrateMappingsFromDimension(dimensionId);
      this._enforceAllAxisConstraints(dimensionId);
    });

    if (this.panel) {
      this.panel.updateStacksConfig({
        stacks: this.stacks,
        activeStackId: this.activeStackId,
        activeDimensionId: this.activeDimensionId,
      });
    }

    this._dispatchDimensionChange({ source: 'defaults', force: true });
  }

  _hydrateMappingsFromDimension(targetDimensionId = this.activeDimensionId) {
    if (!targetDimensionId) return;
    const stack = this.stacks?.[this.activeStackId];
    if (!stack || !stack.dimensions) return;

    const dimensionId = targetDimensionId;
    const label = this.dimensions?.get(dimensionId)?.label ?? dimensionId;
    const dimension =
      stack.dimensions[dimensionId] ||
      ensureDimensionOnStack(stack, dimensionId, {
        dimensionLabel: label,
        createIfMissing: true,
      });
    if (!dimension || !dimension.axes) return;

    AXES.forEach((axis) => {
      const axisState = dimension.axes?.[axis];
      if (!axisState) return;
      const rotation = axisState.rotation || {};
      const knob = axisState.controls?.knob || {};
      const mapping = this._getAxisState(dimensionId, axis);
      if (!mapping) return;

      const stackMin = Number.isFinite(rotation.min) ? Number(rotation.min) : AXIS_MIN;
      const stackMax = Number.isFinite(rotation.max) ? Number(rotation.max) : AXIS_MAX;
      const stackStep = Number.isFinite(rotation.step)
        ? Number(rotation.step)
        : Number.isFinite(mapping.step)
        ? Number(mapping.step)
        : AXIS_STEP;
      const fallbackValue = Number.isFinite(mapping.defaultValue) ? Number(mapping.defaultValue) : AXIS_EQ;
      const stackValue = [rotation.value, knob.value, fallbackValue, AXIS_EQ].find((candidate) =>
        Number.isFinite(candidate),
      );
      const numericValue = Number.isFinite(stackValue) ? Number(stackValue) : AXIS_EQ;
      const shouldSeedValue = !Number.isFinite(mapping.value);

      if (shouldSeedValue) {
        mapping.value = numericValue;
        mapping.initValue = Number.isFinite(mapping.initValue) ? mapping.initValue : numericValue;
        if (!Number.isFinite(mapping.defaultValue)) {
          mapping.defaultValue = numericValue;
        }
      }

      mapping.min = Number.isFinite(mapping.min) ? Number(mapping.min) : stackMin;
      mapping.max = Number.isFinite(mapping.max) ? Number(mapping.max) : stackMax;
      mapping.step = Number.isFinite(mapping.step) ? Number(mapping.step) : stackStep;
      mapping.minLimit = AXIS_MIN;
      mapping.maxLimit = AXIS_MAX;

      if (!axisState.controls || typeof axisState.controls !== 'object') {
        axisState.controls = this._createDefaultAxisControls();
      }
      if (!axisState.controls.knob || typeof axisState.controls.knob !== 'object') {
        axisState.controls.knob = { value: 0, normalized: 0 };
      }

      const axisValue = Number.isFinite(mapping.value) ? Number(mapping.value) : numericValue;
      axisState.rotation = {
        value: axisValue,
        normalized: Number.isFinite(rotation.normalized) ? Number(rotation.normalized) : null,
        min: mapping.min,
        max: mapping.max,
        step: mapping.step,
      };

      let normalizedValue = Number.isFinite(knob.normalized) ? Number(knob.normalized) : null;
      if (!Number.isFinite(normalizedValue) && Number.isFinite(axisState.rotation.normalized)) {
        normalizedValue = Number(axisState.rotation.normalized);
      }
      if (
        !Number.isFinite(normalizedValue) &&
        Number.isFinite(mapping.min) &&
        Number.isFinite(mapping.max) &&
        mapping.max !== mapping.min
      ) {
        normalizedValue = (axisValue - mapping.min) / (mapping.max - mapping.min);
      }
      axisState.controls.knob.value = axisValue;
      axisState.controls.knob.normalized = Number.isFinite(normalizedValue)
        ? Math.min(1, Math.max(0, Number(normalizedValue)))
        : axisState.controls.knob.normalized ?? 0;
    });
  }

  _serializeStacksForPayload() {
    const clonedStacks = cloneEditStacks(this.stacks);
    const filteredStacks = {};
    const dimensionOrderReference = Array.isArray(this.dimensionList)
      ? this.dimensionList.map((dimension) => dimension?.id).filter(Boolean)
      : [];

    Object.entries(clonedStacks).forEach(([stackId, stack]) => {
      if (!stack?.enabled) return;
      const stackDimensions = stack.dimensions || {};
      const orderedDimensionIds = [
        ...dimensionOrderReference.filter((dimensionId) =>
          Object.prototype.hasOwnProperty.call(stackDimensions, dimensionId),
        ),
        ...Object.keys(stackDimensions).filter(
          (dimensionId) => !dimensionOrderReference.includes(dimensionId),
        ),
      ];

      const dimensions = {};
      orderedDimensionIds.forEach((dimensionId) => {
        const dimension = stackDimensions[dimensionId];
        if (!dimension) return;

        const axes = {};
        AXES.forEach((axisKey) => {
          const axisState = dimension.axes?.[axisKey];
          if (!axisState) return;

          const normalizedValue = this.paramManager?.getNormalizedValue(
            axisKey,
            dimension.dimensionId ?? dimensionId,
          );
          const constrainedNormalized = Number.isFinite(normalizedValue)
            ? Math.min(1, Math.max(0, Number(normalizedValue)))
            : null;

          const modules = Array.isArray(axisState.modules) ? axisState.modules : [];
          axes[axisKey] = {
            modules: modules.map((module) => {
              if (!module || typeof module !== 'object') return module;
              const sanitized = { ...module };
              delete sanitized.mappings;
              delete sanitized.rotation;
              delete sanitized.controls;
              delete sanitized.sensor;
              delete sanitized.cosmic;
              if (constrainedNormalized !== null) {
                sanitized.controlNormalized = constrainedNormalized;
              } else {
                delete sanitized.controlNormalized;
              }
              return sanitized;
            }),
          };
        });

        const effectiveDesign =
          dimension.design && typeof dimension.design === 'object'
            ? this._cloneDesign(dimension.design)
            : this._cloneDesign(this.design);

        dimensions[dimensionId] = {
          dimensionId: dimension.dimensionId ?? dimensionId,
          dimensionLabel: dimension.dimensionLabel ?? dimensionId,
          design: effectiveDesign,
          axes,
        };
      });

      filteredStacks[stackId] = {
        id: stack.id ?? stackId,
        kind: stack.kind ?? 'deck',
        label: stack.label ?? stackId,
        enabled: true,
        dimensions,
      };
    });

    let nextActiveStackId = this.activeStackId;
    if (!filteredStacks[nextActiveStackId]) {
      const [firstEnabled] = Object.keys(filteredStacks);
      nextActiveStackId = firstEnabled ?? null;
    }

    let nextActiveDimensionId = this.activeDimensionId;
    const activeStack = nextActiveStackId ? filteredStacks[nextActiveStackId] : null;
    if (activeStack) {
      if (!activeStack.dimensions[nextActiveDimensionId]) {
        const [firstDimension] = Object.keys(activeStack.dimensions || {});
        nextActiveDimensionId = firstDimension ?? null;
      }
    } else {
      nextActiveDimensionId = null;
    }

    return {
      stacks: filteredStacks,
      activeStackId: nextActiveStackId,
      activeDimensionId: nextActiveDimensionId,
    };
  }

  _getDesignRef(dimensionId, { createIfMissing = false } = {}) {
    if (!dimensionId) {
      return this.globalDesign;
    }
    if (!this.designByDimension[dimensionId] && createIfMissing) {
      this.designByDimension[dimensionId] = this._cloneDesign(this.globalDesign);
    }
    return this.designByDimension[dimensionId] || this.globalDesign;
  }

  _designEquals(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async _ensurePanel() {
    if (!this.panel) {
      this.panel = new OrbitersEditPanel({
        design: this.design,
        stacks: this.stacks,
        onDesignChange: (updated) => this._handleDesignChange(updated),
        onStacksChange: (payload) => this._handleStacksChange(payload),
        onRackChange: (axis, updated) => this._handleRackChange(axis, updated),
        onAnyChange: () => this.emitState(),
        voiceId: this._voiceId,
      });
    }
    await this.panel.mount();
    this.panel.updateStacksConfig({
      stacks: this.stacks,
      activeStackId: this.activeStackId,
      activeDimensionId: this.activeDimensionId,
    });
    if (this._pendingPanelStacks && typeof this.panel.loadExternalStacks === 'function') {
      this.panel.loadExternalStacks(this._pendingPanelStacks);
      this._pendingPanelStacks = null;
    }
    const hasOverride =
      Boolean(this.activeDimensionId && this.designByDimension[this.activeDimensionId]);
    this.panel.setDesign(this.design, { silent: true, recordOverride: hasOverride });
  }

  _handleStacksChange(payload = {}) {
    const previousDimensionId = this.activeDimensionId;

    if (payload.activeStackId) {
      this.activeStackId = payload.activeStackId;
    }
    if (payload.activeDimensionId) {
      this.activeDimensionId = payload.activeDimensionId;
    }
    if (payload.stacks && typeof payload.stacks === 'object') {
      this.stacks = cloneEditStacks(payload.stacks);
    }
    ensureStacksDimensions(this.stacks, this.activeDimensionId, this.activeDimensionId);
    const primaryStack = this.stacks[this.activeStackId];
    if (primaryStack && primaryStack.dimensions) {
      if (!primaryStack.dimensions[this.activeDimensionId]) {
        const dimensionIds = Object.keys(primaryStack.dimensions);
        if (dimensionIds.length) {
          this.activeDimensionId = dimensionIds[0];
        }
      }
    }

    if (previousDimensionId !== this.activeDimensionId && this.paramManager) {
      this._isSwitchingDimension = true;
      try {
        this.paramManager.setActiveDimension(this.activeDimensionId);
      } finally {
        this._isSwitchingDimension = false;
      }
    }
    const dimensionIds = new Set();
    if (payload.activeDimensionId) {
      dimensionIds.add(payload.activeDimensionId);
    }
    if (this.activeDimensionId) {
      dimensionIds.add(this.activeDimensionId);
    }
    if (!dimensionIds.size) {
      const currentStack = this.stacks?.[this.activeStackId];
      const fallbackDimensionId = currentStack && currentStack.dimensions
        ? Object.keys(currentStack.dimensions)[0]
        : null;
      if (fallbackDimensionId) {
        dimensionIds.add(fallbackDimensionId);
      }
    }
    dimensionIds.forEach((dimensionId) => {
      this._ensureDimensionState(dimensionId);
      this._hydrateMappingsFromDimension(dimensionId);
      this._enforceAllAxisConstraints(dimensionId);
    });
    this._hydrateDesignFromStacks();
    this.design = this._getDesignRef(this.activeDimensionId, { createIfMissing: true });
    this._syncStacksDesign(this.activeDimensionId, this.design);
    this.applyDesign();
    if (this.panel) {
      const hasOverride = Boolean(this.designByDimension[this.activeDimensionId]);
      this.panel.setDesign(this.design, { silent: true, recordOverride: hasOverride });
    }
    this.emitState();
    this._dispatchDimensionChange({ source: 'panel' });
  }

  async _loadWorld(context = {}) {
    const world = context.trackData?.entangledWorld || context.entangledWorld;
    if (!this.worldManager || !world) {
      return false;
    }

    if (this._worldLoader) {
      try {
        await this._worldLoader.deactivate(context);
      } catch (err) {
        console.warn('[OrbitersEditMode] Failed to deactivate previous world loader', err);
      }
      this._worldLoader = null;
    }

    const loader = new OrbitersPlayMode({
      worldManager: this.worldManager,
      scene: context.scene,
    });

    let success = false;
    try {
      success = await loader.activate({
        ...context,
        graphicsPreference: context.graphicsPreference || 'high',
      });
    } catch (err) {
      console.warn('[OrbitersEditMode] Failed to load entangled world for edit mode:', err);
      success = false;
    }

    if (success) {
      this._worldLoader = loader;
      return true;
    }

    try {
      await loader.deactivate(context);
    } catch {
      // ignore cleanup errors
    }
    return false;
  }
}

function getDefaultActiveStackId(stacks) {
  if (!stacks || typeof stacks !== 'object') {
    return DEFAULT_STACK_ID;
  }
  if (stacks[DEFAULT_STACK_ID]) {
    return DEFAULT_STACK_ID;
  }
  const [firstKey] = Object.keys(stacks);
  return firstKey || DEFAULT_STACK_ID;
}

export default OrbitersEditMode;
