// @vitest-environment jsdom
/**
 * The Engine Monitor value source:
 *   - `EffectsRack.getMonitorReadout` — the single owner of the monitor value math: per loaded slot,
 *     the module label + its value mapped into the module's domain (with units).
 *   - `AudioEngineAdapter.getMonitorSnapshot` — walks every dimension's racks and reads their
 *     readouts, optionally mapping a supplied live-normalized value per (dimension, axis).
 */
import { describe, it, expect, vi } from 'vitest';
import { EffectsRack } from '../../src/audio/effects/rack.js';
import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';

/** A minimal loaded slot for getMonitorReadout (linear range, optional units). */
function slot({ label, controlNormalized, units = null, min = 0, max = 100 }) {
  return {
    module: { label },
    range: { min, max, equilibrium: (min + max) / 2 },
    target: null,
    control: { signalRange: { transform: 'linear' } },
    manifest: { valueRange: { units } },
    controlNormalized,
  };
}

describe('EffectsRack.getMonitorReadout', () => {
  it('returns one entry per loaded slot (slot/label/units), skipping empty slots', () => {
    const rack = new EffectsRack({ channel: 'x', dimensionId: 'EW::I' });
    rack.slots = [slot({ label: 'Reverb', controlNormalized: 0.5, units: '%' }), null];

    const out = rack.getMonitorReadout();
    expect(out).toHaveLength(1); // the null slot is skipped
    expect(out[0].slot).toBe('A');
    expect(out[0].label).toBe('Reverb');
    expect(out[0].units).toBe('%');
    expect(Number.isFinite(out[0].value)).toBe(true);
    expect(typeof out[0].formatted).toBe('string');
  });

  it('value is null and formatted "0"-style when there is no usable normalized input', () => {
    const rack = new EffectsRack({ channel: 'y', dimensionId: 'EW::I' });
    rack.slots = [slot({ label: 'Filter', controlNormalized: NaN, units: 'Hz' })];

    const out = rack.getMonitorReadout();
    expect(out[0].value).toBeNull();
    // formatMonitorValue(null, 'Hz') → "0 Hz" — the legacy DOM monitor reads identically.
    expect(out[0].formatted).toBe('0 Hz');
  });

  it('maps the supplied override normalized instead of the slot default', () => {
    const rack = new EffectsRack({ channel: 'z', dimensionId: 'EW::I' });
    rack.slots = [slot({ label: 'Gain', controlNormalized: 0, units: 'dB' })];

    const low = rack.getMonitorReadout(0)[0].value;
    const high = rack.getMonitorReadout(1)[0].value;
    expect(Number.isFinite(low)).toBe(true);
    expect(Number.isFinite(high)).toBe(true);
    expect(high).toBeGreaterThan(low); // a higher normalized maps higher on a linear range
  });

  it('labels slots A then B for a two-slot axis', () => {
    const rack = new EffectsRack({ channel: 'x', dimensionId: 'EW::I' });
    rack.slots = [
      slot({ label: 'A-mod', controlNormalized: 0.5 }),
      slot({ label: 'B-mod', controlNormalized: 0.5 }),
    ];
    const out = rack.getMonitorReadout();
    expect(out.map((r) => r.slot)).toEqual(['A', 'B']);
    expect(out.map((r) => r.label)).toEqual(['A-mod', 'B-mod']);
  });
});

describe('AudioEngineAdapter.getMonitorSnapshot', () => {
  function fakeRack(readouts, dimensionLabel = null) {
    return { dimensionLabel, getMonitorReadout: vi.fn(() => readouts) };
  }

  // Call the method against a minimal fake `this` — it only reads instance fields +
  // getActiveDimensionId(), so we avoid constructing the heavy real adapter.
  function callSnapshot(fakeThis, getNormalized) {
    return AudioEngineAdapter.prototype.getMonitorSnapshot.call(fakeThis, getNormalized);
  }

  it('walks every dimension in order, reading each axis rack; null racks → []', () => {
    const readoutA = [{ slot: 'A', label: 'R', value: 1, units: '%', formatted: '1 %' }];
    const fakeThis = {
      getActiveDimensionId: () => 'EW::II',
      axisOrder: ['x', 'y', 'z'],
      _dimensionOrder: ['EW::I', 'EW::II'],
      _dimensionChains: new Map([
        ['EW::I', { axisRacks: { x: fakeRack(readoutA, 'EW::I'), y: fakeRack([]), z: null } }],
        ['EW::II', { axisRacks: { x: fakeRack([]), y: fakeRack([]), z: fakeRack([]) } }],
      ]),
    };

    const snap = callSnapshot(fakeThis);
    expect(snap.activeDimensionId).toBe('EW::II');
    expect(snap.dimensions.map((d) => d.dimensionId)).toEqual(['EW::I', 'EW::II']);
    expect(snap.dimensions[0].dimensionLabel).toBe('EW::I');
    expect(snap.dimensions[0].axes.x).toBe(readoutA);
    expect(snap.dimensions[0].axes.z).toEqual([]); // a missing rack → empty axis
  });

  it('passes the live-normalized value per (dimension, axis) into the rack readout', () => {
    const xRack = fakeRack([]);
    const fakeThis = {
      getActiveDimensionId: () => 'EW::I',
      axisOrder: ['x'],
      _dimensionOrder: ['EW::I'],
      _dimensionChains: new Map([['EW::I', { axisRacks: { x: xRack } }]]),
    };
    const getNormalized = vi.fn((dim, axis) => (dim === 'EW::I' && axis === 'x' ? 0.3 : null));

    callSnapshot(fakeThis, getNormalized);
    expect(getNormalized).toHaveBeenCalledWith('EW::I', 'x');
    expect(xRack.getMonitorReadout).toHaveBeenCalledWith(0.3);
  });

  it('passes null to the rack readout when no normalized source is supplied', () => {
    const xRack = fakeRack([]);
    const fakeThis = {
      getActiveDimensionId: () => 'EW::I',
      axisOrder: ['x'],
      _dimensionOrder: ['EW::I'],
      _dimensionChains: new Map([['EW::I', { axisRacks: { x: xRack } }]]),
    };
    callSnapshot(fakeThis);
    expect(xRack.getMonitorReadout).toHaveBeenCalledWith(null);
  });
});
