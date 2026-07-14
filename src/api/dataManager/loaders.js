/**
 * @file loaders.js
 * @description Handles raw data fetching from API endpoints, embedded auth, and HTTP operations.
 * @version 1.0.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2025-01-11
 */

import notifications from '../../core/AppNotifications.js';
import { getT } from '../../i18n/index.js';
import { fetchJsonFromApi } from '../httpClient.js';
import { Constants } from '../../config/Constants.js';
import { voiceRegistry } from '../../voice/VoiceRegistry.js';

let cachedStorageBase = null;

// ============================================================================
// Environment & Storage Resolution
// ============================================================================

function safeGetEnvValue(key) {
    try {
        return import.meta?.env?.[key];
    } catch {
        return undefined;
    }
}

// Test-only hook: clear the module-level storage-base memo so a test can exercise
// resolveStorageBase()/resolveStorageAssetURL() against a fresh window each time.
// Behavior-neutral in production (the memo is simply recomputed on next access).
export function resetStorageBaseCache() {
    cachedStorageBase = null;
}

export function resolveStorageBase() {
    if (cachedStorageBase !== null) {
        return cachedStorageBase;
    }

    if (typeof window === 'undefined') {
        const envOnly =
            safeGetEnvValue('VITE_PUBLIC_HERBARIUM_BASE') ||
            safeGetEnvValue('VITE_STORAGE_BASE') ||
            safeGetEnvValue('VITE_ASSET_BASE') ||
            safeGetEnvValue('VITE_HERBARIUM_BASE');
        cachedStorageBase = envOnly ? envOnly.replace(/\/$/, '') : '';
        return cachedStorageBase;
    }

    const candidates = [
        window.VITE_PUBLIC_HERBARIUM_BASE,
        window.PUBLIC_HERBARIUM_BASE,
        window.__PUBLIC_HERBARIUM_BASE__,
        window.STORAGE_BASE,
        window.ASSET_BASE,
        window.ASSETS_BASE,
        window.STORAGE_BASE_URL,
        window.PUBLIC_STORAGE_BASE,
        safeGetEnvValue('VITE_PUBLIC_HERBARIUM_BASE'),
        safeGetEnvValue('VITE_STORAGE_BASE'),
        safeGetEnvValue('VITE_ASSET_BASE'),
        safeGetEnvValue('VITE_HERBARIUM_BASE'),
    ];

    // Reject unsubstituted Vite tokens (e.g. "%VITE_HERBARIUM_BASE%") so a missing
    // build-time env var can never resolve into a broken storage URL.
    const match = candidates.find(
        (value) => typeof value === 'string' && value.trim().length > 0 && !value.includes('%'),
    );
    cachedStorageBase = (match || '').replace(/\/$/, '');
    return cachedStorageBase;
}

export function resolveStorageAssetURL(key) {
    if (!key || typeof key !== 'string') {
        return null;
    }
    if (/^https?:\/\//i.test(key)) {
        return key;
    }
    const base = resolveStorageBase();
    if (!base) {
        return null;
    }
    const trimmed = key.replace(/^\/+/, '');
    return `${base}/${trimmed}`;
}

// ============================================================================
// Embedded Auth Token Management
// ============================================================================

// The embed token only ever arrives from the embedding host over postMessage (below).
// It is deliberately NOT read from the URL: a `?token=` query string turns every shared,
// screenshotted, or logged embed URL into a replayable bearer credential.
let embeddedToken = null;
let embedAuthRequested = false;

// Guarded: this module is in the package-entry graph and may be evaluated with no window.
if (typeof window !== 'undefined') window.addEventListener('message', (event) => {
    // Only the window embedding us may supply auth tokens. Anything else — popups,
    // injected scripts, same-window posts — must never become the API identity.
    if (window.parent === window || event.source !== window.parent) {
        return;
    }
    if (typeof event.data !== 'object' || !event.data) {
        return;
    }

    const { type, token, customToken, expiresAt } = event.data;

    if (type === 'authToken' && token) {
        const normalizedToken = String(token).trim();
        if (!normalizedToken) {
            return;
        }
        const previousToken = embeddedToken ? String(embeddedToken).trim() : null;
        const tokenChanged = previousToken !== normalizedToken;
        embeddedToken = normalizedToken;
        embedAuthRequested = false;

        // The active voice's DataManager (not a `window` global) owns the live track id;
        // an embed-token change refetches that voice's own config.
        const activeDataManager = voiceRegistry.getActive()?.dataManager ?? null;
        const currentId = activeDataManager?.activeConfigRequest?.trackId ?? null;
        if (tokenChanged && currentId && activeDataManager) {
            activeDataManager.fetchAndUpdateConfig(currentId);
        }

        // The embedded token usually arrives AFTER the studio UI mounts, so the edit-panel chrome theme's
        // mount-time `/me/users/settings` fetch returned null and the panel fell back to the DEFAULT
        // preset. Announce the change so the panel can re-fetch settings and apply the user's real preset.
        if (tokenChanged && typeof document !== 'undefined') {
            try {
                document.dispatchEvent(new CustomEvent('orbiters:auth-token'));
            } catch {}
        }

        if (typeof window.__setOrbiterExternalAuthToken === 'function') {
            try {
                window.__setOrbiterExternalAuthToken(normalizedToken, { expiresAt: Number.isFinite(expiresAt) ? expiresAt : null });
            } catch (error) {
                console.warn('[DataManager] Failed to forward auth token to iframe session auth', error);
            }
        }
        return;
    }

    if ((type === 'provide-auth' || type === 'auth-token') && typeof customToken === 'string' && customToken.trim()) {
        if (typeof window.__setOrbiterExternalAuthToken === 'function') {
            try {
                window.__setOrbiterExternalAuthToken(customToken.trim(), { expiresAt: Number.isFinite(expiresAt) ? expiresAt : null });
            } catch (error) {
                console.warn('[DataManager] Failed to forward custom token to iframe session auth', error);
            }
        }
        // Some hosts deliver auth ONLY via this custom-token path (not `type:'authToken'`). The chrome
        // theme's settings fetch falls back to session/Firebase auth, which this call has just primed —
        // so announce it too, or the panel would stay on the default preset for those hosts.
        if (typeof document !== 'undefined') {
            try {
                document.dispatchEvent(new CustomEvent('orbiters:auth-token'));
            } catch {}
        }
    }
});

export function getEmbeddedAuthToken() {
    if (!embeddedToken) {
        return null;
    }
    return embeddedToken.startsWith('Bearer ') ? embeddedToken : `Bearer ${embeddedToken}`;
}

export function requestEmbeddedAuthToken() {
    if (!embeddedToken && !embedAuthRequested && typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'needAuth' }, '*');
        embedAuthRequested = true;
        return true;
    }
    return Boolean(embeddedToken);
}

// ============================================================================
// API Fetching Helpers
// ============================================================================

function buildVersionQuery(version) {
    return version ? `?version=${encodeURIComponent(version)}` : '';
}

function buildQueryString(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value === null || value === undefined) {
            return;
        }
        const stringValue = typeof value === 'string' ? value.trim() : String(value);
        if (stringValue.length === 0) {
            return;
        }
        query.set(key, stringValue);
    });
    const serialized = query.toString();
    return serialized ? `?${serialized}` : '';
}

function buildTrackReleasePath(trackId, { version = null, hydrate = null } = {}) {
    const params = {
        version: version ?? null,
        hydrate: hydrate ?? null,
    };
    const query = buildQueryString(params);
    return `/tracks/${trackId}/release${query}`;
}

function normalizeHydrateValue(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return null;
        }
        return String(value);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }
    return null;
}

function hasHydratedReleases(payload) {
    const hydration = payload?.hydration;
    if (!hydration || typeof hydration !== 'object') {
        return false;
    }
    return Boolean(hydration.orbiterRelease && hydration.worldRelease);
}

async function readErrorBody(response) {
    try {
        return await response.json();
    } catch (err) {
        return null;
    }
}

function attachUnavailable(error, body) {
    if (!body || typeof body !== 'object') {
        return error;
    }
    if (body.unavailable && typeof body.unavailable === 'object') {
        error.unavailable = body.unavailable;
    }
    if (typeof body.code === 'string') {
        error.code = body.code;
    }
    return error;
}

export async function fetchReleaseFromApi(path, entityLabel, options = {}) {
    const fetchOptions = {
        authToken: getEmbeddedAuthToken(),
        ...options,
    };

    if (entityLabel === 'Orbiter') {
        fetchOptions.cache = 'reload';
    }

    const response = await fetchJsonFromApi(path, fetchOptions);

    if (!response.ok) {
        if (response.status === 403 && requestEmbeddedAuthToken()) {
            return null;
        }

        const isNotFound = response.status === 404;
        const body = await readErrorBody(response);
        let message =
            (body && typeof body.message === 'string' && body.message) ||
            `${entityLabel} request failed (${response.status}).`;

        if (message === 'noReleaseYet') {
            message = `No release is available yet for the requested ${entityLabel.toLowerCase()}.`;
        }

        if (isNotFound) {
            throw attachUnavailable(
                new Error(`${entityLabel.toLowerCase()}-not-found`),
                body
            );
        }

        notifications.showToast(message, 'error');
        throw attachUnavailable(new Error(message), body);
    }

    const payload = await response.json();
    if (!payload?.success) {
        const t = getT();
        const msg = payload?.message || t('notifications.apiError');
        notifications.showToast(msg, 'error');
        throw new Error(msg);
    }

    return payload;
}

// ============================================================================
// Release Fetchers
// ============================================================================

/**
 * Seed the global track-release cache with a payload we ALREADY have — the
 * `hydrationLevel=2` collection fetch returns, per item, the same hydrated release response the
 * per-voice `/tracks/{id}/release?hydrate=2` call would fetch again (the same backend builders).
 * Priming here turns each voice's release fetch into a warm cache hit, collapsing N slow
 * (multi-second) hydrated release calls into ZERO for a freshly loaded collection.
 *
 * Safe by construction: `fetchTrackRelease` only trusts a cached payload for a hydrated request
 * when `hasHydratedReleases(payload)` — a seed that turns out thin is simply ignored and the
 * voice falls back to the network.
 * @param {string} trackId
 * @param {object} payload the item's hydrated release response.
 * @returns {boolean} true when seeded.
 */
export function primeTrackReleaseCache(trackId, payload) {
    const id = typeof trackId === 'string' ? trackId : null;
    if (!id || !payload || typeof payload !== 'object') return false;
    // Seed only what fetchTrackRelease will actually honor for a hydrated request — otherwise the
    // seed is dead weight that reports success while every voice still re-fetches.
    if (!hasHydratedReleases(payload)) return false;
    Constants.setTrackRelease(id, payload, { version: null });
    return true;
}

/** Same as `primeTrackReleaseCache`, for an orbiter-entity collection item. */
export function primeOrbiterReleaseCache(orbiterId, payload) {
    const id = typeof orbiterId === 'string' ? orbiterId : null;
    if (!id || !payload || typeof payload !== 'object' || !payload.release) return false;
    Constants.setOrbiterRelease(id, payload, { version: null });
    return true;
}

/** Same as `primeTrackReleaseCache`, for a world-entity collection item. */
export function primeWorldReleaseCache(worldId, payload) {
    const id = typeof worldId === 'string' ? worldId : null;
    if (!id || !payload || typeof payload !== 'object' || !payload.release) return false;
    Constants.setWorldRelease(id, payload, { version: null });
    return true;
}

export async function fetchTrackRelease(
    trackId,
    { version = null, hydrate = null, hydration = null, hydrationLevel = null, cache = Constants } = {}
) {
    if (!trackId) {
        throw new Error('trackId is required to fetch track release data.');
    }

    const resolvedHydrate = normalizeHydrateValue(hydrate ?? hydration ?? hydrationLevel);
    const requiresHydration = Boolean(resolvedHydrate);
    const cached = cache.getTrackRelease(trackId, { version });
    if (cached && (!requiresHydration || hasHydratedReleases(cached))) {
        return cached;
    }

    const payload = await fetchReleaseFromApi(
        buildTrackReleasePath(trackId, { version, hydrate: resolvedHydrate }),
        'track'
    );
    
    if (!payload) {
        return null;
    }

    return cache.setTrackRelease(trackId, payload, { version });
}

export async function fetchOrbiterRelease(orbiterId, { version = null, useFallback = true, cache = Constants } = {}) {
    if (!orbiterId) {
        throw new Error('orbiterId is required to fetch orbiter release data.');
    }

    const cached = cache.getOrbiterRelease(orbiterId, { version });
    if (cached) {
        return cached;
    }

    try {
        const payload = await fetchReleaseFromApi(
            `/orbiters/${orbiterId}/release${buildVersionQuery(version)}`,
            'orbiter'
        );
        
        if (!payload) {
            return null;
        }

        return cache.setOrbiterRelease(orbiterId, payload, { version });
    } catch (error) {
        if (!useFallback) {
            throw error;
        }
        
        // Return error info for fallback handling in assembler
        return {
            error: error,
            orbiterId,
            version,
            isNotFound: String(error?.message || '').includes('orbiter-not-found'),
            unavailable: error?.unavailable || null,
            code: error?.code || null,
        };
    }
}

export async function fetchEntangledWorldRelease(worldId, { version = null, cache = Constants } = {}) {
    if (!worldId) {
        throw new Error('entangled world id is required to fetch world release data.');
    }

    const cached = cache.getWorldRelease(worldId, { version });
    if (cached) {
        return cached;
    }

    const payload = await fetchReleaseFromApi(
        `/entangled-worlds/${worldId}/release${buildVersionQuery(version)}`,
        'entangled world'
    );

    if (!payload) {
        return null;
    }

    return cache.setWorldRelease(worldId, payload, { version });
}
