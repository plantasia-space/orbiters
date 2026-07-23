/**
 * @file src/ui/react/regions/GrainWaveformLayer.tsx
 * @description Grain activity over the track waveform. While the voice's grain
 * engine is audible, every grain spawn drops a solid pill spanning the audio
 * slice it plays (vertical offset = pan; reversed grains render hollow), and a
 * translucent band marks the current spray range around the read point — so
 * the waveform shows WHERE the grain cloud is reading and HOW LONG its grains
 * are, exactly like the classic granular-instrument displays.
 *
 * Entirely event-driven: it subscribes to the engine's grain-spawn seam (the
 * same one the 3D disk layer uses) and manages its dots imperatively — no
 * React state, no RAF, zero work while no grains play. Dots live well under
 * two seconds, so a zoom change mid-life is imperceptible; everything new is
 * placed at the current px/sec.
 */
import * as React from 'react';

import { voiceRegistry } from '../../../voice/VoiceRegistry.js';
import { GRANULAR_ENGINE_ID } from '../../../audio/granular/GranularEngine.js';

type GrainSpawn = {
  positionSec: number;
  durationSec: number;
  pan: number;
  pitch: number;
  reversed: boolean;
};

type GranularEngineLike = {
  addGrainListener: (listener: (spawn: GrainSpawn) => void) => () => void;
  peekParams: () => { positionSpray: number };
};

type SourceEngineAdapter = {
  peekSourceEngine?: (id: string) => GranularEngineLike | null;
  observeSourceEngines?: (cb: (id: string, engine: GranularEngineLike | null) => void) => () => void;
};

/** Bound on simultaneously mounted dots (engine caps ~20 sounding grains; the
 *  extra headroom covers fade-out tails). */
const MAX_DOTS = 40;

export function GrainWaveformLayer({ voiceId, pxPerSec }: { voiceId: string | number | null; pxPerSec: number }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  // The listener reads the CURRENT zoom without re-subscribing on every zoom change.
  const pxPerSecRef = React.useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const entry = (voiceId != null ? voiceRegistry.get(voiceId) : voiceRegistry.getActive()) as
      | { audioEngine?: SourceEngineAdapter | null }
      | null;
    const adapter = entry?.audioEngine ?? null;
    if (!adapter?.observeSourceEngines) return undefined;

    let engine: GranularEngineLike | null = null;
    let unsubscribeGrains: (() => void) | null = null;
    let liveDots = 0;
    let sprayEl: HTMLDivElement | null = null;
    let sprayCenterSec: number | null = null;
    let sprayHideTimer = 0;

    const hideSpray = () => {
      if (sprayEl) sprayEl.style.opacity = '0';
    };

    const onGrain = (spawn: GrainSpawn) => {
      const px = pxPerSecRef.current;
      // The band centers on an exponential-smoothed position of where grains
      // actually land — identical for follow, anchored and seeking pointers,
      // with no reach into engine internals.
      sprayCenterSec = sprayCenterSec === null
        ? spawn.positionSec
        : sprayCenterSec + (spawn.positionSec - sprayCenterSec) * 0.35;
      if (!sprayEl) {
        sprayEl = document.createElement('div');
        sprayEl.className = 'kit-waveform__grain-spray';
        host.appendChild(sprayEl);
      }
      const spraySec = engine?.peekParams().positionSpray ?? 0;
      sprayEl.style.opacity = '1';
      sprayEl.style.left = `${sprayCenterSec * px}px`;
      sprayEl.style.width = `${Math.max(2, spraySec * 2 * px)}px`;
      window.clearTimeout(sprayHideTimer);
      sprayHideTimer = window.setTimeout(hideSpray, 400);

      if (liveDots >= MAX_DOTS) return;
      liveDots += 1;
      const dot = document.createElement('div');
      dot.className = spawn.reversed
        ? 'kit-waveform__grain-dot kit-waveform__grain-dot--reversed'
        : 'kit-waveform__grain-dot';
      // A tool marker, not an effect: the pill sits solid on its slice for as
      // long as the grain sounds, then snaps away (short floor so micro grains
      // still register).
      const lifeSec = Math.max(0.15, Math.min(1.2, spawn.durationSec));
      dot.style.left = `${spawn.positionSec * px}px`;
      // The pill spans the actual audio slice the grain plays — grain size is
      // read directly off the waveform (and scales with zoom); micro grains
      // clamp down to a dot.
      dot.style.width = `${Math.max(6, spawn.durationSec * px).toFixed(1)}px`;
      dot.style.top = `${50 + spawn.pan * 34}%`;
      dot.style.animationDuration = `${lifeSec.toFixed(2)}s`;
      // animationend is the normal cleanup; the timer covers a backgrounded tab
      // (frozen CSS animations) so dots can never pile up at the cap.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        liveDots -= 1;
        dot.remove();
      };
      dot.addEventListener('animationend', release);
      window.setTimeout(release, lifeSec * 1000 + 500);
      host.appendChild(dot);
    };

    const bind = (next: GranularEngineLike | null) => {
      unsubscribeGrains?.();
      engine = next;
      unsubscribeGrains = next ? next.addGrainListener(onGrain) : null;
      if (!next) hideSpray();
    };

    // One peek covers an engine created before this panel mounted (persisted
    // rack config); the observation covers every later create/dispose.
    bind(adapter.peekSourceEngine?.(GRANULAR_ENGINE_ID) ?? null);
    const unobserve = adapter.observeSourceEngines((id, next) => {
      if (id === GRANULAR_ENGINE_ID) bind(next);
    });

    return () => {
      unobserve();
      unsubscribeGrains?.();
      window.clearTimeout(sprayHideTimer);
      host.replaceChildren();
    };
  }, [voiceId]);

  return <div ref={hostRef} className="kit-waveform__grain-layer" aria-hidden="true" />;
}

export default GrainWaveformLayer;
