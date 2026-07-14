// @vitest-environment jsdom
/**
 * The `sensors` EngineContext surface — a per-axis facade over the singleton
 * SensorController for the device-motion enable toggles. The enable is per-axis-per-dimension and
 * NOT a PM param (it drives SensorController start/stop-listening + persists scoped toggle state),
 * so it's a surface (like `cosmic`) rather than `useParameter`. It re-reads on the controller's
 * `sensorToggleChanged` document event (+ dimension change), and resolves the controller through a
 * PROVIDER so a controller that comes up AFTER mount (PanelManager builds it lazily) still works.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';
import { lookupComponentMetadataByKey } from '../../src/input/midi/componentMetadata.js';
import { UI_COMPONENT_SCOPES } from '../../src/core/stackUtils.js';

function makeController() {
  const state = { x: false, y: false, z: false };
  return {
    isAxisEnabled: (axis) => Boolean(state[axis]),
    setAxisActive: vi.fn((axis, on) => {
      if (axis in state) state[axis] = Boolean(on);
    }),
    calibrateDevice: vi.fn(),
  };
}

let pm;
let controller;

beforeEach(() => {
  pm = new ParameterManager();
  controller = makeController();
});

describe('sensors surface — per-axis facade over SensorController', () => {
  it('forwards enable + calibrate to the controller, per-axis', () => {
    const { sensors } = createEngineContext({ parameterManager: pm, sensorsProvider: () => controller });

    expect(sensors.available('x')).toBe(true);
    expect(sensors.available('distance')).toBe(false); // not a UI sensor axis here
    expect(sensors.isEnabled('x')).toBe(false);

    sensors.setEnabled('x', true);
    expect(controller.setAxisActive).toHaveBeenCalledWith('x', true);
    expect(sensors.isEnabled('x')).toBe(true);
    expect(sensors.isEnabled('y')).toBe(false); // per-axis isolation

    sensors.setEnabled('x', false);
    expect(controller.setAxisActive).toHaveBeenLastCalledWith('x', false);
    expect(sensors.isEnabled('x')).toBe(false);

    sensors.calibrate();
    expect(controller.calibrateDevice).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-sensor axis without throwing', () => {
    const { sensors } = createEngineContext({ parameterManager: pm, sensorsProvider: () => controller });
    sensors.setEnabled('distance', true);
    expect(controller.setAxisActive).not.toHaveBeenCalled();
    expect(sensors.isEnabled('distance')).toBe(false);
  });

  it('is unavailable and safe with no controller (pre-init / tests)', () => {
    const { sensors } = createEngineContext({ parameterManager: pm, sensorsProvider: () => null });
    expect(sensors.available('x')).toBe(false);
    expect(sensors.isEnabled('x')).toBe(false);
    expect(() => sensors.setEnabled('x', true)).not.toThrow();
    expect(() => sensors.calibrate()).not.toThrow();
  });

  it('resolves the controller LAZILY so one that comes up after mount works', () => {
    let live = null;
    const { sensors } = createEngineContext({ parameterManager: pm, sensorsProvider: () => live });
    expect(sensors.available('x')).toBe(false); // not up yet
    live = controller; // PanelManager builds it later
    expect(sensors.available('x')).toBe(true);
    sensors.setEnabled('y', true);
    expect(controller.setAxisActive).toHaveBeenCalledWith('y', true);
  });
});

describe('sensors surface — subscribe re-read triggers', () => {
  it('fires on sensorToggleChanged and orbiters:dimension-changed, stops after unsubscribe', () => {
    const { sensors } = createEngineContext({ parameterManager: pm, sensorsProvider: () => controller });
    const listener = vi.fn();
    const unsubscribe = sensors.subscribe(listener);

    document.dispatchEvent(new CustomEvent('sensorToggleChanged', { detail: { axis: 'x' } }));
    document.dispatchEvent(new Event('orbiters:dimension-changed'));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    document.dispatchEvent(new CustomEvent('sensorToggleChanged', { detail: { axis: 'x' } }));
    document.dispatchEvent(new Event('orbiters:dimension-changed'));
    expect(listener).toHaveBeenCalledTimes(2); // no more after unsubscribe
  });
});

describe('sensor-toggle componentId → legacy metadata (MIDI clear/inherit contract)', () => {
  // The React sensor toggle registers MIDI under `${axis}.sensor-toggle` (reusing the cosmic-enable
  // toggle seam). Like the cosmic toggle, it MUST resolve so `_clearLegacyWidgetMappingsForComponent`
  // drops the stale WAC `toggleSensor${AXIS}` mapping and the layered learn inherits.
  it.each(['x', 'y', 'z'])('%s.sensor-toggle resolves to uiId toggleSensor%s (DIMENSION → layered)', (axis) => {
    const meta = lookupComponentMetadataByKey(`${axis}.sensor-toggle`);
    expect(meta).toBeTruthy();
    expect(meta.id).toBe(`${axis}.sensor-toggle`);
    expect(meta.uiIds).toEqual([`toggleSensor${axis.toUpperCase()}`]);
    expect(meta.scope).toBe(UI_COMPONENT_SCOPES.DIMENSION);
  });
});
