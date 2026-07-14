// @vitest-environment jsdom
//
// Tests-first: characterization tests that LOCK CURRENT behavior of the two pure
// transforms in src/api/dataManager/assembler.js — `effectsToStacks` and
// `applyOrbiterSessionHydration`. No source change is made; these pass against the code as-is.
//
// Why jsdom (the task asked for a node-only file): `assembler.js` is NOT importable in a pure
// node environment. It statically imports `../../core/AppNotifications.js`, whose default export
// is a *singleton instantiated at module load* (`new AppNotifications()`), and that constructor
// calls `document.getElementById(...)` unconditionally. The import chain also pulls in
// `src/config/Constants.js`, which reads `navigator.userAgent` at import time. Both touch DOM
// globals before any test runs, so a DOM-like environment is mandatory just to import the unit.
// The sibling tests/api/dataManager/releaseCache.contract.test.js uses jsdom for the same reason.
import { describe, it, expect } from 'vitest';
import {
    effectsToStacks,
    applyOrbiterSessionHydration,
} from '../../../src/api/dataManager/assembler.js';

// Ground truth (verified at runtime against the real impl):
//   - createDefaultStacks() yields ONLY the enabled stack spec → { 'deck-i': … } (MAX_MODULES = 1).
//   - DEFAULT_STACK_ID  = 'deck-i', DEFAULT_DIMENSION_ID = 'EW::I'.
//   - EFFECT_AXES = ['x','y','z'].

describe('effectsToStacks — default stacks when no modules', () => {
    it('returns only the single enabled stack (deck-i) with its spec metadata', () => {
        const stacks = effectsToStacks();

        expect(Object.keys(stacks)).toEqual(['deck-i']);

        const deck = stacks['deck-i'];
        expect(deck.id).toBe('deck-i');
        expect(deck.kind).toBe('deck');
        expect(deck.label).toBe('Deck I');
        expect(deck.enabled).toBe(true);
        expect(deck).toHaveProperty('dimensions');
    });

    it('creates the default dimension (EW::I) with x/y/z axes', () => {
        const stacks = effectsToStacks();
        const deck = stacks['deck-i'];

        expect(Object.keys(deck.dimensions)).toEqual(['EW::I']);

        const dimension = deck.dimensions['EW::I'];
        expect(dimension.dimensionId).toBe('EW::I');
        // label falls back to the resolved id when none is supplied
        expect(dimension.dimensionLabel).toBe('EW::I');
        expect(dimension.design).toBeNull();
        expect(Object.keys(dimension.axes)).toEqual(['x', 'y', 'z']);
    });

    it('fills each axis with exactly MAX_MODULES (1) cloned empty modules', () => {
        const stacks = effectsToStacks();
        const dimension = stacks['deck-i'].dimensions['EW::I'];

        ['x', 'y', 'z'].forEach((axis) => {
            const modules = dimension.axes[axis].modules;
            expect(modules).toHaveLength(1);

            const module = modules[0];
            // The no-modules branch rewrites each slot via cloneModuleState({}), which produces an
            // all-null module that INCLUDES the controlNormalized key (null).
            expect(module).toMatchObject({
                effectId: null,
                effectVersion: null,
                moduleId: null,
                moduleMetadata: null,
                inputParamId: null,
                range: { min: null, max: null, equilibrium: null },
                mappings: [],
                controlNormalized: null,
            });
            expect('controlNormalized' in module).toBe(true);
        });
    });

    it('honors a custom default dimensionId via options (label mirrors the id)', () => {
        const stacks = effectsToStacks({}, { dimensionId: 'CUSTOM' });
        const deck = stacks['deck-i'];

        expect(Object.keys(deck.dimensions)).toEqual(['CUSTOM']);
        expect(deck.dimensions['CUSTOM'].dimensionId).toBe('CUSTOM');
        expect(deck.dimensions['CUSTOM'].dimensionLabel).toBe('CUSTOM');
    });

    it('falls back to the default stack when an unknown stackId is requested', () => {
        // stacks[stackId] is undefined for an unknown id, so the impl falls back to DEFAULT_STACK_ID
        // (deck-i) and still seeds the default dimension on it.
        const stacks = effectsToStacks({}, { stackId: 'does-not-exist' });

        expect(Object.keys(stacks)).toEqual(['deck-i']);
        expect(Object.keys(stacks['deck-i'].dimensions)).toEqual(['EW::I']);
    });

    it('treats a non-array modules value as no modules (default-fill branch)', () => {
        const stacks = effectsToStacks({ x: { modules: 'not-an-array' } });
        const dimension = stacks['deck-i'].dimensions['EW::I'];

        expect(dimension.axes.x.modules).toHaveLength(1);
        expect(dimension.axes.x.modules[0]).toMatchObject({
            effectId: null,
            controlNormalized: null,
        });
    });
});

describe('effectsToStacks — grouping by dimensionId', () => {
    it('routes modules to their own dimensions and undimensioned modules to the default', () => {
        const stacks = effectsToStacks({
            x: { modules: [{ effectId: 'reverb', dimensionId: 'EW::II', dimensionLabel: 'Two' }] },
            y: { modules: [{ effectId: 'delay' }] },
        });
        const deck = stacks['deck-i'];

        // Insertion order is observable: the x-axis creates EW::II first, then the y-axis creates EW::I.
        expect(Object.keys(deck.dimensions)).toEqual(['EW::II', 'EW::I']);

        // The dimensioned module lands on its dimension's x-axis.
        expect(deck.dimensions['EW::II'].axes.x.modules[0]).toMatchObject({
            effectId: 'reverb',
        });
        // dimensionLabel carried from the module that supplied it.
        expect(deck.dimensions['EW::II'].dimensionLabel).toBe('Two');

        // The undimensioned module lands on the DEFAULT dimension's y-axis.
        expect(deck.dimensions['EW::I'].axes.y.modules[0]).toMatchObject({
            effectId: 'delay',
        });
        expect(deck.dimensions['EW::I'].dimensionLabel).toBe('EW::I');
    });

    it('carries dimensionLabel from the first module that declares one', () => {
        const stacks = effectsToStacks({
            x: { modules: [{ effectId: 'a', dimensionId: 'D1', dimensionLabel: 'My Label' }] },
        });
        expect(stacks['deck-i'].dimensions['D1'].dimensionLabel).toBe('My Label');
    });

    it('strips per-module dimension metadata from the stored module (includeDimensionMetadata:false)', () => {
        const stacks = effectsToStacks({
            x: { modules: [{ effectId: 'reverb', dimensionId: 'EW::II', dimensionLabel: 'Two' }] },
        });
        const module = stacks['deck-i'].dimensions['EW::II'].axes.x.modules[0];

        // dimension metadata lives on the dimension, not the cloned module.
        expect(module).not.toHaveProperty('dimensionId');
        expect(module).not.toHaveProperty('dimensionLabel');
        // cloned (rewritten) modules always carry the controlNormalized key.
        expect('controlNormalized' in module).toBe(true);
    });
});

describe('effectsToStacks — axis padding', () => {
    it('caps every axis at MAX_MODULES (1) and keeps the first module when given more', () => {
        const stacks = effectsToStacks({
            x: { modules: [{ effectId: 'first' }, { effectId: 'second' }] },
        });
        const axis = stacks['deck-i'].dimensions['EW::I'].axes.x;

        expect(axis.modules).toHaveLength(1);
        expect(axis.modules[0].effectId).toBe('first');
    });

    it('leaves sibling axes of a freshly-created dimension as raw empty modules (no controlNormalized key)', () => {
        // When the x-axis creates EW::II, only EW::II.axes.x is rewritten. The y/z axes of that
        // dimension keep their createEmptyAxisState() modules, which DO NOT include controlNormalized.
        const stacks = effectsToStacks({
            x: { modules: [{ effectId: 'reverb', dimensionId: 'EW::II' }] },
        });
        const dimension = stacks['deck-i'].dimensions['EW::II'];

        // rewritten axis: has controlNormalized
        expect('controlNormalized' in dimension.axes.x.modules[0]).toBe(true);
        // untouched sibling axes: raw empty module shape, NO controlNormalized key
        expect(dimension.axes.y.modules).toHaveLength(1);
        expect('controlNormalized' in dimension.axes.y.modules[0]).toBe(false);
        expect(dimension.axes.y.modules[0]).toMatchObject({
            effectId: null,
            range: { min: null, max: null, equilibrium: null },
            mappings: [],
        });
        expect('controlNormalized' in dimension.axes.z.modules[0]).toBe(false);
    });
});

describe('applyOrbiterSessionHydration — returns true when sessionPayload.stacks present', () => {
    it('hydrates stacks/effects/sessionState and returns true', () => {
        const orbiter = { engine: { existing: 1 } };
        const payload = {
            stacks: { 'deck-i': {} },
            selection: { a: 1 },
            engine: { type: 'tone' },
            extra: 'keep-me',
        };

        const result = applyOrbiterSessionHydration(orbiter, payload);

        expect(result).toBe(true);

        // stacks normalized to the enabled-stack shape via cloneStacksState.
        expect(Object.keys(orbiter.stacks)).toEqual(['deck-i']);
        // effects derived from the hydrated stacks (x/y/z axes).
        expect(Object.keys(orbiter.effects)).toEqual(['x', 'y', 'z']);

        // selection mirrored onto both selection and stackSelection (cloned, not the same ref).
        expect(orbiter.selection).toEqual({ a: 1 });
        expect(orbiter.stackSelection).toEqual({ a: 1 });
        expect(orbiter.selection).not.toBe(payload.selection);

        // engine merged over any existing engine.
        expect(orbiter.engine).toEqual({ existing: 1, type: 'tone' });

        // sessionState is a shallow copy of the payload with its own re-cloned stacks.
        expect(Object.keys(orbiter.sessionState)).toEqual(['stacks', 'selection', 'engine', 'extra']);
        expect(orbiter.sessionState.extra).toBe('keep-me');
        expect(orbiter.sessionState.stacks).not.toBe(orbiter.stacks);
        expect(Object.keys(orbiter.sessionState.stacks)).toEqual(['deck-i']);
    });

    it('does not mutate caller selection/engine objects (defensive copies)', () => {
        const selection = { a: 1 };
        const engine = { type: 'tone' };
        const orbiter = {};

        applyOrbiterSessionHydration(orbiter, { stacks: { 'deck-i': {} }, selection, engine });

        expect(orbiter.selection).not.toBe(selection);
        expect(orbiter.engine).not.toBe(engine);
    });
});

describe('applyOrbiterSessionHydration — returns false otherwise', () => {
    it('returns false for a null orbiter', () => {
        expect(applyOrbiterSessionHydration(null, { stacks: { 'deck-i': {} } })).toBe(false);
    });

    it('returns false for a null sessionPayload', () => {
        expect(applyOrbiterSessionHydration({}, null)).toBe(false);
    });

    it('returns false for a non-object sessionPayload', () => {
        expect(applyOrbiterSessionHydration({}, 'nope')).toBe(false);
    });

    it('returns false when stacks are absent but still sets sessionState (stacks → null) and does not add a stacks prop', () => {
        const orbiter = {};
        const result = applyOrbiterSessionHydration(orbiter, { selection: { a: 1 } });

        expect(result).toBe(false);
        // sessionState is still written; its stacks normalize to null when none were supplied.
        expect(orbiter.sessionState).toEqual({ selection: { a: 1 }, stacks: null });
        // selection still mirrored even on the no-stacks path.
        expect(orbiter.selection).toEqual({ a: 1 });
        // no stacks were applied, so orbiter.stacks is never assigned.
        expect('stacks' in orbiter).toBe(false);
        expect('effects' in orbiter).toBe(false);
    });

    it('returns false when stacks is a non-object value and echoes that raw value into sessionState.stacks', () => {
        const orbiter = {};
        const result = applyOrbiterSessionHydration(orbiter, { stacks: 'not-an-object' });

        expect(result).toBe(false);
        // stacksSource is null (not an object), so sessionState.stacks falls back to the raw payload value.
        expect(orbiter.sessionState).toEqual({ stacks: 'not-an-object' });
        expect('stacks' in orbiter).toBe(false);
    });
});
