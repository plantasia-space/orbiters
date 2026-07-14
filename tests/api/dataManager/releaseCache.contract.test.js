// @vitest-environment jsdom
// (src/config/Constants.js touches `navigator` at import time — needs a browser-like global,
//  matching tests/input/source/priority.test.js. The InMemoryReleaseCache double itself is
//  dependency-free; only the real-singleton adapter forces jsdom here.)
//
// Tests-first: characterization PARITY CONTRACT over the release/config cache surface.
// A describe.each runs the IDENTICAL spec against TWO adapters:
//   (a) the live `Constants` singleton (src/config/Constants.js), and
//   (b) a fresh InMemoryReleaseCache double.
// Both MUST behave identically — this is the "two adapters justify the seam" proof: it shows the
// double is observationally equivalent to `Constants` for the methods the DataManager pipeline
// uses, so a future refactor can inject either behind the same seam. These lock CURRENT behavior;
// no source change is made.
import { describe, it, expect, beforeEach } from 'vitest';
import { Constants } from '../../../src/config/Constants.js';
import { InMemoryReleaseCache, createInMemoryReleaseCache } from './helpers/InMemoryReleaseCache.js';

// Each adapter exposes a `cache` getter (the object under test) and a `reset()` that returns it
// to a clean baseline before every test.
const adapters = [
    {
        name: 'Constants singleton (real)',
        make() {
            return {
                cache: Constants,
                reset() {
                    Constants.clearAllCaches();
                    return Constants;
                },
            };
        },
    },
    {
        name: 'InMemoryReleaseCache (double)',
        make() {
            return {
                cache: createInMemoryReleaseCache(),
                reset() {
                    // A fresh instance per spec — but mirror the real adapter's reset surface too.
                    const cache = new InMemoryReleaseCache();
                    cache.clearAllCaches();
                    this.cache = cache;
                    return cache;
                },
            };
        },
    },
];

describe.each(adapters)('release cache parity — $name', ({ make }) => {
    let cache;

    beforeEach(() => {
        const adapter = make();
        cache = adapter.reset();
    });

    // --- per-entity set/get round-trip -------------------------------------

    it('round-trips a track release (set returns it, get reads it back)', () => {
        const release = { trackId: 't1', payload: 'track' };
        const returned = cache.setTrackRelease('t1', release);
        expect(returned).toBe(release); // set* returns the stored release (load-bearing)
        expect(cache.getTrackRelease('t1')).toBe(release);
    });

    it('round-trips an orbiter release (set returns it, get reads it back)', () => {
        const release = { orbiterId: 'o1', payload: 'orbiter' };
        const returned = cache.setOrbiterRelease('o1', release);
        expect(returned).toBe(release);
        expect(cache.getOrbiterRelease('o1')).toBe(release);
    });

    it('round-trips a world release (set returns it, get reads it back)', () => {
        const release = { worldId: 'w1', payload: 'world' };
        const returned = cache.setWorldRelease('w1', release);
        expect(returned).toBe(release);
        expect(cache.getWorldRelease('w1')).toBe(release);
    });

    // --- versioned vs unversioned keys are distinct ------------------------

    it('keeps versioned and unversioned track keys distinct', () => {
        const base = { v: 'none' };
        const v2 = { v: '2' };
        cache.setTrackRelease('t1', base);
        cache.setTrackRelease('t1', v2, { version: '2' });
        expect(cache.getTrackRelease('t1')).toBe(base);
        expect(cache.getTrackRelease('t1', { version: '2' })).toBe(v2);
        // a different version is a miss
        expect(cache.getTrackRelease('t1', { version: '3' })).toBeNull();
    });

    it('keeps versioned and unversioned orbiter keys distinct', () => {
        const base = { v: 'none' };
        const v2 = { v: '2' };
        cache.setOrbiterRelease('o1', base);
        cache.setOrbiterRelease('o1', v2, { version: '2' });
        expect(cache.getOrbiterRelease('o1')).toBe(base);
        expect(cache.getOrbiterRelease('o1', { version: '2' })).toBe(v2);
    });

    it('keeps versioned and unversioned world keys distinct', () => {
        const base = { v: 'none' };
        const v2 = { v: '2' };
        cache.setWorldRelease('w1', base);
        cache.setWorldRelease('w1', v2, { version: '2' });
        expect(cache.getWorldRelease('w1')).toBe(base);
        expect(cache.getWorldRelease('w1', { version: '2' })).toBe(v2);
    });

    // --- get-miss returns null ---------------------------------------------

    it('returns null on a release miss for every entity', () => {
        expect(cache.getTrackRelease('nope')).toBeNull();
        expect(cache.getOrbiterRelease('nope')).toBeNull();
        expect(cache.getWorldRelease('nope')).toBeNull();
    });

    // --- invalid id rejection ----------------------------------------------

    it('throws on a non-string release id (via buildCacheKey)', () => {
        expect(() => cache.setTrackRelease('', {})).toThrow('Invalid cache key id. Must be a string.');
        expect(() => cache.getTrackRelease(null)).toThrow('Invalid cache key id. Must be a string.');
        expect(() => cache.setOrbiterRelease(undefined, {})).toThrow('Invalid cache key id. Must be a string.');
        expect(() => cache.setWorldRelease(42, {})).toThrow('Invalid cache key id. Must be a string.');
    });

    // --- buildConfigKey -----------------------------------------------------

    it('buildConfigKey throws when trackId is missing', () => {
        expect(() => cache.buildConfigKey({})).toThrow('trackId is required to build a config key.');
        expect(() => cache.buildConfigKey({ trackId: '' })).toThrow('trackId is required to build a config key.');
    });

    it('buildConfigKey joins parts with default placeholders and optional version', () => {
        expect(cache.buildConfigKey({ trackId: 't1' })).toBe('t1|default|default');
        expect(cache.buildConfigKey({ trackId: 't1', orbiterId: 'o1' })).toBe('t1|o1|default');
        expect(cache.buildConfigKey({ trackId: 't1', orbiterId: 'o1', entangledWorldId: 'w1' }))
            .toBe('t1|o1|w1');
        expect(cache.buildConfigKey({ trackId: 't1', orbiterId: 'o1', entangledWorldId: 'w1', version: 7 }))
            .toBe('t1|o1|w1|7');
        // version is coerced via String()
        expect(cache.buildConfigKey({ trackId: 't1', version: 'rev-a' })).toBe('t1|default|default|rev-a');
    });

    // --- getCurrentConfig: snapshot, then CURRENT_CONFIG_KEY/TRACK_DATA fallback ---

    it('getCurrentConfig reads back the exact snapshot just set', () => {
        const data = { combined: true };
        cache.setCurrentConfig('t1|default|default', data);
        expect(cache.getCurrentConfig('t1|default|default')).toBe(data);
    });

    it('getCurrentConfig returns null when the snapshot Map misses (no single-current fallback)', () => {
        const data = { combined: true };
        cache.setCurrentConfig('k1', data);
        cache._configSnapshots.delete('k1');
        // The keyed snapshot Map is the SOLE store — there is no CURRENT_CONFIG_KEY/TRACK_DATA fallback.
        expect(cache.getCurrentConfig('k1')).toBeNull();
    });

    it('getCurrentConfig returns null when neither snapshot nor current-key matches', () => {
        cache.setCurrentConfig('k1', { a: 1 });
        expect(cache.getCurrentConfig('k2')).toBeNull();
    });

    it('getCurrentConfig throws on an invalid configKey', () => {
        expect(() => cache.getCurrentConfig('')).toThrow('Invalid configKey. Must be a string.');
        expect(() => cache.setCurrentConfig(null, {})).toThrow('Invalid configKey. Must be a string.');
    });

    // --- setTrackData / getTrackData / clearTrackData ----------------------

    it('setTrackData stores under the assembled config key; getTrackData resolves it by trackId prefix', () => {
        const data = {
            orbiter: { orbiterId: 'o1' },
            entangledWorld: { worldId: 'w1' },
        };
        cache.setTrackData('t1', data);
        // setTrackData builds 't1|o1|w1' from the nested ids.
        expect(cache.getCurrentConfig('t1|o1|w1')).toBe(data);
        // getTrackData('t1') now resolves the snapshot via getConfigByTrackId's prefix scan
        // (replacing the old single-current TRACK_DATA fallback that covered non-default orbiter/world).
        expect(cache.getTrackData('t1')).toBe(data);
        expect(cache.getConfigByTrackId('t1')).toBe(data);
    });

    it('getTrackData reads back data stored under the bare trackId config key', () => {
        const data = { bare: true };
        // store under 't1|default|default' explicitly
        cache.setCurrentConfig('t1|default|default', data);
        expect(cache.getTrackData('t1')).toBe(data);
    });

    it('getTrackData returns null for an unknown trackId', () => {
        expect(cache.getTrackData('ghost')).toBeNull();
    });

    it('getTrackData/clearTrackData/setTrackData throw on an invalid trackId', () => {
        expect(() => cache.getTrackData('')).toThrow('Invalid trackId. Must be a string.');
        expect(() => cache.clearTrackData(null)).toThrow('Invalid trackId. Must be a string.');
        expect(() => cache.setTrackData(42, {})).toThrow('Invalid trackId. Must be a string.');
    });

    // --- getConfigByTrackId: prefix scan, collision safety ------

    it('getConfigByTrackId does NOT cross-match a trackId that is a string-prefix of another', () => {
        // The `|` delimiter is what keeps 'track-1' from matching 'track-12|...'. This is the exact
        // multi-voice bleed the keystone prevents — a regex/startsWith without the delimiter would fail.
        const one = { id: 'track-1' };
        const twelve = { id: 'track-12' };
        cache.setCurrentConfig('track-12|o2|w2', twelve);
        cache.setCurrentConfig('track-1|o1|w1', one);
        expect(cache.getConfigByTrackId('track-1')).toBe(one);
        expect(cache.getConfigByTrackId('track-12')).toBe(twelve);
    });

    it('getConfigByTrackId matches a bare trackId key (no delimiter) and returns null for a miss', () => {
        const data = { bare: true };
        cache._configSnapshots.set('soloTrack', data); // exotic bare key
        expect(cache.getConfigByTrackId('soloTrack')).toBe(data);
        expect(cache.getConfigByTrackId('absent')).toBeNull();
    });

    it('trimConfigSnapshots keeps a RE-SET (recently-used) old key, evicting truly-stale ones (LRU)', () => {
        cache.setCurrentConfig('t1|default|default', { a: 1 });
        cache.setCurrentConfig('t2|default|default', { b: 2 });
        cache.setCurrentConfig('t3|default|default', { c: 3 });
        // Touch t1 again — delete-then-set moves it to the end, marking it most-recently-used.
        cache.setCurrentConfig('t1|default|default', { a: 11 });

        cache.trimConfigSnapshots(1);

        // t1 survives (re-used), not the newer-but-untouched t3.
        expect(cache._configSnapshots.size).toBe(1);
        expect(cache.getCurrentConfig('t1|default|default')).toEqual({ a: 11 });
    });

    it('clearTrackData removes every snapshot for the trackId (any orbiter/world variant)', () => {
        const bare = { bare: true };
        const variant = { variant: true };
        cache.setCurrentConfig('t1|default|default', bare);
        cache.setCurrentConfig('t1|o1|w1', variant);
        expect(cache.getTrackData('t1')).toBe(bare);
        cache.clearTrackData('t1');
        expect(cache.getTrackData('t1')).toBeNull();
        expect(cache.getConfigByTrackId('t1')).toBeNull();
        expect(cache._configSnapshots.has('t1|o1|w1')).toBe(false);
    });

    // --- trimConfigSnapshots: evicts oldest-first, keeps most recent --------

    it('trimConfigSnapshots(1) keeps the limit, evicting oldest-first so the newest survives', () => {
        cache.setCurrentConfig('t1|default|default', { a: 1 });
        cache.setCurrentConfig('t2|default|default', { b: 2 });
        cache.setCurrentConfig('t3|default|default', { c: 3 }); // most recently set
        expect(cache._configSnapshots.size).toBe(3);

        cache.trimConfigSnapshots(1);

        // Insertion-ordered eviction drops t1, t2; the newest (t3) survives.
        expect(cache._configSnapshots.size).toBe(1);
        expect(cache._configSnapshots.has('t3|default|default')).toBe(true);
        expect(cache.getCurrentConfig('t3|default|default')).toEqual({ c: 3 });
    });

    it('trimConfigSnapshots is a no-op when at or under the limit', () => {
        cache.setCurrentConfig('t1|default|default', { a: 1 });
        cache.trimConfigSnapshots(24);
        expect(cache._configSnapshots.size).toBe(1);
    });

    // --- clearStaleReleaseCaches: prune only non-retained ids --------------

    it('clearStaleReleaseCaches prunes only ids not in the retain set, per entity', () => {
        cache.setTrackRelease('keepT', { x: 1 });
        cache.setTrackRelease('dropT', { x: 2 });
        cache.setOrbiterRelease('keepO', { x: 3 });
        cache.setOrbiterRelease('dropO', { x: 4 });
        cache.setWorldRelease('keepW', { x: 5 });
        cache.setWorldRelease('dropW', { x: 6 });

        cache.clearStaleReleaseCaches({
            trackIds: ['keepT'],
            orbiterIds: new Set(['keepO']),
            worldIds: ['keepW'],
        });

        expect(cache.getTrackRelease('keepT')).toEqual({ x: 1 });
        expect(cache.getTrackRelease('dropT')).toBeNull();
        expect(cache.getOrbiterRelease('keepO')).toEqual({ x: 3 });
        expect(cache.getOrbiterRelease('dropO')).toBeNull();
        expect(cache.getWorldRelease('keepW')).toEqual({ x: 5 });
        expect(cache.getWorldRelease('dropW')).toBeNull();
    });

    it('clearStaleReleaseCaches leaves an entity untouched when its retain set is empty', () => {
        cache.setTrackRelease('t1', { x: 1 });
        cache.setOrbiterRelease('o1', { x: 2 });
        // Only world retain is provided (and empty/absent); tracks & orbiters keep everything.
        cache.clearStaleReleaseCaches({ trackIds: [], orbiterIds: null });
        expect(cache.getTrackRelease('t1')).toEqual({ x: 1 });
        expect(cache.getOrbiterRelease('o1')).toEqual({ x: 2 });
    });

    it('clearStaleReleaseCaches retains versioned keys whose extracted id is retained', () => {
        cache.setTrackRelease('keepT', { v: 'base' });
        cache.setTrackRelease('keepT', { v: '2' }, { version: '2' });
        cache.setTrackRelease('dropT', { v: 'base' });
        cache.clearStaleReleaseCaches({ trackIds: ['keepT'] });
        expect(cache.getTrackRelease('keepT')).toEqual({ v: 'base' });
        expect(cache.getTrackRelease('keepT', { version: '2' })).toEqual({ v: '2' });
        expect(cache.getTrackRelease('dropT')).toBeNull();
    });

    // --- clearAllCaches: clears every keyed cache (no single-current pointers) ---

    it('clearAllCaches clears every release map and the snapshot cache', () => {
        cache.setTrackRelease('t1', { a: 1 });
        cache.setOrbiterRelease('o1', { b: 2 });
        cache.setWorldRelease('w1', { c: 3 });
        cache.setCurrentConfig('t1|default|default', { d: 4 });

        cache.clearAllCaches();

        expect(cache.getTrackRelease('t1')).toBeNull();
        expect(cache.getOrbiterRelease('o1')).toBeNull();
        expect(cache.getWorldRelease('w1')).toBeNull();
        expect(cache._configSnapshots.size).toBe(0);
    });
});
