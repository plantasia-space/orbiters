/**
 * Parameterized* — orbiters wrappers that bind a library `arrow` control to a
 * routed parameter via {@link useParameter}.
 *
 * Each wrapper = `useParameter` + the pure control. The library stays presentation;
 * orbiters owns the wiring. Defaults match the WAC priorities the controls replace
 * (`PRIORITY_MAP`) so contention behaviour is unchanged.
 *
 * Intent split:
 *   - Knob / Slider: live-on-drag + commit-on-release (commit fires even when the
 *     stepped value didn't move — `commitIfUnchanged`).
 *   - Param: stays LIVE — wheel/keys/drag are live; `onValueCommit` only fires on an
 *     explicit text entry. We do NOT force it into the release-commit model.
 *   - Switch: a discrete change IS the commit. `kick`'s momentary `onTrigger` is app
 *     behaviour (wired app-side in slice 3), passed straight through here.
 */
import * as React from 'react';
import { Knob, Slider, Param, Switch } from 'plantasia.space-design/react/arrow';
import { getPriority } from '../../config/Constants.js';
import { useParameter, useTrigger, type MidiBinding } from './useParameter';
import { useEngine } from '../engine/EngineContext';
import { useNumericKeyboard } from '../numeric-keyboard/NumericKeyboardProvider';

type Bind = {
  /** The routed parameter name (e.g. an axis: "x" | "y" | "z"). */
  rootParam: string;
  /** Override the contention priority (defaults to the replaced WAC control's). */
  priority?: number;
  /** When false, the control is write-only (display does not follow external writes). */
  bidirectional?: boolean;
  /** When set, the control is a scoped MIDI-learn target (componentId must match
   *  the replaced WAC widget, e.g. "x.knob", for persisted mappings to carry over). */
  midi?: MidiBinding;
};

// The seam owns these props; consumers may not pass them through.
type Owned = 'value' | 'onValueChange' | 'onValueCommit' | 'locked';
type WrapProps<C extends React.ElementType> = Omit<React.ComponentProps<C>, Owned> & Bind;

/* ── Canvas-widget theming (knob / slider / switch) ──────────────────────────
   The lib's arrow Knob/Slider/Switch paint to a <canvas>, resolving each `colors`
   token by appending a probe <span> to `document.body` and reading its computed
   colour — then they only RE-READ when documentElement's `class` attribute mutates.

   Two consequences broke orbiter theming:
   1. The probe lives OUTSIDE `.orbiters-react-ui`, so the theme bridge's
      `--primary`/`--secondary` aliases (scoped to that class) never reach it —
      a `var(--primary)` token falls back to the lib default (white), not the
      orbiter colour.
   2. The orbiter palette lands as inline `--color1`/`--color2` on `:root`
      (`designManager.applyDesignSettings`), which mutates STYLE, not class — so
      the widgets' class-only MutationObserver never repaints on a theme edit.

   Fix both at the source: read `--color1`/`--color2` off `:root` ourselves (where
   they ARE set, regardless of the bridge scope) and re-read on the
   `orbiters:design-updated` event `designManager` fires, then feed the controls
   RESOLVED LITERALS. Passing literals changes the `colors` prop string on every
   theme edit, which is what forces the canvas to repaint.

   Knob slots:   [0] value arc + needle, [1] compass rose, [2] disc fill, [3..] unused.
   Slider slots: [0] value fill, [1] track, [2] handle fill, [3] handle stroke, [4] unused. */
const ORBITER_COLOR_FALLBACK: [string, string] = ['#ffffff', '#000000'];
const ORBITER_COLOR_FALLBACK_STR = `${ORBITER_COLOR_FALLBACK[0]};${ORBITER_COLOR_FALLBACK[1]}`;

/* ── Per-tile palette store ───────────────────────────────────────────────────
   Multi-orbiter: each tile's palette (`--color1`/`--color2`) lands on its OWN cell
   (`designManager` writes them to the voice's themeRoot), and the tile's React host
   (`orbiters-react-ui-root-<voiceId>`) is mounted INSIDE that cell — so reading the
   vars off the host resolves the tile's colours via the CSS cascade. Reading off
   `documentElement` (the old behaviour) saw only the single-orbiter / page-wide
   palette, so every multi tile's canvas widgets fell back to white/black.

   The store is keyed by voiceId so N tiles theme independently from ONE shared
   `orbiters:design-updated` listener: each entry re-reads its OWN host on the event
   (a sibling tile's edit re-reads to the same value → no spurious repaint). Single-
   orbiter (voiceId null) reads `documentElement` → byte-identical. */
type OrbiterColorEntry = { snapshot: string; subs: Set<() => void> };
const orbiterColorStore = new Map<string, OrbiterColorEntry>();
let orbiterColorListeners = 0;

/** The element whose computed `--color1`/`--color2` are this voice's palette: the tile's React host
 *  (inherits its cell's vars), or `documentElement` for single-orbiter / before the host mounts. */
function resolveColorRoot(voiceId: string | null): Element | null {
  if (typeof document === 'undefined') return null;
  if (voiceId) {
    const host = document.getElementById(`orbiters-react-ui-root-${voiceId}`);
    if (host) return host;
  }
  return document.documentElement;
}

function readColors(voiceId: string | null): string {
  const root = resolveColorRoot(voiceId);
  if (!root) return ORBITER_COLOR_FALLBACK_STR;
  const s = getComputedStyle(root);
  const c1 = s.getPropertyValue('--color1').trim() || ORBITER_COLOR_FALLBACK[0];
  const c2 = s.getPropertyValue('--color2').trim() || ORBITER_COLOR_FALLBACK[1];
  return `${c1};${c2}`;
}

/** Get-or-create the store entry for a voice (called only from `subscribe`, which has a paired
 *  cleanup that evicts the entry when its last subscriber leaves — so the Map never grows unbounded). */
function ensureEntry(voiceId: string | null): OrbiterColorEntry {
  const key = voiceId ?? '';
  let entry = orbiterColorStore.get(key);
  if (!entry) {
    entry = { snapshot: readColors(voiceId), subs: new Set() };
    orbiterColorStore.set(key, entry);
  }
  return entry;
}

/** Re-read every tracked tile's palette on a design edit; notify only the tiles whose colours changed. */
function refreshAllOrbiterColors() {
  orbiterColorStore.forEach((entry, key) => {
    const next = readColors(key || null);
    if (next !== entry.snapshot) {
      entry.snapshot = next;
      entry.subs.forEach((fn) => fn());
    }
  });
}

/** `[color1, color2]` of THIS tile's orbiter palette (Color A / Color B), kept live across theme edits
 *  via the shared `orbiters:design-updated` subscription. One document listener total; per-voice reads. */
export function useOrbiterColors(): [string, string] {
  const { voiceId } = useEngine();
  const subscribe = React.useCallback(
    (cb: () => void) => {
      const key = voiceId ?? '';
      const entry = ensureEntry(voiceId);
      if (orbiterColorListeners === 0 && typeof document !== 'undefined') {
        document.addEventListener('orbiters:design-updated', refreshAllOrbiterColors);
      }
      orbiterColorListeners += 1;
      entry.subs.add(cb);
      // Sync the current palette now that the host is mounted (it may not have been at first render).
      const next = readColors(voiceId);
      if (next !== entry.snapshot) {
        entry.snapshot = next;
        cb();
      }
      return () => {
        entry.subs.delete(cb);
        if (entry.subs.size === 0) orbiterColorStore.delete(key); // evict the tile's entry on last leave
        orbiterColorListeners -= 1;
        if (orbiterColorListeners === 0 && typeof document !== 'undefined') {
          document.removeEventListener('orbiters:design-updated', refreshAllOrbiterColors);
        }
      };
    },
    [voiceId],
  );
  // Pure read: return the live entry's snapshot, or the fallback string when no entry exists yet (before
  // subscribe seeds it). `subscribe` re-reads + notifies once mounted, so this converges without a
  // getComputedStyle side-effect during render.
  const getSnapshot = React.useCallback(
    () => orbiterColorStore.get(voiceId ?? '')?.snapshot ?? ORBITER_COLOR_FALLBACK_STR,
    [voiceId],
  );
  const snap = React.useSyncExternalStore(subscribe, getSnapshot, () => ORBITER_COLOR_FALLBACK_STR);
  const i = snap.indexOf(';');
  return [snap.slice(0, i), snap.slice(i + 1)];
}

/** Build the lib `colors` string for a knob / slider / switch from the live orbiter palette. ONE place
 *  so every canvas widget maps the orbiter colours the same way (no inline per-component strings). */
export const knobColors = (c1: string, c2: string) => `${c1};${c2};transparent;${c1};${c2}`;
export const sliderColors = (c1: string, c2: string) => `${c1};${c2};${c1};${c1};${c2}`;
/** Toggle switch: the orbiter primary for BOTH the off outline and the on fill (no muted `--input` grey). */
export const toggleColors = (c1: string) => `${c1};${c1}`;
/** Kick switch: the orbiter primary, then a lighter pressed state (50% mixed toward white). */
export const kickColors = (c1: string) => `${c1};color-mix(in srgb, ${c1} 50%, white)`;

export function ParameterizedKnob({ rootParam, priority, bidirectional, midi, ...props }: WrapProps<typeof Knob>) {
  const { value, locked, onLive, onCommit, gestureProps, midiProps } = useParameter(rootParam, {
    priority: priority ?? getPriority('webaudio-knob'),
    bidirectional,
    midi: midi && { min: props.min, max: props.max, ...midi, componentType: 'knob' },
  });
  const [c1, c2] = useOrbiterColors();
  return (
    <Knob
      colors={knobColors(c1, c2)}
      {...props}
      {...gestureProps}
      {...midiProps}
      value={value}
      locked={locked}
      onValueChange={onLive}
      onValueCommit={onCommit}
      commitIfUnchanged
    />
  );
}

export function ParameterizedSlider({ rootParam, priority, bidirectional, midi, ...props }: WrapProps<typeof Slider>) {
  const { value, locked, onLive, onCommit, gestureProps, midiProps } = useParameter(rootParam, {
    priority: priority ?? getPriority('webaudio-slider'),
    bidirectional,
    midi: midi && { min: props.min, max: props.max, ...midi, componentType: 'slider' },
  });
  const [c1, c2] = useOrbiterColors();
  return (
    <Slider
      colors={sliderColors(c1, c2)}
      {...props}
      {...gestureProps}
      {...midiProps}
      value={value}
      locked={locked}
      onValueChange={onLive}
      onValueCommit={onCommit}
      commitIfUnchanged
    />
  );
}

/** Numeric-keypad mode for a Param. `interpolated` offers the ramp-duration
 *  slider (WAC default); `value-only` is a plain entry; `false` opts out entirely. */
type KeyboardMode = 'interpolated' | 'value-only' | false;

export function ParameterizedParam({
  rootParam,
  priority,
  bidirectional,
  midi,
  keyboard = 'interpolated',
  onCommit: onCommitProp,
  ...props
}: WrapProps<typeof Param> & { keyboard?: KeyboardMode; onCommit?: (value: number) => void }) {
  // Param stays live: onValueChange (wheel/keys/drag) → live; onValueCommit (text
  // entry only) → commit. No commitIfUnchanged — there is no release-commit here.
  const { value, locked, onLive, onCommit, interpolateTo, captureBinding, gestureProps, midiProps } = useParameter(
    rootParam,
    {
      priority: priority ?? getPriority('webaudio-param'),
      bidirectional,
      midi: midi && { min: props.min, max: props.max, ...midi, componentType: 'param' },
    },
  );
  const keypad = useNumericKeyboard();

  // A click/tap (or Enter/Space) opens the shared on-screen keypad instead of
  // the lib's inline text editor — restoring numeric entry for users without a
  // physical keyboard. The lib gates this by `canAdjust`, so a readOnly/disabled/
  // locked Param (e.g. the cosmic ƒ monitor) never opens it. The confirmed entry runs
  // through `interpolateTo`, dimension-locked (immediate when duration is 0). The
  // axis×dim + start value are snapshotted at OPEN (captureBinding) so the ramp targets
  // exactly what the user was editing, even if a peer flips the active dimension while
  // the modal is open.
  const title =
    (typeof props['aria-label'] === 'string' && props['aria-label']) ||
    (typeof props.label === 'string' && props.label) ||
    rootParam;
  const onRequestEdit =
    keyboard === false
      ? undefined
      : () => {
          const binding = captureBinding();
          keypad.open({
            title,
            value: binding.value,
            min: props.min,
            max: props.max,
            // Prefer the control's step, else the parameter's registered step (systemic).
            step: props.step ?? binding.step,
            // Equilibrium (reset) value for the keypad's value slider: an explicit control
            // `defaultValue` prop wins, otherwise the parameter's registered equilibrium
            // (from ParameterManager) — so it's systemic, never hardcoded per control.
            defaultValue: props.defaultValue ?? binding.equilibrium,
            interpolate: keyboard === 'interpolated',
            onSubmit: ({ targetValue, interpolationDuration }) => {
              interpolateTo(targetValue, interpolationDuration, binding);
              // The on-screen keypad is the primary numeric-entry path (a click opens it instead of
              // the inline editor), so a consumer's commit callback must fire here too — not only via
              // onValueCommit (inline text entry). Without this, a keypad-entered value never commits
              // to the consumer (e.g. the track-BPM persistence) — the fix for a past save regression.
              onCommitProp?.(targetValue);
            },
          });
        };

  return (
    <Param
      {...props}
      {...gestureProps}
      {...midiProps}
      value={value}
      locked={locked}
      onValueChange={onLive}
      onValueCommit={(v) => {
        onCommit(v);
        onCommitProp?.(v);
      }}
      onRequestEdit={onRequestEdit}
    />
  );
}

export function ParameterizedSwitch({ rootParam, priority, bidirectional, midi, ...props }: WrapProps<typeof Switch>) {
  // A discrete switch change is a commit; no gesture freeze needed.
  const { value, locked, onCommit, midiProps } = useParameter(rootParam, {
    priority: priority ?? getPriority('webaudio-switch'),
    bidirectional,
    midi: midi && { min: props.min, max: props.max, ...midi, componentType: 'switch' },
  });
  return <Switch {...props} {...midiProps} value={value} locked={locked} onValueChange={onCommit} />;
}

/**
 * ParameterizedKick — a MOMENTARY kick switch. Unlike the value wrappers it
 * carries no `rootParam`: a kick is an action (×0.5 / ×2 frequency multiplier), so click
 * AND inbound MIDI both fire the single `onTrigger`. `componentId` is the scoped MIDI
 * identity — use the legacy component key so metadata resolves (e.g.
 * "x.frequency-multiplier-low"); MIDI registration is handled by {@link useTrigger}.
 */
type KickProps = Omit<
  React.ComponentProps<typeof Switch>,
  'kind' | 'onTrigger' | 'value' | 'onValueChange'
> & {
  componentId: string;
  onTrigger: () => void;
  /** Explicit DOM id; defaults to `pm-<componentId>`. */
  midiId?: string;
};

export function ParameterizedKick({ componentId, onTrigger, midiId, ...props }: KickProps) {
  const { midiProps } = useTrigger({ componentId, onTrigger, id: midiId });
  return <Switch kind="kick" {...props} {...midiProps} onTrigger={onTrigger} />;
}

export { useParameter, useTrigger, useTriggerGroup, useToggle, useStepSelect } from './useParameter';
export type {
  UseParameterOptions,
  UseParameterResult,
  MidiBinding,
  UseTriggerOptions,
  UseTriggerResult,
  TriggerGroupItem,
  UseToggleOptions,
  UseToggleResult,
  UseStepSelectOptions,
  UseStepSelectResult,
} from './useParameter';
