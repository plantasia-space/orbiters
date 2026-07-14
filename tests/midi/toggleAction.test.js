// @vitest-environment jsdom
/**
 * Cosmic/sensor enable + loop as LATCHING toggle bindings (ToggleActionDispatcher).
 *
 * A toggle latches: mapped to a momentary MIDI pad (127 press / 0 release) it must FLIP on each
 * PRESS and hold, then flip back on the next press. So the dispatcher fires a FLIP action on a
 * RISING edge only (prev < 64, cur >= 64); the release / held-high / continuous values never
 * re-fire. The action is a no-arg flip — the React seam inverts the control's current state. (The
 * MIDIController delegates its toggle branch here; it's pure so it tests without the controller's
 * import graph.)
 */
import { describe, it, expect, vi } from 'vitest';
import { ToggleActionDispatcher, TOGGLE_THRESHOLD } from '../../src/input/midi/toggleAction.ts';
import { lookupComponentMetadataByKey } from '../../src/input/midi/componentMetadata.js';
import { UI_COMPONENT_SCOPES } from '../../src/core/stackUtils.js';

const AXES = ['x', 'y', 'z'];

describe('cosmic-enable toggle componentId → legacy cosmic-toggle metadata (clear/inherit contract)', () => {
  // CosmicEnableToggle registers under `${axis}.cosmic-toggle`. Like the kicks (D1), this MUST
  // resolve in the metadata registry so `_clearLegacyWidgetMappingsForComponent` drops the stale
  // WAC `${axis}CosmicLFO` mapping and the layered learn inherits. Rename the stackUtils key and
  // the lookup goes null → clear/inherit silently break. This pins it.
  it.each(AXES)('%s.cosmic-toggle resolves to uiId %sCosmicLFO (DIMENSION → layered)', (axis) => {
    const meta = lookupComponentMetadataByKey(`${axis}.cosmic-toggle`);
    expect(meta).toBeTruthy();
    expect(meta.id).toBe(`${axis}.cosmic-toggle`);
    expect(meta.uiIds).toEqual([`${axis}CosmicLFO`]);
    expect(meta.scope).toBe(UI_COMPONENT_SCOPES.DIMENSION); // → supportsLayers, learn goes layered
  });

  it.each(AXES)('round-trips from the legacy WAC uiId %sCosmicLFO back to the component', (axis) => {
    // `_clearLegacyWidgetMappingsForComponent` deletes `midiWidgetMappings` keyed by this uiId;
    // it must round-trip back to the same component (byUiId index).
    expect(lookupComponentMetadataByKey(`${axis}CosmicLFO`)?.id).toBe(`${axis}.cosmic-toggle`);
  });
});

describe('header loop toggle componentId → legacy loop-toggle metadata (GLOBAL toggle clear/inherit)', () => {
  // The header loop toggle registers MIDI under the legacy GLOBAL key `loop-toggle` (scope GLOBAL →
  // non-layered, element-id path). It must resolve so the stale WAC `loop-toggle` mapping clears
  // and the learn inherits.
  it('loop-toggle resolves to its own uiId and is UNIQUE/GLOBAL (non-layered)', () => {
    const meta = lookupComponentMetadataByKey('loop-toggle');
    expect(meta).toBeTruthy();
    expect(meta.id).toBe('loop-toggle');
    expect(meta.uiIds).toEqual(['loop-toggle']);
    expect(meta.scope).toBe(UI_COMPONENT_SCOPES.UNIQUE); // GLOBAL/UNIQUE → supportsLayers false
  });
});

describe('ToggleActionDispatcher — rising-edge flip (latch on press)', () => {
  it('fires the flip ONCE on a rising edge (a press)', () => {
    const d = new ToggleActionDispatcher();
    const flip = vi.fn();
    d.register('t1', flip);
    expect(d.handle('t1', 127)).toBe(true);
    expect(flip).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on release, and fires again on the NEXT press (latch back-and-forth)', () => {
    const d = new ToggleActionDispatcher();
    const flip = vi.fn();
    d.register('t1', flip);
    d.handle('t1', 127); // press → flip (1)
    expect(d.handle('t1', 0)).toBe(false); // release → no flip
    expect(flip).toHaveBeenCalledTimes(1);
    expect(d.handle('t1', 127)).toBe(true); // press again → flip (2)
    expect(flip).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-fire while held above the threshold (continuous controller)', () => {
    const d = new ToggleActionDispatcher();
    const flip = vi.fn();
    d.register('t1', flip);
    d.handle('t1', 64); // press
    d.handle('t1', 100); // held
    d.handle('t1', 127); // held
    expect(flip).toHaveBeenCalledTimes(1);
  });

  it('treats exactly the threshold as a press', () => {
    const d = new ToggleActionDispatcher();
    const flip = vi.fn();
    d.register('t1', flip);
    expect(d.handle('t1', TOGGLE_THRESHOLD - 1)).toBe(false);
    expect(d.handle('t1', TOGGLE_THRESHOLD)).toBe(true);
    expect(flip).toHaveBeenCalledTimes(1);
  });

  it('isolates rising-edge state per id', () => {
    const d = new ToggleActionDispatcher();
    const a1 = vi.fn();
    const a2 = vi.fn();
    d.register('t1', a1);
    d.register('t2', a2);
    d.handle('t1', 127);
    expect(a1).toHaveBeenCalledTimes(1);
    expect(a2).not.toHaveBeenCalled();
  });

  it('coerces a non-finite MIDI value to released (no fire)', () => {
    const d = new ToggleActionDispatcher();
    const flip = vi.fn();
    d.register('t1', flip);
    expect(d.handle('t1', Number.NaN)).toBe(false);
    expect(flip).not.toHaveBeenCalled();
  });
});

describe('ToggleActionDispatcher — lifecycle', () => {
  it('does nothing for an unregistered id', () => {
    const d = new ToggleActionDispatcher();
    expect(d.handle('nope', 127)).toBe(false);
  });

  it('unregister drops the action AND the edge state so inbound no longer fires', () => {
    const d = new ToggleActionDispatcher();
    const flip = vi.fn();
    d.register('t1', flip);
    d.handle('t1', 127);
    d.unregister('t1');
    expect(d.has('t1')).toBe(false);
    expect(d.handle('t1', 127)).toBe(false);
    expect(flip).toHaveBeenCalledTimes(1);
  });

  it('re-registration replaces the action (remount re-supplies the flip)', () => {
    const d = new ToggleActionDispatcher();
    const first = vi.fn();
    const second = vi.fn();
    d.register('t1', first);
    d.register('t1', second);
    d.handle('t1', 127);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('register with no action clears the binding', () => {
    const d = new ToggleActionDispatcher();
    const flip = vi.fn();
    d.register('t1', flip);
    d.register('t1'); // clear
    expect(d.has('t1')).toBe(false);
    expect(d.handle('t1', 127)).toBe(false);
  });
});

describe('ToggleActionDispatcher — resetState (dimension-change re-arm)', () => {
  it('re-arms a HELD control so its next press flips the now-active dimension', () => {
    const d = new ToggleActionDispatcher();
    const flip = vi.fn();
    d.register('t1', flip);
    d.handle('t1', 127); // press → flip (1), value held high
    expect(flip).toHaveBeenCalledTimes(1);
    // Dimension switch while the control is still held high: resetState drops the edge memory so
    // a re-sent high value counts as a fresh press on the new dimension.
    d.resetState();
    expect(d.handle('t1', 127)).toBe(true);
    expect(flip).toHaveBeenCalledTimes(2);
  });

  it('keeps the action bound (only the edge memory is cleared)', () => {
    const d = new ToggleActionDispatcher();
    const flip = vi.fn();
    d.register('t1', flip);
    d.resetState();
    expect(d.has('t1')).toBe(true);
  });
});
