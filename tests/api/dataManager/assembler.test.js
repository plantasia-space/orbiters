// @vitest-environment jsdom
// (src/config/Constants.js touches `navigator`/`window` at import time — needs a
//  browser-like global, matching the sibling tests/api/dataManager/
//  releaseCache.contract.test.js. The toast layer is still mocked, so no real DOM
//  notification is created; jsdom is only here to satisfy the Constants import.)
/**
 * Tests-first: characterization tests over `assembleConfig` in
 * src/api/dataManager/assembler.js — the function that fetches + normalizes
 * track / orbiter / world releases and combines them into one config.
 *
 * These LOCK CURRENT behavior so the planned refactor (lifting the global
 * `Constants` cache out of the pipeline) can be proven shape-for-shape safe.
 * No source file is changed.
 *
 * The only boundaries stubbed are the network loaders, the toast layer, and
 * i18n. Everything else (the real normalizers, the fallback builders, the live
 * `Constants` singleton cache) runs for real, because that wiring is exactly
 * what we pin.
 *
 *  - (T3) happy path → combined { track, orbiter, entangledWorld, request } with
 *         entangledWorld a SIBLING of track (pre-refactor shape).
 *  - (T4) the path that DOES cache resolved orbiter+world releases is the track
 *         HYDRATION-match path; the plain successful-fetch path does NOT cache
 *         (current behavior — pinned both ways).
 *  - (T6) orbiter loader returns { error } → default orbiter fallback used +
 *         cached at the 'fallback' version + a SINGLE warning toast (once-guard)
 *         + resetOrbiterFallbackNotification re-arms it.
 *  - (T7) world loader throws → world fallback cached at 'fallback';
 *         request with no world id → entangledWorld = normalized default, NOT
 *         cached, loader never called.
 *  - (T8) guards: missing trackId throws; null track payload → null; a world
 *         fetch that RESOLVES null (no throw) → null. (A null orbiter payload
 *         does NOT return null — it routes through the fallback; pinned as such.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- boundary stubs ---------------------------------------------------------
// loaders.js pulls in httpClient (network) at import time; stub the whole module.
// resolveStorageAssetURL is also imported by the REAL normalizers, so keep an
// identity passthrough for it (URLs are not under test here).
vi.mock('../../../src/api/dataManager/loaders.js', () => ({
    fetchTrackRelease: vi.fn(),
    fetchOrbiterRelease: vi.fn(),
    fetchEntangledWorldRelease: vi.fn(),
    resolveStorageAssetURL: (value) => (typeof value === 'string' ? value : null),
}));

// notifications.showToast touches the DOM toast layer; stub the singleton so
// toast calls are observable as plain mock calls.
vi.mock('../../../src/core/AppNotifications.js', () => ({
    default: { showToast: vi.fn() },
}));

// i18n getT returns a translator; stub it to echo the key so toast messages are
// asserted by their i18n key without loading i18next.
vi.mock('../../../src/i18n/index.js', () => ({
    getT: () => (key) => key,
}));

import {
    fetchTrackRelease,
    fetchOrbiterRelease,
    fetchEntangledWorldRelease,
} from '../../../src/api/dataManager/loaders.js';
import notifications from '../../../src/core/AppNotifications.js';
import { Constants } from '../../../src/config/Constants.js';
import { DEFAULT_ORBITER_FALLBACK } from '../../../src/defaults/orbiterFallback.js';
import { DEFAULT_ENTANGLED_WORLD_FALLBACK } from '../../../src/defaults/entangledWorldFallback.js';
import {
    assembleConfig,
    resetOrbiterFallbackNotification,
} from '../../../src/api/dataManager/assembler.js';
import { nestEntangledWorldIntoTrack } from '../../../src/api/dataManager/normalizers.js';

// (T11) The pure world-into-track nesting helper — the lever that lets
// Main.js drop its re-patch. Pure, idempotent, additive (keeps the sibling).
describe('nestEntangledWorldIntoTrack (T11)', () => {
    it('nests entangledWorld under track AND keeps it as a sibling', () => {
        const combined = {
            track: { trackId: 't' },
            orbiter: { orbiterId: 'o' },
            entangledWorld: { worldId: 'w' },
            request: {},
        };
        const out = nestEntangledWorldIntoTrack(combined);
        expect(out.entangledWorld).toBe(combined.entangledWorld); // sibling kept (same ref)
        expect(out.track.entangledWorld).toBe(combined.entangledWorld); // and nested under track
        expect(out.orbiter).toBe(combined.orbiter);
        expect(out.request).toBe(combined.request);
    });
    it('is idempotent (re-applying changes nothing observable)', () => {
        const combined = { track: { trackId: 't' }, entangledWorld: { worldId: 'w' } };
        const once = nestEntangledWorldIntoTrack(combined);
        const twice = nestEntangledWorldIntoTrack(once);
        expect(twice.track.entangledWorld).toBe(once.track.entangledWorld);
        expect(twice.entangledWorld).toBe(once.entangledWorld);
    });
    it('is a no-op when there is no entangledWorld or no track', () => {
        const noWorld = { track: { trackId: 't' }, entangledWorld: null };
        expect(nestEntangledWorldIntoTrack(noWorld)).toBe(noWorld);
        const noTrack = { track: null, entangledWorld: { worldId: 'w' } };
        expect(nestEntangledWorldIntoTrack(noTrack)).toBe(noTrack);
    });
});

// --- raw payload builders (shapes the REAL loaders would return) ------------

function makeTrackPayload({
    trackId = 't1',
    version = 'tv1',
    defaultOrbiterId = 'o1',
    defaultEntangledWorldId = 'w1',
} = {}) {
    return {
        trackId,
        release: {
            version,
            metadata: {
                trackId,
                trackName: 'Test Track',
                defaultOrbiterId,
                defaultEntangledWorldId,
            },
            assets: {},
        },
    };
}

function makeOrbiterPayload({ orbiterId = 'o1', version = 'ov1' } = {}) {
    return {
        success: true,
        orbiterId,
        release: {
            version,
            metadata: {
                orbiterId,
                orbiterName: 'Test Orbiter',
                // A non-empty parameters map + a JSON URL keeps the legacy
                // fallback path from firing for the happy case.
                parameters: {
                    speed: { axis: 'speed', value: 0.5, min: 0, max: 2 },
                },
                orbiterJSONURL: 'orbiter.json',
            },
        },
    };
}

function makeWorldPayload({ worldId = 'w1', version = 'wv1' } = {}) {
    return {
        success: true,
        worldId,
        release: {
            version,
            metadata: {
                worldId,
                artName: 'Test World',
            },
            assets: {},
        },
    };
}

// A track payload carrying a hydration block whose embedded releases match the
// resolved ids — this is the path that DOES populate the Constants cache.
function makeTrackWithHydration() {
    return {
        trackId: 't1',
        release: {
            version: 'tv1',
            metadata: { trackId: 't1', defaultOrbiterId: 'o1', defaultEntangledWorldId: 'w1' },
            assets: {},
        },
        hydration: {
            orbiterId: 'o1',
            orbiterVersion: 'ov1',
            orbiterRelease: {
                version: 'ov1',
                metadata: {
                    orbiterId: 'o1',
                    parameters: { speed: { axis: 'speed', value: 0.5, min: 0, max: 2 } },
                    orbiterJSONURL: 'orbiter.json',
                },
            },
            worldId: 'w1',
            worldVersion: 'wv1',
            worldRelease: {
                version: 'wv1',
                metadata: { worldId: 'w1', permissions: { entityId: 'w1' } },
            },
        },
    };
}

beforeEach(() => {
    // Wipe the live Constants cache so every spec starts from a known empty state.
    Constants.clearAllCaches();
    // The assembler's once-guard flags are module-level `let`s; the only public
    // reset is for the orbiter-fallback flag. Reset it so toast-count specs are
    // independent of order.
    resetOrbiterFallbackNotification();
    vi.clearAllMocks();
});

describe('assembleConfig — guards (T8)', () => {
    it('throws when request.trackId is missing', async () => {
        await expect(assembleConfig({})).rejects.toThrow(
            'trackId is required to assemble configuration data.',
        );
        await expect(assembleConfig(undefined)).rejects.toThrow(
            'trackId is required to assemble configuration data.',
        );
    });

    it('returns null when the track payload is null', async () => {
        fetchTrackRelease.mockResolvedValue(null);
        const result = await assembleConfig({ trackId: 't1' });
        expect(result).toBeNull();
    });

    it('returns null when the world fetch RESOLVES null (no throw)', async () => {
        // A world fetch that resolves null (rather than throwing) is the genuine
        // reachable `return null` for the world branch: the catch-based fallback
        // never runs, so worldPayload stays null and assembleConfig bails out.
        fetchTrackRelease.mockResolvedValue(makeTrackPayload());
        fetchOrbiterRelease.mockResolvedValue(makeOrbiterPayload());
        fetchEntangledWorldRelease.mockResolvedValue(null);
        const result = await assembleConfig({ trackId: 't1' });
        expect(result).toBeNull();
    });

    it('does NOT return null on a null orbiter payload — it routes through the fallback', async () => {
        // CURRENT behavior: a null/error orbiter payload is treated as a fetch
        // failure and routed through createDefaultOrbiterFallback (cached +
        // returned). So the orbiter `return null` branch is unreachable via the
        // fetch path. We pin the real behavior: a non-null fallback orbiter.
        fetchTrackRelease.mockResolvedValue(makeTrackPayload());
        fetchOrbiterRelease.mockResolvedValue(null);
        fetchEntangledWorldRelease.mockResolvedValue(makeWorldPayload());
        const result = await assembleConfig({ trackId: 't1' });
        expect(result).not.toBeNull();
        expect(result.orbiter).toBeTruthy();
        // The fallback resolves its version to 'fallback'.
        expect(result.request.orbiterVersion).toBe('fallback');
    });
});

describe('assembleConfig — happy path (T3)', () => {
    it('returns combined { track, orbiter, entangledWorld, request } — entangledWorld a sibling AND nested under track', async () => {
        fetchTrackRelease.mockResolvedValue(makeTrackPayload());
        fetchOrbiterRelease.mockResolvedValue(makeOrbiterPayload());
        fetchEntangledWorldRelease.mockResolvedValue(makeWorldPayload());

        const result = await assembleConfig({ trackId: 't1' });

        // Top-level shape: exactly four keys.
        expect(Object.keys(result).sort()).toEqual(
            ['entangledWorld', 'orbiter', 'request', 'track'].sort(),
        );

        // entangledWorld is a SIBLING of track AND now nested under track too,
        // so track-scoped readers find it on every path; the sibling is kept (additive).
        expect(result.entangledWorld).toBeTruthy();
        expect(result.track.entangledWorld).toBeTruthy();
        expect(result.track.entangledWorld.worldId).toBe('w1');

        // Each branch is the normalized entity (ids carried through).
        expect(result.track.trackId).toBe('t1');
        expect(result.orbiter.orbiterId).toBe('o1');
        expect(result.entangledWorld.worldId).toBe('w1');

        // request mirrors the resolved ids + versions.
        expect(result.request).toEqual({
            trackId: 't1',
            trackVersion: 'tv1',
            orbiterId: 'o1',
            orbiterVersion: 'ov1',
            entangledWorldId: 'w1',
            entangledWorldVersion: 'wv1',
        });
    });
});

describe('assembleConfig — release caching (T4)', () => {
    it('caches the resolved orbiter + world releases when they arrive via the track HYDRATION-match path', async () => {
        // The hydration block carries embedded releases matching the resolved
        // ids; assembleConfig adopts them via Constants.setOrbiter/WorldRelease
        // and skips the network entirely.
        fetchTrackRelease.mockResolvedValue(makeTrackWithHydration());

        expect(Constants.getOrbiterRelease('o1', { version: 'ov1' })).toBeNull();
        expect(Constants.getWorldRelease('w1', { version: 'wv1' })).toBeNull();

        const result = await assembleConfig({ trackId: 't1' });

        // No loader call — the releases came from hydration.
        expect(fetchOrbiterRelease).not.toHaveBeenCalled();
        expect(fetchEntangledWorldRelease).not.toHaveBeenCalled();

        // Resolved releases are now in the Constants cache at their real versions.
        const cachedOrbiter = Constants.getOrbiterRelease('o1', { version: 'ov1' });
        const cachedWorld = Constants.getWorldRelease('w1', { version: 'wv1' });
        expect(cachedOrbiter).toBeTruthy();
        expect(cachedOrbiter.orbiterId).toBe('o1');
        expect(cachedWorld).toBeTruthy();
        expect(cachedWorld.worldId).toBe('w1');

        // request still mirrors the resolved versions.
        expect(result.request.orbiterVersion).toBe('ov1');
        expect(result.request.entangledWorldVersion).toBe('wv1');
    });

    it('does NOT cache on the plain successful-fetch path (current behavior)', async () => {
        // When releases come straight from the loaders (no hydration, no
        // fallback), assembleConfig does NOT write them into Constants — caching
        // only happens on the hydration-match and fallback branches.
        fetchTrackRelease.mockResolvedValue(makeTrackPayload());
        fetchOrbiterRelease.mockResolvedValue(makeOrbiterPayload());
        fetchEntangledWorldRelease.mockResolvedValue(makeWorldPayload());

        await assembleConfig({ trackId: 't1' });

        expect(Constants.getOrbiterRelease('o1', { version: 'ov1' })).toBeNull();
        expect(Constants.getWorldRelease('w1', { version: 'wv1' })).toBeNull();
        expect(Constants._orbiterReleases.size).toBe(0);
        expect(Constants._worldReleases.size).toBe(0);
    });
});

describe('assembleConfig — orbiter loader error → fallback (T6)', () => {
    it('uses the default orbiter fallback, caches it at the fallback version, and fires a single warning toast', async () => {
        fetchTrackRelease.mockResolvedValue(makeTrackPayload());
        fetchOrbiterRelease.mockResolvedValue({ error: 'kaboom' });
        fetchEntangledWorldRelease.mockResolvedValue(makeWorldPayload());

        const result = await assembleConfig({ trackId: 't1' });

        // Fallback orbiter used and reflected in the request version.
        expect(result.orbiter).toBeTruthy();
        const fallbackVersion = DEFAULT_ORBITER_FALLBACK.release.version; // 'fallback'
        expect(result.request.orbiterVersion).toBe(fallbackVersion);

        // The fallback is cached under the resolved id at the fallback version.
        const cached = Constants.getOrbiterRelease('o1', { version: fallbackVersion });
        expect(cached).toBeTruthy();
        expect(cached.release.version).toBe(fallbackVersion);

        // Exactly one orbiter-fallback toast (once-guard), of type 'warning'
        // (an error was present and it was not a not-found).
        const fallbackToasts = notifications.showToast.mock.calls.filter(
            ([msg]) => msg === 'notifications.orbiterFallback',
        );
        expect(fallbackToasts).toHaveLength(1);
        expect(fallbackToasts[0][1]).toBe('warning');
    });

    it('does NOT fire a second fallback toast until resetOrbiterFallbackNotification re-arms the guard', async () => {
        fetchTrackRelease.mockResolvedValue(makeTrackPayload());
        fetchOrbiterRelease.mockResolvedValue({ error: 'kaboom' });
        fetchEntangledWorldRelease.mockResolvedValue(makeWorldPayload());

        await assembleConfig({ trackId: 't1' });
        // Second assemble with the guard still latched → no new toast.
        await assembleConfig({ trackId: 't1' });

        let fallbackToasts = notifications.showToast.mock.calls.filter(
            ([msg]) => msg === 'notifications.orbiterFallback',
        );
        expect(fallbackToasts).toHaveLength(1);

        // Re-arm the guard, then assemble again → a fresh toast fires.
        resetOrbiterFallbackNotification();
        await assembleConfig({ trackId: 't1' });

        fallbackToasts = notifications.showToast.mock.calls.filter(
            ([msg]) => msg === 'notifications.orbiterFallback',
        );
        expect(fallbackToasts).toHaveLength(2);
    });
});

describe('assembleConfig — world fallbacks (T7)', () => {
    it('caches a world fallback at the fallback version when the world loader throws', async () => {
        fetchTrackRelease.mockResolvedValue(makeTrackPayload());
        fetchOrbiterRelease.mockResolvedValue(makeOrbiterPayload());
        fetchEntangledWorldRelease.mockRejectedValue(new Error('network down'));

        const result = await assembleConfig({ trackId: 't1' });

        // World branch is populated from the cached fallback (keeps the id).
        expect(result.entangledWorld).toBeTruthy();
        expect(result.entangledWorld.worldId).toBe('w1');
        expect(result.request.entangledWorldVersion).toBe('fallback');

        // Fallback cached under the resolved world id at the fallback version.
        const cached = Constants.getWorldRelease('w1', { version: 'fallback' });
        expect(cached).toBeTruthy();
        expect(cached.release.version).toBe('fallback');
    });

    it('uses the normalized default world (NOT cached, loader not called) when there is no world id', async () => {
        // No defaultEntangledWorldId on the track and none in the request →
        // resolvedWorldId stays falsy → the else branch normalizes the local
        // DEFAULT_ENTANGLED_WORLD_FALLBACK without ever touching the cache.
        fetchTrackRelease.mockResolvedValue(
            makeTrackPayload({ defaultEntangledWorldId: null }),
        );
        fetchOrbiterRelease.mockResolvedValue(makeOrbiterPayload());

        const result = await assembleConfig({ trackId: 't1' });

        const expectedWorldId = DEFAULT_ENTANGLED_WORLD_FALLBACK.worldId; // 'fallback-world'
        expect(result.entangledWorld).toBeTruthy();
        expect(result.entangledWorld.worldId).toBe(expectedWorldId);

        // The world loader was never called, and nothing was cached for it.
        expect(fetchEntangledWorldRelease).not.toHaveBeenCalled();
        expect(Constants.getWorldRelease(expectedWorldId)).toBeNull();
        expect(Constants.getWorldRelease(expectedWorldId, { version: 'fallback' })).toBeNull();
        expect(Constants._worldReleases.size).toBe(0);

        // request.entangledWorldId falls back to the normalized world id.
        expect(result.request.entangledWorldId).toBe(expectedWorldId);
    });
});
