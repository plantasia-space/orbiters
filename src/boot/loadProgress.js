/**
 * @file src/boot/loadProgress.js
 * Per-voice load-progress reporting.
 *
 * The boot loader was built as ONE global: `Constants.LOADING_STATE` (4 flags) +
 * `window.updateLoadingScreen` / `window.updateLoadingProgress` rendering into the ONE
 * `#loading-screen` overlay. In the multi-orbiter realm N voices interleaved writes to that
 * single state (a voice starting its model load pushed the counter BACKWARDS for everyone),
 * every voice's audio-download text overwrote the same text node, and the first voice to
 * finish removed the overlay for the whole realm — the rest loaded behind a black screen.
 *
 * `createLoadProgress` gives each voice its OWN progress channel:
 *   - single-orbiter (`mirrorGlobal: true`, the default): every report is mirrored through the
 *     existing globals (`Constants.setLoadingState`, `window.updateLoadingProgress`) so the boot
 *     overlay behaves exactly as before;
 *   - multi/collection voices (`mirrorGlobal: false`): reports NEVER touch the global overlay —
 *     they are dispatched on the voice's own event bus as `orbiters:load-progress` /
 *     `orbiters:load-error`, and each tile's `VoiceLoadOverlay` renders them per-voice.
 */

import { Constants } from '../config/Constants.js';

/** Boot steps, in order. Mirrors `Constants.LOADING_STATE`. */
export const LOAD_STEP_KEYS = ['trackLoaded', 'orbiterLoaded', 'modelLoaded', 'uiReady'];

export const LOAD_PROGRESS_EVENT = 'orbiters:load-progress';
export const LOAD_ERROR_EVENT = 'orbiters:load-error';

/**
 * The step message for a given steps state — the same wording the global overlay has always
 * shown, shared so the per-tile overlays and the boot overlay never drift.
 * @param {{trackLoaded:boolean, orbiterLoaded:boolean, modelLoaded:boolean, uiReady:boolean}} steps
 * @returns {string}
 */
export function loadStepMessage(steps) {
    if (!steps?.trackLoaded) return 'Loading Track Data...';
    if (!steps.orbiterLoaded) return 'Loading Orbiter...';
    if (!steps.modelLoaded) return 'Loading 3D Model...';
    if (!steps.uiReady) return 'Finalizing User Interface...';
    return 'Ready';
}

/** Format a byte count as a MB string for download counters ("12.40"). */
export function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(2);
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.voiceId] the reporting voice (null for the single-orbiter default).
 * @param {EventTarget|null} [opts.eventBus] the voice's event bus; progress events dispatch here.
 * @param {boolean} [opts.mirrorGlobal] mirror every report through the legacy global overlay
 *   plumbing. True for single-orbiter (byte-identical boot overlay); false for realm voices.
 * @returns {{
 *   setStep: (key: string, value: boolean) => void,
 *   setMessage: (message: string) => void,
 *   fail: (error?: *) => void,
 *   snapshot: () => object,
 * }}
 */
export function createLoadProgress({ voiceId = null, eventBus = null, mirrorGlobal = true } = {}) {
    const steps = { trackLoaded: false, orbiterLoaded: false, modelLoaded: false, uiReady: false };

    function snapshot(message = null) {
        const completed = LOAD_STEP_KEYS.filter((key) => steps[key]).length;
        return {
            voiceId,
            steps: { ...steps },
            completed,
            total: LOAD_STEP_KEYS.length,
            message,
        };
    }

    function dispatch(type, detail) {
        if (!eventBus || typeof eventBus.dispatchEvent !== 'function') return;
        try {
            eventBus.dispatchEvent(new CustomEvent(type, { detail }));
        } catch (_) {}
    }

    return {
        /** Mark one boot step done/undone (the 4-step counter). */
        setStep(key, value) {
            if (Object.prototype.hasOwnProperty.call(steps, key)) {
                steps[key] = Boolean(value);
            }
            if (mirrorGlobal) {
                Constants.setLoadingState(key, value);
            }
            dispatch(LOAD_PROGRESS_EVENT, snapshot());
        },
        /** Push a free-form progress message (audio/model download counters). */
        setMessage(message) {
            if (mirrorGlobal && typeof window !== 'undefined') {
                window.updateLoadingProgress?.(message);
            }
            dispatch(LOAD_PROGRESS_EVENT, snapshot(message));
        },
        /**
         * Report this voice's bootstrap as finished, whatever the step flags say. Mirrors the
         * single-orbiter overlay semantics: `hideLoadingScreen()` runs at bootstrap end even when
         * a step stayed false (e.g. the audio engine failed but the orbiter is usable) — the tile
         * overlay must clear then too, not wait for a 4/4 that may never come.
         */
        done() {
            dispatch(LOAD_PROGRESS_EVENT, { ...snapshot(), done: true });
        },
        /** Report this voice's load as failed (the tile shows an error state). */
        fail(error = null) {
            dispatch(LOAD_ERROR_EVENT, { voiceId, error });
        },
        snapshot,
    };
}
