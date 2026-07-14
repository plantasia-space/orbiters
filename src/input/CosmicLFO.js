/**
 * @file src/input/CosmicLFO.js
 * @description Manages the Cosmic LFO subsystem that drives orbiters via procedural modulation,
 * including UI state, parameter bindings, and herbarium symbol integration.
 */

import notifications from '../core/AppNotifications.js';
import { PARAM_DISPLAY_DECIMALS, PARAM_INTERNAL_PRECISION_DECIMALS } from '../core/ParameterManager.js';
import { getScopedState, setScopedState } from '../core/stackUtils.js';
import { getT } from '../i18n/index.js';
import { resolveHerbariumSymbol, fetchHerbariumSymbol, parseHerbariumSvg } from '../utils/cdnAssets.js';
import { ensureDropdownItemStructure, prepareDropdownIconSvg } from '../ui/dropdownItem.js';
// The pure oscillator + frequency kernels live in standalone TS modules.
// This facade owns only the impure parts (scoped state, PM push, knob/dropdown DOM)
// and delegates all maths here.
import { sample as oscSample } from './cosmic/LFOOscillator.ts';
import {
  MIN_FREQUENCY_HZ,
  MAX_FREQUENCY_HZ,
  toFiniteNumber,
  sanitizeFrequency,
  ensureHarmonicRange,
  applyMultiplier,
} from './cosmic/FrequencySourceManager.ts';
// The source / waveform MODEL (identity, labels, icons) is the single source of truth in
// the catalog — both this facade and the React panel read it so the list can't drift
// ([[no-two-sources-of-truth]]). This file owns only the legacy-DOM presentation of it.
import {
  MANUAL_SOURCE_KEY,
  DEFAULT_COSMIC_SOURCE_KEY,
  COSMIC_DISCRETE_SOURCES,
  COSMIC_MANUAL_SOURCE,
  COSMIC_WAVEFORMS,
  COSMIC_WAVEFORM_KEYS,
} from './cosmic/cosmicSources.ts';
// Route the PM push + scope resolution through the shared input seam.
import { getPriority } from '../config/Constants.js';
import { createInputRouter } from './source/InputRouter.ts';
import { resolveScopedContext } from './source/ScopingResolver.ts';
// Cosmic surface: the dash-form PM param id (`<axis>-cosmic-frequency`) the React
// manual-freq knob + monitor bind to. CosmicLFO bridges to it so the React knob drives the
// LFO and LFO-internal changes (kick / source switch) reflect on the knob + monitor.
import { cosmicFrequencyParamId } from './cosmicFrequencyParam.js';

const COSMIC_ICON_SIZE = '100%';

// Derive the legacy-DOM definition shapes from the shared catalog (MANUAL_SOURCE_KEY and
// the source/waveform identities are imported above). The herbarium svg resolution stays
// HERE — it's the legacy presentation concern — keyed off each catalog entry's
// `legacySymbol`, so the runtime values are identical to the former inline literals.
const ALLOWED_WAVEFORMS = COSMIC_WAVEFORM_KEYS;

const WAVEFORM_DEFINITIONS = Object.freeze(
  Object.fromEntries(
    COSMIC_WAVEFORMS.map((w) => [
      w.key,
      { label: w.label, i18nKey: w.i18nKey, icon: resolveHerbariumSymbol(w.legacySymbol) },
    ]),
  ),
);

const SOURCE_DEFINITIONS = Object.fromEntries(
  COSMIC_DISCRETE_SOURCES.map((s) => [
    s.key,
    { label: s.label, i18nKey: s.i18nKey, icon: resolveHerbariumSymbol(s.legacySymbol) },
  ]),
);

const MANUAL_MENU_META = {
  label: COSMIC_MANUAL_SOURCE.label,
  i18nKey: COSMIC_MANUAL_SOURCE.i18nKey,
  icon: resolveHerbariumSymbol(COSMIC_MANUAL_SOURCE.legacySymbol),
};

function shouldDebugCosmicLfo() {
  try {
    if (typeof window !== 'undefined') {
      return Boolean(window.__DEBUG_COSMIC_LFO);
    }
  } catch (_) {}
  return false;
}

function debugLog(instance, message, detail = {}) {
  const enabled = instance?.debug || shouldDebugCosmicLfo();
  if (!enabled) return;
  try {
    // gated by window.__DEBUG_COSMIC_LFO or instance.debug
    console.debug(`[CosmicLFO:${instance?.axis}] ${message}`, detail);
  } catch (_) {
    // ignore logging errors
  }
}

/**
 * @class CosmicLFO
 * @description A low-frequency oscillator (LFO) that derives its frequency settings from exoplanet data.
 * Allows waveforms like sine, saw, triangle, square, random, etc.
 */
export class CosmicLFO {

  /**
   * Constructor for a new CosmicLFO instance.
   * @param {string} axis - The axis this LFO controls ('x', 'y', or 'z').
   * @param {ParameterManager} parameterManager - The owning voice's ParameterManager (DI).
   */
  constructor(axis, parameterManager, { eventBus } = {}) {
    this.axis = axis;
    this.parameterManager = parameterManager;
    // The per-voice event bus this LFO mirrors its non-PM cosmic state changes onto
    // (the React `cosmic` surface subscribes to the SAME bus). Defaults to `window` so single-orbiter is
    // byte-identical; a multi tile injects its own EventTarget so one voice's cosmic toggle doesn't
    // re-read another voice's React surface.
    this._eventBus = eventBus ?? (typeof window !== 'undefined' ? window : null);
    // The seam this LFO pushes through. Lazily bound (see _inputSource()).
    this._inputSourceHandle = null;

    // Multidimensional LFO management (per dimension oscillator state)
    // Maps dimensionId -> { isActive, phase, frequency, amplitude, waveform }
    this.dimensionLFOs = new Map();
    
    // UI and state (shared across all dimensions)
    this.isActive = false; // True when any dimension is actively running
    this.waveform = 'sine';
    this.baseFrequency = 0.01;
    this.amplitude = 1.0;
    this.visualSampleRate = 30;
    this._samplerHandle = null;
    this._samplerMode = null;
    this._visualSamplerActive = false;
    this._activeDimensions = new Set();
    this.debug = false;
    this.currentExoplanet = MANUAL_SOURCE_KEY;
    this.currentMultiplier = 1;
    this.currentFrequencySource = MANUAL_SOURCE_KEY;
    this.sourceBaseFrequency = this.baseFrequency;
    this.frequencySources = {};
    this.frequencySlotMap = { manual: MANUAL_SOURCE_KEY };
    this._lastVisualValue = null;
    this._lastVisualTimestamp = null;
    this.switchElement = null;
    this._boundSwitchChange = null;
    this._boundDimensionListener = null;
    this._duringScopedApply = false;
    this._pendingSourceState = null;
    this._lastToggleValue = null;
    this._currentWaveformSelection = `${this.axis}-waveform-${this.waveform}`;
    this._lastPushedParamValue = null;
    this._lastVisualUpdateTime = 0;
    this._visualUpdateIntervalMs = 80; // ~12fps for knob/display DOM writes
    this._attachedTriggerSwitches = new Set(); // Track attached trigger switches
    this._triggerSwitchHandlers = new Map(); // Store handlers for cleanup
    this._sourcesInitialized = false;
    this._boundVisibilityChange = null;
    this._boundLanguageChange = null;
    // Cosmic surface: the CosmicLFO ↔ `<axis>-cosmic-frequency` PM bridge (the React
    // manual-freq knob + monitor bind to that param). `_freqParamSource` is the write-back
    // tag so our own publish is ignored by our subscription (the param is bidirectional, so
    // PM re-notifies even the writer). `_applyingFreqFromParam` guards the inbound apply from
    // re-publishing. See cosmicFrequencyBridge.test.js for the pinned PM contract.
    this._freqParamBound = false;
    this._freqParamController = null;
    this._applyingFreqFromParam = false;
    this._freqParamSource = `CosmicLFO:freq:${this.axis}`;
    // Same bridge for the `<axis>-cosmic-amplitude` PM param (the React amplitude knob).
    this._ampParamBound = false;
    this._ampParamController = null;
    this._applyingAmpFromParam = false;
    this._ampParamSource = `CosmicLFO:amp:${this.axis}`;

    if (typeof document !== 'undefined') {
      this._updateWaveformMenu();
    }

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const schedule = window.requestAnimationFrame || window.setTimeout;
      if (typeof schedule === 'function') {
        schedule(() => {
          this._updateWaveformMenu();
        }, 0);
      }
    }

    if (typeof document !== 'undefined') {
      this._boundVisibilityChange = () => this._onVisibilityChange();
      document.addEventListener('visibilitychange', this._boundVisibilityChange, { passive: true });
    }

    if (typeof window !== 'undefined') {
      this._boundLanguageChange = () => this._refreshLocalizedDropdownLabels();
      window.addEventListener('languageChanged', this._boundLanguageChange);
    }

    // Re-apply this axis' stored per-dimension scoped state whenever the active dimension changes.
    // (Previously registered inside the legacy `attachSwitch`; hoisted here so it survives the WAC
    // switch removal — `_applyScopedStateFromRegistry` is the only driver of scoped state on dim change.)
    if (typeof document !== 'undefined') {
      this._boundDimensionListener = () => this._applyScopedStateFromRegistry();
      document.addEventListener('orbiters:dimension-changed', this._boundDimensionListener);
    }
  }
  getScopedContext() {
    // Scope resolution consolidated into the shared resolver (was duplicated across
    // CosmicLFO / Sensors / MIDI). CosmicLFO keeps its extra ParameterManager fallback (used
    // when the world-mode controller has no active dimension) by passing parameterManager+axis.
    return resolveScopedContext({ parameterManager: this.parameterManager, axis: this.axis });
  }

  /**
   * Lazily bind the {@link InputSource} this LFO pushes through, created from the
   * ParameterManager. Priority comes from the single source of truth (PRIORITY_MAP), per axis.
   */
  _inputSource() {
    if (!this.parameterManager) return null;
    if (!this._inputSourceHandle) {
      this._inputSourceHandle = createInputRouter(this.parameterManager)
        .source(`CosmicLFO:${this.axis}`, getPriority(`cosmic-${this.axis}`));
    }
    return this._inputSourceHandle;
  }

  getComponentId() {
    return `${this.axis}.cosmic-toggle`;
  }

  _persistToggleState(isActive) {
    const { stackId, dimensionId } = this.getScopedContext();
    if (!stackId || !dimensionId) return;
    try {
      setScopedState(stackId, this.getComponentId(), Boolean(isActive), { dimensionId });
    } catch (error) {
      console.warn('[CosmicLFO] Failed to persist toggle state:', error);
    }
    this._persistCosmicState();
  }

  getStoredToggleState() {
    const { stackId, dimensionId } = this.getScopedContext();
    if (!stackId || !dimensionId) return undefined;
    try {
      return getScopedState(stackId, this.getComponentId(), { dimensionId });
    } catch (error) {
      console.warn('[CosmicLFO] Failed to read toggle state:', error);
      return undefined;
    }
  }

  _getComponentIds() {
    const axis = this.axis;
    return {
      toggle: this.getComponentId(),
      waveform: `${axis}.waveform`,
      amplitude: `${axis}.cosmic-amplitude`,
      frequency: `${axis}.cosmic-frequency`,
      source: `${axis}.exo-source`,
    };
  }

  _createSourceState() {
    const { dimensionId } = this.getScopedContext();
    const dimensionLFO = dimensionId ? this.dimensionLFOs.get(dimensionId) : null;

    // Prefer dimension-specific state when available
    if (dimensionLFO) {
      return {
        sourceKey: dimensionLFO.currentFrequencySource ?? this.currentFrequencySource,
        slotId: dimensionLFO.currentExoplanet ?? this.currentExoplanet,
        multiplier: dimensionLFO.currentMultiplier ?? this.currentMultiplier,
        baseFrequency: dimensionLFO.sourceBaseFrequency ?? this.sourceBaseFrequency,
      };
    }

    // Fallback to shared state
    return {
      sourceKey: this.currentFrequencySource,
      slotId: this.currentExoplanet,
      multiplier: this.currentMultiplier,
      baseFrequency: this.sourceBaseFrequency,
    };
  }

  _persistCosmicState(overrides = {}) {
    if (this._duringScopedApply) return;
    const { stackId, dimensionId } = this.getScopedContext();
    if (!stackId || !dimensionId) return;
    const ids = this._getComponentIds();
    try {
    const waveformSelection =
      overrides.waveform ??
      this._currentWaveformSelection ??
      `${this.axis}-waveform-${this.waveform}`;
      setScopedState(stackId, ids.waveform, waveformSelection, { dimensionId });

      const amplitudeValue = overrides.amplitude ?? this.amplitude;
      setScopedState(stackId, ids.amplitude, amplitudeValue, { dimensionId });

      const frequencyValue = overrides.baseFrequency ?? this.baseFrequency;
      setScopedState(stackId, ids.frequency, frequencyValue, { dimensionId });

      const sourceState = overrides.sourceState ?? this._createSourceState();
      setScopedState(stackId, ids.source, sourceState, { dimensionId });
    } catch (error) {
      console.warn('[CosmicLFO] Failed to persist cosmic state:', error);
    }
  }

  _applyStoredSourceState(sourceState, storedFrequency) {
    if (typeof sourceState === 'string') {
      sourceState = {
        sourceKey: sourceState,
        slotId: sourceState,
      };
    }
    const hasSources = Object.keys(this.frequencySources || {}).length > 0;
    debugLog(this, '_applyStoredSourceState:input', {
      sourceState,
      storedFrequency,
      hasSources,
    });
    if (!sourceState) {
      if (Number.isFinite(storedFrequency)) {
        if (hasSources || this._sourcesInitialized) {
          this.setFrequencySource(MANUAL_SOURCE_KEY);
          this.setBaseFrequency(storedFrequency, {
            skipSourceAssignment: true,
            skipMultiplierReset: false,
            skipSourceBaseUpdate: false,
          });
          return true;
        }
        // Defer applying default frequency until sources are available
        this._pendingSourceState = { source: null, frequency: storedFrequency };
        return false;
      }
      return true;
    }

  const {
      sourceKey: rawSourceKey = MANUAL_SOURCE_KEY,
      slotId: rawSlotId = MANUAL_SOURCE_KEY,
      multiplier = 1,
      baseFrequency = this.sourceBaseFrequency,
    } = sourceState || {};

    let effectiveSourceKey = rawSourceKey;
    let effectiveSlotId = rawSlotId;

    const frequencyCandidate = Number.isFinite(storedFrequency)
      ? storedFrequency
      : Number.isFinite(baseFrequency)
        ? baseFrequency
        : null;

    if (
      effectiveSourceKey === MANUAL_SOURCE_KEY &&
      hasSources &&
      (frequencyCandidate == null || frequencyCandidate <= MIN_FREQUENCY_HZ * 1.001)
    ) {
      effectiveSourceKey = null;
      effectiveSlotId = null;
    }

    if (effectiveSourceKey !== MANUAL_SOURCE_KEY && effectiveSourceKey !== null && !hasSources) {
      this._pendingSourceState = { source: sourceState, frequency: storedFrequency };
      return false;
    }

    if (effectiveSourceKey === MANUAL_SOURCE_KEY || (!hasSources && effectiveSourceKey === null)) {
      if (!hasSources && !this._sourcesInitialized) {
        // Defer manual/default application until sources initialize
        this._pendingSourceState = { source: sourceState, frequency: storedFrequency };
        return false;
      }
      debugLog(this, '_applyStoredSourceState -> manual', {
        effectiveSourceKey,
        storedFrequency,
        baseFrequency,
      });
      this.setFrequencySource(MANUAL_SOURCE_KEY);
      const freq = Number.isFinite(storedFrequency)
        ? storedFrequency
        : Number.isFinite(baseFrequency)
        ? baseFrequency
        : this.baseFrequency;
      if (Number.isFinite(freq)) {
        this.setBaseFrequency(freq, {
          skipSourceAssignment: true,
          skipMultiplierReset: false,
          skipSourceBaseUpdate: false,
        });
      }
      this.currentMultiplier = Number.isFinite(multiplier) ? multiplier : 1;
      return true;
    }

    if (effectiveSourceKey === null) {
      debugLog(this, '_applyStoredSourceState -> promoteFallback', {
        storedFrequency,
        baseFrequency,
      });
      const fallbackSlot =
        Object.keys(this.frequencySlotMap || {}).find(
          (key) => key !== MANUAL_SOURCE_KEY && this.frequencySlotMap[key] === 'minimumCosmicLfo',
        ) ||
        Object.keys(this.frequencySlotMap || {}).find((key) => key !== MANUAL_SOURCE_KEY);

      if (fallbackSlot) {
        this.setFrequencySource(fallbackSlot);
        return true;
      }

      this.currentMultiplier = 1;
      return true;
    }

    const selection = effectiveSourceKey || effectiveSlotId;
    debugLog(this, '_applyStoredSourceState -> cosmic', {
      selection,
      effectiveSourceKey,
      effectiveSlotId,
      baseFrequency,
      multiplier,
      storedFrequency,
    });
    this.setFrequencySource(selection);

    if (Number.isFinite(baseFrequency)) {
      this.sourceBaseFrequency = baseFrequency;
      this.setBaseFrequency(baseFrequency, {
        skipSourceAssignment: true,
        skipMultiplierReset: true,
        skipSourceBaseUpdate: true,
      });
    }

    const hasMultiplier = Number.isFinite(multiplier);
    this.currentMultiplier = 1;

    if (hasMultiplier && multiplier !== 1) {
      this.applyTriggerMultiplier(multiplier);
    } else if (hasMultiplier) {
      this.currentMultiplier = multiplier;
    }

    const finalFrequency = Number.isFinite(storedFrequency)
      ? storedFrequency
      : Number.isFinite(baseFrequency) && hasMultiplier
        ? this._sanitizeFrequency(baseFrequency * multiplier)
        : null;

    if (Number.isFinite(finalFrequency)) {
      this.setBaseFrequency(finalFrequency, {
        skipSourceAssignment: true,
        skipMultiplierReset: true,
        skipSourceBaseUpdate: true,
      });
    }

    return true;
  }

  _applyScopedStateFromRegistry() {
    const { stackId, dimensionId } = this.getScopedContext();
    if (!stackId || !dimensionId) return;
    const ids = this._getComponentIds();

    let storedToggle;
    let storedWaveform;
    let storedAmplitude;
    let storedFrequency;
    let storedSource;
    try {
      storedToggle = getScopedState(stackId, ids.toggle, { dimensionId });
    } catch (_) {}
    try {
      storedWaveform = getScopedState(stackId, ids.waveform, { dimensionId });
    } catch (_) {}
    try {
      storedAmplitude = getScopedState(stackId, ids.amplitude, { dimensionId });
    } catch (_) {}
    try {
      storedFrequency = getScopedState(stackId, ids.frequency, { dimensionId });
    } catch (_) {}
    try {
      storedSource = getScopedState(stackId, ids.source, { dimensionId });
    } catch (_) {}
    debugLog(this, '_applyScopedStateFromRegistry:stored', {
      dimensionId,
      storedToggle,
      storedWaveform,
      storedAmplitude,
      storedFrequency,
      storedSource,
    });

    // Avoid forcing blueprint defaults (near MIN_FREQUENCY_HZ) before sources are ready
    if (!storedSource && Number.isFinite(storedFrequency) && Math.abs(storedFrequency - MIN_FREQUENCY_HZ) <= MIN_FREQUENCY_HZ * 0.001 && !this._sourcesInitialized) {
      this._pendingSourceState = { source: null, frequency: storedFrequency };
      debugLog(this, '_applyScopedStateFromRegistry:deferredDefault', {
        reason: 'sources-not-initialized',
        storedFrequency,
      });
      return;
    }

    this._duringScopedApply = true;
    try {
      // Get or create dimension LFO state
      const dimensionLFO = this._ensureDimensionState(dimensionId);

      if (this.switchElement) {
        let desired;
        if (storedToggle === undefined) {
          // Do NOT inherit the current DOM switch state (global) when changing dimensions.
          // Prefer the per-dimension oscillator state, otherwise default to false.
          const existingDim = this.dimensionLFOs.get(dimensionId);
          desired = existingDim ? Boolean(existingDim.isActive) : false;
        } else {
          desired = Boolean(storedToggle);
        }
        if (typeof this.switchElement.setState === 'function') {
          this.switchElement.setState(desired ? 1 : 0, false);
        } else if ('checked' in this.switchElement) {
          this.switchElement.checked = desired;
        }
        this._lastToggleValue = desired;
        if (desired) {
          this.start();
        } else {
          this.stop();
        }
      }

      if (storedWaveform) {
        this.setWaveform(storedWaveform);
      } else if (dimensionLFO?.waveform) {
        // Sync UI with dimension state
        this.waveform = dimensionLFO.waveform;
        this._currentWaveformSelection = `${this.axis}-waveform-${dimensionLFO.waveform}`;
        this._updateWaveformDropdown(this._currentWaveformSelection);
      }

      if (Number.isFinite(storedAmplitude)) {
        this.setAmplitude(storedAmplitude);
      } else if (dimensionLFO && Number.isFinite(dimensionLFO.amplitude)) {
        // Sync UI with dimension state
        this.amplitude = dimensionLFO.amplitude;
      }

      const sourceApplied = this._applyStoredSourceState(storedSource, storedFrequency);
      if (!sourceApplied) {
        // Pending until sources are available.
      } else {
        this._pendingSourceState = null;
        if (!storedSource && Number.isFinite(storedFrequency)) {
          this.setFrequencySource(MANUAL_SOURCE_KEY);
          this.setBaseFrequency(storedFrequency, {
            skipSourceAssignment: true,
            skipMultiplierReset: false,
            skipSourceBaseUpdate: false,
          });
        } else if (dimensionLFO) {
          // Restore dimension-specific source settings to shared UI state
          this.currentFrequencySource = dimensionLFO.currentFrequencySource || MANUAL_SOURCE_KEY;
          this.currentExoplanet = dimensionLFO.currentExoplanet || MANUAL_SOURCE_KEY;
          this.currentMultiplier = Number.isFinite(dimensionLFO.currentMultiplier) 
            ? dimensionLFO.currentMultiplier 
            : 1;
          this.sourceBaseFrequency = Number.isFinite(dimensionLFO.sourceBaseFrequency)
            ? dimensionLFO.sourceBaseFrequency
            : this.baseFrequency;
          
          // Compute final frequency from base * multiplier
          if (Number.isFinite(dimensionLFO.sourceBaseFrequency) && Number.isFinite(dimensionLFO.currentMultiplier)) {
            const computedFrequency = this._sanitizeFrequency(
              dimensionLFO.sourceBaseFrequency * dimensionLFO.currentMultiplier
            );
            this.baseFrequency = computedFrequency;
            dimensionLFO.frequency = computedFrequency;
          } else if (Number.isFinite(dimensionLFO.frequency)) {
            this.baseFrequency = dimensionLFO.frequency;
          }
          
          // Restore the source-dropdown appearance for non-manual sources.
          const isManual = this.currentFrequencySource === MANUAL_SOURCE_KEY;
          if (!isManual) {
            this._updateDropdownAppearance(
              this.currentExoplanet,
              this.currentFrequencySource
            );
          }
        }
      }
    } finally {
      this._duringScopedApply = false;
    }

    this._persistCosmicState();
    
    // Cosmic surface: publish the restored frequency to the PM param so the React freq
    // knob + monitor track a dimension switch (one targeted publish for the now-active dim;
    // tagged → self-guarded, never re-drives the LFO). The per-call write-back inside
    // setBaseFrequency stays suppressed during restore (`_duringScopedApply`) so this is the
    // single, final value that lands.
    this._publishFrequencyToParam(this.baseFrequency, dimensionId);
    this._publishAmplitudeToParam(this.amplitude, dimensionId);
    // React cosmic surface re-reads enable / source / waveform for the now-active dimension.
    this._notifyCosmicChange();
  }

  /**
   * Starts the LFO oscillation loop for the current dimension.
   */
  start() {
    const { dimensionId } = this.getScopedContext();
    if (!dimensionId) {
      console.warn(`[CosmicLFO:${this.axis}] Cannot start: no dimensionId`);
      this._notifyCosmicChange(); // correct an optimistic React toggle (nothing was enabled)
      return;
    }
    const dimensionLFO = this._ensureDimensionState(dimensionId);
    if (!dimensionLFO) {
      this._notifyCosmicChange();
      return;
    }

    dimensionLFO.isActive = true;
    // Don't reset phase to 0 - preserve continuity on restart
    if (dimensionLFO.frequency == null) {
      dimensionLFO.frequency = this.baseFrequency;
    }
    if (!dimensionLFO.waveform) {
      dimensionLFO.waveform = this.waveform;
    }
    if (dimensionLFO.amplitude == null) {
      dimensionLFO.amplitude = this.amplitude;
    }
    this._activeDimensions.add(dimensionId);
    this.isActive = this._activeDimensions.size > 0;
    // PER-DIMENSION FIX: persist the enable toggle for THIS dimension so a dimension
    // switch-away-and-back restores it (the React toggle drives start()/stop() directly, so
    // without this the per-dim enable was never written and the restore stopped the channel).
    // Skipped during a scoped restore (it's reading FROM the registry, not changing intent).
    if (!this._duringScopedApply) {
      this._persistToggleState(true);
    }

    // Modulation flows through ParameterManager updates rather than direct audio connections
    this._lastVisualValue = null;
    this._ensureSamplingLoop({ forceInitial: true });
    this._notifyCosmicChange(); // React cosmic-enable toggle re-reads

    //console.log(`[CosmicLFO:${this.axis}] Started for dimension: ${dimensionId}`);
  }

  /**
   * Stops the LFO oscillation loop for the current dimension.
   */
  stop() {
    const { dimensionId } = this.getScopedContext();
    if (!dimensionId) {
      console.warn(`[CosmicLFO:${this.axis}] Cannot stop: no dimensionId`);
      this._notifyCosmicChange(); // correct an optimistic React toggle
      return;
    }
    const dimensionLFO = this.dimensionLFOs.get(dimensionId);
    if (!dimensionLFO || !dimensionLFO.isActive) {
      this._activeDimensions.delete(dimensionId);
      this.isActive = this._activeDimensions.size > 0;
      this._stopSamplingLoopIfIdle();
      if (!this._duringScopedApply) {
        this._persistToggleState(false);
      }
      this._notifyCosmicChange();
      return;
    }
    dimensionLFO.isActive = false;
    this._activeDimensions.delete(dimensionId);
    this.isActive = this._activeDimensions.size > 0;
    this._stopSamplingLoopIfIdle();
    // PER-DIMENSION FIX: persist the disabled state for THIS dimension (see start()).
    if (!this._duringScopedApply) {
      this._persistToggleState(false);
    }
    this._notifyCosmicChange(); // React cosmic-enable toggle re-reads

    // No audio connections - only parameter updates
    this._lastPushedParamValue = null;
    
    //console.log(`[CosmicLFO:${this.axis}] Stopped for dimension: ${dimensionId}`);
  }

  /**
   * REMOVED: bindAudioParam() - No longer needed.
   * LFOs now only control root parameters via parameter updates, not audio connections.
   */

  /**
   * Creates a new dimension-specific oscillator state.
   * @param {string} dimensionId - The dimension to create the state for
   * @returns {object} The dimension state record
   */
  _createDimensionState(dimensionId) {
    // Initialize with current shared state instead of hardcoded defaults
    // This ensures new dimensions inherit the current cosmic source settings
    const dimensionLFO = {
      isActive: false,
      phase: 0,
      frequency: this.baseFrequency,
      amplitude: this.amplitude,
      waveform: this.waveform,
      // Copy current frequency source settings from shared state
      currentFrequencySource: this.currentFrequencySource || MANUAL_SOURCE_KEY,
      currentExoplanet: this.currentExoplanet || MANUAL_SOURCE_KEY,
      currentMultiplier: this.currentMultiplier || 1,
      sourceBaseFrequency: this.sourceBaseFrequency || this.baseFrequency,
    };
    
    this.dimensionLFOs.set(dimensionId, dimensionLFO);
    //console.log(`[CosmicLFO:${this.axis}] Created dimension state for: ${dimensionId} with source: ${dimensionLFO.currentFrequencySource}`);
    
    return dimensionLFO;
  }

  _isDimensionActive(dimensionId = null) {
    const target = dimensionId ?? this.getScopedContext().dimensionId;
    return target ? this._activeDimensions.has(target) : false;
  }

  _ensureDimensionState(dimensionId = null) {
    const targetId = dimensionId ?? this.getScopedContext().dimensionId;
    if (!targetId) {
      console.warn(`[CosmicLFO:${this.axis}] Cannot ensure dimension state: no dimensionId`);
      return null;
    }

    let dimensionLFO = this.dimensionLFOs.get(targetId);
    if (!dimensionLFO) {
      dimensionLFO = this._createDimensionState(targetId);
    }

    return dimensionLFO;
  }

  _getParameterRange() {
    const param = this.parameterManager?.getParameter(this.axis);
    if (!param) {
      return { min: 0, max: 1 };
    }
    if (param.min === param.max) {
      const fallback = param.min || 0;
      return { min: fallback, max: fallback + 1 };
    }
    return { min: param.min, max: param.max };
  }

  _ensureSamplingLoop({ forceInitial = false } = {}) {
    if (this._visualSamplerActive) {
      if (forceInitial) {
        this._tickSampler({ force: true });
      }
      return;
    }

    this._visualSamplerActive = true;
    this._lastVisualTimestamp = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._tickSampler({ force: true });
    this._scheduleNextSample();
  }

  _stopSamplingLoopIfIdle() {
    if (this._activeDimensions.size === 0) {
      this._visualSamplerActive = false;
      this._cancelScheduledSample();
      this._lastVisualTimestamp = null;
      this._lastVisualValue = null;
    }
  }

  _isDocumentVisible() {
    if (typeof document === 'undefined') {
      return true;
    }
    return document.visibilityState !== 'hidden';
  }

  _getBackgroundTickMs() {
    const sampleRate = Number(this.visualSampleRate);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      return 33;
    }
    return Math.max(16, Math.round(1000 / Math.max(1, Math.min(sampleRate, 60))));
  }

  _cancelScheduledSample() {
    if (!this._samplerHandle) {
      return;
    }
    if (this._samplerMode === 'timeout') {
      clearTimeout(this._samplerHandle);
    } else {
      cancelAnimationFrame(this._samplerHandle);
    }
    this._samplerHandle = null;
    this._samplerMode = null;
  }

  _scheduleNextSample() {
    if (!this._visualSamplerActive) {
      return;
    }

    if (this._isDocumentVisible() && typeof requestAnimationFrame === 'function') {
      this._samplerMode = 'raf';
      this._samplerHandle = requestAnimationFrame((now) => {
        this._samplerHandle = null;
        if (!this._visualSamplerActive) {
          return;
        }
        this._tickSampler({ rafNow: now });
        this._scheduleNextSample();
      });
      return;
    }

    this._samplerMode = 'timeout';
    this._samplerHandle = setTimeout(() => {
      this._samplerHandle = null;
      if (!this._visualSamplerActive) {
        return;
      }
      this._tickSampler();
      this._scheduleNextSample();
    }, this._getBackgroundTickMs());
  }

  _onVisibilityChange() {
    if (!this._visualSamplerActive || this._activeDimensions.size === 0) {
      return;
    }

    this._cancelScheduledSample();
    this._tickSampler({ force: true });
    this._scheduleNextSample();
  }

  _tickSampler({ force = false, rafNow = null } = {}) {
    if (this._activeDimensions.size === 0) {
      return;
    }
    // Use the rAF-provided high-res timestamp when available to avoid a
    // redundant performance.now() call and keep deltaTime accurate.
    const now = rafNow ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let deltaTime = null;
    if (this._lastVisualTimestamp != null) {
      deltaTime = Math.max((now - this._lastVisualTimestamp) / 1000, 0);
    }
    this._lastVisualTimestamp = now;
    this._syncParameterFromLfo({ force, deltaTime, now });
  }

  _syncParameterFromLfo({ force = false, deltaTime = null, now = null } = {}) {
    // Get the currently active dimension for visual updates
    const { dimensionId: activeDimensionId } = this.getScopedContext();
    
    // Early exit if we don't have parameterManager
    if (!this.parameterManager) {
      console.warn(`[CosmicLFO:${this.axis}] No parameterManager!`);
      return;
    }
    
    //console.log(`[CosmicLFO:${this.axis}] _syncParameterFromLfo called, dimensionLFOs size: ${this.dimensionLFOs.size}`);

    // Update ALL active dimension LFOs and push their values
    this.dimensionLFOs.forEach((dimensionLFO, dimensionId) => {
      //console.log(`[CosmicLFO:${this.axis}:${dimensionId}] Checking - isActive: ${dimensionLFO.isActive}`);

      if (!dimensionLFO.isActive) {
        return;
      }

      const range = this._getParameterRange();
      const amplitude = dimensionLFO.amplitude ?? this.amplitude;
      const step = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 1 / 60;
      const frequency = Math.max(dimensionLFO.frequency ?? this.baseFrequency ?? MIN_FREQUENCY_HZ, MIN_FREQUENCY_HZ);
      const waveformType = dimensionLFO.waveform ?? this.waveform;
      // One pure oscillator step (advance phase, evaluate waveform, map +
      // clamp into the param range). Feed the advanced phase back for the next tick.
      const { phase, value: clamped } = oscSample({
        phase: dimensionLFO.phase,
        frequencyHz: frequency,
        dtSeconds: step,
        waveform: waveformType,
        amplitude,
        range,
      });
      dimensionLFO.phase = phase;
      //console.log(`[CosmicLFO:${this.axis}:${dimensionId}] LFO value: ${clamped}, freq: ${frequency}, waveform=${waveformType}, range: [${range.min}, ${range.max}]`);
      
      // Push the value to the root parameter for this dimension
      // (ParameterManager will reject if dimension is locked)
      this._pushRootParameterValue(clamped, dimensionId);

      // Only update visual knob if this is the active dimension AND not locked.
      // DOM writes are throttled to _visualUpdateIntervalMs to avoid main-thread pressure;
      // the audio parameter push above always runs at full LFO rate.
      if (dimensionId === activeDimensionId &&
          !this.parameterManager.isParameterDimensionLocked(this.axis, dimensionId)) {
        if (!force && this._lastVisualValue != null && Math.abs(this._lastVisualValue - clamped) <= 1e-6) {
          return;
        }
        const visualNow = now ?? performance.now();
        if (!force && (visualNow - this._lastVisualUpdateTime) < this._visualUpdateIntervalMs) {
          return;
        }
        this._lastVisualUpdateTime = visualNow;
        this._lastVisualValue = clamped;
        this._updateAxisKnob(clamped, range);

        if (this.debug) {
          if (!this.debugFrameCount) { this.debugFrameCount = 0; }
          this.debugFrameCount++;
          if (this.debugFrameCount % this.visualSampleRate === 0) {
            const normalized = this.parameterManager.normalize(clamped, range.min, range.max);
            try { console.debug(`CosmicLFO (${this.axis}): freq=${frequency.toFixed(4)}Hz, waveform=${waveformType}, value=${clamped.toFixed(3)}, norm=${normalized.toFixed(3)}`); } catch (_) {}
          }
        }
      }
    });
  }

  /**
   * Pushes the LFO value to the root parameter for a specific dimension.
   * This is what actually makes the audio change!
   */
  _pushRootParameterValue(value, dimensionId) {
    // parameterManager and stackId are already validated in _syncParameterFromLfo
    // Push through the unified seam. Priority now from PRIORITY_MAP (cosmic-x/y/z),
    // which keeps cosmic below sensors (the intended order), replacing the hard-coded 10.
    const inputSource = this._inputSource();
    if (!inputSource) return;
    inputSource.set(this.axis, value, { kind: 'raw', dim: dimensionId });
  }

  /**
   * Sets the waveform type (sine, square, triangle, etc.).
   * @param {string} newWaveform - The desired waveform type.
   */
  setWaveform(newWaveform) {
    const selectionValue = typeof newWaveform === 'string' && newWaveform.includes('-waveform-')
      ? newWaveform
      : `${this.axis}-waveform-${newWaveform || this.waveform}`;
    const extracted = selectionValue.replace(`${this.axis}-waveform-`, '').toLowerCase();
    const resolved = ALLOWED_WAVEFORMS.includes(extracted) ? extracted : 'sine';
    this.waveform = resolved;
    this._currentWaveformSelection = selectionValue;
    
    const { dimensionId } = this.getScopedContext();
    if (dimensionId) {
      const dimensionLFO = this._ensureDimensionState(dimensionId);
      if (dimensionLFO) {
        dimensionLFO.waveform = resolved;
      }
    }
    
    this._syncParameterFromLfo({ force: true });
    
    this._updateWaveformDropdown(selectionValue);
    if (!this._duringScopedApply) {
      this._persistCosmicState({ waveform: selectionValue });
    }
    this._notifyCosmicChange(); // React waveform select re-reads
  }

  /**
   * Sets the base frequency.
   * @param {number} freq - The new frequency.
   */
  /**
   * Cosmic surface — bind the CosmicLFO ↔ `<axis>-cosmic-frequency` PM bridge once
   * the param exists (registered by OrbitersEditMode). Idempotent + guarded on registration,
   * so it's safe to call from several lifecycle points (enterMode / setBaseFrequency) and only
   * binds when the param is live. Subscribes with `dimensionId=null` so it follows the active
   * dimension (Option C); inbound edits drive {@link setBaseFrequency}, our own write-back is
   * self-guarded by `_freqParamSource`.
   * @private
   */
  _ensureFrequencyParamBridge() {
    if (this._freqParamBound || !this.parameterManager) return;
    const paramId = cosmicFrequencyParamId(this.axis);
    // Only bind once the param is registered — else this no-ops and a later call retries.
    if (
      typeof this.parameterManager.getParameter === 'function' &&
      !this.parameterManager.getParameter(paramId)
    ) {
      return;
    }
    if (typeof this.parameterManager.subscribe !== 'function') return;
    this._freqParamController = {
      onParameterChanged: (_name, value, dimensionId, metadata) => {
        this._onFrequencyParamChanged(value, dimensionId, metadata);
      },
    };
    this.parameterManager.subscribe(
      this._freqParamController,
      paramId,
      getPriority(`cosmic-${this.axis}`),
      null,
    );
    this._freqParamBound = true;
  }

  /**
   * Inbound from the React manual-freq knob / MIDI: apply a frequency edit to the LFO.
   * Ignores our own write-back (`sourceController === _freqParamSource`) and anything other
   * than a genuine value-change / unchanged-commit (dimension restore is handled by
   * `_applyScopedStateFromRegistry`, not re-driven from notifications).
   * @private
   */
  _onFrequencyParamChanged(value, _dimensionId, metadata) {
    if (metadata?.sourceController === this._freqParamSource) return;
    const reason = metadata?.reason;
    if (reason !== 'value-change' && reason !== 'unchanged-commit') return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    // Treat as a manual frequency edit (the knob only shows in manual mode) — mirror the
    // legacy WAC knob change handler's options (keep the source, reset the multiplier, update
    // the source base). Flag so setBaseFrequency does not re-publish the value we just received.
    this._applyingFreqFromParam = true;
    try {
      this.setBaseFrequency(numeric, {
        skipSourceAssignment: true,
        skipMultiplierReset: false,
        skipSourceBaseUpdate: false,
      });
    } finally {
      this._applyingFreqFromParam = false;
    }
  }

  /**
   * Write-back: publish an LFO-internal frequency change (kick, source switch, manual knob)
   * to the `<axis>-cosmic-frequency` PM param so the React knob + monitor reflect it. Tagged
   * with `_freqParamSource` so our own subscription ignores it. No-op when the param isn't
   * registered or no dimension is resolvable.
   * @private
   */
  _publishFrequencyToParam(value, dimensionId) {
    if (!this.parameterManager) return;
    const paramId = cosmicFrequencyParamId(this.axis);
    if (
      typeof this.parameterManager.getParameter === 'function' &&
      !this.parameterManager.getParameter(paramId)
    ) {
      return;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const dim = dimensionId || this.getScopedContext().dimensionId;
    const priority = getPriority(`cosmic-${this.axis}`);
    try {
      if (dim && typeof this.parameterManager.setDimensionValue === 'function') {
        this.parameterManager.setDimensionValue(paramId, dim, numeric, this._freqParamSource, priority, {
          updateIntent: 'commit',
        });
      } else if (typeof this.parameterManager.setRawValue === 'function') {
        this.parameterManager.setRawValue(paramId, numeric, this._freqParamSource, priority, {
          updateIntent: 'commit',
        });
      }
    } catch (_error) {
      // Tolerate a locked dimension / mid-teardown PM — the knob just won't track this change.
    }
  }

  /**
   * Cosmic surface — broadcast a non-PM cosmic state change (enable / source /
   * waveform) so the React `cosmic` surface re-reads it. Freq + amplitude flow through their
   * PM params (the knobs auto-update), so this is only for the discrete/boolean controls.
   * @private
   */
  _notifyCosmicChange() {
    // Dispatch on this voice's eventBus (window for single-orbiter → byte-identical).
    if (!this._eventBus || typeof this._eventBus.dispatchEvent !== 'function') return;
    try {
      this._eventBus.dispatchEvent(new CustomEvent('orbiters:cosmic-changed', { detail: { axis: this.axis } }));
    } catch (_error) {
      // no-op
    }
  }

  /** Whether the cosmic LFO is enabled (running) for the ACTIVE dimension (React toggle). */
  isCosmicEnabled() {
    const { dimensionId } = this.getScopedContext();
    if (!dimensionId) return Boolean(this.isActive);
    const dim = this.dimensionLFOs.get(dimensionId);
    return dim ? Boolean(dim.isActive) : false;
  }

  /** The current modulation-source key (catalog key, e.g. 'manual' / 'minimumCosmicLfo'). */
  getFrequencySource() {
    return this.currentFrequencySource || MANUAL_SOURCE_KEY;
  }

  /** The current waveform key (e.g. 'sine'). */
  getWaveform() {
    return this.waveform || 'sine';
  }

  setBaseFrequency(freq, options = {}) {
    this._ensureFrequencyParamBridge();
    const {
      skipSourceAssignment = false,
      skipMultiplierReset = false,
      skipSourceBaseUpdate = false
    } = options;

    const sanitized = this._sanitizeFrequency(freq);
    debugLog(this, 'setBaseFrequency', {
      requested: freq,
      sanitized,
      options,
    });
    this.baseFrequency = sanitized;

    const { dimensionId } = this.getScopedContext();
    const dimensionLFO = dimensionId ? this._ensureDimensionState(dimensionId) : null;

    if (dimensionLFO) {
      dimensionLFO.frequency = sanitized;
      
      if (!skipMultiplierReset) {
        dimensionLFO.currentMultiplier = 1;
      }

      if (!skipSourceBaseUpdate) {
        dimensionLFO.sourceBaseFrequency = sanitized;
      }

      if (!skipSourceAssignment) {
        dimensionLFO.currentFrequencySource = MANUAL_SOURCE_KEY;
        dimensionLFO.currentExoplanet = MANUAL_SOURCE_KEY;
      }
    }

    // Also update shared state for UI display
    if (!skipMultiplierReset) {
      this.currentMultiplier = 1;
    }

    if (!skipSourceBaseUpdate) {
      this.sourceBaseFrequency = sanitized;
    }

    if (!skipSourceAssignment) {
      this.currentFrequencySource = MANUAL_SOURCE_KEY;
      this.currentExoplanet = MANUAL_SOURCE_KEY;
    }

    this._syncParameterFromLfo({ force: true });
    if (!this._duringScopedApply) {
      this._persistCosmicState({ baseFrequency: this.baseFrequency });
    }
    // Cosmic surface: mirror the new frequency to the PM param so the React knob +
    // monitor track kick / source-switch / manual changes. Skip when we're applying a value
    // that just came FROM the param (no echo) or during a scoped restore (handled elsewhere).
    if (!this._applyingFreqFromParam && !this._duringScopedApply) {
      this._publishFrequencyToParam(sanitized, dimensionId);
    }
  }

  /**
   * Ensures amplitude controls are initialized and bound.
   * @private
   */

  /**
   * Shows or hides the amplitude controls.
   * @param {boolean} show - Whether to show the controls.
   * @private
   */

  /**
   * Syncs the visual knob state with the internal amplitude value.
   * @private
   */

  /** The dash-form PM param id the React amplitude knob binds to. @private */
  _amplitudeParamId() {
    return `${this.axis}-cosmic-amplitude`;
  }

  /**
   * Cosmic surface — bind the CosmicLFO ↔ `<axis>-cosmic-amplitude` PM bridge (mirror
   * of the frequency bridge). Idempotent + guarded on registration. @private
   */
  _ensureAmplitudeParamBridge() {
    if (this._ampParamBound || !this.parameterManager) return;
    const paramId = this._amplitudeParamId();
    if (
      typeof this.parameterManager.getParameter === 'function' &&
      !this.parameterManager.getParameter(paramId)
    ) {
      return;
    }
    if (typeof this.parameterManager.subscribe !== 'function') return;
    this._ampParamController = {
      onParameterChanged: (_name, value, dimensionId, metadata) => {
        this._onAmplitudeParamChanged(value, dimensionId, metadata);
      },
    };
    this.parameterManager.subscribe(
      this._ampParamController,
      paramId,
      getPriority(`cosmic-${this.axis}`),
      null,
    );
    this._ampParamBound = true;
  }

  /** Inbound from the React amplitude knob / MIDI → apply to the LFO. @private */
  _onAmplitudeParamChanged(value, _dimensionId, metadata) {
    if (metadata?.sourceController === this._ampParamSource) return;
    const reason = metadata?.reason;
    if (reason !== 'value-change' && reason !== 'unchanged-commit') return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    this._applyingAmpFromParam = true;
    try {
      this.setAmplitude(numeric);
    } finally {
      this._applyingAmpFromParam = false;
    }
  }

  /** Write-back: mirror an LFO-internal amplitude change to the PM param. @private */
  _publishAmplitudeToParam(value, dimensionId) {
    if (!this.parameterManager) return;
    const paramId = this._amplitudeParamId();
    if (
      typeof this.parameterManager.getParameter === 'function' &&
      !this.parameterManager.getParameter(paramId)
    ) {
      return;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const dim = dimensionId || this.getScopedContext().dimensionId;
    const priority = getPriority(`cosmic-${this.axis}`);
    try {
      if (dim && typeof this.parameterManager.setDimensionValue === 'function') {
        this.parameterManager.setDimensionValue(paramId, dim, numeric, this._ampParamSource, priority, {
          updateIntent: 'commit',
        });
      } else if (typeof this.parameterManager.setRawValue === 'function') {
        this.parameterManager.setRawValue(paramId, numeric, this._ampParamSource, priority, {
          updateIntent: 'commit',
        });
      }
    } catch (_error) {
      // Tolerate a locked dimension / mid-teardown PM.
    }
  }

  setAmplitude(value, options = {}) {
    this._ensureAmplitudeParamBridge();
    const numeric = Number(value);
    const clamped = Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 1));
    this.amplitude = Number(clamped.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
    
    const { dimensionId } = this.getScopedContext();
    if (dimensionId) {
      const dimensionLFO = this._ensureDimensionState(dimensionId);
      if (dimensionLFO) {
        dimensionLFO.amplitude = this.amplitude;
      }
    }
    
    // Sync UI

    this._syncParameterFromLfo({ force: true });

    if (!this._duringScopedApply) {
      this._persistCosmicState({ amplitude: this.amplitude });
    }
    // Cosmic surface: mirror the amplitude to the PM param so the React knob tracks it
    // (skip echo from a param-driven apply + per-call writes during a scoped restore — the
    // restore's single targeted publish lands the final value).
    if (!this._applyingAmpFromParam && !this._duringScopedApply) {
      this._publishAmplitudeToParam(this.amplitude, this.getScopedContext().dimensionId);
    }
    this._lastVisualValue = null;
  }

  isAudioConnected() {
    return false;
  }

  _updateAxisKnob(rawValue, range = null) {
    if (!this._isDimensionActive()) {
      return;
    }
    const knob = document.getElementById(`${this.axis}Knob`);
    if (!knob) {
      return;
    }
    const min = Number(range?.min ?? knob.getAttribute('min') ?? 0);
    const max = Number(range?.max ?? knob.getAttribute('max') ?? 1);
    const clamped = Math.min(max, Math.max(min, rawValue));
    const current = Number(knob.value);
    if (Number.isFinite(current) && Math.abs(current - clamped) <= 1e-6) {
      return;
    }
    if (typeof knob.setValue === 'function') {
      knob.setValue(clamped, false);
    } else {
      knob.value = clamped;
    }
    knob.setAttribute('value', clamped.toFixed(PARAM_DISPLAY_DECIMALS));
  }



  // Clamp + round delegates to the pure FrequencySourceManager kernel.
  _sanitizeFrequency(freq) {
    return sanitizeFrequency(freq);
  }

  /**
   * Called when the Cosmic LFO mode is activated.
   * Shows Cosmic LFO UI elements and starts the LFO.
   */
  enterMode() {
    // Cosmic surface: bind the freq + amplitude PM bridges so the React knobs can drive
    // the LFO the moment the cosmic panel is active (idempotent; only bind once params exist).
    this._ensureFrequencyParamBridge();
    this._ensureAmplitudeParamBridge();
    // Ensure amplitude controls are ready

    const cosmicElements = document.querySelectorAll(
      '[data-group$="-waveform-dropdown"], ' +
      '[data-group$="-exo-lfo-dropdown"], ' +
      '[id^="xCosmic"], [id^="yCosmic"], [id^="zCosmic"], ' +
      'webaudio-monitor[id^="cosmic-lfo-"]'
    );
    cosmicElements.forEach(el => {
      el.style.display = '';
      if (el.classList.contains('freq-multiplier-btn-lfo')) {
        el.classList.add('is-visible');
      }
      if (el.classList.contains('cosmic-amplitude-control')) {
        el.classList.add('is-visible');
      }
    });

    const { dimensionId } = this.getScopedContext();
    const dimensionLFO = dimensionId ? this.dimensionLFOs.get(dimensionId) : null;
    if (dimensionLFO) {
      this.currentFrequencySource = dimensionLFO.currentFrequencySource || MANUAL_SOURCE_KEY;
      this.currentExoplanet = dimensionLFO.currentExoplanet || MANUAL_SOURCE_KEY;
      this.currentMultiplier = Number.isFinite(dimensionLFO.currentMultiplier)
        ? Number(dimensionLFO.currentMultiplier)
        : 1;
      this.sourceBaseFrequency = Number.isFinite(dimensionLFO.sourceBaseFrequency)
        ? dimensionLFO.sourceBaseFrequency
        : this.baseFrequency;
      if (Number.isFinite(dimensionLFO.frequency)) {
        this.baseFrequency = dimensionLFO.frequency;
      }
    }

    const isManual = this.currentFrequencySource === MANUAL_SOURCE_KEY;
    if (!isManual) {
      this._updateDropdownAppearance(
        this.currentExoplanet,
        this.currentFrequencySource
      );
    }

    // Force a resize/redraw to ensure knobs render at correct size
    if (typeof window !== 'undefined') {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }
    
    // VIEW-ONLY: do NOT start/stop the LFO on a panel switch. The channel enable is owned by the React
    // cosmic surface (toggle → cosmic.setEnabled → start/stop) + per-dimension scoped state. The legacy
    // `${axis}CosmicLFO` <webaudio-switch> was removed in the React migration, so the old getElementById
    // guard always fell through to stop() and silently disabled the LFO every time the panel changed.
  }

  /**
   * Called when the Cosmic LFO mode is deactivated.
   * Hides Cosmic LFO UI elements and stops the LFO.
   */
  exitMode() {
    const cosmicElements = document.querySelectorAll(
      '[data-group$="-waveform-dropdown"], ' +
      '[data-group$="-exo-lfo-dropdown"], ' +
      '[id^="xCosmic"], [id^="yCosmic"], [id^="zCosmic"], ' +
      'webaudio-monitor[id^="cosmic-lfo-"]'
    );
    cosmicElements.forEach(el => {
      el.style.display = 'none';
      if (el.classList.contains('freq-multiplier-btn-lfo')) {
        el.classList.remove('is-visible');
      }
      if (el.classList.contains('cosmic-amplitude-control')) {
        el.classList.remove('is-visible');
      }
    });
    // VIEW-ONLY: do NOT stop the LFO when leaving the cosmic panel (see enterMode) — that disabled the
    // channels on every panel switch via the now-removed <webaudio-switch> guard.
  }

  /** Optional: If you need exoplanet-based logic **/
  handleSelectionChange(type, value) {
    if (type === 'waveform') {
      this.setWaveform(value);
    } else if (type === 'exo') {
      this.setCurrentExoplanet(value);
    }
  }
  
  setCurrentExoplanet(selection) {
    this.setFrequencySource(selection);
  }

  setFrequencySource(selection) {
    this._setFrequencySourceImpl(selection);
    // Notify on EVERY path (incl. the fallback-to-manual when a source has no data) so
    // the React source select re-reads and reflects the true source promptly, instead of the
    // optimistic pick lingering (showing the wrong mode) until the next unrelated cosmic event.
    this._notifyCosmicChange();
  }

  _setFrequencySourceImpl(selection) {
    if (!selection) {
      return;
    }

    const rawValue = typeof selection === 'string' ? selection.trim() : String(selection).trim();
    if (!rawValue) {
      return;
    }
    const sourceKey = rawValue === 'manual-frequency' ? MANUAL_SOURCE_KEY : rawValue;

    debugLog(this, 'setFrequencySource:request', { selection, normalized: sourceKey });

    const { dimensionId } = this.getScopedContext();
    const dimensionLFO = dimensionId ? this._ensureDimensionState(dimensionId) : null;

    if (sourceKey === MANUAL_SOURCE_KEY) {
      debugLog(this, 'setFrequencySource -> manual', { dimensionId });
      this.currentFrequencySource = MANUAL_SOURCE_KEY;
      this.currentExoplanet = MANUAL_SOURCE_KEY;
      this.sourceBaseFrequency = this.baseFrequency;
      this.currentMultiplier = 1;

      if (dimensionLFO) {
        dimensionLFO.currentFrequencySource = MANUAL_SOURCE_KEY;
        dimensionLFO.currentExoplanet = MANUAL_SOURCE_KEY;
        dimensionLFO.sourceBaseFrequency = dimensionLFO.frequency || this.baseFrequency;
        dimensionLFO.currentMultiplier = 1;
      }

      this._updateDropdownAppearance(MANUAL_SOURCE_KEY, MANUAL_SOURCE_KEY);
      if (!this._duringScopedApply) {
        this._persistCosmicState({
          sourceState: this._createSourceState(),
          baseFrequency: this.baseFrequency,
        });
      }
      return;
    }

    let resolvedSourceKey = sourceKey;
    if (resolvedSourceKey !== MANUAL_SOURCE_KEY && typeof this.frequencySources[resolvedSourceKey] !== 'number') {
      const ciMatch = Object.keys(this.frequencySources).find(
        (k) => k.toLowerCase() === String(resolvedSourceKey).toLowerCase(),
      );
      if (ciMatch) resolvedSourceKey = ciMatch;
    }
    if (resolvedSourceKey === MANUAL_SOURCE_KEY) {
      debugLog(this, 'setFrequencySource -> manualSlot', { dimensionId, sourceKey: resolvedSourceKey });
      this.currentFrequencySource = MANUAL_SOURCE_KEY;
      this.currentExoplanet = MANUAL_SOURCE_KEY;
      this.sourceBaseFrequency = this.baseFrequency;
      this.currentMultiplier = 1;

      if (dimensionLFO) {
        dimensionLFO.currentFrequencySource = MANUAL_SOURCE_KEY;
        dimensionLFO.currentExoplanet = MANUAL_SOURCE_KEY;
        dimensionLFO.sourceBaseFrequency = dimensionLFO.frequency || this.baseFrequency;
        dimensionLFO.currentMultiplier = 1;
      }

      this._updateDropdownAppearance(MANUAL_SOURCE_KEY, MANUAL_SOURCE_KEY);
      if (!this._duringScopedApply) {
        this._persistCosmicState({
          sourceState: this._createSourceState(),
          baseFrequency: this.baseFrequency,
        });
      }
      return;
    }

    const nextFrequency = this.frequencySources[resolvedSourceKey];
    if (typeof nextFrequency !== 'number') {
      debugLog(this, 'setFrequencySource -> missingFrequency', {
        dimensionId,
        sourceKey: resolvedSourceKey,
        selection,
      });
      console.warn(`CosmicLFO (${this.axis}): Missing frequency data for source "${resolvedSourceKey}". Falling back to manual input.`);
      // Only nag the USER when THEY actively pick a source whose data is missing. During the internal
      // per-dimension scoped re-application (`_duringScopedApply`, e.g. on a dimension switch) we fall
      // back to manual silently — toasting on every dimension change is noise, not actionable.
      if (typeof notifications?.showToast === 'function' && !this._duringScopedApply) {
        const readableLabel = SOURCE_DEFINITIONS[resolvedSourceKey]?.label || resolvedSourceKey;
        notifications.showToast(`Missing data for ${readableLabel}. frequency enabled.`, 'warning', 4000);
      }
      this.currentFrequencySource = MANUAL_SOURCE_KEY;
      this.currentExoplanet = MANUAL_SOURCE_KEY;

      if (dimensionLFO) {
        dimensionLFO.currentFrequencySource = MANUAL_SOURCE_KEY;
        dimensionLFO.currentExoplanet = MANUAL_SOURCE_KEY;
      }

      this._updateDropdownAppearance(MANUAL_SOURCE_KEY, MANUAL_SOURCE_KEY);
      if (!this._duringScopedApply) {
        this._persistCosmicState({
          sourceState: this._createSourceState(),
          baseFrequency: this.baseFrequency,
        });
      }
      return;
    }

    this.currentFrequencySource = resolvedSourceKey;
    this.currentExoplanet = resolvedSourceKey;
    this.sourceBaseFrequency = nextFrequency;
    this.currentMultiplier = 1;
    debugLog(this, 'setFrequencySource -> cosmic', {
      dimensionId,
      sourceKey: resolvedSourceKey,
      baseFrequency: nextFrequency,
    });

    if (dimensionLFO) {
      dimensionLFO.currentFrequencySource = resolvedSourceKey;
      dimensionLFO.currentExoplanet = resolvedSourceKey;
      dimensionLFO.sourceBaseFrequency = nextFrequency;
      dimensionLFO.currentMultiplier = 1;
    }

    this.setBaseFrequency(nextFrequency, {
      skipSourceAssignment: true,
      skipMultiplierReset: false,
      skipSourceBaseUpdate: false
    });
    this._updateDropdownAppearance(resolvedSourceKey, resolvedSourceKey);
    if (!this._duringScopedApply) {
      this._persistCosmicState({
        sourceState: this._createSourceState(),
        baseFrequency: this.baseFrequency,
      });
    }
  }

  /**
   * Configures the available frequency sources from astronomical data.
   * @param {object} rawSources
   */
  setFrequencySources(rawSources = {}) {
    const extracted = this._extractFrequencySources(rawSources);
    this.frequencySources = extracted;
    this._sourcesInitialized = true;
    debugLog(this, 'setFrequencySources', { rawSources, extracted });

    const slotMap = this._updateFrequencySourceMenu(extracted);
    this.frequencySlotMap = slotMap;

    const defaultSlot = typeof extracted[DEFAULT_COSMIC_SOURCE_KEY] === 'number'
      ? DEFAULT_COSMIC_SOURCE_KEY
      : Object.keys(slotMap).find(
        key => key === slotMap[key] && slotMap[key] === DEFAULT_COSMIC_SOURCE_KEY,
      );

    if (defaultSlot && typeof extracted[DEFAULT_COSMIC_SOURCE_KEY] === 'number') {
      this.currentFrequencySource = DEFAULT_COSMIC_SOURCE_KEY;
      this.currentExoplanet = defaultSlot;
      this.sourceBaseFrequency = extracted[DEFAULT_COSMIC_SOURCE_KEY];
      this.currentMultiplier = 1;
      debugLog(this, 'setFrequencySources -> default cosmic', {
        source: defaultSlot,
        baseFrequency: this.sourceBaseFrequency,
      });
      this.setBaseFrequency(extracted[DEFAULT_COSMIC_SOURCE_KEY], {
        skipSourceAssignment: true,
        skipMultiplierReset: false,
        skipSourceBaseUpdate: false
      });
      this._updateDropdownAppearance(defaultSlot, DEFAULT_COSMIC_SOURCE_KEY);
    } else {
      this.currentFrequencySource = MANUAL_SOURCE_KEY;
      this.currentExoplanet = MANUAL_SOURCE_KEY;
      this.sourceBaseFrequency = this.baseFrequency;
      this.currentMultiplier = 1;
      this._updateDropdownAppearance(MANUAL_SOURCE_KEY, MANUAL_SOURCE_KEY);
      debugLog(this, 'setFrequencySources -> default manual', {
        baseFrequency: this.baseFrequency,
      });
    }

    if (this.currentFrequencySource !== MANUAL_SOURCE_KEY && Number.isFinite(this.sourceBaseFrequency)) {
      this._reseedDimensionStatesWithCosmicSource({
        sourceKey: this.currentFrequencySource,
        slotId: this.currentExoplanet,
        baseFrequency: this.sourceBaseFrequency,
      });
    }

    if (this._pendingSourceState) {
      const pending = this._pendingSourceState;
      this._pendingSourceState = null;
      this._duringScopedApply = true;
      try {
        this._applyStoredSourceState(pending.source, pending.frequency);
      } finally {
        this._duringScopedApply = false;
      }
    }

    if (!this._duringScopedApply) {
      this._persistCosmicState();
    }
    // React cosmic surface re-reads the source/waveform after world data seeds them.
    this._notifyCosmicChange();
  }

  setExoFrequencies(exoData) {
    this.setFrequencySources(exoData);
  }

  getExoBaseFrequency() {
    return this.sourceBaseFrequency;
  }

  applyTriggerMultiplier(multiplier) {
    const { dimensionId } = this.getScopedContext();
    const dimensionLFO = dimensionId ? this._ensureDimensionState(dimensionId) : null;

    // Use dimension-specific source base frequency if available
    const sourceBase = dimensionLFO?.sourceBaseFrequency ?? this.sourceBaseFrequency;
    const currentMult = dimensionLFO?.currentMultiplier ?? this.currentMultiplier;

    // Octave-fold + clamp the multiplied source base in the pure kernel.
    const { multiplier: newMultiplier, frequency: sanitized } = applyMultiplier(
      sourceBase,
      currentMult,
      multiplier,
    );
    if (sanitized == null) {
      console.warn(`CosmicLFO (${this.axis}): Unable to derive frequency for multiplier ${multiplier}.`);
      return;
    }

    this.currentMultiplier = newMultiplier;
    if (dimensionLFO) {
      dimensionLFO.currentMultiplier = newMultiplier;
    }

    this.setBaseFrequency(sanitized, {
      skipSourceAssignment: true,
      skipMultiplierReset: true,
      skipSourceBaseUpdate: true
    });
    // Note: setBaseFrequency already calls _persistCosmicState, so we don't need to call it again
  }

  _extractFrequencySources(rawSources = {}) {
    if (!rawSources || typeof rawSources !== 'object') {
      return {};
    }

    const normalized = {};

    Object.keys(SOURCE_DEFINITIONS).forEach((key) => {
      const rawCandidate = toFiniteNumber(rawSources[key]);
      if (!Number.isFinite(rawCandidate)) {
        return;
      }

      let harmonized = ensureHarmonicRange(rawCandidate);
      if (harmonized == null && rawCandidate === 0) {
        harmonized = MIN_FREQUENCY_HZ;
      }

      if (typeof harmonized === 'number') {
        normalized[key] = this._sanitizeFrequency(harmonized);
      }
    });

    if (!Object.keys(normalized).length) {
      const legacyValue =
        rawSources?.currentExoplanet?.minimum_cosmic_lfo ??
        rawSources?.currentExoplanet?.minimumCosmicLfo ??
        null;
      const parsedLegacy = ensureHarmonicRange(toFiniteNumber(legacyValue));
      if (typeof parsedLegacy === 'number') {
        normalized.minimumCosmicLfo = this._sanitizeFrequency(parsedLegacy);
      } else if (legacyValue === 0) {
        normalized.minimumCosmicLfo = MIN_FREQUENCY_HZ;
      }
    }

    if (!Object.keys(normalized).length) {
      normalized.minimumCosmicLfo = MIN_FREQUENCY_HZ;
    }

    return normalized;
  }

  _updateFrequencySourceMenu(sources) {
    const slotMap = {
      [MANUAL_SOURCE_KEY]: MANUAL_SOURCE_KEY,
    };
    if (typeof document === 'undefined') {
      return slotMap;
    }

    const container = document.querySelector(`[data-group="${this.axis}-exo-lfo-dropdown"]`);
    if (!container) {
      return slotMap;
    }

    const menu = container.querySelector('ul.dropdown-menu');
    if (!menu) {
      return slotMap;
    }

    const manualAnchor = this._ensureDropdownItem(menu, {
      dataValue: MANUAL_SOURCE_KEY,
      label: this._localizedLabel(MANUAL_MENU_META),
      icon: MANUAL_MENU_META.icon,
      id: `${this.axis}-manual-frequency`,
      prepend: true
    });
    if (manualAnchor) {
      manualAnchor.dataset.frequencySource = MANUAL_SOURCE_KEY;
      manualAnchor.style.display = '';
    }

    const availableKeys = Object.keys(SOURCE_DEFINITIONS).filter(
      (key) => typeof sources[key] === 'number'
    );

    const usedAnchors = new Set();

    availableKeys.forEach((sourceKey) => {
      const definition = SOURCE_DEFINITIONS[sourceKey];
      const anchor = this._ensureDropdownItem(menu, {
        dataValue: sourceKey,
        label: this._localizedLabel(definition),
        icon: definition.icon,
        id: `${this.axis}-${sourceKey}`
      });
      if (anchor) {
        anchor.dataset.frequencySource = sourceKey;
        anchor.style.display = '';
        slotMap[sourceKey] = sourceKey;
        usedAnchors.add(anchor);
      }
    });

    menu.querySelectorAll(this._dropdownSelectorQuery()).forEach((anchor) => {
      const value = anchor.getAttribute('data-value');
      if (value === MANUAL_SOURCE_KEY) {
        return;
      }
      if (usedAnchors.has(anchor)) {
        return;
      }
      if (value && value.startsWith('exo-')) {
        anchor.style.display = 'none';
        anchor.removeAttribute('data-frequency-source');
      }
    });

    return slotMap;
  }

  _updateWaveformMenu() {
    if (typeof document === 'undefined') {
      return;
    }

    const container = document.querySelector(`[data-group="${this.axis}-waveform-dropdown"]`);
    if (!container) {
      return;
    }

    const menu = container.querySelector('ul.dropdown-menu');
    if (!menu) {
      return;
    }

    const usedAnchors = new Set();

    ALLOWED_WAVEFORMS.forEach((waveform) => {
      const definition = WAVEFORM_DEFINITIONS[waveform];
      const value = `${this.axis}-waveform-${waveform}`;
      const anchor = this._ensureDropdownItem(menu, {
        dataValue: value,
        label: this._localizedLabel(definition, waveform),
        icon: definition?.icon || resolveHerbariumSymbol(`wf-${waveform}.svg`),
        id: value,
      });
      if (anchor) {
        usedAnchors.add(anchor);
      }
    });

    menu.querySelectorAll(this._dropdownSelectorQuery()).forEach((anchor) => {
      if (!usedAnchors.has(anchor)) {
        const listItem = anchor.closest('li');
        if (listItem) {
          listItem.remove();
        } else {
          anchor.remove();
        }
      }
    });
  }

  _reseedDimensionStatesWithCosmicSource({ sourceKey, slotId, baseFrequency }) {
    if (!sourceKey || sourceKey === MANUAL_SOURCE_KEY) {
      return;
    }
    const sanitized = this._sanitizeFrequency(baseFrequency);
    if (!Number.isFinite(sanitized) || sanitized <= 0) {
      return;
    }
    debugLog(this, '_reseedDimensionStatesWithCosmicSource', {
      sourceKey,
      slotId,
      baseFrequency,
      sanitized,
      cachedDimensions: Array.from(this.dimensionLFOs.keys()),
    });

    const normalizedState = {
      sourceKey,
      slotId: sourceKey,
      multiplier: 1,
      baseFrequency: sanitized,
    };

    const ids = this._getComponentIds();
    const { stackId } = this.getScopedContext();

    this.dimensionLFOs.forEach((dimensionLFO, dimensionId) => {
      if (!dimensionLFO) return;
      dimensionLFO.currentFrequencySource = sourceKey;
      dimensionLFO.currentExoplanet = normalizedState.slotId;
      dimensionLFO.sourceBaseFrequency = sanitized;
      dimensionLFO.currentMultiplier = 1;
      dimensionLFO.frequency = sanitized;

      if (stackId && dimensionId) {
        try {
          setScopedState(stackId, ids.source, normalizedState, { dimensionId });
          setScopedState(stackId, ids.frequency, sanitized, { dimensionId });
        } catch (error) {
          console.warn(`[CosmicLFO:${this.axis}] Failed to reseed cosmic source for ${dimensionId}`, error);
        }
      }
    });

    // Ensure current dimension is also updated even if it has not been created yet
    const { dimensionId: activeDimensionId } = this.getScopedContext();
    if (stackId && activeDimensionId) {
      try {
        setScopedState(stackId, ids.source, normalizedState, { dimensionId: activeDimensionId });
        setScopedState(stackId, ids.frequency, sanitized, { dimensionId: activeDimensionId });
      } catch (error) {
        console.warn(`[CosmicLFO:${this.axis}] Failed to persist active dimension cosmic source`, error);
      }
    }

    this.currentExoplanet = normalizedState.slotId;
    this.sourceBaseFrequency = sanitized;
    this.baseFrequency = sanitized;
    this.currentMultiplier = 1;
    this._lastVisualValue = null;
  }

  _ensureDropdownItem(menu, { dataValue, label, icon, id, prepend = false }) {
    if (!menu) return null;
    const selector = `${this._dropdownSelectorQuery()}[data-value="${dataValue}"]`;
    let anchor = menu.querySelector(selector);
    const isNew = !anchor;

    if (isNew) {
      const listItem = document.createElement('li');
      anchor = document.createElement('a');
      anchor.className = 'dropdown-item';
      anchor.href = '#';
      anchor.setAttribute('data-midi-controllable', 'false');
      listItem.appendChild(anchor);
      if (prepend && menu.firstChild) {
        menu.insertBefore(listItem, menu.firstChild);
      } else if (prepend) {
        menu.appendChild(listItem);
      } else {
        menu.appendChild(listItem);
      }
    }

    if (id) {
      anchor.id = id;
    }
    anchor.dataset.value = dataValue;
    anchor.setAttribute('data-midi-controllable', 'false');
    anchor.setAttribute('data-label', label);
    if (icon) {
      anchor.setAttribute('data-icon', icon);
    }

    const { iconSlot } = ensureDropdownItemStructure(anchor, { label });
    if (iconSlot && icon) {
      this._setInlineIcon(iconSlot, icon, {
        width: COSMIC_ICON_SIZE,
        height: COSMIC_ICON_SIZE,
        marginRight: 0,
        className: 'menu-icon-svg'
      });
    }

    anchor.style.display = '';

    return anchor;
  }

  _setInlineIcon(
    target,
    iconPath,
    { width = COSMIC_ICON_SIZE, height = COSMIC_ICON_SIZE, marginRight = 0, className = 'icon-svg' } = {}
  ) {
    if (!target || !iconPath || typeof fetch !== 'function') return;
    fetchHerbariumSymbol(iconPath)
      .then(({ content, url }) => {
        const svgElement = parseHerbariumSvg(content, url);
        svgElement.setAttribute('fill', 'currentColor');
        prepareDropdownIconSvg(svgElement, className);

        if (width != null) {
          if (typeof width === 'number') {
            svgElement.style.width = `${width}px`;
            svgElement.style.maxWidth = `${width}px`;
          } else {
            svgElement.style.width = String(width);
            svgElement.style.maxWidth = String(width);
          }
        } else {
          svgElement.style.removeProperty('width');
          svgElement.style.removeProperty('max-width');
        }

        if (height != null) {
          if (typeof height === 'number') {
            svgElement.style.height = `${height}px`;
            svgElement.style.maxHeight = `${height}px`;
          } else {
            svgElement.style.height = String(height);
            svgElement.style.maxHeight = String(height);
          }
        } else {
          svgElement.style.removeProperty('height');
          svgElement.style.removeProperty('max-height');
        }

        // Dropdown menu icons should fit inside the slot without stretching
        // across both dimensions, otherwise wide waveform SVGs appear much
        // larger than square Lucide-style source icons.
        if (className === 'menu-icon-svg') {
          svgElement.style.width = 'auto';
          svgElement.style.height = 'auto';
          svgElement.style.maxWidth = typeof width === 'number' ? `${width}px` : String(width);
          svgElement.style.maxHeight = typeof height === 'number' ? `${height}px` : String(height);
          svgElement.style.display = 'block';
        }

        if (marginRight) {
          svgElement.style.marginRight = `${marginRight}px`;
        } else {
          svgElement.style.marginRight = '';
        }
        target.innerHTML = '';
        target.appendChild(svgElement);
      })
      .catch((error) =>
        console.warn(`[CosmicLFO] Failed to load icon ${resolveHerbariumSymbol(iconPath)}:`, error),
      );
  }


  _resolveTriggerComponentId(switchId) {
    if (!switchId) {
      return null;
    }
    if (switchId.endsWith('1')) {
      return `${this.axis}.frequency-multiplier-low`;
    }
    if (switchId.endsWith('2')) {
      return `${this.axis}.frequency-multiplier-high`;
    }
    return `${this.axis}.frequency-multiplier`;
  }











  _updateWaveformDropdown(selectionValue) {
    const container = document.querySelector(`[data-group="${this.axis}-waveform-dropdown"]`);
    if (!container) {
      return;
    }

    this._updateWaveformMenu();

    const button = container.querySelector('button.dropdown-toggle');
    const iconSpan = button?.querySelector('.button-icon');
    const anchor = container.querySelector(`a.dropdown-item[data-value="${selectionValue}"]`);

    const iconPath =
      anchor?.dataset.icon ||
      (typeof button?.getAttribute === 'function' ? button.getAttribute('data-src') : null) ||
      resolveHerbariumSymbol(`wf-${this.waveform}.svg`);
    const label =
      anchor?.dataset.label ||
      anchor?.textContent?.trim() ||
      this._localizedLabel(WAVEFORM_DEFINITIONS[this.waveform], this.waveform.charAt(0).toUpperCase() + this.waveform.slice(1));

    if (button) {
      button.setAttribute('data-src', iconPath);
      button.setAttribute('aria-label', label);
    }
    if (iconSpan) {
      iconSpan.setAttribute('data-src', iconPath);
      iconSpan.setAttribute('aria-label', label);
      this._setInlineIcon(iconSpan, iconPath, { marginRight: 0, className: 'icon-svg' });
    }

    container.querySelectorAll('a.dropdown-item').forEach((item) => {
      item.classList.toggle('active', item.getAttribute('data-value') === selectionValue);
    });
  }

  _updateDropdownAppearance(selectionValue, sourceKey) {
    const container = document.querySelector(`[data-group="${this.axis}-exo-lfo-dropdown"]`);
    if (!container) {
      return;
    }

    const definition = sourceKey === MANUAL_SOURCE_KEY
      ? MANUAL_MENU_META
      : SOURCE_DEFINITIONS[sourceKey] || SOURCE_DEFINITIONS.minimumCosmicLfo;

    const iconPath = definition?.icon || SOURCE_DEFINITIONS.minimumCosmicLfo.icon;
    const label = this._localizedLabel(definition, 'Cosmic LFO');

    const button = container.querySelector('button.dropdown-toggle');
    const iconSpan = button?.querySelector('.button-icon');

    if (button) {
      button.setAttribute('data-src', iconPath);
      button.setAttribute('aria-label', label);
    }
    if (iconSpan) {
      iconSpan.setAttribute('data-src', iconPath);
      iconSpan.setAttribute('aria-label', label);
      this._setInlineIcon(iconSpan, iconPath, { marginRight: 0, className: 'icon-svg' });
    }

    container.querySelectorAll('a.dropdown-item').forEach((anchor) => {
      anchor.classList.toggle('active', anchor.getAttribute('data-value') === selectionValue);
    });
  }

  _dropdownSelectorQuery() {
    return 'a.dropdown-item';
  }

  _localizedLabel(definition, fallback = '') {
    const t = getT();
    const key = definition?.i18nKey;
    if (typeof t === 'function' && key) {
      const translated = t(key);
      if (typeof translated === 'string' && translated && translated !== key) {
        return translated;
      }
    }
    return definition?.label || fallback;
  }

  _refreshLocalizedDropdownLabels() {
    if (typeof document === 'undefined') {
      return;
    }

    this._updateWaveformDropdown(this._currentWaveformSelection || `${this.axis}-waveform-${this.waveform}`);
    this.frequencySlotMap = this._updateFrequencySourceMenu(this.frequencySources || {});
    this._updateDropdownAppearance(
      this.currentExoplanet || MANUAL_SOURCE_KEY,
      this.currentFrequencySource || MANUAL_SOURCE_KEY
    );
  }

  triggerKick(triggerLabel) {
    let multiplier;
    if (triggerLabel.endsWith('1')) {
      multiplier = 0.5;
    } else if (triggerLabel.endsWith('2')) {
      multiplier = 2;
    } else {
      console.warn(`CosmicLFO (${this.axis}): Unknown trigger label '${triggerLabel}'.`);
      return;
    }
    this.applyTriggerMultiplier(multiplier);
  }

  initialize(exoData) {
  }

  computeFrequenciesFromExoData() {
    console.warn(`CosmicLFO (${this.axis}): computeFrequenciesFromExoData() not implemented.`);
  }


  dispose() {
    this._visualSamplerActive = false;
    this._cancelScheduledSample();
    this._activeDimensions.clear();
    this.isActive = false;
    this._lastVisualTimestamp = null;
    this._lastVisualValue = null;
    this._lastPushedParamValue = null;

    if (this.switchElement && this._boundSwitchChange) {
      this.switchElement.removeEventListener('change', this._boundSwitchChange);
    }
    this.switchElement = null;
    this._boundSwitchChange = null;

    if (typeof document !== 'undefined' && this._boundVisibilityChange) {
      document.removeEventListener('visibilitychange', this._boundVisibilityChange);
    }
    this._boundVisibilityChange = null;

    if (typeof window !== 'undefined' && this._boundLanguageChange) {
      window.removeEventListener('languageChanged', this._boundLanguageChange);
    }
    this._boundLanguageChange = null;

    if (typeof document !== 'undefined' && this._boundDimensionListener) {
      document.removeEventListener('orbiters:dimension-changed', this._boundDimensionListener);
    }
    this._boundDimensionListener = null;

    // Cosmic surface: tear down the freq + amplitude PM bridge subscriptions.
    if (this._freqParamController && typeof this.parameterManager?.unsubscribe === 'function') {
      this.parameterManager.unsubscribe(this._freqParamController, cosmicFrequencyParamId(this.axis));
    }
    this._freqParamController = null;
    this._freqParamBound = false;
    this._applyingFreqFromParam = false;
    if (this._ampParamController && typeof this.parameterManager?.unsubscribe === 'function') {
      this.parameterManager.unsubscribe(this._ampParamController, this._amplitudeParamId());
    }
    this._ampParamController = null;
    this._ampParamBound = false;
    this._applyingAmpFromParam = false;

  }
}
