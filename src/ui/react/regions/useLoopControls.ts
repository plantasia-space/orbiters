/**
 * @file src/ui/react/regions/useLoopControls.ts
 * @description The orbiter loop-control logic, reproduced from PeaksView for the kit
 * panel so the whole waveform panel is one kit composition (no Peaks). The engine only stores the
 * loop range (ms) + grid origin + BPM; all the beat math (snap grid, in/out at playhead, loop-size
 * in beats, engage) is UI-side — this hook is that logic, bound to the `waveformData` surface.
 *
 * When Peaks is deleted this is the single loop owner; until then PeaksView keeps its own copy for
 * the flag-off path (they never run together — Peaks isn't mounted in kit mode).
 */
import * as React from 'react';
import { quantizeStepBeats, type QuantizeGridId } from 'plantasia.space-design/react/timeline/quantize';

import type { EngineWaveformData, WaveformLoopRange } from '../../../react/engine/engineTypes';

// Orbiters projections are meter-less (bpm only → 4/4), so a bar is 4 beats everywhere. Only the
// bar-length snap grids (…Bars) read this; the note grids (1/2…1/32) are absolute in beats.
const BAR_BEATS = 4;

/** The loop-size preset vocabulary — absolute beat counts, not bar-relative, so any
 *  consumer just does `beats * secondsPerBeat`. Exported so other timing-preset UI (the
 *  numeric-keyboard grid presets) reuses this exact list instead of inventing a second one. */
export const LOOP_SIZES: ReadonlyArray<{ beats: number; label: string }> = [
  { beats: 0.03125, label: '1/32' },
  { beats: 0.0625, label: '1/16' },
  { beats: 0.125, label: '1/8' },
  { beats: 0.25, label: '1/4' },
  { beats: 0.5, label: '1/2' },
  { beats: 1, label: '1' },
  { beats: 2, label: '2' },
  { beats: 4, label: '4' },
  { beats: 8, label: '8' },
  { beats: 16, label: '16' },
  { beats: 32, label: '32' },
];

export interface LoopControls {
  loop: WaveformLoopRange | null;
  loopActive: boolean;
  /** The snap grid: `auto` (zoom-adaptive, default), `none` (off), or a fixed grid (1/2…1/32, …Bars). */
  snapGrid: QuantizeGridId;
  /** Derived: snapping is on for any grid other than `none` — drives the MIDI toggle's on/off state. */
  snapEnabled: boolean;
  hasLoop: boolean;
  canLoopOut: boolean;
  /** A track BPM is known — the grid + loop-size presets need it. */
  hasBpm: boolean;
  selectedSizeBeats: number | null;
  /** The pending loop-in anchor (seconds) before Out completes it, or null — for the In marker. */
  pendingInSec: number | null;
  /** Snap a seconds value to the grid (respects the Snap toggle) — for snapped seeking. */
  snapSec(sec: number): number;
  /** Commit a (freeform) loop range, snapping the edges when snap is on — for the LoopRegion drag. */
  setLoopRange(range: WaveformLoopRange | null): void;
  loopIn(): void;
  loopOut(): void;
  toggleLoop(): void;
  /** Toggle snap off/on (MIDI + click) — flips `none` ↔ the last active grid (default `auto`). */
  toggleSnap(): void;
  /** Pick a snap grid from the magnet menu (`auto` | `none` | a fixed grid). */
  setSnapGrid(id: QuantizeGridId): void;
  selectLoopSize(beats: number): void;
  setGridMarker(): void;
  /** Set the grid downbeat to an explicit source-second offset (diamond drag / offset field), free + clamped. */
  setGridMarkerSec(sec: number): void;
  clearLoop(): void;
}

export interface UseLoopControlsOptions {
  /** Changes when the track changes — re-reads the engine loop + resets pending edit state. */
  trackKey: string | number | null;
  /** The visible window in seconds (for the zoom-adaptive snap granularity). */
  getVisibleSec: () => number;
  /** Persist the grid origin (the GRID button) to the track's sync settings. */
  onGridCommit?: (sec: number) => void;
  /** Seek the engine (used to jump to the loop start when Out completes an active loop). */
  onSeek?: (sec: number) => void;
}

/** Adaptive snap granularity (beats) by how many beats are visible — mirrors PeaksView's table. */
function snapStepBeatsFor(visibleBeats: number): number {
  if (visibleBeats >= 64) return 4;
  if (visibleBeats >= 32) return 1;
  if (visibleBeats >= 16) return 0.5;
  if (visibleBeats >= 8) return 0.25;
  if (visibleBeats >= 4) return 0.125;
  if (visibleBeats >= 2) return 0.0625;
  return 0.03125;
}

export function useLoopControls(data: EngineWaveformData, opts: UseLoopControlsOptions): LoopControls {
  const { trackKey, getVisibleSec, onGridCommit, onSeek } = opts;

  // Broadcast through the `data` facade, which stamps THIS voice's id onto the shared
  // `ui:loop-toggle` document event so a sibling tile's kit panel + transport button ignore it (the
  // active-voice Interaction recorder + usage-events still hear it). Single-orbiter is byte-identical.
  const broadcastLoop = (active: boolean): void => data.broadcastLoopToggle(active);

  const [loop, setLoop] = React.useState<WaveformLoopRange | null>(() => data.getLoopRangeSec());
  const [loopActive, setLoopActiveState] = React.useState(() => data.isLoopActive());
  // Snap granularity: `auto` (zoom-adaptive, the historical default), `none` (off), or a fixed grid.
  const [snapGrid, setSnapGrid] = React.useState<QuantizeGridId>('auto');
  // The grid to restore when the MIDI/click toggle turns snap back on (never `none`).
  const lastActiveGridRef = React.useRef<QuantizeGridId>('auto');
  const snapEnabled = snapGrid !== 'none';
  const [selectedSizeBeats, setSelectedSizeBeats] = React.useState<number | null>(null);
  // Reactive (not a ref) so the In→Out gating (`canLoopOut`) actually re-renders the Out button.
  const [pendingIn, setPendingIn] = React.useState<number | null>(null);

  const visRef = React.useRef(getVisibleSec);
  visRef.current = getVisibleSec;

  // Re-sync from the engine on a track change; drop any half-finished edit.
  React.useEffect(() => {
    setLoop(data.getLoopRangeSec());
    setLoopActiveState(data.isLoopActive());
    setSelectedSizeBeats(null);
    setPendingIn(null);
  }, [data, trackKey]);

  // Stay linked to the engine loop when something else changes it (the transport bar's loop button,
  // MIDI, etc.) — re-read on the shared `ui:loop-toggle` event. Re-reading after our own broadcast is
  // idempotent (same value → no re-render), so this can't feed back.
  React.useEffect(() => {
    // Subscribe through the `data` facade — it filters OTHER tiles' loop toggles by
    // voiceId, so only THIS voice's external changes re-read here. We still ignore our OWN 'waveform'
    // broadcasts (already reflected in local state); re-read only on external (transport/MIDI) changes.
    return data.subscribeLoopToggle((detail) => {
      if (detail.source === 'waveform') return;
      setLoop(data.getLoopRangeSec());
      setLoopActiveState(data.isLoopActive());
      setSelectedSizeBeats(null); // the loop changed elsewhere — no preset is "selected" anymore
    });
  }, [data]);

  const beatSec = (): number | null => {
    const bpm = data.getTrackBpm();
    return bpm ? 60 / bpm : null;
  };
  const clampDur = (sec: number): number => {
    const dur = data.getDurationSec();
    return Math.min(dur > 0 ? dur : sec, Math.max(0, sec));
  };
  // The snap step in seconds for the current grid, or null when snapping is off / no BPM. `auto`
  // stays zoom-adaptive (its original table); a fixed grid resolves via the shared quantize model.
  const snapStepSec = (): number | null => {
    const bs = beatSec();
    if (!bs || snapGrid === 'none') return null;
    if (snapGrid === 'auto') return bs * snapStepBeatsFor(visRef.current() / bs);
    const stepBeats = quantizeStepBeats(snapGrid, BAR_BEATS);
    return stepBeats ? bs * stepBeats : null;
  };
  const snap = (sec: number): number => {
    const stepSec = snapStepSec();
    if (!stepSec) return clampDur(sec);
    const grid = data.getGridMarkerSec();
    return clampDur(grid + Math.round((sec - grid) / stepSec) * stepSec);
  };

  // Commit a loop range, choosing whether to engage it. `engageLoop` (in/out/size + a new draw)
  // always loops; `commitRange(..., false)` keeps an existing armed-OFF loop disengaged on a drag.
  const commitRange = (range: WaveformLoopRange, active: boolean) => {
    data.setLoopSec(range); // the engine engages on setLoopSec…
    if (!active) data.setLoopActive(false); // …so re-disengage when the edit must stay armed-off
    setLoop(range);
    setLoopActiveState(active);
    broadcastLoop(active);
  };
  const engageLoop = (range: WaveformLoopRange) => commitRange(range, true);

  const pos = () => data.getPositionSec();
  const inLoop = (p: number, r: WaveformLoopRange) => p >= r.startSec && p <= r.endSec;

  return {
    loop,
    loopActive,
    snapGrid,
    snapEnabled,
    hasLoop: !!loop,
    canLoopOut: pendingIn != null || !!loop,
    hasBpm: beatSec() != null,
    selectedSizeBeats,
    pendingInSec: pendingIn,
    snapSec: snap,

    setLoopRange: (range) => {
      setSelectedSizeBeats(null); // a freeform drag no longer matches any loop-size preset
      if (!range) {
        data.setLoopSec(null);
        setLoop(null);
        setLoopActiveState(false);
        broadcastLoop(false);
        return;
      }
      const a = snap(range.startSec);
      const b = snap(range.endSec);
      // Drawing a NEW loop engages it; editing an existing band preserves its engaged state.
      if (b > a) commitRange({ startSec: Math.min(a, b), endSec: Math.max(a, b) }, loop ? loopActive : true);
    },

    // Set the loop-in at the (snapped) playhead. IN and OUT are independent: with a loop already
    // set, a new IN re-anchors it IMMEDIATELY to [new IN, old OUT] (no waiting for a fresh OUT),
    // preserving its enabled/disabled state like a band edit. An IN at/after the current OUT makes
    // the OUT stale — the loop is removed and the new IN waits as the pending anchor.
    loopIn: () => {
      const inSec = snap(pos());
      if (loop && inSec < loop.endSec) {
        setSelectedSizeBeats(null); // a freeform IN no longer matches any size preset
        setPendingIn(null);
        commitRange({ startSec: inSec, endSec: loop.endSec }, loopActive);
        return;
      }
      if (loop) {
        // IN past the current OUT → drop the loop, keep the new IN pending for the next OUT.
        setSelectedSizeBeats(null); // no loop left for a size preset to describe
        data.setLoopSec(null);
        setLoop(null);
        setLoopActiveState(false);
        broadcastLoop(false);
      }
      setPendingIn(inSec);
    },
    loopOut: () => {
      const end = snap(pos());
      const base = pendingIn ?? loop?.startSec ?? end;
      setPendingIn(null);
      // Only a forward range — an OUT at/before the IN is ignored, never relocates/inverts the loop.
      if (end > base) {
        setSelectedSizeBeats(null); // a freeform In/Out loop no longer matches any size preset
        engageLoop({ startSec: base, endSec: end });
        onSeek?.(base); // jump back to the loop start so it plays from the top (legacy parity)
      }
    },

    toggleLoop: () => {
      if (loopActive) {
        data.setLoopActive(false);
        setLoopActiveState(false);
        broadcastLoop(false);
        return;
      }
      if (loop) {
        data.setLoopActive(true);
      } else {
        const dur = data.getDurationSec();
        if (dur <= 0) return; // can't create a loop before the duration is known
        const full = { startSec: 0, endSec: dur };
        data.setLoopSec(full);
        setLoop(full);
      }
      setLoopActiveState(true);
      broadcastLoop(true);
    },

    toggleSnap: () => {
      if (snapGrid === 'none') {
        setSnapGrid(lastActiveGridRef.current);
      } else {
        lastActiveGridRef.current = snapGrid;
        setSnapGrid('none');
      }
    },

    setSnapGrid: (id: QuantizeGridId) => {
      if (id !== 'none') lastActiveGridRef.current = id;
      setSnapGrid(id);
    },

    selectLoopSize: (beats) => {
      const bs = beatSec();
      if (!bs) return;
      const p = pos();
      // Anchor: an explicit pending In point wins; else an ACTIVE loop containing the playhead
      // re-lengths from its own start. A DISABLED loop's markers are inert — the preset loops from
      // the playhead, exactly like a playhead outside the range.
      const base = pendingIn ?? (loopActive && loop && inLoop(p, loop) ? loop.startSec : snap(p));
      const end = clampDur(base + beats * bs);
      setPendingIn(null);
      if (end > base) {
        engageLoop({ startSec: base, endSec: end });
        setSelectedSizeBeats(beats);
      }
    },

    setGridMarker: () => {
      const g = snap(pos());
      data.setGridMarkerSec(g);
      onGridCommit?.(g);
    },

    // Set the grid downbeat to an EXPLICIT source-second offset (the draggable diamond / the offset
    // field), not the playhead. NO snap — the downbeat IS the grid origin, so snapping it to its own
    // grid is circular; it's placed freely. Clamped to [0, duration].
    setGridMarkerSec: (sec: number) => {
      const g = clampDur(Number(sec) || 0);
      data.setGridMarkerSec(g);
      onGridCommit?.(g);
    },

    clearLoop: () => {
      data.setLoopSec(null);
      setLoop(null);
      setLoopActiveState(false);
      setSelectedSizeBeats(null);
      setPendingIn(null);
      broadcastLoop(false);
    },
  };
}
