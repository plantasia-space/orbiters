// @vitest-environment jsdom
// (loaders.js registers a window 'message' listener at import time, and
//  Constants.js touches `navigator` at import time — both require a
//  browser-like global, so this file runs in jsdom.)
//
// Tests-first: characterization tests that LOCK CURRENT behavior of
// src/api/dataManager/loaders.js — the raw fetch + Constants-cache pipeline that
// a future refactor will lift the global Constants cache out of. No production
// behavior is changed by these tests; they pass against the code AS IT IS NOW.
//
// The HTTP layer (fetchJsonFromApi), the notifications singleton, and getT are
// mocked. The REAL Constants singleton is used so cache HIT/MISS round-trips are
// genuine (clearAllCaches() between tests keeps it isolated).
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- mock the HTTP layer + notifications + i18n ----------------------------
vi.mock('../../../src/api/httpClient.js', () => ({
    fetchJsonFromApi: vi.fn(),
}));
vi.mock('../../../src/core/AppNotifications.js', () => ({
    default: { showToast: vi.fn() },
}));
vi.mock('../../../src/i18n/index.js', () => ({
    getT: vi.fn(() => (key) => key),
}));

import { fetchJsonFromApi } from '../../../src/api/httpClient.js';
import notifications from '../../../src/core/AppNotifications.js';
import { Constants } from '../../../src/config/Constants.js';
import {
    fetchTrackRelease,
    fetchOrbiterRelease,
    fetchEntangledWorldRelease,
    fetchReleaseFromApi,
    getEmbeddedAuthToken,
    resolveStorageAssetURL,
    resetStorageBaseCache,
} from '../../../src/api/dataManager/loaders.js';

// Build a minimal fake Response that fetchReleaseFromApi understands.
function fakeResponse({ ok = true, status = 200, json } = {}) {
    return {
        ok,
        status,
        json: vi.fn(async () => (typeof json === 'function' ? json() : json)),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    Constants.clearAllCaches();
    Constants.TRACK_ID = null;
    resetStorageBaseCache();
    // Reset window globals the storage-base resolver consults.
    delete window.STORAGE_BASE;
    delete window.VITE_PUBLIC_HERBARIUM_BASE;
    delete window.PUBLIC_HERBARIUM_BASE;
    delete window.__PUBLIC_HERBARIUM_BASE__;
    delete window.ASSET_BASE;
    delete window.ASSETS_BASE;
    delete window.STORAGE_BASE_URL;
    delete window.PUBLIC_STORAGE_BASE;
});

// ===========================================================================
// fetchTrackRelease — cache HIT vs cache MISS
// ===========================================================================
describe('fetchTrackRelease', () => {
    it('cache HIT: returns the cached release without any HTTP call', async () => {
        const cached = { success: true, trackId: 't1', cached: true };
        Constants.setTrackRelease('t1', cached);

        const result = await fetchTrackRelease('t1');

        expect(result).toBe(cached);
        expect(fetchJsonFromApi).not.toHaveBeenCalled();
    });

    it('cache MISS: fetches, writes to Constants, and returns the STORED value', async () => {
        const payload = { success: true, trackId: 't1', fresh: true };
        fetchJsonFromApi.mockResolvedValue(fakeResponse({ json: payload }));

        const result = await fetchTrackRelease('t1');

        expect(fetchJsonFromApi).toHaveBeenCalledTimes(1);
        // setTrackRelease returns the stored release; the loader returns that.
        expect(result).toBe(payload);
        // And the value is now in the cache (a subsequent get is a HIT).
        expect(Constants.getTrackRelease('t1')).toBe(payload);
    });

    it('cache MISS path hits the /tracks/<id>/release endpoint with the track label', async () => {
        const payload = { success: true };
        fetchJsonFromApi.mockResolvedValue(fakeResponse({ json: payload }));

        await fetchTrackRelease('abc');

        const [path] = fetchJsonFromApi.mock.calls[0];
        expect(path).toContain('/tracks/abc/release');
    });

    it('throws when trackId is missing', async () => {
        await expect(fetchTrackRelease()).rejects.toThrow(
            'trackId is required to fetch track release data.'
        );
        expect(fetchJsonFromApi).not.toHaveBeenCalled();
    });

    it('cached-but-unhydrated + hydrate requested: re-fetches instead of returning the cache', async () => {
        // A cached release WITHOUT hydration.orbiterRelease/worldRelease does not satisfy
        // a hydrate request, so the loader bypasses the cache and fetches.
        Constants.setTrackRelease('t1', { success: true, noHydration: true });
        const hydrated = {
            success: true,
            hydration: { orbiterRelease: {}, worldRelease: {} },
        };
        fetchJsonFromApi.mockResolvedValue(fakeResponse({ json: hydrated }));

        const result = await fetchTrackRelease('t1', { hydrate: 'full' });

        expect(fetchJsonFromApi).toHaveBeenCalledTimes(1);
        expect(result).toBe(hydrated);
    });

    it('cached-AND-hydrated + hydrate requested: HIT, no HTTP', async () => {
        const cached = {
            success: true,
            hydration: { orbiterRelease: {}, worldRelease: {} },
        };
        Constants.setTrackRelease('t1', cached);

        const result = await fetchTrackRelease('t1', { hydrate: 'full' });

        expect(result).toBe(cached);
        expect(fetchJsonFromApi).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// fetchOrbiterRelease — cache HIT/MISS + fallback semantics
// ===========================================================================
describe('fetchOrbiterRelease', () => {
    it('cache HIT: returns the cached release without any HTTP call', async () => {
        const cached = { success: true, orbiterId: 'o1' };
        Constants.setOrbiterRelease('o1', cached);

        const result = await fetchOrbiterRelease('o1');

        expect(result).toBe(cached);
        expect(fetchJsonFromApi).not.toHaveBeenCalled();
    });

    it('cache MISS: fetches, writes, and returns the STORED value', async () => {
        const payload = { success: true, orbiterId: 'o1' };
        fetchJsonFromApi.mockResolvedValue(fakeResponse({ json: payload }));

        const result = await fetchOrbiterRelease('o1');

        expect(fetchJsonFromApi).toHaveBeenCalledTimes(1);
        expect(result).toBe(payload);
        expect(Constants.getOrbiterRelease('o1')).toBe(payload);
    });

    it('throws when orbiterId is missing', async () => {
        await expect(fetchOrbiterRelease()).rejects.toThrow(
            'orbiterId is required to fetch orbiter release data.'
        );
    });

    it('on failure with useFallback (default): returns the error-object instead of throwing', async () => {
        // A 500 with no body → fetchReleaseFromApi throws; the loader catches it.
        fetchJsonFromApi.mockResolvedValue(
            fakeResponse({ ok: false, status: 500, json: null })
        );

        const result = await fetchOrbiterRelease('o1', { version: 'v9' });

        expect(result).toMatchObject({
            orbiterId: 'o1',
            version: 'v9',
            isNotFound: false,
        });
        expect(result.error).toBeInstanceOf(Error);
        // Nothing got cached on the failure path.
        expect(Constants.getOrbiterRelease('o1', { version: 'v9' })).toBeNull();
    });

    it('on failure with useFallback:false: rethrows the underlying error', async () => {
        fetchJsonFromApi.mockResolvedValue(
            fakeResponse({ ok: false, status: 500, json: null })
        );

        await expect(
            fetchOrbiterRelease('o1', { useFallback: false })
        ).rejects.toThrow();
    });

    it('error-object marks isNotFound:true when the underlying error is orbiter-not-found (404)', async () => {
        fetchJsonFromApi.mockResolvedValue(
            fakeResponse({ ok: false, status: 404, json: null })
        );

        const result = await fetchOrbiterRelease('o1');

        expect(result.isNotFound).toBe(true);
    });
});

// ===========================================================================
// fetchEntangledWorldRelease — cache HIT/MISS
// ===========================================================================
describe('fetchEntangledWorldRelease', () => {
    it('cache HIT: returns the cached release without any HTTP call', async () => {
        const cached = { success: true, worldId: 'w1' };
        Constants.setWorldRelease('w1', cached);

        const result = await fetchEntangledWorldRelease('w1');

        expect(result).toBe(cached);
        expect(fetchJsonFromApi).not.toHaveBeenCalled();
    });

    it('cache MISS: fetches, writes, and returns the STORED value', async () => {
        const payload = { success: true, worldId: 'w1' };
        fetchJsonFromApi.mockResolvedValue(fakeResponse({ json: payload }));

        const result = await fetchEntangledWorldRelease('w1');

        expect(fetchJsonFromApi).toHaveBeenCalledTimes(1);
        expect(result).toBe(payload);
        expect(Constants.getWorldRelease('w1')).toBe(payload);
    });

    it('throws when worldId is missing', async () => {
        await expect(fetchEntangledWorldRelease()).rejects.toThrow(
            'entangled world id is required to fetch world release data.'
        );
    });
});

// ===========================================================================
// fetchReleaseFromApi — 403 + embedded-auth path returns null
// ===========================================================================
describe('fetchReleaseFromApi — 403 + embedded-auth', () => {
    it('403 while inside an iframe with no token → requests auth and returns null', async () => {
        // requestEmbeddedAuthToken() returns true only when there is no embedded token
        // AND window.parent !== window (i.e. embedded in a parent frame). jsdom's default
        // window.parent === window, so stub a distinct parent with postMessage.
        const postMessage = vi.fn();
        const originalParent = window.parent;
        Object.defineProperty(window, 'parent', {
            value: { postMessage },
            configurable: true,
        });

        try {
            fetchJsonFromApi.mockResolvedValue(
                fakeResponse({ ok: false, status: 403, json: null })
            );

            const result = await fetchReleaseFromApi('/tracks/x/release', 'track');

            expect(result).toBeNull();
            expect(postMessage).toHaveBeenCalledWith({ type: 'needAuth' }, '*');
            // The 403 short-circuits before any error toast.
            expect(notifications.showToast).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(window, 'parent', {
                value: originalParent,
                configurable: true,
            });
        }
    });

    it('non-403 failure (500) shows an error toast and throws', async () => {
        fetchJsonFromApi.mockResolvedValue(
            fakeResponse({ ok: false, status: 500, json: { message: 'boom' } })
        );

        await expect(
            fetchReleaseFromApi('/tracks/x/release', 'track')
        ).rejects.toThrow('boom');
        expect(notifications.showToast).toHaveBeenCalledWith('boom', 'error');
    });

    it('404 throws an <entity>-not-found error WITHOUT a toast', async () => {
        fetchJsonFromApi.mockResolvedValue(
            fakeResponse({ ok: false, status: 404, json: null })
        );

        await expect(
            fetchReleaseFromApi('/orbiters/x/release', 'orbiter')
        ).rejects.toThrow('orbiter-not-found');
        expect(notifications.showToast).not.toHaveBeenCalled();
    });

    it('ok response with success:false shows a toast and throws the payload message', async () => {
        fetchJsonFromApi.mockResolvedValue(
            fakeResponse({ ok: true, status: 200, json: { success: false, message: 'nope' } })
        );

        await expect(
            fetchReleaseFromApi('/tracks/x/release', 'track')
        ).rejects.toThrow('nope');
        expect(notifications.showToast).toHaveBeenCalledWith('nope', 'error');
    });
});

// ===========================================================================
// resolveStorageAssetURL — http passthrough + base join
// ===========================================================================
describe('resolveStorageAssetURL', () => {
    it('passes through an absolute http(s) URL untouched', () => {
        expect(resolveStorageAssetURL('https://cdn.example.com/a.png')).toBe(
            'https://cdn.example.com/a.png'
        );
        expect(resolveStorageAssetURL('http://cdn.example.com/a.png')).toBe(
            'http://cdn.example.com/a.png'
        );
    });

    it('joins a relative key onto the resolved base, stripping leading slashes + trailing base slash', () => {
        window.STORAGE_BASE = 'https://storage.example.com/';
        resetStorageBaseCache();

        expect(resolveStorageAssetURL('/icons/leaf.png')).toBe(
            'https://storage.example.com/icons/leaf.png'
        );
        expect(resolveStorageAssetURL('icons/leaf.png')).toBe(
            'https://storage.example.com/icons/leaf.png'
        );
    });

    it('returns null for a falsy or non-string key', () => {
        expect(resolveStorageAssetURL('')).toBeNull();
        expect(resolveStorageAssetURL(null)).toBeNull();
        expect(resolveStorageAssetURL(42)).toBeNull();
    });

    it('returns null for a relative key when no storage base is resolvable', () => {
        // No window.* base set and no env → base resolves to '' → null.
        resetStorageBaseCache();
        expect(resolveStorageAssetURL('icons/leaf.png')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// The import-time 'message' listener only accepts tokens from the embedding
// parent window; any other sender must never become the API identity.
// NOTE: the accept case runs LAST in this file — it sets the module-level
// embedded token, which sticks for the rest of the process.
describe('embedded-auth message listener — sender guard', () => {
    function dispatchAuthMessage({ source }) {
        const event = new Event('message');
        event.data = { type: 'authToken', token: 'msg-token' };
        event.source = source;
        event.origin = 'https://host.example';
        window.dispatchEvent(event);
    }

    function stubParent(value) {
        Object.defineProperty(window, 'parent', { value, configurable: true });
    }

    it('ignores auth tokens when not embedded (window.parent === window)', () => {
        dispatchAuthMessage({ source: null });
        expect(getEmbeddedAuthToken()).toBeNull();
    });

    it('ignores auth tokens from windows other than the parent', () => {
        const originalParent = window.parent;
        stubParent({ postMessage: vi.fn() });
        try {
            dispatchAuthMessage({ source: { someOther: 'window' } });
            expect(getEmbeddedAuthToken()).toBeNull();
        } finally {
            stubParent(originalParent);
        }
    });

    it('accepts an auth token posted by the embedding parent', () => {
        const originalParent = window.parent;
        const parentStub = { postMessage: vi.fn() };
        stubParent(parentStub);
        try {
            dispatchAuthMessage({ source: parentStub });
            expect(getEmbeddedAuthToken()).toBe('Bearer msg-token');
        } finally {
            stubParent(originalParent);
        }
    });
});
