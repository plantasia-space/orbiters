import { voiceRegistry } from '../voice/VoiceRegistry.js';
import OrbitersPlayMode from './play/OrbitersPlayMode.js';
import OrbitersEditMode from './edit/OrbitersEditMode.js';

export class OrbiterModeController {
  constructor({
    worldManager,
    scene,
    defaultMode = 'play',
    onModeChanged,
    emitParameterUpdate,
    parameterManager,
    // The DOM element this voice's orbiter theme is scoped to (its grid cell; null →
    // documentElement for single-orbiter). Passed through to edit mode, which re-applies design on
    // dimension changes.
    themeRoot = null,
    // This voice's id, threaded into edit mode so its dimension-changed event is stamped
    // per-voice (single-orbiter null → byte-identical).
    voiceId = null,
    playMode,
    editMode,
  } = {}) {
    if (!worldManager && (!playMode || !editMode)) {
      throw new Error('[OrbiterModeController] worldManager or custom modes are required');
    }

    this.modes = {
      play: playMode ?? new OrbitersPlayMode({ worldManager, scene }),
      // Thread the voice's ParameterManager into edit mode (DI; no singleton).
      edit: editMode ?? new OrbitersEditMode({ worldManager, emitParameterUpdate, parameterManager, themeRoot, voiceId }),
    };

    if (emitParameterUpdate && this.modes.edit.setParameterEmitter) {
      this.modes.edit.setParameterEmitter(emitParameterUpdate);
    }

    this.onModeChanged = onModeChanged;
    this.activeModeKey = null;
    this.defaultMode = defaultMode;
    this.lastContext = null;
  }

  get activeMode() {
    return this.modes[this.activeModeKey] ?? null;
  }

  async init(context = {}) {
    return this.setMode(this.defaultMode, context);
  }

  async setMode(modeKey, context = undefined) {
    const nextMode = this.modes[modeKey];
    if (!nextMode) {
      throw new Error(`[OrbiterModeController] unknown mode "${modeKey}"`);
    }
    const resolvedContext = context ?? this.lastContext ?? {};
    if (!Object.keys(resolvedContext).length) {
      throw new Error('[OrbiterModeController] setMode requires a context on first call');
    }
    const switchingToSameMode = this.activeModeKey === modeKey;

    if (this.activeModeKey && !switchingToSameMode) {
      const currentMode = this.modes[this.activeModeKey];
      if (currentMode?.deactivate) {
        await currentMode.deactivate(resolvedContext);
      }
    }

    this.activeModeKey = modeKey;
    this.lastContext = resolvedContext;
    // The oscilloscope is per-voice; drive the active (focused) voice's instance.
    voiceRegistry.getActive()?.oscilloscope?.setRequirePlaybackState(modeKey !== 'edit');

    if (switchingToSameMode) {
      if (typeof nextMode.refresh === 'function') {
        return nextMode.refresh(resolvedContext);
      }
      return true;
    }

    const activationResult = await nextMode.activate(resolvedContext);
    this.onModeChanged?.(modeKey, resolvedContext);
    return activationResult;
  }

  getActiveMode() {
    return this.activeModeKey;
  }

  isEditMode() {
    return this.activeModeKey === 'edit';
  }

  getActiveDimensionId() {
    const active = this.activeMode;
    if (active?.getActiveDimensionId) {
      return active.getActiveDimensionId();
    }
    if (this.modes.edit?.getActiveDimensionId) {
      return this.modes.edit.getActiveDimensionId();
    }
    return null;
  }

  getAvailableDimensions() {
    if (this.modes.edit?.getAvailableDimensions) {
      return this.modes.edit.getAvailableDimensions();
    }
    const active = this.activeMode;
    if (active?.getAvailableDimensions) {
      return active.getAvailableDimensions();
    }
    return [];
  }

  setActiveDimension(dimensionId, options = {}) {
    let didChange = false;
    const active = this.activeMode;
    if (active && typeof active.setActiveDimension === 'function') {
      didChange = active.setActiveDimension(dimensionId, options) || didChange;
    }
    const editMode = this.modes.edit;
    if (editMode && editMode !== active && typeof editMode.setActiveDimension === 'function') {
      didChange = editMode.setActiveDimension(dimensionId, options) || didChange;
    }
    return didChange;
  }
}

export default OrbiterModeController;
