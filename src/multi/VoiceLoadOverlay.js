/**
 * @file src/multi/VoiceLoadOverlay.js
 * @description Per-tile loading feedback for the multi-orbiter / collection realm.
 *
 * The boot overlay (`#loading-screen`) is ONE global element; in the shared realm it can't say
 * anything meaningful about N voices (and the first finished voice used to remove it while its
 * siblings were still loading — black tiles, no feedback). This overlay is the per-voice
 * replacement: one per tile, mounted INSIDE the voice's cell, subscribed to the voice's OWN event
 * bus (`orbiters:load-progress` / `orbiters:load-error` from `createLoadProgress`). It shows the
 * same 4-step counter + download counters the single-orbiter overlay shows, then fades out when
 * ITS voice is ready — so orbiters reveal progressively, one by one, exactly as they finish.
 *
 * Plain DOM (not React) on purpose: it exists before/while the tile's React chrome mounts, works
 * for both the collection stages and the plain `?multi=` grid cells, and dies with the voice.
 */
import './voiceLoadOverlay.css';

import {
    LOAD_PROGRESS_EVENT,
    LOAD_ERROR_EVENT,
    loadStepMessage,
} from '../boot/loadProgress.js';
import { getT } from '../i18n/index.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.cell the voice's tile/stage element (the overlay mounts inside it).
 * @param {EventTarget} opts.eventBus the voice's event bus (progress events dispatch here).
 * @returns {{ dispose: () => void }}
 */
export function createVoiceLoadOverlay({ cell, eventBus }) {
    // `cell` may be a plain object in unit tests (the compositor seam is DOM-free there).
    if (!cell || typeof cell.appendChild !== 'function' || !eventBus || typeof document === 'undefined') {
        return { dispose: () => {} };
    }

    // The overlay is absolutely positioned over the tile; guarantee the cell anchors it.
    try {
        if (typeof window !== 'undefined' && window.getComputedStyle(cell).position === 'static') {
            cell.style.position = 'relative';
        }
    } catch (_) {}

    const overlay = document.createElement('div');
    overlay.className = 'voice-load-overlay';
    overlay.innerHTML = `
        <div class="voice-load-overlay__spinner"><div class="voice-load-overlay__dot"></div></div>
        <div class="voice-load-overlay__text">Loading Track Data... (0/4)</div>
    `;
    cell.appendChild(overlay);
    const textEl = overlay.querySelector('.voice-load-overlay__text');

    let removed = false;
    let failed = false;
    let removeTimer = null;

    function remove() {
        if (removed) return;
        removed = true;
        eventBus.removeEventListener(LOAD_PROGRESS_EVENT, onProgress);
        eventBus.removeEventListener(LOAD_ERROR_EVENT, onError);
        if (removeTimer) clearTimeout(removeTimer);
        overlay.remove();
    }

    // Fade out, then remove — the tile "reveals" as its voice becomes ready.
    function reveal() {
        if (removed || overlay.classList.contains('voice-load-overlay--done')) return;
        overlay.classList.add('voice-load-overlay--done');
        removeTimer = setTimeout(remove, 600);
    }

    function setText(next) {
        // Progress can tick per network chunk — skip identical writes.
        if (textEl && textEl.textContent !== next) {
            textEl.textContent = next;
        }
    }

    function onProgress(event) {
        if (removed) return;
        const detail = event?.detail || {};
        const { steps, completed = 0, total = 4, message } = detail;
        // `done` = bootstrap finished (even if a step flag stayed false, e.g. audio engine failed
        // but the orbiter is usable) — same semantics as the single-orbiter hideLoadingScreen().
        if (detail.done || completed >= total) {
            reveal();
            return;
        }
        // A progress tick after an error means the voice is recovering (fallback bootstrap) —
        // drop the error state and resume the counter.
        if (failed) {
            failed = false;
            overlay.classList.remove('voice-load-overlay--error');
        }
        setText(message ? message : `${loadStepMessage(steps)} (${completed}/${total})`);
    }

    function onError(event) {
        if (removed) return;
        failed = true;
        overlay.classList.add('voice-load-overlay--error');
        setText(
            event?.detail?.timedOut
                ? getT()('loading.voiceTimeout', 'This orbiter took too long to load.')
                : getT()('loading.voiceFailed', "Couldn't load this orbiter."),
        );
    }

    eventBus.addEventListener(LOAD_PROGRESS_EVENT, onProgress, { passive: true });
    eventBus.addEventListener(LOAD_ERROR_EVENT, onError, { passive: true });

    return { dispose: remove };
}
