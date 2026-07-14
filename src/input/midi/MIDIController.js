// src/MIDIController.js

/**
 * @file MIDIController.js
 * @description Handles all MIDI controller-related logic, including MIDI interactions, mappings, and MIDI Learn functionality.
 * @version 2.0.0
 * @autor 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2024-12-07
 */

import { getPriority, MIDI_SUPPORTED } from '../../config/Constants.js';
import { KickTriggerDispatcher } from './kickTrigger.ts';
import { ToggleActionDispatcher } from './toggleAction.ts';
import { StepSelectDispatcher } from './stepSelect.ts';
import { DEFAULT_ORBITER_FALLBACK } from '../../defaults/orbiterFallback.js';
import notifications from '../../core/AppNotifications.js';
import { PANEL_IDS, subscribeToAnyPanelChange } from '../../core/PanelManager.js';
import { setScopedState } from '../../core/stackUtils.js';
import { voiceRegistry } from '../../voice/VoiceRegistry.js';
import { byId } from '../../voice/voiceDom.js';
import { getT } from '../../i18n/index.js';
import { MidiOverlayManager } from '../../ui/midi/MidiOverlayManager.js';
import { MidiIndicatorManager } from '../../ui/midi/MidiIndicatorManager.js';
import { MidiLearnUiController } from '../../ui/midi/MidiLearnUiController.js';
import { MidiContextMenu } from './contextMenu.js';
import { MidiConnectionManager } from './MidiConnectionManager.js';
import { MidiMappingRegistry } from './MidiMappingRegistry.js';
import { MidiFeedbackBridge } from './MidiFeedbackBridge.js';
import { MidiMappingPersistence } from './MidiMappingPersistence.js';
import { ScopedMidiMap } from './ScopedMidiMap.js';
import { makeScopeKey, orbiterScopeKey, parseScopeKey } from './scopeKey.js';
import { MidiWidgetDriver } from './MidiWidgetDriver.js';
import { midiNormToValue } from './midiScale.js';
import {
  DEFAULT_STACK_ID,
  DEFAULT_DIMENSION_ID,
  parseLayeredKey,
  lookupComponentMetadataByKey,
} from './componentMetadata.js';
import {
  hasActiveMidiMappings,
  hasConnectedMidiOutputs,
} from './midiFeedbackState.js';
import { isAutofocusEnabled } from './autofocusSettings.js';

const MIDI_ACTIVATION_FAILED_STORAGE_KEY = 'orbiters.midiActivationFailedNotified';
let midiActivationFailedNotified = false;

// Leading-edge throttle window for MIDI autofocus dimension switches. After a switch,
// further switches are suppressed for this long so two controls on different dimensions can't thrash.
const AUTOFOCUS_COOLDOWN_MS = 250;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isIframeContext() {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch (error) {
    return true;
  }
}

function hasNotifiedMidiActivationFailed() {
  if (midiActivationFailedNotified) return true;
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem(MIDI_ACTIVATION_FAILED_STORAGE_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function markMidiActivationFailedNotified() {
  midiActivationFailedNotified = true;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(MIDI_ACTIVATION_FAILED_STORAGE_KEY, '1');
  } catch (error) {
    // Ignore storage failures; we at least keep the in-memory flag.
  }
}

/** 
 * MIDIController Singleton Class
 * Handles MIDI interactions, including listening to MIDI inputs,
 * managing MIDI mappings, and facilitating MIDI Learn functionality.
 * @class
 * @memberof InputInterface 
 */
export class MIDIController {
  /**
   * Creates an instance of MIDIController.
   * Implements the Singleton pattern to ensure only one instance exists.
   */
  constructor() {
    if (MIDIController.instance) {
      return MIDIController.instance;
    }

    this.mappingRegistry = new MidiMappingRegistry();
    this.midiParamMappings = this.mappingRegistry.midiParamMappings;
    this.midiWidgetMappings = this.mappingRegistry.midiWidgetMappings;
    this.widgetRegistry = this.mappingRegistry.widgetRegistry;
    this.widgetDescriptors = this.mappingRegistry.widgetDescriptors;
    this.layeredWidgetMappings = this.mappingRegistry.layeredWidgetMappings;
    // Kick switches: momentary TRIGGER bindings. A kick is an action, not a
    // value — inbound MIDI fires the bound action on a rising edge (delegated to the pure
    // KickTriggerDispatcher) instead of writing to ParameterManager.
    this._kickTriggers = new KickTriggerDispatcher();
    // LATCHING on/off toggle ACTIONS (cosmic-enable, sensor-enable, loop). Like kicks
    // these fire a registered callback on a RISING edge (a press) rather than writing a PM value;
    // the callback FLIPS the maintained state, so a momentary pad latches on/off.
    this._toggleActions = new ToggleActionDispatcher();
    // Single-CC stepped SELECT (cosmic source / waveform). The cycle ActionButtonGroup
    // has no per-option DOM target, so ONE CC maps across the N options by value → index.
    this._stepSelect = new StepSelectDispatcher();
    // The param manager is the owning voice's instance, injected via
    // setParameterManager() AFTER the composition root builds it (this module-level singleton is
    // constructed at import, before any voice exists). The feedback bridge is created there too.
    this.paramManager = null;
    // The active voice's combined config ({ track, orbiter, entangledWorld, … }), cached from the
    // `dataManager:configUpdated` event — replaces the removed Constants.TRACK_DATA global.
    this._currentCombined = null;
    const existingFeedbackFlag =
      typeof window !== 'undefined' && typeof window.__ENABLE_MIDI_FEEDBACK !== 'undefined'
        ? Boolean(window.__ENABLE_MIDI_FEEDBACK)
        : false;
    this._shouldEmitMidiFeedback = existingFeedbackFlag;
    if (typeof window !== 'undefined') {
      window.__ENABLE_MIDI_FEEDBACK = existingFeedbackFlag;
    }

    /**
     * @type {boolean}
     * @description Indicates whether MIDI is currently activated.
     */
    this.isMIDIActivated = false;

    /**
     * @type {boolean}
     * @description Indicates whether MIDI Learn mode is active.
     */
    this.isMidiLearnModeActive = false;

    /**
     * @type {HTMLElement|null}
     * @description The currently selected parameter for MIDI Learn mode.
     */
    this.currentLearnParam = null;

    /**
     * @type {HTMLElement|null}
     * @description The currently selected widget for MIDI Learn mode.
     */
    this.currentLearnWidget = null;

    // Bind methods to maintain 'this' context
    this.handleMidiMessage = this.handleMidiMessage.bind(this);
    this.handleStateChange = this.handleStateChange.bind(this);
    this.highlightParameter = this.highlightParameter.bind(this);
    this.unhighlightParameter = this.unhighlightParameter.bind(this);
    this.highlightWidget = this.highlightWidget.bind(this);
    this.unhighlightWidget = this.unhighlightWidget.bind(this);
    this.startMidiLearnForWidget = this.startMidiLearnForWidget.bind(this);

    this.widgetParameterLookup = this.mappingRegistry.widgetParameterLookup;
    // Persisted MIDI bindings are SLICE-OWNED — kept per scopeKey
    // (`orbiter:<id>`, `collection:<id>`) in this store, not in one flat map. A CC mapped on
    // a tile is shared by every tile of the SAME slice and never cross-hydrates a different
    // one. The store emits per-slice changes; we re-hydrate that slice's siblings live (see
    // `_rehydrateSliceSiblings`).
    this.scopedMidiMap = new ScopedMidiMap();
    this.mappingPersistence = new MidiMappingPersistence({
      scopedMidiMap: this.scopedMidiMap,
      resolveScope: (element, identifier) => this._resolveMidiScope(element, identifier),
      resolveParameterId: (element, identifier) => this._resolveParameterId(element, identifier),
      resolveDeviceInfo: (event) => this._resolveDeviceInfo(event),
    });
    this._unsubscribeScopedMidi = this.scopedMidiMap.subscribe((scopeKey, paramKey) =>
      this._rehydrateSliceSiblings(scopeKey, paramKey),
    );
    this._loadMappingsPromise = null;
    this._lastLoadedSignature = null;
    // In-flight per-slice loads triggered by `registerMidiLearnTarget`'s lazy fetch (a
    // widget whose persistence slice hasn't loaded yet) — keyed by scopeKey so two widgets
    // registering for the SAME not-yet-loaded slice in the same tick (e.g. the same track on two
    // collection stages) share ONE fetch instead of firing a redundant duplicate.
    this._pendingScopeLoads = new Map();
    this._boundDimensionChange = this._handleDimensionChange.bind(this);
    this._indicatorTrackingRaf = null;
    this.connectionManager = new MidiConnectionManager();
    // The feedback bridge needs the owning voice's ParameterManager, which does not
    // exist at import time — it is created in setParameterManager() once the voice injects it.
    this.feedbackBridge = null;
    this._updateMidiFeedbackAutoState('init');
    this.overlayManager = new MidiOverlayManager({
      isElementMapped: (element) => this.isElementMapped(element),
      onStartLearn: (element) => this.startMidiLearnForElement(element),
      onOpenContextMenu: (event, element) => this.openContextMenu(event, element),
    });
    this.indicatorManager = new MidiIndicatorManager({
      // MIDI is an ACTIVE-VOICE surface (one device): read the FOCUSED voice's panel.
      isMidiPanelActive: () =>
        voiceRegistry.getActive()?.panelManager?.getActivePanel?.() === PANEL_IDS.MIDI,
    });
    this.learnUiController = new MidiLearnUiController({
      overlayManager: this.overlayManager,
      onEnter: () => this._handleLearnModeEnter(),
      onExit: () => this._handleLearnModeExit(),
      onStartLearn: (element, identifier) => this._handleStartLearn(element, identifier),
    });
    this.contextMenu = new MidiContextMenu({
      onLearn: (payload) => this._handleContextLearnAction(payload),
      onDelete: (payload) => this._handleContextDeleteAction(payload),
      onCancel: () => {
        if (this.currentLearnParam) {
          this.learnUiController.unhighlightWidget(this.currentLearnParam);
          this.learnUiController.unhighlightParameter(this.currentLearnParam);
        }
        this.currentlyLearningWidget = null;
        this.currentLearnParam = null;
      },
    });
    // MIDI is an ACTIVE-VOICE, single-focus surface (one device → the focused voice).
    // Single-orbiter is byte-identical: the one voice's DataManager bus IS `window`, so this fires.
    // KNOWN multi gap (deferred): a multi tile's DataManager dispatches on its OWN per-voice EventTarget
    // (every voice, incl. the active one — see makeOrbiterVoiceSession), so this `window` listener does
    // NOT fire in multi and `_currentCombined` (MIDI scope/orbiter-id resolution) goes stale. Fixing it
    // belongs with the full per-voice MIDI scope (claimed-id registry + HeaderBar sync MIDI), not here.
    window.addEventListener('dataManager:configUpdated', this.handleDataManagerConfig.bind(this));
    if (typeof document !== 'undefined') {
      document.addEventListener('orbiters:dimension-changed', this._boundDimensionChange);
    }

    this.contextMenu.attach();
    this._messageUnsubscribe = this.connectionManager.onMessage(this.handleMidiMessage);
    this._stateUnsubscribe = this.connectionManager.onStateChange((payload) => {
      this.handleStateChange(payload?.rawEvent || payload);
    });
    this.init();
    void this.loadPersistedMappings();

    // De-singletonization: panel state is per-voice now. MIDI (an active-voice surface)
    // refreshes its overlays whenever ANY voice's panel changes — `subscribeToAnyPanelChange` is the
    // realm-level notification every PanelManager instance fires.
    //
    // Deferred a microtask: this constructor runs at module load (the eager `MIDIControllerInstance`
    // singleton). PanelManager imports MIDIController, so subscribing synchronously here would touch
    // PanelManager's module-level state (`anyPanelChangeObservers`) before it has initialized under the
    // circular import — a TDZ. The microtask guarantees the whole module graph is initialized first.
    queueMicrotask(() => {
      this._panelChangeUnsubscribe = subscribeToAnyPanelChange(() => {
        if (this.isMidiLearnModeActive) {
          this._updateIndicatorsVisibility(true);
          this.learnUiController.refreshOverlays();
        }
      });
    });


    MIDIController.instance = this;
  }

  /**
   * Injects the active voice's ParameterManager (A2 DI). The composition root calls this
   * after it constructs the voice's manager — this module-level singleton is built at import
   * (before any voice exists), so the manager and its feedback bridge cannot be wired in the
   * constructor. MIDI is an ACTIVE-VOICE surface (one focused voice owns the physical device), so
   * this may later be re-called when focus switches voices: the feedback bridge is torn down and
   * rebound to the new manager so output feedback never stays bound to the prior voice (no
   * split-brain). Re-injecting the SAME manager is a no-op for the bridge.
   * @param {ParameterManager} parameterManager - The active voice's ParameterManager instance.
   * @returns {void}
   */
  setParameterManager(parameterManager) {
    if (parameterManager !== this.paramManager) {
      // Manager changed (or first injection): rebind the feedback bridge to the new manager.
      if (this.feedbackBridge) {
        this.feedbackBridge.deactivate();
        this.feedbackBridge = null;
      }
      this.paramManager = parameterManager;
      if (this.paramManager) {
        this.feedbackBridge = new MidiFeedbackBridge({
          parameterManager: this.paramManager,
          mappingRegistry: this.mappingRegistry,
          connectionManager: this.connectionManager,
          shouldEmit: () =>
            Boolean(
              this._shouldEmitMidiFeedback ||
                (typeof window !== 'undefined' && window.__ENABLE_MIDI_FEEDBACK),
            ),
        });
        this.feedbackBridge.activate();
      }
    }
    this._updateMidiFeedbackAutoState('param-manager-set');
  }

  /**
   * Multi-orbiter: resolve the ParameterManager to drive for a given MIDI binding.
   * Each binding carries the `voiceId` of the tile whose control was mapped; route the inbound value
   * to THAT voice's PM (via the realm registry) so a CC drives the orbiter it was mapped on — never
   * whichever orbiter is focused, and a CC mapped on an orbiter loaded into N tiles drives all N (each
   * tile's binding resolves its own voice). Single-orbiter (`voiceId` null, or the voice not found)
   * falls back to the controller's single injected PM → byte-identical.
   * @param {string|null|undefined} voiceId
   * @returns {object|null} the ParameterManager to write to.
   */
  _pmForVoice(voiceId) {
    if (voiceId) {
      const pm = voiceRegistry.get(voiceId)?.parameterManager;
      if (pm) return pm;
    }
    return this.paramManager;
  }

  /**
   * Resolve the ORBITER a control belongs to. MIDI mappings are orbiter-owned
   * (keyed by orbiterId), not focus-bound — so a control's binding is scoped by the orbiter of
   * its OWN tile, found from the tile's voiceId via the voice registry. Single-orbiter (voiceId
   * null, or voice not yet registered) falls back to the controller's cached combined config —
   * the same orbiterId resolution `loadPersistedMappings` has always used → byte-identical.
   * @param {string|null|undefined} voiceId
   * @returns {string|null}
   */
  _orbiterIdForVoice(voiceId) {
    if (voiceId) {
      // A multi tile carries its own voiceId. Resolve STRICTLY to that voice's orbiter — never
      // fall back to `_currentCombined`/default for a known tile, or a binding could leak onto
      // the wrong (active) orbiter if the control mounts before its voice's identity resolves.
      // Returning null here makes the widget hydrate empty and reconcile on the next load /
      // re-hydrate once the voice gains its orbiterId (orbiter-owned invariant stays intact).
      return voiceRegistry.get(voiceId)?.dataManager?.activeConfigRequest?.orbiterId || null;
    }
    // Single-orbiter (voiceId null): the one orbiterId comes from the cached combined config —
    // the same fallback chain `loadPersistedMappings` has always used → byte-identical.
    return (
      this._currentCombined?.orbiter?.orbiterId ||
      this._currentCombined?.track?.defaultOrbiterId ||
      DEFAULT_ORBITER_FALLBACK?.orbiterId ||
      DEFAULT_ORBITER_FALLBACK?.release?.metadata?.orbiterId ||
      null
    );
  }

  /**
   * The persistence slice a binding belongs to, as a scopeKey. When a binding supplies an
   * explicit `persistenceScope` (a shell action's collection, a slot-level focus
   * owner), prefer it; otherwise the binding is orbiter-owned via its voice as usual.
   * @param {object|null} metadata
   * @returns {string|null}
   */
  _bindingScopeKey(metadata) {
    const explicit = metadata?.persistenceScope;
    if (explicit?.scope && explicit?.entityId) {
      return makeScopeKey(explicit.scope, explicit.entityId);
    }
    return orbiterScopeKey(this._orbiterIdForVoice(metadata?.voiceId));
  }

  /**
   * The persisted-bindings slice (from `ScopedMidiMap`) for a widget's OWN slice — the only
   * candidate set it may hydrate from. Null when no slice is resolvable (hydrates empty).
   * @param {object|null} metadata resolved widget descriptor (carries voiceId)
   * @returns {Map<string, {channel:number, cc:number}>|null}
   */
  _persistedBindingsForWidget(metadata) {
    return this.scopedMidiMap.bindingsFor(this._bindingScopeKey(metadata));
  }

  /**
   * Live propagation: when a binding is learned/unmapped on one tile, re-hydrate the SAME
   * slice's OTHER widgets of that SAME control so they pick up (or drop) the binding immediately
   * — without waiting for a reload. Scoped to the changed slice + componentKey, so single-
   * orbiter (only the origin widget matches) is a no-op re-affirm and different slices that
   * share a leaf key never cross-react.
   * @param {string} scopeKey
   * @param {string} paramKey the scoped key that changed (`layered:<componentKey>|…`) or bare id
   */
  _rehydrateSliceSiblings(scopeKey, paramKey) {
    if (!scopeKey) {
      return;
    }
    const changedComponentKey = parseLayeredKey(paramKey)?.componentKey || paramKey;
    this.widgetRegistry.forEach((element, widgetId) => {
      const metadata = this._resolveWidgetMetadata(widgetId, element);
      if (!metadata) {
        return;
      }
      const widgetComponentKey = metadata.componentKey || metadata.baseParamId || widgetId;
      if (widgetComponentKey !== changedComponentKey) {
        return;
      }
      if (this._bindingScopeKey(metadata) !== scopeKey) {
        return;
      }
      this._applyPersistedMappingForWidget(widgetId, element);
    });
  }

  /**
   * Initializes the MIDIController by checking MIDI support,
   * restoring mappings, and setting up event listeners.
   * @async
   * @private
   * @returns {Promise<void>}
   */
  async init() {
    if (!MIDI_SUPPORTED) {
      console.warn("MIDIController: Web MIDI API not supported. Skipping initialization.");
      return;
    }

    //notifications.showToast("MIDIController: Web MIDI API supported.");
    // Restore persisted mappings if you have this method
    // await this.restoreMidiLearn();

  }

  handleDataManagerConfig(event) {
    const combined = event?.detail?.combined || null;
    // Cache the active voice's combined config here (no Constants.TRACK_DATA global). The
    // MIDI scope/orbiter-id resolvers below read this instead of the removed single-current pointer.
    if (combined) {
      this._currentCombined = combined;
    }
    this.loadPersistedMappings(true, combined);
  }

  /**
   * Load the persisted mappings of EVERY present slice, not just the active
   * one. In multi-orbiter mode each live voice's orbiterId is read from the voice registry;
   * widgets carrying an explicit persistence slice (shell targets, slot-focus) contribute
   * their scopeKeys; in single-orbiter mode (no voices registered) we fall back to the one
   * resolvable orbiterId, exactly as before → byte-identical. One `loadMany` loads them all.
   */
  async loadPersistedMappings(force = false, combined = null) {
    if (!MIDI_SUPPORTED) return;
    const scopeKeys = new Set();
    voiceRegistry.all().forEach((voice) => {
      const scopeKey = orbiterScopeKey(voice?.dataManager?.activeConfigRequest?.orbiterId);
      if (scopeKey) {
        scopeKeys.add(scopeKey);
      }
    });
    this.widgetDescriptors.forEach((metadata) => {
      const explicit = metadata?.persistenceScope;
      const scopeKey = explicit ? makeScopeKey(explicit.scope, explicit.entityId) : null;
      if (scopeKey) {
        scopeKeys.add(scopeKey);
      }
    });
    if (!scopeKeys.size) {
      const orbiterId =
        combined?.orbiter?.orbiterId ||
        combined?.track?.defaultOrbiterId ||
        this._currentCombined?.orbiter?.orbiterId ||
        this._currentCombined?.track?.defaultOrbiterId ||
        DEFAULT_ORBITER_FALLBACK?.orbiterId ||
        DEFAULT_ORBITER_FALLBACK?.release?.metadata?.orbiterId ||
        null;
      const scopeKey = orbiterScopeKey(orbiterId);
      if (scopeKey) {
        scopeKeys.add(scopeKey);
      }
    }

    if (!scopeKeys.size) {
      console.warn('[MIDIController] No persistence slice available for loading MIDI mappings.');
      return;
    }

    const ids = [...scopeKeys];
    const signature = ids.slice().sort().join('|');
    // Loaded-ness is PER SLICE (`hasLoaded`), never the store-global hasAny(): a shell slice
    // registering after the orbiters loaded must not be masked by their bindings.
    if (!force && this._lastLoadedSignature === signature && ids.every((key) => this.scopedMidiMap.hasLoaded(key))) {
      return;
    }

    if (this._loadMappingsPromise) {
      return this._loadMappingsPromise;
    }

    this._loadMappingsPromise = (async () => {
      try {
        await this.mappingPersistence.loadMany(ids);
        this._applyPersistedMappingsToRegisteredWidgets();
      } catch (error) {
        if (error?.message?.toLowerCase?.().includes('authentication required')) {
          // handled via login prompt inside midiLearnService
        } else {
          console.error('[MIDIController] Failed to load MIDI mappings:', error);
        }
      } finally {
        this._lastLoadedSignature = signature;
        this._loadMappingsPromise = null;
        this._updateMidiFeedbackAutoState('mappings-load-final');
      }
    })();

    return this._loadMappingsPromise;
  }

  /**
   * Fetch one slice's persisted bindings, sharing an in-flight request when a SECOND
   * caller asks for the SAME slice before the first resolves (e.g. the same track registering its
   * MIDI focus target on two collection stages in the same tick) — one network round-trip, not two.
   * @param {string} scopeKey
   * @returns {Promise<void>}
   */
  _loadScopeSliceOnce(scopeKey) {
    let promise = this._pendingScopeLoads.get(scopeKey);
    if (!promise) {
      promise = this.mappingPersistence
        .loadMany([scopeKey])
        .finally(() => this._pendingScopeLoads.delete(scopeKey));
      this._pendingScopeLoads.set(scopeKey, promise);
    }
    return promise;
  }

  /**
   * Re-fetch the active orbiter's scoped mappings and re-apply them to the live widgets.
   * The load-saved-mappings dialog calls this after copying a source orbiter's bindings
   * into the current one, so the change takes effect immediately without a reload.
   */
  async reloadPersistedMappings() {
    return this.loadPersistedMappings(true);
  }

  /** The collection whose shell targets are currently registered (or null outside the
   *  collection studio) — used by the load-mappings dialog to scope shell-mapping transfers. */
  getActiveCollectionId() {
    for (const metadata of this.widgetDescriptors.values()) {
      const explicit = metadata?.persistenceScope;
      if (explicit?.scope === 'collection' && explicit.entityId) {
        return explicit.entityId;
      }
    }
    return null;
  }

  /** The active orbiter id (or null) — used to scope MIDI-mapping transfers from the dialog. */
  getActiveOrbiterId() {
    // In multi, prefer the ACTIVE (focused) voice's own orbiterId. `_currentCombined`
    // is a single-current cache that can go stale when each voice dispatches config on its own bus, so
    // the load-mappings dialog could otherwise copy mappings into the WRONG orbiter when several are
    // open. Single-orbiter (no active voice, or one voice = same id) → `_currentCombined` → byte-identical.
    return (
      voiceRegistry.getActive()?.dataManager?.activeConfigRequest?.orbiterId ||
      this._currentCombined?.orbiter?.orbiterId ||
      this._currentCombined?.track?.defaultOrbiterId ||
      null
    );
  }

  _applyPersistedMappingsToRegisteredWidgets() {
    if (!this.scopedMidiMap.hasAny()) {
      this._updateMidiFeedbackAutoState('mappings-hydrated');
      return;
    }
    this.widgetRegistry.forEach((widget, widgetId) => {
      this._applyPersistedMappingForWidget(widgetId, widget);
    });
    this._updateMidiFeedbackAutoState('mappings-hydrated');
  }

  _applyPersistedMappingForWidget(widgetId, widget = null) {
    const element = widget || this.widgetRegistry.get(widgetId);
    if (!element) return;
    const metadata = this._resolveWidgetMetadata(widgetId, element);
    if (!metadata) {
      return;
    }

    // Hydrate ONLY from this widget's own orbiter's persisted bindings, so a
    // different orbiter that shares a leaf component key (e.g. `x.knob`) can never cross-hydrate.
    const persistedBindings = this._persistedBindingsForWidget(metadata);

    if (metadata.supportsLayers) {
      const context = this._resolveCurrentStackContext();
      const hydration = this.mappingRegistry.hydrateLayeredWidget(
        widgetId,
        metadata,
        context,
        persistedBindings,
      );
      if (!hydration || !hydration.binding) {
        if (element && typeof element.removeAttribute === 'function') {
          element.removeAttribute('data-midi-param-id');
        }
        this._removeWidgetIndicator(widgetId);
        return;
      }
      if (element && typeof element.setAttribute === 'function' && hydration.scopedKey) {
        element.setAttribute('data-midi-param-id', hydration.scopedKey);
      }
      const presentation = this._resolveDimensionPresentation(context.dimensionId);
      if (this.indicatorManager.hasIndicator(widgetId)) {
        this.indicatorManager.updateIndicator(widgetId, {
          midiCC: hydration.binding.cc,
          midiChannel: hydration.binding.channel,
          type: 'cc',
          layerIndex: presentation.index,
          dimensionId: context.dimensionId,
          stackId: context.stackId,
          dimensionLabel: presentation.label,
        });
      } else {
        this.markAsMapped(widgetId, hydration.binding.cc, hydration.binding.channel, 'cc', {
          layerIndex: presentation.index,
          dimensionId: context.dimensionId,
          stackId: context.stackId,
          dimensionLabel: presentation.label,
        });
      }
      return;
    }

    const key = metadata.baseParamId || this._resolveBaseParameterId(element, widgetId);
    if (!key) {
      return;
    }

    let binding = persistedBindings?.get(key);
    if (!binding && persistedBindings && metadata.legacyKeys.length) {
      const legacyKey = metadata.legacyKeys.find((candidate) =>
        persistedBindings.has(candidate),
      );
      if (legacyKey) {
        binding = persistedBindings.get(legacyKey);
        persistedBindings.set(key, binding);
        persistedBindings.delete(legacyKey);
      }
    }
    if (!binding) {
      if (this.midiWidgetMappings.has(widgetId)) {
        this.midiWidgetMappings.delete(widgetId);
        this._removeWidgetIndicator(widgetId);
      }
      return;
    }

    const channel = Number(binding.channel);
    const cc = Number(binding.cc);
    if (!Number.isFinite(channel) || !Number.isFinite(cc)) {
      return;
    }

    const existing = this.midiWidgetMappings.get(widgetId);
    if (existing && existing.channel === channel && existing.cc === cc) {
      this._syncIndicatorVisibility(widgetId, element);
      return;
    }

    this.midiWidgetMappings.set(widgetId, { channel, cc, scopedKey: key });
    const parameterId = metadata.axis || key;
    this.mappingRegistry.linkParameterMapping(parameterId, {
      scopedKey: key,
      channel,
      cc,
      kind: metadata.kind,
    });
    this.markAsMapped(widgetId, cc, channel, 'cc', { layerIndex: 0, stackId: DEFAULT_STACK_ID });
  }

  _getParameterIdForWidget(widgetId, widget = null) {
    return (
      this.mappingRegistry.getParameterIdForWidget(widgetId, widget, () =>
        this._resolveCurrentStackContext(),
      ) || widgetId
    );
  }

  /**
   * Activates MIDI mode by requesting MIDI access.
   * Shows a toast notification upon successful activation.
   * @async
   * @public
   * @returns {Promise<void>}
   * @throws Will log an error if MIDI activation fails.
   *
   * @example
   * const midiController = new MIDIController();
   * midiController.activateMIDI();
   */
  async activateMIDI() {
    if (this.isMIDIActivated) {
      // notifications.showToast('MIDI is already activated.', 'info');
      this._updateMidiFeedbackAutoState('midi-activated');
      return;
    }

    try {
      await this.connectionManager.ensureAccess();
      this.isMIDIActivated = true;
      //notifications.showToast('MIDI activated successfully!', 'success');
      this._updateMidiFeedbackAutoState('midi-activated');
    } catch (error) {
      const shouldNotify =
        !isIframeContext() || !hasNotifiedMidiActivationFailed();
      if (shouldNotify) {
        const t = getT();
        notifications.showToast(t('notifications.midiActivationFailed', { error: error.message }), 'error');
        if (isIframeContext()) {
          markMidiActivationFailedNotified();
        }
      }
    }
  }

  /**
   * Handles state changes for MIDI devices, such as connections and disconnections.
   * @private
   * @param {MIDIConnectionEvent} event - The MIDI connection event.
   * @returns {void}
   *
   * @example
   * midiController.handleStateChange(event);
   */
  handleStateChange(eventOrPayload) {
    const port = eventOrPayload?.port || eventOrPayload;
    if (!port) {
      return;
    }
   // notifications.showToast(`MIDI device ${port.name} is now ${port.state}.`, 'info');
    this._updateMidiFeedbackAutoState('port-state');
  }

  /**
   * Handles incoming MIDI messages, dispatching them to mapped widgets or parameters.
   * Also manages MIDI Learn functionality by mapping new controls.
   * @private
   * @param {MIDIMessageEvent} event - The MIDI message event.
   * @returns {void}
   *
   * @example
   * midiController.handleMidiMessage(event);
   */
  handleMidiMessage(message) {
    if (!message) {
      return;
    }
    const rawEvent = message.rawEvent || message;
    const status = message.data?.status ?? rawEvent?.data?.[0] ?? 0;
    const data1 = message.data?.data1 ?? rawEvent?.data?.[1] ?? 0;
    const data2 = message.data?.data2 ?? rawEvent?.data?.[2] ?? 0;
    const channel = Number.isFinite(message.channel) ? message.channel : status & 0x0f;
    let finalValue = data2;
    let isNote = false;

    const normalizedType = message.type;
    if (normalizedType === 'cc') {
      // no-op
    } else if (normalizedType === 'noteOn') {
      isNote = true;
      finalValue = data2 > 0 ? 127 : 0;
    } else if (normalizedType === 'noteOff') {
      isNote = true;
      finalValue = 0;
    } else {
      const messageType = status & 0xf0;
      if (messageType === 0x90) {
        isNote = true;
        finalValue = data2 > 0 ? 127 : 0;
      } else if (messageType === 0x80) {
        isNote = true;
        finalValue = 0;
      } else if (messageType !== 0xb0) {
        return;
      }
    }

    const ccNumber = message.data?.data1 ?? rawEvent?.data?.[1] ?? 0;

    if (window.__DEBUG_MIDI) {
      console.debug('[MIDIController] message', {
        channel,
        ccNumber,
        finalValue,
        isNote,
      });
    }

    if (this.isMidiLearnModeActive && this.currentLearnWidget) {
      const widgetId = this.currentLearnWidget.id || this.currentLearnWidget.getAttribute('data-value');
      this.setMidiWidgetMapping(widgetId, channel, ccNumber);
      this.learnUiController.unhighlightWidget(widgetId);
      this._queueMappingSave({
        element: this.currentLearnWidget,
        identifier: widgetId,
        channel,
        cc: ccNumber,
        event: rawEvent,
      });
      this.currentLearnWidget = null;
      return;
    }

    this.midiWidgetMappings.forEach((mapping, widgetId) => {
      if (mapping.channel === channel && mapping.cc === ccNumber) {
        // A kick (momentary trigger) may have learned via the element-id path
        // (when its pinned layered descriptor wasn't resolvable at learn time). Fire the
        // registered action on a rising edge here too — a trigger has no value to drive,
        // so the widget-driver path below would just no-op on the React <div>.
        if (this._kickTriggers.has(widgetId)) {
          this._kickTriggers.handle(widgetId, finalValue);
          return;
        }
        // A LATCHING toggle ACTION (loop / cosmic / sensor enable) that learned via the
        // element-id path (GLOBAL toggles like loop are non-layered). A rising edge (a press)
        // FLIPS the maintained state. No value to drive, so the widget-driver path below would
        // no-op on the React element.
        if (this._toggleActions.has(widgetId)) {
          this._toggleActions.handle(widgetId, finalValue);
          return;
        }
        // A stepped SELECT (cosmic source / waveform) that learned via the element-id
        // path. Map the CC value to an option index and select it (deduped per index). No value
        // to drive, so the widget-driver path below would no-op on the React element.
        if (this._stepSelect.has(widgetId)) {
          this._stepSelect.handle(widgetId, finalValue);
          return;
        }
        // A React VALUE control bound GLOBAL (non-layered) — e.g. the shared BPM —
        // also lands here: it has no layered key (so `_applyLayeredMidiValue` skips it), and
        // the widget-driver path below would no-op on its React element. Write the scaled
        // value straight to the PM param (the React control, subscribed to that param, then
        // updates). Guard on `!supportsLayers` so DIMENSION controls — handled by the layered
        // path AND present in this map — don't get a double write here.
        const reactMeta = this._resolveWidgetMetadata(widgetId);
        // GLOBAL (non-layered) React control (e.g. shared BPM) — drive its OWN voice PM.
        const reactPm = this._pmForVoice(reactMeta?.voiceId);
        if (
          reactMeta?.pinned &&
          !reactMeta.supportsLayers &&
          reactMeta.componentType !== 'kick' &&
          reactMeta.axis &&
          reactPm &&
          typeof reactPm.setRawValue === 'function'
        ) {
          const normalized = this._normalizeMidiValue(finalValue);
          const rawValue = this._rawValueForBinding(reactMeta, this.widgetRegistry.get(widgetId), normalized);
          if (Number.isFinite(rawValue)) {
            try {
              this.feedbackBridge?.suppressParameter(reactMeta.axis);
              reactPm.setRawValue(reactMeta.axis, rawValue, this, getPriority('MIDI'));
            } catch (error) {
              console.warn('[MIDIController] Failed to write GLOBAL React MIDI value to PM:', error);
            }
          }
          return;
        }
        let widget = this.widgetRegistry.get(widgetId);
        if (!widget) {
          widget =
            document.getElementById(widgetId) ||
            document.querySelector(`[data-value="${widgetId}"]`) ||
            null;
          if (widget && widgetId) {
            this.registerWidget(widgetId, widget);
          }
        }
        if (!widget) return;
        const behavior = widget.dataset?.midiBehavior || '';
        if (behavior === 'toggle') {
          MidiWidgetDriver.applyToggleWidget(widget, finalValue >= 64);
          return;
        }
        if (window.__DEBUG_MIDI) {
          console.debug('[MIDIController] updating widget', {
            widgetId,
            finalValue,
            type: isNote ? 'note' : 'cc',
          });
        }
        if (widget.classList?.contains('dropdown-item')) {
          widget.click();
        } else if (widget.tagName === 'WEBAUDIO-SWITCH') {
          MidiWidgetDriver.triggerWebAudioSwitch(widget, finalValue);
        } else {
          MidiWidgetDriver.updateWebAudioWidget(widget, finalValue, isNote ? 'note' : 'cc');
        }
      }
    });

    const layeredMatches = this.mappingRegistry.getLayeredMatches(channel, ccNumber);
    if (layeredMatches.length) {
      const midiContext = {
        midiValue: finalValue,
        isNote,
        channel,
        ccNumber,
      };
      layeredMatches.forEach((entry) => {
        this._applyLayeredMidiValue(entry, midiContext);
      });
    }

    this.midiParamMappings.forEach((mapping, param) => {
      if (mapping.channel === channel && mapping.cc === ccNumber) {
        this.updateParameter(param, finalValue);
      }
    });
  }

  _formatIndicatorText({ midiCC, midiChannel, type = 'cc', dimensionLabel = null }) {
    const base = `CH ${midiChannel + 1} / ${type.toUpperCase()} ${midiCC}`;
    return dimensionLabel ? `${base} | ${dimensionLabel}` : base;
  }

  _normalizeMidiValue(midiValue) {
    return clamp(Number.isFinite(midiValue) ? midiValue / 127 : 0, 0, 1);
  }

  _computeWidgetRawValue(widget, normalizedValue) {
    if (!widget) {
      return normalizedValue;
    }
    const minAttr = widget.min ?? widget.getAttribute?.('min');
    const maxAttr = widget.max ?? widget.getAttribute?.('max');
    const min = Number(minAttr);
    const max = Number(maxAttr);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return min + normalizedValue * (max - min);
    }
    if (typeof widget.value === 'number') {
      return widget.value;
    }
    const current = Number(widget.value);
    if (Number.isFinite(current)) {
      return current;
    }
    return normalizedValue;
  }

  _coerceScopedValue(metadata, { rawValue, normalizedValue, boolValue }) {
    if (!metadata) {
      return undefined;
    }
    const template = metadata.defaultValue;
    if (metadata.componentType === 'knob' || (template && typeof template === 'object' && 'value' in template)) {
      return {
        value: Number.isFinite(rawValue) ? Number(rawValue) : 0,
        normalized: Number.isFinite(normalizedValue) ? Number(normalizedValue) : 0,
        _timestamp: Date.now(),
      };
    }
    if (typeof template === 'boolean' || /toggle/i.test(metadata.componentType || '')) {
      return Boolean(boolValue);
    }
    if (Array.isArray(template)) {
      return template.slice();
    }
    if (typeof template === 'number') {
      return Number.isFinite(rawValue) ? Number(rawValue) : 0;
    }
    if (template && typeof template === 'object') {
      return {
        ...template,
        value: Number.isFinite(rawValue) ? Number(rawValue) : template.value ?? rawValue,
        normalized:
          Number.isFinite(normalizedValue) && Object.prototype.hasOwnProperty.call(template, 'normalized')
            ? Number(normalizedValue)
            : template.normalized ?? normalizedValue,
        _timestamp: Date.now(),
      };
    }
    return Number.isFinite(rawValue) ? Number(rawValue) : rawValue;
  }

  /**
   * When autofocus is ON, moving a mapped control whose parameter belongs to a non-active
   * dimension switches the active dimension to that control's. Edit-mode only — the `modes.edit`
   * controller exists only in edit mode (play mode has no dimensions), so its absence no-ops here.
   * Leading-edge throttle with a global 250 ms cooldown so two controls on different dimensions
   * can't thrash. Reuses the same `setActiveDimension` path as the number-keys / dimension selector,
   * which is audio-neutral.
   */
  _maybeAutofocus(scopedKey) {
    if (!isAutofocusEnabled()) return;
    const edit = voiceRegistry.getActive()?.worldMode?.modes?.edit;
    if (!edit || typeof edit.setActiveDimension !== 'function') return;
    const target = parseLayeredKey(scopedKey)?.dimensionId;
    if (!target || target === edit.activeDimensionId) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    // Default to -Infinity (not 0): 0 is a real early `performance.now()` value, so a `|| 0` sentinel
    // would suppress the very first switch within the first 250 ms after load.
    if (now - (this._lastAutofocusSwitchAt ?? -Infinity) < AUTOFOCUS_COOLDOWN_MS) return;
    this._lastAutofocusSwitchAt = now;
    edit.setActiveDimension(target);
  }

  _applyLayeredMidiValue({ widgetId, scopedKey, binding }, midiContext) {
    const metadata = this._resolveWidgetMetadata(widgetId);
    if (!metadata || !metadata.supportsLayers) {
      return;
    }
    // Autofocus runs for ANY mapped layered control (kick/toggle/select/value), so check
    // it here before the component-type early-returns below.
    this._maybeAutofocus(scopedKey);
    // A kick is a momentary ACTION, not a value. Fire the registered trigger on a
    // RISING edge (note-on, or a CC crossing 64 upward) and skip the value / scoped-state /
    // ParameterManager path entirely. Rising-edge keying on the prior value means a held
    // control or a note-off doesn't re-fire. The action itself (triggerKick) resolves the
    // active dimension, so the kick lands where the matching click would.
    if (metadata.componentType === 'kick') {
      this._kickTriggers.handle(widgetId, midiContext.midiValue);
      return;
    }
    // A LATCHING toggle ACTION (cosmic / sensor enable) learned LAYERED (DIMENSION-scoped).
    // A rising edge (a press) FLIPS the maintained state and skips the value / scoped-state /
    // ParameterManager path: the callback (CosmicLFO.start/stop, SensorController) owns persistence
    // + the active dimension, exactly as the matching on-screen hexagon click would.
    if (metadata.componentType === 'toggle') {
      this._toggleActions.handle(widgetId, midiContext.midiValue);
      return;
    }
    // A stepped SELECT (cosmic source / waveform) learned LAYERED (it is DIMENSION-scoped).
    // Map the CC value to an option index and fire the select-by-index callback (deduped per index),
    // skipping the value / scoped-state / ParameterManager path: source/waveform are strings the
    // CosmicLFO owns + persists per-dim, not PM params.
    if (metadata.componentType === 'select') {
      this._stepSelect.handle(widgetId, midiContext.midiValue);
      return;
    }
    const parsedScope = parseLayeredKey(scopedKey);
    if (!parsedScope) {
      return;
    }
    const normalizedValue = this._normalizeMidiValue(midiContext.midiValue);
    const widget = this.widgetRegistry.get(widgetId);
    const rawValue = this._rawValueForBinding(metadata, widget, normalizedValue);
    const coerced = this._coerceScopedValue(metadata, {
      rawValue,
      normalizedValue,
      boolValue: midiContext.midiValue >= 64,
    });
    if (typeof coerced === 'undefined') {
      return;
    }

    const targetStackId = parsedScope.stackId || DEFAULT_STACK_ID;
    const targetDimensionId = parsedScope.dimensionId || DEFAULT_DIMENSION_ID;
    const componentId = metadata.componentId || parsedScope.componentKey;
    if (!componentId) {
      return;
    }

    try {
      setScopedState(targetStackId, componentId, coerced, { dimensionId: targetDimensionId });
    } catch (error) {
      console.warn('[MIDIController] Failed to persist layered MIDI value:', error);
    }

    const activeContext = this._resolveCurrentStackContext();
    // Drive the binding's OWN voice PM (the orbiter the control belongs to), not the single
    // focused `this.paramManager`. Single-orbiter (voiceId null) → this.paramManager (byte-identical).
    const pm = this._pmForVoice(metadata.voiceId);
    if (pm && metadata.axis && Number.isFinite(rawValue)) {
      try {
        if (typeof pm.setDimensionValue === 'function') {
          this.feedbackBridge?.suppressParameter(metadata.axis);
          pm.setDimensionValue(
            metadata.axis,
            targetDimensionId,
            rawValue,
            this,
            getPriority('MIDI')
          );
        } else if (
          activeContext.stackId === targetStackId &&
          activeContext.dimensionId === targetDimensionId
        ) {
          this.feedbackBridge?.suppressParameter(metadata.axis);
          pm.setRawValue(metadata.axis, rawValue, this, getPriority('MIDI'));
        }
      } catch (error) {
        console.warn('[MIDIController] Failed to propagate MIDI value to ParameterManager:', error);
      }
    }

    const presentation = this._resolveDimensionPresentation(targetDimensionId);
    this.indicatorManager.updateIndicator(widgetId, {
      midiCC: binding.cc,
      midiChannel: binding.channel,
      type: midiContext.isNote ? 'note' : 'cc',
      layerIndex: presentation.index,
      dimensionId: targetDimensionId,
      stackId: targetStackId,
      dimensionLabel: presentation.label,
    });
  }

  /**
   * Marks a widget or parameter as mapped and adds visual indicators.
   * @private
   * @param {string} elementId - The ID of the widget or parameter.
   * @param {number} midiCC - The MIDI Control Change number.
   * @param {number} midiChannel - The MIDI channel number (0-15).
   * @returns {void}
   *
   * @example
   * midiController.markAsMapped('volumeSlider', 7, 0);
   */
  markAsMapped(elementId, midiCC, midiChannel, type = 'cc', meta = {}) {
    this.indicatorManager.markAsMapped(elementId, {
      ...meta,
      midiCC,
      midiChannel,
      type,
    });
  }

  updateIndicatorForElement(element) {
    this.indicatorManager.updateIndicatorForElement(element);
  }


  _updateIndicatorsVisibility(visible) {
    this.indicatorManager.setVisibility(Boolean(visible && this.isMidiLearnModeActive));
  }

  _updateMidiFeedbackAutoState(reason = '') {
    const shouldEnable =
      hasConnectedMidiOutputs(this.connectionManager) &&
      hasActiveMidiMappings(this.mappingRegistry, this.midiWidgetMappings, this.midiParamMappings);
    if (this._shouldEmitMidiFeedback === shouldEnable) {
      if (
        typeof window !== 'undefined' &&
        window.__ENABLE_MIDI_FEEDBACK !== this._shouldEmitMidiFeedback
      ) {
        window.__ENABLE_MIDI_FEEDBACK = this._shouldEmitMidiFeedback;
      }
      return;
    }
    this._shouldEmitMidiFeedback = shouldEnable;
    if (typeof window !== 'undefined') {
      window.__ENABLE_MIDI_FEEDBACK = shouldEnable;
      if (window.__DEBUG_MIDI) {
        console.debug(
          `[MIDIController] MIDI feedback ${shouldEnable ? 'enabled' : 'disabled'}${
            reason ? ` (${reason})` : ''
          }`,
        );
      }
    }
  }

  /**
   * While MIDI-learn mode is active, keep every CH/CC badge + click overlay glued to its control by
   * repositioning each frame. The badges/overlays are `position:fixed` off a getBoundingClientRect,
   * so discrete refreshes (panel-change, resize) drift the moment a layout change they don't fire on
   * happens — a panel opening/closing reflows the controls, an async waveform lays out over several
   * frames, a transition animates. A per-frame reposition is the lightest thing that stays tied
   * through ALL of those; it runs only during learn mode (a transient, non-audio-critical state) and
   * stops itself the instant learn mode ends.
   */
  _startIndicatorTracking() {
    if (this._indicatorTrackingRaf != null || typeof window === 'undefined') {
      return;
    }
    const tick = () => {
      if (!this.isMidiLearnModeActive) {
        this._indicatorTrackingRaf = null;
        return;
      }
      this.indicatorManager.refreshPositions();
      this.refreshOverlays();
      this._indicatorTrackingRaf = window.requestAnimationFrame(tick);
    };
    this._indicatorTrackingRaf = window.requestAnimationFrame(tick);
  }

  _stopIndicatorTracking() {
    if (this._indicatorTrackingRaf != null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this._indicatorTrackingRaf);
    }
    this._indicatorTrackingRaf = null;
  }

  ensureOverlayForElement(element) {
    this.learnUiController.ensureOverlayForElement(element);
  }

  refreshOverlays() {
    this.learnUiController.refreshOverlays();
  }

  _resolveMidiScope(element, identifier = null) {
    // A learned binding is scoped to the persistence slice of the WIDGET being
    // mapped — an explicit `persistenceScope` (shell targets, slot focus) when the binding
    // carries one, else the tile's own orbiter via its voiceId — not whatever `_currentCombined`
    // last cached. In multi, each voice dispatches config on its own bus so `_currentCombined`
    // can be stale; the per-widget resolution sidesteps that. Single-orbiter (voiceId null)
    // falls back to `_currentCombined` inside `_orbiterIdForVoice` → unchanged behaviour.
    const widgetId = element?.id || element?.getAttribute?.('data-value') || identifier;
    const metadata = widgetId ? this._resolveWidgetMetadata(widgetId, element) : null;
    const resolved = parseScopeKey(this._bindingScopeKey(metadata));
    if (resolved) {
      return resolved;
    }
    console.warn('[MIDIController] Unable to resolve persistence slice for MIDI mapping.');
    return null;
  }

  _resolveParameterId(element, fallbackId) {
    const widgetId = element?.id || element?.getAttribute?.('data-value') || fallbackId;
    const metadata = this._resolveWidgetMetadata(widgetId, element);
    if (!metadata) {
      return fallbackId;
    }
    const scopedKey = this._buildScopedMidiKey(metadata, this._resolveCurrentStackContext());
    return scopedKey || fallbackId;
  }

  _resolveDeviceInfo(event) {
    const input = event?.target || event?.currentTarget || event?.srcElement;
    if (input) {
      const deviceId = input.id || input.name || input.manufacturer || 'midi-device';
      return {
        deviceId,
        name: input.name || null,
        manufacturer: input.manufacturer || null,
      };
    }
    return { deviceId: 'midi-device', name: null, manufacturer: null };
  }

  _resolveWidgetMetadata(widgetId, widget = null) {
    return this.mappingRegistry.resolveWidgetMetadata(widgetId, widget);
  }

  _resolveBaseParameterId(element, fallbackId) {
    return this.mappingRegistry.resolveBaseParameterId(element, fallbackId);
  }

  _buildScopedMidiKey(metadata, context = null) {
    const activeContext = context || this._resolveCurrentStackContext();
    return this.mappingRegistry.buildScopedMidiKey(metadata, activeContext);
  }

  _resolveCurrentStackContext() {
    const modeController = voiceRegistry.getActive()?.worldMode ?? null;
    const editMode = modeController?.modes?.edit ?? null;
    let stackId =
      editMode?.activeStackId ??
      modeController?.activeStackId ??
      editMode?.defaultStackId ??
      null;
    let dimensionId =
      editMode?.activeDimensionId ??
      modeController?.activeDimensionId ??
      editMode?.defaultDimensionId ??
      null;

    if (!dimensionId && typeof document !== 'undefined') {
      const dimensionButton = byId('dimensionMenuButton');
      if (dimensionButton?.dataset?.dimensionId) {
        dimensionId = dimensionButton.dataset.dimensionId;
      }
    }

    if (!stackId) {
      stackId = voiceRegistry.getActive()?.worldMode?.activeStackId ?? null;
    }

    return {
      stackId: stackId || DEFAULT_STACK_ID,
      dimensionId: dimensionId || DEFAULT_DIMENSION_ID,
    };
  }

  _resolveDimensionPresentation(dimensionId = null) {
    const modeController = voiceRegistry.getActive()?.worldMode ?? null;
    const usableId =
      dimensionId ??
      modeController?.activeDimensionId ??
      modeController?.defaultDimensionId ??
      null;
    const listSource =
      (Array.isArray(modeController?.dimensionList) ? modeController.dimensionList : null) ||
      (modeController?.dimensions && typeof modeController.dimensions.values === 'function'
        ? Array.from(modeController.dimensions.values())
        : null) ||
      (typeof modeController?._dimensionDefinitions === 'function'
        ? modeController._dimensionDefinitions()
        : null);
    let index = 0;
    let label = usableId;
    if (Array.isArray(listSource) && listSource.length) {
      const normalized = listSource.map((entry) =>
        typeof entry === 'string' ? { id: entry, label: entry } : entry || {},
      );
      const resolvedIndex = usableId
        ? normalized.findIndex((entry) => entry.id === usableId)
        : -1;
      if (resolvedIndex >= 0) {
        index = resolvedIndex;
        label = normalized[resolvedIndex]?.label ?? usableId;
      } else if (usableId == null) {
        index = 0;
        label = normalized[0]?.label ?? normalized[0]?.id ?? null;
      } else if (usableId) {
        index = Math.max(
          0,
          normalized.findIndex((entry) => entry.id === usableId || entry.label === usableId),
        );
      }
    } else if (typeof document !== 'undefined') {
      const menuItems = Array.from(
        document.querySelectorAll('[data-dimension-menu] [data-dimension-id]'),
      );
      if (menuItems.length) {
        const idx = menuItems.findIndex((item) => item.dataset.dimensionId === usableId);
        if (idx >= 0) {
          index = idx;
          label = menuItems[idx]?.dataset?.value || menuItems[idx]?.textContent?.trim() || usableId;
        }
      }
    }

    if (!label && typeof document !== 'undefined') {
      const activeMenuItem = document.querySelector(
        `[data-dimension-menu] [data-dimension-id="${usableId}"]`,
      );
      if (activeMenuItem?.dataset?.value) {
        label = activeMenuItem.dataset.value;
      } else {
        const buttonLabel = document.querySelector('[data-dimension-label]');
        if (buttonLabel?.textContent) {
          label = buttonLabel.textContent.trim();
        }
      }
    }
    return {
      index,
      label: label ?? usableId ?? DEFAULT_DIMENSION_ID,
    };
  }

  _syncIndicatorVisibility(widgetId, element = null) {
    const widgetElement =
      element || document.getElementById(widgetId) || document.querySelector(`[data-value="${widgetId}"]`);
    if (!widgetElement) {
      return;
    }
    this.indicatorManager.updateIndicatorForElement(widgetElement);
  }

  _removeWidgetIndicator(widgetId) {
    this.indicatorManager.removeIndicator(widgetId);
  }

  _syncLayeredWidgetMapping(widgetId, metadata, context = null, element = null) {
    if (!metadata?.supportsLayers) {
      return;
    }
    const activeContext = context || this._resolveCurrentStackContext();
    const elementRef = element || this.widgetRegistry.get(widgetId);
    const { binding, scopedKey } = this.mappingRegistry.syncLayeredWidgetBinding(
      widgetId,
      metadata,
      activeContext,
    );

    if (!binding) {
      if (elementRef && typeof elementRef.removeAttribute === 'function') {
        elementRef.removeAttribute('data-midi-param-id');
      }
      this._removeWidgetIndicator(widgetId);
      return;
    }

    if (elementRef && typeof elementRef.setAttribute === 'function' && scopedKey) {
      elementRef.setAttribute('data-midi-param-id', scopedKey);
    }

    const presentation = this._resolveDimensionPresentation(activeContext.dimensionId);
    if (this.indicatorManager.hasIndicator(widgetId)) {
      this.indicatorManager.updateIndicator(widgetId, {
        midiCC: binding.cc,
        midiChannel: binding.channel,
        type: 'cc',
        layerIndex: presentation.index,
        dimensionId: activeContext.dimensionId || '',
        stackId: activeContext.stackId || '',
        dimensionLabel: presentation.label,
      });
      this._syncIndicatorVisibility(widgetId, elementRef || this.widgetRegistry.get(widgetId));
    } else {
      this.markAsMapped(widgetId, binding.cc, binding.channel, 'cc', {
        layerIndex: presentation.index,
        dimensionId: activeContext.dimensionId,
        stackId: activeContext.stackId,
        dimensionLabel: presentation.label,
      });
    }
  }

  _syncAllLayeredWidgetMappings() {
    if (!this.layeredWidgetMappings.size) {
      return;
    }
    const context = this._resolveCurrentStackContext();
    this.layeredWidgetMappings.forEach((_map, widgetId) => {
      const metadata = this._resolveWidgetMetadata(widgetId);
      if (metadata?.supportsLayers) {
        this._syncLayeredWidgetMapping(widgetId, metadata, context);
      }
    });
  }

  _handleDimensionChange() {
    this._syncAllLayeredWidgetMappings();
    // Toggle actions (cosmic-enable) are DIMENSION-scoped but the dispatcher keys edge
    // state by the dimension-stable widget id. Re-arm on a dimension change so the next inbound
    // CC reconciles the now-active dimension's toggle instead of being deduped against the old
    // dimension's state (kicks self-rearm on a drop below threshold; level-deduped toggles need
    // this explicit reset).
    this._toggleActions.resetState();
    // Stepped selects (cosmic source / waveform) are likewise DIMENSION-scoped — re-arm so
    // the next inbound CC reconciles the now-active dimension's selection rather than being deduped
    // against the old dimension's index.
    this._stepSelect.resetState();
  }

  _queueMappingSave({ element, identifier, channel, cc, event }) {
    if (!this.isMidiLearnModeActive) {
      return;
    }
    const context = this._resolveCurrentStackContext();
    if (window.__DEBUG_MIDI) {
      console.debug('[MIDIController] persisting mapping', {
        identifier,
        channel,
        cc,
        stackId: context.stackId,
        dimensionId: context.dimensionId,
      });
    }
    void this.mappingPersistence
      .saveBinding({
        element,
        identifier,
        context,
        midiPayload: { channel, cc, event },
      })
      .catch((error) => {
        console.error('[MIDIController] Failed to persist MIDI mapping:', error);
        const t = getT();
        const message = error?.message || t('notifications.midiMappingSaveFailed');
        notifications.showToast(message, 'error');
      });
  }

  _queueMappingRemoval(identifier, parameterKey = null, element = null) {
    const elementRef =
      element ||
      document.getElementById(identifier) ||
      document.querySelector(`[data-value="${identifier}"]`) ||
      this.widgetRegistry.get(identifier) ||
      null;
    if (window.__DEBUG_MIDI) {
      console.debug('[MIDIController] removing mapping', {
        identifier,
        parameterKey,
      });
    }
    void this.mappingPersistence
      .clearBinding({
        identifier,
        parameterKey,
        element: elementRef,
      })
      .catch((error) => {
        console.error('[MIDIController] Failed to clear MIDI mapping remotely:', error);
        const t = getT();
        const message = error?.message || t('notifications.midiMappingRemovalFailed');
        notifications.showToast(message, 'error');
      });
  }

  /**
   * Updates a parameter based on incoming MIDI data.
   * @private
   * @param {string} identifier - The parameter name or widget ID.
   * @param {number} midiValue - The MIDI CC value (0-127).
   * @returns {void}
   *
   * @example
   * midiController.updateParameter('volume', 100);
  */
  updateParameter(identifier, midiValue) {
    const element = this.widgetRegistry.get(identifier);
    if (element) {
      MidiWidgetDriver.updateParameterElement(element, midiValue);
    } else {
      console.warn(`MIDIController: Element '${identifier}' not found.`);
    }
  }

  /**
   * Registers a widget for MIDI control.
   * @public
   * @param {string} id - The widget's unique ID.
   * @param {HTMLElement} widget - The widget instance.
   * @returns {void}
   *
   * @example
   * midiController.registerWidget('volumeSlider', sliderElement);
  */
  registerWidget(id, widget) {
    if (!id || !widget) {
      console.warn("MIDIController: Cannot register widget without ID or instance.");
      return;
    }
    this.mappingRegistry.registerWidget(id, widget);
    const paramId = this._getParameterIdForWidget(id, widget);
    if (paramId && typeof widget.setAttribute === 'function') {
      widget.setAttribute('data-midi-param-id', paramId);
    }
    this._applyPersistedMappingForWidget(id, widget);
  }

  /**
   * React seam: register a controlled React control as a MIDI-learn
   * target from a TYPED scoped-binding record — not by round-tripping metadata
   * through DOM `data-midi-*` attributes (the WAC model). The record is the source
   * of truth; we seed the widget descriptor directly, so the existing key-build /
   * inbound-drive / feedback / echo-suppression machinery works unchanged and a
   * React control sharing a WAC widget's `componentId` (e.g. "x.knob") inherits its
   * persisted `layered:<componentId>|<stack>|<dimension>` mappings.
   *
   * Only `id` + `data-automatable` live on the DOM (the learn overlays need a
   * positioned element + stable id); all scoped metadata comes from the record.
   *
   * @param {{ id:string, element:HTMLElement, componentId:string, componentType?:string,
   *   scope?:('DIMENSION'|'GLOBAL'), axis?:string, min?:number, max?:number,
   *   persistenceScope?:{scope:string, entityId:string}|null }} binding
   */
  registerMidiLearnTarget(binding) {
    const { id, element, componentId } = binding || {};
    if (!id || !element || !componentId) {
      console.warn('[MIDIController] registerMidiLearnTarget requires { id, element, componentId }.');
      return;
    }
    if (typeof element.setAttribute === 'function' && !element.hasAttribute('data-automatable')) {
      element.setAttribute('data-automatable', 'true');
    }
    // Persistence-scope tint: non-orbiter-owned targets (collection shell actions) get their
    // scope stamped on the element; the learn overlay + CH/CC badge mirror it so the user can
    // tell collection-owned mappings from orbiter-owned ones at a glance.
    if (binding.persistenceScope?.scope && binding.persistenceScope.scope !== 'orbiter' && element.dataset) {
      element.dataset.midiScope = binding.persistenceScope.scope;
    }
    const componentType = binding.componentType || null;
    const scope = binding.scope || 'DIMENSION';
    // A kick is a momentary TRIGGER, not a value. Stash its action so inbound
    // MIDI can fire it (see _applyLayeredMidiValue). Re-supplied on every (re)mount; the
    // CC mapping itself persists via the scoped binding below.
    if (componentType === 'kick') {
      this._kickTriggers.register(id, binding.onTrigger);
    }
    // A toggle is a stateful ACTION (start/stop), not a value. Stash its on/off
    // callback so inbound MIDI can fire it (see the element-id + layered dispatch). Re-supplied
    // on every (re)mount; the CC mapping itself persists via the scoped binding below.
    if (componentType === 'toggle') {
      this._toggleActions.register(id, binding.onToggle);
    }
    // A stepped SELECT maps ONE CC across the options by value → index. Stash its option
    // count + select-by-index callback so inbound MIDI can drive it (see the inbound dispatch).
    if (componentType === 'select') {
      this._stepSelect.register(id, { count: binding.selectCount, onIndex: binding.onSelectIndex });
    }
    // The `defaultValue` template drives `_coerceScopedValue` (it gates the param
    // drive AND shapes the persisted scoped state). Match each control's CANONICAL
    // scoped-state shape (stackUtils blueprints): knob = {value}, param/slider =
    // number, switch = boolean. A wrong shape (e.g. an object for a numeric param)
    // would corrupt scoped state on the next remount/restore.
    const DEFAULT_VALUE_BY_TYPE = { knob: { value: 0 }, slider: 0, param: 0, switch: false, toggle: false };
    const descriptor = {
      componentId,
      componentKey: componentId,
      baseParamId: componentId,
      // Multi-orbiter: the voice/tile this control belongs to ('v1'…; null in single-orbiter).
      // Inbound MIDI routes the value to THIS voice's ParameterManager (see `_pmForVoice`), so a CC drives
      // the orbiter it was mapped on — not whichever orbiter is focused. Null → the single active PM.
      voiceId: binding.voiceId ?? null,
      // Explicit persistence slice ({scope, entityId}) — a shell action's collection, or
      // a slot-focus owner. Absent → the binding is orbiter-owned via its voice.
      persistenceScope:
        binding.persistenceScope?.scope && binding.persistenceScope?.entityId
          ? { scope: binding.persistenceScope.scope, entityId: binding.persistenceScope.entityId }
          : null,
      scope,
      supportsLayers: scope === 'DIMENSION',
      componentType,
      // Tag momentary actions as triggers so the feedback bridge skips them — a
      // kick has no sustained value to echo back to a motorized fader/LED ring. Carried on the
      // descriptor (pinned) so it propagates onto every parameter-mapping record built from it.
      kind: componentType === 'kick' ? 'trigger' : undefined,
      axis: binding.axis || null,
      min: Number.isFinite(binding.min) ? binding.min : null,
      max: Number.isFinite(binding.max) ? binding.max : null,
      defaultValue: componentType in DEFAULT_VALUE_BY_TYPE ? DEFAULT_VALUE_BY_TYPE[componentType] : 0,
    };
    this.mappingRegistry.registerScopedBinding(id, element, descriptor);
    // Cache the scoped key directly (avoids getParameterIdForWidget stamping
    // data-midi-param-id back onto the element, which would invalidate the seeded
    // descriptor on the next resolve).
    const scopedKey = this._buildScopedMidiKey(descriptor, this._resolveCurrentStackContext());
    if (scopedKey) {
      this.mappingRegistry.widgetParameterLookup.set(id, scopedKey);
    }
    this._applyPersistedMappingForWidget(id, element);
    const descriptorScopeKey = descriptor.persistenceScope
      ? makeScopeKey(descriptor.persistenceScope.scope, descriptor.persistenceScope.entityId)
      : null;
    if (descriptorScopeKey && !this.scopedMidiMap.hasLoaded(descriptorScopeKey)) {
      void this._loadScopeSliceOnce(descriptorScopeKey)
        .then(() => this._applyPersistedMappingForWidget(id, element))
        .catch(() => {});
    }
    // A control migrated to the React seam may still be shadowed by a stale
    // WAC-era element-id mapping (keyed by a uiId like `yCosmicManualKnob`) that
    // dispatches through the widget-driver path and bypasses ParameterManager (no
    // curve). Drop those so inbound flows ONLY through the scoped/PM path; the user
    // re-learns on the React control ("clear legacy, require re-learn").
    // Pass the binding's already-resolved persistence slice (prefers the explicit
    // `persistenceScope` over the tile's voice, same as every other store write) — not the raw
    // voiceId, which would fall back to whichever orbiter is currently focused/combined for a
    // binding that carries an explicit persistence owner.
    this._clearLegacyWidgetMappingsForComponent(componentId, this._bindingScopeKey(descriptor));
    this.ensureOverlayForElement(element);
  }

  /**
   * Clears any LEGACY (WAC-era) element-id MIDI mappings for a migrated component's
   * `uiIds`. React scoped bindings live in the layered registry, never in
   * `midiWidgetMappings`, so this only removes stale widget-path mappings that would
   * otherwise shadow the scoped binding and bypass ParameterManager. Quiet
   * (no toast) and idempotent — only acts when such a legacy entry actually exists.
   * @private
   * @param {string} componentId
   * @param {string|null} scopeKey the binding's already-resolved persistence slice.
   */
  _clearLegacyWidgetMappingsForComponent(componentId, scopeKey = null) {
    const component = lookupComponentMetadataByKey(componentId);
    const uiIds = component?.uiIds;
    if (!Array.isArray(uiIds) || !uiIds.length) {
      return;
    }
    uiIds.forEach((legacyId) => {
      if (!legacyId || !this.midiWidgetMappings.has(legacyId)) {
        return;
      }
      this.midiWidgetMappings.delete(legacyId);
      this.mappingRegistry.clearLayeredMap?.(legacyId);
      this.widgetParameterLookup.delete(legacyId);
      if (scopeKey) {
        this.scopedMidiMap.deleteBinding(scopeKey, legacyId);
      }
      this._removeWidgetIndicator(legacyId);
      this._queueMappingRemoval(legacyId, legacyId);
      if (typeof window !== 'undefined' && window.__DEBUG_MIDI) {
        console.debug('[MIDIController] cleared legacy WAC mapping shadowing', componentId, legacyId);
      }
    });
  }

  /**
   * Inbound MIDI value scaling that prefers a typed binding's range (React seam)
   * and falls back to reading the widget element (WAC). MIDI 0..1 → param units.
   * Honours the target PM param's `scale` (e.g. logarithmic for the cosmic freq knob)
   * so equal CC steps land on equal knob positions; linear params are unchanged.
   */
  _rawValueForBinding(metadata, widget, normalizedValue) {
    if (metadata && Number.isFinite(metadata.min) && Number.isFinite(metadata.max)) {
      // Read the param's scaling curve from the binding's OWN voice PM (not the focused one),
      // so value scaling matches the orbiter the control belongs to. Single-orbiter (voiceId null) →
      // this.paramManager. Range (min/max) comes from the descriptor and is already per-binding.
      const scale = this._pmForVoice(metadata.voiceId)?.getParameter?.(metadata.axis)?.scale;
      return midiNormToValue(normalizedValue, metadata.min, metadata.max, scale);
    }
    return this._computeWidgetRawValue(widget, normalizedValue);
  }

  /**
   * React seam: deterministic unmount cleanup — the counterpart that
   * `unregisterAutomatableElement` never had (it only cleared a local Set, leaving
   * the MIDIController registries holding a detached element). Drops the live
   * element + its live mappings (the persisted scoped binding survives in
   * localStorage and re-hydrates on the next register), clears any pending learn
   * pointed at this element, and prunes its overlay.
   *
   * @param {string} id - the control's DOM id used at registration.
   */
  unregisterMidiLearnTarget(id) {
    if (!id) return;
    if (this.currentLearnWidget && this.currentLearnWidget.id === id) {
      this.currentLearnWidget = null;
      this.currentLearnParam = null;
    }
    // Drop any kick trigger action + its rising-edge state for this binding.
    this._kickTriggers.unregister(id);
    // Drop any toggle action + its last on/off state for this binding.
    this._toggleActions.unregister(id);
    // Drop any stepped-select action + its last-index state for this binding.
    this._stepSelect.unregister(id);
    this.mappingRegistry.unregisterWidget(id);
    // The control's DOM node is unmounting (e.g. an interaction-panel switch) — drop its CH/CC
    // indicator badge so it can't linger orphaned where the control used to be. The scoped binding
    // persists in the mapping registry, so re-mounting the control re-creates the badge. Mirrors
    // the overlay cleanup `refreshOverlays()` already does on this same unmount seam.
    this.indicatorManager.removeIndicator(id, { suppressClassRemoval: true });
    if (this.isMidiLearnModeActive) {
      this.refreshOverlays();
    }
  }

  /**
   * Sets a MIDI mapping for a widget.
   * @public
   * @param {string} widgetId - The widget's unique ID.
   * @param {number} channel - MIDI channel (0-15).
   * @param {number} cc - MIDI Control Change number (0-127).
   * @returns {void}
   *
   * @example
   * midiController.setMidiWidgetMapping('volumeSlider', 0, 7);
   */
  setMidiWidgetMapping(widgetId, channel, cc) {
    if (!widgetId) {
      console.warn("MIDIController: Widget ID is required for mapping.");
      return;
    }

    const metadata = this._resolveWidgetMetadata(widgetId);
    const element = this.widgetRegistry.get(widgetId) || document.getElementById(widgetId);

    if (metadata?.supportsLayers) {
      const context = this._resolveCurrentStackContext();
      const result = this.mappingRegistry.setLayeredBinding(widgetId, metadata, context, {
        channel,
        cc,
      });
      if (!result) {
        console.warn(`[MIDIController] Unable to store layered mapping for '${widgetId}'.`);
        return;
      }
      if (element && typeof element.setAttribute === 'function' && result.scopedKey) {
        element.setAttribute('data-midi-param-id', result.scopedKey);
      }
      const presentation = this._resolveDimensionPresentation(context.dimensionId);
      if (this.indicatorManager.hasIndicator(widgetId)) {
        this.indicatorManager.updateIndicator(widgetId, {
          midiCC: cc,
          midiChannel: channel,
          type: 'cc',
          layerIndex: presentation.index,
          dimensionId: context.dimensionId,
          stackId: context.stackId,
          dimensionLabel: presentation.label,
        });
      } else {
        this.markAsMapped(widgetId, cc, channel, 'cc', {
          layerIndex: presentation.index,
          dimensionId: context.dimensionId,
          stackId: context.stackId,
          dimensionLabel: presentation.label,
        });
      }
      if (element) {
        element.classList.add('midi-mapped');
      }
      // Record the binding in this widget's OWN slice at gesture time —
      // BEFORE the queued save's network round-trip, so the slice's write epoch advances and
      // any in-flight fetch lands stale. The store emits, so every same-slice sibling of this
      // control re-hydrates live (instant propagation). A different slice sharing the leaf
      // key is untouched.
      const scopeKey = this._bindingScopeKey(metadata);
      if (scopeKey && result.scopedKey) {
        this.scopedMidiMap.setBinding(scopeKey, result.scopedKey, { channel, cc });
      }
      this._updateMidiFeedbackAutoState('widget-mapped');
      return;
    } else {
      this.mappingRegistry.clearLayeredMap(widgetId);
      const baseKey = metadata?.baseParamId || this._resolveBaseParameterId(element, widgetId) || widgetId;
      this.midiWidgetMappings.set(widgetId, { channel, cc, scopedKey: baseKey });
      const parameterId = metadata?.axis || baseKey;
      this.mappingRegistry.linkParameterMapping(parameterId, {
        scopedKey: baseKey,
        channel,
        cc,
        kind: metadata?.kind,
      });
      if (element && typeof element.setAttribute === 'function') {
        element.setAttribute('data-midi-param-id', baseKey);
      }
      // Slice-owned record at gesture time + live propagation (see the
      // layered branch above).
      const scopeKey = this._bindingScopeKey(metadata);
      if (scopeKey) {
        this.scopedMidiMap.setBinding(scopeKey, baseKey, { channel, cc });
      }
    }

    if (element) {
      element.classList.add('midi-mapped');
    }
    this.markAsMapped(widgetId, cc, channel, 'cc', { layerIndex: 0, stackId: DEFAULT_STACK_ID });
    this._updateMidiFeedbackAutoState('widget-mapped');
  }

  /**
   * Clears the MIDI mapping for a specific parameter or widget.
   * Removes visual indicators and updates internal mappings.
   * @public
   * @param {string} identifier - The parameter name or widget ID.
   * @returns {void}
   *
   * @example
   * midiController.clearMidiMapping('volumeSlider');
   */
  clearMidiMapping(identifier) {
    let cleared = false;
    const removalKeys = new Set();

    // Check if identifier is a parameter
    if (this.midiParamMappings.has(identifier)) {
      this.midiParamMappings.delete(identifier);
      cleared = true;

      // Remove 'midi-mapped' class from the parameter element
      const paramElement = document.querySelector(`[data-group="${identifier}"]`);
      if (paramElement) {
        paramElement.classList.remove('midi-mapped');
      }

      // Remove MIDI indicator
      this.indicatorManager.removeIndicator(identifier);

      // Legacy param mapping (no widget) — drop it from the resolvable orbiter's
      // store slice (single-orbiter / active-config fallback, since there is no tile voiceId here).
      const paramScopeKey = orbiterScopeKey(this._orbiterIdForVoice(null));
      if (paramScopeKey) {
        this.scopedMidiMap.deleteBinding(paramScopeKey, identifier);
      }
      removalKeys.add(identifier);
    }

    // Check if identifier is a widget
    if (this.midiWidgetMappings.has(identifier)) {
      const metadata = this._resolveWidgetMetadata(identifier);
      const context = this._resolveCurrentStackContext();
      // This widget's own slice — removed bindings are dropped from its store
      // slice, which emits so every same-slice sibling re-hydrates (loses the mapping) live.
      const widgetScopeKey = this._bindingScopeKey(metadata);
      const indicator = this.indicatorManager.getIndicatorElement(identifier);

      const removalContext = {
        stackId: indicator?.dataset?.stackId || context.stackId,
        dimensionId: indicator?.dataset?.dimensionId || context.dimensionId,
      };

      if (metadata?.supportsLayers) {
        const elementRef = this.widgetRegistry.get(identifier);
        const result = this.mappingRegistry.removeLayeredBindings(
          identifier,
          metadata,
          removalContext,
        );
        result.removedKeys.forEach((key) => {
          removalKeys.add(key);
          if (widgetScopeKey) {
            this.scopedMidiMap.deleteBinding(widgetScopeKey, key);
          }
        });
        if (result.cleared) {
          this._removeWidgetIndicator(identifier);
          if (elementRef && typeof elementRef.removeAttribute === 'function') {
            elementRef.removeAttribute('data-midi-param-id');
          }
          this.widgetParameterLookup.delete(identifier);
        } else if (result.removedKeys.length) {
          this._removeWidgetIndicator(identifier);
          this._syncLayeredWidgetMapping(
            identifier,
            metadata,
            this._resolveCurrentStackContext(),
            elementRef,
          );
        }
        cleared = result.removedKeys.length > 0;
      } else {
        this.midiWidgetMappings.delete(identifier);
        this._removeWidgetIndicator(identifier);
        const baseKey =
          metadata?.baseParamId ||
          this.widgetParameterLookup.get(identifier) ||
          this._resolveBaseParameterId(this.widgetRegistry.get(identifier), identifier);
        if (baseKey) {
          if (widgetScopeKey) {
            this.scopedMidiMap.deleteBinding(widgetScopeKey, baseKey);
          }
          removalKeys.add(baseKey);
          const parameterId = metadata?.axis || baseKey;
          this.mappingRegistry.unlinkParameterMapping(parameterId, baseKey);
        }
        this.mappingRegistry.clearLayeredMap(identifier);
        const widgetElement =
          document.getElementById(identifier) || document.querySelector(`[data-value="${identifier}"]`);
        if (widgetElement) {
          widgetElement.classList.remove('midi-mapped');
        }
        this.widgetParameterLookup.delete(identifier);
        cleared = true;
        
      }
    }

    if (cleared) {
      // Notify the user
      const t = getT();
      notifications.showToast(t('notifications.midiMappingCleared', { identifier }), 'success');
      removalKeys.forEach((key) => {
        this._queueMappingRemoval(identifier, key);
      });
    } else {
      console.warn(`MIDIController: No MIDI mapping found for '${identifier}'.`);
      const t = getT();
      notifications.showToast(t('notifications.midiMappingNotFound', { identifier }), 'error');
    }
    this._updateMidiFeedbackAutoState('mapping-cleared');
  }

  /**
   * Enables MIDI Learn mode by creating overlays over automatable elements.
   * @public
   * @returns {void}
   *
   * @example
   * midiController.enableMidiLearn();
  */
  enableMidiLearn() {
    if (!this.isMIDIActivated) {
      const t = getT();
      notifications.showToast(t('notifications.midiLearnNotActivated'), 'error');
      return;
    }
    if (this.learnUiController.enable()) {
      const t = getT();
      notifications.showToast(t('notifications.midiLearnActivated'), 'info', undefined, 'midi-learn');
      this._updateIndicatorsVisibility(true);
    }
  }

  /**
   * Initiates MIDI learning mode for a specific widget.
   * Highlights the widget and waits for MIDI input to map controls.
   * @private
   * @param {HTMLElement} widget - The widget element to map.
   * @returns {void}
   *
   * @example
   * midiController.startMidiLearnForWidget(sliderElement);
   */
  startMidiLearnForWidget(widget) {
    if (!widget) {
      return;
    }
    this.learnUiController.startLearnForElement(widget);
  }

  /**
   * Highlights a specific widget in the UI to indicate it's being mapped.
   * @private
   * @param {string} widgetId - The widget's unique ID.
   * @returns {void}
   *
   * @example
   * midiController.highlightWidget('volumeSlider');
   */
  highlightWidget(widgetId) {
    this.learnUiController.highlightWidget(widgetId);
  }

  /**
   * Removes the highlight from a specific widget in the UI.
   * @private
   * @param {string} widgetId - The widget's unique ID.
   * @returns {void}
   *
   * @example
   * midiController.unhighlightWidget('volumeSlider');
   */
  unhighlightWidget(widgetId) {
    this.learnUiController.unhighlightWidget(widgetId);
  }

  /**
   * Highlights a specific parameter in the UI to indicate it's being mapped.
   * @private
   * @param {string} param - The parameter name.
   * @returns {void}
   *
   * @example
   * midiController.highlightParameter('balance');
   */
  highlightParameter(param) {
    this.learnUiController.highlightParameter(param);
  }

  /**
   * Removes the highlight from a specific parameter in the UI.
   * @private
   * @param {string} param - The parameter name.
   * @returns {void}
   *
   * @example
   * midiController.unhighlightParameter('balance');
   */
  unhighlightParameter(param) {
    this.learnUiController.unhighlightParameter(param);
  }

  /**
   * Exits MIDI Learn mode by removing overlays, cleaning up mappings,
   * and restoring UI elements to their default state.
   * @private
   * @returns {void}
   *
   * @example
   * midiController.exitMidiLearnMode();
   */
  exitMidiLearnMode() {
    if (this.learnUiController.disable()) {
      const toastContainer = document.getElementById('toast-container');
      if (toastContainer) {
        toastContainer.innerHTML = '';
      }
    }
  }

  /**
   * Handles the "Learn" action from the context menu.
   * Initiates MIDI Learn mode for the selected parameter or widget.
   * @private
   * @param {Event} event - The click or touch event.
   * @returns {void}
   *
   * @example
   * contextMenuLearnButton.addEventListener('click', midiController.handleContextMenuLearn);
   */
  _handleContextLearnAction({ widget, param }) {
    if (widget) {
      this.startMidiLearnForWidget(widget);
      this.contextMenu.close();
      return;
    }
    if (!param) {
      notifications.showToast('Select a widget or parameter first.', 'warning');
      return;
    }
    this.isMidiLearnModeActive = true;
    this.currentLearnParam = param;
    this.highlightParameter(param);
    notifications
      .showUniversalModal('MIDI Learn', `Perform a MIDI action (e.g., move a knob) to map it to '${param}'.`, 'Cancel')
      .then(() => {
        if (this.isMidiLearnModeActive) {
          this.isMidiLearnModeActive = false;
          this.unhighlightParameter(param);
          this.currentLearnParam = null;
        }
      });
    this.contextMenu.close();
  }

  _handleContextDeleteAction({ widget, param }) {
    if (widget?.id) {
      this.clearMidiMapping(widget.id);
      this.contextMenu.close();
      return;
    }
    if (param) {
      this.clearMidiMapping(param);
      this.contextMenu.close();
      return;
    }
    notifications.showToast('Select a widget or parameter first.', 'warning');
  }

  /**
   * Checks if a given element is already mapped to a MIDI control.
   * @private
   * @param {HTMLElement} element - The DOM element to check.
   * @returns {boolean} - Returns true if the element is mapped, false otherwise.
   *
   * @example
   * const isMapped = midiController.isElementMapped(widgetElement);
   */
  isElementMapped(element) {
    const id = element.id || element.getAttribute('data-value');
    return this.midiWidgetMappings.has(id) || this.midiParamMappings.has(id);
  }

  /**
   * Initiates MIDI Learn mode for a specific element (widget or parameter).
   * Highlights the element and waits for MIDI input to map controls.
   * @private
   * @param {HTMLElement} element - The DOM element to map.
   * @returns {void}
   *
   * @example
   * midiController.startMidiLearnForElement(widgetElement);
   */
  startMidiLearnForElement(element) {
    this.learnUiController.startLearnForElement(element);
  }

  /**
   * Opens the MIDI Context Menu for the specified widget or parameter at the event's location.
   * @private
   * @param {MouseEvent|TouchEvent} event - The event triggering the context menu.
   * @param {HTMLElement} element - The widget or dropdown item requesting MIDI Learn.
   * @returns {void}
   *
   * @example
   * midiController.openContextMenu(event, widgetElement);
   */
  openContextMenu(event, element) {
    if (!element?.hasAttribute?.('data-automatable') && !element?.hasAttribute?.('data-midi-controllable')) {
      console.warn('[MIDIController] Unknown element type for MIDI Learn context menu.');
      return;
    }
    this.currentlyLearningWidget = element;
    this.currentLearnParam = element.id || element.getAttribute('data-value') || null;
    this.contextMenu.open(event, element);
  }

  _handleLearnModeEnter() {
    this.isMidiLearnModeActive = true;
    this.currentLearnParam = null;
    this.currentLearnWidget = null;
    this.contextMenu.close();
    this._updateIndicatorsVisibility(true);
    // Continuously keep the CH/CC badges + overlays tied to their controls while learning (see
    // _startIndicatorTracking) — panel open/close, async waveform layout, and resize all reflow the
    // controls, and discrete refreshes miss them. Stopped the instant learn mode ends.
    this._startIndicatorTracking();
  }

  _handleLearnModeExit() {
    this.isMidiLearnModeActive = false;
    this.currentLearnParam = null;
    this.currentLearnWidget = null;
    this.contextMenu.close();
    this._updateIndicatorsVisibility(false);
    this._stopIndicatorTracking();
  }

  _handleStartLearn(element, identifier) {
    if (!element || !identifier) {
      return;
    }
    this.currentLearnWidget = element;
    this.currentLearnParam = identifier;
    this.isMidiLearnModeActive = true;
    // 'midi-learn' kind: this hint fires on EVERY control you learn — helpful once, noise on repeat.
    // The user can close it to mute it (toastBridge suppress-by-kind).
    notifications.showToast(`Perform a MIDI action to assign it to '${identifier}'.`, 'info', undefined, 'midi-learn');
  }

}

export const MIDIControllerInstance = MIDI_SUPPORTED ? new MIDIController() : null;
if (typeof window !== 'undefined') {
  window.MIDIControllerInstance = MIDIControllerInstance;
}
