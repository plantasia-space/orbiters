/**
 * @file src/config/Constants.js
 * @description Shared constants, feature flags, and helper setters used across the Orbiters runtime.
 */

// Utility helpers -----------------------------------------------------------

function buildCacheKey(prefix, id, version) {
    if (!id || typeof id !== 'string') {
        throw new Error('Invalid cache key id. Must be a string.');
    }
    return version ? `${prefix}${id}@${version}` : `${prefix}${id}`;
}

function extractIdFromCacheKey(prefix, key) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) {
        return null;
    }
    const payload = key.slice(prefix.length);
    const versionMarker = payload.indexOf('@');
    return versionMarker >= 0 ? payload.slice(0, versionMarker) : payload;
}

/**
 * @file constants.js
 * @description Defines and manages application-wide constants and utility functions.
 * Handles caching mechanisms and prioritization for various controller types.
 * @version 2.0.0
 * @date 2024-12-18
 */

/**
 * Checks if the current environment supports sensors.
 * @returns {boolean} - True if DeviceMotion or DeviceOrientation APIs are available.
 */
export const SENSORS_SUPPORTED = () => {
    return typeof DeviceMotionEvent !== 'undefined' || typeof DeviceOrientationEvent !== 'undefined';
};

/**
 * Detects if the current device is a mobile device.
 * @returns {boolean} - True if the device is mobile, false otherwise.
 */
export const isMobileDevice = () => {
    return typeof navigator !== 'undefined' &&
        /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
};

/**
 * Determines if internal sensors are usable based on device type and sensor support.
 * @constant
 * @type {boolean}
 */
export const INTERNAL_SENSORS_USABLE = SENSORS_SUPPORTED() && isMobileDevice();

/**
 * Determines if external sensors can be connected. Defaults to desktop devices.
 * @constant
 * @type {boolean}
 */
export let EXTERNAL_SENSORS_USABLE = !isMobileDevice(); // Default to true for desktop
/**
 * Dynamically updates the usability of external sensors (e.g., WebSocket connected).
 * @param {boolean} status - True if external sensors are connected, false otherwise.
 */
export function setExternalSensorsUsable(status) {
    EXTERNAL_SENSORS_USABLE = status;
    //console.log(`[SENSORS] External Sensors Usable: ${EXTERNAL_SENSORS_USABLE}`);
}

/**
 * Checks if any sensors (internal or external) are usable.
 * @constant
 * @type {boolean}
 */
export const SENSORS_USABLE = INTERNAL_SENSORS_USABLE || EXTERNAL_SENSORS_USABLE;

/**
 * Indicates whether the browser supports the Web MIDI API.
 * @constant
 * @type {boolean}
 */
export const MIDI_SUPPORTED = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

// Throttle values optimized for sensor and MIDI feedback
// LOW = best quality (faster updates), HIGH = power saving (slower updates)
export const THROTTLE_LOW_MS = 33;  // 30 FPS - Best quality
export const THROTTLE_MID_MS = 50;  // 20 FPS - Balanced
export const THROTTLE_HIGH_MS = 66; // 15 FPS - Power saving

export let PERFORMANCE_THROTTLE_MS = THROTTLE_MID_MS;
export let MIDI_FEEDBACK_THROTTLE_MS = THROTTLE_MID_MS;
export let SENSOR_FEEDBACK_THROTTLE_MS = THROTTLE_MID_MS;

/**
 * Updates every shared feedback throttle (MIDI, sensors, etc.) so they stay in
 * lockstep with the active performance preset.
 * @param {number} nextThrottleMs
 * @returns {number} The sanitized throttle value that was stored.
 */
export function setPerformanceThrottleMs(nextThrottleMs) {
    const sanitized = Number.isFinite(nextThrottleMs) && nextThrottleMs >= 0 ? nextThrottleMs : THROTTLE_MID_MS;
    if (
        PERFORMANCE_THROTTLE_MS === sanitized &&
        MIDI_FEEDBACK_THROTTLE_MS === sanitized &&
        SENSOR_FEEDBACK_THROTTLE_MS === sanitized
    ) {
        return sanitized;
    }
    PERFORMANCE_THROTTLE_MS = sanitized;
    MIDI_FEEDBACK_THROTTLE_MS = sanitized;
    SENSOR_FEEDBACK_THROTTLE_MS = sanitized;
    return sanitized;
}

/**
 * @namespace Constants
 * @description A collection of application-wide constants and utility functions for track data caching.
 */
export const Constants = {
    /**
     * @type {string}
     * @description Default track ID used for playback flows when none is specified.
     */
    DEFAULT_PLAY_TRACK_ID: import.meta.env?.VITE_DEFAULT_PLAY_TRACK_ID,

    /**
     * @type {string}
     * @description Default track ID used for edit flows when none is specified. Acts as a sentinel for local fallbacks.
     */
    DEFAULT_EDIT_TRACK_ID: import.meta.env?.VITE_DEFAULT_EDIT_TRACK_ID,
    /**
     * @type {string}
     * @description Default entangled world ID used for edit flows when none is specified.
     */
    DEFAULT_EDIT_WORLD_ID: import.meta.env?.VITE_DEFAULT_EDIT_WORLD_ID,

    /** 
     * @type {number}
     * @description Duration in minutes after which cached data expires.
     * Reduced to keep signed asset URLs fresh.
     */
    CACHE_EXPIRY_MINUTES: 3,

    /**
     * Cache prefixes for release data stored within in-memory maps.
     */
    TRACK_CACHE_PREFIX: 'trackRelease:',
    ORBITER_CACHE_PREFIX: 'orbiterRelease:',
    WORLD_CACHE_PREFIX: 'worldRelease:',
    CONFIG_CACHE_PREFIX: 'configSnapshot:',

    ROOT_BASE: (() => {
        const sanitize = (value) => (typeof value === 'string' ? value.replace(/\/+$/, '') : '');
        let envBase;
        try {
            envBase = import.meta.env?.VITE_ROOT_BASE;
        } catch (error) {
            envBase = undefined;
        }

        const candidates = [
            envBase,
            typeof window !== 'undefined' ? window.VITE_ROOT_BASE : undefined,
            typeof window !== 'undefined' ? window.ROOT_BASE : undefined,
            typeof window !== 'undefined' ? window.__ROOT_BASE__ : undefined,
            typeof window !== 'undefined' ? window.location?.origin : undefined,
        ];

        const match = candidates.find((value) => typeof value === 'string' && value.trim().length);
        return sanitize(match || '');
    })(),

    /**
     * In-memory mirrors for quick access to release data.
     */
    _trackReleases: new Map(),
    _orbiterReleases: new Map(),
    _worldReleases: new Map(),
    _configSnapshots: new Map(),



        /** 
     * Centralized loading state for tracking application initialization.
     */
        LOADING_STATE: {
            trackLoaded: false,
            orbiterLoaded: false,
            modelLoaded: false,
            uiReady: false,
        },
    
        /**
         * Updates the loading state and calls updateLoadingScreen().
         * Ensures that only valid keys are updated.
         * @param {string} key - The loading step (e.g., "trackLoaded").
         * @param {boolean} value - True if the step is completed.
         */
        setLoadingState(key, value) {
            if (this.LOADING_STATE.hasOwnProperty(key)) {
                this.LOADING_STATE[key] = value;
                if (typeof document !== 'undefined' && document.body) {
                    document.body.setAttribute(
                        'data-ui-ready',
                        this.LOADING_STATE.uiReady ? 'true' : 'false',
                    );
                }
                if (typeof window !== 'undefined' && typeof window.updateLoadingScreen === 'function') {
                    window.updateLoadingScreen(); // Automatically update the loading screen
                }
            } else {
                console.warn(`[Constants] Attempted to set unknown loading state: ${key}`);
            }
        },
    
        /**
         * Retrieves the current loading state.
         * @returns {object} The current state of all loading steps.
         */
        getLoadingState() {
            return this.LOADING_STATE;
        },

        
    /**
     * Sets and caches track data for the specified trackId.
     * @param {string} trackId - The unique identifier for the track.
     * @param {object} trackData - The data object containing track information.
     * @throws Will throw an error if `trackId` is not a valid string.
     */
    setTrackData(trackId, trackData) {
        if (!trackId || typeof trackId !== 'string') {
            throw new Error('Invalid trackId. Must be a string.');
        }
        const configKey = this.buildConfigKey({
            trackId,
            orbiterId: trackData?.orbiter?.orbiterId || null,
            entangledWorldId: trackData?.entangledWorld?.worldId || null,
        });
        this.setCurrentConfig(configKey, trackData);
    },

    setCurrentConfig(configKey, configData) {
        if (!configKey || typeof configKey !== 'string') {
            throw new Error('Invalid configKey. Must be a string.');
        }
        // The keyed snapshot Map is the SOLE store — no single-current TRACK_DATA pointer.
        // Two voices showing the same track share this snapshot; identity lives per-voice on each
        // voice's DataManager (currentConfigKey / activeConfigRequest.trackId).
        // Delete-then-set so re-setting an existing key moves it to the END of insertion order — this
        // makes it the most-recently-used, which trimConfigSnapshots (oldest-first eviction) keeps.
        this._configSnapshots.delete(configKey);
        this._configSnapshots.set(configKey, configData);
    },

    getCurrentConfig(configKey) {
        if (!configKey || typeof configKey !== 'string') {
            throw new Error('Invalid configKey. Must be a string.');
        }
        return this._configSnapshots.has(configKey)
            ? this._configSnapshots.get(configKey)
            : null;
    },

    /**
     * Resolve the cached combined config for a trackId, regardless of which orbiter/world it is keyed
     * under (configKeys are `trackId|orbiterId|worldId|…`). Replaces the old single-current TRACK_DATA
     * fallback that `getTrackData` relied on when the orbiter/world were non-default. Returns the first
     * matching snapshot (single-orbiter has exactly one).
     * @param {string} trackId
     * @returns {object|null}
     */
    getConfigByTrackId(trackId) {
        if (!trackId || typeof trackId !== 'string') {
            return null;
        }
        const prefix = `${trackId}|`;
        for (const [key, value] of this._configSnapshots) {
            if (key === trackId || key.startsWith(prefix)) {
                return value;
            }
        }
        return null;
    },

    buildConfigKey({ trackId, orbiterId = null, entangledWorldId = null, version = null }) {
        if (!trackId) {
            throw new Error('trackId is required to build a config key.');
        }
        const parts = [trackId, orbiterId || 'default', entangledWorldId || 'default'];
        if (version) {
            parts.push(String(version));
        }
        return parts.join('|');
    },

    setTrackRelease(trackId, release, { version = null } = {}) {
        const key = buildCacheKey(this.TRACK_CACHE_PREFIX, trackId, version);
        this._trackReleases.set(key, release);
        return release;
    },

    getTrackRelease(trackId, { version = null } = {}) {
        const key = buildCacheKey(this.TRACK_CACHE_PREFIX, trackId, version);
        if (this._trackReleases.has(key)) {
            return this._trackReleases.get(key);
        }
        return null;
    },

    setOrbiterRelease(orbiterId, release, { version = null } = {}) {
        const key = buildCacheKey(this.ORBITER_CACHE_PREFIX, orbiterId, version);
        this._orbiterReleases.set(key, release);
        return release;
    },

    getOrbiterRelease(orbiterId, { version = null } = {}) {
        const key = buildCacheKey(this.ORBITER_CACHE_PREFIX, orbiterId, version);
        if (this._orbiterReleases.has(key)) {
            return this._orbiterReleases.get(key);
        }
        return null;
    },

    setWorldRelease(worldId, release, { version = null } = {}) {
        const key = buildCacheKey(this.WORLD_CACHE_PREFIX, worldId, version);
        this._worldReleases.set(key, release);
        return release;
    },

    getWorldRelease(worldId, { version = null } = {}) {
        const key = buildCacheKey(this.WORLD_CACHE_PREFIX, worldId, version);
        if (this._worldReleases.has(key)) {
            return this._worldReleases.get(key);
        }
        return null;
    },

    /**
     * Retrieves cached track data for the specified trackId.
     * @param {string} trackId - The unique identifier for the track.
     * @returns {object|null} - Returns the cached track data or null if not found.
     * @throws Will throw an error if `trackId` is not a valid string.
     */
    getTrackData(trackId) {
        if (!trackId || typeof trackId !== 'string') {
            throw new Error('Invalid trackId. Must be a string.');
        }
        // Resolve from the keyed snapshot cache by trackId (any orbiter/world variant). The exact
        // `trackId|default|default` key is checked first as a fast path.
        const defaultKey = this.buildConfigKey({ trackId });
        if (this._configSnapshots.has(defaultKey)) {
            return this._configSnapshots.get(defaultKey);
        }
        const byTrack = this.getConfigByTrackId(trackId);
        if (byTrack) {
            return byTrack;
        }
        console.warn(`[CACHE] No track data found for trackId: ${trackId}`);
        return null;
    },

    /**
     * Clears cached data for the specified trackId.
     * @param {string} trackId - The unique identifier for the track.
     * @throws Will throw an error if `trackId` is not a valid string.
     */
    clearTrackData(trackId) {
        if (!trackId || typeof trackId !== 'string') {
            throw new Error('Invalid trackId. Must be a string.');
        }
        // Drop every cached snapshot for this trackId (any orbiter/world variant).
        const prefix = `${trackId}|`;
        for (const key of [...this._configSnapshots.keys()]) {
            if (key === trackId || key.startsWith(prefix)) {
                this._configSnapshots.delete(key);
            }
        }
    },

    clearStaleReleaseCaches({ trackIds = null, orbiterIds = null, worldIds = null } = {}) {
        const retainTracks = trackIds instanceof Set ? trackIds : new Set(trackIds || []);
        const retainOrbiters = orbiterIds instanceof Set ? orbiterIds : new Set(orbiterIds || []);
        const retainWorlds = worldIds instanceof Set ? worldIds : new Set(worldIds || []);

        if (retainTracks.size) {
            for (const key of this._trackReleases.keys()) {
                const id = extractIdFromCacheKey(this.TRACK_CACHE_PREFIX, key);
                if (id && !retainTracks.has(id)) {
                    this._trackReleases.delete(key);
                }
            }
        }

        if (retainOrbiters.size) {
            for (const key of this._orbiterReleases.keys()) {
                const id = extractIdFromCacheKey(this.ORBITER_CACHE_PREFIX, key);
                if (id && !retainOrbiters.has(id)) {
                    this._orbiterReleases.delete(key);
                }
            }
        }

        if (retainWorlds.size) {
            for (const key of this._worldReleases.keys()) {
                const id = extractIdFromCacheKey(this.WORLD_CACHE_PREFIX, key);
                if (id && !retainWorlds.has(id)) {
                    this._worldReleases.delete(key);
                }
            }
        }
    },

    trimConfigSnapshots(maxEntries = 24) {
        const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 24;
        if (this._configSnapshots.size <= limit) {
            return;
        }

        // Insertion-ordered eviction, oldest-first. setCurrentConfig re-inserts on every write, so the
        // most-recently-USED snapshots sit at the end and survive (LRU).
        const keys = Array.from(this._configSnapshots.keys());
        for (const key of keys) {
            if (this._configSnapshots.size <= limit) break;
            this._configSnapshots.delete(key);
        }
    },

    clearAllCaches() {
        this._trackReleases.clear();
        this._orbiterReleases.clear();
        this._worldReleases.clear();
        this._configSnapshots.clear();
    },
};


/**
 * @constant
 * @memberof CoreModule
 * @type {string}
 * @description Default track ID used across the application.
 */
export const DEFAULT_PLAY_TRACK_ID = Constants.DEFAULT_PLAY_TRACK_ID;
export const DEFAULT_EDIT_TRACK_ID = Constants.DEFAULT_EDIT_TRACK_ID;
export const DEFAULT_EDIT_WORLD_ID = Constants.DEFAULT_EDIT_WORLD_ID;

/**
 * @constant
 * @memberof CoreModule
 * @type {object}
 * @description Defines priority levels for various controller types.
 */
export const PRIORITY_MAP = {
    "MIDI": 1,
    "webaudio-knob": 2,
    "webaudio-slider": 3,
    "webaudio-switch": 4,
    "webaudio-numeric-keyboard": 5,
    "webaudio-param": 6,
    "webaudio-keyboard": 7,

    // NEW: Visual controllers inserted in priority
    "visual-x": 7.5,
    "visual-y": 8.5,
    "visual-z": 9.5,

    // Existing sensors
    "sensor-x": 8,
    "sensor-y": 9,
    "sensor-z": 10,
    "sensor-distance": 10.5,   // The 4th sensor axis, sits just below x/y/z, above cosmic

    // Cosmic LFOs (background modulations) — one per axis (x/y/z), below sensors.
    // Renamed from the stale cosmic-lfo-A/B/C slot keys (never wired; the LFO model
    // is per-axis, mirroring sensor-x/y/z) to the real axis names.
    "cosmic-x": 11,
    "cosmic-y": 12,
    "cosmic-z": 13,

    // 3D camera (orbit drag). Replaces the dead, never-read "orbit": 14 entry.
    // Direct user manipulation wins over modulation, so it sits at the top of the band;
    // an explicit recenter/reset wins over everything (priority 0).
    "camera": 1,
    "camera-reset": 0,
};
/**
 * @constant
 * @description Tracks the current playback state of the orbiter.
 */
export let PLAYBACK_STATE = "stopped"; // Can be "playing", "paused", "stopped"

/**
 * Updates the `PLAYBACK_STATE` global variable.
 * @param {string} state - The new playback state ("playing", "paused", "stopped").
 */
export function setPlaybackState(state) {
    if (["playing", "paused", "stopped"].includes(state)) {
        PLAYBACK_STATE = state;
        //console.log(`[Constants] Playback state updated: ${PLAYBACK_STATE}`);
    } else {
        console.warn(`[Constants] Invalid playback state: ${state}`);
    }
}

/**
 * Retrieves the current playback state.
 * @returns {string} The current playback state.
 */
export function getPlaybackState() {
    return PLAYBACK_STATE;
}

/**
 * @constant
 * @memberof CoreModule
 * @type {number}
 * @description Fallback priority value for undefined controller types.
 */
export const DEFAULT_PRIORITY = 100;

/**
 * Retrieves the priority for a given controller type.
 * Defaults to `DEFAULT_PRIORITY` if the type is not defined in `PRIORITY_MAP`.
 * @param {string} controllerType - The type of the controller (e.g., 'webaudio-knob').
 * @returns {number} - The priority value associated with the controller type.
 */
export function getPriority(controllerType) {
    // `??` not `||`: a priority of 0 is the HIGHEST (e.g. camera-reset) and must be respected,
    // not coerced to DEFAULT_PRIORITY as a falsy value.
    return PRIORITY_MAP[controllerType] ?? DEFAULT_PRIORITY;
}

/**
 * Generates and retrieves a persistent `uniqueId` for the desktop client.
 * Uses sessionStorage when available; falls back to an in-memory value otherwise.
 * @returns {string} - The persistent `uniqueId`.
 */
export function getUniqueId() {
    const UNIQUE_ID_KEY = 'uniqueId';
    let uniqueId = null;
    try {
        if (typeof window !== 'undefined' && window.sessionStorage) {
            uniqueId = window.sessionStorage.getItem(UNIQUE_ID_KEY);
            if (!uniqueId) {
                uniqueId = 'unique-' + Math.random().toString(36).substr(2, 16);
                window.sessionStorage.setItem(UNIQUE_ID_KEY, uniqueId);
            }
            return uniqueId;
        }
    } catch {
        // Ignore storage errors (e.g., Safari private mode)
    }

    if (!uniqueId) {
        uniqueId = 'unique-' + Math.random().toString(36).substr(2, 16);
    }

    return uniqueId;
}

/**
 * @constant
 * @type {string}
 * @description Persistent unique identifier for the desktop client.
 */
export const UNIQUE_ID = getUniqueId();

/**
 * @constant
 * @type {number}
 * @description Maximum number of effect modules per rack/dimension
 */
export const MAX_MODULES = 1;

const MODULE_LETTER_SEQUENCE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_MONITOR_VISIBLE_SLOTS = 2;

// DO NOT DELETE // 
//If you plan to support three-plus modules soon, expand the info-grid markup (and placeholder config) 
// so more than two label/value pairs per axis can exist; the new metadata hook will make that wiring 
// straightforward once the DOM can accommodate it.

/**
 * @constant
 * @type {{count: number, letters: string[]}}
 * @description Letters and count for monitor slots, capped to current UI capability.
 */
export const MONITOR_MODULE_SLOTS = Object.freeze((() => {
    const numericMax = Number(MAX_MODULES);
    const normalized = Number.isFinite(numericMax) && numericMax > 0 ? Math.floor(numericMax) : 1;
    const count = Math.max(1, Math.min(normalized, MAX_MONITOR_VISIBLE_SLOTS));
    return {
        count,
        letters: MODULE_LETTER_SEQUENCE.slice(0, count).split(''),
    };
})());

/**
 * @constant
 * @type {object}
 * @description Shared constraints for orbiter axis parameters (degrees).
 */
export const AXIS_ROTATION_CONSTRAINTS = Object.freeze({
    min: -180,
    max: 180,
    equilibrium: 0,
    step: 0.01
});

Constants.AXIS_ROTATION_CONSTRAINTS = AXIS_ROTATION_CONSTRAINTS;

/**
 * Logs sensor detection states for debugging.
 */
//console.log(`[SENSORS] Supported: ${SENSORS_SUPPORTED()}`);
//console.log(`[SENSORS] Internal Sensors Usable: ${INTERNAL_SENSORS_USABLE}`);
//console.log(`[SENSORS] External Sensors Usable: ${EXTERNAL_SENSORS_USABLE}`);
//console.log(`[SENSORS] Sensors Usable: ${SENSORS_USABLE}`);
