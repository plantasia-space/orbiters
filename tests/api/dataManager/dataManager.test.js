// @vitest-environment jsdom
//
// Tests-FIRST: characterization tests that LOCK the CURRENT behavior of the
// DataManager facade's three config-update entry points, with the global `Constants`
// cache still wired in the middle of the pipeline. No source changes — these pass
// against the code as it is now.
//
// jsdom is required: src/config/Constants.js touches `navigator` at import time, and the
// DataManager dispatches CustomEvents on `window` + reads `window.location.search`.
//
// What is mocked (the seams around the method under test):
//   - assembleConfig (./assembler.js)      -> returns a fixed combined payload
//   - fetchTrackUserSettings (../trackUserSettingsService.js) -> the private settings layer
//   - sessionBridge (./sessionBridge.js)   -> safeResolveSession / safeUpdateSession spies
//   - buildEditModeFallback (../../defaults/editModeFallback.js) -> sentinel fallback combined
// `Constants` is the REAL singleton (cleared in beforeEach) — that is the coupling under test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- module mocks (hoisted) ------------------------------------------------
vi.mock('../../../src/api/dataManager/assembler.js', () => ({
    assembleConfig: vi.fn(),
    resetOrbiterFallbackNotification: vi.fn(),
}));

vi.mock('../../../src/api/trackUserSettingsService.js', () => ({
    fetchTrackUserSettings: vi.fn(),
}));

vi.mock('../../../src/api/dataManager/sessionBridge.js', () => ({
    safeResolveSession: vi.fn(),
    safeUpdateSession: vi.fn(),
}));

vi.mock('../../../src/defaults/editModeFallback.js', () => ({
    buildEditModeFallback: vi.fn(),
}));

import { DataManager } from '../../../src/api/dataManager/index.js';
import { Constants } from '../../../src/config/Constants.js';
import { assembleConfig } from '../../../src/api/dataManager/assembler.js';
import { fetchTrackUserSettings } from '../../../src/api/trackUserSettingsService.js';
import { safeResolveSession, safeUpdateSession } from '../../../src/api/dataManager/sessionBridge.js';
import { buildEditModeFallback } from '../../../src/defaults/editModeFallback.js';

// A minimal combined payload shaped like a real assembled config (track/orbiter/world).
function makeCombined(overrides = {}) {
    return {
        track: { trackId: 'track-1', version: '7' },
        orbiter: { orbiterId: 'orb-1', version: 'o2' },
        entangledWorld: { worldId: 'world-1', version: 'w3', modelURL: 'https://cdn/model.glb' },
        ...overrides,
    };
}

// Capture every 'dataManager:configUpdated' event dispatched during a test.
let configUpdatedEvents;
function onConfigUpdated(event) {
    configUpdatedEvents.push(event);
}

beforeEach(() => {
    // Real Constants singleton: wipe the keyed caches + loading flags.
    Constants.clearAllCaches();
    Constants.LOADING_STATE.trackLoaded = false;
    Constants.LOADING_STATE.orbiterLoaded = false;
    Constants.LOADING_STATE.modelLoaded = false;
    Constants.LOADING_STATE.uiReady = false;

    // Reset the notifier / spies.
    vi.clearAllMocks();
    fetchTrackUserSettings.mockResolvedValue(null);

    // Default url (no query params) so resolveConfigRequest falls back to the passed trackId.
    window.history.replaceState({}, '', '/');

    configUpdatedEvents = [];
    window.addEventListener('dataManager:configUpdated', onConfigUpdated);
});

afterEach(() => {
    window.removeEventListener('dataManager:configUpdated', onConfigUpdated);
});

// ===========================================================================
// fetchAndUpdateConfig
// ===========================================================================
describe('DataManager.fetchAndUpdateConfig', () => {
    it('caches the assembled combined under buildConfigKey(request) and exposes it via Constants', async () => {
        const combined = makeCombined();
        assembleConfig.mockResolvedValue(combined);

        const dm = new DataManager();
        await dm.fetchAndUpdateConfig('track-1');

        // CURRENT-BEHAVIOR SURPRISE (locked): the cache key is built from the ORIGINAL
        // resolved request (resolveConfigRequest from URL params), NOT from the richer
        // activeConfigRequest rebuilt from the combined. With no URL params the request
        // carries null orbiter/world/version, so the key is 'track-1|default|default'.
        const expectedKey = Constants.buildConfigKey({ trackId: 'track-1' });
        expect(expectedKey).toBe('track-1|default|default');

        // The keyed snapshot Map is the SOLE store (no TRACK_DATA/CURRENT_CONFIG_KEY).
        expect(Constants.getConfigByTrackId('track-1')).toBe(Constants.getCurrentConfig(expectedKey));
        expect(Constants.getCurrentConfig(expectedKey)).toMatchObject({
            track: { trackId: 'track-1' },
            orbiter: { orbiterId: 'orb-1' },
            entangledWorld: { worldId: 'world-1' },
            trackUserSettings: null,
        });
    });

    it('attaches trackUserSettings from the service onto the cached combined', async () => {
        assembleConfig.mockResolvedValue(makeCombined());
        const settings = { trackId: 'track-1', sync: { bpm: 120 } };
        fetchTrackUserSettings.mockResolvedValue(settings);

        const dm = new DataManager();
        await dm.fetchAndUpdateConfig('track-1');

        const cached = Constants.getConfigByTrackId('track-1');
        expect(cached.trackUserSettings).toBe(settings);
        // attaching is a shallow copy, NOT identity of the assembled object.
        expect(cached).not.toBe(assembleConfig.mock.results[0].value);
    });

    it('sets activeConfigRequest.trackId to the resolved track id (per-voice identity)', async () => {
        assembleConfig.mockResolvedValue(makeCombined());

        const dm = new DataManager();
        await dm.fetchAndUpdateConfig('track-1');

        // Identity lives per-voice on the DataManager instance, not a Constants global.
        expect(dm.activeConfigRequest.trackId).toBe('track-1');
    });

    it('sets the three loading-state flags (trackLoaded, orbiterLoaded, modelLoaded)', async () => {
        assembleConfig.mockResolvedValue(makeCombined());

        const dm = new DataManager();
        await dm.fetchAndUpdateConfig('track-1');

        expect(Constants.LOADING_STATE.trackLoaded).toBe(true);
        expect(Constants.LOADING_STATE.orbiterLoaded).toBe(true); // !!orbiter
        expect(Constants.LOADING_STATE.modelLoaded).toBe(true);   // !!entangledWorld
    });

    it('orbiterLoaded is false when no orbiter, modelLoaded is false when no world', async () => {
        assembleConfig.mockResolvedValue(
            makeCombined({
                orbiter: null,
                entangledWorld: null,
            })
        );

        const dm = new DataManager();
        await dm.fetchAndUpdateConfig('track-1');

        expect(Constants.LOADING_STATE.trackLoaded).toBe(true);
        expect(Constants.LOADING_STATE.orbiterLoaded).toBe(false);
        expect(Constants.LOADING_STATE.modelLoaded).toBe(false);
    });

    it('dispatches exactly one dataManager:configUpdated with detail.combined + detail.request', async () => {
        const combined = makeCombined();
        assembleConfig.mockResolvedValue(combined);

        const dm = new DataManager();
        await dm.fetchAndUpdateConfig('track-1');

        expect(configUpdatedEvents).toHaveLength(1);
        const { detail } = configUpdatedEvents[0];
        // detail.combined is the attached (cached) combined — read back from the keyed snapshot cache.
        expect(detail.combined).toBe(Constants.getConfigByTrackId('track-1'));
        // detail.request is the rebuilt activeConfigRequest derived from the combined.
        expect(detail.request).toMatchObject({
            trackId: 'track-1',
            trackVersion: '7',
            orbiterId: 'orb-1',
            orbiterVersion: 'o2',
            entangledWorldId: 'world-1',
            entangledWorldVersion: 'w3',
            version: '7',
        });
    });

    it('reuses a cached combined (does not call assembleConfig) when Constants already has the key', async () => {
        const expectedKey = Constants.buildConfigKey({ trackId: 'track-1' });
        const cached = makeCombined({ track: { trackId: 'track-1' }, orbiter: null, entangledWorld: null });
        Constants.setCurrentConfig(expectedKey, cached);

        const dm = new DataManager();
        await dm.fetchAndUpdateConfig('track-1');

        expect(assembleConfig).not.toHaveBeenCalled();
        // still fires exactly one event from the cache-hit path.
        expect(configUpdatedEvents).toHaveLength(1);
    });

    it('returns early (no event, no cache write) when assembleConfig resolves null on a cache miss', async () => {
        assembleConfig.mockResolvedValue(null);

        const dm = new DataManager();
        await dm.fetchAndUpdateConfig('track-1');

        expect(configUpdatedEvents).toHaveLength(0);
        // No snapshot is cached on the null-assemble path.
        expect(Constants._configSnapshots.size).toBe(0);
    });
});

// ===========================================================================
// applyResolvedSession
// ===========================================================================
describe('DataManager.applyResolvedSession', () => {
    function makeResolution(overrides = {}) {
        return {
            ok: true,
            track: { trackId: 'track-1', version: '7' },
            orbiter: { orbiterId: 'orb-1', version: 'o2' },
            entangledWorld: { worldId: 'world-1', version: 'w3', modelURL: 'https://cdn/m.glb' },
            request: {},
            ...overrides,
        };
    }

    it('builds a sibling-shape combined snapshot, sets Constants, and dispatches one event', async () => {
        const dm = new DataManager();
        const resolution = makeResolution();

        const returned = dm.applyResolvedSession(resolution);

        // sibling shape: track/orbiter/entangledWorld + trackUserSettings + request
        expect(returned).toMatchObject({
            track: { trackId: 'track-1' },
            orbiter: { orbiterId: 'orb-1' },
            entangledWorld: { worldId: 'world-1' },
            trackUserSettings: null,
        });
        expect(returned.request).toMatchObject({
            trackId: 'track-1',
            orbiterId: 'orb-1',
            entangledWorldId: 'world-1',
            version: '7',
        });

        // Snapshot is stored under the version-bearing config key and is the current config.
        const expectedKey = Constants.buildConfigKey({
            trackId: 'track-1',
            orbiterId: 'orb-1',
            entangledWorldId: 'world-1',
            version: '7',
        });
        expect(Constants.getCurrentConfig(expectedKey)).toBe(returned);

        // Per-voice identity on the instance + loading flags.
        expect(dm.activeConfigRequest.trackId).toBe('track-1');
        expect(Constants.LOADING_STATE.trackLoaded).toBe(true);
        expect(Constants.LOADING_STATE.orbiterLoaded).toBe(true);
        expect(Constants.LOADING_STATE.modelLoaded).toBe(true);

        // Exactly one event carrying the combined + activeConfigRequest.
        expect(configUpdatedEvents).toHaveLength(1);
        expect(configUpdatedEvents[0].detail.combined).toBe(returned);
        expect(configUpdatedEvents[0].detail.request).toMatchObject({ trackId: 'track-1' });

        // It does NOT refetch through assembleConfig.
        expect(assembleConfig).not.toHaveBeenCalled();
        // It bridges the resolved session.
        expect(safeResolveSession).toHaveBeenCalledTimes(1);
    });

    it('returns null without side effects when resolution is missing or not ok', () => {
        const dm = new DataManager();
        expect(dm.applyResolvedSession(null)).toBeNull();
        expect(dm.applyResolvedSession({ ok: false })).toBeNull();
        expect(configUpdatedEvents).toHaveLength(0);
        expect(Constants._configSnapshots.size).toBe(0);
    });

    it('throws when the resolved session is missing track data', () => {
        const dm = new DataManager();
        expect(() => dm.applyResolvedSession({ ok: true, track: null })).toThrow(
            'Resolved session is missing track data.'
        );
    });

    it('prefers resolution.trackUserSettings, then track.trackUserSettings, else null', () => {
        const dm = new DataManager();

        const withTop = dm.applyResolvedSession(
            makeResolution({ trackUserSettings: { from: 'resolution' } })
        );
        expect(withTop.trackUserSettings).toEqual({ from: 'resolution' });

        Constants.clearAllCaches();
        const withTrack = dm.applyResolvedSession(
            makeResolution({
                track: { trackId: 'track-1', version: '7', trackUserSettings: { from: 'track' } },
            })
        );
        expect(withTrack.trackUserSettings).toEqual({ from: 'track' });
    });
});

// ===========================================================================
// applyConfigOverrides — edit-mode fallback
// ===========================================================================
describe('DataManager.applyConfigOverrides edit-mode fallback', () => {
    it('uses buildEditModeFallback().combined when assembleConfig misses and baseTrackId is DEFAULT_EDIT_TRACK_ID', async () => {
        // Pin a concrete edit-track sentinel for this test (env value is undefined otherwise).
        const originalEditId = Constants.DEFAULT_EDIT_TRACK_ID;
        Constants.DEFAULT_EDIT_TRACK_ID = 'edit-track-sentinel';

        try {
            assembleConfig.mockResolvedValue(null); // cache miss + assemble fails
            const fallbackCombined = {
                track: { trackId: 'edit-track-sentinel', version: 'edit' },
                orbiter: { orbiterId: 'orbiter-fallback' },
                entangledWorld: { worldId: 'edit-world' }, // no modelURL
            };
            buildEditModeFallback.mockReturnValue({ combined: fallbackCombined });

            const dm = new DataManager();
            const result = await dm.applyConfigOverrides({ trackId: 'edit-track-sentinel' });

            // buildEditModeFallback was invoked with the edit track id.
            expect(buildEditModeFallback).toHaveBeenCalledWith({ trackId: 'edit-track-sentinel' });

            // The fallback's combined flows through _attachTrackUserSettings (shallow copy +
            // trackUserSettings), then becomes the cached/returned config.
            expect(result).toMatchObject({
                track: { trackId: 'edit-track-sentinel' },
                orbiter: { orbiterId: 'orbiter-fallback' },
                entangledWorld: { worldId: 'edit-world' },
                trackUserSettings: null,
            });
            expect(Constants.getConfigByTrackId('edit-track-sentinel')).toBe(result);
            expect(dm.activeConfigRequest.trackId).toBe('edit-track-sentinel');
            expect(Constants.LOADING_STATE.modelLoaded).toBe(true); // fallback world data present

            // One configUpdated event from the fallback path.
            expect(configUpdatedEvents).toHaveLength(1);
            expect(configUpdatedEvents[0].detail.combined).toBe(result);
        } finally {
            Constants.DEFAULT_EDIT_TRACK_ID = originalEditId;
        }
    });

    it('returns null and marks the session pending when assembleConfig misses for a non-edit track', async () => {
        assembleConfig.mockResolvedValue(null);
        buildEditModeFallback.mockReturnValue({ combined: { track: { trackId: 'x' } } });

        const dm = new DataManager();
        const result = await dm.applyConfigOverrides({ trackId: 'some-other-track' });

        expect(result).toBeNull();
        expect(buildEditModeFallback).not.toHaveBeenCalled();
        expect(safeUpdateSession).toHaveBeenCalledWith(
            { status: 'pending' },
            { source: 'data-manager' }
        );
        expect(configUpdatedEvents).toHaveLength(0);
    });
});

// ===========================================================================
// Per-voice release pin (sessionDescriptor.trackVersion)
// ===========================================================================
// Regression cover for a version that reached the voice but never reached the fetch.
// In the shared multi-orbiter realm every voice reads the SAME page URL, so a per-card
// version pin cannot travel as a URL param — it rides the voice's sessionDescriptor.
// The descriptor used to stop at the voice session: the DataManager never received it and
// resolved the request from the URL alone, so a pinned voice silently loaded the LIVE
// release. Metadata looked right (the host fetched the pinned release itself) while the
// audio was the current version — the bug these tests lock out.
describe('DataManager — per-voice trackVersion pin', () => {
    it('sends the descriptor pin to assembleConfig when the URL carries no version', async () => {
        assembleConfig.mockResolvedValue(makeCombined());

        const dm = new DataManager({ sessionDescriptor: { trackId: 'track-1', trackVersion: 3 } });
        await dm.fetchAndUpdateConfig('track-1');

        expect(assembleConfig).toHaveBeenCalledWith(
            expect.objectContaining({ trackId: 'track-1', trackVersion: 3 })
        );
    });

    it('keys the cache per version so two versions of one track cannot collide', async () => {
        assembleConfig.mockResolvedValue(makeCombined());

        const pinned = new DataManager({ sessionDescriptor: { trackId: 'track-1', trackVersion: 3 } });
        await pinned.fetchAndUpdateConfig('track-1');

        // A different key than the unpinned/live one — otherwise the first voice to load
        // would hand its snapshot to every other voice on the same track.
        expect(pinned.currentConfigKey).not.toBe(Constants.buildConfigKey({ trackId: 'track-1' }));
        expect(pinned.currentConfigKey).toBe(
            Constants.buildConfigKey({ trackId: 'track-1', version: 3 })
        );
    });

    it('leaves an unpinned voice on the live release', async () => {
        assembleConfig.mockResolvedValue(makeCombined());

        const dm = new DataManager({ sessionDescriptor: { trackId: 'track-1' } });
        await dm.fetchAndUpdateConfig('track-1');

        expect(assembleConfig).toHaveBeenCalledWith(
            expect.objectContaining({ trackId: 'track-1', trackVersion: null })
        );
    });

    it('lets the descriptor pin win over a page URL version (the realm shares one URL)', async () => {
        window.history.replaceState({}, '', '/?trackVersion=9');
        assembleConfig.mockResolvedValue(makeCombined());

        const dm = new DataManager({ sessionDescriptor: { trackId: 'track-1', trackVersion: 3 } });
        await dm.fetchAndUpdateConfig('track-1');

        expect(assembleConfig).toHaveBeenCalledWith(
            expect.objectContaining({ trackVersion: 3 })
        );
    });

    it('still honours the URL version for the standalone app (no descriptor)', async () => {
        window.history.replaceState({}, '', '/?trackVersion=9');
        assembleConfig.mockResolvedValue(makeCombined());

        const dm = new DataManager();
        await dm.fetchAndUpdateConfig('track-1');

        expect(assembleConfig).toHaveBeenCalledWith(
            expect.objectContaining({ trackVersion: '9' })
        );
    });
});

// A voice that explicitly unpins must not inherit the page's ?trackVersion=. The realm's URL
// belongs to every voice, so falling through to it would re-pin a card that just went back to
// the live release.
describe('DataManager — explicit unpin beats the shared page URL', () => {
    it('treats a descriptor trackVersion of null as "live release", not "ask the URL"', async () => {
        window.history.replaceState({}, '', '/?trackVersion=9');
        assembleConfig.mockResolvedValue(makeCombined());

        const dm = new DataManager({ sessionDescriptor: { trackId: 'track-1', trackVersion: null } });
        await dm.fetchAndUpdateConfig('track-1');

        expect(assembleConfig).toHaveBeenCalledWith(
            expect.objectContaining({ trackVersion: null })
        );
    });

    it('treats an undefined trackVersion on a voice descriptor the same way', async () => {
        window.history.replaceState({}, '', '/?trackVersion=9');
        assembleConfig.mockResolvedValue(makeCombined());

        // makeOrbiterVoiceSession always sets the key, undefined when the host did not pin.
        const dm = new DataManager({
            sessionDescriptor: { trackId: 'track-1', trackVersion: undefined },
        });
        await dm.fetchAndUpdateConfig('track-1');

        expect(assembleConfig).toHaveBeenCalledWith(
            expect.objectContaining({ trackVersion: null })
        );
    });
});
