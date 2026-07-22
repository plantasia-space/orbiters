/**
 * @file index.js
 * @description Main DataManager facade that wires all modules together with a cohesive API.
 * @version 2.0.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2025-01-11
 */

import { Constants } from '../../config/Constants.js';
import { createLoadProgress } from '../../boot/loadProgress.js';
import { formatParameterDisplayValue } from '../../core/ParameterManager.js';
import { buildEditModeFallback } from '../../defaults/editModeFallback.js';
import { getWorldInteractionModeFromUrl } from '../../utils/urlParams.js';
import { fetchTrackUserSettings } from '../trackUserSettingsService.js';
import { assembleConfig, resetOrbiterFallbackNotification } from './assembler.js';
import { 
    fetchTrackRelease, 
    fetchOrbiterRelease, 
    fetchEntangledWorldRelease
} from './loaders.js';
import { 
    normalizeTrackRelease, 
    normalizeOrbiterRelease, 
    normalizeWorldRelease 
} from './normalizers.js';
import { loadFromHydratedSession } from './hydration.js';
import { 
    buildPlaceholderConfig, 
    populatePlaceholders, 
    clearPlaceholders,
    getParamValueFormatted 
} from './placeholders.js';
import { safeResolveSession, safeUpdateSession } from './sessionBridge.js';

// ============================================================================
// Configuration Request Resolution
// ============================================================================

/** Version pins carried on a config request, excluding the track's (which has an alias). */
const ENTITY_VERSION_KEYS = ['orbiterVersion', 'entangledWorldVersion'];

const isEmptyPin = (value) => value == null || value === '';

/**
 * Settle every version pin on a config request.
 *
 * Two rules, both of which were being broken:
 *
 * 1. A key the caller never MENTIONED keeps whatever the active request had. Deleting those too
 *    meant an override naming only `orbiterId` silently unpinned the track and dropped the voice
 *    back to the live release. Naming a key with null/'' is still a deliberate unpin.
 * 2. `version` is a legacy alias of `trackVersion` that the config cache key reads. They are
 *    settled as ONE value, so they cannot disagree — an alias left pointing at an old pin keyed
 *    the cache to a version nobody had asked for and served those bytes straight back.
 *
 * @param {object} params
 * @param {object} params.currentRequest the active request being overridden
 * @param {object} params.sanitizedOverrides overrides with `undefined` values already removed
 * @param {object} params.nextRequest the merged request, mutated in place
 * @returns {object} nextRequest
 */
/**
 * Settle `trackVersion` and its legacy `version` alias on a request that is NOT the result of an
 * override merge — a request resolved straight from the URL or a voice descriptor.
 *
 * Same single rule as `resolveRequestVersionPins`, so a request built on either path keys the
 * config cache identically. Folding the alias by hand at each call site is how the two drifted.
 *
 * @param {object} request mutated in place
 * @returns {object} request
 */
export function settleRequestVersionAlias(request) {
    if (!request) return request;
    // Key PRESENCE is deliberately left alone. A request resolved from the URL or a descriptor
    // carries an explicit `trackVersion: null` to mean "live", and downstream (assembleConfig,
    // buildConfigKey) is built around that shape — dropping the key would change it. Only the
    // two spellings are reconciled, in whichever direction carries the pin.
    if (!isEmptyPin(request.trackVersion)) {
        request.version = request.trackVersion;
    } else if (!isEmptyPin(request.version)) {
        request.trackVersion = request.version;
    }
    return request;
}

export function resolveRequestVersionPins({ currentRequest, sanitizedOverrides, nextRequest }) {
    ENTITY_VERSION_KEYS.forEach((key) => {
        if (key in sanitizedOverrides) {
            if (isEmptyPin(sanitizedOverrides[key])) delete nextRequest[key];
            return;
        }
        if (isEmptyPin(nextRequest[key])) delete nextRequest[key];
    });

    // `trackVersion` wins over `version` when an override names both.
    const namesTrackVersion =
        'trackVersion' in sanitizedOverrides || 'version' in sanitizedOverrides;
    const requested = namesTrackVersion
        ? ('trackVersion' in sanitizedOverrides
            ? sanitizedOverrides.trackVersion
            : sanitizedOverrides.version)
        : (currentRequest?.trackVersion ?? currentRequest?.version ?? null);

    if (isEmptyPin(requested)) {
        delete nextRequest.trackVersion;
        delete nextRequest.version;
    } else {
        nextRequest.trackVersion = requested;
        nextRequest.version = requested;
    }

    return nextRequest;
}

function resolveConfigRequest(fallbackTrackId, descriptor = null) {
    const params = new URLSearchParams(window.location.search);
    const trackId = params.get('trackId') || fallbackTrackId;
    const orbiterId = params.get('orbiterId');
    const entangledWorldId = params.get('entangledWorldId');
    // A voice's own version pin wins over the URL. In the shared realm the URL belongs to the
    // PAGE — every voice reads the same one — so a per-card version can only travel on the
    // voice's descriptor.
    //
    // A descriptor that NAMES trackVersion is authoritative, explicit null included: that is a
    // card saying "live release", and falling through to a page-level ?trackVersion= would pin
    // it to a version it deliberately unpinned. Only a descriptor that stays silent (and the
    // standalone app, which has no descriptor) defers to the URL.
    const trackVersion =
        descriptor != null && Object.hasOwn(descriptor, 'trackVersion')
            ? descriptor.trackVersion
            : params.get('trackVersion');
    const orbiterVersion = params.get('orbiterVersion');
    const entangledWorldVersion = params.get('entangledWorldVersion');

    return {
        trackId,
        orbiterId: orbiterId || null,
        entangledWorldId: entangledWorldId || null,
        trackVersion: trackVersion || null,
        orbiterVersion: orbiterVersion || null,
        entangledWorldVersion: entangledWorldVersion || null,
    };
}

function getInitialEditModeFlag() {
    try {
        // The one read of edit mode (it also knows edit is unreachable in a multi-stage boot) —
        // this used to parse `mode`/`editMode` itself, which let a collection voice construct with
        // edit on while its mode controller booted play.
        return getWorldInteractionModeFromUrl() === 'edit';
    } catch (error) {
        return false;
    }
}

// ============================================================================
// DataManager Class
// ============================================================================

/**
 * Class representing a data manager for handling track data and UI placeholders.
 * @class
 * @memberof CoreModule 
 */
export class DataManager {
    /**
     * Creates an instance of DataManager.
     */
    constructor({ eventBus, loadProgress, sharedRealmCache = false, sessionDescriptor = null } = {}) {
        // This voice's own descriptor, carrying any release pin (e.g. `trackVersion`). Realm
        // voices all share one page URL, so a per-voice pin has no URL param to ride on.
        this._sessionDescriptor = sessionDescriptor;
        this.cacheExpiryMinutes = Constants.CACHE_EXPIRY_MINUTES || 10;
        // This voice's load-progress reporter. Defaults to a global-mirroring reporter so
        // a bare `new DataManager()` keeps the legacy single-orbiter overlay behavior; multi voices
        // inject a per-voice reporter so N data loads can't thrash the one global counter.
        this._loadProgress = loadProgress ?? createLoadProgress();
        // In the shared multi-orbiter realm the release caches are a REALM resource — one
        // voice pruning "everything but my track" would evict its siblings' releases (including the
        // ones the collection fetch just primed) and force N re-downloads. Single-orbiter keeps the
        // legacy retain-only-active pruning.
        this._sharedRealmCache = Boolean(sharedRealmCache);
        // The per-voice event bus the `dataManager:configUpdated` signal is dispatched
        // on (the React info + kit-waveform surfaces subscribe to the SAME bus). Defaults to `window` so
        // single-orbiter is byte-identical; a multi tile injects its own EventTarget so a new track
        // loading in one tile doesn't re-read another tile's surfaces.
        this._eventBus = eventBus ?? (typeof window !== 'undefined' ? window : null);
        this.parameterManager = null;
        this.placeholderConfig = {};
        this.activeView = null;
        this.lastParamValues = {};
        this.currentConfigKey = null;
        this.activeConfigRequest = null;
        this.editModeEnabled = getInitialEditModeFlag();
        // No longer published on `window` — the boot registers this instance as the active
        // voice's `dataManager`, and readers (the embed-token auth refetch) resolve it via the registry.
    }

    _pruneMemoryCaches(request = {}) {
        try {
            if (!this._sharedRealmCache) {
                const trackIds = new Set();
                const orbiterIds = new Set();
                const worldIds = new Set();

                if (request?.trackId) trackIds.add(request.trackId);
                if (request?.orbiterId) orbiterIds.add(request.orbiterId);
                if (request?.entangledWorldId) worldIds.add(request.entangledWorldId);

                Constants.clearStaleReleaseCaches?.({ trackIds, orbiterIds, worldIds });
            }
            Constants.trimConfigSnapshots?.(24);
        } catch (error) {
            console.warn('[DataManager] Failed to prune memory caches', error);
        }
    }

    async _attachTrackUserSettings(combined, fallbackTrackId = null) {
        if (!combined || typeof combined !== 'object') {
            return combined;
        }

        const trackId = combined?.track?.trackId || fallbackTrackId || null;
        if (!trackId) {
            return {
                ...combined,
                trackUserSettings: combined?.trackUserSettings ?? null,
            };
        }

        try {
            const trackUserSettings = await fetchTrackUserSettings(trackId, {
                promptOnAuthError: false,
                returnNullOnAuthError: true,
            });
            return {
                ...combined,
                trackUserSettings: trackUserSettings ?? null,
            };
        } catch (error) {
            console.warn('[DataManager] Failed to load track user settings', { trackId, error });
            return {
                ...combined,
                trackUserSettings: combined?.trackUserSettings ?? null,
            };
        }
    }

    /**
     * Ensures a resolved combined payload carries private per-user track settings.
     *
     * This is used by session/bootstrap flows that already have resolved track,
     * orbiter, and world data but still need the private settings layer before
     * initializing sync, playback, and waveform UI.
     *
     * @param {object|null} combined
     * @param {string|null} [fallbackTrackId]
     * @returns {Promise<object|null>}
     */
    async attachTrackUserSettings(combined, fallbackTrackId = null) {
        return this._attachTrackUserSettings(combined, fallbackTrackId);
    }

    // ========================================================================
    // Public API - Configuration Loading
    // ========================================================================

    /**
     * Fetches track data and updates the placeholder configuration.
     * @async
     * @public
     * @param {string} trackId - The ID of the track to fetch data for.
     * @returns {Promise<void>}
     */
    async fetchAndUpdateConfig(trackId) {
        try {
            const request = resolveConfigRequest(trackId, this._sessionDescriptor);
            settleRequestVersionAlias(request);
            this.activeConfigRequest = request;
            const configKey = Constants.buildConfigKey(request);
            this.currentConfigKey = configKey;

            let combinedData = Constants.getCurrentConfig(configKey);
            if (!combinedData) {
                combinedData = await assembleConfig(request);
                if (!combinedData) {
                    return;
                }
            }
            combinedData = await this._attachTrackUserSettings(combinedData, request.trackId);
            Constants.setCurrentConfig(configKey, combinedData);

            this.activeConfigRequest = {
                trackId: combinedData.track?.trackId || request.trackId,
                trackVersion: combinedData.track?.version || request.trackVersion || null,
                orbiterId: combinedData.orbiter?.orbiterId || request.orbiterId || null,
                orbiterVersion: combinedData.orbiter?.version || request.orbiterVersion || null,
                entangledWorldId: combinedData.entangledWorld?.worldId || request.entangledWorldId || null,
                entangledWorldVersion: combinedData.entangledWorld?.version || request.entangledWorldVersion || null,
                version: combinedData.track?.version || request.version || null,
            };
            this._pruneMemoryCaches(this.activeConfigRequest);

            this.updatePlaceholderConfig(request.trackId);

            // Update loading state
            this._loadProgress.setStep("trackLoaded", true);
            this._loadProgress.setStep("orbiterLoaded", !!combinedData?.orbiter);
            this._loadProgress.setStep("modelLoaded", !!combinedData?.entangledWorld);
            
            this._eventBus?.dispatchEvent(new CustomEvent('dataManager:configUpdated', {
                detail: {
                    combined: combinedData,
                    request: this.activeConfigRequest,
                },
            }));
        } catch (error) {
            throw error;
        }
    }

    /**
     * Fetches track data from the server or retrieves it from the cache.
     * @async
     * @public
     * @param {string} trackId - The ID of the track to fetch data for.
     * @param {Object} overrides - Optional overrides for the request
     * @returns {Promise<Object>} The track data.
     */
    async fetchTrackData(trackId, overrides = {}) {
        const baseRequest = resolveConfigRequest(trackId, this._sessionDescriptor);
        const request = {
            ...baseRequest,
            ...Object.fromEntries(Object.entries(overrides).filter(([_, value]) => value !== undefined)),
            trackId,
        };
        settleRequestVersionAlias(request);

        const configKey = Constants.buildConfigKey(request);
        const cached = Constants.getCurrentConfig(configKey);
        if (cached) {
            return cached;
        }

        const combined = await assembleConfig(request);
        if (combined) {
            const hydratedCombined = await this._attachTrackUserSettings(combined, trackId);
            Constants.setCurrentConfig(configKey, hydratedCombined);
            return hydratedCombined;
        }
        return combined;
    }

    /**
     * Loads configuration from a descriptor object.
     * @async
     * @public
     * @param {Object} descriptor - Configuration descriptor
     * @returns {Promise<Object>} Combined configuration data
     */
    async loadConfiguration(descriptor = {}) {
        const sanitized = {
            trackId: descriptor.trackId ?? null,
            orbiterId: descriptor.orbiterId ?? null,
            entangledWorldId: descriptor.entangledWorldId ?? null,
            trackVersion: descriptor.trackVersion ?? null,
            orbiterVersion: descriptor.orbiterVersion ?? null,
            entangledWorldVersion: descriptor.entangledWorldVersion ?? null,
        };

        return this.applyConfigOverrides(
            Object.fromEntries(
                Object.entries({
                    trackId: sanitized.trackId,
                    trackVersion: sanitized.trackVersion,
                    orbiterId: sanitized.orbiterId,
                    orbiterVersion: sanitized.orbiterVersion,
                    entangledWorldId: sanitized.entangledWorldId,
                    entangledWorldVersion: sanitized.entangledWorldVersion,
                }).filter(([, value]) => value != null)
            )
        );
    }

    /**
     * Loads configuration from pre-hydrated session data.
     * @async
     * @public
     * @param {Object} options - Hydration options
     * @returns {Promise<Object>} Combined configuration data
     */
    async loadFromHydratedSession(options = {}) {
        return loadFromHydratedSession(options);
    }

    /**
     * Applies a resolved session snapshot (from entity resolver) without refetching.
     * @param {import('../../session/entityResolver.js').SessionResolutionResult} resolution
     * @returns {Object|null} Combined configuration that was applied.
     */
    applyResolvedSession(resolution) {
        if (!resolution || !resolution.ok) {
            return null;
        }

        const { track, orbiter, entangledWorld, request = {} } = resolution;
        if (!track || !track.trackId) {
            throw new Error('Resolved session is missing track data.');
        }

        const effectiveRequest = {
            trackId: track.trackId,
            trackVersion: track.version ?? request.trackVersion ?? null,
            orbiterId: orbiter?.orbiterId ?? request.orbiterId ?? null,
            orbiterVersion: orbiter?.version ?? request.orbiterVersion ?? null,
            entangledWorldId: entangledWorld?.worldId ?? request.entangledWorldId ?? null,
            entangledWorldVersion: entangledWorld?.version ?? request.entangledWorldVersion ?? null,
            version: track.version ?? request.version ?? null,
        };

        const combined = {
            track,
            orbiter,
            entangledWorld,
            trackUserSettings:
                resolution?.trackUserSettings
                ?? track?.trackUserSettings
                ?? null,
            request: effectiveRequest,
        };

        const configKey = Constants.buildConfigKey({
            trackId: effectiveRequest.trackId,
            orbiterId: effectiveRequest.orbiterId,
            entangledWorldId: effectiveRequest.entangledWorldId,
            version: effectiveRequest.version,
        });

        Constants.setCurrentConfig(configKey, combined);
        this.currentConfigKey = configKey;
        this.activeConfigRequest = { ...effectiveRequest };
        this._pruneMemoryCaches(this.activeConfigRequest);
        this.placeholderConfig = {};
        this.updatePlaceholderConfig(effectiveRequest.trackId);
        if (this.activeView) {
            this.populatePlaceholders(this.activeView);
        }
        this._loadProgress.setStep('trackLoaded', true);
        this._loadProgress.setStep('orbiterLoaded', !!orbiter);
        this._loadProgress.setStep('modelLoaded', !!entangledWorld);

        safeResolveSession(
            {
                trackId: effectiveRequest.trackId,
                trackVersion: effectiveRequest.trackVersion,
                orbiterId: effectiveRequest.orbiterId,
                orbiterVersion: effectiveRequest.orbiterVersion,
                entangledWorldId: effectiveRequest.entangledWorldId,
                entangledWorldVersion: effectiveRequest.entangledWorldVersion,
            },
            { source: 'data-manager', status: 'resolved' }
        );

        this._eventBus?.dispatchEvent(new CustomEvent('dataManager:configUpdated', {
            detail: {
                combined,
                request: this.activeConfigRequest,
            },
        }));

        return combined;
    }

    /**
     * Applies configuration overrides and reloads data as needed.
     * @async
     * @public
     * @param {Object} overrides - Configuration overrides
     * @returns {Promise<Object>} Combined configuration data
     */
    async applyConfigOverrides(overrides = {}) {
        try {
            const baseTrackId = overrides.trackId
                || this.activeConfigRequest?.trackId
                || Constants.DEFAULT_PLAY_TRACK_ID;

            const currentRequest = this.activeConfigRequest
                ? { ...this.activeConfigRequest }
                : { ...resolveConfigRequest(baseTrackId, this._sessionDescriptor) };

            const sanitizedOverrides = Object.fromEntries(
                Object.entries(overrides).filter(([_, value]) => value !== undefined)
            );

            const nextRequest = {
                ...currentRequest,
                ...sanitizedOverrides,
                trackId: baseTrackId,
            };

            resolveRequestVersionPins({ currentRequest, sanitizedOverrides, nextRequest });

            const configKey = Constants.buildConfigKey(nextRequest);

            let combined = Constants.getCurrentConfig(configKey);
            if (!combined) {
                combined = await assembleConfig(nextRequest);

                if (!combined && baseTrackId === Constants.DEFAULT_EDIT_TRACK_ID) {
                    
                    const fallback = buildEditModeFallback({ trackId: baseTrackId });
                    combined = fallback.combined;
                }

                if (!combined) {
                    console.warn('[DataManager] applyConfigOverrides: unable to resolve configuration for request', nextRequest);
                    safeUpdateSession({ status: 'pending' }, { source: 'data-manager' });
                    return null;
                }
            }
            combined = await this._attachTrackUserSettings(combined, nextRequest.trackId);
            Constants.setCurrentConfig(configKey, combined);

            this.currentConfigKey = configKey;
            // The active request records what was ASKED FOR, not what came back. Every later
            // override inherits its pins from here, and `combined.*.version` is the version that
            // was SERVED — for an unpinned request simply the live release's number. Storing that
            // re-pinned a live voice the moment it loaded, so the next override that did not name
            // a version inherited a pin nobody had asked for and the voice stopped following live.
            this.activeConfigRequest = {
                trackId: combined.track?.trackId || nextRequest.trackId,
                trackVersion: nextRequest.trackVersion ?? null,
                orbiterId: combined.orbiter?.orbiterId || nextRequest.orbiterId || null,
                orbiterVersion: nextRequest.orbiterVersion ?? null,
                entangledWorldId: combined.entangledWorld?.worldId || nextRequest.entangledWorldId || null,
                entangledWorldVersion: nextRequest.entangledWorldVersion ?? null,
                version: nextRequest.version ?? null,
            };
            this._pruneMemoryCaches(this.activeConfigRequest);

            this.placeholderConfig = {};
            this.updatePlaceholderConfig(this.activeConfigRequest.trackId);
            this._loadProgress.setStep('trackLoaded', true);
            this._loadProgress.setStep('orbiterLoaded', !!combined.orbiter);
            this._loadProgress.setStep('modelLoaded', !!combined.entangledWorld);

            // The RESOLVED session still reports the versions actually served — that is what a
            // resolved descriptor means, and what the host reads to show which version is on
            // screen. Only the inherited request above is kept as-asked.
            safeResolveSession(
                {
                    trackId: this.activeConfigRequest.trackId,
                    trackVersion: combined.track?.version ?? this.activeConfigRequest.trackVersion ?? null,
                    orbiterId: this.activeConfigRequest.orbiterId,
                    orbiterVersion: combined.orbiter?.version ?? this.activeConfigRequest.orbiterVersion ?? null,
                    entangledWorldId: this.activeConfigRequest.entangledWorldId,
                    entangledWorldVersion:
                        combined.entangledWorld?.version ?? this.activeConfigRequest.entangledWorldVersion ?? null,
                },
                { source: 'data-manager', status: 'resolved' }
            );

            this._eventBus?.dispatchEvent(new CustomEvent('dataManager:configUpdated', {
                detail: {
                    combined,
                    request: this.activeConfigRequest,
                },
            }));

            return combined;
        } catch (error) {
            safeUpdateSession(
                {
                    status: 'error',
                    errors: [{ message: error?.message || 'Failed to load session', source: 'data-manager' }],
                },
                { source: 'data-manager' }
            );
            throw error;
        }
    }

    /**
     * Swaps the current track with a new one.
     * @async
     * @public
     * @param {string} trackId - The new track ID
     * @param {Object} options - Additional options
     * @returns {Promise<Object>} Combined configuration data
     */
    async swapTrack(trackId, options = {}) {
        return this.applyConfigOverrides({ trackId, ...options });
    }

    /**
     * Swaps the current orbiter with a new one.
     * @async
     * @public
     * @param {string} orbiterId - The new orbiter ID
     * @param {Object} options - Additional options
     * @returns {Promise<Object>} Combined configuration data
     */
    async swapOrbiter(orbiterId, options = {}) {
        return this.applyConfigOverrides({ orbiterId, ...options });
    }

    /**
     * Swaps the current entangled world with a new one.
     * @async
     * @public
     * @param {string} entangledWorldId - The new world ID
     * @param {Object} options - Additional options
     * @returns {Promise<Object>} Combined configuration data
     */
    async swapEntangledWorld(entangledWorldId, options = {}) {
        return this.applyConfigOverrides({ entangledWorldId, ...options });
    }

    // ========================================================================
    // Public API - Placeholder Management
    // ========================================================================

    /**
     * Updates the configuration for UI placeholders using the retrieved track data.
     * @public
     */
    updatePlaceholderConfig(trackId) {
        // Prefer THIS voice's exact snapshot (currentConfigKey): two live voices can show the
        // same track under different orbiter/world combos, and the track-only scan below would
        // return whichever sibling snapshot comes first. The scan stays as the fallback when the
        // key doesn't match the requested trackId (no single-current TRACK_DATA pointer).
        const keyed = this.currentConfigKey && this.currentConfigKey.split('|')[0] === trackId
            ? Constants.getCurrentConfig(this.currentConfigKey)
            : null;
        const combined = keyed || Constants.getConfigByTrackId(trackId);
        if (!combined) {
            return;
        }

        const { track, orbiter, entangledWorld } = combined;
        this.placeholderConfig = buildPlaceholderConfig(track, orbiter, entangledWorld);
    }

    /**
     * Populates the UI placeholders with the configured data.
     * @public
     * @param {string} target - The type of information to populate (e.g., 'trackInfo').
     */
    populatePlaceholders(target) {
        this.activeView = target;
        populatePlaceholders(target, this.placeholderConfig);

        // Immediately refresh root parameter values when entering Control Monitor view
        if (target === 'monitorInfo' && this.parameterManager) {
            const rootMap = { x: 'placeholder_2', y: 'placeholder_4', z: 'placeholder_6' };
            Object.entries(rootMap).forEach(([name, id]) => {
                let value;
                if (typeof this.parameterManager.getParameter === 'function') {
                    const paramObj = this.parameterManager.getParameter(name);
                    value = paramObj?.value;
                } else if (typeof this.parameterManager.getParameterValue === 'function') {
                    value = this.parameterManager.getParameterValue(name);
                }
                if (value != null) {
                    const el = document.getElementById(id);
                    if (el) el.textContent = typeof value === 'number' ? formatParameterDisplayValue(value) : value;
                }
            });
        }
    }

    /**
     * Sets the ParameterManager instance for subscribing to parameter updates.
     * @public
     * @param {ParameterManager} manager - The ParameterManager instance to assign.
     */
    setParameterManager(manager) {
        this.parameterManager = manager;
        this.lastParamValues = {};
    }

    // ========================================================================
    // Public API - Edit Mode
    // ========================================================================

    isEditModeEnabled() {
        return this.editModeEnabled;
    }

    setEditModeEnabled(enabled) {
        this.editModeEnabled = Boolean(enabled);
    }

    // ========================================================================
    // Public API - Direct Fetchers (for external use)
    // ========================================================================

    async fetchTrackRelease(trackId, options) {
        return fetchTrackRelease(trackId, options);
    }

    async fetchOrbiterRelease(orbiterId, options) {
        return fetchOrbiterRelease(orbiterId, options);
    }

    async fetchEntangledWorldRelease(worldId, options) {
        return fetchEntangledWorldRelease(worldId, options);
    }
}

// ============================================================================
// Named Exports for Direct Module Access
// ============================================================================

export {
    // Loaders
    fetchTrackRelease,
    fetchOrbiterRelease,
    fetchEntangledWorldRelease,
    
    // Normalizers
    normalizeTrackRelease,
    normalizeOrbiterRelease,
    normalizeWorldRelease,
    
    // Assembler
    assembleConfig,
    resetOrbiterFallbackNotification,
    
    // Hydration
    loadFromHydratedSession,

    // Placeholders
    buildPlaceholderConfig,
    populatePlaceholders,
    clearPlaceholders,
    getParamValueFormatted,
    
    // Session Bridge
    safeResolveSession,
    safeUpdateSession,
};
