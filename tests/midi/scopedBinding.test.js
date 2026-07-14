// @vitest-environment jsdom
/**
 * MIDI fix: a typed scoped-binding descriptor must be PINNED — never
 * re-resolved from the DOM. Learn stamps `data-midi-param-id` on the element; the
 * old code's hint-invalidation then rebuilt the descriptor without the typed
 * min/max, collapsing inbound value scaling to 0..1 (the "MIDI not wired to the
 * knob" bug Bruna hit). This guards that the pin holds.
 */
import { describe, it, expect } from 'vitest';
import { MidiMappingRegistry } from '../../src/input/midi/MidiMappingRegistry.js';

function makeEl(id) {
  const el = document.createElement('div');
  el.id = id;
  return el;
}

describe('registerScopedBinding — pinned typed descriptor', () => {
  it('keeps the typed min/max after a learn stamps data-midi-param-id', () => {
    const reg = new MidiMappingRegistry();
    const el = makeEl('pm-x.knob-1');
    reg.registerScopedBinding('pm-x.knob-1', el, {
      componentId: 'x.knob',
      componentKey: 'x.knob',
      baseParamId: 'x.knob',
      scope: 'DIMENSION',
      supportsLayers: true,
      componentType: 'knob',
      axis: 'x',
      min: -180,
      max: 180,
    });

    // simulate what setMidiWidgetMapping does on learn:
    el.setAttribute('data-midi-param-id', 'layered:x.knob|deck-i|EW::I');

    const meta = reg.resolveWidgetMetadata('pm-x.knob-1');
    expect(meta.pinned).toBe(true);
    expect(meta.min).toBe(-180); // survives — value scaling stays correct
    expect(meta.max).toBe(180);
    expect(meta.axis).toBe('x');
    expect(meta.supportsLayers).toBe(true);
  });

  it('still removes everything on unregister', () => {
    const reg = new MidiMappingRegistry();
    const el = makeEl('pm-y.knob-1');
    reg.registerScopedBinding('pm-y.knob-1', el, { componentId: 'y.knob', componentKey: 'y.knob', supportsLayers: true, axis: 'y', min: 0, max: 1 });
    expect(reg.widgetRegistry.has('pm-y.knob-1')).toBe(true);
    reg.unregisterWidget('pm-y.knob-1');
    expect(reg.widgetRegistry.has('pm-y.knob-1')).toBe(false);
    expect(reg.widgetDescriptors.has('pm-y.knob-1')).toBe(false);
  });
});
