/**
 * @file src/boot/loadingScreen.js
 * The boot loading screen: the step-progress overlay shown until the orbiter is ready.
 *
 * `updateLoadingScreen` / `updateLoadingProgress` are published on `window` so the
 * non-module callers can drive them — `Constants.setLoadingState` (config/Constants.js)
 * ticks the step count, and the audio player (audio/playback/player.js) pushes a custom
 * download-progress message. `hideLoadingScreen` is called from the session bootstrap once
 * the UI is ready. Extracted from Main.js so the composition root stays a boot sequence.
 */

import notifications from '../core/AppNotifications.js';
import { Constants } from '../config/Constants.js';
import { loadStepMessage } from './loadProgress.js';

/** Tear down the loading overlay and clear any transient loaders. */
export function hideLoadingScreen() {
    const loadingScreen = document.getElementById('loading-screen');
    if (!loadingScreen) {
        try {
            notifications.clearTransientLoaders?.();
        } catch (_) {}
        return;
    }
    loadingScreen.classList.add('hidden');
    loadingScreen.style.display = 'none';
    loadingScreen.innerHTML = '';
    loadingScreen.remove();
    try {
        notifications.clearTransientLoaders?.();
    } catch (_) {}
}

/** Ensure the overlay's spinner + text structure exists; returns the container (or null). */
function ensureLoadingContainer(loadingScreen) {
    let loadingContainer = loadingScreen.querySelector(".loading-container");
    if (!loadingContainer) {
        // Create static structure only once
        loadingScreen.innerHTML = `
            <div class="loading-container">
                <div class="orbit-container">
                    <div class="orbit-dot"></div>
                </div>
                <div class="loading-text"></div>
            </div>
        `;
        loadingContainer = loadingScreen.querySelector(".loading-container");
    }
    return loadingContainer;
}

/** Render the step-progress message from the current `Constants` loading state. */
function updateLoadingScreen() {
    const loadingScreen = document.getElementById("loading-screen");
    if (!loadingScreen) return;

    // Get current loading state
    const loadingStates = Constants.getLoadingState();
    const totalSteps = Object.keys(loadingStates).length;
    const completedSteps = Object.values(loadingStates).filter(Boolean).length;

    const message = loadStepMessage(loadingStates);
    const loadingContainer = ensureLoadingContainer(loadingScreen);

    // Update only the text element, leaving the spinner untouched
    const loadingText = loadingContainer.querySelector(".loading-text");
    loadingText.textContent = `${message} (${completedSteps}/${totalSteps})`;

    // Hide loading screen when done
    if (completedSteps === totalSteps) {
        loadingScreen.classList.add("hidden");
        setTimeout(() => {
            loadingScreen.style.display = "none";
        }, 500);
    }
}

/**
 * Show a boot-phase message on the overlay BEFORE any voice reports steps — covers the
 * collection-fetch window (`?collection=`), which used to be a black screen with no text
 * because nothing ticked `Constants.setLoadingState` until the first voice booted.
 * @param {string} message
 */
export function showBootMessage(message) {
    if (typeof document === 'undefined') return;
    const loadingScreen = document.getElementById('loading-screen');
    if (!loadingScreen) return;
    const loadingContainer = ensureLoadingContainer(loadingScreen);
    const loadingText = loadingContainer.querySelector('.loading-text');
    if (loadingText) {
        loadingText.textContent = message;
    }
}

/**
 * Updates loading screen with custom progress message (for audio download)
 * @param {string} progressMessage - Custom progress message to display
 */
function updateLoadingProgress(progressMessage) {
    const loadingScreen = document.getElementById("loading-screen");
    if (!loadingScreen) return;

    const loadingContainer = loadingScreen.querySelector(".loading-container");
    if (!loadingContainer) return;

    const loadingText = loadingContainer.querySelector(".loading-text");
    if (loadingText) {
        loadingText.textContent = progressMessage;
    }
}

/**
 * Publish the loading-screen updaters on `window` for the non-module callers
 * (`Constants.setLoadingState`, the audio player). Call once, early in boot, before any
 * loading-state transitions occur.
 */
export function installLoadingScreenBridge() {
    if (typeof window === 'undefined') return;
    window.updateLoadingScreen = updateLoadingScreen;
    window.updateLoadingProgress = updateLoadingProgress;
}
