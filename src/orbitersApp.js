/**
 * @file src/orbitersApp.js
 * @description The Orbiters runtime, built by `createOrbitersApp()` (called from Main.js, the
 * composition root). Constructs the scene/world/audio/parameter singletons, wires session
 * bootstrap + lifecycle handlers, and returns `{ start, parameterManager }`. Scene setup, parameter
 * management, interactions, and rendering are all assembled here.
 * @version 2.0.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾 
 * @license MIT
 * @date 2024-12-07
 * @memberof CoreModule 
 */
/**
 * @namespace CoreModule
 * @description The **CoreModule** serves as the backbone of the application, organizing and executing foundational logic. 
 * It provides a centralized system for managing interactions, parameter transformations, and application state, 
 * ensuring seamless operation and integration of various components.
 */

/**
 * @namespace InputInterface
 * @description Provides documentation for sensors, MIDI controllers, touch, and other user input mechanisms. 
 * This namespace focuses on capturing, processing, and responding to user interactions efficiently and intuitively.
 */

/**
 * @namespace 2DGUI
 * @description Handles all 2D graphical user interface elements, including sliders, buttons, knobs, and parameter displays. 
 * This namespace integrates WebAudioControls for creating custom, reusable components to control audio parameters seamlessly. 
 * Its focus is on interactive and visually appealing controls optimized for 2D environments.
 */

/**
 * @namespace 3DGUI
 * @description Manages 3D graphical user interface components, including interactive elements within 3D scenes. 
 * It integrates seamlessly with Three.js to provide immersive user interactions.
 */

/**
 * @namespace AudioEngine
 * @description Encapsulates the core logic for audio processing, synthesis, and playback. 
 * This namespace manages the Web Audio API, Tone.js orbiters, and audio parameters to create a dynamic sound environment.
 */
// -----------------------------
// Import Statements
// -----------------------------

// Import scene setup and space elements
import './ui/uiCoreShim.js';

import {
    ensureOscilloscopeOverlay,
    updateOscilloscopePerformanceProfile,
    configureCameraAutomation,
    drawRing,
    isRingEnabled,
    destroyOscilloscopeOverlay,
} from './world/Scene.js';
import { getCameraFocus } from './world/cameraFocus.js';
import { RingOscilloscope } from './world/Ring.js';
import { initSpaceScene } from './world/SceneSpace.js'; // ✅ This handles the cubemap loading!

import { WorldSceneController } from './world/WorldSceneController.js';
import { WorldManagerExtended } from './world/WorldManagerExtended.js';
import { OrbiterModeController } from './orbiter/OrbiterModeController.js';
import {
    getWorldInteractionModeFromUrl,
    getSessionInputSourceFromUrl,
    getDirectPayloadFromURL,
    deriveDescriptorFromHydratedPayload,
    getSessionIdFromUrl,
    getFpsOverlayEnabledFromUrl,
} from './utils/urlParams.js';
import {
    resolveGraphicsPreset,
    normalizeGraphicsPresetKey,
    getGraphicsPresetByKey,
} from './config/performance.js';
import {
    resolveAudioPerformancePreset,
    normalizeAudioPerformanceKey,
    getAudioPerformancePresetByKey,
    persistAudioPerformanceKey,
    getAudioPerformanceThrottleMs,
} from './config/audioPerformance.js';
import { buildEditModeFallback } from './defaults/editModeFallback.js';
import { start as startToneContext } from 'tone';

// Data manager for handling application data
import { DataManager } from './api/dataManager/index.js';

// Internationalization

// Constants for configuration and defaults
import {
    Constants,
    DEFAULT_PLAY_TRACK_ID,
    DEFAULT_EDIT_TRACK_ID,
    AXIS_ROTATION_CONSTRAINTS,
    setPerformanceThrottleMs,
} from './config/Constants.js';

// Iframe session helpers
import {
    getOrbiterSession,
    updateOrbiterSession,
    setOrbiterPlaybackBridge,
} from './utils/iFrameParams.js';



// Interaction and UI setup
import { createOrbiterParameterEmitter } from './orbiter/emitOrbiterParameters.js';
import { bindViewportHandlers, sendWorldSize } from './ui/viewport.js';
import { deriveDesignDefaultsFromCombined } from './ui/designManager.js';
import { applyBrandVars } from './api/orbiterThemes.js';
import { activateMarkedControlTooltips } from './ui/controlTooltips.js';
import { createSessionManager } from './session/sessionController.js';
import { createPlaybackSessionLoader } from './session/playbackSessionLoader.js';
import { createInitializeBaseFlow } from './orbiter/baseFlow/createInitializeBaseFlow.js';
import { mountGranularVisual } from './visual/granularVisualBridge.js';
import { mountEffectVisuals } from './visual/effectVisualsBridge.js';
import { clearVisualFeedback, subscribeVisualFeedback } from './visual/visualFeedbackSettings.js';
import { resolveEffectVisualSettings } from './visual/effectVisualPolicy.js';
import { sessionDescriptorSignature, sanitizeId } from './session/sessionDescriptor.js';
import {
    createStubOrbiterFromCombined,
    createFallbackStubOrbiter,
    deriveStacksDefaultsFromCombined,
    deriveMappingDefaultsFromCombined,
} from './session/editModeHelpers.js';
import { cloneStacksState } from './core/stackUtils.js';




// Parameter manager for managing adjustable parameters
import { ParameterManager } from './core/ParameterManager.js';
import { PanelManager } from './core/PanelManager.js';
import { CameraController } from './input/CameraController.js';
import { voiceRegistry, PRIMARY_VOICE_ID } from './voice/VoiceRegistry.js';
import { Deck } from './voice/Deck.js';
import { getSharedClockState } from './sync/init.js';
import { TransportControl } from './ui/TransportControl.js';

// Notifications handler
import { createOrbitersUsageEventsClient } from './platform-events/orbitersUsageEvents.js';
import { initCapture } from './export/capture.js';
import { isCaptureWindow, bootCaptureWindow } from './export/captureWindow.js';


import { createCosmicLfoCoordinator } from './input/cosmicLfoCoordinator.js';
import { MIDIControllerInstance } from './input/midi/MIDIController.js';
import { hideLoadingScreen } from './boot/loadingScreen.js';
import { createLoadProgress } from './boot/loadProgress.js';
import { createMonitorHydration } from './ui/monitorHydration.js';

// Auth sync between shared session cookie and Firebase
import { ensureFirebaseAuthFromSession } from './auth/sessionAuth.js';

// ...existing code...

/**
 * Construct the Orbiters runtime: builds every singleton, wires the session interceptors and
 * lifecycle handlers, and returns `{ start, parameterManager, voiceId, suspend, resume, dispose }`.
 * Call once, after i18n is ready (the composition root awaits `initI18n()` before constructing the
 * app). `start()` kicks the DOM-ready boot: initial session fetch → React mount → render ring.
 *
 * All options default to today's single-orbiter behavior (so `createOrbitersApp()` with
 * no args is byte-identical). The multi-orbiter composition owner (createMultiOrbiterApp) passes them
 * for the PRIMARY (full) voice:
 * @param {object} [opts]
 * @param {string} [opts.voiceId] the realm-registry key + the engine-registration target voice
 *   (defaults to PRIMARY_VOICE_ID — the single always-active voice).
 * @param {*} [opts.outputNode] a shared master bus (host.getInputNode()) the adapter mixes into,
 *   skipping its own limiter (default null → own limiter → Tone.Destination).
 * @param {*} [opts.transport] a shared transport for the adapter (default null → own
 *   TransportController over its own shared-package Transport — per-voice transport is independent).
 * @param {boolean} [opts.installLifecycle] install this instance's page-lifecycle handlers (default
 *   true; the multi-orbiter shell passes false and owns ONE shared handler set, driving the returned
 *   suspend/resume/dispose).
 * @param {{trackId?: string, orbiterId?: string, entangledWorldId?: string}} [opts.sessionDescriptor]
 *   the entity this voice should boot (default null → resolve from the URL / host bridge as today).
 *   The multi-orbiter shell passes the PRIMARY voice's roster entry so the multi boot honors
 *   roster[0] instead of the URL fallback.
 */
export function createOrbitersApp({
    voiceId = PRIMARY_VOICE_ID,
    outputNode = null,
    transport = null,
    installLifecycle = true,
    sessionDescriptor = null,
    canvasEl = null,
    // In the multi-orbiter realm the ViewportCompositor owns ONE renderer; a scene voice
    // passes it here and its WorldSceneController borrows it (one WebGL context → textures upload for
    // every voice) instead of creating its own. No `sharedRenderer` → single-orbiter is byte-identical.
    sharedRenderer = null,
    mountChrome = true,
    // The DOM cell to mount this voice's React UI into (a grid tile). Null →
    // single-orbiter, mounts to document.body and fills the viewport (byte-identical).
    uiContainer = null,
    // In a multi grid exactly one voice owns the realm-global UI side effects
    // (the `data-ui-react` body attr + `.dark` class). Single-orbiter always owns them.
    isPrimary = false,
    // The voice's session event bus. Single-orbiter defaults to `window` (byte-identical);
    // a multi-orbiter voice passes its OWN EventTarget so session→world signals don't cross-talk between
    // voices (otherwise only one of N planets loads its world texture).
    eventBus = (typeof window !== 'undefined' ? window : null),
    // True when this voice lives in the shared multi-orbiter realm. Drives two policies
    // explicitly (rather than inferring them from bus identity): the voice neither touches the ONE
    // global boot overlay (per-tile overlays own feedback) nor prunes the realm-shared release
    // caches (one voice's load must not evict its siblings' releases). Single-orbiter: false.
    sharedRealm = false,
} = {}) {
const IS_IFRAME = typeof window !== 'undefined' && window.self !== window.top;

// Precompute URL parameters & initial mode
const INITIAL_URL_PARAMS = new URLSearchParams(window.location.search);
// Fixed-size capture window: the same orbiter with the full interface, sized to the chosen
// aspect. Window snapping + auto-record (once the orbiter is loaded) is wired in handleDomReady.
const IS_CAPTURE_WINDOW = isCaptureWindow();
const INITIAL_WORLD_MODE = getWorldInteractionModeFromUrl(INITIAL_URL_PARAMS);
const INITIAL_GRAPHICS_RESOLUTION = resolveGraphicsPreset(INITIAL_URL_PARAMS);
const INITIAL_GRAPHICS_PRESET_KEY = INITIAL_GRAPHICS_RESOLUTION.key;
const INITIAL_GRAPHICS_PROFILE = INITIAL_GRAPHICS_RESOLUTION.preset;
const INITIAL_GRAPHICS_PREFERENCE = INITIAL_GRAPHICS_PROFILE.label;
const INITIAL_AUDIO_RESOLUTION = resolveAudioPerformancePreset(INITIAL_URL_PARAMS);
const INITIAL_AUDIO_PRESET_KEY = INITIAL_AUDIO_RESOLUTION.key;
const INITIAL_AUDIO_PROFILE = INITIAL_AUDIO_RESOLUTION.preset;
const INITIAL_SESSION_SOURCE = getSessionInputSourceFromUrl(INITIAL_URL_PARAMS);
const INITIAL_SESSION_ID = getSessionIdFromUrl(INITIAL_URL_PARAMS);
const INITIAL_FPS_OVERLAY_ENABLED = getFpsOverlayEnabledFromUrl(INITIAL_URL_PARAMS);
const IS_INITIAL_EDIT_MODE = INITIAL_WORLD_MODE === 'edit';
const usageEvents = createOrbitersUsageEventsClient({
    mode: INITIAL_WORLD_MODE,
    getEngine: () => audioEngine || voiceRegistry.getActive()?.audioEngine || null,
});
usageEvents.start();

let activeGraphicsProfileKey = INITIAL_GRAPHICS_PRESET_KEY;
let activeGraphicsProfile = INITIAL_GRAPHICS_PROFILE;
// Per-group effect-visual settings, resolved from the graphics profile by the
// one policy resolver (user preference still stubbed to "everything on").
// Cached so per-frame readers get a stable object, recomputed on profile change.
let activeEffectVisualSettings = resolveEffectVisualSettings(activeGraphicsProfile);
let activeAudioProfileKey = INITIAL_AUDIO_PRESET_KEY;
let activeAudioProfile = INITIAL_AUDIO_PROFILE;

// Retrieve the canvas element for 3D rendering. A per-voice canvas (multi-orbiter scene voice)
// may be injected; the single-orbiter default stays the fixed #canvas3D.
const canvas3D = canvasEl || document.getElementById('canvas3D');

// Shared scene controller integrates renderer, camera, controls
const worldController = new WorldSceneController(canvas3D, {
    performanceProfile: INITIAL_GRAPHICS_PROFILE,
    showFpsOverlay: INITIAL_FPS_OVERLAY_ENABLED,
    sharedRenderer,
    // This voice's ONE camera-input surface = its cell in a shared realm (`uiContainer`), or the
    // app's fullscreen canvas single-orbiter. Always set (never the shared canvas), so the CameraController
    // binds exactly one element it owns.
    inputElement: uiContainer ?? canvas3D,
});
const { scene, camera, renderer } = worldController;

// The ParameterManager is constructed up-front (no singleton) so camera automation,
// edit mode, MIDI, and the cosmic LFOs all receive the SAME per-voice instance via DI. Param
// REGISTRATION (x/y/z, sync-bpm, ...) still happens below — subscribers (camera automation) bind
// to the live manager before the params exist, exactly as the prior singleton timing did.
const parameterManager = new ParameterManager();
// The MIDI controller is a module-level singleton built at import (before any voice); inject the
// voice's manager now and let it create its feedback bridge.
if (MIDIControllerInstance) {
    MIDIControllerInstance.setParameterManager(parameterManager);
}

// Gate this voice's camera orbit on ITS OWN playback state, resolved off the registry each frame (the
// audio engine attaches after its async init). In the multi-stage collection view all voices share one
// realm, so reading the realm-global playback made every camera animate when any one voice played;
// scoping to this voice keeps play/Space animating only the focused (playing) orbiter. Single-orbiter
// registers one always-active voice, so this reads the same state the global would have (equivalent).
configureCameraAutomation(
    worldController,
    parameterManager,
    () => voiceRegistry.get(voiceId)?.audioEngine?.getPlaybackState() ?? 'stopped',
    // What this voice's camera orbits — the world, or its first moon.
    () => getCameraFocus(voiceId),
);

// Construct THIS voice's oscilloscope up-front (no module singleton) and keep the
// reference in this module's closure. It is attached to the VoiceContext at registration below, and
// every boot-time oscilloscope call (perf profile, overlay attach) passes this same instance. Built
// here — before the perf-profile / overlay-attach calls and before the render callback that reads it
// — so there is no swallowed ReferenceError / black screen from touching it before construction.
const oscilloscope = new RingOscilloscope();
updateOscilloscopePerformanceProfile(oscilloscope, INITIAL_GRAPHICS_PROFILE);

if (typeof window !== 'undefined') {
    window.__orbitersGraphicsProfile = {
        key: activeGraphicsProfileKey,
        config: activeGraphicsProfile,
    };
    window.__orbitersAudioProfile = {
        key: activeAudioProfileKey,
        config: activeAudioProfile,
    };
}
syncFeedbackThrottleToAudioProfile(activeAudioProfileKey);
persistAudioPerformanceKey(activeAudioProfileKey);

// Ensure the oscilloscope overlay exists and is attached
ensureOscilloscopeOverlay(oscilloscope, scene);

// Placeholder: instantiate extended manager (world content integration forthcoming)
const worldManager = new WorldManagerExtended(scene, { renderer });
// Edit-mode emitter — getters resolve the controller + engine lazily (both declared below),
// so this needs no function hoisting and stays a plain const.
// The DOM element this voice's orbiter theme (--color1/2/3, font) is scoped to. For a
// multi tile that's its grid cell, so each tile shows its own world's colors; single-orbiter passes
// null so applyDesignSettings falls back to documentElement (byte-identical, page-wide theme).
const designThemeRoot = uiContainer || null;
// De-singletonization: this voice OWNS its PanelManager (not a module singleton),
// so opening a panel in one tile doesn't move the others. It broadcasts panel changes on this voice's
// eventBus (window for single-orbiter → byte-identical) and scopes its chrome to the voice's root.
const panelManager = new PanelManager({
    eventBus,
    root: uiContainer ?? (typeof document !== 'undefined' ? document : null),
    voiceId,
});
// De-singletonization: this voice OWNS its TransportControl (not a singleton),
// so play/pause in one tile drives only that tile's orbiter. It dispatches transport-state-change on
// this voice's eventBus (window for single-orbiter → byte-identical).
const transportControl = new TransportControl({
    eventBus,
    root: uiContainer ?? (typeof document !== 'undefined' ? document : null),
});
const emitOrbiterParameters = createOrbiterParameterEmitter({
    getModeController: () => orbiterModeController,
    getAudioEngine: () => audioEngine,
    themeRoot: designThemeRoot,
});
const orbiterModeController = new OrbiterModeController({
    worldManager,
    scene,
    defaultMode: INITIAL_WORLD_MODE,
    emitParameterUpdate: emitOrbiterParameters,
    parameterManager,
    themeRoot: designThemeRoot,
    // Stamp this voice's dimension-changed events (single-orbiter null → byte-identical).
    voiceId,
    onModeChanged: (mode) => {}
});

// ✅ Set the cubemap skybox
initSpaceScene(scene);

// Instantiate the DataManager for handling track data. Constructed BEFORE bindViewportHandlers
// because that runs an initial resize synchronously, which calls getTrackId() → dataManager (the
// active trackId now lives on the DataManager instance, not a Constants global).
// Does this voice own the ONE global boot overlay? Only the single-orbiter app (whose
// event bus IS window) does. A multi/collection voice gets its own EventTarget, reports progress
// on it (per-tile overlays subscribe there), and must never touch the global overlay — previously
// N voices thrashed the one 4-step counter and the FIRST voice to finish removed the overlay while
// its siblings were still loading behind a black screen.
const ownsGlobalLoadingScreen = !sharedRealm;
const loadProgress = createLoadProgress({ voiceId, eventBus, mirrorGlobal: ownsGlobalLoadingScreen });

// Observable per-voice boot completion — settles `{ok}` when this voice's bootstrap
// finishes (or falls back). The multi shell awaits it (with a deadline) so ONE stuck voice can no
// longer hang the whole realm invisibly; single-orbiter never awaits it.
let resolveWhenReady;
const whenReady = new Promise((resolve) => { resolveWhenReady = resolve; });
function settleReady(result) {
    if (resolveWhenReady) {
        resolveWhenReady(result);
        resolveWhenReady = null;
    }
}

const dataManager = new DataManager({ eventBus, loadProgress, sharedRealmCache: sharedRealm });

// This voice's DECK — the one owner of its sync/warp flags, tempo, meter, grid, and beat clock. The
// coordinator fans each master/status change to it; its shared-clock source reads the realm clock live
// (a function so the beat is never cached). Seeded from trackData by the audio adapter. `collection`
// comes from the CONSTRUCTION PATH (sharedRealm), never the live registry size — sibling voices
// register asynchronously, so size at construction lies. A solo deck mirrors the master and keeps the
// historical follow rule (only while the sync session is enabled), byte-identical.
const deck = new Deck({ voiceId, collection: sharedRealm });
deck.setSharedClockSource(() => getSharedClockState());

// Register this orbiter as the single voice in the realm registry — the realm-global
// replacement for the old `window.__orbitersWorldController/WorldMode` + `window.dataManagerInstance`
// slots that the last-booted orbiter used to clobber. Single boot = one always-active voice, so
// every reader resolves it via `voiceRegistry.getActive()`. The audio engine and cosmic LFOs are
// filled onto this same record below, once they exist (two-phase: sync fields now, async ones later).
// The VOICE owns its camera-input controller — created here at boot (world + params + the voice's
// input surface all exist) and disposed with the voice, not spun up/torn down on every jamming-panel
// enter/exit. Panel state is now just a drive filter (see PanelManager). It focuses this voice on
// pointerdown, so no realm-level hit-test is needed.
const cameraController = new CameraController(worldController, parameterManager, voiceId);

voiceRegistry.register(voiceId, {
    id: voiceId,
    parameterManager,
    worldController,
    // This voice's camera-input controller. Read by PanelManager to gate drive on panel change.
    cameraController,
    worldMode: orbiterModeController,
    dataManager,
    // The voice's resolved trackId (the loaded track wins; the boot descriptor / URL are the pre-load
    // fallback). Read by the capture flow when the engine is embedded in a host page, to target this
    // voice's track in the standalone app.
    getTrackId: () =>
        dataManager.activeConfigRequest?.trackId ??
        sessionDescriptor?.trackId ??
        INITIAL_URL_PARAMS.get('trackId') ??
        null,
    transportControl,
    // This voice's own PanelManager (panel state is per-voice, de-singletonized).
    panelManager,
    // This voice's event channel — the SAME EventTarget the PanelManager dispatches on
    // and the React engine context subscribes to (window for single-orbiter). Registering it here is
    // what lets `resolveEngineContext` find it via `getVoice().eventBus` so dispatch + subscribe match.
    eventBus,
    deck,
    // The voice owns its ring oscilloscope (constructed above, attached to this
    // voice's scene). The render loop and active-voice consumers resolve it off the registry.
    oscilloscope,
    // The voice's DOM root — `document` for single-orbiter (so scoped lookups are
    // byte-identical), a per-voice subtree in multi-orbiter.
    rootEl: typeof document !== 'undefined' ? document : null,
    // The element this voice's orbiter theme (`--color1/2/3`) is written to (its grid cell in
    // multi-orbiter; null in single-orbiter where the theme lands on documentElement directly). The
    // multi shell reads it on focus change to mirror the FOCUSED tile's accent onto documentElement so
    // body-portalled menus (More / Monitor) theme correctly.
    themeRoot: designThemeRoot,
});

// Keep renderer and camera aligned with viewport changes. This is the FULLSCREEN single-orbiter
// framing (it sizes the renderer to the WINDOW and posts world-size to the host). It belongs ONLY to
// a voice that OWNS its renderer; a shared-renderer voice is sized/framed per-cell by the
// ViewportCompositor, so running this would stamp the shared canvas fullscreen and clobber the grid.
// (Gated on `!sharedRenderer`, NOT `mountChrome` — multi tiles now mount chrome but must not reframe.)
if (!sharedRenderer) {
    bindViewportHandlers({
        renderer,
        camera,
        getTrackId: () => dataManager.activeConfigRequest?.trackId ?? null,
        maxDevicePixelRatio: INITIAL_GRAPHICS_PROFILE.maxDevicePixelRatio,
        // Subtract the Studio panel inset so resize reframes the SAME left region the controller does —
        // otherwise this handler resizes to the full tab and the orbiter recenters under the panel.
        getViewportInset: () => worldController.viewportInsetRight,
    });
}

const sessionManager = createSessionManager({
    dataManager,
    updateOrbiterSession,
    eventBus,
});

const playbackLoader = createPlaybackSessionLoader({
    dataManager,
    sessionManager,
    eventTarget: eventBus,
});

if (eventBus) {
    eventBus.addEventListener('orbiters:session-load', interceptPlaybackSessionLoad, { capture: true });
    eventBus.addEventListener('orbiters:session-update', interceptPlaybackSessionUpdate, { capture: true });
}

function syncFeedbackThrottleToAudioProfile(profileKey) {
    const throttleMs = getAudioPerformanceThrottleMs(profileKey);
    setPerformanceThrottleMs(throttleMs);
}

function getLastSessionResolution() {
    if (sessionManager && typeof sessionManager.getLastResolution === 'function') {
        return sessionManager.getLastResolution();
    }
    return null;
}

function refreshDimensionScopedUi() {
    const resolution = getLastSessionResolution();
    if (!resolution || resolution.ok === false) {
        return;
    }

    const entangledWorld = resolution.entangledWorld ?? resolution.track?.entangledWorld ?? null;
    try {
        primeCosmicLfoUi(entangledWorld);
    } catch (error) {
        console.warn('[Main] Failed to refresh cosmic LFO sources after dimension change', error);
    }

    if (dataManager) {
        try {
            if (dataManager.activeView) {
                dataManager.populatePlaceholders(dataManager.activeView);
            } else {
                monitorHydration.hydrate(dataManager);
            }
        } catch (error) {
            console.warn('[Main] Failed to refresh placeholders after dimension change', error);
        }
    }
}

if (typeof document !== 'undefined') {
    if (!document.__orbitersDimensionUiHandler) {
        document.__orbitersDimensionUiHandler = refreshDimensionScopedUi;
        document.addEventListener('orbiters:dimension-changed', refreshDimensionScopedUi, {
            passive: true,
        });
    }
}

// Instantiate the Audio Engine for managing playback
let audioEngine;
let orbiterWarningShown = false;
let lastSessionSignature = null;
let pendingSessionLoad = null;
let lastResolvedSession = null;
let usageEventsPlaybackUnsubscribe = null;

setOrbiterPlaybackBridge({
    getCurrentTime: () => {
        if (!audioEngine || typeof audioEngine.getCurrentPositionMs !== 'function') {
            return 0;
        }
        const positionMs = Number(audioEngine.getCurrentPositionMs());
        return Number.isFinite(positionMs) ? positionMs / 1000 : 0;
    },
    isPlaying: () => {
        if (!audioEngine || typeof audioEngine.isPlaying !== 'function') {
            return false;
        }
        return Boolean(audioEngine.isPlaying());
    },
    seek: async ({ time } = {}) => {
        if (!audioEngine || typeof audioEngine.seekToMilliseconds !== 'function') {
            throw new Error('Audio engine is not ready.');
        }
        const seconds = Number(time);
        if (!Number.isFinite(seconds)) {
            throw new Error('Invalid playback seek time.');
        }
        await audioEngine.seekToMilliseconds(Math.max(0, seconds) * 1000);
    },
});

// Register the adjustable parameters for user 1 (the manager itself is constructed up-front,
// near the camera-automation wiring above — per-voice DI).
const {
    min: ROOT_AXIS_MIN = 0,
    max: ROOT_AXIS_MAX = 1,
    equilibrium: ROOT_AXIS_EQ = 0,
} = AXIS_ROTATION_CONSTRAINTS || {};

['x', 'y', 'z'].forEach((axis) => {
    parameterManager.addParameter(
        axis,
        ROOT_AXIS_EQ,
        ROOT_AXIS_MIN,
        ROOT_AXIS_MAX,
        true,
        'linear',
        (value) => value,
        (value) => value
    );
});

function syncUsageEventsPlaybackListener() {
    if (typeof usageEventsPlaybackUnsubscribe === 'function') {
        usageEventsPlaybackUnsubscribe();
        usageEventsPlaybackUnsubscribe = null;
    }

    if (!audioEngine || typeof audioEngine.addPlaybackStateListener !== 'function') {
        return;
    }

    usageEventsPlaybackUnsubscribe = audioEngine.addPlaybackStateListener((payload = {}) => {
        usageEvents.handlePlaybackStateChange(payload);
    });
}

// The BPM range is 20–300 across every UI surface (the legacy `webaudio-param`
// markup in index.html, the React HeaderBar + PlaybackPanel controls). The param was
// registered at 240, which clipped inbound MIDI (the control/descriptor scale to 300 but the
// param capped at 240) so a CC sweep didn't span the real tempo range. Align to 300.
parameterManager.addParameter(
    'sync-bpm',
    120,
    20,
    300,
    true,
    'linear',
    (value) => value,
    (value) => value
);

parameterManager.addParameter(
    'sync-track-bpm',
    120,
    20,
    300,
    true,
    'linear',
    (value) => value,
    (value) => value
);

let audioEngineDisposeBound = false;
let visualResourcesSuspended = false;
let lifecycleHandlersInstalled = false;
let instanceDisposed = false;
// This voice's granular visual bridge (engine lifetime → accretion disk layer). Mounted when the
// audio engine lands on the voice entry; this instance owns its teardown (the single-orbiter path
// never unregisters its voice, so registry events can't be the trigger).
let granularVisualHandle = null;
// This voice's rack-effect visual bridge (effect lifetimes → group layers: echoes on the moons,
// space/air on the cloud shell + glow). Same seam, same ownership as the granular bridge.
let effectVisualsHandle = null;
// The registry subscription that mounts the bridge on engine assignment (released on dispose).
let unsubscribeEngineAssigned = null;
// The visual-feedback subscription: a module's switch moved in the Studio, so the effect bridge
// re-decides what it binds. Only the visuals move — the audio graph is never touched.
let unsubscribeVisualFeedback = null;
// The React-UI shell handle for this instance, so full teardown unmounts its root. Without this a voice
// removed in place (a collection stage cleared / replaced without changing the stage count) would leave
// its UI root rendering against a disposed engine over the now-empty cell.
let reactUIHandle = null;

function suspendVisualResources() {
    if (visualResourcesSuspended || instanceDisposed) {
        return;
    }
    try {
        worldController.setRenderActive?.(false);
    } catch (_) {}
    try {
        destroyOscilloscopeOverlay(oscilloscope);
    } catch (_) {}
    visualResourcesSuspended = true;
}

function resumeVisualResources() {
    if (!visualResourcesSuspended || instanceDisposed) {
        return;
    }
    try {
        ensureOscilloscopeOverlay(oscilloscope, scene);
    } catch (_) {}
    try {
        worldController.setRenderActive?.(true);
    } catch (_) {}
    visualResourcesSuspended = false;
}

function disposeOrbiterInstance({ reason = 'unknown' } = {}) {
    if (instanceDisposed) return;
    instanceDisposed = true;

    // Settle this voice NOW: its in-flight bootstrap bails on `instanceDisposed`, so it will never
    // reach `settleReady` itself, and dispose has already cleared the deadline timer. The realm's boot
    // worker holds a slot on `settled` — without this, removing a voice mid-boot wedges the queue.
    settleReady({ ok: false, disposed: true });

    // Stop render loop and release visual GPU resources first.
    suspendVisualResources();

    try {
        cosmicLFOManager?.disposeAll?.();
    } catch (error) {
        console.warn('[Main] Failed to dispose CosmicLFO manager', { reason, error });
    }

    // Dispose the voice's camera-input controller before its world (it removes a render callback
    // from the world + its pointer listeners from the input surface).
    try {
        cameraController?.dispose?.();
    } catch (error) {
        console.warn('[Main] Failed to dispose camera controller', { reason, error });
    }

    // Tear down the granular visual bridge before its world controller (it removes a render
    // callback + a scene overlay and frees the layer's GPU resources).
    try {
        unsubscribeEngineAssigned?.();
    } catch (_) {}
    unsubscribeEngineAssigned = null;
    try {
        unsubscribeVisualFeedback?.();
    } catch (_) {}
    unsubscribeVisualFeedback = null;
    // The voice's module switches leave with the voice — a later voice reusing this id must boot
    // from its own orbiter's session, never from a stranger's leftovers.
    try {
        clearVisualFeedback(voiceId);
    } catch (_) {}
    try {
        granularVisualHandle?.dispose?.();
    } catch (error) {
        console.warn('[Main] Failed to dispose granular visual bridge', { reason, error });
    }
    granularVisualHandle = null;
    try {
        effectVisualsHandle?.dispose?.();
    } catch (error) {
        console.warn('[Main] Failed to dispose effect visuals bridge', { reason, error });
    }
    effectVisualsHandle = null;

    try {
        worldController.dispose?.();
    } catch (error) {
        console.warn('[Main] Failed to dispose world controller', { reason, error });
    }

    try {
        audioEngine?.dispose?.();
    } catch (error) {
        console.warn('[Main] Failed to dispose audio engine', { reason, error });
    }
    audioEngine = null;

    // Unmount this instance's React-UI root (see reactUIHandle). Removing a voice in place otherwise
    // leaves a live root over the cell; on a real page unload it's harmless but still the correct teardown.
    try {
        reactUIHandle?.unmount?.();
    } catch (error) {
        console.warn('[Main] Failed to unmount React UI shell', { reason, error });
    }
    reactUIHandle = null;
}

function installInstanceLifecycleHandlers() {
    if (lifecycleHandlersInstalled || typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }
    lifecycleHandlersInstalled = true;

    const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
            suspendVisualResources();
        } else {
            resumeVisualResources();
            // Resume AudioContext if the browser suspended it while the tab was in the background.
            // Tone.start() is safe to call repeatedly — it's a no-op when the context is already running.
            try { startToneContext(); } catch {}
            void audioEngine?.resumeAfterInterruption?.();
        }
    };

    const onPageHide = (event) => {
        suspendVisualResources();
        if (event?.persisted) {
            return;
        }
    };

    const onBeforeUnload = () => {
        disposeOrbiterInstance({ reason: 'beforeunload' });
    };

    const onUnload = () => {
        disposeOrbiterInstance({ reason: 'unload' });
    };

    const onPageShow = (event) => {
        if (event?.persisted) {
            resumeVisualResources();
        }
        try { startToneContext(); } catch {}
        void audioEngine?.resumeAfterInterruption?.();
    };

    document.addEventListener('visibilitychange', onVisibilityChange, { passive: true });
    window.addEventListener('pagehide', onPageHide, { passive: true });
    window.addEventListener('pageshow', onPageShow, { passive: true });
    window.addEventListener('beforeunload', onBeforeUnload, { once: true });
    window.addEventListener('unload', onUnload, { once: true });
}

// The multi-orbiter shell owns ONE shared set of lifecycle handlers and drives the
// returned suspend/resume/dispose; a per-voice install would double-register (and the {once:true}
// beforeunload would dispose only one voice). Single-orbiter keeps installing its own.
if (installLifecycle) {
    installInstanceLifecycleHandlers();
}

// -----------------------------
// Application Initialization Function
// -----------------------------

/**
 * Initializes the application.
 * Fetches track data, sets up the scene, and configures interactions.
 * @async
 * @function initializeApp
 * @throws Will log an error if initialization fails.
 * @memberof CoreModule
 */
async function initializeApp() {
    try {
        const fallbackTrackId = INITIAL_WORLD_MODE === 'edit'
            ? DEFAULT_EDIT_TRACK_ID
            : DEFAULT_PLAY_TRACK_ID;

        try {
            await ensureFirebaseAuthFromSession();
        } catch (authError) {
            console.warn('[APP] Firebase session sync skipped:', authError?.message || authError);
        }

        const initialTrackId =
            sessionDescriptor?.trackId || INITIAL_URL_PARAMS.get('trackId') || fallbackTrackId;
        await requestInitialSession({ fallbackTrackId: initialTrackId });
    } catch (error) {
        console.error('[APP] Error during application initialization:', error);
        await handleSessionError({ detail: { error } });
    }
}
  
// -----------------------------
// DOMContentLoaded Event Listener
// -----------------------------

/**
 * Executes when the DOM is fully loaded.
 * Initializes the application and starts the animation loop.
 * @memberof CoreModule 
 */
let domReadyHandled = false;
function handleDomReady() {
    if (domReadyHandled) {
        return;
    }
    domReadyHandled = true;

    // Global brand primitives + entity accents, applied once at :root (theme-independent).
    void applyBrandVars();

    initializeApp().then(() => {
        worldController.addRenderCallback(() => {
            // Draw each voice's own oscilloscope from its own audio engine's
            // amplitude. Single-orbiter = one voice, so this is the exact same per-frame draw call as
            // before (its oscilloscope, its audioEngine). Every guard is preserved per-voice: the
            // ring-enabled check, the finite-amplitude coercion, and the one-shot orbiterWarningShown.
            // Index loop over the registry's cached list — no per-frame allocation in this 60fps path.
            const voices = voiceRegistry.all();
            for (let i = 0; i < voices.length; i++) {
                const voice = voices[i];
                const voiceOscilloscope = voice.oscilloscope;
                if (!isRingEnabled(voiceOscilloscope)) {
                    continue;
                }

                let currentAmp = 0;
                const voiceAudioEngine = voice.audioEngine;
                if (voiceAudioEngine) {
                    if (typeof voiceAudioEngine.getAmplitude === 'function') {
                        const amplitude = voiceAudioEngine.getAmplitude();
                        currentAmp = Number.isFinite(amplitude) ? amplitude : 0;
                    } else if (!orbiterWarningShown) {
                        orbiterWarningShown = true;
                    }
                } else if (!orbiterWarningShown) {
                    orbiterWarningShown = true;
                }

                drawRing(voiceOscilloscope, currentAmp);
            }
        });
    });

    activateMarkedControlTooltips();
    sendWorldSize(renderer, dataManager.activeConfigRequest?.trackId ?? null);
    initCapture();
    // Only the STANDALONE single-orbiter app arms its own capture window here. A shared-realm voice
    // (multi / collection tile) must not — every tile runs this boot, so N tiles would each lock the
    // window and race to auto-record. The realm arms capture ONCE at the shell level
    // (`createMultiOrbiterApp`). `!sharedRenderer` == the single-orbiter app that owns its own window.
    if (IS_CAPTURE_WINDOW && !sharedRenderer) {
        bootCaptureWindow();
    }
}

// Kick the boot once the DOM is ready. Called by the composition root after construction.
function start() {
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                handleDomReady();
            }, { once: true });
        } else {
            handleDomReady();
        }
    }
}


// Cosmic LFOs (x/y/z) + world→sources priming live in the coordinator. Called here to preserve LFO
// construction timing; the manager is registered onto the active voice for runtime readers.
const { manager: cosmicLFOManager, primeCosmicLfoUi } = createCosmicLfoCoordinator(parameterManager, eventBus);
// Attach to THIS voice (not getActive()) so a later-registered voice can't misroute it.
const ownVoice = voiceRegistry.get(voiceId);
if (ownVoice) {
    ownVoice.cosmicLFOManager = cosmicLFOManager;
}

const monitorHydration = createMonitorHydration(activeGraphicsProfile.uiMonitorThrottleMs);

const initializeBaseFlow = createInitializeBaseFlow({
    voiceId,
    loadProgress,
    orbiterModeController,
    renderer,
    scene,
    dataManager,
    parameterManager,
    primeCosmicLfoUi,
    hydrateMonitorPanels: monitorHydration.hydrate,
    getAudioEngine: () => audioEngine,
    setAudioEngine: (engine) => {
        audioEngine = engine;
    },
    getAudioEngineDisposeBound: () => audioEngineDisposeBound,
    setAudioEngineDisposeBound: (value) => {
        audioEngineDisposeBound = value;
    },
    isIframe: IS_IFRAME,
    themeRoot: designThemeRoot,
    panelManager,
    transportControl,
    // The per-voice event bus (window for single-orbiter) the AudioEngineAdapter mirrors
    // its count-in onto, matching the bus the React Transport surface subscribes to.
    eventBus,
});

// Mount this voice's engine-lifetime consumers (the granular visual bridge) at the registry's
// assignment seam — the one point where the adapter identity is settled on the entry. The
// registry notifies for EVERY voice, so filter to this instance's own voice.
unsubscribeEngineAssigned = voiceRegistry.onAudioEngineAssigned((voiceEntry) => {
    if (voiceEntry?.id !== voiceId) return;
    // A rebuilt engine (fresh adapter identity) gets a fresh bridge; the old
    // one is torn down with the old adapter.
    granularVisualHandle?.dispose?.();
    granularVisualHandle = mountGranularVisual(voiceEntry, {
        getVisualSettings: () => activeEffectVisualSettings,
    });
    effectVisualsHandle?.dispose?.();
    effectVisualsHandle = mountEffectVisuals(voiceEntry, {
        getVisualSettings: () => activeEffectVisualSettings,
    });
});

// A module's visual switch moved: the bridge re-decides what it binds — nothing else. The rack, the
// effect nodes and the sound go on exactly as they were.
unsubscribeVisualFeedback = subscribeVisualFeedback((changedVoiceId) => {
    if (changedVoiceId !== voiceId) return;
    effectVisualsHandle?.refresh?.();
});

function buildBootstrapSessionDescriptor({ fallbackTrackId }) {
    const snapshot = getOrbiterSession();
    const requested = { ...(snapshot?.requested || {}) };
    const resolved = snapshot?.resolved ? { ...snapshot.resolved } : null;

    // A multi-orbiter primary boots its roster entry (sessionDescriptor); single-orbiter
    // (sessionDescriptor null) resolves from the URL exactly as before.
    const urlTrackId = sessionDescriptor?.trackId || INITIAL_URL_PARAMS.get('trackId');
    const urlOrbiterId =
        sessionDescriptor?.orbiterId
        || INITIAL_URL_PARAMS.get('orbiterId')
        || INITIAL_URL_PARAMS.get('engineId');
    const urlWorldId =
        sessionDescriptor?.entangledWorldId
        || INITIAL_URL_PARAMS.get('entangledWorldId')
        || INITIAL_URL_PARAMS.get('worldId');

    if (urlTrackId) {
        requested.trackId = urlTrackId;
    }
    if (urlOrbiterId) {
        requested.orbiterId = urlOrbiterId;
    }
    if (urlWorldId) {
        requested.entangledWorldId = urlWorldId;
    }

    const baseTrackId = urlTrackId || fallbackTrackId;
    requested.trackId = baseTrackId;
    if (!urlOrbiterId) {
        requested.orbiterId = null;
    }
    if (!urlWorldId) {
        requested.entangledWorldId = null;
    }
    if (resolved && baseTrackId && resolved.trackId !== baseTrackId) {
        resolved.trackId = baseTrackId;
        resolved.orbiterId = urlOrbiterId || null;
        resolved.entangledWorldId = urlWorldId || null;
    }

    return {
        requested,
        resolved,
        source: snapshot?.source || 'app-init',
    };
}

async function bootstrapFromResolution(detail) {
    // A voice removed mid-boot must not build anything: its session resolve is still in flight and
    // resolves onto a disposed instance (world + audio engine + UI would all leak into a dead cell).
    if (instanceDisposed) return;
    if (!detail || !detail.resolution || detail.resolution.ok === false) {
        const error = detail?.resolution?.error || detail?.error || new Error('Invalid session resolution payload');
        throw error;
    }

    const previousResolution = lastResolvedSession;

    const { resolution, descriptor } = detail;
    const changedHints = new Set(
        Array.isArray(detail.changed)
            ? detail.changed
                  .map((entry) =>
                      (typeof entry === 'string' ? entry.trim() : String(entry ?? '')).trim(),
                  )
                  .filter(Boolean)
            : [],
    );
    let combined = {
        track: resolution.track ?? null,
        orbiter: resolution.orbiter ?? null,
        entangledWorld: resolution.entangledWorld ?? null,
        trackUserSettings:
            resolution.trackUserSettings
            ?? resolution.combined?.trackUserSettings
            ?? null,
    };

    // The world-into-track nesting now happens inside the assembler
    // (`nestEntangledWorldIntoTrack` at the combined-build), so `resolution.track`
    // already carries `track.entangledWorld` on every path — Main.js no longer re-patches.

    const trackId =
        combined.track?.trackId ||
        descriptor?.trackId ||
        (INITIAL_WORLD_MODE === 'edit' ? DEFAULT_EDIT_TRACK_ID : DEFAULT_PLAY_TRACK_ID);

    if (trackId) {
        Constants.setTrackData(trackId, combined);
    }

    combined = await dataManager.attachTrackUserSettings(combined, trackId);
    if (instanceDisposed) return;

    if (trackId) {
        Constants.setTrackData(trackId, combined);
    }

    const designDefaults = deriveDesignDefaultsFromCombined(combined, {});
    const mappingDefaults = deriveMappingDefaultsFromCombined(combined, {});
    const stacksDefaults = deriveStacksDefaultsFromCombined(combined, null);
    const stackSelection =
        combined.orbiter?.stackSelection ||
        combined.orbiter?.selection ||
        null;

    const stubOrbiter = createStubOrbiterFromCombined(combined, { stacksDefaults });
    const hasPlayableAudio = Boolean(
        combined.track?.audioFileMP3URL || combined.track?.audioFileWAVURL,
    );

    const worldModeKey = INITIAL_WORLD_MODE;
    const graphicsPreference = descriptor?.graphicsPreference || INITIAL_GRAPHICS_PREFERENCE;
    const graphicsProfileKey =
        normalizeGraphicsPresetKey(graphicsPreference) || INITIAL_GRAPHICS_PRESET_KEY;
    const graphicsProfile =
        graphicsProfileKey === INITIAL_GRAPHICS_PRESET_KEY
            ? INITIAL_GRAPHICS_PROFILE
            : getGraphicsPresetByKey(graphicsProfileKey);

    const audioProfileKey =
        normalizeAudioPerformanceKey(descriptor?.audioProfile) || activeAudioProfileKey;
    const audioProfile =
        audioProfileKey === activeAudioProfileKey
            ? activeAudioProfile
            : getAudioPerformancePresetByKey(audioProfileKey);

    if (graphicsProfileKey !== activeGraphicsProfileKey) {
        worldController.updatePerformanceProfile(graphicsProfile);
        updateOscilloscopePerformanceProfile(oscilloscope, graphicsProfile);
    }
    activeGraphicsProfileKey = graphicsProfileKey;
    activeGraphicsProfile = graphicsProfile;
    activeEffectVisualSettings = resolveEffectVisualSettings(graphicsProfile);
    monitorHydration.setIntervalMs(graphicsProfile.uiMonitorThrottleMs);
    if (typeof window !== 'undefined') {
        window.__orbitersGraphicsProfile = {
            key: activeGraphicsProfileKey,
            config: activeGraphicsProfile,
        };
        window.__orbitersAudioProfile = {
            key: audioProfileKey,
            config: audioProfile,
        };
    }

    activeAudioProfileKey = audioProfileKey;
    activeAudioProfile = audioProfile;
    syncFeedbackThrottleToAudioProfile(audioProfileKey);
    persistAudioPerformanceKey(audioProfileKey);

    const worldModeArgs = {
        trackData: combined,
        graphicsPreference,
        graphicsProfile,
        audioProfile,
        designDefaults,
        mappingDefaults,
        stacksDefaults,
        stubOrbiter,
    };

	    const audioEngineOptions = {
	        trackData: combined,
	        engineConfig: stubOrbiter?.orbiterData,
	        userManager: parameterManager,
	        performanceProfile: audioProfile,
	        // Null in single-orbiter (adapter owns its limiter → Destination); the shared
	        // master bus + shared transport when this voice is part of a multi-orbiter view.
	        outputNode,
	        transport,
	        // This voice's deck — the adapter seeds it from trackData and reads tempo/sync from it.
	        deck,
    };

    const previousTrackId =
        previousResolution?.track?.trackId ??
        previousResolution?.request?.trackId ??
        null;
    const previousTrackVersion =
        previousResolution?.track?.version ??
        previousResolution?.request?.trackVersion ??
        null;
    const previousOrbiterId =
        previousResolution?.orbiter?.orbiterId ??
        previousResolution?.request?.orbiterId ??
        null;
    const previousOrbiterVersion =
        previousResolution?.orbiter?.version ??
        previousResolution?.request?.orbiterVersion ??
        null;
    const previousWorldId =
        previousResolution?.entangledWorld?.worldId ??
        previousResolution?.request?.entangledWorldId ??
        null;
    const previousWorldVersion =
        previousResolution?.entangledWorld?.version ??
        previousResolution?.request?.entangledWorldVersion ??
        null;

    const nextTrackId = combined.track?.trackId ?? descriptor?.trackId ?? null;
    const nextTrackVersion = combined.track?.version ?? descriptor?.trackVersion ?? null;
    const nextOrbiterId = combined.orbiter?.orbiterId ?? descriptor?.orbiterId ?? null;
    const nextOrbiterVersion = combined.orbiter?.version ?? descriptor?.orbiterVersion ?? null;
    const nextWorldId = combined.entangledWorld?.worldId ?? descriptor?.entangledWorldId ?? null;
    const nextWorldVersion =
        combined.entangledWorld?.version ?? descriptor?.entangledWorldVersion ?? null;

    const trackChanged =
        !previousResolution ||
        previousTrackId !== nextTrackId ||
        (previousTrackVersion ?? null) !== (nextTrackVersion ?? null);

    const orbiterChanged =
        trackChanged ||
        changedHints.has('orbiterRelease') ||
        changedHints.has('orbiterSession') ||
        previousOrbiterId !== nextOrbiterId ||
        (previousOrbiterVersion ?? null) !== (nextOrbiterVersion ?? null);

    const worldHintChanged =
        changedHints.has('entangledWorldRelease') ||
        changedHints.has('entangledWorldSession') ||
        changedHints.has('entangledWorld') ||
        changedHints.has('entangledWorldId') ||
        changedHints.has('world') ||
        changedHints.has('worldId');

    const worldChanged =
        worldHintChanged ||
        previousWorldId !== nextWorldId ||
        (previousWorldVersion ?? null) !== (nextWorldVersion ?? null);

    const reuseAudioEngine =
        Boolean(audioEngine) && !trackChanged && !orbiterChanged && worldChanged;

    await initializeBaseFlow({
        worldModeKey,
        worldModeArgs,
        trackData: combined,
        entangledWorld: combined.entangledWorld,
        audioEngineOptions,
        skipAudioPreload: worldModeKey === 'edit' ? !hasPlayableAudio : false,
        mappingDefaults,
        stacksDefaults,
        stackSelection,
        designDefaults,
        reuseAudioEngine,
    });

    if (instanceDisposed) return;

    syncUsageEventsPlaybackListener();

    lastResolvedSession = resolution;

    loadProgress.setStep('uiReady', true);
    if (ownsGlobalLoadingScreen) {
        hideLoadingScreen();
    }

    // React UI shell — the only UI. Mounted here, after the engine + root params
    // (incl. premix-deck-i) are ready.
    await ensureReactUIMounted();
    loadProgress.done();
    settleReady({ ok: true });
}

async function handleSessionReady(event) {
    // The session resolve that raised this is not cancellable, so it can land after the voice was
    // removed from its stage. A disposed instance does nothing.
    if (instanceDisposed) return;
    const detail = event?.detail || {};
    // Voice isolation is BUS privacy, not a descriptor filter: each multi voice owns a private
    // `eventBus` (an EventTarget of its own), so another voice's session events never reach this
    // handler; single-orbiter listens on `window` but is the only voice there. A construction-time
    // trackId filter here would wrongly drop a legitimate in-place track swap (the studio can load a
    // different track onto a live voice), so no such guard exists — `sessionDescriptor` only seeds
    // the boot and getTrackId.
    usageEvents.handleSessionReady(detail);
    const signature = detail.descriptor ? sessionDescriptorSignature(detail.descriptor) : null;

    if (signature && signature === lastSessionSignature && detail.cached) {
        return;
    }

    const run = async () => {
        await bootstrapFromResolution(detail);
        if (signature) {
            lastSessionSignature = signature;
        }
    };

    if (pendingSessionLoad) {
        pendingSessionLoad = pendingSessionLoad.then(run, run);
    } else {
        pendingSessionLoad = run();
    }

    try {
        await pendingSessionLoad;
    } catch (error) {
        console.error('[APP] Failed to bootstrap session:', error);
        // A resolved session whose bootstrap throws (e.g. the world GLB 404s after
        // retries) must settle this voice NOW — otherwise the tile spins for the full boot
        // deadline and holds a realm boot slot for nothing.
        loadProgress.fail(error);
        settleReady({ ok: false, error });
    } finally {
        pendingSessionLoad = null;
    }
}

async function handleSessionError(event) {
    // Same in-flight-resolve race as handleSessionReady, and worse: this path bootstraps the edit-mode
    // FALLBACK (a stub orbiter with its own theme), so a dead voice would paint a second, differently
    // coloured interface into a stage the user already cleared.
    if (instanceDisposed) return;
    const detail = event?.detail || {};
    usageEvents.handleSessionFailed(detail);
    const descriptor = detail.descriptor || {};
    const error = detail.error || detail;
    console.error('[APP] Session resolution failed:', error, descriptor);
    // Surface the failure on this voice's channel (multi tile shows an error state).
    // If the fallback bootstrap below completes, the progress steps complete too and the tile
    // overlay clears itself — the error state is only terminal when recovery also fails.
    loadProgress.fail(error);

    lastSessionSignature = null;
    pendingSessionLoad = null;
    sessionManager.resetSignature();
    lastResolvedSession = null;
    if (typeof usageEventsPlaybackUnsubscribe === 'function') {
        usageEventsPlaybackUnsubscribe();
        usageEventsPlaybackUnsubscribe = null;
    }

    const fallbackTrackId =
        descriptor.trackId ||
        (INITIAL_WORLD_MODE === 'edit' ? DEFAULT_EDIT_TRACK_ID : DEFAULT_PLAY_TRACK_ID);

    const fallback = buildEditModeFallback({ trackId: fallbackTrackId });
    const stacksDefaultsClone = cloneStacksState(fallback.stacksDefaults);
    const stubOrbiter = createFallbackStubOrbiter(fallback.combined, { stacksDefaults: stacksDefaultsClone });

    await initializeBaseFlow({
        worldModeKey: INITIAL_WORLD_MODE,
        worldModeArgs: {
            trackData: fallback.combined,
            graphicsPreference: INITIAL_GRAPHICS_PREFERENCE,
            designDefaults: fallback.designDefaults,
            mappingDefaults: fallback.mappingDefaults,
            stacksDefaults: stacksDefaultsClone,
            stubOrbiter,
        },
        trackData: fallback.combined,
        entangledWorld: fallback.combined?.entangledWorld ?? null,
	        audioEngineOptions: {
	            trackData: fallback.combined ?? null,
	            engineConfig: stubOrbiter?.orbiterData ?? null,
	            userManager: parameterManager,
	            outputNode,
	            transport,
	            // This voice's deck — the adapter seeds it from trackData and reads tempo/sync from it.
	            deck,
	        },
        skipAudioPreload: INITIAL_WORLD_MODE === 'edit'
            ? !(fallback.combined?.track?.audioFileMP3URL || fallback.combined?.track?.audioFileWAVURL)
            : false,
        mappingDefaults: fallback.mappingDefaults,
        stacksDefaults: stacksDefaultsClone,
        stackSelection: fallback.combined?.orbiter?.stackSelection || null,
        designDefaults: fallback.designDefaults,
    });

    if (instanceDisposed) return;

    loadProgress.setStep('uiReady', true);
    if (ownsGlobalLoadingScreen) {
        hideLoadingScreen();
    }

    // Same React-UI shell mount for the edit-mode fallback bootstrap path.
    await ensureReactUIMounted();
    loadProgress.done();
    settleReady({ ok: true, fallback: true });
}

/**
 * Mount the React UI shell once the engine is ready. React is the only UI, so this
 * always mounts; the dynamic import is just a code-split boundary. Idempotent —
 * `mountOrbitersUI` re-mounts cleanly on re-bootstrap. A mount failure is logged
 * loudly (there is no legacy UI to fall back to).
 */
async function ensureReactUIMounted() {
    // A voice with mountChrome:false renders its 3D scene only (no UI).
    if (!mountChrome || instanceDisposed) return;
    try {
        const { mountOrbitersUI } = await import('./ui/react/mountOrbitersUI.tsx');
        // The instance can be disposed across this import. `uiContainer` is a grid cell that OUTLIVES
        // the voice (the slot layout owns it, so the compositor leaves it in place), and dispose has
        // already run its one unmount — so a root mounted now would never be torn down.
        if (instanceDisposed) return;
        // Single-orbiter mounts to <body> with no voiceId (byte-identical). A multi tile
        // passes its cell + voiceId so the UI fills that tile and reads ITS OWN voice's engine; the
        // primary tile owns the realm-global UI side effects. Keep the handle so dispose unmounts it.
        reactUIHandle = mountOrbitersUI({
            parameterManager,
            container: uiContainer ?? undefined,
            voiceId: uiContainer ? voiceId : undefined,
            isPrimary,
        });
    } catch (error) {
        console.error('[APP] Failed to mount React UI shell:', error);
    }
}

function buildSnapshotFromBridgeDetail(detail = {}) {
    const payload = detail.payload && typeof detail.payload === 'object' ? detail.payload : {};
    const session = detail.session && typeof detail.session === 'object' ? detail.session : {};
    const hydrated = session.hydratedBlobs && typeof session.hydratedBlobs === 'object'
        ? session.hydratedBlobs
        : {};
    const changedRaw = detail.changed || payload.changed || session.changed || [];
    const changed = Array.isArray(changedRaw)
        ? changedRaw
              .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry ?? '')).trim())
              .filter(Boolean)
        : [];

    const sessionId = sanitizeId(
        payload.sessionId ??
            session.sessionId ??
            session.requested?.sessionId ??
            session.resolved?.sessionId ??
            null,
    );

    return {
        sessionId,
        trackRelease: payload.trackRelease ?? payload.trackSession ?? hydrated.trackSession ?? null,
        orbiterRelease: payload.orbiterRelease ?? payload.orbiterSession ?? hydrated.orbiterSession ?? null,
        entangledWorldRelease:
            payload.entangledWorldRelease ??
            payload.entangledWorldSession ??
            hydrated.entangledWorldSession ??
            null,
        status: payload.status ?? session.status ?? null,
        warnings: payload.warnings ?? session.warnings ?? [],
        changed,
    };
}

function interceptPlaybackSessionLoad(event) {
    if (!playbackLoader) {
        return;
    }
    const detail = event.detail || {};
    const snapshot = buildSnapshotFromBridgeDetail(detail);
    const source = detail.payload?.source || detail.session?.source || 'host-load';
    // A studio swap is an explicit live-descriptor load — never a session-id playback load. Return
    // before the sessionId check so a session id left behind by an earlier playback load can't
    // hijack the swap into `loadBySessionId` (the id is a module-global shared across voices).
    if (source === 'studio-swap') {
        return;
    }
    const hasEmbeddedSnapshot =
        snapshot.trackRelease || snapshot.orbiterRelease || snapshot.entangledWorldRelease;
    const sessionId =
        snapshot.sessionId || lastResolvedSession?.raw?.sessionId || Constants.SESSION_ID || null;
    const rawBase = lastResolvedSession?.raw ?? null;

    // Only intercept for Playback Loader if we have a Session ID (Historical/Playback Mode).
    // If we have blobs but no Session ID, it's likely a Live/Edit load, which sessionController handles.
    if (sessionId) {
        event.stopImmediatePropagation();
        void playbackLoader.loadBySessionId(sessionId, {
            source,
            changed: snapshot.changed,
            rawBase,
        });
        return;
    }

    // Fallback: If it's a pure snapshot (no ID) but explicitly marked as playback source, we might want to intercept.
    // But for 'host-load', we let it fall through to sessionController.
    if (hasEmbeddedSnapshot && source === 'playback-session') {
        event.stopImmediatePropagation();
        void playbackLoader.loadFromSnapshot(snapshot, {
            source,
            sessionId: null,
            changed: snapshot.changed,
            rawBase,
        });
        return;
    }

    // Otherwise, let the event propagate to sessionController

}

function interceptPlaybackSessionUpdate(event) {
    if (!playbackLoader) {
        return;
    }
    const detail = event.detail || {};
    const snapshot = buildSnapshotFromBridgeDetail(detail);
    const source = detail.payload?.source || detail.session?.source || 'host-update';
    const sessionId =
        snapshot.sessionId || lastResolvedSession?.raw?.sessionId || Constants.SESSION_ID || null;
    const rawBase = lastResolvedSession?.raw ?? null;
    const mergeBase = rawBase
        ? {
              ...rawBase,
              track: lastResolvedSession?.track ?? rawBase.track ?? null,
              orbiter: lastResolvedSession?.orbiter ?? rawBase.orbiter ?? null,
              entangledWorld: lastResolvedSession?.entangledWorld ?? rawBase.entangledWorld ?? null,
          }
        : {
              track: lastResolvedSession?.track ?? null,
              orbiter: lastResolvedSession?.orbiter ?? null,
              entangledWorld: lastResolvedSession?.entangledWorld ?? null,
          };

    // Fill missing blobs from the last resolved snapshot so we can apply partial updates
    const mergedSnapshot = {
        ...snapshot,
        trackRelease:
            snapshot.trackRelease ??
            snapshot.trackSession ??
            mergeBase?.trackRelease ??
            mergeBase?.trackSession ??
            null,
        orbiterRelease:
            snapshot.orbiterRelease ??
            snapshot.orbiterSession ??
            mergeBase?.orbiterRelease ??
            mergeBase?.orbiterSession ??
            null,
        entangledWorldRelease:
            snapshot.entangledWorldRelease ??
            snapshot.entangledWorldSession ??
            mergeBase?.entangledWorldRelease ??
            mergeBase?.entangledWorldSession ??
            null,
    };

    const hasEmbeddedSnapshot =
        mergedSnapshot.trackRelease ||
        mergedSnapshot.orbiterRelease ||
        mergedSnapshot.entangledWorldRelease;

    const hasTrack = mergedSnapshot.trackRelease || mergedSnapshot.trackSession || null;

    if (hasTrack) {
        event.stopImmediatePropagation();
        void playbackLoader.loadFromSnapshot(mergedSnapshot, {
            source,
            sessionId,
            changed: snapshot.changed,
            rawBase: mergeBase,
        });
        return;
    }

    if (sessionId) {
        event.stopImmediatePropagation();
        const hydratedBlobs = {
            trackSession: snapshot.trackRelease ?? snapshot.trackSession ?? null,
            orbiterSession: snapshot.orbiterRelease ?? snapshot.orbiterSession ?? null,
            entangledWorldSession: snapshot.entangledWorldRelease ?? snapshot.entangledWorldSession ?? null,
        };
        void playbackLoader.loadBySessionId(sessionId, {
            source,
            changed: snapshot.changed,
            rawBase: mergeBase,
            hydratedBlobs,
        });
    } else {
        console.warn('[Main] session-update ignored: missing sessionId and no embedded snapshot');
    }
}

async function requestInitialSession({ fallbackTrackId }) {
    const bootstrap = buildBootstrapSessionDescriptor({ fallbackTrackId });
    bootstrap.trackId = bootstrap.requested?.trackId ?? null;
    bootstrap.trackVersion = bootstrap.requested?.trackVersion ?? null;
    bootstrap.orbiterId = bootstrap.requested?.orbiterId ?? null;
    bootstrap.orbiterVersion = bootstrap.requested?.orbiterVersion ?? null;
    bootstrap.entangledWorldId = bootstrap.requested?.entangledWorldId ?? null;
    bootstrap.entangledWorldVersion = bootstrap.requested?.entangledWorldVersion ?? null;

    
    const directPayload = getDirectPayloadFromURL(INITIAL_URL_PARAMS);
    const directDescriptor = directPayload
        ? deriveDescriptorFromHydratedPayload(directPayload)
        : null;

    const initialSignatureSeed =
        (directDescriptor && directDescriptor.trackId) ? directDescriptor : (bootstrap.requested || {});

    sessionManager.setInitialSignature(initialSignatureSeed, INITIAL_SESSION_ID ?? null);
    sessionManager.installSessionListeners();
    if (eventBus) {
        eventBus.addEventListener('orbiters:session-ready', handleSessionReady, { passive: true });
        eventBus.addEventListener('orbiters:session-error', handleSessionError);
    }

    if (INITIAL_SESSION_ID) {
        const playbackResult = await playbackLoader.loadBySessionId(INITIAL_SESSION_ID, {
            source: 'playback-session:url',
        });
        if (playbackResult.ok) {
            return;
        }
    }

    if (directPayload) {
        const snapshot = {
            sessionId: null,
            trackRelease: directPayload.trackSession,
            orbiterRelease: directPayload.orbiterSession,
            entangledWorldRelease: directPayload.entangledWorldSession,
        };
        const directResult = await playbackLoader.loadFromSnapshot(snapshot, {
            source: 'hydrated-url',
        });
        if (directResult.ok) {
            return;
        }
    }

    if (INITIAL_SESSION_SOURCE === 'host' && IS_IFRAME) {
        return;
    }

    await sessionManager.processSessionRequest(bootstrap, 'app-init');
}

// The multi-orbiter shell drives these (single-orbiter ignores them — its own
// installed lifecycle handlers call the same closures). suspend/resume mirror the visibilitychange
// branch; dispose tears down this voice's own resources (adapter + visuals).
function suspend() {
    suspendVisualResources();
}
function resume() {
    resumeVisualResources();
    try { startToneContext(); } catch {}
    void audioEngine?.resumeAfterInterruption?.();
}
function dispose() {
    disposeOrbiterInstance({ reason: 'shell' });
}

// Expose `worldController` so the multi-orbiter voice factory can register this voice's
// scene+camera with the ViewportCompositor (single-orbiter callers simply ignore it).
return { start, parameterManager, voiceId, worldController, suspend, resume, dispose, whenReady };
}
