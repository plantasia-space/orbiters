/**
 * @file src/ui/react/regions/SyncSettingsMenu.tsx
 * @description The settings submenu next to the SYNC control (header sync-row). A lucide `Settings2`
 * icon opens a design-lib `Popover` of sync-adjacent settings:
 *
 *   - Manual audio offset (ms) — per-DEVICE by-ear output-latency calibration (arrow Slider + Param).
 *   - Metronome — THIS PLAYER's own local monitor click while it plays (design-lib Switch);
 *     per-player flags, so several players can click at once, each at its own meter and tempo.
 *   - Meter — the per-TRACK time signature, saved/loaded like the track tempo; drives the metronome
 *     subdivision and launch bar (design-lib arrow Params).
 *
 * Controls are the design library; values bind to their owners: the offset + metronome to their plain
 * per-device stores (via `useSyncExternalStore` over their change events); the meter belongs to THIS
 * TILE's own voice/track — read via the per-voice engine context (`getMeterId`/`subscribeMeterChange`,
 * WrapGridState-backed) and written via `setTrackMeterLiveFromUi`/`commitTrackMeterFromUi`, which are
 * always local to this voice (meter is never shared, even between synced voices — see `trackSettingsCommit.js`).
 */
import { useSyncExternalStore, useCallback, useEffect, useState } from 'react';
import {
  CornerButton,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Switch,
} from 'plantasia.space-design/react';
import { QuantizeMenu } from 'plantasia.space-design/react/timeline/components/quantize-menu';
import { QUANTIZE_PRESETS, quantizeStepBeats } from 'plantasia.space-design/react/timeline/quantize';
import { ValueParam, ValueSlider } from 'plantasia.space-design/react/arrow';
import { Settings2, Metronome, Music4, CookingPot } from 'lucide-react';
import {
  MAX_ABS_OFFSET_MS,
  AUDIO_OFFSET_CHANGED_EVENT,
  getManualAudioOffsetMs,
  setManualAudioOffsetMs,
} from '../../../config/audioOffset.js';
import {
  isMetronomeEnabled,
  setMetronomeEnabled,
  METRONOME_CHANGED_EVENT,
} from '../../../config/metronome.js';
import {
  DEFAULT_METER_ID,
  MAX_METER_NUMERATOR,
  VALID_METER_DENOMINATORS,
  formatMeterId,
  parseMeter,
} from '../../../sync/meter.js';
import { setTrackMeterLiveFromUi, commitTrackMeterFromUi } from '../../../sync/trackSettingsCommit.js';
import { useEngineWaveformData, useEngineVoiceId } from '../../../react/engine/EngineContext';
import { getT } from '../../../i18n/index.js';
import { usePortalContainer } from '../PortalContainerProvider';
import { useNavViewportState } from './useNavViewportState';
import { deckFor } from '../../../voice/Deck.js';
import { broadcastAction } from '../../../multi/multiFocusBroadcast.js';
import type { QuantizeGridId } from 'plantasia.space-design/react/timeline/quantize';

function subscribeWindow(eventName: string) {
  return (onChange: () => void): (() => void) => {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener(eventName, onChange);
    return () => window.removeEventListener(eventName, onChange);
  };
}

const subscribeOffset = subscribeWindow(AUDIO_OFFSET_CHANGED_EVENT);
const subscribeMetronome = subscribeWindow(METRONOME_CHANGED_EVENT);
const LAUNCH_BAR_UNITS = 1;
const LAUNCH_GRID_LABEL = 'Launch grid';

function launchGridIdForBars(bars: number): QuantizeGridId {
  if (!(bars > 0)) return 'none';
  let best: QuantizeGridId = '1bar';
  let bestErr = Number.POSITIVE_INFINITY;
  for (const p of QUANTIZE_PRESETS) {
    const quantizedBars = quantizeStepBeats(p.id, LAUNCH_BAR_UNITS);
    if (quantizedBars == null) continue;
    const err = Math.abs(quantizedBars - bars);
    if (err < bestErr) {
      bestErr = err;
      best = p.id;
    }
  }
  return best;
}

/** The live per-device manual audio offset (ms). */
function useManualAudioOffsetMs(): number {
  return useSyncExternalStore(subscribeOffset, getManualAudioOffsetMs, () => 0);
}

/** The live metronome on/off state for THIS tile's own player — metronome flags are per-player
 *  (one, the other, or both players can click at once); single-orbiter uses the null slot. */
function useMetronomeEnabled(voiceId: string | null): boolean {
  return useSyncExternalStore(
    subscribeMetronome,
    () => isMetronomeEnabled(voiceId),
    () => false,
  );
}

/** This TILE's own per-track meter id (meter is always per-voice, never shared) — via the per-voice
 *  engine context, WrapGridState-backed. */
function useMeterId(data: ReturnType<typeof useEngineWaveformData>): string {
  return useSyncExternalStore(
    (onChange) => data.subscribeMeterChange(onChange),
    () => data.getMeterId() ?? DEFAULT_METER_ID,
    () => DEFAULT_METER_ID,
  );
}

// The denominator field's raw value IS the real denominator (1/2/4/8/16/32) — typing "4" must SET 4.
// (A prior version used an INDEX into VALID_METER_DENOMINATORS as the raw value with a `format` to
// display the real number; Param's direct-entry path writes back the typed literal as the RAW value,
// bypassing `format` entirely — so typing "4" set index 4, i.e. denominator 16. `format` in this
// component is display-only everywhere else in the codebase; nothing inverts it for typed input.)
//
// `step` is FIXED at 1 (not scaled to the current value) so Param's OWN internal step-grid snap
// (`Math.round((v-min)/step)*step+min`) is a true no-op for any integer input — a dynamic step tied
// to the current denominator was tried first and rejected: with `min=1` fixed, a large step (e.g. 8
// at denominator 16) skews the grid far from where a typed literal actually sits, so typing "4"
// while at 16 resolved to 1, not 4 (caught in review before ship). With step=1 that corruption can't
// happen, so typed/dragged values always reach `resolveDenominatorInput` undistorted.
// Arrow keys/wheel now always nudge by EXACTLY `current ± 1` (never a different magnitude), which is
// the one signal we can rely on to mean "move one entry" rather than "set this literal value" — so
// `resolveDenominatorInput` reads an exact ±1 delta as a step through the geometric sequence
// (4→8→16…) and treats every other delta (typed entry, drag, page-step) as the literal target,
// snapped to the nearest valid power of two.
const MIN_METER_DENOMINATOR = VALID_METER_DENOMINATORS[0];
const MAX_METER_DENOMINATOR = VALID_METER_DENOMINATORS[VALID_METER_DENOMINATORS.length - 1];
const MAX_DENOMINATOR_POWER = VALID_METER_DENOMINATORS.length - 1; // values are 2^0 .. 2^MAX_DENOMINATOR_POWER

export function snapToValidDenominator(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return MIN_METER_DENOMINATOR;
  const power = Math.max(0, Math.min(MAX_DENOMINATOR_POWER, Math.round(Math.log2(n))));
  return 2 ** power;
}

/** Move exactly one entry up/down the valid power-of-two sequence from `current`. */
function stepValidDenominator(current: number, direction: 1 | -1): number {
  const idx = VALID_METER_DENOMINATORS.indexOf(snapToValidDenominator(current));
  const next = Math.max(0, Math.min(VALID_METER_DENOMINATORS.length - 1, idx + direction));
  return VALID_METER_DENOMINATORS[next];
}

/** Resolve Param's raw callback value against the denominator it started from — see the block
 * comment above `MIN_METER_DENOMINATOR` for why the exact-±1 check is the nudge/literal signal. */
export function resolveDenominatorInput(raw: number, current: number): number {
  const delta = Number(raw) - Number(current);
  if (delta === 1) return stepValidDenominator(current, 1);
  if (delta === -1) return stepValidDenominator(current, -1);
  return snapToValidDenominator(raw);
}

function clampNumerator(value: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(MAX_METER_NUMERATOR, n));
}

export function SyncSettingsMenu() {
  const t = getT();
  const voiceId = useEngineVoiceId();
  const data = useEngineWaveformData();
  const offsetMs = useManualAudioOffsetMs();
  const metronomeOn = useMetronomeEnabled(voiceId);
  const meterId = useMeterId(data);
  const meter = parseMeter(meterId);
  const portalContainer = usePortalContainer();
  const { isMobile } = useNavViewportState();
  const [launchGridId, setLaunchGridId] = useState<QuantizeGridId>(
    () => launchGridIdForBars(deckFor(voiceId)?.launchGridBars ?? 0),
  );

  const onOffsetLive = useCallback((v: number) => setManualAudioOffsetMs(v, { persist: false }), []);
  const onOffsetCommit = useCallback((v: number) => setManualAudioOffsetMs(v), []);
  const setMeterLive = useCallback((numerator: number, denominator: number) => {
    setTrackMeterLiveFromUi(formatMeterId({
      numerator: clampNumerator(numerator),
      denominator: snapToValidDenominator(denominator),
    }), voiceId);
  }, [voiceId]);
  const commitMeter = useCallback((numerator: number, denominator: number) => {
    commitTrackMeterFromUi(formatMeterId({
      numerator: clampNumerator(numerator),
      denominator: snapToValidDenominator(denominator),
    }), voiceId);
  }, [voiceId]);
  useEffect(() => {
    const deck = deckFor(voiceId);
    if (!deck) return undefined;
    setLaunchGridId(launchGridIdForBars(deck.launchGridBars));
    return deck.onChange((_snapshot: unknown, reason: string) => {
      if (reason === 'launch-grid') setLaunchGridId(launchGridIdForBars(deck.launchGridBars));
    });
  }, [voiceId]);
  const onLaunchGridChange = useCallback((id: QuantizeGridId) => {
    const bars = quantizeStepBeats(id, LAUNCH_BAR_UNITS);
    const value = bars == null ? 0 : bars;
    deckFor(voiceId)?.setLaunchGridBars(value);
    broadcastAction(voiceId, 'deck', 'setLaunchGridBars', [value]);
  }, [voiceId]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <CornerButton kind="kick" icon={<Settings2 />} aria-label={t('sync.menu.settings')} dropIndicator="down" />
      </PopoverTrigger>
      {/* Portals into the per-voice orbiter container (`container` below), which carries `.dark` + the
          orbiter tokens. The explicit `dark` class stays only as a fallback for the pre-mount case
          where the container isn't ready and Radix falls back to <body>. */}
      <PopoverContent
        align={isMobile ? 'center' : 'start'}
        side="bottom"
        className="dark orbiters-react-ui__sync-settings"
        container={portalContainer ?? undefined}
        // The offset value box opens the on-screen keypad — a dialog portalled OUTSIDE this
        // popover. Without these guards the non-modal popover treats the keypad (focus +
        // pointer) as an outside interaction and closes underneath it; keep it open so the
        // menu is still there when the entry is confirmed or cancelled.
        onFocusOutside={(e) => {
          if ((e.target as HTMLElement | null)?.closest?.('.ps-numkbd-dialog')) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          const el = e.target as HTMLElement | null;
          if (el?.closest?.('.ps-numkbd-dialog, [data-slot="dialog-overlay"]')) e.preventDefault();
        }}
      >
        <div className="orbiters-react-ui__sync-settings-block">
          <span className="orbiters-react-ui__sync-settings-rowlabel">{t('sync.menu.offset.label')}</span>
          <p className="orbiters-react-ui__sync-settings-hint">{t('sync.menu.offset.hint')}</p>
          {/* The shared pre-wired slider + value box pair — tapping the value box opens the
              on-screen keypad (desktop and mobile alike), same as every other value box. */}
          <ValueSlider
            className="orbiters-react-ui__sync-settings-offset-row"
            label={t('sync.menu.offset.label')}
            value={offsetMs}
            min={-MAX_ABS_OFFSET_MS}
            max={MAX_ABS_OFFSET_MS}
            step={1}
            precision={0}
            onValueChange={onOffsetLive}
            onValueCommit={onOffsetCommit}
          />
        </div>

        <div className="orbiters-react-ui__sync-settings-row">
          <Metronome size={15} aria-hidden="true" />
          <span className="orbiters-react-ui__sync-settings-rowlabel">{t('sync.menu.metronome')}</span>
          <Switch
            checked={metronomeOn}
            onCheckedChange={(on: boolean) => setMetronomeEnabled(on, voiceId)}
            aria-label={t('sync.menu.metronome')}
          />
        </div>

        <div className="orbiters-react-ui__sync-settings-row">
          <Music4 size={15} aria-hidden="true" />
          <span className="orbiters-react-ui__sync-settings-rowlabel">{t('sync.menu.meter.label')}</span>
          <div className="orbiters-react-ui__meter-fields" aria-label={t('sync.menu.meter.aria')}>
            <ValueParam
              label={t('sync.menu.meter.numerator')}
              value={meter.numerator}
              min={1}
              max={MAX_METER_NUMERATOR}
              step={1}
              precision={0}
              onValueChange={(v: number) => setMeterLive(v, meter.denominator)}
              onValueCommit={(v: number) => commitMeter(v, meter.denominator)}
            />
            <span className="orbiters-react-ui__meter-slash">/</span>
            <ValueParam
              label={t('sync.menu.meter.denominator')}
              value={meter.denominator}
              min={MIN_METER_DENOMINATOR}
              max={MAX_METER_DENOMINATOR}
              step={1}
              precision={0}
              onValueChange={(v: number) => setMeterLive(meter.numerator, resolveDenominatorInput(v, meter.denominator))}
              onValueCommit={(v: number) => commitMeter(meter.numerator, resolveDenominatorInput(v, meter.denominator))}
            />
          </div>
        </div>

        {isMobile && (
          <div className="orbiters-react-ui__sync-settings-row">
            <CookingPot size={15} aria-hidden="true" />
            <span className="orbiters-react-ui__sync-settings-rowlabel">{LAUNCH_GRID_LABEL}</span>
            <QuantizeMenu
              value={launchGridId}
              onValueChange={onLaunchGridChange}
              heading={LAUNCH_GRID_LABEL}
              aria-label={LAUNCH_GRID_LABEL}
              variant="ghost"
              container={portalContainer}
            />
          </div>
        )}

      </PopoverContent>
    </Popover>
  );
}
