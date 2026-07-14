/**
 * @file tests/api/dataManager/helpers/InMemoryReleaseCache.js
 * @description Dependency-free, in-memory replica of the release/config cache surface
 * that the DataManager pipeline calls on the `Constants` singleton (src/config/Constants.js).
 *
 * Tests-first: this double exists so the cache surface can be exercised — and the
 * future seam justified — without importing the global `Constants` singleton (which touches
 * `navigator`/`import.meta.env` at module-load time). It must be OBSERVATIONALLY EQUIVALENT to
 * the real singleton for the methods the pipeline uses; the parity contract in
 * `../releaseCache.contract.test.js` enforces that equivalence against the live `Constants`.
 *
 * Implementation mirrors src/config/Constants.js EXACTLY (see line references inline). It uses
 * plain Maps + scalars only — zero import.meta.env, window, document, navigator, or console.
 */

// Utility helpers — mirror src/config/Constants.js lines 8-22 ---------------

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

export class InMemoryReleaseCache {
    constructor() {
        // Cache prefixes — mirror Constants.js lines 159-162.
        this.TRACK_CACHE_PREFIX = 'trackRelease:';
        this.ORBITER_CACHE_PREFIX = 'orbiterRelease:';
        this.WORLD_CACHE_PREFIX = 'worldRelease:';
        this.CONFIG_CACHE_PREFIX = 'configSnapshot:';

        // In-memory mirrors — the keyed snapshot cache is the SOLE store (no single-current
        // TRACK_ID/TRACK_DATA/CURRENT_CONFIG_KEY pointers).
        this._trackReleases = new Map();
        this._orbiterReleases = new Map();
        this._worldReleases = new Map();
        this._configSnapshots = new Map();
    }

    // setTrackData — Constants.js lines 247-257.
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
    }

    // setCurrentConfig — Constants.js (keyed Map is the sole store; delete-then-set = LRU touch).
    setCurrentConfig(configKey, configData) {
        if (!configKey || typeof configKey !== 'string') {
            throw new Error('Invalid configKey. Must be a string.');
        }
        this._configSnapshots.delete(configKey);
        this._configSnapshots.set(configKey, configData);
    }

    // getCurrentConfig — Constants.js (snapshot-or-null; no single-current fallback).
    getCurrentConfig(configKey) {
        if (!configKey || typeof configKey !== 'string') {
            throw new Error('Invalid configKey. Must be a string.');
        }
        return this._configSnapshots.has(configKey)
            ? this._configSnapshots.get(configKey)
            : null;
    }

    // getConfigByTrackId — Constants.js (prefix scan over the keyed snapshot cache).
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
    }

    // buildConfigKey — Constants.js lines 283-292 (throws on missing trackId; joins with '|').
    buildConfigKey({ trackId, orbiterId = null, entangledWorldId = null, version = null }) {
        if (!trackId) {
            throw new Error('trackId is required to build a config key.');
        }
        const parts = [trackId, orbiterId || 'default', entangledWorldId || 'default'];
        if (version) {
            parts.push(String(version));
        }
        return parts.join('|');
    }

    // setTrackRelease — Constants.js lines 294-298 (RETURNS the stored release; load-bearing).
    setTrackRelease(trackId, release, { version = null } = {}) {
        const key = buildCacheKey(this.TRACK_CACHE_PREFIX, trackId, version);
        this._trackReleases.set(key, release);
        return release;
    }

    // getTrackRelease — Constants.js lines 300-306.
    getTrackRelease(trackId, { version = null } = {}) {
        const key = buildCacheKey(this.TRACK_CACHE_PREFIX, trackId, version);
        if (this._trackReleases.has(key)) {
            return this._trackReleases.get(key);
        }
        return null;
    }

    // setOrbiterRelease — Constants.js lines 308-312 (RETURNS the stored release).
    setOrbiterRelease(orbiterId, release, { version = null } = {}) {
        const key = buildCacheKey(this.ORBITER_CACHE_PREFIX, orbiterId, version);
        this._orbiterReleases.set(key, release);
        return release;
    }

    // getOrbiterRelease — Constants.js lines 314-320.
    getOrbiterRelease(orbiterId, { version = null } = {}) {
        const key = buildCacheKey(this.ORBITER_CACHE_PREFIX, orbiterId, version);
        if (this._orbiterReleases.has(key)) {
            return this._orbiterReleases.get(key);
        }
        return null;
    }

    // setWorldRelease — Constants.js lines 322-326 (RETURNS the stored release).
    setWorldRelease(worldId, release, { version = null } = {}) {
        const key = buildCacheKey(this.WORLD_CACHE_PREFIX, worldId, version);
        this._worldReleases.set(key, release);
        return release;
    }

    // getWorldRelease — Constants.js lines 328-334.
    getWorldRelease(worldId, { version = null } = {}) {
        const key = buildCacheKey(this.WORLD_CACHE_PREFIX, worldId, version);
        if (this._worldReleases.has(key)) {
            return this._worldReleases.get(key);
        }
        return null;
    }

    // getTrackData — Constants.js lines 342-355. NOTE: the real singleton console.warn()s on a
    // miss; this double intentionally omits the warn (no console), but the RETURN value is identical.
    getTrackData(trackId) {
        if (!trackId || typeof trackId !== 'string') {
            throw new Error('Invalid trackId. Must be a string.');
        }
        const defaultKey = this.buildConfigKey({ trackId });
        if (this._configSnapshots.has(defaultKey)) {
            return this._configSnapshots.get(defaultKey);
        }
        return this.getConfigByTrackId(trackId);
    }

    // clearTrackData — Constants.js (drop every snapshot for the trackId, any orbiter/world variant).
    clearTrackData(trackId) {
        if (!trackId || typeof trackId !== 'string') {
            throw new Error('Invalid trackId. Must be a string.');
        }
        const prefix = `${trackId}|`;
        for (const key of [...this._configSnapshots.keys()]) {
            if (key === trackId || key.startsWith(prefix)) {
                this._configSnapshots.delete(key);
            }
        }
    }

    // clearStaleReleaseCaches — Constants.js lines 375-406 (prunes only non-retained ids; a
    // retain set that is empty leaves that entity untouched).
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
    }

    // trimConfigSnapshots — Constants.js (insertion-ordered: evict oldest first).
    trimConfigSnapshots(maxEntries = 24) {
        const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 24;
        if (this._configSnapshots.size <= limit) {
            return;
        }

        const keys = Array.from(this._configSnapshots.keys());
        for (const key of keys) {
            if (this._configSnapshots.size <= limit) break;
            this._configSnapshots.delete(key);
        }
    }

    // clearAllCaches — Constants.js (clears every keyed cache; no single-current pointers).
    clearAllCaches() {
        this._trackReleases.clear();
        this._orbiterReleases.clear();
        this._worldReleases.clear();
        this._configSnapshots.clear();
    }
}

/**
 * Factory mirror of `new InMemoryReleaseCache()`.
 * @returns {InMemoryReleaseCache}
 */
export function createInMemoryReleaseCache() {
    return new InMemoryReleaseCache();
}
