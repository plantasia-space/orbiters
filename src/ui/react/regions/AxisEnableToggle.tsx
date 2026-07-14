/**
 * @file src/ui/react/regions/AxisEnableToggle.tsx
 * @description The per-axis enable/disable hexagon toggle, SHARED by the Cosmic LFO panel
 * (cosmic enable — `cX/cY/cZ`) and the Sensors panel (sensor enable — `sX/sY/sZ`). Both
 * panels show the SAME control with only a different label, so it lives in ONE place
 * (Bruna: "match them — they should look the same but with different labels"). The label is
 * ALWAYS visible below the hexagon.
 *
 * It is the lib arrow `Switch` toggle (which defaults to a hexagon), in the brilliant ink
 * (no muted `--input` outline, matching the cosmic kicks). Audio wiring is deferred —
 * each consumer passes its own `onToggle` (a `// TODO` no-op for now).
 */
import { Switch } from 'plantasia.space-design/react/arrow';
import { useOrbiterColors, toggleColors } from '../../../react/parameters';

export interface AxisEnableToggleProps {
  /** Always-visible label under the hexagon (e.g. `cX` for cosmic, `sX` for sensors). */
  label: string;
  'aria-label': string;
  /** Controlled on/off state. When provided, the hexagon reflects it (the Cosmic panel drives
   *  it from the `cosmic` surface); omit to leave it uncontrolled (the Sensors panel). */
  value?: boolean;
  /** Fired with the new on/off state. Deferred audio bridge lives in the caller. */
  onToggle?: (on: boolean) => void;
  /** Scoped MIDI-learn attributes (`id` + `data-automatable`) from `useToggle`, spread onto the
   *  underlying Switch so a learned CC can drive the hexagon. Omit for no MIDI. */
  midiProps?: Record<string, string>;
}

export function AxisEnableToggle({
  label,
  'aria-label': ariaLabel,
  value,
  onToggle,
  midiProps,
}: AxisEnableToggleProps) {
  // Brilliant orbiter primary for both states (off outline + on fill), kept live across
  // theme edits — no muted `--input` grey. See the canvas-widget note in `parameters`.
  const [c1] = useOrbiterColors();
  return (
    <Switch
      kind="toggle"
      shape="hexagon"
      colors={toggleColors(c1)}
      label={label}
      showLabel
      className="orbiters-react-ui__axis-enable"
      aria-label={ariaLabel}
      {...midiProps}
      {...(value === undefined ? {} : { value: value ? 1 : 0 })}
      onValueChange={(v) => onToggle?.(v === 1)}
    />
  );
}
