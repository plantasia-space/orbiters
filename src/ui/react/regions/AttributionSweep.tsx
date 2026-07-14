/**
 * @file src/ui/react/regions/AttributionSweep.tsx
 * @description The automatic attribution sweep for video capture. When a recording
 * starts inside the dedicated capture window, the credits already surfaced by the Info panel are
 * swept past the viewer — Track → Entangled World → Orbiter, ~3s each — then the overlay returns
 * to the Engine Monitor (the main engine view). The whole sweep is captured in the exported video,
 * so every export clearly credits who made the audio, the world, and the orbiter.
 *
 * Ownership: the React UI owns the sweep because it already owns the Info-panel view state
 * (`infoPanelStore`). It is driven by the imperative capture engine's STATE EVENT (a clean
 * UI → export dependency), not the other way around — `capture.js` stays presentation-agnostic.
 *
 * Scope: the sweep runs ONLY in the capture window (`isCaptureWindow()`). That is the sole context
 * where a recording starts AND its output is the file the user keeps; the live play UI is untouched.
 *
 * Re-trigger guard: `capture.js` re-emits the `recording` state every second (its elapsed-time
 * ticker), so the sweep keys on the idle→recording TRANSITION — never on a mid-recording tick.
 */
import { useEffect, useRef } from 'react';
import { useEngineInfo } from '../../../react/engine/EngineContext';
import { CAPTURE_STATES, CAPTURE_STATE_CHANGE_EVENT, captureControl } from '../../../export/capture.js';
import { isCaptureWindow } from '../../../export/captureWindow.js';
import { type InfoMode } from './infoPanelStore';
import { useInfoPanelStore } from './InfoPanelStoreContext';

/** The attribution credits, in sweep order — each is an existing Info-panel view. */
const ATTRIBUTION_STEPS: readonly InfoMode[] = ['track', 'entangled-world', 'orbiter'];
/** The view the sweep ends on: the Engine Monitor, i.e. the main engine view (load default). */
const RETURN_MODE: InfoMode = 'monitor';
/** How long each credit stays on screen (ms). Fixed for now (ticket open question). */
const STEP_MS = 3000;

interface AttributionSweepDeps {
  /** Rows for an Info mode; empty when that credit is missing (the step is then skipped). */
  getTags: (mode: InfoMode) => readonly unknown[];
  /** Switch the Info-panel view (the visible credits overlay). */
  setMode: (mode: InfoMode | null) => void;
  /** Current capture state, read once at arm time to seed the transition guard. */
  getCaptureState: () => string;
}

/**
 * Wire the attribution sweep to the capture lifecycle. Returns a cleanup that detaches the listener
 * and aborts any in-flight sweep. Pure of React so it is unit-testable with fake timers.
 */
export function armAttributionSweep({ getTags, setMode, getCaptureState }: AttributionSweepDeps): () => void {
  let cancelled = false;
  let sweeping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  // Seed from the current state so arming mid-recording can't fire a late, false sweep.
  let prevState = getCaptureState();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    });

  // Abort an in-flight sweep: stop the wait AND wake the awaiter so the loop unwinds to its
  // `finally` (restoring the engine view) instead of hanging on a cleared timer.
  const abort = () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    wake?.();
  };

  // Missing (or unreadable) credit data is skipped, not shown blank — graceful, and a throwing
  // provider can never break the recording mid-sweep.
  const hasCredits = (mode: InfoMode) => {
    try {
      return getTags(mode).length > 0;
    } catch {
      return false;
    }
  };

  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const mode of ATTRIBUTION_STEPS) {
        if (cancelled) return;
        if (!hasCredits(mode)) continue;
        setMode(mode);
        await sleep(STEP_MS);
      }
    } finally {
      // Always land on the main engine view, even if the sweep was cut short by an early stop,
      // so the UI is never left stranded on a credits panel.
      setMode(RETURN_MODE);
      sweeping = false;
    }
  };

  const onCaptureState = (event: Event) => {
    const state = (event as CustomEvent<{ state?: string }>).detail?.state;
    if (state === CAPTURE_STATES.recording && prevState !== CAPTURE_STATES.recording) {
      cancelled = false;
      void sweep();
    } else if (state !== CAPTURE_STATES.recording && prevState === CAPTURE_STATES.recording) {
      // Recording ended (stop / save) — abort any in-flight sweep.
      abort();
    }
    if (state) prevState = state;
  };

  window.addEventListener(CAPTURE_STATE_CHANGE_EVENT, onCaptureState);
  return () => {
    abort();
    window.removeEventListener(CAPTURE_STATE_CHANGE_EVENT, onCaptureState);
  };
}

/** Drives the attribution sweep in the capture window. Renders nothing. */
export function AttributionSweep(): null {
  const info = useEngineInfo();
  // This tile's per-voice Info-panel store (the sweep switches its monitor/credits view).
  const infoStore = useInfoPanelStore();
  // Keep the latest info surface available to the running sweep without re-arming the effect.
  const infoRef = useRef(info);
  infoRef.current = info;

  useEffect(() => {
    if (!isCaptureWindow()) return undefined;
    return armAttributionSweep({
      getTags: (mode) => infoRef.current.getTags(mode),
      setMode: (mode) => infoStore.setMode(mode),
      getCaptureState: () => captureControl.getState(),
    });
  }, [infoStore]);

  return null;
}
