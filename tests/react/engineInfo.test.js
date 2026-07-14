// @vitest-environment jsdom
/**
 * The `info` EngineContext surface — the STATIC metadata rows for the Info panel's
 * non-Monitor views (track / entangled-world / orbiter). A facade over the `infoTagsProvider`
 * (`Constants.TRACK_DATA` → `buildInfoTags`). It re-reads on a dimension switch (orbiter axis rows
 * follow the active dimension) AND on a `dataManager:configUpdated` window event (a new
 * track/orbiter/world loaded mid-session).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('info surface — static metadata rows', () => {
  it('returns the provider rows for a mode; [] for an unknown mode or no provider', () => {
    const tags = {
      track: [{ label: 'Track', value: 'bwv1054 andante dub' }],
      orbiter: [{ label: 'Orbiter', value: 'X' }],
    };
    const { info } = createEngineContext({ parameterManager: pm, infoTagsProvider: () => tags });

    expect(info.getTags('track')).toEqual([{ label: 'Track', value: 'bwv1054 andante dub' }]);
    expect(info.getTags('entangled-world')).toEqual([]); // mode absent from the provider's data
    expect(info.getTags('orbiter')).toEqual([{ label: 'Orbiter', value: 'X' }]);

    const { info: unwired } = createEngineContext({ parameterManager: pm }); // no provider
    expect(unwired.getTags('track')).toEqual([]);
  });

  it('re-resolves on every read (reflects newly-loaded data)', () => {
    let current = { track: [{ label: 'Track', value: 'first' }] };
    const { info } = createEngineContext({ parameterManager: pm, infoTagsProvider: () => current });
    expect(info.getTags('track')[0].value).toBe('first');
    current = { track: [{ label: 'Track', value: 'second' }] };
    expect(info.getTags('track')[0].value).toBe('second');
  });
});

describe('info surface — subscribe re-read triggers', () => {
  it('fires on orbiters:dimension-changed AND dataManager:configUpdated, stops after unsubscribe', () => {
    const { info } = createEngineContext({ parameterManager: pm, infoTagsProvider: () => ({}) });
    const listener = vi.fn();
    const unsubscribe = info.subscribe(listener);

    document.dispatchEvent(new Event('orbiters:dimension-changed'));
    window.dispatchEvent(new Event('dataManager:configUpdated'));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    document.dispatchEvent(new Event('orbiters:dimension-changed'));
    window.dispatchEvent(new Event('dataManager:configUpdated'));
    expect(listener).toHaveBeenCalledTimes(2); // no more after unsubscribe
  });

  // Per-voice config-update. Each tile's DataManager dispatches configUpdated on its OWN
  // eventBus, and the `info` + `waveformData` surfaces subscribe to the SAME bus — so a new track loading
  // in one tile doesn't refresh another tile's info rows / kit waveform.
  it('config-update is isolated per voice: configUpdated on bus A does not reach bus B', () => {
    const busA = new EventTarget();
    const busB = new EventTarget();
    const ctxA = createEngineContext({ parameterManager: pm, infoTagsProvider: () => ({}), eventBus: busA });
    const ctxB = createEngineContext({ parameterManager: pm, infoTagsProvider: () => ({}), eventBus: busB });
    const infoA = vi.fn();
    const infoB = vi.fn();
    const dataA = vi.fn();
    const dataB = vi.fn();
    ctxA.info.subscribe(infoA);
    ctxB.info.subscribe(infoB);
    ctxA.waveformData.subscribeConfig(dataA);
    ctxB.waveformData.subscribeConfig(dataB);

    busA.dispatchEvent(new Event('dataManager:configUpdated'));
    expect(infoA).toHaveBeenCalledTimes(1);
    expect(dataA).toHaveBeenCalledTimes(1);
    expect(infoB).not.toHaveBeenCalled();
    expect(dataB).not.toHaveBeenCalled();
  });
});
