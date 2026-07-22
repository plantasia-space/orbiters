// @vitest-environment jsdom
//
// Tests-first: characterization lock over the PURE normalizer layer
// (src/api/dataManager/normalizers.js). These normalizers do not touch the
// global Constants cache, Firebase, or HTTP — they only read the FROZEN
// AXIS_ROTATION_CONSTRAINTS / MAX_MODULES constants and map raw payloads into
// internal shapes. This is the highest-value lock: the layer that must keep
// running with no network when the cache is lifted out of the pipeline.
//
// Why jsdom (not the node default this layer "wants"): the assertions below are
// pure, but the IMPORT GRAPH is not. normalizers.js -> Constants.js reads
// `navigator.userAgent` at import time (isMobileDevice, line ~45/60), and
// normalizers.js -> loaders.js calls `window.addEventListener` at module top
// level. Both throw under the node env, so we need a browser-like global merely
// to load the module — exactly the call the sibling releaseCache.contract.test.js
// already made. No `window`/`document` is touched by any assertion here.
//
// Environment-dependent current behavior locked on purpose:
//  - resolveStorageBase(): with no VITE_*_BASE env + jsdom window having no
//    storage-base globals, it resolves to '' -> resolveStorageAssetURL() returns
//    null for any non-http key (http(s) keys pass through untouched).
//  - normalizeWorldRelease(): modelURL is the direct asset URL (metadata.modelURL
//    -> assets glb chain); orbiters renders worlds as the textured sphere and
//    keeps this field for progress reporting + debugging only.
import { describe, it, expect } from 'vitest';
import {
    normalizeTrackRelease,
    normalizeOrbiterRelease,
    normalizeOrbiterParameters,
    normalizeOrbiterEffects,
    normalizeWorldRelease,
} from '../../../src/api/dataManager/normalizers.js';
import { AXIS_ROTATION_CONSTRAINTS, MAX_MODULES } from '../../../src/config/Constants.js';

// Sanity-anchor the frozen constants the normalizers depend on. If these ever
// change, the expectations below intentionally need to be re-derived.
describe('frozen constants the normalizers lean on', () => {
    it('AXIS_ROTATION_CONSTRAINTS is the degrees range used for x/y/z axes', () => {
        expect(AXIS_ROTATION_CONSTRAINTS).toEqual({
            min: -180,
            max: 180,
            equilibrium: 0,
            step: 0.01,
        });
    });

    it('MAX_MODULES caps each effect rack at one module', () => {
        expect(MAX_MODULES).toBe(1);
    });
});

// ============================================================================
// normalizeTrackRelease
// ============================================================================

describe('normalizeTrackRelease', () => {
    it('returns null for a falsy payload', () => {
        expect(normalizeTrackRelease(null)).toBeNull();
        expect(normalizeTrackRelease(undefined)).toBeNull();
        expect(normalizeTrackRelease(0)).toBeNull();
    });

    // --- duration ladder: seconds candidates win, then ms / 1000 -----------

    it('prefers a seconds duration over a milliseconds duration (sec ladder runs first)', () => {
        // metadata.duration is the LAST seconds candidate; durationMs only runs
        // if no seconds candidate was finite+positive. Here the seconds value
        // must win even though a ms value is also present.
        const track = normalizeTrackRelease({
            trackId: 't1',
            durationMs: 999000, // would be 999s if the ms branch ran
            metadata: { duration: 200 }, // seconds candidate -> wins
        });
        expect(track.durationSec).toBe(200);
        expect(track.durationMs).toBe(200000); // derived as durationSec * 1000
    });

    it('honors the seconds candidate priority order (audioAnalysis.duration_sec first)', () => {
        const track = normalizeTrackRelease({
            trackId: 't1',
            metadata: {
                audioAnalysis: { duration_sec: 123 },
                durationSec: 456, // lower priority, must be ignored
            },
        });
        expect(track.durationSec).toBe(123);
        expect(track.durationMs).toBe(123000);
    });

    it('falls back to milliseconds / 1000 only when no seconds candidate is valid', () => {
        const track = normalizeTrackRelease({
            trackId: 't1',
            durationMs: 180000,
            metadata: {},
        });
        expect(track.durationSec).toBe(180);
        expect(track.durationMs).toBe(180000);
    });

    it('ignores non-positive / non-finite duration candidates', () => {
        const track = normalizeTrackRelease({
            trackId: 't1',
            metadata: { duration_sec: 0, durationSec: -5, duration: 'NaN-ish' },
        });
        // none valid in sec ladder, no ms candidates -> stays null
        expect(track.durationSec).toBeNull();
        // durationMs guard requires a finite, positive durationSec
        expect(track.durationMs).toBeNull();
    });

    // --- artist -> artists array -------------------------------------------

    it('wraps a single metadata.artist into a one-element artists array', () => {
        const track = normalizeTrackRelease({ trackId: 't1', metadata: { artist: 'Solo' } });
        expect(track.artists).toEqual(['Solo']);
    });

    it('passes through an existing metadata.artists array unchanged', () => {
        const track = normalizeTrackRelease({ trackId: 't1', metadata: { artists: ['A', 'B'] } });
        expect(track.artists).toEqual(['A', 'B']);
    });

    it('defaults artists to an empty array when neither artist nor artists is present', () => {
        const track = normalizeTrackRelease({ trackId: 't1', metadata: {} });
        expect(track.artists).toEqual([]);
    });

    // --- default orbiter / world id + version resolution -------------------

    it('resolves default orbiter/world id+version from nested defaultOrbiter/defaultEntangledWorld objects', () => {
        const track = normalizeTrackRelease({
            trackId: 't3',
            metadata: {
                defaultOrbiter: { id: 'orb-1', version: 5 },
                defaultEntangledWorld: { id: 'w-9', version: 'rev' },
            },
        });
        expect(track.defaultOrbiterId).toBe('orb-1');
        expect(track.defaultOrbiterVersion).toBe(5);
        expect(track.defaultEntangledWorldId).toBe('w-9');
        expect(track.defaultEntangledWorldVersion).toBe('rev');
    });

    it('resolves default ids from top-level orbiter/world (object _id, string world)', () => {
        const track = normalizeTrackRelease({
            trackId: 't4',
            orbiter: { _id: 'topO', version: 11 },
            world: 'topW', // a string world id -> no .version, so version stays null
            metadata: {},
        });
        expect(track.defaultOrbiterId).toBe('topO');
        expect(track.defaultOrbiterVersion).toBe(11);
        expect(track.defaultEntangledWorldId).toBe('topW');
        expect(track.defaultEntangledWorldVersion).toBeNull();
    });

    it('defaults orbiter/world ids and versions to null when nothing is provided', () => {
        const track = normalizeTrackRelease({ trackId: 't5', metadata: {} });
        expect(track.defaultOrbiterId).toBeNull();
        expect(track.defaultOrbiterVersion).toBeNull();
        expect(track.defaultEntangledWorldId).toBeNull();
        expect(track.defaultEntangledWorldVersion).toBeNull();
    });

    // --- assorted scalar defaults ------------------------------------------

    it('coerces isLatest / canEdit to booleans and defaults availableVersions to []', () => {
        const track = normalizeTrackRelease({ trackId: 't5', metadata: {} });
        expect(track.isLatest).toBe(false);
        expect(track.canEdit).toBe(false);
        expect(track.availableVersions).toEqual([]);
    });

    // --- asset URL handling: null without herbarium base, http passthrough --

    it('returns null audio URLs when keys are private (non-http) and no storage base is configured', () => {
        // jsdom window has no storage-base global + no VITE_*_BASE env -> base is ''
        // -> resolveStorageAssetURL() returns null for a relative/private key.
        const track = normalizeTrackRelease({
            trackId: 't1',
            assets: { compressedKey: 'private/key.mp3', losslessKey: 'private/key.wav' },
            metadata: {},
        });
        expect(track.audioFileMP3URL).toBeNull();
        expect(track.audioFileWAVURL).toBeNull();
        // ...but the raw keys are always retained for cache identity.
        expect(track.audioFileMP3Key).toBe('private/key.mp3');
        expect(track.audioFileWAVKey).toBe('private/key.wav');
    });

    it('passes a presigned http(s) URL straight through (no base prepended)', () => {
        const track = normalizeTrackRelease({
            trackId: 't1',
            assets: {
                compressedURL: 'https://signed/audio.mp3',
                compressedKey: 'private/key.mp3',
            },
            metadata: {},
        });
        // signed URL is preferred over the key, and passes through untouched.
        expect(track.audioFileMP3URL).toBe('https://signed/audio.mp3');
        expect(track.audioFileMP3Key).toBe('private/key.mp3');
    });

    it('carries the raw trackId, status, and assets onto the normalized shape', () => {
        const assets = { compressedKey: 'k' };
        const track = normalizeTrackRelease({
            trackId: 't1',
            status: 'published',
            assets,
            metadata: { trackName: 'Song' },
        });
        expect(track.trackId).toBe('t1');
        expect(track.status).toBe('published');
        expect(track.trackName).toBe('Song');
        expect(track.assets).toBe(assets); // same reference, untouched
    });
});

// ============================================================================
// normalizeOrbiterParameters
// ============================================================================

describe('normalizeOrbiterParameters', () => {
    it('synthesizes all three x/y/z axes when given an empty object', () => {
        const params = normalizeOrbiterParameters({});
        expect(Object.keys(params).sort()).toEqual(['x', 'y', 'z']);
        // each synthesized axis is fully clamped to the frozen constraints
        for (const axis of ['x', 'y', 'z']) {
            expect(params[axis]).toEqual({
                axis,
                label: axis.toUpperCase(),
                description: `Axis ${axis.toUpperCase()} rotation`,
                min: -180,
                max: 180,
                minLimit: -180,
                maxLimit: 180,
                step: 0.01,
                initValue: 0,
                value: 0,
                defaultValue: 0,
            });
        }
    });

    it('clamps a provided axis value to AXIS_ROTATION_CONSTRAINTS and forces the axis range', () => {
        const params = normalizeOrbiterParameters({ x: { value: 999 } });
        expect(params.x.value).toBe(180); // clamped to max
        expect(params.x.initValue).toBe(180);
        expect(params.x.defaultValue).toBe(180);
        expect(params.x.min).toBe(-180);
        expect(params.x.max).toBe(180);
        expect(params.x.minLimit).toBe(-180);
        expect(params.x.maxLimit).toBe(180);
        expect(params.x.step).toBe(0.01);
    });

    it('clamps a below-range axis value to the minimum', () => {
        const params = normalizeOrbiterParameters({ z: { value: -999 } });
        expect(params.z.value).toBe(-180);
    });

    it('leaves a non-axis param with the generic -1..1 range and no axis limits', () => {
        const params = normalizeOrbiterParameters({ foo: { value: 0.5 } });
        expect(params.foo.value).toBe(0.5); // not clamped to the axis range
        expect(params.foo.min).toBe(-1);
        expect(params.foo.max).toBe(1);
        expect(params.foo.step).toBe(0.01);
        // axis-only fields are NOT added to non-axis params
        expect(params.foo.minLimit).toBeUndefined();
        expect(params.foo.maxLimit).toBeUndefined();
    });

    it('accepts an array of params, lower-cases the map key but keeps the original axis field', () => {
        const params = normalizeOrbiterParameters([
            { axis: 'Y', value: -500 }, // keyed under 'y', clamped because key is an axis
            { key: 'gain', value: 2 },
        ]);
        // map key is the lower-cased axis...
        expect(params.y).toBeDefined();
        // ...but the stored object preserves the original 'Y'
        expect(params.y.axis).toBe('Y');
        expect(params.y.value).toBe(-180); // clamped to axis min
        expect(params.y.minLimit).toBe(-180);
        // a non-axis array entry keeps its generic range
        expect(params.gain.value).toBe(2);
        expect(params.gain.min).toBe(-1);
        expect(params.gain.max).toBe(1);
        // and x/z are still synthesized to fill the axis set
        expect(params.x).toBeDefined();
        expect(params.z).toBeDefined();
    });

    it('uses lower/upper as min/max fallbacks for a non-axis param', () => {
        const params = normalizeOrbiterParameters({ foo: { value: 0.2, lower: -3, upper: 7 } });
        expect(params.foo.min).toBe(-3);
        expect(params.foo.max).toBe(7);
    });

    it('falls back the value chain initValue -> value -> defaultValue -> 0 for a non-axis param', () => {
        const params = normalizeOrbiterParameters({ foo: { defaultValue: 4 } });
        // no initValue/value provided -> all three settle on defaultValue
        expect(params.foo.initValue).toBe(4);
        expect(params.foo.value).toBe(4);
        expect(params.foo.defaultValue).toBe(4);
    });
});

// ============================================================================
// normalizeOrbiterEffects
// ============================================================================

describe('normalizeOrbiterEffects', () => {
    it('always returns x/y/z racks, each padded to MAX_MODULES modules', () => {
        const effects = normalizeOrbiterEffects({});
        expect(Object.keys(effects).sort()).toEqual(['x', 'y', 'z']);
        for (const axis of ['x', 'y', 'z']) {
            expect(effects[axis].modules).toHaveLength(MAX_MODULES);
        }
    });

    it('shapes a padded (empty) module with null ids and a missing-effect compat flag', () => {
        const effects = normalizeOrbiterEffects({});
        const mod = effects.x.modules[0];
        expect(mod.effectId).toBeNull();
        expect(mod.effectVersion).toBeNull();
        expect(mod.moduleId).toBeNull();
        expect(mod.moduleMetadata).toBeNull();
        expect(mod.inputParamId).toBeNull();
        expect(mod.range).toEqual({ min: null, max: null, equilibrium: null });
        expect(mod.mappings).toEqual([]);
        expect(mod.dimensionId).toBeNull();
        expect(mod.dimensionLabel).toBeNull();
        expect(mod.controlNormalized).toBeNull();
        // an unknown/null effectId resolves as a missing effect
        expect(mod.compat).toEqual({
            missingEffect: true,
            missingModuleId: false,
            requestedVersion: null,
            resolvedVersion: null,
            upgradedFromVersion: null,
        });
    });

    it('truncates an over-long rack down to MAX_MODULES modules', () => {
        const effects = normalizeOrbiterEffects({
            x: {
                modules: [
                    { effectId: 'a' },
                    { effectId: 'b' },
                    { effectId: 'c' },
                ],
            },
        });
        // MAX_MODULES is 1, so only the first survives the slice.
        expect(effects.x.modules).toHaveLength(MAX_MODULES);
        expect(effects.x.modules[0].effectId).toBe('a');
    });

    it('carries the rack dimensionId/dimensionLabel through, defaulting to null', () => {
        const effects = normalizeOrbiterEffects({
            x: { dimensionId: 'dim-1', dimensionLabel: 'Reverb', modules: [] },
        });
        expect(effects.x.dimensionId).toBe('dim-1');
        expect(effects.x.dimensionLabel).toBe('Reverb');
        // y was not provided -> defaults
        expect(effects.y.dimensionId).toBeNull();
        expect(effects.y.dimensionLabel).toBeNull();
    });

    it('clamps controlNormalized into [0,1] and nulls non-finite values', () => {
        const tooHigh = normalizeOrbiterEffects({ x: { modules: [{ effectId: 'a', controlNormalized: 5 }] } });
        expect(tooHigh.x.modules[0].controlNormalized).toBe(1);
        const tooLow = normalizeOrbiterEffects({ x: { modules: [{ effectId: 'a', controlNormalized: -2 }] } });
        expect(tooLow.x.modules[0].controlNormalized).toBe(0);
        const mid = normalizeOrbiterEffects({ x: { modules: [{ effectId: 'a', controlNormalized: 0.25 }] } });
        expect(mid.x.modules[0].controlNormalized).toBe(0.25);
        const bad = normalizeOrbiterEffects({ x: { modules: [{ effectId: 'a', controlNormalized: 'nope' }] } });
        expect(bad.x.modules[0].controlNormalized).toBeNull();
    });

    it('only keeps finite numeric range bounds, else null', () => {
        const effects = normalizeOrbiterEffects({
            x: { modules: [{ effectId: 'a', range: { min: 2, max: 'x', init: 1 } }] },
        });
        const range = effects.x.modules[0].range;
        expect(range.min).toBe(2);
        expect(range.max).toBeNull(); // non-finite -> null
        expect(range.equilibrium).toBe(1); // read from range.init when equilibrium absent
    });
});

// ============================================================================
// normalizeWorldRelease
// ============================================================================

describe('normalizeWorldRelease', () => {
    it('returns null for a falsy payload', () => {
        expect(normalizeWorldRelease(null)).toBeNull();
        expect(normalizeWorldRelease(undefined)).toBeNull();
    });

    it('reads camelCase frequency sources from the astronomical body', () => {
        const world = normalizeWorldRelease({
            release: {
                metadata: {
                    step_one: {
                        astronomical_body: {
                            minimumCosmicLfo: 0.1,
                            stellarLuminosityLsun: 5,
                            frequencyCpd: 2,
                            mass: 9,
                        },
                    },
                },
            },
        });
        expect(world.frequencySources).toEqual({
            minimumCosmicLfo: 0.1,
            stellarLuminosityLsun: 5,
            frequencyCpd: 2,
            mass: 9,
        });
    });

    it('reads snake_case frequency sources and the alternate astronomicalBody key', () => {
        const world = normalizeWorldRelease({
            release: {
                metadata: {
                    step_one: {
                        // alternate camelCase container key
                        astronomicalBody: {
                            minimum_cosmic_lfo: 0.3,
                            stellar_luminosity_lsun: 8,
                            frequency_cpd: 4,
                            mass: 1,
                        },
                    },
                },
            },
        });
        expect(world.frequencySources).toEqual({
            minimumCosmicLfo: 0.3,
            stellarLuminosityLsun: 8,
            frequencyCpd: 4,
            mass: 1,
        });
    });

    it('defaults every frequency source to null when no astronomical body is present', () => {
        const world = normalizeWorldRelease({ release: { metadata: {} } });
        expect(world.frequencySources).toEqual({
            minimumCosmicLfo: null,
            stellarLuminosityLsun: null,
            frequencyCpd: null,
            mass: null,
        });
    });

    it('takes metadata.modelURL as the direct model URL', () => {
        const world = normalizeWorldRelease({
            worldId: 'w1',
            release: { version: 3, metadata: { modelURL: 'https://cdn/x.glb' } },
        });
        expect(world.modelURL).toBe('https://cdn/x.glb');
    });

    it('walks the model URL fallback chain (assets.glbURL, glbUrls[0], glb, glbFileURL)', () => {
        const glbUrl = normalizeWorldRelease({
            release: { metadata: {}, assets: { glbURL: 'https://a/glbURL.glb' } },
        });
        expect(glbUrl.modelURL).toBe('https://a/glbURL.glb');

        const glbUrlsArray = normalizeWorldRelease({
            release: { metadata: {}, assets: { glbUrls: ['https://a/first.glb', 'https://a/second.glb'] } },
        });
        expect(glbUrlsArray.modelURL).toBe('https://a/first.glb');

        const glb = normalizeWorldRelease({
            release: { metadata: {}, assets: { glb: 'https://a/glb.glb' } },
        });
        expect(glb.modelURL).toBe('https://a/glb.glb');

        const glbFileURL = normalizeWorldRelease({
            release: { metadata: {}, assets: { glbFileURL: 'https://a/glbFile.glb' } },
        });
        expect(glbFileURL.modelURL).toBe('https://a/glbFile.glb');
    });

    it('yields a null model URL when neither metadata nor assets carry one', () => {
        const world = normalizeWorldRelease({ release: { metadata: {} } });
        expect(world.modelURL).toBeNull();
    });

    it('resolves worldId, version, and identity metadata fields', () => {
        const world = normalizeWorldRelease({
            worldId: 'w1',
            release: {
                version: 7,
                status: 'published',
                metadata: {
                    sciName: 'Sci',
                    artName: 'Art',
                    orbitalPeriod: 365,
                    moonAmount: 2,
                },
            },
        });
        expect(world.worldId).toBe('w1');
        expect(world.version).toBe(7);
        expect(world.status).toBe('published');
        expect(world.sciName).toBe('Sci');
        expect(world.artName).toBe('Art');
        expect(world.orbitalPeriod).toBe(365);
        expect(world.moonAmount).toBe(2);
    });
});

describe('normalizeOrbiterRelease', () => {
    it('returns null for a falsy payload', () => {
        expect(normalizeOrbiterRelease(null)).toBeNull();
        expect(normalizeOrbiterRelease(undefined)).toBeNull();
    });

    // An orbiter is a standalone entity. The linked ids an author stores on its release are the
    // session they built and tested it against — an editing reference, never a playback input. The
    // normalized shape must not surface them, or a play path can pick them up again and make an
    // orbiter fail to load whenever its author's track is archived, deleted or private.
    it('does not lift any linked track/world id out of the release', () => {
        const orbiter = normalizeOrbiterRelease({
            orbiterId: 'orb-1',
            release: {
                version: 3,
                metadata: {
                    orbiterName: 'Standalone',
                    entitiesPreview: {
                        trackId: 'reference-track-1',
                        entangledWorldId: 'reference-world-1',
                        track: { trackId: 'reference-track-legacy' },
                        entangledWorld: { worldId: 'reference-world-legacy' },
                    },
                },
            },
        });

        expect(orbiter.orbiterId).toBe('orb-1');
        expect(orbiter.version).toBe(3);
        const serialized = JSON.stringify({
            ...orbiter,
            metadata: null, // the raw release metadata is carried through verbatim by design
        });
        expect(serialized).not.toContain('reference-track-1');
        expect(serialized).not.toContain('reference-world-1');
        expect(serialized).not.toContain('reference-track-legacy');
        expect(serialized).not.toContain('reference-world-legacy');
    });
});
