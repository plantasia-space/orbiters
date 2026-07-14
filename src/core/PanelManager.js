/**
 * @file src/core/PanelManager.js
 * @description Orchestrates panel activation logic for the main interaction modes (MIDI, Sensors, etc.)
 * and coordinates sensor/MIDI/webRTC side effects when panels change.
 *
 * De-singletonization: `PanelManager` is now a PER-VOICE instance, not a module
 * singleton. Each orbiter voice owns its own panel state (`currentPanel`) and broadcasts panel changes
 * on its OWN `eventBus` (the per-voice EventTarget), so opening a panel in one tile does not move every
 * other tile. Single-orbiter constructs exactly ONE instance whose `eventBus` defaults to `window` and
 * whose `root` defaults to `document`, so its behaviour is byte-identical to the old singleton.
 *
 * Single-focus surfaces (MIDI, CosmicLFO) are the ACTIVE-VOICE tier: they read
 * `voiceRegistry.getActive().panelManager` and listen to `subscribeToAnyPanelChange` (a realm-level
 * notification fired by every instance) instead of importing a singleton.
 */
import { SensorController } from '../input/SensorsController.js';
import notifications from './AppNotifications.js';
import { MIDIControllerInstance } from '../input/midi/MIDIController.js';
import { INTERNAL_SENSORS_USABLE, EXTERNAL_SENSORS_USABLE, setExternalSensorsUsable, MIDI_SUPPORTED } from '../config/Constants.js';
import { WebRTCManager } from '../api/WebRTCManager.js';
import { getT } from '../i18n/index.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';

const PANEL_IDS = {
    JAMMING: 'JAMMING_PANEL',
    MIDI: 'MIDI_PANEL',
    SENSORS: 'SENSORS_PANEL',
    COSMIC_LFO: 'COSMIC_LFO_PANEL',
    PLAYBACK: 'PLAYBACK_PANEL'
};

const PANEL_CHANGE_EVENT = 'orbiters:panel-change';

const PANEL_LABEL_KEYS = {
    [PANEL_IDS.JAMMING]: 'panels.jamming',
    [PANEL_IDS.MIDI]: 'panels.midi',
    [PANEL_IDS.SENSORS]: 'panels.sensors',
    [PANEL_IDS.COSMIC_LFO]: 'panels.cosmicLfo',
    [PANEL_IDS.PLAYBACK]: 'panels.playback'
};

let t = getT();

function getPanelLabel(panelId) {
    const key = PANEL_LABEL_KEYS[panelId];
    if (!key) {
        return panelId?.toLowerCase?.().replace('_', ' ') || '';
    }
    return t(key);
}

/**
 * Realm-level "a panel changed somewhere" notification, for single-focus surfaces (MIDI) that need to
 * refresh on the FOCUSED voice's panel changes without owning a per-voice subscription. This is the
 * active-voice tier — NOT panel state (which is per-voice on each instance below).
 */
const anyPanelChangeObservers = new Set();
export function subscribeToAnyPanelChange(cb) {
    if (typeof cb !== 'function') return () => {};
    anyPanelChangeObservers.add(cb);
    return () => anyPanelChangeObservers.delete(cb);
}
function notifyAnyPanelChange(panelId) {
    anyPanelChangeObservers.forEach((cb) => {
        try { cb(panelId); } catch (error) { console.error('[PanelManager] any-panel-change observer error:', error); }
    });
}

/** The panel manager of the focused voice (active-voice tier), or null. */
function activePanelManager() {
    return voiceRegistry.getActive()?.panelManager ?? null;
}

/**
 * Handles registering panels, switching between them, and notifying subscribers when this voice's
 * active UI mode changes. One instance PER VOICE.
 */
class PanelManager {
    /**
     * @param {object} [opts]
     * @param {EventTarget|Window} [opts.eventBus] where panel-change is dispatched (per-voice EventTarget
     *   for a multi tile; defaults to `window` → single-orbiter byte-identical).
     * @param {Document|HTMLElement} [opts.root] DOM scope for this voice's chrome (defaults to `document`).
     * @param {string} [opts.voiceId] the realm-registry id of this voice, so its CameraController can gate
     *   pointer input on focus. null/undefined = single-orbiter (always the active voice).
     */
    constructor({ eventBus, root, voiceId } = {}) {
        this.voiceId = voiceId ?? null;
        this.currentPanel = null;
        this.subscribers = [];
        this.panels = {};
        this.sensorControllerInstance = null;
        // Set by Interaction.js (the Sensors panel reads it to build its SensorController).
        this.parameterManager = null;
        this.eventBus = eventBus ?? (typeof window !== 'undefined' ? window : null);
        this.root = root ?? (typeof document !== 'undefined' ? document : null);
        registerDefaultPanels(this);
    }

    registerPanel(id, { onEnter, onExit }) {
        this.panels[id] = { onEnter, onExit };
    }

    activatePanel(newPanel) {
        if (this.currentPanel === newPanel) {
            return;
        }

        const oldPanel = this.currentPanel;
        if (this.panels[oldPanel]?.onExit) {
            try {
                this.panels[oldPanel].onExit();
            } catch (error) {
                console.error(`[PanelManager] Error exiting panel "${oldPanel}":`, error);
            }
        }

        this.currentPanel = newPanel;

        // Gate this voice's camera drive on the new panel (jamming = on, else off).
        this._applyCameraDriveFilter(newPanel);

        const titleElement = document.querySelector('.responsive-title');
        if (titleElement) {
            titleElement.textContent = getPanelLabel(newPanel);
        }

        if (this.panels[newPanel]?.onEnter) {
            try {
                this.panels[newPanel].onEnter();
            } catch (error) {
                console.error(`[PanelManager] Error entering panel "${newPanel}":`, error);
            }
        } else {
            console.warn(`[PanelManager] No onEnter handler for panel: ${newPanel}`);
        }

        this.subscribers.forEach((cb) => {
            try {
                cb(newPanel);
            } catch (error) {
                console.error('[PanelManager] Subscriber error:', error);
            }
        });

        // Per-voice: React's `panels` facade subscribes to THIS voice's eventBus (window for single-orbiter).
        if (this.eventBus?.dispatchEvent) {
            this.eventBus.dispatchEvent(new CustomEvent(PANEL_CHANGE_EVENT, {
                detail: { panelId: newPanel, previousPanel: oldPanel }
            }));
        }
        // Active-voice surfaces (MIDI) refresh on any voice's panel change.
        notifyAnyPanelChange(newPanel);

        // Re-evaluate row visibility on every panel change
        evaluateJamVisibility(true);
        // Ensure toggles follow the new panel's defaults
        setToggleVisibilityRespectingActivity(getPanelVisibilityMode(newPanel));
    }

    subscribe(callback) {
        this.subscribers.push(callback);
    }

    getActivePanel() {
        return this.currentPanel;
    }

    // Panel state is a drive FILTER over the voice's persistent CameraController (created by the
    // voice session at boot, disposed with the voice), NOT a create/destroy trigger. Camera drag/zoom/
    // recenter act only in jamming mode; focus-on-pointerdown stays live in every panel (the controller
    // owns that). `this.voiceId` is always the voice's registry id, so no getActive() lookup.
    _applyCameraDriveFilter(panel) {
        const cam = voiceRegistry.get(this.voiceId)?.cameraController;
        cam?.enablePointerParamDrive(panel === PANEL_IDS.JAMMING);
    }
}

/**
 * Register the standard panels onto a PanelManager instance. Called from the constructor so every
 * per-voice instance carries the same handler set (the handlers close over `pm`, not a singleton).
 */
function registerDefaultPanels(pm) {
    pm.registerPanel(PANEL_IDS.JAMMING, {
        onEnter: async () => {
            document
                .querySelectorAll('[data-group$="-waveform-dropdown"], [data-group$="-exo-lfo-dropdown"]')
                .forEach((el) => {
                    el.style.display = 'none';
                });

            document.querySelectorAll('[id^="xCosmic"], [id^="yCosmic"], [id^="zCosmic"]').forEach((el) => {
                el.style.display = 'none';
            });

            document.querySelectorAll('webaudio-monitor[id^="cosmic-lfo-"], .cosmic-amplitude-control, .cosmic-manual-frequency').forEach((el) => {
                el.style.display = 'none';
            });

            evaluateJamVisibility(true);
            setToggleVisibilityRespectingActivity(getPanelVisibilityMode(PANEL_IDS.JAMMING));
        }
        // No onExit — the camera controller lives with the voice, not the jamming panel.
        // `activatePanel` toggles its drive filter on every panel change (see `_applyCameraDriveFilter`).
    });

    pm.registerPanel(PANEL_IDS.MIDI, {
        onEnter: async () => {
            try {
                if (MIDI_SUPPORTED && MIDIControllerInstance) {
                    if (!MIDIControllerInstance.isMIDIActivated) {
                        await MIDIControllerInstance.activateMIDI();
                    }
                    await MIDIControllerInstance.loadPersistedMappings();
                } else {
                    const tt = getT();
                    notifications.showToast(tt('notifications.midiActivationError'), 'error');
                }
            } catch (error) {
                console.error('[PanelManager] Error entering MIDI panel:', error);
                const tt = getT();
                notifications.showToast(tt('notifications.midiActivationError'), 'error');
            }
        },
        onExit: () => {}
    });

    pm.registerPanel(PANEL_IDS.SENSORS, {
        onEnter: async () => {
            document.querySelectorAll('.xyz-sensors-toggle').forEach((button) => {
                button.style.display = 'block';
            });

            if (!pm.parameterManager) {
                const tt = getT();
                notifications.showToast(tt('notifications.sensorsUnavailable'), 'error');
                return;
            }

            try {
                const sensorController = SensorController.getInstance(pm.parameterManager);
                const webRTCManager = WebRTCManager.getInstance((data) => {
                    sensorController.setExternalSensorData(data);
                });

                if (INTERNAL_SENSORS_USABLE && SensorController.isSupported()) {
                    const permissionGranted = await sensorController.requestPermission();
                    if (permissionGranted) {
                        await sensorController.activateSensors();
                        sensorController.switchSensorSource(false);
                    } else {
                        const tt = getT();
                        notifications.showToast(tt('notifications.sensorPermissionDenied'), 'error');
                    }
                } else if (EXTERNAL_SENSORS_USABLE) {
                    try {
                        await webRTCManager.initialize();
                        setExternalSensorsUsable(true);
                        const tt = getT();
                        notifications.showToast(tt('notifications.externalSensorsActivated'), 'success');
                    } catch (error) {
                        console.error('[PanelManager] Failed to initialize WebRTCManager.', error);
                        const tt = getT();
                        notifications.showToast(tt('notifications.externalSensorsFailed'), 'error');
                    }
                } else {
                    const tt = getT();
                    notifications.showToast(tt('notifications.noSensorsAvailable'), 'warning');
                }

                pm.sensorControllerInstance = sensorController;

                setToggleVisibilityRespectingActivity(getPanelVisibilityMode(PANEL_IDS.SENSORS));
            } catch (error) {
                console.error('[PanelManager] Error during sensor activation:', error);
                const tt = getT();
                notifications.showToast(tt('notifications.sensorsUnavailable'), 'error');
            }
        },
        onExit: () => {
            const sc = pm.sensorControllerInstance;
            const anyAxisActive =
                ['toggleSensorX', 'toggleSensorY', 'toggleSensorZ'].some(id => isSwitchActive(document.getElementById(id))) ||
                (sc && (sc.isSensorActive || Object.values(sc.activeAxes || {}).some(Boolean)));

            if (sc && !anyAxisActive) {
                try {
                   // sc.deactivateSensors();
                } catch (error) {
                    console.error('[PanelManager] Error deactivating sensors:', error);
                }
                pm.sensorControllerInstance = null;
            }

            setExternalSensorsUsable(!!anyAxisActive);
            evaluateJamVisibility(true);
        }
    });

    pm.registerPanel(PANEL_IDS.COSMIC_LFO, {
        onEnter: () => {
            const cosmicLFOManager = voiceRegistry.getActive()?.cosmicLFOManager;
            if (cosmicLFOManager) {
                cosmicLFOManager.x.enterMode();
                cosmicLFOManager.y.enterMode();
                cosmicLFOManager.z.enterMode();
            }

            document.querySelectorAll('.xyz-cosmic-lfo').forEach((button) => {
                button.style.display = 'block';
            });
            updateToggleDatasets();
            setToggleVisibilityRespectingActivity(getPanelVisibilityMode(PANEL_IDS.COSMIC_LFO));
        },
        onExit: () => {
            const cosmicLFOManager = voiceRegistry.getActive()?.cosmicLFOManager;
            if (cosmicLFOManager) {
                cosmicLFOManager.x.exitMode();
                cosmicLFOManager.y.exitMode();
                cosmicLFOManager.z.exitMode();
            }
        }
    });

    pm.registerPanel(PANEL_IDS.PLAYBACK, {
        onEnter: () => {
            setToggleVisibilityRespectingActivity(getPanelVisibilityMode(PANEL_IDS.PLAYBACK));
        },
        onExit: () => {}
    });
}

if (typeof window !== 'undefined') {
    window.addEventListener('languageChanged', () => {
        t = getT();
        const activePanel = activePanelManager()?.getActivePanel?.();
        if (!activePanel) return;
        const titleElement = document.querySelector('.responsive-title');
        if (titleElement) {
            titleElement.textContent = getPanelLabel(activePanel);
        }
    });
}

/**
 * Initialize the default panel state for a voice's PanelManager. Takes the instance explicitly (no
 * singleton): registers the (one, global, legacy) toggle listeners and activates the default panel for
 * THIS voice. (`panelManager.parameterManager` is set by the caller for the Sensors panel.)
 */
function initializePanels(panelManager, defaultPanel = PANEL_IDS.JAMMING) {
    setupToggleListeners();
    updateToggleDatasets();
    evaluateJamVisibility(true);
    setToggleVisibilityRespectingActivity(getPanelVisibilityMode(defaultPanel));
    panelManager.activatePanel(defaultPanel);
}

export { PanelManager, PANEL_IDS, initializePanels };

// -----------------------------
// Helpers (operate on the ONE global legacy-chrome DOM, reflecting the FOCUSED voice's panel)
// -----------------------------

function isSwitchActive(el) {
    if (!el) return false;
    if (typeof el.state !== 'undefined') {
        const value = Number(el.state);
        if (!Number.isNaN(value)) return value === 1;
    }
    if (typeof el.value !== 'undefined') {
        const value = Number(el.value);
        if (!Number.isNaN(value)) return value === 1;
    }
    const attr = el.getAttribute?.('state');
    if (attr !== null) {
        const value = Number(attr);
        if (!Number.isNaN(value)) return value === 1;
    }
    if (typeof el.checked === 'boolean') {
        return el.checked;
    }
    return false;
}

// Detects runtime sensor activity (even if toggles are hidden)
function anySensorActive() {
    const toggleOn = ['toggleSensorX', 'toggleSensorY', 'toggleSensorZ']
        .some(id => isSwitchActive(document.getElementById(id)));
    if (toggleOn) return true;

    const sc = activePanelManager()?.sensorControllerInstance;
    return !!(sc && (sc.isSensorActive || Object.values(sc.activeAxes || {}).some(Boolean)));
}

// Detects runtime cosmic LFO activity (manager or toggles)
function anyCosmicActive() {
    const toggleOn = ['xCosmicLFO', 'yCosmicLFO', 'zCosmicLFO']
        .some(id => isSwitchActive(document.getElementById(id)));
    if (toggleOn) return true;

    const mgr = voiceRegistry.getActive()?.cosmicLFOManager;
    return !!(mgr && ((mgr.x && mgr.x.isActive) || (mgr.y && mgr.y.isActive) || (mgr.z && mgr.z.isActive)));
}

function evaluateJamVisibility(force = false) {
    const sensorsGroup = document.querySelector('.xyz-sensors-row');
    const cosmicGroup = document.querySelector('.xyz-cosmic-row');

    if (sensorsGroup) {
        sensorsGroup.style.display = anySensorActive() ? '' : 'none';
    }

    if (cosmicGroup) {
        cosmicGroup.style.display = anyCosmicActive() ? '' : 'none';
    }
}

// Map each panel to its default toggle visibility behavior
function getPanelVisibilityMode(panelId) {
    switch (panelId) {
        case PANEL_IDS.SENSORS:
            return { sensors: 'show', cosmic: 'auto' };
        case PANEL_IDS.COSMIC_LFO:
            return { sensors: 'auto', cosmic: 'show' };
        case PANEL_IDS.PLAYBACK:
            return { sensors: 'hide', cosmic: 'hide' };
        case PANEL_IDS.JAMMING:
        default:
            return { sensors: 'auto', cosmic: 'auto' };
    }
}

// Honor per-panel mode plus activity. mode: 'show' | 'hide' | 'auto' (auto = visible only if active)
function setToggleVisibilityRespectingActivity(mode = { sensors: 'auto', cosmic: 'auto' }) {
    const sensorsActive = anySensorActive();
    const cosmicActive = anyCosmicActive();

    const sensorsDisplay =
        mode.sensors === 'show' ? 'block' :
        mode.sensors === 'hide' ? 'none' :
        sensorsActive ? 'block' : 'none';

    const cosmicDisplay =
        mode.cosmic === 'show' ? 'block' :
        mode.cosmic === 'hide' ? 'none' :
        cosmicActive ? 'block' : 'none';

    document.querySelectorAll('.xyz-sensors-toggle').forEach((el) => {
        el.style.display = sensorsDisplay;
    });
    document.querySelectorAll('.xyz-cosmic-lfo').forEach((el) => {
        el.style.display = cosmicDisplay;
    });

    const activePanel = activePanelManager()?.getActivePanel?.();
    const showAmplitude = activePanel === PANEL_IDS.COSMIC_LFO;
    document.querySelectorAll('.cosmic-amplitude-control').forEach((el) => {
        if (showAmplitude) {
            el.classList.add('is-visible');
            el.style.display = 'flex';
        } else {
            el.classList.remove('is-visible');
            el.style.display = 'none';
        }
    });

    const showMultipliers = activePanel === PANEL_IDS.COSMIC_LFO;
    document.querySelectorAll('.freq-multiplier-btn-lfo').forEach((el) => {
        if (showMultipliers) {
            el.classList.add('is-visible');
            el.style.display = 'flex';
        } else {
            el.classList.remove('is-visible');
            el.style.display = 'none';
        }
    });

    const showManual = activePanel === PANEL_IDS.COSMIC_LFO;
    document.querySelectorAll('.cosmic-manual-frequency').forEach((el) => {
        const wantsVisible = el.getAttribute('data-visible') === 'true';
        el.style.display = showManual && wantsVisible ? 'flex' : 'none';
    });

    if (typeof window !== 'undefined' && window.MIDIControllerInstance?.refreshOverlays) {
        window.MIDIControllerInstance.refreshOverlays();
    }
}

let toggleListenersRegistered = false;
function setupToggleListeners() {
    if (toggleListenersRegistered) return;
    toggleListenersRegistered = true;

    const switches = document.querySelectorAll('.xyz-sensors-toggle, .xyz-cosmic-lfo');
    switches.forEach((switchEl) => {
        const handler = () => {
            updateSingleToggleDataset(switchEl);
            evaluateJamVisibility(true);
            setToggleVisibilityRespectingActivity(getPanelVisibilityMode(activePanelManager()?.getActivePanel?.()));
        };
        updateSingleToggleDataset(switchEl);
        switchEl.addEventListener('change', handler);
        switchEl.addEventListener('input', handler);
    });
}

function updateToggleDatasets() {
    document.querySelectorAll('.xyz-sensors-toggle, .xyz-cosmic-lfo').forEach(updateSingleToggleDataset);
}

function updateSingleToggleDataset(el) {
    el.dataset.isActive = isSwitchActive(el) ? '1' : '0';
}
