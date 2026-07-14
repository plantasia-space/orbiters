// @vitest-environment node
/**
 * ParameterManager per-voice behavior.
 *
 * `ParameterManager` is now constructed PER orbiter voice (no process singleton; the `getInstance`
 * static cache is gone). Each instance owns its own `parameters`/`lockedParams`/`lockedDimensions`
 * store, and the composition root threads the instance to every consumer via DI. Bare param ids
 * (`x`/`y`/`z`, `premix-deck-i`, ...) stay stable BECAUSE each voice has its own store — they never
 * collide across voices.
 *
 * These tests PIN the per-instance contract (no AudioContext, no initialize() — PM is a pure logic
 * class): two instances are independent, and the single-orbiter behavior every consumer relies on
 * is identical for one instance.
 */
import { describe, it, expect } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';

const DIMS = ['EW::I', 'EW::II', 'EW::III'];

function freshPM() {
  return new ParameterManager();
}

describe('per-voice independence (the singleton A2 removed)', () => {
  it('`new ParameterManager()` yields INDEPENDENT instances — no shared cache, no cross-talk', () => {
    const a = new ParameterManager();
    const b = new ParameterManager();
    expect(b).not.toBe(a); // each voice gets its own store

    // Same bare id (`x`) on both — writes to one must not leak to the other.
    a.addParameter('x', 0.25, 0, 1, false, 'linear');
    b.addParameter('x', 0.75, 0, 1, false, 'linear');
    expect(a.getRawValue('x')).toBeCloseTo(0.25, 6);
    expect(b.getRawValue('x')).toBeCloseTo(0.75, 6);

    a.setRawValue('x', 0.9, null, 1);
    expect(a.getRawValue('x')).toBeCloseTo(0.9, 6);
    expect(b.getRawValue('x')).toBeCloseTo(0.75, 6); // b is untouched

    // Locks are per-instance too.
    a.lockParameter('x');
    expect(a.isParameterLocked('x')).toBe(true);
    expect(b.isParameterLocked('x')).toBe(false);
  });

  it('`getInstance` no longer exists on the class', () => {
    expect(ParameterManager.getInstance).toBeUndefined();
  });
});

describe('addParameter / addMultidimensionalParameter + getNormalizedValue(x/y/z)', () => {
  it('registers a single parameter and normalizes its raw value by range', () => {
    const pm = freshPM();
    pm.addParameter('volume', 50, 0, 100, false, 'linear');
    expect(pm.getRawValue('volume')).toBeCloseTo(50, 6);
    expect(pm.getNormalizedValue('volume')).toBeCloseTo(0.5, 6);
  });

  it('registers a multidim axis with independent per-dimension values, normalized per range', () => {
    const pm = freshPM();
    // ±180 axis, equilibrium 0 → normalized 0.5 at raw 0.
    pm.addMultidimensionalParameter('x', DIMS, 0, -180, 180, { isBidirectional: true, scope: 'DIMENSION' });
    pm.setDimensionValue('x', 'EW::I', 90, null, 1, { updateIntent: 'commit' });
    pm.setDimensionValue('x', 'EW::II', -180, null, 1, { updateIntent: 'commit' });

    expect(pm.getNormalizedValue('x', 'EW::I')).toBeCloseTo(0.75, 6); // 90 of [-180,180]
    expect(pm.getNormalizedValue('x', 'EW::II')).toBeCloseTo(0, 6);   // -180 → 0
    expect(pm.getNormalizedValue('x', 'EW::III')).toBeCloseTo(0.5, 6); // untouched equilibrium
  });
});

describe('setActiveDimension broadcast', () => {
  it('flips activeDimensionId on every multidim param and notifies ONLY active-dim (null) subscribers', () => {
    const pm = freshPM();
    pm.addMultidimensionalParameter('x', DIMS, 0, -180, 180, { scope: 'DIMENSION' });
    pm.setDimensionValue('x', 'EW::II', 33, null, 1, { updateIntent: 'commit' });

    const activeCalls = [];
    const specificCalls = [];
    pm.subscribe({ onParameterChanged: (...a) => activeCalls.push(a) }, 'x', 10, null);      // active-dim listener
    pm.subscribe({ onParameterChanged: (...a) => specificCalls.push(a) }, 'x', 10, 'EW::I'); // specific-dim listener
    activeCalls.length = 0;
    specificCalls.length = 0;

    pm.setActiveDimension('EW::II');

    expect(pm.getParameter('x').activeDimensionId).toBe('EW::II');
    const switched = activeCalls.find(([, , , meta]) => meta?.reason === 'active-dimension-change');
    expect(switched).toBeTruthy();
    expect(switched[1]).toBeCloseTo(33, 6); // value of the now-active dimension
    expect(specificCalls).toHaveLength(0);  // a dim-specific subscriber is NOT pinged on switch
  });
});

describe('getActiveRootParams', () => {
  it('reads x/y/z active-dimension raw values, defaulting missing axes to 0', () => {
    const pm = freshPM();
    pm.addMultidimensionalParameter('x', DIMS, 0, -180, 180, { scope: 'DIMENSION' });
    pm.addMultidimensionalParameter('y', DIMS, 0, -180, 180, { scope: 'DIMENSION' });
    pm.setActiveDimension('EW::I');
    pm.setDimensionValue('x', 'EW::I', 12, null, 1, { updateIntent: 'commit' });
    pm.setDimensionValue('y', 'EW::I', -7, null, 1, { updateIntent: 'commit' });

    expect(pm.getActiveRootParams()).toEqual({ x: 12, y: -7, z: 0 }); // z never registered → 0
  });
});

describe('lock model — whole-param locks', () => {
  it('lockParameter rejects writes and broadcasts onParameterLocked(true); unlock reverses it', () => {
    const pm = freshPM();
    pm.addParameter('gain', 0.2, 0, 1, false);
    const locks = [];
    pm.subscribe({ onParameterChanged() {}, onParameterLocked: (...a) => locks.push(a) }, 'gain', 10);

    pm.lockParameter('gain');
    expect(pm.isParameterLocked('gain')).toBe(true);
    expect(locks.at(-1)).toEqual(['gain', true]);

    pm.setRawValue('gain', 0.9, null, 1); // rejected while locked
    expect(pm.getRawValue('gain')).toBeCloseTo(0.2, 6);

    pm.unlockParameter('gain');
    expect(pm.isParameterLocked('gain')).toBe(false);
    expect(locks.at(-1)).toEqual(['gain', false]);
    pm.setRawValue('gain', 0.9, null, 1); // writable again
    expect(pm.getRawValue('gain')).toBeCloseTo(0.9, 6);
  });
});

describe('lock model — per-dimension locks', () => {
  it('lockParameterDimension rejects only the locked dim; other dims stay writable', () => {
    const pm = freshPM();
    pm.addMultidimensionalParameter('x', DIMS, 0, -180, 180, { scope: 'DIMENSION' });

    pm.lockParameterDimension('x', 'EW::I');
    expect(pm.isParameterDimensionLocked('x', 'EW::I')).toBe(true);
    expect(pm.isParameterDimensionLocked('x', 'EW::II')).toBe(false);

    pm.setDimensionValue('x', 'EW::I', 50, null, 1, { updateIntent: 'commit' });  // rejected
    pm.setDimensionValue('x', 'EW::II', 60, null, 1, { updateIntent: 'commit' }); // applied
    expect(pm.getDimensionValue('x', 'EW::I')).toBeCloseTo(0, 6);
    expect(pm.getDimensionValue('x', 'EW::II')).toBeCloseTo(60, 6);

    pm.unlockParameterDimension('x', 'EW::I');
    expect(pm.isParameterDimensionLocked('x', 'EW::I')).toBe(false);
  });

  it('a whole-param lock makes isParameterDimensionLocked true for every dimension', () => {
    const pm = freshPM();
    pm.addMultidimensionalParameter('y', DIMS, 0, -180, 180, { scope: 'DIMENSION' });
    pm.lockParameter('y');
    expect(pm.isParameterDimensionLocked('y', 'EW::I')).toBe(true);
    expect(pm.isParameterDimensionLocked('y', 'EW::III')).toBe(true);
  });
});
