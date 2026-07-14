// @vitest-environment jsdom
/**
 * The RESOLUTION seam — the ONE place the React shell reads the imperative singletons.
 * The 13 sibling engine*.test.js files cover the createEngineContext SURFACES with fakes;
 * this file covers resolution itself:
 *   - the loud-on-drift POLICY (warnOnMissingExpectedSurfaces, pure module engineResolution.ts)
 *   - the {context, report} CONTRACT (resolveEngineContext) incl. the formerly-silent shape-drift.
 *
 * Why it matters: each reader shape-guards its singleton and returns null on mismatch. Before
 * this, a singleton that was PRESENT but shape-drifted (e.g. a renamed export) resolved to null
 * silently → a blank region with no error (removed the legacy fallback that masked it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resolveEngineSingletons pulls Interaction → MIDIController → Main.js (the whole app entry).
// The seam reads window.MIDIControllerInstance, NOT this import, so stubbing the module is
// faithful and breaks the cold-import cycle that booting Main would otherwise trigger.
vi.mock('../../src/input/midi/MIDIController.js', () => ({ MIDIControllerInstance: null }));

import {
  warnOnMissingExpectedSurfaces,
  ALWAYS_EXPECTED_SURFACES,
} from '../../src/ui/react/engineResolution.ts';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { resolveEngineContext } from '../../src/ui/react/resolveEngineSingletons.ts';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';

/** A correctly-shaped MIDIController (matches the readMidiController guard). */
function makeMidiController() {
  return {
    registerMidiLearnTarget: vi.fn(),
    unregisterMidiLearnTarget: vi.fn(),
  };
}

/** A full resolution report with every surface live — clone + override per test. */
function fullReport(overrides = {}) {
  return {
    midi: true,
    dims: true,
    panels: true,
    transport: true,
    sync: true,
    cosmic: true,
    sensors: true,
    webRtc: true,
    audioEngine: true,
    info: true,
    ...overrides,
  };
}

describe('warnOnMissingExpectedSurfaces (policy)', () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('only treats module-level singletons as always-expected', () => {
    expect(ALWAYS_EXPECTED_SURFACES).toEqual(['panels', 'transport', 'sync']);
  });

  it('stays quiet when every expected surface resolved', () => {
    expect(warnOnMissingExpectedSurfaces(fullReport(), /* midiSupported */ true)).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns and names an expected module-level surface that went missing (shape drift)', () => {
    const missing = warnOnMissingExpectedSurfaces(fullReport({ panels: false }), true);
    expect(missing).toEqual(['panels']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('panels');
  });

  it('treats midi as expected only when Web MIDI is supported', () => {
    expect(warnOnMissingExpectedSurfaces(fullReport({ midi: false }), true)).toEqual(['midi']);
    warnSpy.mockClear();
    expect(warnOnMissingExpectedSurfaces(fullReport({ midi: false }), false)).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('never warns about legitimately-lazy surfaces (audioEngine/sensors/webRtc/cosmic/dims/info)', () => {
    const lazyAbsent = fullReport({
      audioEngine: false,
      sensors: false,
      webRtc: false,
      cosmic: false,
      dims: false,
      info: false,
    });
    expect(warnOnMissingExpectedSurfaces(lazyAbsent, true)).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('resolveEngineContext (contract + report)', () => {
  const globalKeys = ['MIDIControllerInstance'];
  // The dimension reader resolves off the active voice's `worldMode` (registry), not a
  // `globalThis` slot — clear the realm registry between tests so a voice registered by another suite
  // can't leak in and flip `dims`.
  beforeEach(() => {
    voiceRegistry.clear();
  });
  afterEach(() => {
    voiceRegistry.clear();
    globalKeys.forEach((k) => {
      delete globalThis[k];
    });
  });

  it('returns { context, report } with a boolean for every surface', () => {
    const { context, report } = resolveEngineContext(new ParameterManager());
    expect(context).toBeDefined();
    expect(context.params).toBeDefined();
    for (const key of [
      'midi',
      'dims',
      'panels',
      'transport',
      'sync',
      'cosmic',
      'sensors',
      'webRtc',
      'audioEngine',
      'info',
    ]) {
      expect(typeof report[key]).toBe('boolean');
    }
  });

  it('reports midi live when the global is correctly shaped', () => {
    globalThis.MIDIControllerInstance = makeMidiController();
    expect(resolveEngineContext(new ParameterManager()).report.midi).toBe(true);
  });

  it('reports midi FALSE when the global is present but shape-drifted (the formerly-silent bug)', () => {
    // Present, but missing unregisterMidiLearnTarget — the exact silent-null case.
    globalThis.MIDIControllerInstance = { registerMidiLearnTarget: vi.fn() };
    expect(resolveEngineContext(new ParameterManager()).report.midi).toBe(false);
  });

  it('reports audioEngine by its presence + shape at mount', () => {
    // The audio engine is resolved off the active voice (registry), not a globalThis slot.
    voiceRegistry.register('test-voice', { id: 'test-voice' });
    expect(resolveEngineContext(new ParameterManager()).report.audioEngine).toBe(false);

    voiceRegistry.getActive().audioEngine = { getMonitorSnapshot: vi.fn() };
    expect(resolveEngineContext(new ParameterManager()).report.audioEngine).toBe(true);
  });
});
