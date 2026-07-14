/**
 * The ParameterManager contract the CosmicLFO ↔ PM frequency bridge relies on.
 *
 * The `${axis}-cosmic-frequency` PM param is KEPT (strategy §7); the React-knob
 * bridge that consumed it (`_onFrequencyParamChanged`/`_publishFrequencyToParam`,
 * the in-place dual path) was retired during Phase 0, and the same wiring
 * returns on the InputSource seam under `<CosmicLfoPanel>` (Phase 2). These
 * PM-contract invariants are what that future wiring will re-rely on, so we pin them
 * here against the REAL ParameterManager (registered exactly as OrbitersEditMode does)
 * so a PM refactor can't silently break them in the meantime.
 *
 * The bridge pattern:
 *   - subscribes a controller OBJECT with dimensionId=null;
 *   - writes back tagged with a STRING source `CosmicLFO:freq:<axis>`;
 *   - ignores notifications whose `metadata.sourceController` is that string, and
 *     whose `reason` is anything other than 'value-change' / 'unchanged-commit'.
 * So it is only correct if: (1) a bidirectional param re-notifies even the source
 * (hence self-guard, not assume exclusion); (2) the source identity is carried
 * verbatim on the metadata; (3) value-change / unchanged-commit /
 * active-dimension-change / subscribe reasons are produced as expected.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import {
  cosmicFrequencyParamId,
  COSMIC_FREQ_MIN,
  COSMIC_FREQ_MAX,
} from '../../src/input/cosmicFrequencyParam.js';

const AXIS = 'x';
const DIMS = ['EW::I', 'EW::II'];
const PARAM = cosmicFrequencyParamId(AXIS);
const FREQ_SOURCE = `CosmicLFO:freq:${AXIS}`;

function registerFrequencyParam(pm) {
  // Mirror OrbitersEditMode._initializeMultidimensionalParameters for the freq param.
  pm.addMultidimensionalParameter(PARAM, DIMS, 0.01, COSMIC_FREQ_MIN, COSMIC_FREQ_MAX, {
    isBidirectional: true,
    step: 0.0001,
    scope: 'DIMENSION',
    scale: 'logarithmic',
  });
}

describe('cosmicFrequencyParam helpers', () => {
  it('derives the PM param id in the dash form (distinct from the dot MIDI componentId)', () => {
    // The PM rootParam is "x-cosmic-frequency"; the MIDI componentId stays
    // "x.cosmic-frequency" (the form `<CosmicLfoPanel>` will reuse) so persisted WAC
    // mappings carry over. These two forms are intentionally different — do not "normalise".
    expect(cosmicFrequencyParamId('x')).toBe('x-cosmic-frequency');
    expect(cosmicFrequencyParamId('z')).toBe('z-cosmic-frequency');
  });

  it('exposes a valid frequency range', () => {
    expect(COSMIC_FREQ_MIN).toBeLessThan(COSMIC_FREQ_MAX);
  });
});

describe('CosmicLFO ↔ PM frequency bridge — PM contract', () => {
  let pm;
  let calls;
  let controller;

  beforeEach(() => {
    // ParameterManager is per-voice — `new` already yields an isolated store.
    pm = new ParameterManager();
    registerFrequencyParam(pm);
    calls = [];
    // Mirrors CosmicLFO._freqParamController: an OBJECT controller, null dimension.
    controller = {
      onParameterChanged(name, value, dimensionId, metadata) {
        calls.push({ name, value, dimensionId, metadata });
      },
    };
    pm.subscribe(controller, PARAM, 10, null);
    calls.length = 0; // drop any 'subscribe' seed notification
  });

  it('re-notifies the bidirectional source verbatim, so the write-back MUST self-guard', () => {
    // A knob/MIDI edit (object source) lands and is applied to the LFO.
    pm.setDimensionValue(PARAM, 'EW::I', 1.5, controller, 100, { updateIntent: 'commit' });
    const edit = calls.find((c) => c.metadata?.reason === 'value-change');
    expect(edit).toBeTruthy();
    expect(edit.value).toBeCloseTo(1.5, 5);

    calls.length = 0;
    // The bridge's write-back uses the STRING source. Because the param is
    // bidirectional, PM re-notifies even though *this* controller is a different object
    // — proving the bridge cannot rely on PM exclusion and must compare sourceController.
    pm.setDimensionValue(PARAM, 'EW::I', 2.0, FREQ_SOURCE, 10, { updateIntent: 'commit' });
    const echo = calls.find((c) => c.metadata?.sourceController === FREQ_SOURCE);
    expect(echo).toBeTruthy(); // delivered → the bridge's sourceController guard is load-bearing
  });

  it('tags unchanged commits with reason "unchanged-commit" (bridge still applies these)', () => {
    pm.setDimensionValue(PARAM, 'EW::I', 3.0, controller, 100, { updateIntent: 'commit' });
    calls.length = 0;
    // Re-commit the SAME value with notifyIfUnchanged (the seam's commitIfUnchanged).
    pm.setDimensionValue(PARAM, 'EW::I', 3.0, controller, 100, {
      updateIntent: 'commit',
      notifyIfUnchanged: true,
    });
    const unchanged = calls.find((c) => c.metadata?.reason === 'unchanged-commit');
    expect(unchanged).toBeTruthy();
  });

  it('emits reason "active-dimension-change" on a dimension switch (bridge ignores these)', () => {
    // Seed distinct per-dimension values, then switch the active dimension.
    pm.setDimensionValue(PARAM, 'EW::I', 1.0, controller, 100, { updateIntent: 'commit' });
    pm.setDimensionValue(PARAM, 'EW::II', 7.0, controller, 100, { updateIntent: 'commit' });
    pm.setActiveDimension('EW::I'); // ensure a known starting active dim
    calls.length = 0;

    pm.setActiveDimension('EW::II');
    const switched = calls.find((c) => c.metadata?.reason === 'active-dimension-change');
    expect(switched).toBeTruthy();
    // The bridge filters this reason — dimension restore is handled by
    // _applyScopedStateFromRegistry, not by re-driving audio from the notification.
    expect(switched.value).toBeCloseTo(7.0, 5);
  });

  it('keeps per-dimension frequency isolated (a write to one dim does not bleed)', () => {
    pm.setDimensionValue(PARAM, 'EW::I', 0.5, controller, 100, { updateIntent: 'commit' });
    pm.setDimensionValue(PARAM, 'EW::II', 9.0, controller, 100, { updateIntent: 'commit' });
    expect(pm.getDimensionValue(PARAM, 'EW::I')).toBeCloseTo(0.5, 5);
    expect(pm.getDimensionValue(PARAM, 'EW::II')).toBeCloseTo(9.0, 5);
  });
});
