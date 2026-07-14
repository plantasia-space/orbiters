// @vitest-environment jsdom
/**
 * MidiMappingPersistence — the bridge between the ScopedMidiMap store and the REST API.
 * Pins the scope grouping of `loadMany` (orbiter slices ride the single-orbiter hot path; collection
 * slices are scoped single fetches) and the EPOCH GUARD: a fetch that raced a local learn is
 * discarded instead of clobbering the just-learned binding (the long-standing fetch-vs-learn
 * correctness gap this design closed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScopedMidiMap } from '../../src/input/midi/ScopedMidiMap.js';
import { MidiMappingPersistence } from '../../src/input/midi/MidiMappingPersistence.js';
import { fetchMidiMappings } from '../../src/api/midiLearnService.js';

vi.mock('../../src/api/midiLearnService.js', () => ({
  fetchMidiMappings: vi.fn(),
  saveMidiMapping: vi.fn().mockResolvedValue({}),
  clearMidiMappingRemote: vi.fn().mockResolvedValue({}),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makePersistence(store) {
  return new MidiMappingPersistence({
    scopedMidiMap: store,
    resolveScope: () => ({ scope: 'orbiter', entityId: 'orb-A' }),
    resolveParameterId: () => 'x.knob',
    resolveDeviceInfo: () => ({ deviceId: 'dev-1' }),
  });
}

describe('MidiMappingPersistence.loadMany — scope grouping', () => {
  it('one orbiter slice uses the scoped orbiter fetch (hot path)', async () => {
    fetchMidiMappings.mockResolvedValue({ midiLearn: { orbiters: { 'orb-A': { 'x.knob': { cc: 21, channel: 1 } } } } });
    const store = new ScopedMidiMap();
    await makePersistence(store).loadMany(['orbiter:orb-A']);
    expect(fetchMidiMappings).toHaveBeenCalledWith('orb-A');
    expect(store.bindingsFor('orbiter:orb-A').get('x.knob')).toEqual({ channel: 0, cc: 21 });
  });

  it('several orbiter slices share ONE full-tree fetch; a collection slice fetches scoped', async () => {
    fetchMidiMappings.mockImplementation(async (ref) => {
      if (ref && typeof ref === 'object') {
        return { midiLearn: { collections: { 'col-1': { 'drawer-toggle': { cc: 40, channel: 1 } } } } };
      }
      return {
        midiLearn: {
          orbiters: {
            'orb-A': { 'x.knob': { cc: 21, channel: 1 } },
            'orb-B': { 'x.knob': { cc: 30, channel: 1 } },
          },
        },
      };
    });
    const store = new ScopedMidiMap();
    await makePersistence(store).loadMany(['orbiter:orb-A', 'orbiter:orb-B', 'collection:col-1']);

    // One undefined-arg (full tree) call for the two orbiters + one scoped collection call.
    expect(fetchMidiMappings).toHaveBeenCalledTimes(2);
    expect(fetchMidiMappings).toHaveBeenCalledWith(undefined);
    expect(fetchMidiMappings).toHaveBeenCalledWith({ scope: 'collection', entityId: 'col-1' });
    expect(store.bindingsFor('orbiter:orb-B').get('x.knob').cc).toBe(30);
    expect(store.bindingsFor('collection:col-1').get('drawer-toggle').cc).toBe(40);
  });
});

describe('MidiMappingPersistence.loadMany — partial failure isolation', () => {
  it('a rejecting collection-scope fetch (older backend) never blocks orbiter hydration', async () => {
    fetchMidiMappings.mockImplementation(async (ref) => {
      if (ref && typeof ref === 'object') {
        throw new Error('Invalid scope: use track, orbiter, or world.');
      }
      return { midiLearn: { orbiters: { 'orb-A': { 'x.knob': { cc: 21, channel: 1 } } } } };
    });
    const store = new ScopedMidiMap();
    await makePersistence(store).loadMany(['orbiter:orb-A', 'collection:col-1']);

    // The orbiter slice hydrated; the collection slice stayed not-loaded for a later retry.
    expect(store.bindingsFor('orbiter:orb-A').get('x.knob').cc).toBe(21);
    expect(store.hasLoaded('orbiter:orb-A')).toBe(true);
    expect(store.hasLoaded('collection:col-1')).toBe(false);
  });

  it('a TOTAL failure still rethrows (preserves the caller auth/log handling)', async () => {
    fetchMidiMappings.mockRejectedValue(new Error('Authentication required to load MIDI mappings'));
    const store = new ScopedMidiMap();
    await expect(makePersistence(store).loadMany(['orbiter:orb-A'])).rejects.toThrow(/Authentication required/);
  });
});

describe('MidiMappingPersistence.loadMany — epoch guard (fetch-vs-learn race)', () => {
  it('discards a response for a slice that was written locally while the fetch was in flight', async () => {
    const store = new ScopedMidiMap();
    let resolveFetch;
    fetchMidiMappings.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

    const load = makePersistence(store).loadMany(['collection:col-1']);
    // The learn lands mid-flight (gesture-time write advances the epoch)…
    store.setBinding('collection:col-1', 'stage-focus-1', { channel: 0, cc: 99 });
    // …then the (pre-learn) response arrives without that binding.
    resolveFetch({ midiLearn: { collections: { 'col-1': {} } } });
    await load;

    expect(store.bindingsFor('collection:col-1').get('stage-focus-1')).toEqual({ channel: 0, cc: 99 });
    expect(store.hasLoaded('collection:col-1')).toBe(false); // stale response must not count as loaded
  });

  it('applies normally when nothing raced the fetch', async () => {
    const store = new ScopedMidiMap();
    fetchMidiMappings.mockResolvedValue({ midiLearn: { collections: { 'col-1': { 'stage-next': { cc: 41, channel: 1 } } } } });
    await makePersistence(store).loadMany(['collection:col-1']);
    expect(store.bindingsFor('collection:col-1').get('stage-next')).toEqual({ channel: 0, cc: 41 });
    expect(store.hasLoaded('collection:col-1')).toBe(true);
  });
});
