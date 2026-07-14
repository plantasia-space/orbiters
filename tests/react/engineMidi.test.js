// @vitest-environment jsdom
/**
 * The `midi` EngineContext surface (strategy §3) — lazy availability.
 *
 * MIDIController is created on first MIDI activation and may not exist when the
 * shell mounts. `createEngineContext` accepts a `midiControllerProvider` resolved
 * on every access, so `midi.available` flips true (and register/unregister start
 * working) once MIDI comes up AFTER mount — instead of being frozen at mount time.
 *
 * Also pins the legacy one-shot `midiController` snapshot still works (tests / when
 * MIDI is already up).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

function makeMidiController() {
  return {
    registerMidiLearnTarget: vi.fn(),
    unregisterMidiLearnTarget: vi.fn(),
  };
}

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('midi surface — lazy availability via provider', () => {
  it('reflects MIDI activated AFTER context creation (not frozen at mount)', () => {
    let controller = null; // MIDI not up yet at "mount"
    const { midi } = createEngineContext({
      parameterManager: pm,
      midiControllerProvider: () => controller,
    });

    expect(midi.available).toBe(false);

    // MIDI activates later — the getter re-resolves, so availability flips true.
    controller = makeMidiController();
    expect(midi.available).toBe(true);

    const binding = { id: 'pm-x.knob', element: {}, componentId: 'x.knob' };
    midi.registerTarget(binding);
    expect(controller.registerMidiLearnTarget).toHaveBeenCalledWith(binding);
    midi.unregisterTarget('pm-x.knob');
    expect(controller.unregisterMidiLearnTarget).toHaveBeenCalledWith('pm-x.knob');
  });

  it('reflects MIDI going away again (provider returns null)', () => {
    let controller = makeMidiController();
    const { midi } = createEngineContext({
      parameterManager: pm,
      midiControllerProvider: () => controller,
    });
    expect(midi.available).toBe(true);
    controller = null;
    expect(midi.available).toBe(false);
    // register/unregister are no-ops, not throws, when unavailable.
    expect(() => midi.registerTarget({ id: 'x', element: {}, componentId: 'x' })).not.toThrow();
    expect(() => midi.unregisterTarget('x')).not.toThrow();
  });
});

describe('midi surface — legacy one-shot snapshot', () => {
  it('honours a direct midiController value (no provider)', () => {
    const controller = makeMidiController();
    const { midi } = createEngineContext({ parameterManager: pm, midiController: controller });
    expect(midi.available).toBe(true);
    midi.registerTarget({ id: 'x', element: {}, componentId: 'x' });
    expect(controller.registerMidiLearnTarget).toHaveBeenCalled();
  });

  it('is unavailable with neither provider nor controller', () => {
    const { midi } = createEngineContext({ parameterManager: pm });
    expect(midi.available).toBe(false);
  });
});
