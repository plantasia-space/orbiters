/**
 * @file src/ui/react/regions/CosmicLfoPanel.tsx
 * @description The per-axis Cosmic LFO control stack (strategy §5, reuse-map #3).
 *
 * MODEL: the legacy cosmic controls are NOT a separate panel box. In
 * index.html they are hidden children of each `.xyz-column` (the column with the jam-base
 * axis knob + value), which PanelManager reveals when COSMIC_LFO is active. So this is a
 * per-axis STACK rendered INSIDE `XYZControls`' axis column (gated to `cosmic-lfo`), NOT a
 * standalone region.
 *
 * This component is the ONE place that constructs the cosmic panel. The legacy logic was
 * scattered (index.html markup + PanelManager show/hide + CosmicLFO `_toggleManualControls`
 * / `_setMultiplierVisibility` DOM toggling); here it collapses into a single source-driven
 * render. The MODULATION SOURCE is the pivot:
 *   - a DISCRETE source (Cosmic LFO / Stellar Luminosity / Frequency CPD / Mass — the
 *     world-data sources) → show the ×0.5 / ×2 frequency MULTIPLIERS;
 *   - the MANUAL source → show a CONTINUOUS frequency KNOB (the "extra knob") the user
 *     dials in `[COSMIC_FREQ_MIN, COSMIC_FREQ_MAX]`.
 * The source list + the `isManualSource` fork come from the shared catalog
 * (`cosmic/cosmicSources`), the SAME model the legacy `CosmicLFO.js` reads — no duplication.
 *
 * Visual order (top→bottom, matching the legacy DOM + the reference captures):
 * amplitude (Depth) knob → waveform glyph → source glyph → [multipliers | manual freq knob]
 * → ƒ frequency monitor → cosmic enable toggle (hexagon).
 *
 * WIRED (the cosmic panel drives the live CosmicLFO):
 *   - amplitude → `${axis}-cosmic-amplitude` (Knob) + the CosmicLFO PM amplitude bridge
 *   - manual frequency → `${axis}-cosmic-frequency` (Knob, log) + the freq bridge (manual mode)
 *   - frequency monitor → `${axis}-cosmic-frequency` (Param, readout)
 *   - source / waveform selects + cosmic enable toggle → the `cosmic` EngineContext surface
 *     (`setFrequencySource` / `setWaveform` / `start`·`stop`), re-read on the surface's change
 *     subscription so they track the legacy chrome, dimension switches, and world-data seeding
 *   - ×0.5/×2 multiplier kicks → `cosmic.triggerKick` (its effect reflects on the freq knob/monitor via
 *     the freq bridge and rides the multi-focus broadcast policy)
 *
 * Remaining deferred: per-OPTION MIDI-learn on the select/kick controls (needs the lib
 * ActionButtonGroup per-option DOM hook).
 */
import { useCallback, useEffect, useState } from 'react';
import { ActionButtonGroup } from 'plantasia.space-design/react';
import { Icon } from 'plantasia.space-design/icons';
import {
  ParameterizedKnob,
  ParameterizedParam,
  ParameterizedKick,
  useToggle,
  useStepSelect,
  useOrbiterColors,
  kickColors,
} from '../../../react/parameters';
import { useEngineCosmic } from '../../../react/engine/EngineContext';
import { AxisEnableToggle } from './AxisEnableToggle';
import { cosmicKickComponentId } from './cosmicKickIds';
import {
  COSMIC_SOURCES,
  COSMIC_WAVEFORMS,
  isManualSource,
} from '../../../input/cosmic/cosmicSources';
import { COSMIC_FREQ_MIN, COSMIC_FREQ_MAX } from '../../../input/cosmicFrequencyParam.js';
import { usePortalContainer } from '../PortalContainerProvider';
import { useNavViewportState } from './useNavViewportState';

type Axis = 'x' | 'y' | 'z';

/** Source + waveform options for the `ActionButtonGroup` dropdowns, sourced from the
    shared catalog. `kind: 'select'` makes each a single-selection item (like the header
    info menu); the icon is the design-lib glyph. */
const SOURCE_OPTIONS = COSMIC_SOURCES.map((s) => ({
  value: s.key,
  label: s.label,
  kind: 'select' as const,
  icon: <Icon name={s.libIcon} />,
}));
const WAVEFORM_OPTIONS = COSMIC_WAVEFORMS.map((w) => ({
  value: w.key,
  label: w.label,
  kind: 'select' as const,
  icon: <Icon name={w.libIcon} />,
}));

/**
 * Source / waveform selection, bridged to the live CosmicLFO through the `cosmic`
 * EngineContext surface. The select drives `setSource`/`setWaveform` (which change
 * the actual sound), and re-reads on the surface's change subscription so it tracks the
 * legacy chrome, a dimension switch, or world-data seeding. The pick is also applied
 * optimistically so the UI is instant. Source/waveform are strings (not PM params), hence a
 * surface rather than `useParameter`.
 */
function useCosmicSource(axis: Axis): [string, (next: string) => void] {
  const cosmic = useEngineCosmic();
  const [value, setValue] = useState<string>(() => cosmic.getSource(axis));
  useEffect(() => {
    const read = () => setValue(cosmic.getSource(axis));
    read();
    return cosmic.subscribe(read);
  }, [cosmic, axis]);
  const select = useCallback(
    (next: string) => {
      cosmic.setSource(axis, next);
      setValue(next);
    },
    [cosmic, axis],
  );
  return [value, select];
}

function useCosmicWaveform(axis: Axis): [string, (next: string) => void] {
  const cosmic = useEngineCosmic();
  const [value, setValue] = useState<string>(() => cosmic.getWaveform(axis));
  useEffect(() => {
    const read = () => setValue(cosmic.getWaveform(axis));
    read();
    return cosmic.subscribe(read);
  }, [cosmic, axis]);
  const select = useCallback(
    (next: string) => {
      cosmic.setWaveform(axis, next);
      setValue(next);
    },
    [cosmic, axis],
  );
  return [value, select];
}

/** Cosmic enable (on/off) for the axis' active dimension, via the `cosmic` surface. */
function useCosmicEnabled(axis: Axis): [boolean, (on: boolean) => void] {
  const cosmic = useEngineCosmic();
  const [enabled, setEnabled] = useState<boolean>(() => cosmic.isEnabled(axis));
  useEffect(() => {
    const read = () => setEnabled(cosmic.isEnabled(axis));
    read();
    return cosmic.subscribe(read);
  }, [cosmic, axis]);
  const toggle = useCallback(
    (on: boolean) => {
      cosmic.setEnabled(axis, on);
      setEnabled(on);
    },
    [cosmic, axis],
  );
  return [enabled, toggle];
}

/**
 * Glyph selector built from the lib `ActionButtonGroup` — the SAME normalized dropdown
 * the header info/more buttons use (Bruna: match the "More" button style), NOT a bespoke
 * Select. `showSelectedAsIcon` keeps the chosen glyph in the trigger; the menu opens
 * upward (`placement="top"`) since the cosmic stack sits low on screen. Shown un-dimmed
 * (no `NotWired`) to match the header dropdowns; audio wiring is still deferred.
 */
function GlyphSelect({
  value,
  onChange,
  options,
  ariaLabel,
  midiComponentId,
}: {
  value: string;
  onChange: (next: string) => void;
  options: typeof SOURCE_OPTIONS | typeof WAVEFORM_OPTIONS;
  ariaLabel: string;
  /** Legacy scoped MIDI key (e.g. `${axis}.waveform`); enables single-CC stepped-select MIDI. */
  midiComponentId?: string;
}) {
  // The cycle ActionButtonGroup has no per-OPTION DOM target, so its single trigger is the
  // one learn target. A learned CC steps across the options by value → index (deduped per index),
  // firing the SAME `onChange` as a menu pick so MIDI and the menu converge on the live CosmicLFO.
  const portalContainer = usePortalContainer();
  const { triggerProps } = useStepSelect({
    componentId: midiComponentId,
    count: options.length,
    // Defensive: the dispatcher clamps to its registration-time count, which equals
    // `options.length` here — but guard against a one-render skew if a select ever gets a
    // DYNAMIC option list (a shorter list + a stale higher index would otherwise throw on `.value`).
    onSelectIndex: (index) => {
      const option = options[index];
      if (option) onChange(option.value);
    },
  });
  return (
    <div className="orbiters-react-ui__cosmic-glyph">
      <ActionButtonGroup
        options={options}
        value={value}
        showSelectedAsIcon
        placement="top"
        align="center"
        aria-label={ariaLabel}
        onChange={onChange}
        triggerProps={triggerProps}
        container={portalContainer}
      />
    </div>
  );
}

/** Amplitude (Depth) → `${axis}-cosmic-amplitude` (0..1). PM-wired; audio read is deferred. */
function DepthKnob({ axis }: { axis: Axis }) {
  return (
    <div className="orbiters-react-ui__cosmic-cell">
      <ParameterizedKnob
        rootParam={`${axis}-cosmic-amplitude`}
        min={0}
        max={1}
        step={0.01}
        sensitivity={0.15}
        aria-label={`${axis} cosmic depth`}
        midi={{ componentId: `${axis}CosmicAmplitudeKnob` }}
      />
      <span className="orbiters-react-ui__cosmic-label">Depth</span>
    </div>
  );
}

/** MANUAL-mode frequency knob — the "extra knob" shown ONLY when the source is `manual`
    (legacy `${axis}CosmicManualKnob`). Continuous, log-scaled `${axis}-cosmic-frequency`. */
function ManualFrequencyKnob({ axis }: { axis: Axis }) {
  return (
    <div className="orbiters-react-ui__cosmic-cell">
      <ParameterizedKnob
        rootParam={`${axis}-cosmic-frequency`}
        min={COSMIC_FREQ_MIN}
        max={COSMIC_FREQ_MAX}
        step={0.001}
        log
        sensitivity={0.15}
        aria-label={`${axis} manual cosmic frequency`}
        midi={{ componentId: `${axis}CosmicManualKnob` }}
      />
      <span className="orbiters-react-ui__cosmic-label">Freq</span>
    </div>
  );
}

/** DISCRETE-mode ×0.5 / ×2 frequency multipliers (legacy `${axis}Cosmic1`/`Cosmic2`,
    `.freq-multiplier-btn-lfo`). The kick Switch renders the ◄ ► triangles natively. Shown
    opaque (no `NotWired` dim); audio wiring still deferred. */
function CosmicMultipliers({ axis }: { axis: Axis }) {
  // A kick is a momentary ACTION — apply the ×0.5 / ×2 frequency multiplier on the
  // per-axis CosmicLFO (legacy labels `${axis}Cosmic1`/`Cosmic2`). Click and inbound MIDI both arrive
  // here via ParameterizedKick's single `onTrigger`; multi-focus broadcast lives in the cosmic facade.
  const cosmic = useEngineCosmic();
  const onMultiplier = useCallback(
    (kind: 'half' | 'double') => {
      const label = kind === 'half' ? `${axis}Cosmic1` : `${axis}Cosmic2`;
      cosmic.triggerKick(axis, label);
    },
    [cosmic, axis],
  );
  // Kick idle = brilliant orbiter primary; the press flashes a brighter tint then settles.
  // Kept live across theme edits (see the canvas-widget note in `parameters`).
  const [c1] = useOrbiterColors();
  return (
    <div className="orbiters-react-ui__cosmic-multipliers">
      {/* D1: the kick's scoped MIDI identity is the LEGACY component key (via
          `cosmicKickComponentId`) so metadata resolves — letting the learn go LAYERED,
          `_clearLegacyWidgetMappingsForComponent` drop the stale WAC `${axis}Cosmic1/2`
          mapping, and inheritance bind. The previous `${axis}.cosmic-kick-1/2` had no
          metadata entry → all three no-op'd. Element-id fallback stays as a net. */}
      <ParameterizedKick
        componentId={cosmicKickComponentId(axis, 'half')}
        onTrigger={() => onMultiplier('half')}
        direction="left"
        colors={kickColors(c1)}
        aria-label={`${axis} frequency ×0.5`}
      />
      <ParameterizedKick
        componentId={cosmicKickComponentId(axis, 'double')}
        onTrigger={() => onMultiplier('double')}
        direction="right"
        colors={kickColors(c1)}
        aria-label={`${axis} frequency ×2`}
      />
    </div>
  );
}

/** Cosmic enable (hexagon) — the per-axis `${axis}CosmicLFO` radio (`.xyz-cosmic-lfo`).
    The SAME shared control as the Sensors panel toggle, with a `cX/cY/cZ` label. Wired to the
    `cosmic` surface (CosmicLFO.start/stop on the active dimension). */
function CosmicEnableToggle({ axis }: { axis: Axis }) {
  const [enabled, setEnabled] = useCosmicEnabled(axis);
  // Make the hexagon MIDI-mappable. componentId is the LEGACY cosmic-enable key
  // (`${axis}.cosmic-toggle`, uiId `${axis}CosmicLFO`) so metadata resolves → the learn goes
  // layered (it is DIMENSION-scoped, per-axis-per-dim), `_clearLegacyWidgetMappingsForComponent`
  // drops the stale WAC mapping, and inheritance binds. A MIDI press (rising edge) FLIPS the enable
  // via the SAME `setEnabled` as a click, so MIDI and the hexagon converge on CosmicLFO.start/stop.
  const { midiProps } = useToggle({ componentId: `${axis}.cosmic-toggle`, value: enabled, onToggle: setEnabled });
  return (
    <AxisEnableToggle
      label={`c${axis.toUpperCase()}`}
      aria-label={`${axis} cosmic LFO enable`}
      value={enabled}
      onToggle={setEnabled}
      midiProps={midiProps}
    />
  );
}

/**
 * The per-axis cosmic-LFO stack, rendered inside `XYZControls`' axis column when the
 * COSMIC_LFO panel is active. The column is bottom-anchored (`.orbiters-react-ui__xyz`),
 * so adding this stack grows the column UPWARD: the axis knob + value rise, the cosmic
 * controls fill below them, the hexagon enable toggle sits at the bottom.
 *
 * The selected SOURCE owns the panel's two modes: `manual` → continuous frequency knob,
 * any discrete source → ×0.5/×2 multipliers (the single fork the whole panel pivots on).
 */
export function CosmicAxisStack({ axis }: { axis: Axis }) {
  const [waveform, setWaveform] = useCosmicWaveform(axis);
  const [source, setSource] = useCosmicSource(axis);
  const { isMobile } = useNavViewportState();
  const manual = isManualSource(source);

  return (
    <div className="orbiters-react-ui__cosmic-stack" data-axis={axis}>
      <DepthKnob axis={axis} />

      {/* Matching the legacy reduced-screen layout (Bruna): the waveform + modulation-source
          glyphs sit SIDE-BY-SIDE rather than stacked, so the stack reclaims a row of vertical space —
          letting the Depth knob stay legible on short viewports instead of shrinking to nothing. */}
      <div className="orbiters-react-ui__cosmic-glyphs">
        {/* Waveform glyph — single-CC stepped-select MIDI under the legacy `${axis}.waveform` key. */}
        <GlyphSelect
          value={waveform}
          onChange={setWaveform}
          options={WAVEFORM_OPTIONS}
          ariaLabel={`${axis} waveform`}
          midiComponentId={`${axis}.waveform`}
        />

        {/* Modulation source glyph — the pivot that selects the mode below. Single-CC stepped-select
            MIDI under the legacy `${axis}.exo-source` key (uiId `${axis}-exo-lfo-dropdown`). */}
        <GlyphSelect
          value={source}
          onChange={setSource}
          options={SOURCE_OPTIONS}
          ariaLabel={`${axis} modulation source`}
          midiComponentId={`${axis}.exo-source`}
        />
      </div>

      {/* SOURCE-DRIVEN MODE: manual → extra continuous frequency knob; discrete →
          ×0.5/×2 multipliers. This is the centralised two-part logic the legacy spread
          across PanelManager + CosmicLFO DOM toggling. The slot has a CONSTANT height
          (sized for the taller knob+label) so every column lines up whether it shows a
          knob or the multipliers — fixing the legacy mixed-mode misalignment. */}
      <div className="orbiters-react-ui__cosmic-mode-slot">
        {manual ? <ManualFrequencyKnob axis={axis} /> : <CosmicMultipliers axis={axis} />}
      </div>

      {/* Read-only frequency monitor — the legacy `cosmic-lfo-${axis}-freq` ƒ readout;
          mirrors `${axis}-cosmic-frequency` (effective LFO frequency). */}
      <ParameterizedParam
        rootParam={`${axis}-cosmic-frequency`}
        label="ƒ"
        precision={isMobile ? 3 : 4}
        readOnly
        bidirectional
        aria-label={`${axis} cosmic frequency monitor`}
      />

      {/* Cosmic enable (hexagon) — `${axis}CosmicLFO` radio. Visual; audio wiring TODO. */}
      <CosmicEnableToggle axis={axis} />
    </div>
  );
}
