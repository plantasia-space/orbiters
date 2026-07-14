// @vitest-environment jsdom
/**
 * Per-slice mapping store (`ScopedMidiMap`).
 *
 * A MIDI mapping is slice-owned — keyed by scopeKey (`orbiter:<id>`, `collection:<id>`),
 * shared across every tile of the SAME slice, and never cross-hydrating a DIFFERENT slice that
 * happens to share a leaf key. This is the routing subsystem's unit-test surface. Write epochs
 * make a fetch that raced a local learn land stale instead of clobbering it.
 */
import { describe, it, expect, vi } from 'vitest';
import { ScopedMidiMap } from '../../src/input/midi/ScopedMidiMap.js';
import { MidiMappingRegistry } from '../../src/input/midi/MidiMappingRegistry.js';
import { buildLayeredKey } from '../../src/input/midi/componentMetadata.js';

describe('ScopedMidiMap — per-orbiter store', () => {
  it('loadOrbiter normalizes the backend 1-based channel to runtime 0-based', () => {
    const store = new ScopedMidiMap();
    store.loadSlice('orbiter:orb-A', { 'layered:x.knob|deck-i|EW::I': { cc: 21, channel: 1 } });
    expect(store.bindingsFor('orbiter:orb-A').get('layered:x.knob|deck-i|EW::I')).toEqual({
      channel: 0, // 1-based 1 → 0-based 0
      cc: 21,
    });
  });

  it('loadOrbiter for one orbiter does NOT clear another (load ALL present orbiters)', () => {
    const store = new ScopedMidiMap();
    store.loadSlice('orbiter:orb-A', { 'x.knob': { cc: 21, channel: 1 } });
    store.loadSlice('orbiter:orb-B', { 'x.knob': { cc: 30, channel: 1 } });
    // Re-loading A must not wipe B.
    store.loadSlice('orbiter:orb-A', { 'x.knob': { cc: 22, channel: 1 } });
    expect(store.bindingsFor('orbiter:orb-A').get('x.knob').cc).toBe(22);
    expect(store.bindingsFor('orbiter:orb-B').get('x.knob').cc).toBe(30);
  });

  it('keeps DIFFERENT orbiters independent for the SAME leaf key (no cross-talk)', () => {
    const store = new ScopedMidiMap();
    store.setBinding('orbiter:orb-A', 'layered:x.knob|deck-i|EW::I', { channel: 0, cc: 21 });
    store.setBinding('orbiter:orb-B', 'layered:x.knob|deck-i|EW::I', { channel: 0, cc: 99 });
    expect(store.bindingsFor('orbiter:orb-A').get('layered:x.knob|deck-i|EW::I').cc).toBe(21);
    expect(store.bindingsFor('orbiter:orb-B').get('layered:x.knob|deck-i|EW::I').cc).toBe(99);
  });

  it('setBinding emits (orbiterId, paramKey); loadOrbiter does NOT emit (bulk boot load)', () => {
    const store = new ScopedMidiMap();
    const listener = vi.fn();
    store.subscribe(listener);

    store.loadSlice('orbiter:orb-A', { 'x.knob': { cc: 21, channel: 1 } });
    expect(listener).not.toHaveBeenCalled(); // bulk load is silent

    store.setBinding('orbiter:orb-A', 'x.knob', { channel: 0, cc: 22 });
    expect(listener).toHaveBeenCalledWith('orbiter:orb-A', 'x.knob');
  });

  it('deleteBinding removes the binding and emits (unmap propagation)', () => {
    const store = new ScopedMidiMap();
    const listener = vi.fn();
    store.setBinding('orbiter:orb-A', 'x.knob', { channel: 0, cc: 21 });
    store.subscribe(listener);

    expect(store.deleteBinding('orbiter:orb-A', 'x.knob')).toBe(true);
    expect(store.bindingsFor('orbiter:orb-A').has('x.knob')).toBe(false);
    expect(listener).toHaveBeenCalledWith('orbiter:orb-A', 'x.knob');
  });

  it('unsubscribe stops further notifications', () => {
    const store = new ScopedMidiMap();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.setBinding('orbiter:orb-A', 'x.knob', { channel: 0, cc: 21 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('hasAny reflects whether any orbiter holds a binding', () => {
    const store = new ScopedMidiMap();
    expect(store.hasAny()).toBe(false);
    store.bindingsFor('orbiter:orb-A'); // create empty slice
    expect(store.hasAny()).toBe(false);
    store.setBinding('orbiter:orb-A', 'x.knob', { channel: 0, cc: 21 });
    expect(store.hasAny()).toBe(true);
  });

  it('hasLoaded distinguishes a genuinely-empty fetched orbiter from one never fetched', () => {
    const store = new ScopedMidiMap();
    expect(store.hasLoaded('orbiter:orb-A')).toBe(false);
    store.bindingsFor('orbiter:orb-A'); // a mere lookup (learn/hydrate) must NOT count as "loaded"
    expect(store.hasLoaded('orbiter:orb-A')).toBe(false);

    store.loadSlice('orbiter:orb-A', {}); // backend returned zero bindings for this orbiter
    expect(store.hasLoaded('orbiter:orb-A')).toBe(true);
    expect(store.bindingsFor('orbiter:orb-A').size).toBe(0); // empty, but no longer "unloaded"

    expect(store.hasLoaded('orbiter:orb-B')).toBe(false);
    store.clear();
    expect(store.hasLoaded('orbiter:orb-A')).toBe(false);
  });

  it('ignores invalid inputs (falsy orbiterId/key, non-finite cc/channel)', () => {
    const store = new ScopedMidiMap();
    store.setBinding(null, 'x.knob', { channel: 0, cc: 21 });
    store.setBinding('orbiter:orb-A', '', { channel: 0, cc: 21 });
    store.setBinding('orbiter:orb-A', 'x.knob', { channel: 0, cc: NaN });
    expect(store.hasAny()).toBe(false);
    expect(store.bindingsFor(null)).toBeNull();
  });
});

describe('hydrateLayeredWidget — orbiter-scoped candidate set (no cross-hydration)', () => {
  function makeKnob(id) {
    const el = document.createElement('div');
    el.id = id;
    return el;
  }
  const META = (widgetId) => ({
    widgetId,
    componentKey: 'x.knob',
    baseParamId: 'x.knob',
    legacyKeys: [],
    supportsLayers: true,
    axis: 'x',
  });
  const CONTEXT = { stackId: 'deck-i', dimensionId: 'EW::I' };
  const KEY = buildLayeredKey('x.knob', 'deck-i', 'EW::I');

  it('a widget hydrates ONLY from its own orbiter’s bindings', () => {
    const store = new ScopedMidiMap();
    store.setBinding('orbiter:orb-A', KEY, { channel: 0, cc: 21 });
    store.setBinding('orbiter:orb-B', KEY, { channel: 0, cc: 99 });

    // Two registries standing in for two tiles' widgets (same componentKey 'x.knob').
    const regA = new MidiMappingRegistry();
    regA.registerScopedBinding('vA-pm-x.knob', makeKnob('vA-pm-x.knob'), META('vA-pm-x.knob'));
    const regB = new MidiMappingRegistry();
    regB.registerScopedBinding('vB-pm-x.knob', makeKnob('vB-pm-x.knob'), META('vB-pm-x.knob'));

    const ha = regA.hydrateLayeredWidget(
      'vA-pm-x.knob',
      regA.resolveWidgetMetadata('vA-pm-x.knob'),
      CONTEXT,
      store.bindingsFor('orbiter:orb-A'),
    );
    const hb = regB.hydrateLayeredWidget(
      'vB-pm-x.knob',
      regB.resolveWidgetMetadata('vB-pm-x.knob'),
      CONTEXT,
      store.bindingsFor('orbiter:orb-B'),
    );

    expect(ha.binding.cc).toBe(21); // orbiter A's CC
    expect(hb.binding.cc).toBe(99); // orbiter B's CC — NOT A's
  });

  it('a widget whose orbiter has no binding hydrates empty (null candidate set is safe)', () => {
    const reg = new MidiMappingRegistry();
    reg.registerScopedBinding('vC-pm-x.knob', makeKnob('vC-pm-x.knob'), META('vC-pm-x.knob'));
    const hydration = reg.hydrateLayeredWidget(
      'vC-pm-x.knob',
      reg.resolveWidgetMetadata('vC-pm-x.knob'),
      CONTEXT,
      null,
    );
    expect(hydration.binding).toBeFalsy();
  });
});

describe('ScopedMidiMap — write epochs (fetch-vs-learn race)', () => {
  it('a fetch that raced a local learn is discarded (loadSlice with a stale epoch)', () => {
    const store = new ScopedMidiMap();
    const key = 'orbiter:orb-A';
    const epochAtFetchStart = store.epoch(key);
    // The learn lands while the fetch is in flight…
    store.setBinding(key, 'x.knob', { channel: 0, cc: 22 });
    // …so the (pre-learn) response must be dropped, keeping the learned binding.
    const applied = store.loadSlice(key, { 'x.knob': { cc: 21, channel: 1 } }, epochAtFetchStart);
    expect(applied).toBe(false);
    expect(store.bindingsFor(key).get('x.knob').cc).toBe(22);
    // A stale response must not mark the slice loaded either — the next explicit load runs.
    expect(store.hasLoaded(key)).toBe(false);
  });

  it('an unmap also advances the epoch (a stale fetch cannot resurrect a removed binding)', () => {
    const store = new ScopedMidiMap();
    const key = 'collection:col-1';
    store.loadSlice(key, { 'drawer-toggle': { cc: 40, channel: 1 } });
    const epochAtFetchStart = store.epoch(key);
    store.deleteBinding(key, 'drawer-toggle');
    const applied = store.loadSlice(key, { 'drawer-toggle': { cc: 40, channel: 1 } }, epochAtFetchStart);
    expect(applied).toBe(false);
    expect(store.bindingsFor(key).has('drawer-toggle')).toBe(false);
  });

  it('an un-raced fetch applies normally (epoch unchanged)', () => {
    const store = new ScopedMidiMap();
    const key = 'collection:col-1';
    const epochAtFetchStart = store.epoch(key);
    const applied = store.loadSlice(key, { 'stage-focus-1': { cc: 30, channel: 1 } }, epochAtFetchStart);
    expect(applied).toBe(true);
    expect(store.bindingsFor(key).get('stage-focus-1')).toEqual({ channel: 0, cc: 30 });
    expect(store.hasLoaded(key)).toBe(true);
  });

  it('slices race independently — a write in one slice never invalidates another slice\'s fetch', () => {
    const store = new ScopedMidiMap();
    const epochA = store.epoch('orbiter:orb-A');
    store.setBinding('collection:col-1', 'stage-focus-1', { channel: 0, cc: 30 });
    expect(store.loadSlice('orbiter:orb-A', { 'x.knob': { cc: 21, channel: 1 } }, epochA)).toBe(true);
  });
});
