// @vitest-environment jsdom
/**
 * A momentary TRIGGER (kick) binding must never produce outbound MIDI feedback.
 *
 * A kick is an action (×0.5 / ×2), not a sustained value: there is nothing to echo back to a
 * motorized fader or LED ring. Two halves are pinned here:
 *  1. the registry tags a kick's parameter-mapping records `kind:'trigger'` (sourced from the
 *     scoped descriptor's `componentType:'kick'`), and
 *  2. `MidiFeedbackBridge` skips any `kind:'trigger'` mapping — even when it shares a parameterId
 *     with a real value binding — while still emitting feedback for the value binding.
 */
import { describe, it, expect, vi } from 'vitest';
import { MidiMappingRegistry } from '../../src/input/midi/MidiMappingRegistry.js';
import { MidiFeedbackBridge } from '../../src/input/midi/MidiFeedbackBridge.js';

function makeEl(id) {
  const el = document.createElement('div');
  el.id = id;
  return el;
}

const CTX = { stackId: 'deck-i', dimensionId: 'EW::I' };

describe('registry tags kick bindings kind:trigger (D2)', () => {
  it('derives kind:trigger from componentType:kick on the descriptor', () => {
    const reg = new MidiMappingRegistry();
    const el = makeEl('pm-x.frequency-multiplier-low');
    reg.registerScopedBinding('pm-x.frequency-multiplier-low', el, {
      componentId: 'x.frequency-multiplier-low',
      componentKey: 'x.frequency-multiplier-low',
      baseParamId: 'x.frequency-multiplier-low',
      scope: 'DIMENSION',
      supportsLayers: true,
      componentType: 'kick',
      axis: null, // production kicks carry no axis (useTrigger)
    });
    const meta = reg.resolveWidgetMetadata('pm-x.frequency-multiplier-low');
    expect(meta.kind).toBe('trigger');
    expect(meta.componentType).toBe('kick');
    expect(meta.supportsLayers).toBe(true); // learn goes layered, not element-id
  });

  it('stamps kind:trigger onto the parameter-mapping record on learn (setLayeredBinding)', () => {
    const reg = new MidiMappingRegistry();
    const el = makeEl('pm-x.frequency-multiplier-low');
    reg.registerScopedBinding('pm-x.frequency-multiplier-low', el, {
      componentId: 'x.frequency-multiplier-low',
      componentKey: 'x.frequency-multiplier-low',
      baseParamId: 'x.frequency-multiplier-low',
      scope: 'DIMENSION',
      supportsLayers: true,
      componentType: 'kick',
      axis: null,
    });
    const meta = reg.resolveWidgetMetadata('pm-x.frequency-multiplier-low');
    reg.setLayeredBinding('pm-x.frequency-multiplier-low', meta, CTX, { channel: 0, cc: 20 });
    // parameterId for a kick falls back to its componentKey (no axis).
    const mappings = reg.getMappingsForParameter('x.frequency-multiplier-low');
    expect(mappings).toHaveLength(1);
    expect(mappings[0].kind).toBe('trigger');
  });

  it('leaves a value (knob) binding untagged', () => {
    const reg = new MidiMappingRegistry();
    const el = makeEl('pm-x.knob');
    reg.registerScopedBinding('pm-x.knob', el, {
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
    const meta = reg.resolveWidgetMetadata('pm-x.knob');
    expect(meta.kind).toBeUndefined();
    reg.setLayeredBinding('pm-x.knob', meta, CTX, { channel: 0, cc: 10 });
    const mappings = reg.getMappingsForParameter('x'); // axis-keyed
    expect(mappings[0].kind).toBeNull();
  });
});

describe('MidiFeedbackBridge skips trigger bindings (D2)', () => {
  function makeBridge(reg) {
    const sendControlChange = vi.fn();
    const parameterManager = {
      // a real value param so the value mapping can be normalized
      parameters: new Map([['x', { min: -180, max: 180 }]]),
      getActiveDimension: () => 'EW::I',
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    const bridge = new MidiFeedbackBridge({
      parameterManager,
      mappingRegistry: reg,
      connectionManager: { sendControlChange },
      shouldEmit: () => true,
    });
    return { bridge, sendControlChange };
  }

  it('emits feedback for a value mapping but NOT for a trigger sharing the parameterId', () => {
    const reg = new MidiMappingRegistry();
    // Worst case: a trigger and a value mapping under the SAME parameterId 'x'. The guard must
    // skip only the trigger. (Production kicks key off their componentId, never a PM param — this
    // is the defensive case where a future trigger collides with a real param.)
    reg.linkParameterMapping('x', {
      scopedKey: 'layered:x.knob|deck-i|EW::I',
      channel: 0,
      cc: 10,
    });
    reg.linkParameterMapping('x', {
      scopedKey: 'layered:x.frequency-multiplier-low|deck-i|EW::I',
      channel: 0,
      cc: 20,
      kind: 'trigger',
    });

    const { bridge, sendControlChange } = makeBridge(reg);
    bridge._handleParameterUpdate('x', 0);

    expect(sendControlChange).toHaveBeenCalledTimes(1);
    expect(sendControlChange).toHaveBeenCalledWith(expect.objectContaining({ cc: 10 }));
    expect(sendControlChange).not.toHaveBeenCalledWith(expect.objectContaining({ cc: 20 }));
  });

  it('emits nothing when the only mapping is a trigger', () => {
    const reg = new MidiMappingRegistry();
    reg.linkParameterMapping('x', {
      scopedKey: 'layered:x.frequency-multiplier-low|deck-i|EW::I',
      channel: 0,
      cc: 20,
      kind: 'trigger',
    });
    const { bridge, sendControlChange } = makeBridge(reg);
    bridge._handleParameterUpdate('x', 0);
    expect(sendControlChange).not.toHaveBeenCalled();
  });
});
