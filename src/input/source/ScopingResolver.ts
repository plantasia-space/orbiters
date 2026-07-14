/**
 * @file src/input/source/ScopingResolver.ts
 * @description Single source of truth for "which stack / dimension is active".
 *
 * Before this, the input sources each hand-rolled their own `getScopedContext()` that read
 * the same `window.__orbitersWorldMode` global with subtly different fallback chains. This
 * consolidates that resolution into one pure helper so the seam is defined once. CosmicLFO and
 * SensorsController now delegate here; MIDIController keeps its own variant (with extra
 * stack/DOM fallbacks) until it joins the seam.
 *
 * Behaviour is a faithful union of the two pre-existing implementations:
 *  - SensorsController.getScopedContext (the base resolve), and
 *  - CosmicLFO.getScopedContext (base resolve + an optional ParameterManager fallback,
 *    used only when no dimension is active on the world-mode controller).
 *
 * No mutation, no DOM writes — it only reads the world-mode controller (and, optionally,
 * a ParameterManager) and returns the resolved scope.
 */

import { voiceRegistry } from '../../voice/VoiceRegistry.js';

/** The active scope an input source pushes into. */
export interface ScopedContext {
  /** The active stack, e.g. `deck-i`. Never null — falls back to {@link DEFAULT_STACK_ID}. */
  stackId: string;
  /** The active dimension id, or null when nothing is active and no fallback resolved one. */
  dimensionId: string | null;
}

/** The slice of the world-mode controller the scope resolution reads. */
export interface ModeControllerLike {
  modes?: {
    edit?: {
      activeStackId?: string | null;
      activeDimensionId?: string | null;
    } | null;
  } | null;
  /** Legacy accessor some controllers expose instead of `modes.edit.activeDimensionId`. */
  getActiveDimensionId?: () => string | null | undefined;
}

/** The slice of ParameterManager the optional dimension fallback reads. */
export interface ParameterManagerLike {
  getParameter?: (name: string) => {
    isMultidimensional?: boolean;
    activeDimensionId?: string | null;
  } | null | undefined;
}

export interface ResolveScopeOptions {
  /**
   * The world-mode controller. Defaults to the active voice's `worldMode` (from the voice
   * registry) when omitted; pass `null` explicitly (or any value) to override — useful for tests/SSR.
   */
  modeController?: ModeControllerLike | null;
  /**
   * Optional ParameterManager. When provided together with {@link ResolveScopeOptions.axis},
   * and the world-mode controller did not yield a dimension, the resolver falls back to the
   * axis parameter's `activeDimensionId` (only when that parameter is multidimensional).
   * This reproduces CosmicLFO's extra fallback; sources that don't pass it behave like
   * SensorsController (no PM fallback).
   */
  parameterManager?: ParameterManagerLike | null;
  /** The axis/parameter name used by the ParameterManager fallback (e.g. `x`). */
  axis?: string;
}

/** The stack id used when the world-mode controller has no active stack. */
export const DEFAULT_STACK_ID = 'deck-i';

/** Read the active voice's world-mode controller (null when no voice is active). */
function defaultModeController(): ModeControllerLike | null {
  return (voiceRegistry.getActive()?.worldMode as ModeControllerLike | undefined) ?? null;
}

/**
 * Resolve the active `{ stackId, dimensionId }` scope.
 *
 * Resolution order for `dimensionId`:
 *   1. `modeController.modes.edit.activeDimensionId`
 *   2. `modeController.getActiveDimensionId()` (if it's a function)
 *   3. ParameterManager fallback — `parameterManager.getParameter(axis).activeDimensionId`,
 *      but only when `parameterManager` + `axis` were supplied and that parameter is
 *      multidimensional. (Without them, dimensionId stays null — Sensors' behaviour.)
 */
export function resolveScopedContext(options: ResolveScopeOptions = {}): ScopedContext {
  const modeController =
    'modeController' in options ? options.modeController : defaultModeController();
  const editMode = modeController?.modes?.edit ?? null;
  const stackId = editMode?.activeStackId ?? DEFAULT_STACK_ID;

  let dimensionId: string | null = null;
  if (editMode?.activeDimensionId) {
    dimensionId = editMode.activeDimensionId;
  } else if (typeof modeController?.getActiveDimensionId === 'function') {
    dimensionId = modeController.getActiveDimensionId() ?? null;
  }

  // ParameterManager fallback (CosmicLFO's extra step): only when nothing resolved above
  // and the caller opted in by passing a parameterManager + axis.
  if (!dimensionId && options.parameterManager && options.axis &&
      typeof options.parameterManager.getParameter === 'function') {
    const axisParam = options.parameterManager.getParameter(options.axis);
    if (axisParam && axisParam.isMultidimensional && axisParam.activeDimensionId) {
      dimensionId = axisParam.activeDimensionId;
    }
  }

  return { stackId, dimensionId };
}
