/**
 * useParameter — the orbiters React seam over ParameterManager.
 *
 * The library `arrow` controls are pure + controlled: they render the value and
 * emit `onValueChange` (live) / `onValueCommit` (commit). This hook is the wiring
 * the library deliberately leaves out: it subscribes a control to a routed
 * parameter, maps live/commit intents, mirrors lock state, and — critically —
 * keeps every write per-dimension.
 *
 * Dimension model (Option C; chosen over a per-dimension subscription
 * after the Codex adversarial review):
 *   - Subscribe ONCE with `dimensionId = null` so the DISPLAY follows the active
 *     dimension (ParameterManager only notifies a specific-dimension subscriber for
 *     that one dimension — it would hide every other axis).
 *   - WRITES target the dimension captured at gesture start, never "active now":
 *     during a pointer drag the active dimension can change, but the value must
 *     keep landing in the dimension the gesture began in.
 *   - While a pointer gesture owns the control, FREEZE the displayed value (ignore
 *     external param notifications). This is WAC's "isBidirectional = false during
 *     interaction" and it also neutralises the controlled-`value` clobber in the
 *     library Slider/Knob (latestValueRef is re-synced from the prop every render,
 *     so a mid-gesture external value would otherwise be committed on release).
 *
 * The hook owns no audio/MIDI logic — it is the thin seam between the pure control
 * and the injected engine boundary. Phase 0 (strategy §3): it reads the
 * ParameterManager + MIDIController exclusively through `EngineContext`
 * (`useEngineParams`/`useEngineMidi`) — no `Main.js` import, no `window.*`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEngineParams, useEngineMidi, useEngineVoiceId } from '../engine/EngineContext';
import type { ParamController, ScopedMidiBinding, WriteOptions } from '../engine/engineTypes';

const LIVE = 'live' as const;
const COMMIT = 'commit' as const;

/**
 * The DOM ids currently claimed by mounted MIDI-bound controls. The MIDI-learn
 * overlays key on `document.getElementById(id)`, so two controls sharing an id
 * would have the second silently shadow the first (the overlay would track the
 * wrong element). componentIds are intended to be unique (they mirror the WAC
 * widget ids), so a collision is a wiring bug — surface it loudly in dev instead
 * of registering a duplicate. Callers disambiguate via an explicit `midi.id`.
 */
const claimedMidiIds = new Set<string>();

/**
 * Scope a MIDI-target DOM id to its voice. In the multi-orbiter realm every tile renders the
 * SAME controls, so the same `componentId` mints the same `pm-<componentId>` id on every tile — and the
 * learn overlays + `document.getElementById` would resolve only the FIRST tile, cross-wiring voice 2's
 * binding to voice 1's element. Prefixing with the voiceId makes each tile's id unique. Single-orbiter
 * (voiceId null) returns the bare id → byte-identical. The DOM id is only the overlay / getElementById
 * handle; persisted MIDI mappings key on `componentId`, so scoping it does NOT change which CC mappings
 * a control inherits.
 */
function scopeMidiId(baseId: string, voiceId: string | null): string {
  return voiceId ? `${voiceId}-${baseId}` : baseId;
}

/**
 * Identity that maps the control to a scoped MIDI binding
 * (`layered:<componentId>|<stack>|<dimension>`). `componentId` MUST match the WAC
 * widget being replaced (e.g. "x.knob") so persisted MIDI mappings carry over.
 * `componentType`/`min`/`max` are normally filled by the `Parameterized*` wrapper.
 */
export interface MidiBinding {
  componentId: string;
  /** DIMENSION = per-dimension layered key (default); GLOBAL = unscoped. */
  scope?: 'DIMENSION' | 'GLOBAL';
  /** Control kind, for inbound value coercion (wrapper-supplied). */
  componentType?: 'knob' | 'slider' | 'param' | 'switch';
  /** Param range, for inbound MIDI scaling (wrapper-supplied from the control). */
  min?: number;
  max?: number;
  /** Explicit DOM id; defaults to a stable id derived from `componentId`. */
  id?: string;
}

export interface UseParameterOptions {
  /** Contention priority (lower wins). Defaults per-control via the wrappers. */
  priority?: number;
  /**
   * When false, external (non-gesture) parameter changes are not reflected in the
   * displayed value — a write-only control. Defaults true (display follows the
   * active dimension), matching the bidirectional axis knobs.
   */
  bidirectional?: boolean;
  /** When set, the control is registered as a scoped MIDI-learn target (slice 2). */
  midi?: MidiBinding;
}

export interface UseParameterResult {
  value: number;
  locked: boolean;
  /** Pass to the control's `onValueChange` (fires on every step during a gesture). */
  onLive: (value: number) => void;
  /** Pass to the control's `onValueCommit` (fires once at the end of a gesture). */
  onCommit: (value: number) => void;
  /**
   * Ramp to `target` over `durationMs`, locked to a dimension (numeric keyboard).
   * Pass `binding` (from {@link captureBinding} at keyboard-open) to lock the ramp to the
   * axis×dim + start value the user was editing; omit it to bind to the dimension active
   * at call time. `durationMs <= 0` is a plain immediate commit. Each call replaces any
   * in-flight ramp on the same dimension; ramps on other dimensions run independently.
   */
  interpolateTo: (target: number, durationMs: number, binding?: { dim: string | null; value: number }) => void;
  /** Snapshot the current axis×dim + displayed value + the parameter's equilibrium
   *  (reset value) + step, all from ParameterManager — call at keyboard-open. */
  captureBinding: () => { dim: string | null; value: number; equilibrium?: number; step?: number };
  /**
   * Spread onto the control. Drives the per-dimension capture + display freeze from
   * the real pointer gesture (capture phase so it never clobbers the control's own
   * pointer handling).
   */
  gestureProps: { onPointerDownCapture: () => void };
  /**
   * Present only when `options.midi` is set: spread onto the control to stamp the
   * scoped `data-midi-*` attributes + the stable `id` the MIDI registry keys on.
   * Undefined otherwise (no MIDI coupling).
   */
  midiProps?: Record<string, string>;
}

export function useParameter(rootParam: string, options: UseParameterOptions = {}): UseParameterResult {
  const { priority = 100, bidirectional = true, midi } = options;

  // Phase 0 (strategy §3): the engine is INJECTED. The hook reads PM + MIDI only
  // through the context read-models — no Main.js import, no window.* access.
  const params = useEngineParams();
  const engineMidi = useEngineMidi();
  const voiceId = useEngineVoiceId();

  // Scoped MIDI binding. Only the two attributes the learn overlays need (a
  // positioned element + a stable id) live on the DOM; the scoped metadata travels
  // as a typed record (see the register effect).
  //
  // STABLE LOGICAL id (strategy §6): the id derives from `componentId`, NOT a
  // remount-churning `useId()`. So body-level learn overlays — keyed by DOM id +
  // rect — survive dimension-switch / panel remount instead of being orphaned.
  // One control per `componentId` in the shell; a caller mounting several with the
  // same id supplies `midi.id` explicitly (or scopes by dimension) to disambiguate.
  const midiId = midi ? scopeMidiId(midi.id ?? `pm-${midi.componentId}`, voiceId) : undefined;
  // Stable identity (it only depends on midiId) so consumers' memos/effects don't churn every render.
  const midiProps = useMemo(
    () => (midiId ? { id: midiId, 'data-automatable': 'true' } : undefined),
    [midiId],
  );

  const [value, setValue] = useState<number>(() => {
    const v = params.get(rootParam, null);
    return typeof v === 'number' ? v : 0;
  });
  const [locked, setLocked] = useState(false);

  // Gesture state — refs only, never triggers a render mid-drag.
  const gestureRef = useRef(false);
  const capturedDimRef = useRef<string | null>(null);
  const gestureGenRef = useRef(0);
  const removeGestureListenersRef = useRef<(() => void) | null>(null);
  const controllerRef = useRef<ParamController | null>(null);

  // In-flight keyboard interpolations, keyed by the dimension captured when each
  // started. A single axis control owns ONE hook instance but the user can
  // start an interpolation on dim 1, switch the active dimension, and start another
  // on dim 2 — both must run to completion against their OWN dimension. Keying by
  // dimension gives the 9 (3 axis × 3 dim) independent targets the bug demands and
  // makes "start on the same target" a replace (cancel-then-restart), never a leak.
  const SINGLE_DIM_KEY = '__single__';
  const interpRef = useRef<Map<string, number>>(new Map());
  const cancelInterp = useCallback((key: string) => {
    const raf = interpRef.current.get(key);
    if (raf != null) {
      cancelAnimationFrame(raf);
      interpRef.current.delete(key);
    }
  }, []);

  const activeDimOf = useCallback((): string | null => {
    const p = params.getParameter(rootParam);
    return p?.isMultidimensional ? p.activeDimensionId ?? null : null;
  }, [params, rootParam]);

  // Lock = all-param lock OR the ACTIVE dimension is locked. Queried straight from
  // ParameterManager each time so a pre-existing lock on any dimension is reflected
  // the moment that dimension becomes active (no stale tracked set).
  const recomputeLock = useCallback(() => {
    const activeDim = activeDimOf();
    const dimLocked = activeDim ? params.isDimensionLocked(rootParam, activeDim) : false;
    setLocked(params.isLocked(rootParam) || dimLocked);
  }, [params, rootParam, activeDimOf]);

  // Subscribe (null dimension → follow active dimension). Re-runs only if the
  // binding identity changes; unmount always unsubscribes (the top leak in this app).
  useEffect(() => {
    const controller: ParamController = {
      onParameterChanged(_name, v, _dimensionId, metadata) {
        // Lock state changes ONLY on an explicit lock event (onParameterLocked) or
        // when the ACTIVE dimension switches — never on a routine value tick (CosmicLFO
        // can push values ~30Hz across every subscriber). Recompute lock only on a
        // dimension change, and do it regardless of the gesture freeze so the lock
        // reflects the newly-active dimension. (Recomputing on every value notification
        // was both wasteful and, behind the gesture-freeze guard, missed mid-drag locks.)
        if ((metadata as { reason?: string } | undefined)?.reason === 'active-dimension-change') {
          recomputeLock();
        }
        // Freeze: while a gesture owns the control, the gesture is the source of truth.
        if (gestureRef.current) return;
        if (bidirectional) setValue(v);
      },
      onParameterLocked() {
        recomputeLock();
      },
    };
    controllerRef.current = controller;
    recomputeLock(); // seed lock from current truth before the first event

    // Re-seed the displayed value from current PM truth on (re)subscribe. Without this
    // the one-shot initial useState stays 0 for any control mounted BEFORE its param is
    // registered (cosmic/axis params register during edit-mode init, post-mount) until
    // an external write happens to fire.
    if (bidirectional && !gestureRef.current) {
      const seed = params.get(rootParam, null);
      if (typeof seed === 'number') setValue(seed);
    }

    params.subscribe(controller, rootParam, priority, null);
    return () => {
      params.unsubscribe(controller, rootParam);
      controllerRef.current = null;
    };
  }, [params, rootParam, priority, bidirectional, recomputeLock]);

  // MIDI registration: pass the typed scoped-binding record for the rendered
  // element through the injected `midi` boundary. Unmount / id change / binding
  // change deterministically unregisters — the cleanup the WAC path never had.
  // No-op when MIDI is unavailable (the boundary swallows it).
  useEffect(() => {
    if (!midi || !midiId || !engineMidi.available) return;
    const element = document.getElementById(midiId);
    if (!element) return;
    // Disambiguation guard: a `pm-<componentId>` id must be unique among mounted
    // controls (the learn overlays key on it). Warn in dev on a collision so the
    // caller adds an explicit `midi.id`; still register (best-effort) so behaviour
    // doesn't regress. No-op in prod.
    if (claimedMidiIds.has(midiId) && import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        `[useParameter] duplicate MIDI target id "${midiId}" — two controls share componentId ` +
          `"${midi.componentId}". MIDI-learn overlays key on the DOM id; pass a distinct ` +
          `midi.id (or scope by dimension) to disambiguate.`,
      );
    }
    claimedMidiIds.add(midiId);
    const binding: ScopedMidiBinding = {
      id: midiId,
      element,
      componentId: midi.componentId,
      voiceId, // Route inbound MIDI to THIS tile's voice PM (not the focused one)
      componentType: midi.componentType,
      scope: midi.scope,
      axis: rootParam,
      min: midi.min,
      max: midi.max,
    };
    engineMidi.registerTarget(binding);
    return () => {
      claimedMidiIds.delete(midiId);
      engineMidi.unregisterTarget(midiId);
    };
  }, [engineMidi, midiId, midi?.componentId, midi?.componentType, midi?.scope, midi?.min, midi?.max, rootParam]);

  const write = useCallback(
    (v: number, dim: string | null, opts: WriteOptions) => {
      const ctrl = controllerRef.current;
      if (dim != null) params.setDimensionValue(rootParam, dim, v, ctrl, priority, opts);
      else params.setValue(rootParam, v, ctrl, priority, opts);
    },
    [params, rootParam, priority],
  );

  // End the current gesture: drop ALL gesture listeners (not just the one that
  // fired — leftover pointercancel/blur could otherwise end a later gesture and
  // corrupt its captured dimension), clear ownership, and resync the display to the
  // now-active dimension (so a dimension switch mid-drag is reflected on release).
  const finishGesture = useCallback(() => {
    if (!gestureRef.current) return;
    gestureRef.current = false;
    capturedDimRef.current = null;
    removeGestureListenersRef.current?.();
    removeGestureListenersRef.current = null;
    if (bidirectional) {
      const v = params.get(rootParam, null);
      if (typeof v === 'number') setValue(v);
    }
  }, [params, rootParam, bidirectional]);

  // Pointer-driven gesture: capture the dimension at drag start and freeze display.
  // Ends on commit (knob/slider) or pointerup (param drag, which has no commit).
  const onPointerDownCapture = useCallback(() => {
    if (gestureRef.current) return;
    gestureRef.current = true;
    capturedDimRef.current = activeDimOf();
    // A direct drag on this dimension takes over from any running keyboard ramp on
    // the SAME dimension (they'd otherwise fight over the value); ramps on other
    // dimensions keep running untouched.
    cancelInterp(capturedDimRef.current ?? SINGLE_DIM_KEY);
    const gen = ++gestureGenRef.current;
    // Deferred so a synchronous onCommit (same pointerup dispatch) runs first; the
    // generation guard makes a stale callback a no-op for any newer gesture.
    const onEnd = () => {
      if (gen === gestureGenRef.current) queueMicrotask(finishGesture);
    };
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onEnd);
    removeGestureListenersRef.current = () => {
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onEnd);
    };
  }, [activeDimOf, finishGesture, cancelInterp]);

  // Drop any in-flight gesture listeners if the control unmounts mid-drag.
  useEffect(() => () => removeGestureListenersRef.current?.(), []);

  const onLive = useCallback(
    (v: number) => {
      setValue(v); // drive the controlled display from the gesture
      const dim = gestureRef.current ? capturedDimRef.current : activeDimOf();
      write(v, dim, { updateIntent: LIVE });
    },
    [write, activeDimOf],
  );

  const onCommit = useCallback(
    (v: number) => {
      setValue(v);
      const dim = gestureRef.current ? capturedDimRef.current : activeDimOf();
      // notifyIfUnchanged: release commits even when the stepped value didn't move (WAC parity).
      write(v, dim, { updateIntent: COMMIT, notifyIfUnchanged: true });
      finishGesture(); // ends the gesture + resyncs display to the active dimension
    },
    [write, activeDimOf, finishGesture],
  );

  // interpolateTo — the numeric-keyboard write path. Ramp the parameter from
  // its current value to `target` over `durationMs`, LOCKED to a dimension, never
  // re-resolved to "active dimension" per frame. This is the exact fix for the WAC bug
  // where switching dimension mid-ramp redirected the interpolation: every tick writes
  // through `write(v, boundDim, …)`, which routes to `setDimensionValue(rootParam,
  // boundDim, …)` and so always lands on the original axis×dim. Display follows only
  // while that dim is active (ParameterManager notifies the active-following subscriber
  // for the active dimension only), so a mid-ramp dimension switch correctly shows the
  // newly-active dimension's value while the ramp keeps running unseen on its own dim.
  //
  // `binding` snapshots the axis×dim + start value at KEYBOARD-OPEN (passed by the
  // wrapper), so the ramp targets exactly what the user was editing — immune to a
  // concurrent remote/MIDI dimension switch while the modal is open (the modal blocks a
  // LOCAL switch, but a peer can still flip the active dimension). Without it we fall
  // back to the dimension active at call time.
  const interpolateTo = useCallback(
    (target: number, durationMs: number, binding?: { dim: string | null; value: number }) => {
      const dim = binding ? binding.dim : activeDimOf();
      const key = dim ?? SINGLE_DIM_KEY;
      // A live drag and an interpolation on the same target must not fight; and a
      // re-submit replaces the in-flight ramp rather than stacking a second rAF.
      cancelInterp(key);
      const startValue = binding
        ? binding.value
        : (() => {
            const v = params.get(rootParam, null);
            return typeof v === 'number' ? v : 0;
          })();
      // No (or non-positive) duration → a plain commit, identical to a value-only edit.
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        write(target, dim, { updateIntent: COMMIT, notifyIfUnchanged: true });
        return;
      }
      const startTime = performance.now();
      const step = (now: number) => {
        const progress = Math.min((now - startTime) / durationMs, 1);
        const v = startValue + (target - startValue) * progress;
        if (progress < 1) {
          write(v, dim, { updateIntent: LIVE });
          interpRef.current.set(key, requestAnimationFrame(step));
        } else {
          // Final frame: land exactly on target and commit (WAC parity).
          interpRef.current.delete(key);
          write(target, dim, { updateIntent: COMMIT, notifyIfUnchanged: true });
        }
      };
      interpRef.current.set(key, requestAnimationFrame(step));
    },
    [activeDimOf, cancelInterp, params, rootParam, write],
  );

  // Snapshot the current axis×dim + displayed value — the wrapper calls this at
  // keyboard-OPEN and threads it back into `interpolateTo` on submit, so the ramp is
  // bound to what the user was actually editing. Also surfaces the parameter's
  // EQUILIBRIUM (reset value, declared at registration in ParameterManager) so the keypad
  // resets to it dynamically — no per-control hardcoding.
  const captureBinding = useCallback(() => {
    const p = params.getParameter(rootParam) as { defaultValue?: number; step?: number } | null;
    const equilibrium = typeof p?.defaultValue === 'number' ? p.defaultValue : undefined;
    const step = typeof p?.step === 'number' ? p.step : undefined;
    return { dim: activeDimOf(), value, equilibrium, step };
  }, [activeDimOf, value, params, rootParam]);

  // Cancel every in-flight interpolation when the control unmounts (panel switch,
  // shell teardown) — the cleanup the WAC rAF loop never had.
  useEffect(() => {
    const map = interpRef.current;
    return () => {
      map.forEach((raf) => cancelAnimationFrame(raf));
      map.clear();
    };
  }, []);

  return { value, locked, onLive, onCommit, interpolateTo, captureBinding, gestureProps: { onPointerDownCapture }, midiProps };
}

export interface UseTriggerOptions {
  /** Scoped MIDI identity — the legacy component key so metadata resolves and the stale
   *  WAC mapping clears/inherits (e.g. "x.frequency-multiplier-low", uiId "xCosmic1"). */
  componentId: string;
  /** The momentary action fired by click AND by inbound MIDI (rising edge). */
  onTrigger: () => void;
  /** Explicit DOM id; defaults to `pm-<componentId>`. */
  id?: string;
  scope?: 'DIMENSION' | 'GLOBAL';
}

export interface UseTriggerResult {
  /** Spread onto the control: the stable id + data-automatable the learn overlays key on. */
  midiProps: Record<string, string>;
}

/**
 * useTrigger — the seam for a MOMENTARY action control (kick switches).
 *
 * Unlike {@link useParameter}, a trigger has no value, no subscription, and no lock: it
 * registers a scoped MIDI target whose `onTrigger` is fired on a rising edge by the
 * MIDIController (never a ParameterManager write). The same `onTrigger` is wired to the
 * control's click, so click and MIDI converge on one action. Unmount unregisters.
 */
export function useTrigger(options: UseTriggerOptions): UseTriggerResult {
  const { componentId, onTrigger, id, scope } = options;
  const engineMidi = useEngineMidi();
  const voiceId = useEngineVoiceId();
  const midiId = scopeMidiId(id ?? `pm-${componentId}`, voiceId);
  const midiProps = useMemo(() => ({ id: midiId, 'data-automatable': 'true' }), [midiId]);

  // Hold the latest action in a ref so a new closure each render doesn't churn the
  // registration; the registered wrapper always calls the current one.
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  useEffect(() => {
    if (!engineMidi.available) return;
    const element = document.getElementById(midiId);
    if (!element) return;
    if (claimedMidiIds.has(midiId) && import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        `[useTrigger] duplicate MIDI target id "${midiId}" — two controls share ` +
          `componentId "${componentId}". Pass a distinct id to disambiguate.`,
      );
    }
    claimedMidiIds.add(midiId);
    const binding: ScopedMidiBinding = {
      id: midiId,
      element,
      componentId,
      voiceId, // This tile's voice (kick action fires within its own boundary)
      componentType: 'kick',
      scope,
      onTrigger: () => onTriggerRef.current(),
    };
    engineMidi.registerTarget(binding);
    return () => {
      claimedMidiIds.delete(midiId);
      engineMidi.unregisterTarget(midiId);
    };
  }, [engineMidi, midiId, componentId, scope]);

  return { midiProps };
}

export interface UseToggleOptions {
  /** Scoped MIDI identity — the legacy component key so metadata resolves and the stale WAC
   *  mapping clears/inherits (e.g. "x.cosmic-toggle", uiId "xCosmicLFO"). */
  componentId: string;
  /** The control's CURRENT on/off state. A MIDI press flips it (→ `onToggle(!value)`). */
  value: boolean;
  /** Apply the new on/off state. Called by inbound MIDI with the FLIPPED current state. */
  onToggle: (next: boolean) => void;
  /** Explicit DOM id; defaults to `pm-<componentId>`. */
  id?: string;
  /** DIMENSION (default — per-axis-per-dim, like the cosmic-enable hexagon) or GLOBAL. */
  scope?: 'DIMENSION' | 'GLOBAL';
}

export interface UseToggleResult {
  /** Spread onto the control: the stable id + data-automatable the learn overlays key on. */
  midiProps: Record<string, string>;
}

/**
 * useToggle — the seam for a LATCHING on/off toggle control (cosmic/sensor enable, loop).
 *
 * Like {@link useTrigger} the control registers a scoped MIDI target with no value subscription —
 * but it LATCHES: the MIDIController fires its action on a RISING edge (a press), and that action
 * FLIPS the maintained state. The flip reads the control's CURRENT `value` fresh (via a ref) and
 * applies `onToggle(!value)`, so a momentary MIDI pad flips on press / flips back on the next
 * press, and MIDI + an on-screen click stay in agreement (React state is the single source of
 * truth). Drive the control's own change handler from the same `onToggle` so both converge.
 * Unmount unregisters.
 */
export function useToggle(options: UseToggleOptions): UseToggleResult {
  const { componentId, value, onToggle, id, scope = 'DIMENSION' } = options;
  const engineMidi = useEngineMidi();
  const voiceId = useEngineVoiceId();
  const midiId = scopeMidiId(id ?? `pm-${componentId}`, voiceId);
  const midiProps = useMemo(() => ({ id: midiId, 'data-automatable': 'true' }), [midiId]);

  // Hold the latest value + action in refs so the registered flip always reads the CURRENT state
  // and calls the CURRENT handler, without churning the registration each render.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;

  useEffect(() => {
    if (!engineMidi.available) return;
    const element = document.getElementById(midiId);
    if (!element) return;
    if (claimedMidiIds.has(midiId) && import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        `[useToggle] duplicate MIDI target id "${midiId}" — two controls share ` +
          `componentId "${componentId}". Pass a distinct id to disambiguate.`,
      );
    }
    claimedMidiIds.add(midiId);
    const binding: ScopedMidiBinding = {
      id: midiId,
      element,
      componentId,
      voiceId, // This tile's voice (toggle flips within its own boundary)
      componentType: 'toggle',
      scope,
      // FLIP on a press: invert the control's current state (read fresh) and apply it.
      onToggle: () => onToggleRef.current(!valueRef.current),
    };
    engineMidi.registerTarget(binding);
    return () => {
      claimedMidiIds.delete(midiId);
      engineMidi.unregisterTarget(midiId);
    };
  }, [engineMidi, midiId, componentId, scope]);

  return { midiProps };
}

export interface UseStepSelectOptions {
  /** Scoped MIDI identity — the legacy component key so metadata resolves and the stale WAC
   *  mappings clear/inherit (e.g. "x.waveform" / "x.exo-source"). Omit to disable MIDI. */
  componentId?: string;
  /** Number of options the single CC steps across (by value → index). */
  count: number;
  /** Select the option at the resolved index (inbound MIDI; maps index → option in the caller). */
  onSelectIndex: (index: number) => void;
  /** Explicit DOM id; defaults to `pm-<componentId>`. */
  id?: string;
  /** DIMENSION (default — the cosmic selects are per-axis-per-dim) or GLOBAL. */
  scope?: 'DIMENSION' | 'GLOBAL';
}

export interface UseStepSelectResult {
  /** Present only when `componentId` is set: spread onto the lib `ActionButtonGroup`'s
   *  `triggerProps` to stamp the stable `id` + data-automatable the learn overlays key on (the
   *  cycle trigger is the SINGLE learn target — the menu has no per-option DOM). Undefined otherwise. */
  triggerProps?: Record<string, string>;
}

/**
 * useStepSelect — the seam for a single-CC stepped SELECT (cosmic source / waveform).
 *
 * The lib `ActionButtonGroup` cycle control has no per-OPTION DOM element, so its single
 * collapsed trigger is the one learn target. Inbound MIDI maps one CC across the `count` options
 * by VALUE → index (a quantized selector knob); the MIDIController fires `onSelectIndex(index)`
 * deduped per index (never a ParameterManager write). The caller maps the index to the option
 * value and applies it, so a menu pick and a MIDI sweep converge. Unmount unregisters. No-op
 * (no MIDI coupling) when `componentId` is omitted.
 */
export function useStepSelect(options: UseStepSelectOptions): UseStepSelectResult {
  const { componentId, count, onSelectIndex, id, scope = 'DIMENSION' } = options;
  const engineMidi = useEngineMidi();
  const voiceId = useEngineVoiceId();
  const midiId = componentId ? scopeMidiId(id ?? `pm-${componentId}`, voiceId) : undefined;

  // Latest select-by-index action via a ref so per-render closures don't churn registration.
  const onSelectIndexRef = useRef(onSelectIndex);
  onSelectIndexRef.current = onSelectIndex;

  useEffect(() => {
    if (!componentId || !midiId || !engineMidi.available) return;
    const element = document.getElementById(midiId);
    if (!element) return;
    if (claimedMidiIds.has(midiId) && import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        `[useStepSelect] duplicate MIDI target id "${midiId}" — two controls share ` +
          `componentId "${componentId}". Pass a distinct id to disambiguate.`,
      );
    }
    claimedMidiIds.add(midiId);
    const binding: ScopedMidiBinding = {
      id: midiId,
      element,
      componentId,
      voiceId, // This tile's voice (select fires within its own boundary)
      componentType: 'select',
      scope,
      selectCount: count,
      onSelectIndex: (index: number) => onSelectIndexRef.current(index),
    };
    engineMidi.registerTarget(binding);
    return () => {
      claimedMidiIds.delete(midiId);
      engineMidi.unregisterTarget(midiId);
    };
  }, [engineMidi, midiId, componentId, scope, count]);

  const triggerProps = useMemo(
    () => (midiId ? { id: midiId, 'data-automatable': 'true' } : undefined),
    [midiId],
  );
  return { triggerProps };
}

export interface TriggerGroupItem {
  /** Scoped MIDI identity — match the legacy per-option key so a learned CC inherits/clears it. */
  componentId: string;
  /** The momentary action fired by click AND inbound MIDI (rising edge). */
  onTrigger: () => void;
  scope?: 'DIMENSION' | 'GLOBAL';
}

/**
 * useTriggerGroup — register a DYNAMIC set of momentary-trigger MIDI targets in ONE effect.
 *
 * For option lists whose count comes from the engine (the panel switcher, the dimension tabs),
 * per-option {@link useTrigger} calls would break the rules of hooks. This registers all targets
 * in a single effect (looping inside it) and returns a `domProps(componentId)` helper to spread
 * the stable `id` + `data-automatable` onto each option element (an `ActionButtonGroup` option's
 * `domProps`, or a Radix `TabsTrigger`). Each fires on a MIDI rising edge exactly like
 * `useTrigger`. Re-registers only when the SET of componentIds/scopes changes; the latest
 * `onTrigger` closures are read through a ref so per-render closures don't churn registration.
 */
export function useTriggerGroup(
  items: TriggerGroupItem[],
): (componentId: string) => Record<string, string> {
  const engineMidi = useEngineMidi();
  const voiceId = useEngineVoiceId();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const signature = items.map((item) => `${item.componentId}:${item.scope ?? ''}`).join('|');

  useEffect(() => {
    if (!engineMidi.available) return;
    const registered: string[] = [];
    itemsRef.current.forEach(({ componentId, scope }) => {
      const midiId = scopeMidiId(`pm-${componentId}`, voiceId);
      const element = document.getElementById(midiId);
      if (!element) return; // not in this layout (e.g. collapsed) — nothing to attach
      claimedMidiIds.add(midiId);
      engineMidi.registerTarget({
        id: midiId,
        element,
        componentId,
        voiceId, // This tile's voice (group triggers fire within its own boundary)
        componentType: 'kick',
        scope,
        onTrigger: () => itemsRef.current.find((item) => item.componentId === componentId)?.onTrigger(),
      });
      registered.push(midiId);
    });
    return () => {
      registered.forEach((midiId) => {
        claimedMidiIds.delete(midiId);
        engineMidi.unregisterTarget(midiId);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineMidi, signature, voiceId]);

  return (componentId: string) => ({ id: scopeMidiId(`pm-${componentId}`, voiceId), 'data-automatable': 'true' });
}
