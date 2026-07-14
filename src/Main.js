/**
 * @file src/Main.js
 * @description Composition root for the Orbiters app (entry point referenced by index.html).
 * Runs the boot prelude (UI-core shim, environment guards, loading-screen bridge, i18n),
 * then constructs the runtime via `createOrbitersApp` and starts it. All runtime
 * construction and domain logic live in `orbitersApp.js` and the modules it composes.
 * @version 2.0.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @memberof CoreModule
 */

// uiCoreShim publishes window.uiCore (Bootstrap-like Dropdown/Modal/Tooltip helpers) used by
// notifications/tooltips — imported first so its side-effect runs before anything reads it.
import './ui/uiCoreShim.js';

import { initI18n, getT } from './i18n/index.js';
import { installEnvGuards } from './boot/envGuards.js';
import { installLoadingScreenBridge, showBootMessage } from './boot/loadingScreen.js';
import { installAudioOffsetRuntimeHandle } from './config/audioOffset.js';
import { installMetronome } from './audio/metronome.js';
import { createOrbitersApp } from './orbitersApp.js';
import { resolveBootTargetFromUrl, getQueueStartFromUrl } from './utils/urlParams.js';
import { createMultiOrbiterApp } from './multi/createMultiOrbiterApp.js';
import { createCollectionApp, renderMessage } from './multi/createCollectionApp.js';
import { fetchCollectionData } from './api/collectionDataService.js';
import { fetchQueueData, buildQueueData } from './api/queueDataService.js';
import { makeOrbiterVoiceSession } from './multi/makeOrbiterVoiceSession.js';
import { createViewportCompositor } from './multi/renderHost.js';

// 1. Boot prelude — must run before the app constructs anything (no app state needed).
installEnvGuards();
installLoadingScreenBridge();
// Expose the per-device manual audio offset for by-ear tuning (window.orbitersAudioOffset)
// and to seed the cache from `?audioOffset=`/localStorage before the first scheduled start.
installAudioOffsetRuntimeHandle();
// Wire the device metronome singleton to its toggle + the capture-mute gate.
installMetronome();

// 2. i18n must resolve before the first translated paint (React regions read `getT()` at render);
// keep the document title in sync with the active locale.
await initI18n();
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.title = getT()('app.title');
    window.addEventListener('languageChanged', () => {
        document.title = getT()('app.title');
    });
}

// 3. Construct the runtime and boot it on DOM-ready (initial session → React mount → render).
// Boot dispatch (three branches; single-orbiter is the byte-identical default):
//   - `?collection=<id>`  → native collection mode (decisions/0004): fetch the collection (roster +
//     permissions + saved layout) and compose it into the ported resizable slot layout over the shared
//     realm. The host opens this full-screen; there is NO per-frame bridge.
//   - `?multi=1` + `?roster=` → the multi-orbiter realm from an inline roster.
//   - otherwise            → single-orbiter (unchanged). A stray flag with no valid data falls through.
// The branch is resolved ONCE, by `resolveBootTargetFromUrl` — the same call that suppresses edit mode
// for the multi-stage branches (edit is a single-orbiter surface: it edits one orbiter). Dispatching and
// suppressing off one resolver is what keeps a collection URL from also raising the studio.
const bootParams = new URLSearchParams(window.location.search);
const { kind: bootKind, collectionId, queueMode, queueTracks, roster } = resolveBootTargetFromUrl(bootParams);

let app;
if (bootKind === 'queue') {
    // Queue mode: same multi-stage layout as collection mode, but the stages
    // come from the user's playable queue (backend) or an inline `?tracks=` list — never
    // the collection loader (a queue is not a collection). Like collection mode, a
    // failure surfaces a message; it never falls back to single-orbiter.
    try {
        showBootMessage(getT()('loading.queue', 'Loading queue...'));
        const startTrackId = getQueueStartFromUrl(bootParams);
        const queueData = queueMode
            ? await fetchQueueData({ startTrackId })
            : buildQueueData(queueTracks, { startTrackId });
        app = createCollectionApp({ collectionData: queueData, makeVoiceSession: makeOrbiterVoiceSession });
    } catch (error) {
        console.error('[queue] failed to load queue', error);
        app = renderMessage(
            error?.code === 'unauthorized'
                ? getT()('queueMode.signInRequired', 'Sign in to play your queue.')
                : error?.code === 'empty'
                    ? getT()('queueMode.empty', 'Your queue is empty.')
                    : getT()('queueMode.loadFailed', "Couldn't load your queue.")
        );
    }
} else if (bootKind === 'collection') {
    // Collection mode fetches its own data (stubbed until the backend lands). A fetch/permission
    // failure surfaces a message instead of a broken realm; it never falls back to single-orbiter
    // (the URL asked for a specific collection).
    try {
        // The collection fetch is a real network wait — say so instead of a black screen
        // (nothing ticked the boot overlay until the first voice booted).
        showBootMessage(getT()('loading.collection', 'Loading Collection...'));
        const collectionData = await fetchCollectionData(collectionId);
        app = createCollectionApp({ collectionData, makeVoiceSession: makeOrbiterVoiceSession });
    } catch (error) {
        console.error('[collection] failed to load collection', error);
        app = renderMessage(error?.code === 'not-found' ? 'Collection not found.' : "Couldn't load this collection.");
    }
} else if (bootKind === 'multi') {
    // The multi-orbiter realm renders all voices through ONE WebGLRenderer/canvas/loop (the
    // ViewportCompositor) so compressed textures upload for every voice — N canvases = N contexts, where
    // only the first textured. The shell owns its lifecycle (disposed with the realm).
    app = createMultiOrbiterApp({
        roster,
        makeVoiceSession: makeOrbiterVoiceSession,
        createRenderHost: createViewportCompositor,
    });
} else {
    app = createOrbitersApp();
}
app.start();
