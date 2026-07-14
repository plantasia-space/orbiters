/**
 * NumericKeyboardProvider + useNumericKeyboard — now a THIN ADAPTER over the shared
 * design-lib keypad (the presentation + a generic provider were promoted into
 * `plantasia.space-design`, so orbiters and entangled-worlds render the SAME keypad — one source of
 * truth). This module keeps only the orbiters-specific glue the lib provider deliberately does NOT
 * own: the grid-tied duration presets (resolved from the engine's track tempo) and the per-voice
 * themed portal container. Both are injected into each `open()` request; call sites are unchanged.
 */
import { useMemo, type ReactNode } from 'react';
import {
  NumericKeyboardProvider as LibNumericKeyboardProvider,
  useNumericKeyboard as useLibNumericKeyboard,
  type NumericKeyboardRequest as LibNumericKeyboardRequest,
  type NumericSubmitDetail,
  type DurationGridPreset,
} from 'plantasia.space-design/react';
import { usePortalContainer } from '../../ui/react/PortalContainerProvider';
import { useEngineWaveformDataOptional } from '../engine/EngineContext';
import type { EngineWaveformData } from '../engine/engineTypes';
import { LOOP_SIZES } from '../../ui/react/regions/useLoopControls';

export type { NumericSubmitDetail };

/** Resolve the SAME loop-size preset vocabulary (`LOOP_SIZES`) to ms — reuses
 *  the loop-preset interface's logic rather than inventing a second timing-preset vocabulary,
 *  INCLUDING its BPM source (`getTrackBpm()`, the track's native tempo — the same one
 *  `useLoopControls.ts`'s `beatSec()` reads), so the same preset label means the same real
 *  duration in both surfaces. Empty when the track has no BPM yet — the keypad simply shows no
 *  preset row then. */
function computeGridPresets(data: EngineWaveformData): DurationGridPreset[] {
  const bpm = data.getTrackBpm();
  if (!(typeof bpm === 'number' && bpm > 0)) return [];
  const msPerBeat = 60000 / bpm;
  return LOOP_SIZES.map(({ beats, label }) => ({ label, ms: beats * msPerBeat }));
}

/** The orbiters-facing request — the lib request minus the fields this adapter injects
 *  (`gridPresets` from the engine tempo, `container` from the per-voice portal scope). */
export type NumericKeyboardRequest = Omit<LibNumericKeyboardRequest, 'gridPresets' | 'container'>;

export interface NumericKeyboardApi {
  open: (request: NumericKeyboardRequest) => void;
}

/** Mount ONE shared keypad for the React shell — the design-lib provider renders the single Dialog +
 *  keypad instance and remembers the last ramp duration across opens. The shell's themed portal
 *  scope is passed as the provider-level DEFAULT container, so controls that open the keypad
 *  internally (the lib's pre-wired value slider in the edit rows) land in the orbiter-themed scope
 *  too; the per-open injection below still overrides it with a per-voice scope where one applies. */
export function NumericKeyboardProvider({ children }: { children: ReactNode }) {
  const portalContainer = usePortalContainer();
  return (
    <LibNumericKeyboardProvider container={portalContainer ?? undefined}>
      {children}
    </LibNumericKeyboardProvider>
  );
}

/** Open the shared keypad, injecting the orbiters-specific grid presets + per-voice portal container.
 *  Snapshotted at OPEN (same convention `useParameter`'s `captureBinding` uses): the track's native
 *  tempo essentially never changes while the keypad is open, and the container is this voice's scope. */
export function useNumericKeyboard(): NumericKeyboardApi {
  const lib = useLibNumericKeyboard();
  // Nullable so a control rendered outside <EngineProvider> still gets a keypad (just no grid
  // presets) rather than throwing — preserving the original no-throw contract.
  const waveform = useEngineWaveformDataOptional();
  // Portal the keypad into THIS voice's orbiter-themed container so its numerals/surface read the
  // orbiter theme, not the host page's (the feed realm's root/user theme).
  const portalContainer = usePortalContainer();
  return useMemo<NumericKeyboardApi>(
    () => ({
      open: (req) =>
        lib.open({
          ...req,
          container: portalContainer ?? undefined,
          gridPresets: req.interpolate && waveform ? computeGridPresets(waveform) : undefined,
        }),
    }),
    [lib, waveform, portalContainer],
  );
}
