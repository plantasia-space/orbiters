/**
 * Kick switches as momentary TRIGGER bindings (KickTriggerDispatcher).
 *
 * A kick is an action (×0.5 / ×2 frequency multiplier), not a value. Inbound MIDI fires
 * the registered action on a RISING edge only (note-on / CC crossing 64 upward); a held
 * control or a release/note-off never re-fires. (The MIDIController delegates its kick
 * branch to this dispatcher; it's pure so it tests without the controller's import graph.)
 */
import { describe, it, expect, vi } from 'vitest';
import { KickTriggerDispatcher, RISING_THRESHOLD } from '../../src/input/midi/kickTrigger.ts';

describe('KickTriggerDispatcher — rising-edge dispatch', () => {
  it('fires once on a rising edge (crossing the threshold upward)', () => {
    const d = new KickTriggerDispatcher();
    const action = vi.fn();
    d.register('k1', action);
    expect(d.handle('k1', 100)).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-fire while held high', () => {
    const d = new KickTriggerDispatcher();
    const action = vi.fn();
    d.register('k1', action);
    d.handle('k1', 100); // rise
    d.handle('k1', 120); // held
    d.handle('k1', 127); // held
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on release, and fires again on the next press', () => {
    const d = new KickTriggerDispatcher();
    const action = vi.fn();
    d.register('k1', action);
    d.handle('k1', 100); // press → 1
    expect(d.handle('k1', 0)).toBe(false); // release → no fire
    expect(action).toHaveBeenCalledTimes(1);
    expect(d.handle('k1', 100)).toBe(true); // press again → 2
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('treats exactly the threshold as pressed', () => {
    const d = new KickTriggerDispatcher();
    const action = vi.fn();
    d.register('k1', action);
    expect(d.handle('k1', RISING_THRESHOLD - 1)).toBe(false);
    expect(d.handle('k1', RISING_THRESHOLD)).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('isolates rising-edge state per id', () => {
    const d = new KickTriggerDispatcher();
    const a1 = vi.fn();
    const a2 = vi.fn();
    d.register('k1', a1);
    d.register('k2', a2);
    d.handle('k1', 127);
    expect(a1).toHaveBeenCalledTimes(1);
    expect(a2).not.toHaveBeenCalled();
  });

  it('coerces a non-finite MIDI value to released (no fire)', () => {
    const d = new KickTriggerDispatcher();
    const action = vi.fn();
    d.register('k1', action);
    expect(d.handle('k1', Number.NaN)).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('KickTriggerDispatcher — lifecycle', () => {
  it('does nothing for an unregistered id', () => {
    const d = new KickTriggerDispatcher();
    expect(d.handle('nope', 127)).toBe(false);
  });

  it('unregister drops the action so inbound no longer fires', () => {
    const d = new KickTriggerDispatcher();
    const action = vi.fn();
    d.register('k1', action);
    d.unregister('k1');
    expect(d.has('k1')).toBe(false);
    expect(d.handle('k1', 127)).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it('re-registration replaces the action (remount re-supplies onTrigger)', () => {
    const d = new KickTriggerDispatcher();
    const first = vi.fn();
    const second = vi.fn();
    d.register('k1', first);
    d.register('k1', second);
    d.handle('k1', 127);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('register with no action clears the binding', () => {
    const d = new KickTriggerDispatcher();
    const action = vi.fn();
    d.register('k1', action);
    d.register('k1'); // clear
    expect(d.has('k1')).toBe(false);
    expect(d.handle('k1', 127)).toBe(false);
  });
});
