// @vitest-environment jsdom
/**
 * Cosmic source / waveform as single-CC stepped SELECT bindings (StepSelectDispatcher).
 *
 * The cycle ActionButtonGroup has no per-OPTION DOM target, so one CC maps across the N options
 * by VALUE → index (a quantized selector knob). The select-by-index action fires only when the
 * resolved index changes, so a continuous sweep fires once per band crossing. The first message
 * after (re)register reconciles the selection to the controller position. (The MIDIController
 * delegates here; it's pure so it tests without the controller's import graph.)
 */
import { describe, it, expect, vi } from 'vitest';
import { StepSelectDispatcher, midiValueToIndex } from '../../src/input/midi/stepSelect.ts';
import { lookupComponentMetadataByKey } from '../../src/input/midi/componentMetadata.js';
import { UI_COMPONENT_SCOPES } from '../../src/core/stackUtils.js';

const AXES = ['x', 'y', 'z'];

describe('midiValueToIndex — even quantization across N options', () => {
  it('maps the full 0..127 range across 4 bands', () => {
    expect(midiValueToIndex(0, 4)).toBe(0);
    expect(midiValueToIndex(31, 4)).toBe(0);
    expect(midiValueToIndex(32, 4)).toBe(1);
    expect(midiValueToIndex(63, 4)).toBe(1);
    expect(midiValueToIndex(64, 4)).toBe(2);
    expect(midiValueToIndex(95, 4)).toBe(2);
    expect(midiValueToIndex(96, 4)).toBe(3);
    expect(midiValueToIndex(127, 4)).toBe(3); // top clamps to last, not count
  });

  it('clamps out-of-range / non-finite to a valid index', () => {
    expect(midiValueToIndex(200, 4)).toBe(3);
    expect(midiValueToIndex(-5, 4)).toBe(0);
    expect(midiValueToIndex(Number.NaN, 4)).toBe(0);
  });

  it('handles a single-option list and a zero/invalid count without throwing', () => {
    expect(midiValueToIndex(127, 1)).toBe(0);
    expect(midiValueToIndex(127, 0)).toBe(0);
    expect(midiValueToIndex(127, -3)).toBe(0);
  });
});

describe('StepSelectDispatcher — value→index dispatch with per-index dedupe', () => {
  it('fires the resolved index on the first message (reconcile to controller position)', () => {
    const d = new StepSelectDispatcher();
    const onIndex = vi.fn();
    d.register('s1', { count: 4, onIndex });
    expect(d.handle('s1', 96)).toBe(true);
    expect(onIndex).toHaveBeenCalledTimes(1);
    expect(onIndex).toHaveBeenLastCalledWith(3);
  });

  it('does NOT re-fire while the value stays inside the same band', () => {
    const d = new StepSelectDispatcher();
    const onIndex = vi.fn();
    d.register('s1', { count: 4, onIndex });
    d.handle('s1', 64); // index 2
    d.handle('s1', 80); // still band 2
    d.handle('s1', 95); // still band 2
    expect(onIndex).toHaveBeenCalledTimes(1);
    expect(onIndex).toHaveBeenLastCalledWith(2);
  });

  it('fires once per band crossing on a sweep', () => {
    const d = new StepSelectDispatcher();
    const seen = [];
    d.register('s1', { count: 4, onIndex: (i) => seen.push(i) });
    [0, 16, 32, 48, 64, 80, 96, 112, 127].forEach((v) => d.handle('s1', v));
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('isolates index state per id', () => {
    const d = new StepSelectDispatcher();
    const a1 = vi.fn();
    const a2 = vi.fn();
    d.register('s1', { count: 4, onIndex: a1 });
    d.register('s2', { count: 4, onIndex: a2 });
    d.handle('s1', 127);
    expect(a1).toHaveBeenCalledTimes(1);
    expect(a2).not.toHaveBeenCalled();
  });
});

describe('StepSelectDispatcher — lifecycle + re-arm', () => {
  it('does nothing for an unregistered id', () => {
    const d = new StepSelectDispatcher();
    expect(d.handle('nope', 127)).toBe(false);
  });

  it('register with no action (or non-positive count) clears the binding', () => {
    const d = new StepSelectDispatcher();
    d.register('s1', { count: 4, onIndex: vi.fn() });
    d.register('s1', { count: 0, onIndex: vi.fn() }); // invalid count → clear
    expect(d.has('s1')).toBe(false);
    d.register('s2', { count: 4 }); // no action → not registered
    expect(d.has('s2')).toBe(false);
  });

  it('unregister drops the action AND the last index', () => {
    const d = new StepSelectDispatcher();
    const onIndex = vi.fn();
    d.register('s1', { count: 4, onIndex });
    d.handle('s1', 127);
    d.unregister('s1');
    expect(d.has('s1')).toBe(false);
    expect(d.handle('s1', 127)).toBe(false);
    expect(onIndex).toHaveBeenCalledTimes(1);
  });

  it('resetState re-arms so the next same-band message reconciles (dimension switch)', () => {
    const d = new StepSelectDispatcher();
    const onIndex = vi.fn();
    d.register('s1', { count: 4, onIndex });
    d.handle('s1', 127); // index 3
    d.handle('s1', 120); // same band → deduped
    expect(onIndex).toHaveBeenCalledTimes(1);
    d.resetState();
    expect(d.handle('s1', 120)).toBe(true); // reconciles now-active dimension's select
    expect(onIndex).toHaveBeenCalledTimes(2);
    expect(onIndex).toHaveBeenLastCalledWith(3);
  });
});

describe('cosmic select componentId → legacy metadata (clear/inherit contract)', () => {
  // GlyphSelect registers under `${axis}.waveform` / `${axis}.exo-source`. Like the kicks/toggle,
  // these MUST resolve so `_clearLegacyWidgetMappingsForComponent` drops the stale WAC per-option
  // mappings and the layered learn inherits. Rename the stackUtils keys and the lookup goes null.
  it.each(AXES)('%s.waveform resolves with the 4 legacy waveform uiIds (DIMENSION → layered)', (axis) => {
    const meta = lookupComponentMetadataByKey(`${axis}.waveform`);
    expect(meta).toBeTruthy();
    expect(meta.id).toBe(`${axis}.waveform`);
    expect(meta.uiIds).toEqual([
      `${axis}-waveform-sine`,
      `${axis}-waveform-square`,
      `${axis}-waveform-sawtooth`,
      `${axis}-waveform-triangle`,
    ]);
    expect(meta.scope).toBe(UI_COMPONENT_SCOPES.DIMENSION);
  });

  it.each(AXES)('%s.exo-source resolves to the legacy source dropdown uiId (DIMENSION → layered)', (axis) => {
    const meta = lookupComponentMetadataByKey(`${axis}.exo-source`);
    expect(meta).toBeTruthy();
    expect(meta.id).toBe(`${axis}.exo-source`);
    expect(meta.uiIds).toEqual([`${axis}-exo-lfo-dropdown`]);
    expect(meta.scope).toBe(UI_COMPONENT_SCOPES.DIMENSION);
  });
});
