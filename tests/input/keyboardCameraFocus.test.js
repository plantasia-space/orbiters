// @vitest-environment jsdom
/**
 * Q sends the camera to the other body — the same choice the corner button makes.
 *
 * The interesting case is the shift-selection. Every other shortcut SETS a thing (this panel, this
 * dimension), so ganging it across several voices needs no thought: the same value lands on each.
 * This one TOGGLES. Applied voice by voice it would flip each about its OWN state, so a selection
 * that started out disagreeing would stay that way forever and Q could never settle it. These pin
 * that the selection is read once and answered once.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { KeyboardController } from '../../src/input/KeyboardController.js';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';
import { getCameraFocus, setCameraFocus } from '../../src/world/cameraFocus.js';

describe('Q — what the camera orbits', () => {
  let kb;

  beforeEach(() => {
    voiceRegistry.clear();
    voiceRegistry.register('A', { id: 'A' });
    voiceRegistry.register('B', { id: 'B' });
    setCameraFocus('A', 'world');
    setCameraFocus('B', 'world');
    kb = KeyboardController.initialize({});
  });

  it('sends the focused voice to the moon, and back again', () => {
    voiceRegistry.setActive('A');

    kb.toggleCameraFocus();
    expect(getCameraFocus('A')).toBe('moon');

    kb.toggleCameraFocus();
    expect(getCameraFocus('A')).toBe('world');
  });

  it('leaves a voice that is not focused exactly where it was', () => {
    voiceRegistry.setActive('A');

    kb.toggleCameraFocus();

    expect(getCameraFocus('A')).toBe('moon');
    expect(getCameraFocus('B')).toBe('world'); // B was never asked
  });

  it('settles a disagreeing selection instead of flipping each about its own state', () => {
    // The trap: A is out at the moon, B is home at the world. Toggling each in turn would simply
    // swap them and leave the selection just as split — pressing Q forever would never agree.
    setCameraFocus('A', 'moon');
    setCameraFocus('B', 'world');
    voiceRegistry.setActive('A');
    voiceRegistry.addToSelection('B'); // the shift-selection the shortcuts gang across
    expect(voiceRegistry.getFocusTargets()).toHaveLength(2);

    kb.toggleCameraFocus();

    expect(getCameraFocus('A')).toBe(getCameraFocus('B')); // they agree...
    expect(getCameraFocus('A')).toBe('world'); // ...on the answer for the voice the key was aimed at

    kb.toggleCameraFocus();
    expect(getCameraFocus('A')).toBe('moon');
    expect(getCameraFocus('B')).toBe('moon'); // and they cross back together
  });

  it('answers the voice you last touched, not the one you selected first', () => {
    // Shift-clicking a second orbiter makes THAT one active, while the selection keeps its
    // insertion order — so the first id in the list is NOT the voice under the hand. Toggling about
    // the first would leave the orbiter you just clicked looking like it ignored the key.
    setCameraFocus('A', 'moon');
    setCameraFocus('B', 'world');
    voiceRegistry.setActive('A');
    voiceRegistry.toggleSelection('B'); // shift-click: B joins the selection AND becomes active

    expect(voiceRegistry.getFocusTargets()[0]).toBe('A'); // …yet A is still first in the list
    expect(voiceRegistry.getActive()?.id).toBe('B'); // …and B is the one you touched

    kb.toggleCameraFocus();

    // B was at the world, so the key sends everything to the moon. Reading A first would have sent
    // them all to the world instead — and B, the one under the hand, would not have moved at all.
    expect(getCameraFocus('B')).toBe('moon');
    expect(getCameraFocus('A')).toBe('moon');
  });

  it('does nothing at all when there is no voice to aim at', () => {
    voiceRegistry.clear();
    expect(() => kb.toggleCameraFocus()).not.toThrow();
  });
});
