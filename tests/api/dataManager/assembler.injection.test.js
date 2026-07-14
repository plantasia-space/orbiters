// @vitest-environment jsdom
// (src/config/Constants.js touches `navigator`/`window` at import time — needs a
//  browser-like global, matching the sibling assembler.test.js. The toast layer is
//  still mocked, so no real DOM notification is created; jsdom is only here to
//  satisfy the Constants import we assert against.)
/**
 * Seam proof: assembleConfig now accepts an injectable
 * `{ cache, fallbacks, notify }`. These tests prove the seam works end-to-end:
 *
 *  - the resolved releases are written into the INJECTED cache double, and the
 *    global `Constants` singleton stays empty for those ids (no module-global
 *    side-effect leaks out of the pipeline);
 *  - the loader calls receive the injected cache (so an injected cache flows all
 *    the way down to the fetchers);
 *  - an injected `fallbacks` strategy is used (its factories produce the fallback
 *    payloads), and an injected `notify` object receives the toast intents —
 *    instead of the module-singleton notifier;
 *  - the combined output keeps the pre-refactor shape (entangledWorld a SIBLING
 *    of track).
 *
 * The default-parameter equality (`cache = Constants`, etc.) means production is
 * byte-identical; the characterization suite (assembler.test.js) pins that. This
 * file only exercises the NEW injected path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the network loaders (same boundary the characterization suite stubs). The
// real assembler still passes its `cache` down to these — we assert that below.
vi.mock('../../../src/api/dataManager/loaders.js', () => ({
    fetchTrackRelease: vi.fn(),
    fetchOrbiterRelease: vi.fn(),
    fetchEntangledWorldRelease: vi.fn(),
    resolveStorageAssetURL: (value) => (typeof value === 'string' ? value : null),
}));

// notifications.showToast touches the DOM toast layer; stub the singleton. We do
// NOT want the DEFAULT notifier firing here — we inject our own — but the default
// notifier still exists at module scope, so keep the toast layer harmless.
vi.mock('../../../src/core/AppNotifications.js', () => ({
    default: { showToast: vi.fn() },
}));

vi.mock('../../../src/i18n/index.js', () => ({
    getT: () => (key) => key,
}));

import {
    fetchTrackRelease,
    fetchOrbiterRelease,
    fetchEntangledWorldRelease,
} from '../../../src/api/dataManager/loaders.js';
import { Constants } from '../../../src/config/Constants.js';
import { assembleConfig } from '../../../src/api/dataManager/assembler.js';
import { createInMemoryReleaseCache } from './helpers/InMemoryReleaseCache.js';

// A track payload whose hydration block embeds releases matching the resolved
// ids — this is the path that adopts the embedded releases and caches them via
// cache.set{Orbiter,World}Release. Distinct ids so we can assert isolation from
// any other spec's writes to the global Constants singleton.
function makeTrackWithHydration() {
    return {
        trackId: 'inj-t1',
        release: {
            version: 'tv1',
            metadata: { trackId: 'inj-t1', defaultOrbiterId: 'inj-o1', defaultEntangledWorldId: 'inj-w1' },
            assets: {},
        },
        hydration: {
            orbiterId: 'inj-o1',
            orbiterVersion: 'ov1',
            orbiterRelease: {
                version: 'ov1',
                metadata: {
                    orbiterId: 'inj-o1',
                    parameters: { speed: { axis: 'speed', value: 0.5, min: 0, max: 2 } },
                    orbiterJSONURL: 'orbiter.json',
                },
            },
            worldId: 'inj-w1',
            worldVersion: 'wv1',
            worldRelease: {
                version: 'wv1',
                metadata: { worldId: 'inj-w1', permissions: { entityId: 'inj-w1' } },
            },
        },
    };
}

function makeTrackPayload() {
    return {
        trackId: 'inj-t1',
        release: {
            version: 'tv1',
            metadata: {
                trackId: 'inj-t1',
                defaultOrbiterId: 'inj-o1',
                defaultEntangledWorldId: 'inj-w1',
            },
            assets: {},
        },
    };
}

function makeOrbiterPayload() {
    return {
        success: true,
        orbiterId: 'inj-o1',
        release: {
            version: 'ov1',
            metadata: {
                orbiterId: 'inj-o1',
                orbiterName: 'Injected Orbiter',
                parameters: { speed: { axis: 'speed', value: 0.5, min: 0, max: 2 } },
                orbiterJSONURL: 'orbiter.json',
            },
        },
    };
}

// A minimal stub fallback strategy that records its calls and returns payloads
// the assembler can normalize + cache.
function makeStubFallbacks() {
    return {
        createOrbiterFallback: vi.fn(({ orbiterId, version }) => ({
            success: true,
            orbiterId,
            release: {
                version,
                metadata: { orbiterId, orbiterName: 'Stub Fallback Orbiter', parameters: {}, orbiterJSONURL: 'stub.json' },
            },
        })),
        createWorldFallback: vi.fn(({ worldId, version }) => ({
            success: true,
            worldId,
            release: {
                version,
                metadata: { worldId, permissions: { entityId: worldId } },
            },
        })),
        createDefaultWorld: vi.fn(() => null),
    };
}

// A stub notifier that records intents instead of firing toasts.
function makeStubNotify() {
    return {
        notifyWorldPreviewUnavailable: vi.fn(),
        notifyOrbiterPreviewUnavailable: vi.fn(),
        notifyOrbiterFallback: vi.fn(),
        clearOrbiterFallback: vi.fn(),
        notifyWorldUnavailable: vi.fn(),
        reset: vi.fn(),
    };
}

beforeEach(() => {
    Constants.clearAllCaches();
    vi.clearAllMocks();
});

describe('assembleConfig — injected seam', () => {
    it('caches resolved releases into the INJECTED cache and leaves global Constants untouched', async () => {
        const cache = createInMemoryReleaseCache();
        const fallbacks = makeStubFallbacks();
        const notify = makeStubNotify();

        fetchTrackRelease.mockResolvedValue(makeTrackWithHydration());

        const result = await assembleConfig(
            { trackId: 'inj-t1' },
            { cache, fallbacks, notify },
        );

        // Top-level shape unchanged (4 keys); nests the world UNDER track too.
        expect(Object.keys(result).sort()).toEqual(
            ['entangledWorld', 'orbiter', 'request', 'track'].sort(),
        );
        expect(result.entangledWorld).toBeTruthy();
        expect(result.track.entangledWorld).toBeTruthy();
        expect(result.track.entangledWorld.worldId).toBe('inj-w1');
        expect(result.track.trackId).toBe('inj-t1');
        expect(result.orbiter.orbiterId).toBe('inj-o1');
        expect(result.entangledWorld.worldId).toBe('inj-w1');

        // The resolved releases landed in the INJECTED double…
        const cachedOrbiter = cache.getOrbiterRelease('inj-o1', { version: 'ov1' });
        const cachedWorld = cache.getWorldRelease('inj-w1', { version: 'wv1' });
        expect(cachedOrbiter).toBeTruthy();
        expect(cachedOrbiter.orbiterId).toBe('inj-o1');
        expect(cachedWorld).toBeTruthy();
        expect(cachedWorld.worldId).toBe('inj-w1');

        // …and NOT in the global Constants singleton (proving no module-global leak).
        expect(Constants.getOrbiterRelease('inj-o1', { version: 'ov1' })).toBeNull();
        expect(Constants.getWorldRelease('inj-w1', { version: 'wv1' })).toBeNull();
        expect(Constants._orbiterReleases.size).toBe(0);
        expect(Constants._worldReleases.size).toBe(0);
        expect(Constants._trackReleases.size).toBe(0);

        // The hydration-match path doesn't need fallbacks; the stub strategy was
        // never invoked. The injected notifier received the (no-op) preview checks.
        expect(fallbacks.createOrbiterFallback).not.toHaveBeenCalled();
        expect(fallbacks.createWorldFallback).not.toHaveBeenCalled();
        expect(notify.notifyWorldPreviewUnavailable).toHaveBeenCalledTimes(1);
        expect(notify.notifyOrbiterPreviewUnavailable).toHaveBeenCalledTimes(1);
        expect(notify.clearOrbiterFallback).toHaveBeenCalledTimes(1);
    });

    it('flows the injected cache down to every loader call', async () => {
        const cache = createInMemoryReleaseCache();
        const fallbacks = makeStubFallbacks();
        const notify = makeStubNotify();

        // Plain successful-fetch path (no hydration block) so all three loaders run.
        fetchTrackRelease.mockResolvedValue(makeTrackPayload());
        fetchOrbiterRelease.mockResolvedValue(makeOrbiterPayload());
        fetchEntangledWorldRelease.mockResolvedValue({
            success: true,
            worldId: 'inj-w1',
            release: { version: 'wv1', metadata: { worldId: 'inj-w1', artName: 'Injected World' } },
        });

        await assembleConfig({ trackId: 'inj-t1' }, { cache, fallbacks, notify });

        // Each loader received the injected cache (so a fetch-miss would write to it).
        expect(fetchTrackRelease).toHaveBeenCalledWith(
            'inj-t1',
            expect.objectContaining({ cache }),
        );
        expect(fetchOrbiterRelease).toHaveBeenCalledWith(
            'inj-o1',
            expect.objectContaining({ cache }),
        );
        expect(fetchEntangledWorldRelease).toHaveBeenCalledWith(
            'inj-w1',
            expect.objectContaining({ cache }),
        );
    });

    it('uses the injected fallbacks strategy when the orbiter loader errors, caching the stub fallback into the injected cache', async () => {
        const cache = createInMemoryReleaseCache();
        const fallbacks = makeStubFallbacks();
        const notify = makeStubNotify();

        fetchTrackRelease.mockResolvedValue(makeTrackPayload());
        fetchOrbiterRelease.mockResolvedValue({ error: 'kaboom' });
        fetchEntangledWorldRelease.mockResolvedValue({
            success: true,
            worldId: 'inj-w1',
            release: { version: 'wv1', metadata: { worldId: 'inj-w1', artName: 'Injected World' } },
        });

        const result = await assembleConfig({ trackId: 'inj-t1' }, { cache, fallbacks, notify });

        // The INJECTED fallback factory produced the orbiter payload.
        expect(fallbacks.createOrbiterFallback).toHaveBeenCalledTimes(1);
        expect(result.orbiter).toBeTruthy();
        expect(result.orbiter.orbiterId).toBe('inj-o1');

        // The injected notifier received the fallback intent (not the global default).
        expect(notify.notifyOrbiterFallback).toHaveBeenCalledTimes(1);
        expect(notify.notifyOrbiterFallback).toHaveBeenCalledWith(
            expect.objectContaining({ unavailableInfo: null, isNotFound: false }),
        );

        // The stub fallback was cached into the INJECTED double, never the global.
        const cached = cache.getOrbiterRelease('inj-o1', { version: result.request.orbiterVersion });
        expect(cached).toBeTruthy();
        expect(Constants._orbiterReleases.size).toBe(0);
    });
});
