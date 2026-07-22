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
 * Which cache keys a primed payload may legitimately answer.
 *
 * The unversioned (`version: null`) key means "whatever is live". Seeding a payload there
 * unconditionally is how a PINNED release ends up served to a voice that asked for the live one —
 * the two are different bytes under the same key. A payload may claim the live key only when the
 * entity's own pointer agrees that it is live.
 *
 * @param {object} payload a release response.
 * @returns {{version: number|null, isLive: boolean}}
 */
function resolvePrimedReleaseKeys(payload) {
    const version = payload?.release?.version ?? null;
    if (version == null) return { version: null, isLive: true };

    // Claiming the live key needs POSITIVE evidence that this payload IS live. Treating a missing
    // pointer as proof of liveness let a pinned item — which carries no pointer of its own — be
    // written under the live key and answer every later unpinned request with the wrong bytes.
    const current = payload?.currentReleaseVersion ?? null;
    if (current != null) return { version, isLive: version === current };
    if (typeof payload?.isLatest === 'boolean') return { version, isLive: payload.isLatest };

    // No pointer, but the payload's own release list still says which version is newest.
    const versions = (Array.isArray(payload?.releases) ? payload.releases : [])
        .map((release) => release?.version)
        .filter((value) => typeof value === 'number');
    if (versions.length > 0) return { version, isLive: version === Math.max(...versions) };

    // Nothing to check against: seed the exact version only. The voice re-fetches for a live
    // request, which costs a round trip — far cheaper than serving it a pinned release.
    return { version, isLive: false };
}

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
    const { version, isLive } = resolvePrimedReleaseKeys(payload);
    if (version != null) Constants.setTrackRelease(id, payload, { version });
    if (isLive) Constants.setTrackRelease(id, payload, { version: null });
    return true;
}

/** Same as `primeTrackReleaseCache`, for an orbiter-entity collection item. */
export function primeOrbiterReleaseCache(orbiterId, payload) {
    const id = typeof orbiterId === 'string' ? orbiterId : null;
    if (!id || !payload || typeof payload !== 'object' || !payload.release) return false;
    const { version, isLive } = resolvePrimedReleaseKeys(payload);
    if (version != null) Constants.setOrbiterRelease(id, payload, { version });
    if (isLive) Constants.setOrbiterRelease(id, payload, { version: null });
    return true;
}

/** Same as `primeTrackReleaseCache`, for a world-entity collection item. */
export function primeWorldReleaseCache(worldId, payload) {
    const id = typeof worldId === 'string' ? worldId : null;
    if (!id || !payload || typeof payload !== 'object' || !payload.release) return false;
    const { version, isLive } = resolvePrimedReleaseKeys(payload);
    if (version != null) Constants.setWorldRelease(id, payload, { version });
    if (isLive) Constants.setWorldRelease(id, payload, { version: null });
    return true;
}

/** Pinned requests already proven gone. Without this every later load repeats the dead
 *  request before the retry, doubling release traffic for the whole session. Keyed by the
 *  request path, so a different entity or version is unaffected. */
const prunedVersions = new Set();

function prunedKey(entityLabel, path) {
    return `${entityLabel}::${path}`;
}

/** Test seam: drop the memo of pinned versions proven missing. */
export function resetPrunedVersionMemo() {
    prunedVersions.clear();
}

/**
 * Fetches a release, tolerating a pinned version that no longer exists.
 *
 * A stored session names the version it was built against, but versions are not permanent:
 * retention prunes them and an author can delete one. The pin is a preference, not a
 * requirement — the latest release is always the default — so a version that 404s falls back
 * to live once rather than failing the whole load.
 *
 * Only a not-found on a *versioned* request is retried. An unversioned 404 means the entity
 * itself is gone, and every other error propagates untouched.
 *
 * @param {(version: string|number|null) => string} buildPath Builds the request path for a version.
 * @param {string} entityLabel Entity label used for error text, e.g. `'track'`.
 * @param {string|number|null} version The requested version, or null for live.
 * @returns {Promise<{payload: object|null, version: string|number|null}>} Payload and the version
 *   it actually came from — null when the pinned version was abandoned for live.
 */
async function fetchReleaseAllowingPrunedVersion(buildPath, entityLabel, version) {
    // `== null` on purpose: only absent means "live". Version 0 is a value, not a blank.
    const isPinned = version != null && version !== '';
    if (isPinned && prunedVersions.has(prunedKey(entityLabel, buildPath(version)))) {
        return { payload: await fetchReleaseFromApi(buildPath(null), entityLabel), version: null };
    }
    try {
        return { payload: await fetchReleaseFromApi(buildPath(version), entityLabel), version };
    } catch (error) {
        const notFound = String(error?.message || '') === `${entityLabel.toLowerCase()}-not-found`;
        if (!isPinned || !notFound) {
            throw error;
        }
        prunedVersions.add(prunedKey(entityLabel, buildPath(version)));
        console.warn(
            `[DataManager] ${entityLabel} version ${version} no longer exists — loading the latest release instead.`
        );
        return { payload: await fetchReleaseFromApi(buildPath(null), entityLabel), version: null };
    }
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

    const { payload, version: resolvedVersion } = await fetchReleaseAllowingPrunedVersion(
        (v) => buildTrackReleasePath(trackId, { version: v, hydrate: resolvedHydrate }),
        'track',
        version
    );

    if (!payload) {
        return null;
    }

    // Cache under the version actually served, never the pruned one that was asked for.
    return cache.setTrackRelease(trackId, payload, { version: resolvedVersion });
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
        const { payload, version: resolvedVersion } = await fetchReleaseAllowingPrunedVersion(
            (v) => `/orbiters/${orbiterId}/release${buildVersionQuery(v)}`,
            'orbiter',
            version
        );

        if (!payload) {
            return null;
        }

        return cache.setOrbiterRelease(orbiterId, payload, { version: resolvedVersion });
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

    const { payload, version: resolvedVersion } = await fetchReleaseAllowingPrunedVersion(
        (v) => `/entangled-worlds/${worldId}/release${buildVersionQuery(v)}`,
        'entangled world',
        version
    );

    if (!payload) {
        return null;
    }

    return cache.setWorldRelease(worldId, payload, { version: resolvedVersion });
}
