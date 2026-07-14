/**
 * @file KeyboardController.js
 * @description Centralized keyboard handler that wires transport, dimension, and panel shortcuts.
 * Accounts for iframe focus, prevents repeated key spam, and keeps shortcuts layered for future expansion.
 */

import { PANEL_IDS } from '../core/PanelManager.js';
import { toggleMidiLearnMode } from './midi/midiLearnToggle.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { getCameraFocus, setCameraFocus } from '../world/cameraFocus.js';

const PANEL_SHORTCUTS = Object.freeze({
    KeyJ: PANEL_IDS.JAMMING,
    KeyP: PANEL_IDS.PLAYBACK,
    KeyC: PANEL_IDS.COSMIC_LFO,
    KeyS: PANEL_IDS.SENSORS,
});

const DIMENSION_KEY_CODES = ['Digit1', 'Digit2', 'Digit3'];

function isTextInputTarget(target) {
    if (!target || typeof target !== 'object') {
        return false;
    }
    if (target.isContentEditable) return true;
    if (typeof target.getAttribute === 'function') {
        const role = target.getAttribute('role');
        if (role === 'textbox' || role === 'combobox') {
            return true;
        }
    }
    const tagName = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function normalizeDimensionId(definition) {
    if (!definition) return null;
    return (
        definition.id ||
        definition.dimensionId ||
        definition.dimension?.id ||
        definition?.label ||
        null
    );
}

function getKeyboardFocusTargets() {
    // Multi-selection returns every selected voice; single-focus returns just the active one. So a
    // shortcut gangs across a shift-selection and acts on the one focused voice otherwise.
    return voiceRegistry.getFocusTargets();
}

export class KeyboardController {
    static #instance = null;

    /**
     * Initializes (or updates) the singleton instance.
     * @param {object} deps
     * @param {object} deps.orbiter - Current orbiter instance for transport actions.
     * @param {object} deps.worldModeController - Controller that exposes dimension helpers.
     * @param {object} deps.panelManager - Panel manager singleton for panel switching.
     * @returns {KeyboardController}
     */
    static initialize(deps = {}) {
        if (KeyboardController.#instance) {
            KeyboardController.#instance.updateDependencies(deps);
            return KeyboardController.#instance;
        }
        KeyboardController.#instance = new KeyboardController(deps);
        return KeyboardController.#instance;
    }

    constructor({ orbiter = null, worldModeController = null, panelManager = null } = {}) {
        if (KeyboardController.#instance) {
            throw new Error('KeyboardController is a singleton. Use KeyboardController.initialize().');
        }
        this.orbiter = orbiter;
        this.worldModeController = worldModeController;
        this.panelManager = panelManager;

        this.keyHandlers = new Map();
        this.activeKeys = new Set();
        this.isFocused = typeof document === 'undefined' ? false : document.hasFocus();
        this.lastFocusEventTs = 0;

        this._boundKeyDown = this.handleKeyDown.bind(this);
        this._boundKeyUp = this.handleKeyUp.bind(this);
        this._boundMarkFocused = this.markFocused.bind(this);
        this._boundHandleBlur = this.handleBlur.bind(this);
        this._boundHandleFocus = this.handleFocus.bind(this);
        this._boundHandleVisibility = this.handleVisibilityChange.bind(this);

        this.attachListeners();
        this.registerDefaultLayers();
    }

    updateDependencies({ orbiter = null, worldModeController = null, panelManager = null } = {}) {
        if (orbiter) this.orbiter = orbiter;
        if (worldModeController) this.worldModeController = worldModeController;
        if (panelManager) this.panelManager = panelManager;
    }

    attachListeners() {
        if (typeof document === 'undefined' || typeof window === 'undefined') {
            return;
        }
        document.addEventListener('keydown', this._boundKeyDown, true);
        document.addEventListener('keyup', this._boundKeyUp, true);
        document.addEventListener('pointerdown', this._boundMarkFocused, true);
        document.addEventListener('pointerup', this._boundMarkFocused, true);
        document.addEventListener('mousedown', this._boundMarkFocused, true);
        document.addEventListener('touchstart', this._boundMarkFocused, { passive: true, capture: true });
        window.addEventListener('blur', this._boundHandleBlur, true);
        window.addEventListener('focus', this._boundHandleFocus, true);
        document.addEventListener('visibilitychange', this._boundHandleVisibility, true);
    }

    detachListeners() {
        if (typeof document === 'undefined' || typeof window === 'undefined') {
            return;
        }
        document.removeEventListener('keydown', this._boundKeyDown, true);
        document.removeEventListener('keyup', this._boundKeyUp, true);
        document.removeEventListener('pointerdown', this._boundMarkFocused, true);
        document.removeEventListener('pointerup', this._boundMarkFocused, true);
        document.removeEventListener('mousedown', this._boundMarkFocused, true);
        document.removeEventListener('touchstart', this._boundMarkFocused, true);
        window.removeEventListener('blur', this._boundHandleBlur, true);
        window.removeEventListener('focus', this._boundHandleFocus, true);
        document.removeEventListener('visibilitychange', this._boundHandleVisibility, true);
    }

    registerDefaultLayers() {
        // Transport (Space)
        this.registerKeyHandler('Space', (event) => {
            const isPlaying = this.isPlaybackRunning();
            if (event?.shiftKey) {
                if (isPlaying) {
                    this.togglePlayback();
                    return;
                }
                this.playFromBeginning();
                return;
            }
            if (!this.orbiter) return;
            this.togglePlayback();
        });

        // Dimensions (1,2,3)
        DIMENSION_KEY_CODES.forEach((code, index) => {
            this.registerKeyHandler(
                code,
                () => this.setActiveDimensionByIndex(index),
                { requirePlainModifiers: true },
            );
        });

        // Panels (J, P, C, S)
        Object.entries(PANEL_SHORTCUTS).forEach(([code, panelId]) => {
            this.registerKeyHandler(
                code,
                () => this.activatePanel(panelId),
                { requirePlainModifiers: true, throttleMs: 150 },
            );
        });

        this.registerKeyHandler(
            'KeyM',
            () => this.toggleMidiLearnMode(),
            { requirePlainModifiers: true, throttleMs: 300 },
        );

        // Q — what the camera orbits: the world, or its moon. The same choice the button in the
        // bottom-left corner makes; both write the one store the scene reads every frame.
        this.registerKeyHandler(
            'KeyQ',
            () => this.toggleCameraFocus(),
            { requirePlainModifiers: true, throttleMs: 150 },
        );
    }

    /**
     * Send the focused voices' cameras to the other body.
     *
     * Every other shortcut here SETS a thing (this panel, this dimension), so ganging one across a
     * shift-selection needs no thought — the same value lands on each. This one TOGGLES, and a
     * toggle applied voice by voice would flip each about its own state: a selection that started
     * disagreed would stay disagreed forever, and Q would never be able to settle it. So the
     * selection is read ONCE, from the voice the key was aimed at, and the answer is written to all
     * of them. One key, one answer — press it again and they cross back together.
     *
     * The voice it is aimed at is the ACTIVE one, which is not the same as the first of the
     * selection: shift-clicking a second orbiter makes THAT one active while the selection keeps
     * its insertion order, so the first id is the voice you selected first, not the one you last
     * touched. Reading the first would toggle about a camera the user is not looking at, and the
     * orbiter under their hand would appear to ignore the key.
     */
    toggleCameraFocus() {
        const targetIds = getKeyboardFocusTargets();
        const activeId = voiceRegistry.getActive()?.id ?? null;
        const ids = targetIds.length ? targetIds : [activeId].filter(Boolean);
        if (!ids.length) return;

        const aimedAt = activeId && ids.includes(activeId) ? activeId : ids[0];
        const next = getCameraFocus(aimedAt) === 'moon' ? 'world' : 'moon';
        ids.forEach((id) => setCameraFocus(id, next));
    }

    registerKeyHandler(code, handler, options = {}) {
        if (!code || typeof handler !== 'function') {
            return;
        }
        this.keyHandlers.set(code, {
            handler,
            options: {
                requirePlainModifiers: Boolean(options.requirePlainModifiers),
                throttleMs: typeof options.throttleMs === 'number' ? Math.max(options.throttleMs, 0) : 0,
                lastInvokedAt: 0,
            },
        });
    }

    shouldHandleEvent(event) {
        if (!event || event.defaultPrevented) return false;
        if (!this.isFocused) return false;
        if (isTextInputTarget(event.target)) return false;
        return true;
    }

    handleKeyDown(event) {
        const { code } = event;
        if (!code || !this.shouldHandleEvent(event)) return;
        const entry = this.keyHandlers.get(code);
        if (!entry) return;
        if (event.repeat && this.activeKeys.has(code)) {
            return;
        }
        if (entry.options.requirePlainModifiers && (event.altKey || event.ctrlKey || event.metaKey)) {
            return;
        }
        const now = performance.now();
        if (entry.options.throttleMs && now - entry.options.lastInvokedAt < entry.options.throttleMs) {
            return;
        }

        const result = entry.handler(event);
        entry.options.lastInvokedAt = now;
        this.activeKeys.add(code);
        if (result !== false) {
            event.preventDefault();
            event.stopPropagation();
        }
    }

    handleKeyUp(event) {
        const { code } = event;
        if (!code) return;
        this.activeKeys.delete(code);
    }

    markFocused() {
        this.isFocused = true;
        this.lastFocusEventTs = performance.now();
    }

    handleBlur() {
        this.isFocused = false;
    }

    handleFocus() {
        this.isFocused = true;
    }

    handleVisibilityChange() {
        if (typeof document === 'undefined') return;
        this.isFocused = document.visibilityState === 'visible' && document.hasFocus();
    }

    togglePlayback() {
        const targetIds = getKeyboardFocusTargets();
        let didToggle = false;
        for (const id of targetIds) {
            const transport = voiceRegistry.get(id)?.transportControl ?? null;
            if (transport?.toggle) {
                transport.toggle();
                didToggle = true;
            }
        }
        if (didToggle) {
            return;
        }

        // Fallback to direct orbiter control
        const orbiter = this.orbiter;
        if (!orbiter) return;
        const isPlaying = this.isPlaybackRunning();
        if (isPlaying) {
            if (typeof orbiter.pause === 'function') {
                orbiter.pause();
            } else if (typeof orbiter.stop === 'function') {
                orbiter.stop();
            }
            return;
        }
        if (typeof orbiter.play === 'function') {
            orbiter.play();
        }
    }

    playFromBeginning() {
        const orbiter = this.orbiter;
        const globalEngine = voiceRegistry.getActive()?.audioEngine ?? null;
        if (!orbiter && !globalEngine) {
            return;
        }

        const triggerPlay = () => {
            if (typeof orbiter?.play === 'function') {
                orbiter.play();
                return;
            }
            if (typeof globalEngine?.play === 'function') {
                globalEngine.play();
            }
        };

        let seekPromise = this._seekTransportToStart(orbiter ?? globalEngine ?? null);
        if (!seekPromise && globalEngine && orbiter !== globalEngine) {
            seekPromise = this._seekTransportToStart(globalEngine);
        }

        if (seekPromise && typeof seekPromise.then === 'function') {
            seekPromise
                .catch((error) => {
                    console.warn('[KeyboardController] Failed to seek before restart', error);
                })
                .finally(triggerPlay);
            return;
        }

        triggerPlay();
    }

    _seekTransportToStart(target) {
        if (!target) {
            return null;
        }
        try {
            if (typeof target.seekToMilliseconds === 'function') {
                return target.seekToMilliseconds(0);
            }
            if (typeof target.seek === 'function') {
                return target.seek(0);
            }
        } catch (error) {
            console.warn('[KeyboardController] Failed to seek to start', error);
        }
        return null;
    }

    isPlaybackRunning() {
        try {
            const engine = voiceRegistry.getActive()?.audioEngine ?? null;
            if (engine?.isPlaying) {
                return Boolean(engine.isPlaying());
            }
        } catch (_) {}

        return false;
    }

    setActiveDimensionByIndex(index) {
        if (typeof index !== 'number') return;
        const targetIds = getKeyboardFocusTargets();
        if (targetIds.length) {
            for (const id of targetIds) {
                const voice = voiceRegistry.get(id);
                const fallbackMode = targetIds.length === 1 ? this.worldModeController : null;
                this._applyDimensionToVoice(voice?.worldMode ?? fallbackMode, voice?.id ?? null, index);
            }
        } else {
            const active = voiceRegistry.getActive();
            this._applyDimensionToVoice(active?.worldMode ?? this.worldModeController, active?.id ?? null, index);
        }
    }

    // Switch ONE voice's mode controller to its index-th dimension and broadcast a voice-stamped
    // dimension-changed event (so only that tile's React surfaces re-read). Extracted so the shortcut can
    // drive either the single focused voice or every selected voice through one code path.
    _applyDimensionToVoice(mode, voiceId, index) {
        // Resolved live from the registry — NOT the cached `this.worldModeController`, which is
        // last-writer-wins across tiles (every tile's boot calls updateDependencies, so it pointed at
        // whichever tile booted last, not the focused one).
        if (!mode) {
            return;
        }
        const list = mode.getAvailableDimensions?.();
        if (!Array.isArray(list) || !list.length) {
            return;
        }
        const target = list[index];
        const dimensionId = normalizeDimensionId(target);
        if (!dimensionId) {
            return;
        }

        const didChange = mode.setActiveDimension?.(dimensionId, {
            source: 'keyboard',
            broadcast: true,
        });
        if (didChange && typeof document !== 'undefined') {
            document.dispatchEvent(
                new CustomEvent('orbiters:dimension-changed', {
                    detail: {
                        dimensionId,
                        label: target?.label ?? target?.dimensionLabel ?? dimensionId,
                        source: 'keyboard',
                        // Stamp the voice this switch acts on — only that tile's React
                        // surfaces re-read (single-orbiter null → byte-identical).
                        voiceId,
                    },
                }),
            );
        }
    }

    activatePanel(panelId) {
        if (!panelId) {
            return;
        }
        const targetIds = getKeyboardFocusTargets();
        if (targetIds.length === 0) {
            const panelManager = this.panelManager;
            if (panelManager?.activatePanel && panelManager.getActivePanel?.() !== panelId) {
                panelManager.activatePanel(panelId);
            }
            return;
        }
        for (const id of targetIds) {
            const fallbackManager = targetIds.length === 1 ? this.panelManager : null;
            const panelManager = voiceRegistry.get(id)?.panelManager ?? fallbackManager;
            if (!panelManager?.activatePanel) continue;
            if (panelManager.getActivePanel?.() === panelId) continue;
            panelManager.activatePanel(panelId);
        }
    }

    toggleMidiLearnMode() {
        // Direct import — learn mode is voice-independent, so this works with ZERO voices
        // loaded (the collection studio shell initializes this singleton at boot exactly for
        // that). The old window-global indirection + panel fallback are gone with it.
        void toggleMidiLearnMode();
    }
}

export default KeyboardController;
