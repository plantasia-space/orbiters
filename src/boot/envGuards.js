/**
 * @file src/boot/envGuards.js
 * Environment guards that run once at boot, before the app constructs anything:
 *  - prune the MIDI affordances on platforms without Web MIDI, and
 *  - arm a one-shot silent-audio unlock on the first user gesture.
 *
 * Pure side-effects over `document`/`window`; no app state. Extracted from Main.js so
 * the composition root reads as a sequence of named phases.
 */

import { MIDI_SUPPORTED } from '../config/Constants.js';
import { ensureSilentAudioUnlock } from '../audio/SilentAudioUnlock.js';

/** Remove MIDI learn affordances + menu entries on platforms without Web MIDI. */
function disableMidiUIForUnsupportedEnv() {
    if (MIDI_SUPPORTED) {
        return;
    }

    const pruneMidiAffordances = () => {
        document.querySelectorAll('[midilearn]').forEach(element => {
            element.removeAttribute('midilearn');
        });

        const midiContextMenu = document.getElementById('midi-context-menu');
        if (midiContextMenu?.parentNode) {
            midiContextMenu.parentNode.removeChild(midiContextMenu);
        }

        const exitMidiButton = document.getElementById('exit-midi-learn');
        if (exitMidiButton?.parentNode) {
            exitMidiButton.parentNode.removeChild(exitMidiButton);
        }

        const midiMenuItem = document.getElementById('midi-item');
        if (midiMenuItem?.parentNode) {
            midiMenuItem.parentNode.removeChild(midiMenuItem);
        }

        document.body?.classList.add('midi-disabled');
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', pruneMidiAffordances, { once: true });
    } else {
        pruneMidiAffordances();
    }
}

/** Arm a one-shot silent-audio unlock on the first pointer/touch/key gesture. */
function registerSilentAudioUnlockHandlers() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }

    const attemptUnlock = () => {
        ensureSilentAudioUnlock();
    };

    ['pointerdown', 'touchstart', 'keydown'].forEach((eventName) => {
        document.addEventListener(eventName, attemptUnlock, { once: true, passive: true });
    });
}

/** Run every boot-time environment guard. Call once, before constructing the app. */
export function installEnvGuards() {
    disableMidiUIForUnsupportedEnv();
    registerSilentAudioUnlockHandlers();
}
