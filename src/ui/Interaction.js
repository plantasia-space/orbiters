// src/Interaction.js

/**
 * @file Interaction.js
 * @description Sets up interactions for dynamic placeholder updates, button groups, handles MIDI registrations, and applies UI color configurations based on track data.
 * @version 2.0.0
 * @license MIT
 * @date 2024-12-07
 */

import {
  initializePanels,
  PANEL_IDS,
} from "../core/PanelManager.js";
import { MIDIControllerInstance } from "../input/midi/MIDIController.js";
import { toggleMidiLearnMode } from "../input/midi/midiLearnToggle.js";
import { KeyboardController } from "../input/KeyboardController.js";
import { updateOrbitColor } from "../world/Scene.js";
import { MIDI_SUPPORTED } from "../config/Constants.js";
import { listUiComponents, UI_COMPONENT_SCOPES } from "../core/stackUtils.js";
import { attachControlTooltip } from "./controlTooltips.js";
import { voiceRegistry } from "../voice/VoiceRegistry.js";
import { byId as scopedById } from "../voice/voiceDom.js";
import notifications from "../core/AppNotifications.js";
import { getT } from "../i18n/index.js";
import { syncCoordinator } from "../sync/SyncCoordinator.js";

const LOOP_EVENT = "ui:loop-toggle";
const PLAYBACK_BUFFERING_EVENT = "orbiters:playback-buffering";
const SPEED_CONTROL_LOCK_EVENT = "orbiters:speed-control-lock";
const SPEED_CONTROL_LOCK_TOAST_STORAGE_KEY = "orbiters:speed-lock-toast:v1";
const SPEED_CONTROL_LOCK_TOAST_MAX_SHOWS = 2;
const SPEED_CONTROL_LOCK_TOAST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The active orbiter / audio engine — the focused voice's AudioEngineAdapter (replaces a
 *  module-level `currentOrbiter` that duplicated the engine the voice already holds). The React
 *  shell's `waveform` surface reads it through resolveEngineSingletons so the PlaybackPanel's
 *  waveform kit can bind to the engine. */
export function getCurrentOrbiter() {
  return voiceRegistry.getActive()?.audioEngine ?? null;
}

let playbackStateUnsubscribe = null;
let loopEventHandlerRegistered = false;
let handleLoopEvent = null;
let speedControlLockHandler = null;
let syncStatusHandler = null;
let syncButtonHandler = null;
let speedControlLockToastShown = false;
const registeredAutomatableElements = new Set();

const MIDI_LAYERED_KEY_PREFIX = "layered:";

const midiComponentLookup = (() => {
  const byRoot = new Map();
  const byUiId = new Map();
  const byId = new Map();
  const components = listUiComponents();

  components.forEach((component) => {
    if (!component || typeof component !== "object") {
      return;
    }
    if (component.id) {
      byId.set(component.id, component);
    }
    if (component.rootParam) {
      byRoot.set(component.rootParam, component);
    }
    if (Array.isArray(component.uiIds)) {
      component.uiIds.forEach((uiId) => {
        if (uiId) {
          byUiId.set(uiId, component);
        }
      });
    }
  });

  return Object.freeze({
    byRoot,
    byUiId,
    byId,
  });
})();

// The toggle moved to input/midi/midiLearnToggle.js so no-voice surfaces (the collection
// studio shell) can bind the M key without this per-voice module. Re-exported for existing
// importers; the window global stays for the React header until its provider wiring lands.
export { toggleMidiLearnMode };

if (typeof window !== "undefined") {
  window.__orbitersToggleMidiLearnMode = toggleMidiLearnMode;
}

function readSpeedControlLockToastState() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(SPEED_CONTROL_LOCK_TOAST_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const count = Math.max(0, Number(parsed?.count) || 0);
    const windowStartedAt = Number(parsed?.windowStartedAt);
    if (!Number.isFinite(windowStartedAt) || windowStartedAt <= 0) return null;
    return { count, windowStartedAt };
  } catch (_) {
    return null;
  }
}

function writeSpeedControlLockToastState(nextState) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(
      SPEED_CONTROL_LOCK_TOAST_STORAGE_KEY,
      JSON.stringify(nextState),
    );
  } catch (_) {
    // Ignore storage write errors; notification behavior still works in-memory.
  }
}

function shouldShowSpeedControlLockToast() {
  const now = Date.now();
  const current = readSpeedControlLockToastState();
  if (!current || now - current.windowStartedAt > SPEED_CONTROL_LOCK_TOAST_WINDOW_MS) {
    writeSpeedControlLockToastState({ count: 0, windowStartedAt: now });
    return true;
  }
  return current.count < SPEED_CONTROL_LOCK_TOAST_MAX_SHOWS;
}

function markSpeedControlLockToastShown() {
  const now = Date.now();
  const current = readSpeedControlLockToastState();
  if (!current || now - current.windowStartedAt > SPEED_CONTROL_LOCK_TOAST_WINDOW_MS) {
    writeSpeedControlLockToastState({ count: 1, windowStartedAt: now });
    return;
  }
  writeSpeedControlLockToastState({
    count: current.count + 1,
    windowStartedAt: current.windowStartedAt,
  });
}

function formatSyncBpmValue(value, fallback = "--") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric.toFixed(2).replace(/\.00$/, "");
}

function updateSyncButtonUi(detail = {}) {
  if (typeof document === "undefined") return;
  const button = document.getElementById("sync-enable");
  const bpmButton = document.getElementById("sync-bpm");
  if (!button) return;

  const enabled = detail?.enabled === true;
  const peerCount = Math.max(0, Number(detail?.peerCount) || 0);
  const isConductor = detail?.isConductor === true;
  const mode = detail?.mode === "PHASE_LOCK" ? "phase lock" : "tempo only";
  const formattedBpm = formatSyncBpmValue(detail?.bpm, "120");

  button.dataset.syncEnabled = enabled ? "true" : "false";
  button.dataset.syncMode = detail?.mode || "TEMPO_ONLY";
  button.dataset.syncPeers = String(peerCount);
  button.dataset.syncRole = isConductor ? "conductor" : "peer";
  button.textContent = enabled && peerCount > 0 ? `SYNC ${peerCount + 1}` : "SYNC";
  button.classList.toggle("is-active", enabled);
  button.setAttribute("aria-pressed", enabled ? "true" : "false");

  const roleLabel = isConductor ? "Conductor" : "Peer";
  const stateLabel = enabled ? "Tempo sync enabled" : "Tempo sync disabled";
  const peerLabel = peerCount === 1 ? "1 peer" : `${peerCount} peers`;
  const label = `${stateLabel} · ${roleLabel} · ${peerLabel} · ${mode}`;
  button.setAttribute("title", label);
  button.setAttribute("aria-label", label);

  if (bpmButton) {
    bpmButton.setAttribute("title", `Shared BPM: ${formattedBpm}`);
    bpmButton.setAttribute("aria-label", `Shared BPM: ${formattedBpm}`);
  }
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function lookupComponentByKey(key) {
  if (!key) return null;
  const normalized = safeDecodeURIComponent(String(key).trim());
  if (!normalized) {
    return null;
  }
  if (midiComponentLookup.byRoot.has(normalized)) {
    return midiComponentLookup.byRoot.get(normalized);
  }
  if (midiComponentLookup.byUiId.has(normalized)) {
    return midiComponentLookup.byUiId.get(normalized);
  }
  if (midiComponentLookup.byId.has(normalized)) {
    return midiComponentLookup.byId.get(normalized);
  }
  return null;
}

function resolveMidiComponentMetadata(element, midiParamId = null) {
  const candidates = [];
  if (midiParamId) {
    candidates.push(midiParamId);
  }
  const explicitComponentId =
    element?.dataset?.midiComponentId || element?.getAttribute?.("data-midi-component-id");
  if (explicitComponentId) {
    candidates.push(explicitComponentId);
  }
  const datasetParam =
    element?.dataset?.midiBaseParamId ||
    element?.dataset?.midiParamId ||
    element?.getAttribute?.("data-midi-param-id") ||
    null;
  if (datasetParam && datasetParam !== midiParamId) {
    candidates.push(datasetParam);
  }
  const rootParam = element?.getAttribute?.("root-param");
  if (rootParam) {
    candidates.push(rootParam);
  }
  const elementId = element?.id || element?.getAttribute?.("data-value");
  if (elementId) {
    candidates.push(elementId);
  }

  for (const raw of candidates) {
    if (!raw) continue;
    const direct = lookupComponentByKey(raw);
    if (direct) {
      return direct;
    }

    const trimmed = String(raw).trim();
    if (!trimmed) continue;

    if (trimmed.startsWith(MIDI_LAYERED_KEY_PREFIX)) {
      const payload = trimmed.slice(MIDI_LAYERED_KEY_PREFIX.length);
      const [componentKey] = payload.split("|");
      const layered = lookupComponentByKey(componentKey);
      if (layered) {
        return layered;
      }
    }

    const pipeIndex = trimmed.indexOf("|");
    if (pipeIndex > 0) {
      const firstSegment = trimmed.slice(0, pipeIndex);
      const segmented = lookupComponentByKey(firstSegment);
      if (segmented) {
        return segmented;
      }
    }
  }

  return null;
}

function getMidiControllerInstance() {
  if (typeof window !== "undefined" && window.MIDIControllerInstance) {
    return window.MIDIControllerInstance;
  }
  try {
    return MIDIControllerInstance;
  } catch (error) {
    return null;
  }
}

export function registerAutomatableElement(element, options = {}) {
  if (!element || typeof element !== "object") {
    return;
  }

  const {
    midiParamId: providedParamId = element.getAttribute?.("data-midi-param-id") || null,
    id = element.id || null,
    automatable = true,
  } = options;

  if (!id) {
    const generatedId = `auto-widget-${registeredAutomatableElements.size + 1}`;
    element.id = generatedId;
  }

  if (automatable) {
    element.setAttribute("data-automatable", "true");
  }

  const existingParamId = element.getAttribute?.("data-midi-param-id") || null;
  const resolvedParamId = providedParamId || existingParamId || null;

  const componentMetadata = resolveMidiComponentMetadata(element, resolvedParamId);
  if (componentMetadata) {
    if (componentMetadata.rootParam) {
      element.dataset.midiRootParam = componentMetadata.rootParam;
    }
    element.dataset.midiComponentId = componentMetadata.id || "";
    element.dataset.midiComponentScope = componentMetadata.scope || "";
    element.dataset.midiSupportsLayers =
      componentMetadata.scope === UI_COMPONENT_SCOPES.DIMENSION ? "true" : "false";
    const preferredKey = componentMetadata.id || componentMetadata.rootParam || resolvedParamId;
    if (preferredKey) {
      if (resolvedParamId && resolvedParamId !== preferredKey) {
        element.dataset.midiLegacyParamId = resolvedParamId;
      }
      element.dataset.midiBaseParamId = preferredKey;
      element.setAttribute("data-midi-param-id", preferredKey);
    }
  } else if (resolvedParamId && !element.dataset.midiBaseParamId) {
    element.dataset.midiBaseParamId = resolvedParamId;
    element.setAttribute("data-midi-param-id", resolvedParamId);
  }

  if (!element.dataset.midiSupportsLayers) {
    element.dataset.midiSupportsLayers = "false";
  }

  if (MIDI_SUPPORTED) {
    element.setAttribute("midilearn", "1");
  }

  registeredAutomatableElements.add(element);

  const controller = getMidiControllerInstance();
  if (MIDI_SUPPORTED && controller?.registerWidget && element.id) {
    try {
      controller.registerWidget(element.id, element);
    } catch (error) {
      console.warn(
        "[registerAutomatableElement] Failed to register widget with MIDI controller:",
        element,
        error,
      );
    }
  }

  if (
    typeof window !== "undefined" &&
    window.MIDIControllerInstance?.ensureOverlayForElement
  ) {
    window.MIDIControllerInstance.ensureOverlayForElement(element);
  }
}

export function unregisterAutomatableElement(element) {
  if (!element) return;
  registeredAutomatableElements.delete(element);
}

if (typeof window !== "undefined") {
  window.registerAutomatableElement = registerAutomatableElement;
}

function formatBufferedSeconds(bufferedAheadMs) {
  const seconds = Number(bufferedAheadMs) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0.0";
  }
  return seconds.toFixed(seconds >= 10 ? 0 : 1);
}

function ensureTransportBufferingIndicator() {
  const transportButton = document.getElementById("transportMenuButton");
  if (!transportButton) return null;
  let indicator = transportButton.querySelector("[data-transport-buffering-indicator]");
  if (!indicator) {
    indicator = document.createElement("span");
    indicator.className = "transport-buffering-indicator";
    indicator.setAttribute("data-transport-buffering-indicator", "true");
    indicator.setAttribute("aria-hidden", "false");
    indicator.setAttribute("aria-live", "polite");
    transportButton.appendChild(indicator);
  }
  const loadingLabel = getT()("loading.short", "Loading");
  indicator.textContent = loadingLabel;
  indicator.setAttribute("aria-label", loadingLabel);
  return indicator;
}

function ensureWaveformBufferingDetails() {
  const container = scopedById("waveform-container");
  if (!container) return null;
  let details = scopedById("waveform-buffering-status");
  if (!details) {
    details = document.createElement("div");
    details.id = "waveform-buffering-status";
    details.className = "waveform-buffering-status";
    details.setAttribute("aria-live", "polite");
    details.setAttribute("aria-atomic", "true");
    container.appendChild(details);
  }
  return details;
}

function updatePlaybackBufferingUi({ isBuffering, bufferedAheadMs = 0 } = {}) {
  const transportButton = document.getElementById("transportMenuButton");
  if (transportButton) {
    const indicator = ensureTransportBufferingIndicator();
    if (indicator) {
      const loadingLabel = getT()("loading.short", "Loading");
      indicator.textContent = loadingLabel;
      indicator.setAttribute("aria-label", loadingLabel);
    }
    transportButton.classList.toggle("is-buffering", Boolean(isBuffering));
  }

  const details = ensureWaveformBufferingDetails();
  if (details) {
    details.classList.toggle("visible", Boolean(isBuffering));
    if (isBuffering) {
      details.textContent = `${getT()("loading.short", "Loading")}...`;
    } else {
      details.textContent = "";
    }
  }
}

/**
 * Sets up interactions for dynamic placeholder updates.
 * Initializes ButtonGroups and Single Buttons, registers MIDI controllers if supported.
 * @memberof CoreModule
 * @function setupInteractions
 * @param {DataManager} dataManager - The shared DataManager instance.
 * @param {Orbiter} orbiter - The shared Orbiter instance.
 * @param {ParameterManager} parameterManager - The user manager instance.
 * @param {WorldModeController} worldModeController - Controller coordinating world modes.
 */

export function setupInteractions(
  dataManager,
  orbiter,
  parameterManager,
  worldModeController = null,
  // De-singletonization: this voice's PanelManager instance (no longer a singleton).
  // Falls back to the focused voice's manager for any legacy single-orbiter caller.
  panelManager = voiceRegistry.getActive()?.panelManager ?? null,
  // De-singletonization: this voice's TransportControl instance (no longer a singleton).
  transportControl = voiceRegistry.getActive()?.transportControl ?? null,
) {
  if (typeof playbackStateUnsubscribe === "function") {
    playbackStateUnsubscribe();
    playbackStateUnsubscribe = null;
  }

  speedControlLockToastShown = false;

  if (typeof document !== "undefined") {
    if (typeof speedControlLockHandler === "function") {
      document.removeEventListener(SPEED_CONTROL_LOCK_EVENT, speedControlLockHandler);
    }

    speedControlLockHandler = (event) => {
      const detail = event?.detail || {};
      const disabled = Boolean(detail?.disabled);
      document.body?.classList?.toggle("speed-control-locked", disabled);
      document.body?.setAttribute?.("data-speed-control-locked", disabled ? "true" : "false");

      if (disabled && !speedControlLockToastShown && shouldShowSpeedControlLockToast()) {
        speedControlLockToastShown = true;
        markSpeedControlLockToastShown();
        notifications.showToast(
          getT()("notifications.speedControlDisabledLongMobile"),
          "info",
          7000,
        );
      }
    };

    document.addEventListener(SPEED_CONTROL_LOCK_EVENT, speedControlLockHandler);
  }

  if (orbiter && typeof orbiter.getSpeedControlState === "function" && typeof document !== "undefined") {
    const currentSpeedState = orbiter.getSpeedControlState() || {};
    document.dispatchEvent(
      new CustomEvent(SPEED_CONTROL_LOCK_EVENT, { detail: currentSpeedState }),
    );
  }

  // Initialize THIS voice's transport control (per-voice instance, not a singleton)
  transportControl?.init(orbiter);

  ensureLoopEventHandler();
  // Initialize THIS voice's default panel state (per-voice instance, not a singleton). The Sensors panel
  // reads `panelManager.parameterManager`, so thread it in. The world controller is no longer
  // threaded here — the PanelManager built no CameraController (the voice session owns that now), which
  // is what used to force a getActive()-during-construction resolution of this voice's world.
  if (panelManager) {
    panelManager.parameterManager = parameterManager;
    initializePanels(panelManager, PANEL_IDS.JAMMING);
  }

  const keyboardController = KeyboardController.initialize({
    orbiter,
    worldModeController,
    panelManager,
  });
  if (typeof window !== "undefined") {
    window.__orbitersKeyboard = keyboardController;
  }

  // Legacy ButtonGroup dropdowns + their MIDI registration, the legacy TopBar, and the hidden-WAC
  // static MIDI registration are gone — the React UI owns all of these now.

  // The orbiter's loop default; the React Transport loop button drives the LOOP_EVENT engine path
  // (ensureLoopEventHandler), so no legacy top-bar loop button to register here.
  if (
    orbiter &&
    typeof orbiter === "object" &&
    typeof orbiter.__desiredLoopMode !== "boolean"
  ) {
    orbiter.__desiredLoopMode = true;
  }

  // Subscribe to the conductor's session-level status surface directly (replaces the
  // `orbiters:sync-status-change` window event). Registered once (sentinel guard), matching the prior
  // never-removed listener lifetime; the conductor singleton outlives the chrome.
  if (!syncStatusHandler) {
    syncStatusHandler = (detail) => {
      updateSyncButtonUi(detail || {});
    };
    syncCoordinator.onStatusChange(syncStatusHandler);
  }
  updateSyncButtonUi({
    enabled: syncCoordinator.isEnabled,
    mode: syncCoordinator.mode,
    bpm: syncCoordinator.bpm,
    trackBpm: syncCoordinator.trackBpm,
    detectedTrackBpm: syncCoordinator.detectedTrackBpm,
    peerCount: syncCoordinator.peerCount,
    isConductor: syncCoordinator.isConductor,
  });

  if (typeof document !== "undefined" && !syncButtonHandler) {
    const syncButton = document.getElementById("sync-enable");
    if (syncButton) {
      syncButtonHandler = (event) => {
        event.preventDefault();
        if (syncCoordinator.isEnabled) {
          syncCoordinator.disable();
        } else {
          syncCoordinator.enable();
        }
      };
      syncButton.addEventListener("click", syncButtonHandler);
    }
  }

  // The tempo + grid-marker controls (BPM display, track BPM, GRID pick) are React-owned now
  // (PlaybackPanel via the engine surface). Their owner-only persistence is wired through
  // the commit seam in `src/sync/trackSettingsCommit.js`; the legacy
  // DOM handlers that drove the stripped #sync-bpm / #audio-track-bpm / #grid-marker-pick elements
  // (and the wrap-grid-change mirror) are gone.

  if (orbiter && typeof orbiter === "object") {
    if (typeof orbiter.addPlaybackStateListener === "function") {
      const onPlaybackState = (payload = {}) => {
        const bufferingState =
          typeof orbiter.getBufferingState === "function"
            ? orbiter.getBufferingState() || {}
            : {};
        const terminalState = payload?.state === "stopped" || payload?.state === "paused";
        const isBuffering =
          !terminalState &&
          (payload?.state === "buffering" || Boolean(bufferingState?.isBuffering));
        const uiPayload = {
          isBuffering,
          bufferedAheadMs: Number(bufferingState?.bufferedAheadMs) || 0,
          readyState: Number(bufferingState?.readyState) || 0,
          source: payload?.source || bufferingState?.source || "playback-state",
          timestamp:
            Number(payload?.timestamp) ||
            Number(bufferingState?.timestamp) ||
            (typeof performance !== "undefined" ? performance.now() : Date.now()),
        };
        updatePlaybackBufferingUi(uiPayload);
        if (typeof document !== "undefined") {
          document.dispatchEvent(
            new CustomEvent(PLAYBACK_BUFFERING_EVENT, {
              detail: uiPayload,
            }),
          );
        }
      };
      playbackStateUnsubscribe = orbiter.addPlaybackStateListener(onPlaybackState);
      onPlaybackState({ state: orbiter.getPlaybackState?.() || "stopped", source: "init" });
    } else {
      updatePlaybackBufferingUi({ isBuffering: false, bufferedAheadMs: 0 });
    }
    // The React PlaybackPanel owns the waveform lifecycle (it renders the kit waveform panel bound
    // to the engine's waveformData surface), so there's no legacy auto-construct to subscribe here.
  }
}

function ensureLoopEventHandler() {
  if (loopEventHandlerRegistered || typeof document === "undefined") {
    return;
  }

  handleLoopEvent = (event) => {
    const detail = event?.detail || {};
    const { enabled, source } = detail;

    if (typeof enabled !== "boolean") {
      return;
    }

    let resolvedState = enabled;

    const orbiter = getCurrentOrbiter();
    if (
      source !== "waveform" &&
      orbiter &&
      typeof orbiter === "object"
    ) {
      // The React loop button drives the engine loop directly (waveform.setLoopActive); this legacy
      // LOOP_EVENT path only records the desired loop mode so the default-loop intent stays
      // in sync (the engine reads `__desiredLoopMode` on the next play).
      orbiter.__desiredLoopMode = enabled;
      resolvedState = enabled;
    }
    // (The legacy top-bar loop button is gone; React's loop button reads state via the waveform
    // surface, so there's no extra UI to sync here.)
  };

  document.addEventListener(LOOP_EVENT, handleLoopEvent);
  loopEventHandlerRegistered = true;
}

/**
 * Applies color configurations to the document based on track data.
 * Updates CSS variables and redraws UI components to reflect new colors.
 * @memberof CoreModule
 * @function applyColorsFromTrackData
 * @param {object} trackData - The track data containing color information.
 * @returns {void}
 */
export function applyColorsFromTrackData(trackData, themeRoot = null) {
  if (!trackData || !trackData.orbiter || !trackData.orbiter.orbiterColors) {
    console.warn("[COLORS] No color data available in track data.");
    return;
  }

  const { color1, color2, color3 } = trackData.orbiter.orbiterColors;

  // Scope the orbiter's color vars to this voice's theme root (its tile) when provided,
  // else documentElement (single-orbiter, byte-identical). Without this, every multi tile's boot
  // would write the global vars and the last voice's colors would win across all tiles.
  const root = themeRoot || document.documentElement;

  // Update CSS variables for colors
  if (color1) {
    root.style.setProperty("--color1", color1);
  }

  if (color2) {
    root.style.setProperty("--color2", color2);
  }

  // Color C — the saved selected/active "success" highlight. Read on PLAY too (not just
  // edit) so the play UI's `--success` alias (orbitersUI.css) follows the orbiter's choice.
  if (color3) {
    root.style.setProperty("--color3", color3);
  }

  // sync 3D orbit color from CSS — oscilloscope is per-voice; drive the active one.
  updateOrbitColor(voiceRegistry.getActive()?.oscilloscope);

  if (typeof document !== "undefined") {
    try {
      const event = new CustomEvent("orbiters:design-updated", {
        detail: { colors: { color1, color2, color3 } },
      });
      document.dispatchEvent(event);
    } catch (_) {}
  }
}

