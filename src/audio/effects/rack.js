/**
 * @file src/audio/effects/rack.js
 * @description Runtime implementation of the two-slot effects rack described in the
 * Effect Design Standard (EDS). It owns Tone.js nodes, attaches automation bridges,
 * and keeps the monitor UI in sync with the currently loaded modules.
 */
import { getEffectDefinition } from './index.js';
import { MAX_MODULES, MONITOR_MODULE_SLOTS } from '../../config/Constants.js';
import {
  sanitizeMappings,
  applyMappingsToModule,
  extractModuleMappings,
  buildModuleMappingOverrides,
  mapControlValueToRange,
  formatMonitorValue,
} from './mappingManager.js';
import { isMonitorCurrentlyVisible, isMonitorDimensionActive } from '../../utils/monitorUtils.js';
import { byId } from '../../voice/voiceDom.js';

const DEFAULT_RANGE = Object.freeze({ min: 0, max: 1, equilibrium: 0.5 });
const SLOT_DEBUG_FLAG = '__DEBUG_EFFECT_SLOTS';
const DEFAULT_AUTOMATION_RAMP = 0.05;
const LIVE_UPDATE_INTENT = 'live';
const COMMIT_UPDATE_INTENT = 'commit';
const STEREO_CONFIG = Object.freeze({
  channelCount: 2,
  channelCountMode: 'explicit',
  channelInterpretation: 'speakers',
});

function enforceStereo(node) {
  if (!node) return;
  try {
    if (typeof node.set === 'function') {
      node.set(STEREO_CONFIG);
      return;
    }
    if ('channelCount' in node) {
      node.channelCount = STEREO_CONFIG.channelCount;
    }
    if ('channelCountMode' in node) {
      node.channelCountMode = STEREO_CONFIG.channelCountMode;
    }
    if ('channelInterpretation' in node) {
      node.channelInterpretation = STEREO_CONFIG.channelInterpretation;
    }
  } catch (_) {}
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number(min);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return numeric;
  if (min === max) return min;
  return Math.min(max, Math.max(min, numeric));
}

function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 0) return 0;
  if (numeric >= 1) return 1;
  return numeric;
}

function normalizeUpdateIntent(value) {
  return value === COMMIT_UPDATE_INTENT ? COMMIT_UPDATE_INTENT : LIVE_UPDATE_INTENT;
}

function cloneRange(range = {}) {
  const cloned = {
    min: toFiniteNumber(range.min, null),
    max: toFiniteNumber(range.max, null),
    equilibrium: toFiniteNumber(range.equilibrium ?? range.init, null),
  };
  if (range?.quantize && typeof range.quantize === 'object') {
    cloned.quantize = { ...range.quantize };
  }
  return cloned;
}

function areSettingsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

function shouldDebugSlots() {
  try {
    if (typeof window === 'undefined') return false;
    if (!(SLOT_DEBUG_FLAG in window)) {
      Object.defineProperty(window, SLOT_DEBUG_FLAG, {
        value: false,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    return Boolean(window[SLOT_DEBUG_FLAG]);
  } catch (_) {
    return false;
  }
}

function debugSlotState(message, payload = {}) {
  if (!shouldDebugSlots()) return;
  try {
    console.debug(`[EffectsRackSlots] ${message}`, payload);
  } catch (_) {}
}

function resolveRangeBounds(rangeLike) {
  if (!rangeLike || typeof rangeLike !== 'object') return null;
  const min = toFiniteNumber(rangeLike.min, null);
  const max = toFiniteNumber(rangeLike.max, null);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const floor = Math.min(min, max);
  const ceil = Math.max(min, max);
  const result = { min: floor, max: ceil };
  if (rangeLike?.quantize && typeof rangeLike.quantize === 'object') {
    result.quantize = { ...rangeLike.quantize };
  }
  return result;
}

function createEmptyModuleConfig(dimensionId = null, dimensionLabel = null) {
  return {
    effectId: null,
    moduleId: null,
    inputParamId: null,
    range: { ...DEFAULT_RANGE },
    settings: undefined,
    mappings: [],
    dimensionId,
    dimensionLabel,
    controlNormalized: null,
  };
}

function sanitizeModules(modules = [], dimensionId = null, dimensionLabel = null) {
  const normalized = Array.isArray(modules) ? modules.slice(0, MAX_MODULES) : [];
  const sanitized = normalized.map((module = {}) => ({
    effectId: module?.effectId ?? null,
    moduleId: module?.moduleId ?? null,
    inputParamId: module?.inputParamId ?? null,
    range: module?.range
      ? {
          min: toFiniteNumber(module.range.min, DEFAULT_RANGE.min),
          max: toFiniteNumber(module.range.max, DEFAULT_RANGE.max),
          equilibrium: toFiniteNumber(
            module.range.equilibrium ?? module.range.init,
            DEFAULT_RANGE.equilibrium,
          ),
        }
      : { ...DEFAULT_RANGE },
    settings: module?.settings ? { ...module.settings } : undefined,
    mappings: sanitizeMappings(module?.mappings),
    dimensionId: module?.dimensionId ?? dimensionId ?? null,
    dimensionLabel: module?.dimensionLabel ?? dimensionLabel ?? null,
    controlNormalized: clamp01(module?.controlNormalized),
  }));

  while (sanitized.length < MAX_MODULES) {
    sanitized.push(createEmptyModuleConfig(dimensionId, dimensionLabel));
  }

  return sanitized;
}

function sanitizeConfig(config = {}, fallbackDimensionId = null, fallbackDimensionLabel = null) {
  const dimensionId = config?.dimensionId ?? fallbackDimensionId ?? null;
  const dimensionLabel = config?.dimensionLabel ?? fallbackDimensionLabel ?? dimensionId ?? null;
  return {
    dimensionId,
    dimensionLabel,
    modules: sanitizeModules(config.modules, dimensionId, dimensionLabel),
  };
}

function extractDomain(moduleManifest, effectManifest = null) {
  const moduleRange = resolveRangeBounds(moduleManifest?.valueRange);
  if (moduleRange) return moduleRange;
  const initialRange = resolveRangeBounds(moduleManifest?.initialRange);
  if (initialRange) return initialRange;
  const userRange = resolveRangeBounds(effectManifest?.userParamSpec?.range);
  if (userRange) return userRange;
  return null;
}

function isDefaultRange(rangeConfig) {
  if (!rangeConfig || typeof rangeConfig !== 'object') return true;
  const min = toFiniteNumber(rangeConfig.min, null);
  const max = toFiniteNumber(rangeConfig.max, null);
  const equilibrium = toFiniteNumber(rangeConfig.equilibrium ?? rangeConfig.init, null);
  const eqDefault = equilibrium === null || equilibrium === DEFAULT_RANGE.equilibrium;
  return min === DEFAULT_RANGE.min && max === DEFAULT_RANGE.max && eqDefault;
}

function normalizeRange(rangeConfig = {}, domain = DEFAULT_RANGE) {
  if (!domain) {
    const minBound = toFiniteNumber(rangeConfig?.min, DEFAULT_RANGE.min);
    const maxBound = toFiniteNumber(rangeConfig?.max, DEFAULT_RANGE.max);
    const lower = Math.min(
      Number.isFinite(minBound) ? minBound : DEFAULT_RANGE.min,
      Number.isFinite(maxBound) ? maxBound : DEFAULT_RANGE.max,
    );
    const upper = Math.max(
      Number.isFinite(minBound) ? minBound : DEFAULT_RANGE.min,
      Number.isFinite(maxBound) ? maxBound : DEFAULT_RANGE.max,
    );
    const normalized = {
      min: toFiniteNumber(rangeConfig?.min, DEFAULT_RANGE.min),
      max: toFiniteNumber(rangeConfig?.max, DEFAULT_RANGE.max),
      equilibrium: toFiniteNumber(
        rangeConfig?.equilibrium ?? rangeConfig?.init,
        DEFAULT_RANGE.equilibrium,
      ),
    };
    if (rangeConfig?.quantize && typeof rangeConfig.quantize === 'object') {
      normalized.quantize = { ...rangeConfig.quantize };
    }
    return normalized;
  }

  const min = clamp(toFiniteNumber(rangeConfig?.min, domain.min), domain.min, domain.max);
  const max = clamp(toFiniteNumber(rangeConfig?.max, domain.max), domain.min, domain.max);
  const equilibrium = clamp(
    toFiniteNumber(rangeConfig?.equilibrium ?? rangeConfig?.init, (domain.min + domain.max) / 2),
    domain.min,
    domain.max,
  );

  const normalized = {
    min,
    max,
    equilibrium,
  };
  if (rangeConfig?.quantize && typeof rangeConfig.quantize === 'object') {
    normalized.quantize = { ...rangeConfig.quantize };
  } else if (domain?.quantize) {
    normalized.quantize = { ...domain.quantize };
  }

  return normalized;
}

function findModuleManifest(definition, moduleId) {
  if (!definition?.manifest?.modules) return null;
  return definition.manifest.modules.find((module) => module.id === moduleId) || null;
}

/**
 * Publishes module monitoring data to placeholders.
 * Maps axis + slot index to specific placeholder IDs in a 2-column grid.
 * 
 * Placeholder layout (2-column grid: label | value):
 * X-axis: label_A=1, value_A=2, label_B=3, value_B=4
 * Y-axis: label_A=5, value_A=6, label_B=7, value_B=8
 * Z-axis: label_A=9, value_A=10, label_B=11, value_B=12
 */
const MONITOR_AXES = ['x', 'y', 'z'];
const MONITOR_SLOT_OFFSETS = Object.freeze([
  { label: 0, value: 1 }, // Slot A
  { label: 2, value: 3 }, // Slot B
]);
const MONITOR_AXIS_STRIDE = MONITOR_SLOT_OFFSETS.length * 2;

// The monitor DOM cache is per-rack-instance (`EffectsRack#getMonitorElement`),
// NOT a module singleton — a module-level cache keyed by id alone would return one voice's element
// for another voice's same-id lookup. The owning rack threads its bound `#getMonitorElement` in.
function publishMonitorUpdate(axis, dimensionId, slotA, slotB, getMonitorElement) {
  if (!isMonitorCurrentlyVisible()) return;
  if (!isMonitorDimensionActive(dimensionId)) return;
  if (typeof document === 'undefined') return;
  
  const axisLower = String(axis || '').toLowerCase();
  const axisIndex = MONITOR_AXES.indexOf(axisLower);
  if (axisIndex === -1) return;

  const basePlaceholder = (axisIndex * MONITOR_AXIS_STRIDE) + 1;
  
  try {
    if (typeof window !== 'undefined' && window.__DEBUG_RACK_MONITOR) {
      console.debug(`[Rack Monitor] Publishing ${axisLower} axis, dimension: ${dimensionId}, basePlaceholder: ${basePlaceholder}`, {
        slots: [slotA, slotB].map((slot) => slot ? { module: slot.module?.id, label: slot.module?.label } : null),
      });
    }
  } catch (_) {}
  
  const providedSlots = [slotA, slotB];
  const activeLetters = MONITOR_MODULE_SLOTS.letters;
  const activeCount = MONITOR_MODULE_SLOTS.count;

  const buildSlotData = (slot, moduleLetter, valueElementId) => {
    const prefix = `${axisLower}${moduleLetter}`;
    
    if (!slot || !slot.module || !slot.range) {
      return {
        label: `[${prefix}]`,
        value: '0',
      };
    }
    
    let existingValue = '0';
    try {
      const placeholder = getMonitorElement(valueElementId);
      if (placeholder && placeholder.textContent) {
        const currentText = placeholder.textContent.trim();
        const match = currentText.match(/[-+]?\d+\.?\d*/);
        if (match) {
          existingValue = match[0];
        }
      }
    } catch (_) {}
    
    const labelBase = slot.module.label || slot.module.id || '';
    const label = labelBase ? `[${prefix}] ${labelBase}` : `[${prefix}]`;
    return {
      label,
      value: existingValue,
    };
  };
  
  activeLetters.forEach((moduleLetter, slotIndex) => {
    const slot = providedSlots[slotIndex] || null;
    const offsets = MONITOR_SLOT_OFFSETS[slotIndex];
    if (!offsets) return;

    const labelId = `placeholder_${basePlaceholder + offsets.label}`;
    const valueId = `placeholder_${basePlaceholder + offsets.value}`;
    const slotData = buildSlotData(slot, moduleLetter, valueId);
    
    try {
      const labelEl = getMonitorElement(labelId);
      const valueEl = getMonitorElement(valueId);
      if (labelEl) {
        labelEl.textContent = slotData.label;
        labelEl.style.display = '';
      }
      if (valueEl) {
        valueEl.textContent = slotData.value;
        valueEl.style.display = '';
      }
    } catch (_) {}
  });

  MONITOR_SLOT_OFFSETS.forEach((offsets, slotIndex) => {
    if (slotIndex >= activeCount) {
      const labelId = `placeholder_${basePlaceholder + offsets.label}`;
      const valueId = `placeholder_${basePlaceholder + offsets.value}`;
      const labelEl = getMonitorElement(labelId);
      const valueEl = getMonitorElement(valueId);
      if (labelEl) {
        labelEl.textContent = '';
        labelEl.style.display = 'none';
      }
      if (valueEl) {
        valueEl.textContent = '';
        valueEl.style.display = 'none';
      }
    }
  });
}

/**
 * Manages the signal path and automation plumbing for one rack axis (X/Y/Z).
 * The rack hosts up to `MAX_MODULES` module slots, normalises their ranges,
 * and exposes automation bridges so the UI can modulate AudioParams without zipper noise.
 */
export class EffectsRack {
  /**
   * @param {object} options
   * @param {'x'|'y'|'z'|string} options.channel - Rack axis identifier (drives monitor placeholders).
   * @param {string|null} [options.dimensionId] - Dimension identifier the rack is attached to.
   * @param {Record<string, any>} [options.controllers] - External controller references (deck/panner/playback).
   * @param {object|null} [options.performanceProfile] - Performance tuning (safe ramp times, oversampling, etc.).
   * @param {import('../../voice/Deck.js').Deck|null} [options.deck] - This voice's deck, threaded into tempo-aware effect factories.
   */
  constructor({ channel, dimensionId, controllers = {}, performanceProfile = null, deck = null }) {
    this.channel = channel;
    this.dimensionId = dimensionId ?? null;
    this.dimensionLabel = null;
    this.controllers = { ...controllers };
    this.performanceProfile = performanceProfile || null;
    this.deck = deck ?? null;
    this.safeRampSeconds = this.#computeSafeRampSeconds();
    this._monitorThrottleMs = this.#resolveMonitorThrottleMs();

    this.Tone = null;
    this.channelStrip = null;
    this.levelGain = null;
    this.destination = null;
    this._rawContext = null;
    this._monitorElements = Object.create(null);
    this._lastMonitorUpdateAt = 0;

    this.config = sanitizeConfig({}, this.dimensionId);
    this.slots = Array.from({ length: MAX_MODULES }, () => null);
    this._activeSlots = [];
    this._lastInput = 0.5;
    this._slotObservers = new Set();
  }

  /**
   * Observe slot lifecycle: `callback(slot, true)` when an effect instance is
   * created into a slot, `callback(slot, false)` right before it is disposed
   * (module change, slot clear, or rack teardown). Same-slot param updates do
   * not notify — read live state off `slot.effectNode` instead. Observer
   * errors are contained so a consumer (visual layers) can never break the
   * audio graph.
   * @param {(slot: object, present: boolean) => void} callback
   * @returns {() => void} Unsubscribe.
   */
  observeSlots(callback) {
    if (typeof callback !== 'function') return () => {};
    this._slotObservers.add(callback);
    return () => {
      this._slotObservers.delete(callback);
    };
  }

  #notifySlotChange(slot, present) {
    for (const callback of this._slotObservers) {
      try {
        callback(slot, present);
      } catch (error) {
        console.warn(`[EffectsRack-${this.channel}] Slot observer failed`, error);
      }
    }
  }

  #computeSafeRampSeconds(profile = this.performanceProfile) {
    const fallbackMs = 50;
    const ms = Number(profile?.safeRampTimeMs);
    const resolvedMs = Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
    return Math.max(0.001, resolvedMs / 1000);
  }

  #getQualitySmoothingSeconds() {
    const ms = Number(this.performanceProfile?.effectQuality?.modSmoothingMs);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return Math.max(0.001, ms / 1000);
  }

  #resolveMonitorThrottleMs(profile = this.performanceProfile) {
    const explicit = Number(profile?.uiMonitorThrottleMs);
    if (Number.isFinite(explicit) && explicit >= 0) {
      return explicit;
    }
    try {
      if (typeof window === 'undefined') {
        return 0;
      }
      const fromWindow = Number(window.__orbitersGraphicsProfile?.config?.uiMonitorThrottleMs);
      if (Number.isFinite(fromWindow) && fromWindow >= 0) {
        return fromWindow;
      }
    } catch (_) {}
    return 0;
  }

  #resolveRawContext(ToneRef = this.Tone) {
    return ToneRef?.getContext?.()?.rawContext ?? ToneRef?.context?.rawContext ?? null;
  }

  #getRawContext() {
    if (this._rawContext) return this._rawContext;
    this._rawContext = this.#resolveRawContext(this.Tone);
    return this._rawContext;
  }

  #getCurrentAudioTime({ allowNowFallback = true } = {}) {
    const context = this.#getRawContext();
    const nowTime = context?.currentTime;
    if (Number.isFinite(nowTime)) {
      return nowTime;
    }
    if (allowNowFallback && typeof this.Tone?.now === 'function') {
      return this.Tone.now();
    }
    return 0;
  }

  #getMonitorElement(id) {
    if (typeof document === 'undefined' || !id) return null;
    const cached = this._monitorElements[id];
    if (cached && cached.isConnected) {
      return cached;
    }
    const element = byId(id);
    if (element) {
      this._monitorElements[id] = element;
      return element;
    }
    if (id in this._monitorElements) {
      delete this._monitorElements[id];
    }
    return null;
  }

  #applyEffectQuality(effectInstance) {
    if (!effectInstance || typeof effectInstance !== 'object') return;
    const quality = this.performanceProfile?.effectQuality;
    if (!quality || typeof quality !== 'object') {
      effectInstance.performanceQuality = null;
      return;
    }

    const node = effectInstance.node ?? null;
    effectInstance.performanceQuality = { ...quality };

    if (node && Object.prototype.hasOwnProperty.call(node, 'oversample')) {
      const oversampling = Number(quality.oversampling);
      const mapped = oversampling >= 4 ? '4x' : oversampling >= 2 ? '2x' : 'none';
      try {
        node.oversample = mapped;
      } catch (_) {}
    }

    if (node && Object.prototype.hasOwnProperty.call(node, 'fftSize')) {
      const fftSize = Number(quality.fftSize);
      if (Number.isFinite(fftSize) && fftSize > 0) {
        try {
          node.fftSize = fftSize;
        } catch (_) {}
      }
    }

    if (typeof effectInstance.setQuality === 'function') {
      try {
        effectInstance.setQuality(quality);
      } catch (_) {}
    }
  }

  /**
   * Updates the rack-level performance profile (smoothing windows, oversampling, FFT sizes, etc.)
   * and rebinds automation bridges so new ramp windows take effect.
   * @param {object|null} profile
   */
  setPerformanceProfile(profile = null) {
    this.performanceProfile = profile || null;
    this.safeRampSeconds = this.#computeSafeRampSeconds();
    this._monitorThrottleMs = this.#resolveMonitorThrottleMs(this.performanceProfile);

    if (!Array.isArray(this.slots) || !this.slots.length) {
      return;
    }

    this.slots.forEach((slot) => {
      if (!slot) return;
      if (slot.effectInstance) {
        this.#applyEffectQuality(slot.effectInstance);
      }
      if (slot.automation) {
        this.#disposeAutomation(slot);
      }
      this.#attachAutomationBridge(slot);
    });

    this.#syncActiveSlots();
  }

  /**
   * Bootstraps the rack with Tone.js references and destination wiring.
   * @param {object} options
   * @param {typeof import('tone')} options.Tone - Tone.js namespace.
   * @param {AudioNode|null} [options.destination] - Node the rack should feed.
   * @param {object} [options.config] - Serialized rack configuration produced by the session.
   * @param {object|null} [options.performanceProfile] - Optional override for smoothing/quality.
   */
  init({ Tone, destination = null, config = {}, performanceProfile = null } = {}) {
    if (performanceProfile) {
      this.performanceProfile = performanceProfile;
      this.safeRampSeconds = this.#computeSafeRampSeconds();
    }
    this.Tone = Tone;
    this._rawContext = this.#resolveRawContext(Tone);
    this._monitorThrottleMs = this.#resolveMonitorThrottleMs(this.performanceProfile);
    if (!Tone) {
      throw new Error(`[EffectsRack-${this.channel}] Tone.js reference is required.`);
    }

    // Add an explicit input bus so we can place the channel strip at the end
    this.inputGain = new this.Tone.Gain(1);
    enforceStereo(this.inputGain);

    // Create channelStrip with explicit unity volume (0dB)
    // Keep the panner at the END of the rack by wiring it after any effect nodes
    this.channelStrip = new this.Tone.Channel({ volume: 0, pan: 0 });
    try {
      enforceStereo(this.channelStrip);
    } catch (_) {}
    this.levelGain = new this.Tone.Gain(1);
    enforceStereo(this.levelGain);

    // Base wiring to pass audio even before modules are added
    try {
      this.inputGain.connect(this.channelStrip);
      this.channelStrip.connect(this.levelGain);
    } catch (_) {}

    if (destination) {
      this.setDestination(destination);
    }

    this.setMix(1);
    this.configure(config);
  }

  /**
   * Registers references to UI/deck controllers (panner, playback, etc.) used by modules.
   * @param {Record<string, any>} controllers
   */
  setControllers(controllers = {}) {
    this.controllers = {
      ...(this.controllers || {}),
      ...(controllers || {}),
    };
  }

  /**
   * Reconnects the rack output to a new destination node.
   * @param {AudioNode|null} destination
   */
  setDestination(destination = null) {
    if (!this.levelGain) return;
    try {
      if (this.destination) {
        this.levelGain.disconnect(this.destination);
      } else {
        this.levelGain.disconnect();
      }
    } catch (_) {}

    if (destination) {
      try {
        this.levelGain.connect(destination);
      } catch (error) {
        console.warn(`[EffectsRack-${this.channel}] Failed to connect to destination`, error);
      }
    }
    this.destination = destination;
  }

  /**
   * Configure the rack for this axis/dimension.
   * IMPORTANT: Avoid unnecessary audio-node disconnect/connect while audio is running.
   * Rebuilding the node graph during frequent UI updates (e.g., knob moves) causes audible clicks
   * because WebAudio connections change discontinuously. We therefore:
   *  - Compare the previous graph against the next one
   *  - Only rebuild wiring when the actual set/order of effect nodes changes (topology change)
   *  - For simple value updates (controlNormalized, settings that don’t replace nodes), keep wiring intact
   * This preserves a stable signal path and eliminates zipper noise/clicks during live control.
   * @param {object} config - Sanitised rack configuration (dimension + up to MAX_MODULES modules).
   */
  configure(config = {}) {
    if (!this.Tone) {
      throw new Error(`[EffectsRack-${this.channel}] Cannot configure before init.`);
    }

/*     console.log(`[EffectsRack-${this.channel}] configure() called:`, {
      currentDimensionId: this.dimensionId,
      incomingDimensionId: config.dimensionId,
      moduleCount: config.modules?.length || 0,
      modules: (config.modules || []).map(m => ({
        effectId: m.effectId,
        moduleId: m.moduleId,
        dimensionId: m.dimensionId,
        hasEffect: !!m.effectId
      }))
    }); */

  // Capture current node graph to detect real topology changes (node identity/order)
    const prevNodes = (this.slots || []).map((slot) => slot?.effectNode || null);

    const sanitized = sanitizeConfig(config, this.dimensionId, this.dimensionLabel);
    this.dimensionId = sanitized.dimensionId ?? this.dimensionId;
    this.dimensionLabel = sanitized.dimensionLabel ?? this.dimensionLabel ?? this.dimensionId;
    this.config = sanitized;

    sanitized.modules.forEach((moduleConfig, index) => {
      this.#applyModuleConfig(index, moduleConfig);
    });

    // Compare node graph; only rebuild wiring if nodes changed.
    // NOTE: This is the key to avoiding clicks when parameters update quickly.
    const nextNodes = (this.slots || []).map((slot) => slot?.effectNode || null);
    const graphChanged = prevNodes.length !== nextNodes.length
      ? true
      : nextNodes.some((node, i) => node !== prevNodes[i]);

    if (graphChanged) {
      this.#rebuildSignalGraph();
    }

    this.#syncActiveSlots();
    if (graphChanged) {
      this.#synchroniseInitialValue();
      // Update monitor when graph changes (modules added/removed/changed)
      // Dimension changes are handled at UI level via _clearMonitorDisplay()
      publishMonitorUpdate(
        this.channel,
        this.dimensionId,
        this.slots[0],
        this.slots[1],
        this.#getMonitorElement.bind(this),
      );
      
      // Rebind LFOs when modules are added/removed (not on parameter changes)
      // Use debounce to avoid multiple rapid rebinds when all racks configure at once
      // REMOVED: LFO rebinding on module changes
      // LFOs now only control root parameters, no audio connections needed
    }
    
    this.#debugSlots('configure');
  }

  /**
   * Sets the channel strip output gain (a.k.a mix) using a short soft ramp.
   * @param {number} value - Linear gain (0–1).
   */
  setMix(value) {
    if (!this.levelGain) return;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && this.levelGain.gain) {
      if (typeof this.levelGain.gain.rampTo === 'function') {
        this.levelGain.gain.rampTo(Math.max(0, numeric), 0.05);
      } else {
        this.levelGain.gain.value = Math.max(0, numeric);
      }
    }
  }

  /**
   * Applies a normalised rack control value (0–1) to all active slots,
   * mapping the value into each module's declared domain and publishing monitor telemetry.
   * @param {number} value - Normalised UI input.
   * @param {object} [context] - Optional caller metadata, including `updateIntent`.
   * @returns {{ appliedCount: number, skippedCount: number, totalSlots: number }} stats
   */
  applyInputValue(value, context = {}) {
    const numeric = clamp(Number(value), 0, 1);
    if (!Number.isFinite(numeric)) {
      console.warn(`[EffectsRack-${this.channel}] Invalid value:`, value);
      return;
    }

    this._lastInput = numeric;
    const updateIntent = normalizeUpdateIntent(context?.updateIntent);

    let appliedCount = 0;
    let skippedCount = 0;

    this._activeSlots.forEach((slot) => {
      if (!slot?.range) {
        skippedCount++;
        return;
      }

      slot.controlNormalized = numeric;
      slot.lastAppliedNormalized = numeric;
      
      // Map normalized control to target domain; honor perceptual transform from manifest if provided
      const transform = slot?.control?.signalRange?.transform || 'linear';
      const mappedValue = mapControlValueToRange(slot.range, numeric, { 
        target: slot.target ?? null,
        transform,
      });

      try {
        slot.module?.applyValue?.(mappedValue, {
          ...context,
          updateIntent,
        });
        appliedCount++;
      } catch (error) {
        console.warn(`[EffectsRack-${this.channel}] Failed to apply value`, error);
      }
    });

    try {
      if (typeof window !== 'undefined' && window.__DEBUG_AXIS_X_DIM3 && this.channel === 'x' && this.dimensionId === 'EW::III') {
        console.debug('[EffectsRack-X][EW::III] applyInputValue', {
          numeric,
          activeSlots: this._activeSlots.map(s => ({ moduleId: s?.module?.id, effectId: s?.config?.effectId })),
          appliedCount,
          skippedCount,
        });
      }
    } catch (_) {}
    
    // Update monitor values in real-time using fixed slot indices
    this.#publishMonitorValues(numeric);

    return { appliedCount, skippedCount, totalSlots: this._activeSlots.length };
  }

  /**
   * @returns {boolean} Whether the rack exposes an automation bridge for smooth modulation.
   */
  supportsContinuousAutomation() {
    return true;
  }

  /**
   * @returns {AudioNode|null} Rack input gain node for chaining.
   */
  getInputNode() {
    return this.inputGain;
  }

  /**
   * @returns {AudioNode|null} Rack level node feeding the destination.
   */
  getOutputNode() {
    return this.levelGain;
  }

  /**
   * Resolves a Tone parameter exposed by the rack (`gain`, `level`, `mix`, or `input`).
   * @param {string} paramId
   * @returns {AudioParam|import('tone').Signal|object|null}
   */
  getParam(paramId) {
    switch (paramId) {
      case 'gain':
      case 'level':
      case 'mix':
        return this.levelGain ? this.levelGain.gain : null;
      case 'input':
      case 'inputParam': {
        const slot = this._activeSlots.find((item) => item?.module);
        return slot?.module?.getTargetParam?.() ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * Disconnects nodes, tears down modules, and releases Tone.js resources.
   */
  dispose() {
    try {
      this.inputGain?.disconnect();
    } catch (_) {}
    try {
      this.channelStrip?.disconnect();
    } catch (_) {}
    try {
      this.levelGain?.disconnect();
    } catch (_) {}

    this.slots.forEach((slot, index) => this.#disposeSlot(index));
    this.slots = [];
    this._activeSlots = [];

    this.levelGain?.dispose?.();
    this.inputGain?.dispose?.();
    this.channelStrip?.dispose?.();
    this.levelGain = null;
    this.inputGain = null;
    this.channelStrip = null;
    this._rawContext = null;
    this._monitorElements = Object.create(null);
    this._slotObservers.clear();
  }

  #applyModuleConfig(index, moduleConfig) {
    const currentSlot = this.slots[index];

    if (!moduleConfig?.effectId || !moduleConfig?.moduleId) {
      this.#disposeSlot(index);
      this.slots[index] = null;
      this.config.modules[index] = createEmptyModuleConfig(
        moduleConfig?.dimensionId ?? this.dimensionId,
        moduleConfig?.dimensionLabel ?? this.dimensionLabel,
      );
      return;
    }

    const definition = getEffectDefinition(moduleConfig.effectId);
    if (!definition || typeof definition.create !== 'function') {
      console.warn(`[EffectsRack-${this.channel}] Unknown effect: ${moduleConfig.effectId}`);
      this.#disposeSlot(index);
      this.slots[index] = null;
      this.config.modules[index] = createEmptyModuleConfig(
        moduleConfig?.dimensionId ?? this.dimensionId,
        moduleConfig?.dimensionLabel ?? this.dimensionLabel,
      );
      return;
    }

    const settingsChanged = !areSettingsEqual(
      currentSlot?.config?.settings,
      moduleConfig?.settings,
    );

    if (
      currentSlot &&
      currentSlot.definition?.id === definition.id &&
      currentSlot.module?.id === moduleConfig.moduleId &&
      !settingsChanged
    ) {
      this.#updateExistingSlot(currentSlot, moduleConfig);
      return;
    }

    this.#disposeSlot(index);
    const nextSlot = this.#createSlot(definition, moduleConfig);
    this.slots[index] = nextSlot;
    if (nextSlot) {
      this.#notifySlotChange(nextSlot, true);
    }

    if (nextSlot) {
      this.config.modules[index] = {
        effectId: nextSlot.config.effectId,
        moduleId: nextSlot.config.moduleId,
        inputParamId: nextSlot.config.inputParamId,
        range: cloneRange(nextSlot.config.range),
        settings: nextSlot.config.settings ? { ...nextSlot.config.settings } : undefined,
        mappings: sanitizeMappings(nextSlot.config.mappings),
      };
    } else {
      this.config.modules[index] = createEmptyModuleConfig(
        moduleConfig.dimensionId ?? this.dimensionId,
        moduleConfig.dimensionLabel ?? this.dimensionLabel,
      );
    }
  }

  #createSlot(definition, moduleConfig) {
    let effectInstance;
    try {
      const effectSettings = this.#buildEffectSettings(definition, moduleConfig);
      // Prefer deck-level channel when provided to ensure panner is truly end-of-chain
      const targetChannel = this.controllers?.deckChannel || this.channelStrip;
      effectInstance = definition.create({
        Tone: this.Tone,
        settings: effectSettings,
        channelStrip: targetChannel,
        performanceProfile: this.performanceProfile,
        deck: this.deck,
      });
    } catch (error) {
      console.warn(`[EffectsRack-${this.channel}] Failed to create effect`, error);
      return null;
    }

    if (!effectInstance || !Array.isArray(effectInstance.modules) || !effectInstance.modules.length) {
      effectInstance?.dispose?.();
      return null;
    }

    this.#applyEffectQuality(effectInstance);

    const module =
      effectInstance.modules.find((item) => item.id === moduleConfig.moduleId) ||
      effectInstance.modules[0] ||
      null;

    if (!module) {
      effectInstance.dispose?.();
      return null;
    }

    effectInstance.configureModule?.(module.id);
    module.configure?.();

    const manifest = findModuleManifest(definition, module.id);
    const target = manifest?.target ?? null;
    const domain = extractDomain(manifest, definition?.manifest);
    const range = normalizeRange(moduleConfig.range, domain);
    const savedMappings = sanitizeMappings(moduleConfig.mappings);
    applyMappingsToModule(module, savedMappings, range);

    const effectNode = effectInstance.node ?? null;
    if (!effectNode) {
      effectInstance.dispose?.();
      return null;
    }
    enforceStereo(effectNode);

    const inputParamId = moduleConfig?.inputParamId ?? definition.manifest?.inputParam ?? null;

    const controlOverride = clamp01(moduleConfig.controlNormalized);
    const baseNormalized = clamp01(this._lastInput);
    const controlValue = controlOverride !== null ? controlOverride : (baseNormalized !== null ? baseNormalized : 0.5);
    const equilibriumValue = mapControlValueToRange(range, controlValue, { target });

    try {
      module.applyValue?.(equilibriumValue, {
        updateIntent: COMMIT_UPDATE_INTENT,
        reason: 'slot-create',
      });
    } catch (error) {
      console.warn(`[EffectsRack-${this.channel}] Failed to apply initial value`, error);
    }

    const controlMeta = manifest?.control ?? null;

    const slot = {
      definition,
      effectInstance,
      effectNode,
      module,
      manifest,
      target,
      domain,
      range,
      inputParamId,
      config: {
        effectId: moduleConfig.effectId,
        moduleId: moduleConfig.moduleId,
        inputParamId,
        range: cloneRange(range),
        settings: moduleConfig.settings ? { ...moduleConfig.settings } : undefined,
        mappings: savedMappings.length ? savedMappings : extractModuleMappings(module),
      },
      mappings: extractModuleMappings(module),
      control: controlMeta,
      automation: null,
      // Slot-level IDENTITY (not `config`, which is the persisted module shape):
      // together, dimension and axis name the module a reader is looking at. The
      // axis lives on the rack, and a flattened slot list would otherwise lose it.
      axis: this.channel,
      dimensionId: moduleConfig.dimensionId ?? this.dimensionId ?? null,
      dimensionLabel: moduleConfig.dimensionLabel ?? this.dimensionLabel ?? null,
      controlNormalized: controlValue,
      lastAppliedNormalized: controlValue,
    };

    this.#attachAutomationBridge(slot);
    return slot;
  }

  #updateExistingSlot(slot, moduleConfig) {
    if (!slot) return;

    slot.config = {
      effectId: moduleConfig.effectId,
      moduleId: moduleConfig.moduleId,
      inputParamId: moduleConfig?.inputParamId ?? slot.inputParamId ?? null,
      range: cloneRange(moduleConfig.range),
      settings: moduleConfig.settings ? { ...moduleConfig.settings } : undefined,
      mappings: sanitizeMappings(moduleConfig.mappings),
    };

    slot.axis = this.channel;
    slot.dimensionId = moduleConfig.dimensionId ?? slot.dimensionId ?? null;
    slot.dimensionLabel = moduleConfig.dimensionLabel ?? slot.dimensionLabel ?? null;
    slot.controlNormalized =
      clamp01(moduleConfig.controlNormalized ?? slot.controlNormalized ?? null);
    slot.lastAppliedNormalized = slot.controlNormalized ?? slot.lastAppliedNormalized ?? null;

    slot.manifest = findModuleManifest(slot.definition, slot.module.id);
    slot.domain = extractDomain(slot.manifest, slot.definition?.manifest);
    slot.range = normalizeRange(moduleConfig.range, slot.domain);
    slot.inputParamId = slot.config.inputParamId;
    slot.target = slot.manifest?.target ?? slot.target ?? null;
    enforceStereo(slot.effectNode);

    const savedMappings = slot.config.mappings;
    applyMappingsToModule(slot.module, savedMappings, slot.range);
    slot.module.configure?.();

    try {
      slot.module.applyValue?.(
        mapControlValueToRange(slot.range, this._lastInput, { target: slot.target ?? null }),
        {
          updateIntent: COMMIT_UPDATE_INTENT,
          reason: 'slot-update',
        },
      );
    } catch (error) {
      console.warn(`[EffectsRack-${this.channel}] Failed to reapply module value`, error);
    }
    slot.mappings = extractModuleMappings(slot.module);
    if (!slot.config.mappings?.length) {
      slot.config.mappings = slot.mappings;
    }
    const index = this.slots.indexOf(slot);
    if (index >= 0) {
      this.config.modules[index] = {
        effectId: slot.config.effectId,
        moduleId: slot.config.moduleId,
        inputParamId: slot.config.inputParamId,
        range: cloneRange(slot.config.range),
        settings: slot.config.settings ? { ...slot.config.settings } : undefined,
        mappings: sanitizeMappings(slot.config.mappings),
      };
    }
  }

  #buildEffectSettings(definition, moduleConfig) {
    const originalSettings = moduleConfig?.settings;
    let settings = originalSettings;
    if (Array.isArray(originalSettings)) {
      settings = [...originalSettings];
    } else if (originalSettings && typeof originalSettings === 'object') {
      settings = { ...originalSettings };
    }

    if (this.#definitionNeedsPlayback(definition) && this.controllers?.playback) {
      if (Array.isArray(settings)) {
        const [first, ...rest] = settings;
        const normalizedFirst = first && typeof first === 'object' ? { ...first } : {};
        if (!normalizedFirst.playbackController) {
          normalizedFirst.playbackController = this.controllers.playback;
        }
        return [normalizedFirst, ...rest];
      }

      if (settings && typeof settings === 'object') {
        if (!settings.playbackController) {
          settings.playbackController = this.controllers.playback;
        }
        return settings;
      }

      return { playbackController: this.controllers.playback };
    }

    return settings;
  }

  #definitionNeedsPlayback(definition) {
    const modules = definition?.manifest?.modules;
    if (!Array.isArray(modules)) return false;
    return modules.some((module) => module?.control?.provider === 'playbackController');
  }

  #attachAutomationBridge(slot) {
    if (!slot) return;
    const controlMeta = slot.control;
    if (!controlMeta || controlMeta.mode === 'discrete') return;
    if (!this.Tone?.Signal) {
      console.warn(`[EffectsRack-${this.channel}] Tone.Signal is required for automation.`);
      return;
    }
    const module = slot.module;
    if (typeof module?.setAutomationBridge !== 'function') return;

    const targetParam = module.getTargetParam?.();

    // NEW: Prefer Tone.Param-like objects (with unit-aware scheduling, e.g., dB)
    const isToneParamObject =
      targetParam &&
      typeof targetParam === 'object' &&
      ('value' in targetParam) &&
      (typeof targetParam.rampTo === 'function' || typeof targetParam.setValueAtTime === 'function');

    const smoothing = controlMeta.smoothing || {};
    const safeRamp = Number.isFinite(this.safeRampSeconds) ? this.safeRampSeconds : DEFAULT_AUTOMATION_RAMP;
    const qualityRamp = this.#getQualitySmoothingSeconds();
    const baseDefault = Number.isFinite(smoothing.defaultRamp) ? smoothing.defaultRamp : safeRamp;
    const defaultRamp = Math.max(safeRamp, qualityRamp ?? baseDefault);
    const baseMin = Number.isFinite(smoothing.minRamp) ? smoothing.minRamp : defaultRamp;
    const baseMax = Number.isFinite(smoothing.maxRamp) ? smoothing.maxRamp : Math.max(defaultRamp, safeRamp * 2);
    const minRamp = Math.max(0, baseMin > defaultRamp ? defaultRamp : baseMin);
    const maxRamp = baseMax < defaultRamp ? defaultRamp : baseMax;
    const clampRamp = (value) => {
      if (!Number.isFinite(value)) return defaultRamp;
      const candidate = Math.min(Math.max(value, minRamp), maxRamp);
      return Number.isFinite(candidate) ? candidate : defaultRamp;
    };

    if (isToneParamObject) {
      // Schedule using unit-aware Tone.Param API to preserve dB semantics
      const bridge = {
        ramp: (value, options = {}) => {
          const duration = clampRamp(options?.rampSeconds ?? options?.duration ?? options?.ramp ?? defaultRamp);
          if (typeof targetParam.rampTo === 'function' && duration > 0) {
            targetParam.rampTo(value, duration);
          } else if (typeof targetParam.setValueAtTime === 'function') {
            const t = this.#getCurrentAudioTime();
            targetParam.setValueAtTime(value, t);
          } else {
            // Last resort
            targetParam.value = value;
          }
        },
        setImmediate: (value) => {
          try { targetParam.value = value; } catch (_) {}
        },
        dispose: () => {},
        control: controlMeta,
      };

      try {
        module.setAutomationBridge(bridge);
        slot.automation = {
          signal: null,
          bridge,
          control: controlMeta,
          targetParam,
        };
      } catch (error) {
        console.warn(`[EffectsRack-${this.channel}] Module rejected automation bridge`, error);
      }
      return; // IMPORTANT: Do not fall through to AudioParam/Signal path
    }

    const audioParam = this.#resolveAutomationTarget(targetParam);
    if (!audioParam) return;

    const transform = controlMeta?.signalRange?.transform || 'linear';
    const eps = 1e-6;

    if (transform === 'log' && typeof audioParam.exponentialRampToValueAtTime === 'function') {
      // Use native exponential automation for positive domains (e.g., frequency)
      const nowTime = this.#getCurrentAudioTime({ allowNowFallback: false });
      try {
        const initial = Math.max(eps, this.#readAutomationInitialValue(audioParam));
        if (typeof audioParam.cancelScheduledValues === 'function') {
          audioParam.cancelScheduledValues(nowTime);
        }
        if (typeof audioParam.setValueAtTime === 'function') {
          audioParam.setValueAtTime(initial, nowTime);
        }
      } catch (_) {}

      const bridge = {
        ramp: (value, options = {}) => {
          const duration = clampRamp(options?.rampSeconds ?? options?.duration ?? options?.ramp ?? defaultRamp);
          const target = Math.max(eps, Number(value) || 0);
          try {
            const t = this.#getCurrentAudioTime({ allowNowFallback: false });
            if (typeof audioParam.cancelScheduledValues === 'function') {
              audioParam.cancelScheduledValues(t);
            }
            audioParam.exponentialRampToValueAtTime(target, t + duration);
          } catch (_) {
            // Fallback to immediate set if scheduling fails
            try {
              audioParam.setValueAtTime(target, this.#getCurrentAudioTime({ allowNowFallback: false }));
            } catch (_) {}
          }
        },
        setImmediate: (value) => {
          const target = Math.max(eps, Number(value) || 0);
          try {
            const t = this.#getCurrentAudioTime({ allowNowFallback: false });
            audioParam.setValueAtTime(target, t);
          } catch (_) {}
        },
        dispose: () => {
          // nothing to dispose when using direct param scheduling
        },
        control: controlMeta,
      };

      try {
        module.setAutomationBridge(bridge);
        slot.automation = {
          signal: null,
          bridge,
          control: controlMeta,
          targetParam: audioParam,
        };
      } catch (error) {
        console.warn(`[EffectsRack-${this.channel}] Module rejected automation bridge`, error);
      }
      return;
    }

    // Default: Tone.Signal with linear ramping
    let signal;
    try {
      const initialValue = this.#readAutomationInitialValue(audioParam);
      signal = new this.Tone.Signal(initialValue);
      if (typeof signal.connect === 'function') {
        signal.connect(audioParam);
      } else {
        signal.dispose();
        return;
      }
    } catch (error) {
      console.warn(`[EffectsRack-${this.channel}] Failed to create automation signal`, error);
      return;
    }

    const bridge = {
      ramp: (value, options = {}) => {
        const duration = clampRamp(options?.rampSeconds ?? options?.duration ?? options?.ramp ?? defaultRamp);
        if (typeof signal.rampTo === 'function' && duration > 0) {
          signal.rampTo(value, duration);
        } else {
          signal.value = value;
        }
      },
      setImmediate: (value) => {
        signal.value = value;
      },
      dispose: () => {
        try {
          signal.disconnect();
        } catch (_) {}
        signal.dispose?.();
      },
      control: controlMeta,
    };

    try {
      module.setAutomationBridge(bridge);
      slot.automation = {
        signal,
        bridge,
        control: controlMeta,
        targetParam: audioParam,
      };
    } catch (error) {
      console.warn(`[EffectsRack-${this.channel}] Module rejected automation bridge`, error);
      bridge.dispose();
    }
  }

  #disposeSlot(index) {
    const slot = this.slots[index];
    if (!slot) return;

    // Notify before teardown so observers can detach their taps while the
    // effect node is still valid.
    this.#notifySlotChange(slot, false);

    this.#disposeAutomation(slot);

    try {
      slot.effectNode?.disconnect?.();
    } catch (_) {}

    try {
      slot.module?.setAutomationBridge?.(null);
    } catch (_) {}

    try {
      slot.effectInstance?.dispose?.();
    } catch (error) {
      console.warn(`[EffectsRack-${this.channel}] Failed to dispose effect`, error);
      // Fallback cleanup path in case the effect wrapper fails before disposing its node.
      try {
        slot.effectNode?.disconnect?.();
      } catch (_) {}
      try {
        slot.effectNode?.dispose?.();
      } catch (_) {}
    }

    this.slots[index] = null;
  }

  #rebuildSignalGraph() {
    if (!this.inputGain || !this.channelStrip || !this.levelGain) return;

    // Fade out briefly before rewiring to avoid clicks from discontinuous connections
    const CROSSFADE_SEC = 0.015;
    const gainParam = this.levelGain.gain;
    const hasToneRamp = typeof gainParam?.rampTo === 'function';
    const hasNativeRamp = typeof gainParam?.linearRampToValueAtTime === 'function';
    const rawCtx = this.Tone?.getContext?.()?.rawContext ?? this.Tone?.context?.rawContext ?? null;

    if (hasToneRamp) {
      gainParam.rampTo(0, CROSSFADE_SEC);
    } else if (hasNativeRamp) {
      const t = rawCtx?.currentTime ?? 0;
      try { gainParam.setValueAtTime(gainParam.value, t); } catch (_) {}
      gainParam.linearRampToValueAtTime(0, t + CROSSFADE_SEC);
    }

    // Schedule the actual rewiring after the fade-out completes
    const rewire = () => {
      try { this.inputGain.disconnect(); } catch (_) {}
      try { this.channelStrip.disconnect(); } catch (_) {}

      this.slots.forEach((slot) => {
        if (!slot?.effectNode) return;
        try { slot.effectNode.disconnect(); } catch (_) {}
      });

      // Start from the rack input bus
      let previous = this.inputGain;
      const activeNodes = this.slots
        .map((slot) => slot?.effectNode)
        .filter((node) => node && typeof node.connect === 'function');

      activeNodes.forEach((node) => {
        previous.connect(node);
        previous = node;
      });

      // Ensure the channel strip (with panner) is the last stage before level gain
      try { previous.connect(this.channelStrip); } catch (_) {}
      try { this.channelStrip.connect(this.levelGain); } catch (_) {}

      // Fade back in
      if (hasToneRamp) {
        gainParam.rampTo(1, CROSSFADE_SEC);
      } else if (hasNativeRamp) {
        const t2 = rawCtx?.currentTime ?? 0;
        try { gainParam.setValueAtTime(0, t2); } catch (_) {}
        gainParam.linearRampToValueAtTime(1, t2 + CROSSFADE_SEC);
      } else if (gainParam) {
        gainParam.value = 1;
      }
    };

    // If we could fade out, wait for it; otherwise rewire immediately
    if (hasToneRamp || hasNativeRamp) {
      setTimeout(rewire, CROSSFADE_SEC * 1000);
    } else {
      rewire();
    }
  }

  #syncActiveSlots() {
    this._activeSlots = this.slots.filter((slot) => slot && slot.module);
  }

  #synchroniseInitialValue() {
    const slot = this._activeSlots.find((item) => item && item.range);
    if (!slot) return;
    try {
      const mappedValue = mapControlValueToRange(slot.range, this._lastInput, { target: slot.target ?? null });
      slot.module?.applyValue?.(mappedValue, {
        updateIntent: COMMIT_UPDATE_INTENT,
        reason: 'rack-sync',
      });
    } catch (error) {
      console.warn(`[EffectsRack-${this.channel}] Failed to synchronise initial value`, error);
    }
  }

  #resolveAutomationTarget(targetParam) {
    if (!targetParam) return null;
    if (typeof targetParam.cancelScheduledValues === 'function' || typeof targetParam.setValueAtTime === 'function') {
      return targetParam;
    }
    if (targetParam?.input && (typeof targetParam.input.cancelScheduledValues === 'function' || typeof targetParam.input.setValueAtTime === 'function')) {
      return targetParam.input;
    }
    if (typeof targetParam.value === 'number') {
      return targetParam;
    }
    return null;
  }

  #readAutomationInitialValue(param) {
    if (!param) return 0;
    if (typeof param.value === 'number') return param.value;
    if (param.value && typeof param.value === 'object' && typeof param.value.value === 'number') {
      return param.value.value;
    }
    if (typeof param.getValueAtTime === 'function') {
      try {
        const context = param.context || param._context;
        const now = context?.currentTime ?? 0;
        const value = param.getValueAtTime(now);
        if (Number.isFinite(value)) return value;
      } catch (_) {}
    }
    return 0;
  }

  #disposeAutomation(slot) {
    if (!slot?.automation) {
      slot?.module?.setAutomationBridge?.(null);
      return;
    }
    try {
      slot.automation.bridge?.dispose?.();
    } catch (_) {}
    slot.module?.setAutomationBridge?.(null);
    slot.automation = null;
  }

  #debugSlots(reason = 'configure') {
    if (!shouldDebugSlots()) return;
    const snapshot = this.slots.map((slot, index) => ({
      index,
      effectId: slot?.config?.effectId ?? null,
      moduleId: slot?.config?.moduleId ?? null,
      dimensionId: slot?.dimensionId ?? this.dimensionId ?? null,
      target: slot?.target ?? null,
      provider: slot?.manifest?.control?.provider ?? null,
      hasAutomationBridge: Boolean(slot?.automation),
      range: slot?.range ?? null,
      controlNormalized: Number.isFinite(slot?.controlNormalized) ? slot.controlNormalized : null,
    }));

    debugSlotState(`channel:${this.channel}:${reason}`, {
      channel: this.channel,
      dimensionId: this.dimensionId,
      dimensionLabel: this.dimensionLabel,
      activeSlots: this._activeSlots.length,
      slots: snapshot,
    });
  }

  /**
   * Returns this rack's monitor readout: for each loaded slot, the audio module's label and
   * its current value mapped into the module's domain (with units). This is the single owner
   * of the monitor value math — both the legacy DOM monitor (`#publishMonitorValues`) and the
   * React monitor surface read it, so there is no parallel computation path.
   *
   * Unlike the legacy DOM path it is NOT gated on visibility or the active dimension: callers
   * decide what to show. Inactive dimensions map their last-applied value (`controlNormalized`),
   * so a per-dimension matrix can render every dimension's current value.
   *
   * @param {number|null} [overrideNormalized] Normalized input (0–1) to map. Defaults to each
   *   slot's last-applied value, which is what the snapshot/per-dimension path wants.
   * @returns {Array<{slot:'A'|'B', label:(string|null), value:(number|null), units:(string|null), formatted:string}>}
   */
  getMonitorReadout(overrideNormalized = null) {
    const letters = ['A', 'B'];
    const readouts = [];
    for (let i = 0; i < letters.length; i++) {
      const slot = this.slots[i];
      if (!slot || !slot.module || !slot.range) continue;

      const normalized = Number.isFinite(overrideNormalized)
        ? overrideNormalized
        : (Number.isFinite(slot.controlNormalized) ? slot.controlNormalized : null);

      let value = null;
      if (normalized != null) {
        const transform = slot.control?.signalRange?.transform || 'linear';
        value = mapControlValueToRange(slot.range, normalized, {
          target: slot.target ?? null,
          transform,
        });
      }

      const units = slot.manifest?.valueRange?.units
        || slot.definition?.manifest?.userParamSpec?.units
        || null;

      readouts.push({
        slot: letters[i],
        label: slot.module?.label || slot.module?.id || null,
        // `value` is null when unmapped (no last-applied value) so a React consumer can render a
        // placeholder; `formatted` ALWAYS goes through formatMonitorValue (which renders a non-finite
        // value as '0'/'0 units'), so the legacy DOM monitor reads exactly as before this refactor.
        value: Number.isFinite(value) ? value : null,
        units,
        formatted: formatMonitorValue(value, units),
      });
    }
    return readouts;
  }

  #publishMonitorValues(normalizedValue) {
    // Skip monitor updates if Engine Monitor is not currently visible
    if (!isMonitorCurrentlyVisible()) return;
    // Only update when this rack's dimension is the one currently visible
    if (!isMonitorDimensionActive(this.dimensionId)) return;

    if (typeof window === 'undefined') return;
    const runtimeThrottleMs = this.#resolveMonitorThrottleMs(this.performanceProfile);
    if (runtimeThrottleMs !== this._monitorThrottleMs) {
      this._monitorThrottleMs = runtimeThrottleMs;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const throttleMs = this._monitorThrottleMs;
    if (throttleMs > 0 && now - this._lastMonitorUpdateAt < throttleMs) {
      return;
    }
    this._lastMonitorUpdateAt = now;

    const axisLower = String(this.channel || '').toLowerCase();
    if (!['x', 'y', 'z'].includes(axisLower)) return;

    // Calculate base placeholder ID for this axis (X=1, Y=5, Z=9); slot A at base, slot B at base+2.
    const axisIndex = { x: 0, y: 1, z: 2 }[axisLower];
    const basePlaceholder = (axisIndex * 4) + 1;

    try {
      this.getMonitorReadout(normalizedValue).forEach((readout) => {
        const slotOffset = readout.slot === 'A' ? 0 : 2;
        const labelEl = this.#getMonitorElement(`placeholder_${basePlaceholder + slotOffset}`);
        if (labelEl) {
          const prefix = `${axisLower}${readout.slot}`;
          labelEl.textContent = readout.label ? `[${prefix}] ${readout.label}` : `[${prefix}]`;
        }
        const valueEl = this.#getMonitorElement(`placeholder_${basePlaceholder + slotOffset + 1}`);
        if (valueEl) {
          valueEl.textContent = readout.formatted;
        }
      });
    } catch (_) {}
  }
}

export default EffectsRack;
