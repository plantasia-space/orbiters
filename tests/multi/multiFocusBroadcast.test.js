// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

function setUrl(query = '') {
  window.history.replaceState({}, '', `/${query}`);
}

function makePm() {
  return {
    getDimensionValue: vi.fn(),
    getNormalizedValue: vi.fn(),
    getParameter: vi.fn(),
    isParameterLocked: vi.fn(() => false),
    isParameterDimensionLocked: vi.fn(() => false),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    setDimensionValue: vi.fn(),
    setRawValue: vi.fn(),
    setActiveDimension: vi.fn(),
  };
}

function makeTransport() {
  return {
    getState: vi.fn(() => 'stopped'),
    isPlaying: vi.fn(() => false),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
  };
}

// A full per-voice mock bundle covering every wired broadcast facade, plus the createEngineContext
// options that resolve to it, so a test can assert each facade gangs to selected siblings.
function makeVoiceMocks() {
  const lfo = { triggerKick: vi.fn(), start: vi.fn(), stop: vi.fn(), setFrequencySource: vi.fn(), setWaveform: vi.fn(), isCosmicEnabled: () => false, getFrequencySource: () => 'manual', getWaveform: () => 'sine' };
  const engine = { hasLoopRange: () => true, setLoopEnabled: vi.fn(), getDurationMs: () => 1000, setLoopRange: vi.fn() };
  const mocks = {
    pm: makePm(),
    transport: makeTransport(),
    dimensionProvider: { getAvailableDimensions: () => [], getActiveDimensionId: () => null, setActiveDimension: vi.fn() },
    panelManager: { getActivePanel: () => null, activatePanel: vi.fn() },
    lfo,
    engine,
    syncEnableState: { isEnabled: () => false, setEnabled: vi.fn(), syncedCount: () => 0 },
  };
  mocks.options = {
    parameterManager: mocks.pm,
    transportController: mocks.transport,
    dimensionProvider: mocks.dimensionProvider,
    panelManager: mocks.panelManager,
    cosmicLfoProvider: () => lfo,
    audioEngineProvider: () => engine,
    syncEnableState: mocks.syncEnableState,
    syncCoordinator: { isEnabled: false },
  };
  return mocks;
}

describe('multi-focus broadcast policy', () => {
  beforeEach(() => {
    vi.resetModules();
    setUrl('');
  });

  it('uses opt-out params and explicit action membership', async () => {
    const { isGangableParam, isBroadcastAction } = await import('../../src/multi/multiFocusBroadcast.js');

    expect(isGangableParam('x')).toBe(true);
    expect(isGangableParam('premix-deck-i')).toBe(true);
    expect(isGangableParam('new-param-gangs-by-default')).toBe(true);
    expect(isGangableParam('sync-bpm')).toBe(false);
    expect(isGangableParam('sync-track-bpm')).toBe(false);

    expect(isBroadcastAction('params', 'setValue')).toBe(true);
    expect(isBroadcastAction('sync', 'setEnabled')).toBe(true); // per-voice flag — safe to gang
    expect(isBroadcastAction('waveformData', 'seek')).toBe(false); // per-track playhead — denied
    expect(isBroadcastAction('sensors', 'setEnabled')).toBe(false); // realm singleton — denied
  });
});

describe('multi-focus broadcast with fake voices', () => {
  beforeEach(() => {
    vi.resetModules();
    setUrl('');
  });

  it('replays selected origin actions on selected siblings only, using raw commands', async () => {
    const { voiceRegistry } = await import('../../src/voice/VoiceRegistry.js');
    const { createEngineContext } = await import('../../src/react/engine/createEngineContext.ts');
    const { MULTI_FOCUS_WRITE_SOURCE } = await import('../../src/multi/multiFocusBroadcast.js');
    const pmA = makePm();
    const pmB = makePm();
    const pmC = makePm();
    const tA = makeTransport();
    const tB = makeTransport();
    const tC = makeTransport();

    voiceRegistry.register('A', { id: 'A', parameterManager: pmA, transportControl: tA });
    voiceRegistry.register('B', { id: 'B', parameterManager: pmB, transportControl: tB });
    voiceRegistry.register('C', { id: 'C', parameterManager: pmC, transportControl: tC });
    voiceRegistry.toggleSelection('B');

    const ctxA = createEngineContext({ parameterManager: pmA, transportController: tA, voiceId: 'A' });
    createEngineContext({ parameterManager: pmB, transportController: tB, voiceId: 'B' });
    createEngineContext({ parameterManager: pmC, transportController: tC, voiceId: 'C' });

    const source = { origin: true };
    const options = { updateIntent: 'live' };
    ctxA.params.setValue('premix-deck-i', -12, source, 10, options);

    expect(pmA.setRawValue).toHaveBeenCalledWith('premix-deck-i', -12, source, 10, options);
    expect(pmB.setRawValue).toHaveBeenCalledWith('premix-deck-i', -12, MULTI_FOCUS_WRITE_SOURCE, 10, options);
    expect(pmC.setRawValue).not.toHaveBeenCalled();

    ctxA.transport.toggle();
    expect(tA.toggle).toHaveBeenCalledTimes(1);
    expect(tB.toggle).toHaveBeenCalledTimes(1);
    expect(tC.toggle).not.toHaveBeenCalled();
  });

  it('gangs every wired facade (dims/panels/transport/loop/cosmic-kick/sync) to selected siblings only', async () => {
    const { voiceRegistry } = await import('../../src/voice/VoiceRegistry.js');
    const { createEngineContext } = await import('../../src/react/engine/createEngineContext.ts');
    const A = makeVoiceMocks();
    const B = makeVoiceMocks();
    const C = makeVoiceMocks();

    voiceRegistry.register('A', { id: 'A' });
    voiceRegistry.register('B', { id: 'B' });
    voiceRegistry.register('C', { id: 'C' });
    voiceRegistry.toggleSelection('B'); // selection {A,B}, C excluded

    const ctxA = createEngineContext({ ...A.options, voiceId: 'A' });
    createEngineContext({ ...B.options, voiceId: 'B' });
    createEngineContext({ ...C.options, voiceId: 'C' });

    ctxA.dims.setActive('EW::II');
    expect(A.dimensionProvider.setActiveDimension).toHaveBeenCalledWith('EW::II');
    expect(B.dimensionProvider.setActiveDimension).toHaveBeenCalledWith('EW::II');
    expect(C.dimensionProvider.setActiveDimension).not.toHaveBeenCalled();

    ctxA.panels.activate('cosmic-lfo');
    expect(A.panelManager.activatePanel).toHaveBeenCalledWith('cosmic-lfo');
    expect(B.panelManager.activatePanel).toHaveBeenCalledWith('cosmic-lfo');
    expect(C.panelManager.activatePanel).not.toHaveBeenCalled();

    ctxA.transport.play();
    expect(A.transport.play).toHaveBeenCalledTimes(1);
    expect(B.transport.play).toHaveBeenCalledTimes(1);
    expect(C.transport.play).not.toHaveBeenCalled();

    ctxA.waveform.setLoopActive(true);
    expect(A.engine.setLoopEnabled).toHaveBeenCalledWith(true);
    expect(B.engine.setLoopEnabled).toHaveBeenCalledWith(true);
    expect(C.engine.setLoopEnabled).not.toHaveBeenCalled();

    ctxA.cosmic.triggerKick('x', 'xCosmic1');
    expect(A.lfo.triggerKick).toHaveBeenCalledWith('xCosmic1');
    expect(B.lfo.triggerKick).toHaveBeenCalledWith('xCosmic1');
    expect(C.lfo.triggerKick).not.toHaveBeenCalled();

    ctxA.sync.setEnabled(true);
    expect(A.syncEnableState.setEnabled).toHaveBeenCalledWith(true);
    expect(B.syncEnableState.setEnabled).toHaveBeenCalledWith(true);
    expect(C.syncEnableState.setEnabled).not.toHaveBeenCalled();
  });

  it('gangs the launch grid (deck facade) to selected siblings only', async () => {
    const { voiceRegistry } = await import('../../src/voice/VoiceRegistry.js');
    const { createEngineContext } = await import('../../src/react/engine/createEngineContext.ts');
    const { broadcastAction } = await import('../../src/multi/multiFocusBroadcast.js');
    const { Deck } = await import('../../src/voice/Deck.js');
    const A = makeVoiceMocks();
    const B = makeVoiceMocks();
    const C = makeVoiceMocks();

    voiceRegistry.register('A', { id: 'A', deck: new Deck({ voiceId: 'A', collection: true }) });
    voiceRegistry.register('B', { id: 'B', deck: new Deck({ voiceId: 'B', collection: true }) });
    voiceRegistry.register('C', { id: 'C', deck: new Deck({ voiceId: 'C', collection: true }) });
    voiceRegistry.toggleSelection('B'); // selection {A,B}, C excluded

    createEngineContext({ ...A.options, voiceId: 'A' });
    createEngineContext({ ...B.options, voiceId: 'B' });
    createEngineContext({ ...C.options, voiceId: 'C' });

    // The header picker path: write the OWN deck, then broadcast to the selection.
    voiceRegistry.get('A').deck.setLaunchGridBars(4);
    broadcastAction('A', 'deck', 'setLaunchGridBars', [4]);

    expect(voiceRegistry.get('A').deck.launchGridBars).toBe(4);
    expect(voiceRegistry.get('B').deck.launchGridBars).toBe(4); // ganged
    expect(voiceRegistry.get('C').deck.launchGridBars).toBe(0); // not selected — untouched
  });

  it('skips a selected sibling that has no engineCommands (torn-down / never-mounted)', async () => {
    const { voiceRegistry } = await import('../../src/voice/VoiceRegistry.js');
    const { createEngineContext } = await import('../../src/react/engine/createEngineContext.ts');
    const A = makeVoiceMocks();

    voiceRegistry.register('A', { id: 'A' });
    voiceRegistry.register('B', { id: 'B' }); // registered but NEVER given an engine context
    voiceRegistry.toggleSelection('B');

    const ctxA = createEngineContext({ ...A.options, voiceId: 'A' });
    // B has no engineCommands → the broadcaster must skip it silently, no throw.
    expect(() => ctxA.transport.toggle()).not.toThrow();
    expect(A.transport.toggle).toHaveBeenCalledTimes(1);
  });

  it('respects the param denylist', async () => {
    const { voiceRegistry } = await import('../../src/voice/VoiceRegistry.js');
    const { createEngineContext } = await import('../../src/react/engine/createEngineContext.ts');
    const pmA = makePm();
    const pmB = makePm();

    voiceRegistry.register('A', { id: 'A', parameterManager: pmA });
    voiceRegistry.register('B', { id: 'B', parameterManager: pmB });
    voiceRegistry.toggleSelection('B');

    const ctxA = createEngineContext({ parameterManager: pmA, voiceId: 'A' });
    createEngineContext({ parameterManager: pmB, voiceId: 'B' });

    ctxA.params.setValue('sync-bpm', 128, null, 10, { updateIntent: 'commit' });
    expect(pmA.setRawValue).toHaveBeenCalledTimes(1);
    expect(pmB.setRawValue).not.toHaveBeenCalled();
  });

  it('is a no-op for single-focus selections', async () => {
    const { voiceRegistry } = await import('../../src/voice/VoiceRegistry.js');
    const { createEngineContext } = await import('../../src/react/engine/createEngineContext.ts');
    const pmA = makePm();
    const pmB = makePm();

    voiceRegistry.register('A', { id: 'A', parameterManager: pmA });
    voiceRegistry.register('B', { id: 'B', parameterManager: pmB });

    const ctxA = createEngineContext({ parameterManager: pmA, voiceId: 'A' });
    createEngineContext({ parameterManager: pmB, voiceId: 'B' });

    ctxA.params.setValue('x', 3, null, 10, { updateIntent: 'live' });
    expect(pmA.setRawValue).toHaveBeenCalledTimes(1);
    expect(pmB.setRawValue).not.toHaveBeenCalled();
  });
});

describe('multi-focus broadcast — single-orbiter (voiceId null) is untouched', () => {
  beforeEach(() => {
    vi.resetModules();
    setUrl('');
  });

  it('a null-voiceId context registers no engineCommands and never wraps/broadcasts', async () => {
    const { voiceRegistry } = await import('../../src/voice/VoiceRegistry.js');
    const { createEngineContext } = await import('../../src/react/engine/createEngineContext.ts');
    const pmA = makePm();

    // Single-orbiter boot passes voiceId undefined — there are no siblings, so the facades must be the
    // bare pass-throughs (no broadcast wrapper) and nothing is stashed on any VoiceContext.
    const voiceA = { id: 'A', parameterManager: pmA };
    voiceRegistry.register('A', voiceA);

    const ctx = createEngineContext({ parameterManager: pmA });
    ctx.params.setValue('x', 3, null, 10, { updateIntent: 'live' });
    expect(pmA.setRawValue).toHaveBeenCalledTimes(1);
    expect(voiceA.engineCommands).toBeUndefined();
  });
});
