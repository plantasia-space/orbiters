/**
 * @file src/ui/react/regions/LeftRail.tsx
 * @description The LeftRail region — the premix volume fader (strategy §5).
 *
 * Reproduces the legacy `.col-1` vertical slider (index.html: the
 * `webaudio-slider#gSlider` with `root-param="premix-deck-i"`, min=-60 max=6,
 * `tracking="rel"`, bidirectional). Built from the design-lib arrow `Slider`
 * wired through `ParameterizedSlider` → `useParameter` → the injected
 * `EngineContext`. No `window.*`, no WAC DOM slot.
 *
 * This is the FIRST region built on the shell (reuse-map build order #1): it
 * proves `?ui=react` boots, the EngineProvider is wired, and a real control
 * reads/writes a PM param through the injected boundary.
 */
import { ParameterizedSlider, ParameterizedParam } from '../../../react/parameters';

/** premix-deck-i range (dB), mirrored from index.html / createInitializeBaseFlow. */
const PREMIX_PARAM = 'premix-deck-i';
const PREMIX_MIN = -60;
const PREMIX_MAX = 6;
const PREMIX_STEP = 0.1;

export function LeftRail() {
  return (
    <div className="orbiters-react-ui__left-rail" data-ui-interactive data-ui-react-region="left-rail">
      <ParameterizedSlider
        rootParam={PREMIX_PARAM}
        className="orbiters-react-ui__left-rail-slider"
        direction="vert"
        tracking="rel"
        min={PREMIX_MIN}
        max={PREMIX_MAX}
        step={PREMIX_STEP}
        sensitivity={0.15}
        aria-label="Premix volume"
        // componentId matches the WAC widget id so persisted MIDI mappings carry over.
        midi={{ componentId: 'gSlider', scope: 'GLOBAL' }}
      />
      {/* dB readout BELOW the fader (legacy `#premix-deck-i-display`), not beside it. */}
      <ParameterizedParam
        rootParam={PREMIX_PARAM}
        min={PREMIX_MIN}
        max={PREMIX_MAX}
        precision={1}
        aria-label="Premix volume (dB)"
      />
    </div>
  );
}
