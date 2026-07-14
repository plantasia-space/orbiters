/**
 * @file src/ui/react/regions/XYZControls.tsx
 * @description The XYZ axis-core region (strategy §5, reuse-map build order #2).
 *
 * Reproduces the per-axis column from index.html (`.xyz-column`): for each of
 * x / y / z, the rotation Knob + the numeric value Param. Both are clean PM
 * params ('x' | 'y' | 'z', range ±180), wired through the proven
 * `ParameterizedKnob` / `ParameterizedParam` seam → injected `EngineContext`.
 * Grouped with the design-lib `Panel` / `Section` primitives.
 *
 * SENSOR TOGGLE (`toggleSensor{X,Y,Z}`) — built as a VISUAL control with a deferred
 * audio bridge. There is no clean PM-param path: the sensor on/off drives
 * `SensorsController`, which stores the WAC switch element AS its state and listens
 * to that element's `change` event — it needs a controller extraction + a `sensors`
 * EngineContext surface (a controller-extraction-style lift), which is out of this UI-build scope.
 * Reaching it via `window.*` would break the Phase-0 hard gate. So the toggle is
 * reproduced here (so the column matches the real UI) and carries a clear
 * `// TODO: wire to audio`; the WAC sensor switch stays mounted underneath
 * (compatibility shell), so the feature still works until the surface lands.
 * The COSMIC LFO controls are a per-axis stack (`CosmicAxisStack`) rendered inside
 * this column when the COSMIC_LFO panel is active — mirroring the legacy `.xyz-column`,
 * where the cosmic controls are hidden children PanelManager reveals (not a separate
 * region).
 */
import { useCallback, useEffect, useState } from 'react';
import { ParameterizedKnob, ParameterizedParam, useToggle } from '../../../react/parameters';
import { useActivePanel } from './useActivePanel';
import { AxisEnableToggle } from './AxisEnableToggle';
import { CosmicAxisStack } from './CosmicLfoPanel';
import { useEngineSensors } from '../../../react/engine/EngineContext';
import { AXIS_ROTATION_CONSTRAINTS } from '../../../config/Constants.js';

const AXES = ['x', 'y', 'z'] as const;
type Axis = (typeof AXES)[number];

// AXIS_ROTATION_CONSTRAINTS comes from untyped .js (typed `object`); read the
// shape we rely on, with the index.html defaults as a fallback.
const AXIS_CONSTRAINTS = (AXIS_ROTATION_CONSTRAINTS ?? {}) as {
  min?: number;
  max?: number;
  step?: number;
  equilibrium?: number;
};
const AXIS_MIN = AXIS_CONSTRAINTS.min ?? -180;
const AXIS_MAX = AXIS_CONSTRAINTS.max ?? 180;
const AXIS_STEP = AXIS_CONSTRAINTS.step ?? 0.01;

/** Device-sensor enable (on/off) for the axis' active dimension, via the `sensors` surface.
    Mirrors the cosmic enable hook: optimistic local state + re-read on the surface's change
    subscription so it tracks the legacy chrome, a remote peer (WebRTC), and dimension switches. */
function useSensorEnabled(axis: Axis): [boolean, (on: boolean) => void] {
  const sensors = useEngineSensors();
  const [enabled, setEnabled] = useState<boolean>(() => sensors.isEnabled(axis));
  useEffect(() => {
    const read = () => setEnabled(sensors.isEnabled(axis));
    read();
    return sensors.subscribe(read);
  }, [sensors, axis]);
  const toggle = useCallback(
    (on: boolean) => {
      sensors.setEnabled(axis, on);
      setEnabled(on);
    },
    [sensors, axis],
  );
  return [enabled, toggle];
}

function SensorToggle({ axis }: { axis: Axis }) {
  // The sensor enable now drives the live SensorController via the `sensors` surface
  // (enable → device-motion listeners + per-dim scoped persistence). MIDI reuses the SAME toggle
  // seam as the cosmic enable: componentId `${axis}.sensor-toggle` (uiId `toggleSensor${AXIS}`)
  // resolves in metadata so a learned CC inherits + the stale WAC mapping clears; a MIDI press
  // (rising edge) FLIPS the enable via the same `setEnabled` as a click.
  const [enabled, setEnabled] = useSensorEnabled(axis);
  const { midiProps } = useToggle({ componentId: `${axis}.sensor-toggle`, value: enabled, onToggle: setEnabled });
  // Same control as the cosmic enable toggle (shared `AxisEnableToggle`), `sX/sY/sZ` label.
  return (
    <AxisEnableToggle
      label={`s${axis.toUpperCase()}`}
      aria-label={`${axis} sensor enable`}
      value={enabled}
      onToggle={setEnabled}
      midiProps={midiProps}
    />
  );
}

function AxisColumn({
  axis,
  showSensorToggle,
  showCosmic,
}: {
  axis: Axis;
  showSensorToggle: boolean;
  showCosmic: boolean;
}) {
  return (
    <div className="orbiters-react-ui__axis-column" data-ui-interactive data-axis={axis}>
      <ParameterizedKnob
        rootParam={axis}
        min={AXIS_MIN}
        max={AXIS_MAX}
        step={AXIS_STEP}
        // Double-click recenters to 0 (neutral rotation), NOT the min. The lib knob falls back
        // to `min` (-180) when no `defaultValue` is given — the axis range is symmetric ±180, so
        // the nominal/reset is the center 0.
        defaultValue={0}
        sensitivity={0.15}
        aria-label={`${axis} rotation`}
        // componentId matches the WAC widget so persisted MIDI mappings carry over.
        midi={{ componentId: `${axis}.knob` }}
      />
      {/* Value only — no inline label (the legacy/reference shows just the centred
          number under each gauge; a left-label sat black-on-black and threw the
          number + the whole column off-centre). aria-label keeps it accessible. */}
      {/* Equilibrium (double-click reset) is read from the parameter's registration in
          ParameterManager (0 for the ±180 axes) — no hardcoded reset value here. */}
      <ParameterizedParam
        rootParam={axis}
        min={AXIS_MIN}
        max={AXIS_MAX}
        step={AXIS_STEP}
        precision={1}
        aria-label={`${axis} value`}
        // The speed lock dims + freezes this number, but the padlock belongs on the knob
        // right above it — a second glyph just overlaps the digits. Keep the lock behaviour,
        // drop the redundant icon here.
        showLockIcon={false}
      />
      {/* Per-panel extras (NOT part of the Jam base). The legacy cosmic controls live
          as hidden children of this same `.xyz-column`, revealed when COSMIC_LFO is
          active (PanelManager); the sensor toggle is the SENSORS-panel delta. Only one
          panel is active at a time. The column is bottom-anchored, so the cosmic stack
          grows it upward (knob/value rise) — matching the reference captures. */}
      {showCosmic && <CosmicAxisStack axis={axis} />}
      {showSensorToggle && <SensorToggle axis={axis} />}
    </div>
  );
}

export function XYZControls() {
  // The 3 axis gauges + values are CONSTANT across every panel (the Jam base). The
  // per-panel deltas added under each axis are the COSMIC_LFO cosmic stack and the
  // SENSORS sensor toggle. No titled Panel/Section box — the gauges float bottom-centre
  // over the canvas, matching the reference jam layout.
  const action = useActivePanel()?.action;
  const showSensorToggle = action === 'sensors';
  const showCosmic = action === 'cosmic-lfo';
  return (
    <div className="orbiters-react-ui__xyz" data-ui-interactive data-ui-react-region="xyz">
      <div className="orbiters-react-ui__xyz-row">
        {AXES.map((axis) => (
          <AxisColumn
            key={axis}
            axis={axis}
            showSensorToggle={showSensorToggle}
            showCosmic={showCosmic}
          />
        ))}
      </div>
    </div>
  );
}
