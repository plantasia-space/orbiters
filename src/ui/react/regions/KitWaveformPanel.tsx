/**
 * @file src/ui/react/regions/KitWaveformPanel.tsx
 * @description The orbiter audio waveform, built from the design-lib React
 * timeline kit. (Peaks.js was removed in the cutover; the kit is the default view — there is no
 * feature flag.)
 *
 * This is the "orbiter face" of the shared kit (the EW studio is the other face): a single
 * audio lane — canvas waveform + a live playhead + click/drag-to-seek + wheel/bar zoom + a
 * draggable loop region. It binds to the engine through the lean `waveformData` surface
 * (url/duration/position/seek/loop in seconds) plus the existing `transport` facade for
 * play/pause; it renders the EXACT audiowaveform JSON the engine provides (via `peaksFromWaveformData`),
 * so the waveform itself matches with no recompute.
 *
 * Single playback owner: while this panel is mounted it runs the one RAF for the playhead, so
 * there is never a second waveform or a competing position ticker.
 *
 * Deep-imports only presentation pieces of the kit, so its optional shared-clock peer is
 * never pulled at runtime. The kit subpath resolves to the published design-lib 0.10.0 via a
 * worktree-local vite alias / tsconfig path (a spike) until the orbiter bumps to ^0.10.0.
 */
import * as React from 'react';

import './kit-waveform.css';
import { useEngineWaveformData, useEngineTransport, useEngineVoiceId } from '../../../react/engine/EngineContext';
import type { EngineWaveformData, EngineTransport, TransportCountIn } from '../../../react/engine/engineTypes';
import { ParameterizedParam, useTrigger, useToggle, useTriggerGroup } from '../../../react/parameters';
import { getT } from '../../../i18n/index.js';
import notifications from '../../../core/AppNotifications.js';
import { commitTrackBpmFromUi, commitGridMarkerFromUi, resolveEngine } from '../../../sync/trackSettingsCommit.js';
import { deckFor, WRAP_GRID_CHANGE_EVENT } from '../../../voice/Deck.js';
import { parseMeter, DEFAULT_METER_ID } from '../../../sync/meter.js';
import { useLoopControls, LOOP_SIZES, type LoopControls } from './useLoopControls';
import { GrainWaveformLayer } from './GrainWaveformLayer';
import { useNavViewportState } from './useNavViewportState';
import { usePagedWindow, DEFAULT_WINDOW_SIZE } from 'plantasia.space-design/react';
import { usePortalContainer } from '../PortalContainerProvider';

import { CornerButton } from 'plantasia.space-design/react';
import { TimelineViewport } from 'plantasia.space-design/react/timeline/components/timeline-viewport';
import { TimelineRuler } from 'plantasia.space-design/react/timeline/components/timeline-ruler';
import { MusicalRuler } from 'plantasia.space-design/react/timeline/components/musical-ruler';
import { TimelineGrid } from 'plantasia.space-design/react/timeline/components/timeline-grid';
import { Playhead } from 'plantasia.space-design/react/timeline/components/playhead';
import { Waveform } from 'plantasia.space-design/react/timeline/components/waveform';
import { LoopRegion } from 'plantasia.space-design/react/timeline/components/loop-region';
import { DownbeatMarker } from 'plantasia.space-design/react/timeline/components/downbeat-marker';
import { ValueParam } from 'plantasia.space-design/react/arrow';
import { QuantizeMenu } from 'plantasia.space-design/react/timeline/components/quantize-menu';
import { SNAP_PRESETS } from 'plantasia.space-design/react/timeline/quantize';
import { Icon } from 'plantasia.space-design/icons';
import { Diamond, FlagTriangleRight, FlagTriangleLeft, Magnet, AudioWaveform, Repeat, ChevronLeft, ChevronRight, LockOpen } from 'lucide-react';
import { TimeReadout } from 'plantasia.space-design/react/timeline/components/time-readout';
import { formatTimecode } from 'plantasia.space-design/react/timeline/format';
import { buildPeakLevels, type PeakLevels } from 'plantasia.space-design/react/timeline/peaks';
import { fetchPeaks } from './peaksCache';
import { useTimelineWheel } from 'plantasia.space-design/react/timeline/hooks/use-timeline-wheel';
import { MusicalProjection } from 'entangled-worlds-orbiters-shared/clock/musical';

type PlayheadTransport = React.ComponentProps<typeof Playhead>['transport'];
const MOBILE_LOOP_WINDOW_SIZE = 3;
// The kit resolves its clock peer to design-lib's installed copy; the orbiter's MusicalProjection is
// the same package/code from the orbiter's copy. Runtime-identical, so cast at this one boundary.
type KitProjection = React.ComponentProps<typeof TimelineGrid>['projection'];

const ZOOM_MIN = 4;
const ZOOM_MAX = 600;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Fetch the track's audiowaveform JSON and convert it to the kit's normalized peaks — the
 * SAME data Peaks reads (`waveformJSONURL`), so the rendered shape matches. Deduped per url
 * (`fetchPeaks`); the effect only guards its own setState against a url change / unmount.
 */
function useWaveformPeaks(url: string | null): number[] | null {
  const [peaks, setPeaks] = React.useState<number[] | null>(null);
  React.useEffect(() => {
    if (!url) {
      setPeaks(null);
      return;
    }
    let active = true;
    fetchPeaks(url)
      .then((result) => {
        if (active) setPeaks(result);
      })
      .catch((err) => {
        if (active) {
          console.error('[KitWaveformPanel] waveform fetch failed:', err);
          setPeaks(null);
        }
      });
    return () => {
      active = false;
    };
  }, [url]);
  return peaks;
}

/**
 * The kit Playhead follows a clock `Transport` via `useBeat`, which only reads `positionSec()`
 * + `onTick()`. The orbiter has no shared clock here, so present the engine as that minimal
 * shape: one RAF (the single position owner) gated on the existing transport's play state, with
 * a `poke()` to land the playhead after a paused seek. Cast at this one narrow boundary.
 */
function usePlayheadTransport(data: EngineWaveformData, transport: EngineTransport) {
  const ctl = React.useMemo(() => {
    const listeners = new Set<(sec: number) => void>();
    let raf = 0;
    // `at` overrides the engine read — used after a seek, where the engine applies the new
    // position asynchronously (so reading it synchronously would emit the stale spot).
    const emit = (at?: number) => {
      const p = at ?? data.getPositionSec();
      listeners.forEach((l) => l(p));
    };
    const tick = () => {
      emit();
      raf = requestAnimationFrame(tick);
    };
    return {
      transport: {
        positionSec: () => data.getPositionSec(),
        onTick: (cb: (sec: number) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      } as unknown as PlayheadTransport,
      start: () => {
        if (!raf) raf = requestAnimationFrame(tick);
      },
      stop: () => {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      poke: emit,
    };
  }, [data]);

  React.useEffect(() => {
    if (transport.isPlaying()) ctl.start();
    ctl.poke();
    const off = transport.subscribe(() => {
      if (transport.isPlaying()) {
        ctl.start();
      } else {
        ctl.stop();
        ctl.poke(); // land at the final (paused/stopped) position
      }
    });
    return () => {
      off();
      ctl.stop();
    };
  }, [ctl, transport]);

  return ctl;
}

/**
 * Track a pending quantized SEEK (target position + a beat countdown) so the waveform
 * can blink a marker at the SET position — the count shown in the action, not only at the top. Active
 * only for a seek (TransportCountIn.seekTargetSec present), never a launch. One render per beat (a
 * self-rescheduling timeout, mirroring Transport.tsx), so it stays mobile-cheap.
 */
function useSeekCountIn(transport: EngineTransport) {
  const [countIn, setCountIn] = React.useState<TransportCountIn>(() => transport.getCountIn());
  React.useEffect(() => {
    setCountIn(transport.getCountIn());
    return transport.subscribeCountIn(setCountIn);
  }, [transport]);
  const [beatsLeft, setBeatsLeft] = React.useState(0);
  React.useEffect(() => {
    const { active, targetTime, bpm, seekTargetSec } = countIn;
    if (!active || seekTargetSec == null || !targetTime || !bpm || bpm <= 0) {
      setBeatsLeft(0);
      return;
    }
    const msPerBeat = 60000 / bpm;
    let timer = 0;
    const tick = () => {
      const remainMs = targetTime - performance.now();
      if (remainMs <= 0) {
        setBeatsLeft(0);
        return;
      }
      const beats = Math.ceil(remainMs / msPerBeat);
      setBeatsLeft(beats);
      const nextMs = remainMs - (beats - 1) * msPerBeat;
      timer = window.setTimeout(tick, Math.max(16, nextMs));
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [countIn]);
  const seekTargetSec = countIn.active ? countIn.seekTargetSec : undefined;
  return { active: seekTargetSec != null && beatsLeft > 0, seekTargetSec, beatsLeft };
}

/** This TILE's own per-track meter id (WrapGridState-backed, per-voice — meter is never shared) — so
 * the grid's bar/beat lines match the real time signature instead of a hardcoded 4/4 default
 * (`MusicalProjection` with no `signatureMap`), AND match the RIGHT track when several orbiters each
 * have their own meter. */
function useMeterId(data: ReturnType<typeof useEngineWaveformData>): string {
  return React.useSyncExternalStore(
    (onChange) => data.subscribeMeterChange(onChange),
    () => data.getMeterId() ?? DEFAULT_METER_ID,
    () => DEFAULT_METER_ID,
  );
}

export function KitWaveformPanel() {
  const data = useEngineWaveformData();
  const transport = useEngineTransport();

  // Re-read url + duration when the track changes. The engine fires `dataManager:configUpdated`
  // on a new track/orbiter load; duration is also reliably known by the first play, so re-read on
  // transport-state changes too. Cheap, event-driven — no per-frame work here.
  const readTrack = React.useCallback(
    () => ({ url: data.getWaveformUrl(), durationSec: data.getDurationSec(), bpm: data.getTrackBpm(), gridSec: data.getGridMarkerSec() }),
    [data],
  );
  const [track, setTrack] = React.useState(readTrack);
  React.useEffect(() => {
    const reread = () =>
      setTrack((prev) => {
        const next = readTrack();
        return prev.url === next.url && prev.durationSec === next.durationSec && prev.bpm === next.bpm && prev.gridSec === next.gridSec
          ? prev
          : next;
      });
    reread();
    // Track-config change comes through the per-voice `data` facade now (window for
    // single-orbiter), so a new track in another tile doesn't re-read this one. The BPM-edit re-anchor
    // (`orbiters:sync-bpm-change`) stays on window until the sync-MIDI per-voice scope lands separately.
    const offConfig = data.subscribeConfig(reread);
    window.addEventListener('orbiters:sync-bpm-change', reread); // editing the BPM re-anchors the grid
    const offTransport = transport.subscribe(reread);
    return () => {
      offConfig();
      window.removeEventListener('orbiters:sync-bpm-change', reread);
      offTransport();
    };
  }, [readTrack, transport, data]);
  // Re-read after the GRID button moves the grid origin (no event fires for it).
  const rereadTrack = React.useCallback(() => setTrack(readTrack()), [readTrack]);

  const durationSec = Math.max(0.001, track.durationSec);
  const peaks = useWaveformPeaks(track.url);
  const levels: PeakLevels | undefined = React.useMemo(
    () => (peaks && peaks.length ? buildPeakLevels(peaks) : undefined),
    [peaks],
  );

  // Beat-grid projection from the track tempo + grid origin + real meter (drives the kit
  // TimelineGrid/MusicalRuler bar lines AND the metronome's accent — the SAME time signature, so the
  // visual grid and the audible click agree; without a signatureMap the projection silently defaults
  // to 4/4 regardless of the track's actual meter). Built with the clock's MusicalProjection — the
  // authoritative beat↔seconds math — not hand-rolled.
  const meterId = useMeterId(data);
  const meter = React.useMemo(() => parseMeter(meterId), [meterId]);
  const projection = React.useMemo(
    () => (track.bpm
      ? new MusicalProjection({
        tempoMap: [{ startSec: track.gridSec || 0, bpm: track.bpm }],
        signatureMap: [{ startBar: 0, numerator: meter.numerator, denominator: meter.denominator }],
      })
      : null),
    [track.bpm, track.gridSec, meter.numerator, meter.denominator],
  );

  // Zoom/pan owned here (a UI concern). Fit the whole track to the lane on first measure.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [pxPerSec, setPxPerSec] = React.useState(40);
  const [containerW, setContainerW] = React.useState(0);
  const fittedRef = React.useRef(false);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    setContainerW(el.clientWidth);
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The most zoomed-OUT state = the whole track fitting the lane. Never zoom out past that, so the
  // audio always fills the width and the grid stays bounded to it (no audio-vs-grid mismatch / no
  // empty space). = whole-track-fits px/sec; falls back to the floor until the container is measured.
  // Capped at ZOOM_MAX so a very short track can't invert the [min,max] clamp range.
  const minPxPerSec = containerW > 0 ? Math.min(ZOOM_MAX, (containerW * 0.98) / durationSec) : ZOOM_MIN;

  // Re-clamp pxPerSec into [min,max] when the container resizes (e.g. mobile rotate grows the width →
  // minPxPerSec rises); fit() only runs once per track, so without this the grid/playhead drift off.
  React.useEffect(() => {
    setPxPerSec((p) => clamp(p, minPxPerSec, ZOOM_MAX));
  }, [minPxPerSec]);

  const fit = React.useCallback(() => {
    const el = scrollRef.current;
    setPxPerSec(minPxPerSec);
    if (el) el.scrollLeft = 0;
  }, [minPxPerSec]);

  // Re-fit on a new track (the whole-track-to-lane intent must re-run, not stay at the old zoom).
  React.useEffect(() => {
    fittedRef.current = false;
  }, [track.url]);

  // Fit once per track, when both a real width and a real duration are known.
  React.useEffect(() => {
    if (!fittedRef.current && containerW > 0 && track.durationSec > 0) {
      fittedRef.current = true;
      fit();
    }
  }, [containerW, track.durationSec, fit]);

  // Wheel zoom (cursor-anchored) + shift-wheel pan, re-anchored after the px/sec change.
  const pendingAnchor = React.useRef<{ anchorSec: number; cursorX: number } | null>(null);
  useTimelineWheel({
    targetRef: scrollRef,
    pxPerSec,
    min: minPxPerSec,
    max: ZOOM_MAX,
    onZoom: (next, pointer) => {
      const el = scrollRef.current;
      if (!el) return;
      const cursorX = pointer.clientX - el.getBoundingClientRect().left;
      pendingAnchor.current = { anchorSec: (el.scrollLeft + cursorX) / pxPerSec, cursorX };
      setPxPerSec(next);
    },
    onPan: (dx) => {
      const el = scrollRef.current;
      if (el) el.scrollLeft += dx;
    },
  });
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    const p = pendingAnchor.current;
    if (el && p) {
      el.scrollLeft = p.anchorSec * pxPerSec - p.cursorX;
      pendingAnchor.current = null;
    }
  }, [pxPerSec]);

  // Drag-bar zoom: factor>1 lengthens the visible window (zoom out → smaller px/sec).
  const viewSec = containerW > 0 ? Math.min(durationSec, containerW / pxPerSec) : durationSec;
  const onZoomBar = (factor: number, anchorFrac: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const cursorX = anchorFrac * Math.max(1, el.clientWidth);
    pendingAnchor.current = { anchorSec: (el.scrollLeft + cursorX) / pxPerSec, cursorX };
    setPxPerSec(clamp(pxPerSec / factor, minPxPerSec, ZOOM_MAX));
  };

  const playhead = usePlayheadTransport(data, transport);
  const seekCountIn = useSeekCountIn(transport); // Piece 6: blink a marker at a pending quantized seek

  // Loop controls — the full Peaks loop logic (snap grid, in/out at playhead, loop-size in beats,
  // grid origin, engage) reproduced against the engine, so the kit panel owns the whole panel (no
  // Peaks). The chrome row + the waveform's LoopRegion both drive this one controller.
  // (onSeek goes through a ref so the controller doesn't depend on `seek`'s definition order.)
  const seekRef = React.useRef<(sec: number) => void>(() => {});
  // This tile's own voice: the grid-marker commit must persist to the EDITED tile's track, not the
  // focused one (same cross-voice persistence class as tempo/meter).
  const voiceId = useEngineVoiceId();
  const loopControls = useLoopControls(data, {
    trackKey: track.url,
    getVisibleSec: () => viewSec,
    onGridCommit: (s) => {
      commitGridMarkerFromUi(s, voiceId);
      rereadTrack(); // re-read the grid origin so the grid + projection re-anchor
    },
    onSeek: (s) => seekRef.current(s),
  });
  const loop = loopControls.loop;

  // Start cue — where playback begins, set by pressing the waveform (see onPlayCursor). Distinct from
  // the live playhead: it marks the play-from point.
  const [startCueSec, setStartCueSec] = React.useState(0);
  const startCueRef = React.useRef(startCueSec);
  startCueRef.current = startCueSec;
  // A cue set WHILE PLAYING can't seek immediately (that would interrupt playback). Pause stays pause
  // and stop stays stop — we do NOT reposition then. We ARM the cue and apply it only when the user
  // presses PLAY again (the next start begins from the cue, if still armed). Any explicit seek in the
  // meantime (seek strip / playhead scrub) supersedes and disarms it — that clearing lives in seekRaw.
  const armedCueRef = React.useRef(false);
  // Reset the cue + disarm on a track change (a stale arm must not seek the new track to 0).
  React.useEffect(() => {
    setStartCueSec(0);
    armedCueRef.current = false;
  }, [track.url]);
  React.useEffect(() => {
    return transport.subscribe((state) => {
      if (state === 'playing' && armedCueRef.current) {
        armedCueRef.current = false;
        seekRef.current(startCueRef.current);
      }
    });
  }, [transport]);

  const scale = React.useMemo(() => ({ pxPerSec, originSec: 0, durationSec }), [pxPerSec, durationSec]);
  const laneWidth = durationSec * pxPerSec;

  // Raw seek lands the playhead immediately (the engine seek is async); ruler click-seek snaps to the
  // grid (legacy parity), the playhead scrub stays smooth (raw).
  const seekRaw = (sec: number) => {
    armedCueRef.current = false; // an explicit seek (strip / scrub / stopped press) supersedes a pending cue
    const target = Math.max(0, Math.min(durationSec, sec));
    data.seek(target);
    playhead.poke(target);
  };
  seekRef.current = seekRaw;
  const seekSnapped = (sec: number) => seekRaw(loopControls.snapSec(sec));
  // The seek strip jumps the live playhead. From a PAUSED state it also resumes playback (Bruna:
  // "seek to and play if we are in pause") — so a paused user taps a spot and it plays from there.
  const seekStripSeek = (sec: number) => {
    seekSnapped(sec);
    if (transport.getState() === 'paused') transport.play();
  };

  // Start cue: press the waveform to set WHERE PLAYBACK BEGINS (snapped to the grid — free when snap
  // is Off). This is deliberately different from the seek strip: while STOPPED/paused it also moves
  // the playhead to the cue (so the next play starts there); while PLAYING it only moves the cue
  // marker and leaves live playback running (the seek strip is the control that jumps the live
  // playhead). It does NOT touch the grid/downbeat (owned by the diamond). The surface sits below the
  // loop band / playhead / diamond (higher z-index) so their gestures win where they overlap.
  const onPlayCursor = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cue = loopControls.snapSec(Math.max(0, Math.min(durationSec, (e.clientX - rect.left) / pxPerSec)));
    setStartCueSec(cue);
    if (transport.isPlaying()) {
      armedCueRef.current = true; // apply at the next PLAY (seeking mid-play would interrupt)
    } else {
      seekRaw(cue); // stopped/paused: move the playhead to the start point now (seekRaw disarms)
    }
  };

  // Zoom lives ON the musical grid (it IS the zoom grid): drag the grid ↕ to zoom about the cursor
  // (drag DOWN = zoom in, UP = zoom out — Bruna's preferred direction), double-click to fit.
  // anchorFrac is the cursor across the VISIBLE viewport, not the wide lane. Small ± buttons cover
  // discrete / touch zoom.
  const zoomDragY = React.useRef<number | null>(null);
  const zoomAnchorFrac = (clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0.5;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, el.clientWidth)));
  };
  const onZoomGridDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    zoomDragY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onZoomGridMove = (e: React.PointerEvent) => {
    if (zoomDragY.current == null) return;
    const dy = e.clientY - zoomDragY.current;
    zoomDragY.current = e.clientY;
    // NEGATIVE dy exponent: drag down (dy>0) → factor<1 → zoom IN; drag up → zoom OUT.
    onZoomBar(Math.exp(-dy * 0.012), zoomAnchorFrac(e.clientX));
  };
  const onZoomGridUp = (e: React.PointerEvent) => {
    if (zoomDragY.current == null) return;
    zoomDragY.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  return (
    <div className="orbiters-react-ui__kit-waveform" style={rootStyle}>
      {/* ONE continuous glass panel. Rows: musical grid (top of the waveform, doubles as the
          zoom grid) · loop-select · seek-to · waveform (click = play-start cursor) · time (MM:SS) at
          the bottom of the waveform. The surface owns the glass + rounded corners. */}
      <div className="orbiters-react-ui__kit-waveform__surface">
        {/* small zoom control, pinned to the visible top-right (the musical grid itself is the zoom
            surface — drag it to zoom). Fixed to the surface so it doesn't scroll with the lane. */}
        <div className="orbiters-react-ui__kit-waveform__zoom-controls">
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => onZoomBar(1.5, 0.5)}>
            <Icon name="zoom-out" />
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => onZoomBar(1 / 1.5, 0.5)}>
            <Icon name="zoom-in" />
          </button>
        </div>

        <div ref={scrollRef} className="orbiters-react-ui__kit-waveform__lane" style={scrollStyle}>
          {/* ONE viewport wraps the whole stack so every row shares the seconds⇄px scale and scrolls in
              lockstep with the waveform. Each row carries its own relative box for its absolute children. */}
          <TimelineViewport scale={scale} style={{ width: laneWidth, minWidth: '100%', position: 'relative' }}>
            {/* musical grid (bar.beat) = the zoom grid: drag ↕ to zoom about the cursor, dbl-click to fit. */}
            {projection ? (
              <div
                className="orbiters-react-ui__kit-waveform__musical-zoom"
                onPointerDown={onZoomGridDown}
                onPointerMove={onZoomGridMove}
                onPointerUp={onZoomGridUp}
                onPointerCancel={onZoomGridUp}
                onDoubleClick={fit}
                title="Drag ↕ to zoom · double-click to fit"
              >
                <MusicalRuler
                  projection={projection as unknown as KitProjection}
                  className="orbiters-react-ui__kit-waveform__musical-ruler"
                />
              </div>
            ) : null}

            {/* loop-select row — the loop's home: drag an empty part to DRAW a loop, or drag the band
                to MOVE it (moving lives here, not over the waveform). */}
            <div className="orbiters-react-ui__kit-waveform__strip orbiters-react-ui__kit-waveform__loop-strip">
              <span className="orbiters-react-ui__kit-waveform__strip-icon" aria-label="Loop"><Icon name="loop-2" /></span>
              <TimelineRuler showLabels={false} onLoopDraw={loopControls.setLoopRange} className="absolute inset-0 h-full" />
              {loop && loop.endSec > loop.startSec ? (
                <LoopRegion
                  loop={loop}
                  inactive={!loopControls.loopActive}
                  onChange={loopControls.setLoopRange}
                  onSelect={loopControls.toggleLoop}
                  className="orbiters-react-ui__kit-waveform__loop-strip-band"
                />
              ) : null}
            </div>

            {/* seek-to row — click here to seek (snapped to the grid). */}
            <div className="orbiters-react-ui__kit-waveform__strip orbiters-react-ui__kit-waveform__seek-strip">
              <span className="orbiters-react-ui__kit-waveform__strip-icon" aria-label="Seek to"><Icon name="seek-to" /></span>
              <TimelineRuler showLabels={false} onSeek={seekStripSeek} className="absolute inset-0 h-full" />
            </div>

            {/* waveform lane — waveform + grid + markers + loop band + playhead + play-cursor surface. */}
            <div className="orbiters-react-ui__kit-waveform__wave-lane" style={waveLaneStyle}>
              {/* waveform fills the lane, behind the grid/playhead/loop. Coloured with the orbiter's
                  Color A (--color1) so it reads on the cosmic background — the canvas paints currentColor. */}
              <div style={waveLayerStyle}>
                {peaks && peaks.length > 0 ? (
                  <Waveform renderer="canvas" peaks={peaks} levels={levels} amplitude={0.9} style={{ width: '100%', height: '100%' }} />
                ) : null}
              </div>

              {/* beat / bar grid lines from the track tempo (nothing renders without a BPM). Grid step
                  omitted so the lines coarsen with zoom (dense when zoomed in, thinning as you zoom out). */}
              {projection ? <TimelineGrid projection={projection as unknown as KitProjection} /> : null}

              {/* grain activity — a dot per grain + the spray band while this voice's grain
                  engine is audible; renders nothing (and costs nothing) otherwise. */}
              <GrainWaveformLayer voiceId={voiceId} pxPerSec={pxPerSec} />


              {/* start cue — where playback begins (set by pressing the waveform). Sits below the
                  playhead so the live position stays on top when they overlap (stopped state). */}
              <div className="kit-waveform__marker kit-waveform__marker--start-cue" style={{ left: startCueSec * pxPerSec }} />

              {/* loop-in pending anchor (shown after In, before Out completes the loop) */}
              {loopControls.pendingInSec != null ? (
                <div className="kit-waveform__marker kit-waveform__marker--loop-in" style={{ left: loopControls.pendingInSec * pxPerSec }} />
              ) : null}

              {/* A pending quantized SEEK blinks a bar at the SET position with a beat count. */}
              {seekCountIn.active && seekCountIn.seekTargetSec != null ? (
                <div className="kit-waveform__marker kit-waveform__marker--seek-pending" style={{ left: seekCountIn.seekTargetSec * pxPerSec }}>
                  <span className="kit-waveform__seek-count">{seekCountIn.beatsLeft}</span>
                </div>
              ) : null}

              {/* play-start cursor surface — click the waveform to set where playback resumes from. Its
                  z-index (1) is below the loop band (z-10), playhead knob (z-20) and diamond (z-30), so
                  those win their gestures on overlap and the surface only catches empty waveform. */}
              <div className="orbiters-react-ui__kit-waveform__cursor-surface" onClick={onPlayCursor} />

              {/* loop band OVER the waveform: body is display-only (clicks fall through to the play
                  cursor); only the In/Out handles are grabbable (resize). No double-click-to-clear —
                  it was wiping the loop. Moving lives in the loop strip above. */}
              {loop && loop.endSec > loop.startSec ? (
                <LoopRegion
                  loop={loop}
                  inactive={!loopControls.loopActive}
                  onChange={loopControls.setLoopRange}
                  className="orbiters-react-ui__kit-waveform__wave-loop"
                />
              ) : null}

              {/* live playhead with a grabbable scrub knob (raw, smooth scrub) */}
              <Playhead transport={playhead.transport} onScrub={seekRaw} />

              {/* draggable grid downbeat diamond — sets the grid origin (unchanged from before). */}
              {projection ? (
                <DownbeatMarker offsetSec={track.gridSec} onCommit={(s) => loopControls.setGridMarkerSec(s)} style={{ zIndex: 30 }} />
              ) : null}
            </div>

            {/* time ruler (MM:SS) at the BOTTOM of the waveform — the time axis. Interval omitted so
                the label density adapts to the zoom (fine on a short track, coarse on a long one). */}
            <TimelineRuler className="orbiters-react-ui__kit-waveform__time-ruler" />
          </TimelineViewport>
        </div>
      </div>

      {/* live position (left) + total duration (right), below the panel. */}
      <div className="orbiters-react-ui__kit-waveform__readout-row">
        <TimeReadout transport={playhead.transport} className="orbiters-react-ui__kit-waveform__time" />
        <span className="orbiters-react-ui__kit-waveform__time">{formatTimecode(durationSec)}</span>
      </div>

      <LoopChrome controls={loopControls} gridSec={track.gridSec} maxSec={durationSec} />
    </div>
  );
}

const sizeIsActive = (selected: number | null, beats: number) =>
  selected !== null && Math.abs(selected - beats) < 1e-4;

const loopSizeComponentId = (label: string) => `loop-size-${label.replace('/', '-')}`;

/**
 * The loop-chrome row — icon-first rail: Warp / BPM / Downbeat / Snap / In / Out, then an
 * expandable loop-size preset picker, rebuilt as React controls that drive {@link LoopControls}
 * (the engine, not Peaks), so the whole waveform panel is one kit composition. Reuses the orbiter
 * playback-chrome styles (plain buttons driven by root-level `--color1`/`--color3` tokens, NOT the
 * design-lib `Button` — this panel also renders inside the mobile bottom-sheet drawer portal, where
 * the lib's `--primary`/`--color-foreground` tokens don't resolve, see the CSS comment above
 * `.orbiters-react-ui__playback-btn`) and keeps the same MIDI-learn targets as the Peaks panel.
 *
 * The separate Loop enable/disable toggle that used to live here is gone (Bruna: redundant — Loop
 * on/off is already reachable via the transport bar's own toggle (`Transport.tsx`, same MIDI
 * componentId `loop-toggle`) and by clicking the selected loop region on the waveform
 * (`LoopRegion`'s `onSelect={loopControls.toggleLoop}` above)).
 */
function LoopChrome({ controls, gridSec, maxSec }: { controls: LoopControls; gridSec: number; maxSec: number }) {
  const portalContainer = usePortalContainer();
  const t = getT();
  const { snapGrid, snapEnabled, canLoopOut, hasBpm, selectedSizeBeats } = controls;
  const { isMobile } = useNavViewportState();
  // The downbeat's bounds — the shared `ValueParam` value box applies them to drag/wheel AND the
  // keypad entry, so both paths accept the same range.
  const dbMax = Math.max(0.01, maxSec);

  // Pure UI state (no engine/persistence correlate) for the new rail affordances: the subdivision
  // picker's expand/collapse and its mobile paging window. (In/Out's click-confirmation flash is now
  // CornerButton's own built-in `kind="kick"` bracket-flash — no local timer state needed for it.)
  const [subdivOpen, setSubdivOpen] = React.useState(false);
  const visibleLoopSizeCount = isMobile ? MOBILE_LOOP_WINDOW_SIZE : DEFAULT_WINDOW_SIZE;
  // The SAME sliding-window carousel the numeric keypad's grid-tied presets use — one
  // item per chevron press, not a whole window jump.
  const { start: subdivStart, canPrev: canPrevSubdiv, canNext: canNextSubdiv, prev: prevSubdiv, next: nextSubdiv, reveal: revealSubdiv } =
    usePagedWindow(LOOP_SIZES, visibleLoopSizeCount);

  // Reveal the active preset whenever the picker opens (or the selection/mobile state changes
  // while it's open) — otherwise a selection outside the default window is invisible with no
  // indication it's selected at all.
  React.useEffect(() => {
    if (!subdivOpen || !isMobile || selectedSizeBeats == null) return;
    const idx = LOOP_SIZES.findIndex(({ beats }) => sizeIsActive(selectedSizeBeats, beats));
    if (idx < 0) return;
    revealSubdiv(idx);
  }, [subdivOpen, isMobile, selectedSizeBeats, revealSubdiv]);

  // Shared by both the CornerButton click AND the MIDI trigger (useTrigger's onTrigger fires directly
  // from the MIDI dispatcher, never through the button's onClick) so both paths drive the same action.
  const handleLoopIn = React.useCallback(() => controls.loopIn(), [controls]);
  const handleLoopOut = React.useCallback(() => controls.loopOut(), [controls]);
  const loopInMidi = useTrigger({ componentId: 'loop-in', scope: 'GLOBAL', onTrigger: handleLoopIn });
  const loopOutMidi = useTrigger({ componentId: 'loop-out', scope: 'GLOBAL', onTrigger: handleLoopOut });
  const snapMidi = useToggle({ componentId: 'loop-snap', scope: 'GLOBAL', value: snapEnabled, onToggle: () => controls.toggleSnap() });
  // Per-orbiter WRAP — whether THIS orbiter's audio locks/time-stretches to the shared tempo
  // (ON, default) or plays free at its natural rate (OFF). Read source of truth on each toggle so the
  // local mirror never goes stale; MIDI + click converge on the same action.
  const voiceId = useEngineVoiceId();
  const [wrapOn, setWrapOn] = React.useState(() => deckFor(voiceId)?.warp !== false);
  const toggleWrap = React.useCallback(() => {
    const deck = deckFor(voiceId);
    deck?.setWarp(deck?.warp === false);
    // Mirror the ACTUAL result, not the requested one — a speed-locked deck refuses warp-on.
    setWrapOn(deck?.warp !== false);
  }, [voiceId]);
  const wrapMidi = useToggle({ componentId: 'wrap-toggle', scope: 'GLOBAL', value: wrapOn, onToggle: toggleWrap, id: 'pm-wrap-toggle-kit' });
  // Mobile speed lock: when this voice's audio is pinned to native rate, warp can't do its one job
  // (time-stretch), so the deck forces it off + refuses re-enable. Mirror that here to grey out the
  // control. The engine fans the `orbiters:speed-control-lock` event on every lock change; re-read the
  // deck (source of truth) on it and on active-voice switch.
  const [speedLocked, setSpeedLocked] = React.useState(() => deckFor(voiceId)?.speedLocked === true);
  // No-tempo lock: a track without a tempo can't warp (nothing to stretch to) — the deck forces
  // warp off and refuses re-enable until the user sets the track BPM below. The deck broadcasts
  // every state change on WRAP_GRID_CHANGE_EVENT, which covers track load and the BPM commit.
  const [tempoMissing, setTempoMissing] = React.useState(() => deckFor(voiceId)?.tempoMissing === true);
  React.useEffect(() => {
    const sync = (event?: Event) => {
      // The deck event fires for every deck and reason — only re-read for OUR voice (no detail =
      // the speed-lock event or the initial call: always re-read).
      const detail = (event as CustomEvent | undefined)?.detail;
      if (detail?.voiceId != null && detail.voiceId !== voiceId) return;
      setSpeedLocked(deckFor(voiceId)?.speedLocked === true);
      setTempoMissing(deckFor(voiceId)?.tempoMissing === true);
      setWrapOn(deckFor(voiceId)?.warp !== false);
    };
    sync();
    document.addEventListener('orbiters:speed-control-lock', sync);
    window.addEventListener(WRAP_GRID_CHANGE_EVENT, sync);
    return () => {
      document.removeEventListener('orbiters:speed-control-lock', sync);
      window.removeEventListener(WRAP_GRID_CHANGE_EVENT, sync);
    };
  }, [voiceId]);
  // "Unlock speed": the speed lock exists because long tracks auto-STREAM on mobile and a stream
  // can't stretch. A conscious user can force the track into the buffered/RAM backend — the engine
  // owns the whole reload (single-flight, reverts to streaming on failure); success re-fans the
  // speed-lock event, which flips this UI back to the normal Warp control by itself.
  const [unlockPending, setUnlockPending] = React.useState(false);
  const [unlockFailed, setUnlockFailed] = React.useState(false);
  // The download outlives this panel (PlaybackPanel unmounts it when another region opens) — the
  // engine keeps going; just don't write state into an unmounted tree when the promise settles.
  const unlockMountedRef = React.useRef(true);
  React.useEffect(() => {
    unlockMountedRef.current = true;
    return () => { unlockMountedRef.current = false; };
  }, []);
  const requestUnlockSpeed = React.useCallback(() => {
    const engine = resolveEngine(voiceId);
    if (!engine?.requestBufferedReload || engine.isBufferedReloadPending?.()) return;
    setUnlockPending(true);
    setUnlockFailed(false);
    // This flow must NEVER end silent: a failed load deliberately reverts to
    // streaming and RE-LOCKS everything, and on touch devices (no hover
    // tooltips) a missing signal reads as "downloaded but still dead". The
    // engine watchdogs guarantee the promise settles; catch covers any reject.
    void engine.requestBufferedReload()
      .catch((error: unknown) => {
        console.warn('[KitWaveformPanel] Buffered unlock rejected:', error);
        return false;
      })
      .then((ok: boolean) => {
        if (!ok) {
          notifications.showToast(getT()('notifications.bufferedLoadFailed'), 'warning', 8000);
        }
        if (!unlockMountedRef.current) return;
        setUnlockPending(false);
        setUnlockFailed(!ok);
      });
  }, [voiceId]);
  const loopSizeMidi = useTriggerGroup(
    LOOP_SIZES.map(({ beats, label }) => ({
      componentId: loopSizeComponentId(label),
      scope: 'GLOBAL' as const,
      onTrigger: () => controls.selectLoopSize(beats),
    })),
  );

  // The subdivision-expand button shows the CURRENTLY SELECTED loop size as its own caption (matching
  // the mock — no separate "size"/"subdiv" label, the value doubles as the label) rather than a static
  // word, so a quick glance says what's selected without opening the picker.
  const currentSizeLabel = LOOP_SIZES.find(({ beats }) => sizeIsActive(selectedSizeBeats, beats))?.label ?? '—';

  return (
    <div className="orbiters-react-ui__playback-chrome">
      <div className="orbiters-react-ui__playback-row" data-mobile={isMobile || undefined}>
        {/* Rail order (Bruna): Warp · BPM · Downbeat · Snap · In · Out · Loop Options. In/Out/Snap/Warp/
            subdivision-expand are all the shared `CornerButton` — the SAME ghost icon-button primitive
            Transport.tsx uses for Play/Stop/Record/Loop (`kind="kick"` momentary, `kind="toggle"` on/off),
            not a hand-rolled button; its built-in 180ms bracket-flash replaces the old inFlash/outFlash
            timers. Downbeat + BPM are the two `Param` readouts (value row on top, label under). */}
        {/* Appears only while the mobile speed lock is on: the escape hatch out of streaming mode.
            Sits BESIDE the (disabled) Warp toggle rather than replacing it — Warp keeps its MIDI
            identity (wrap-toggle) mounted, and the rail explains itself: locked warp + the unlock. */}
        {speedLocked ? (
          <CornerButton
            kind="kick"
            onClick={requestUnlockSpeed}
            disabled={unlockPending}
            icon={unlockPending
              ? <span className="orbiters-react-ui__kit-waveform__unlock-orbit" aria-hidden />
              : <LockOpen size={18} strokeWidth={1} />}
            label="Unlock speed"
            aria-label="Unlock speed: download the full track to enable speed and warp"
            title={unlockPending
              ? 'Downloading the full track…'
              : unlockFailed
                ? 'Download failed — still streaming. Tap to try again.'
                : 'Download the full track into memory to unlock speed and warp on this device'}
          />
        ) : null}
        <CornerButton
          kind="toggle"
          pressed={wrapOn && !speedLocked && !tempoMissing}
          onPressedChange={toggleWrap}
          disabled={speedLocked || tempoMissing}
          icon={<AudioWaveform size={18} strokeWidth={1} />}
          label="Warp"
          {...wrapMidi.midiProps}
          aria-label="Warp: lock this deck to the main tempo"
          title={tempoMissing
            ? 'This track has no tempo yet — set its BPM to enable warp'
            : speedLocked
              ? "Warp is off on mobile — audio plays at the song's native tempo"
              : "Warp: lock this deck to the main tempo (off = play at the song's native tempo, still in the session)"}
        />
        <div className="orbiters-react-ui__playback-item">
          <ParameterizedParam
            rootParam="sync-track-bpm"
            min={20}
            max={300}
            step={0.01}
            bidirectional
            keyboard="value-only"
            aria-label="Audio BPM"
            onCommit={(bpm) => commitTrackBpmFromUi(bpm, voiceId)}
          />
          <span className="orbiters-react-ui__playback-item-label">BPM</span>
        </div>
        {/* Downbeat offset (replaces the old "Grid 1" set-from-playhead button): the SAME `Param` BPM
            uses. Value row on top, label under — the diamond is a small inline glyph to the LEFT of the
            number (it echoes the ruler's draggable downbeat marker). Routes controls.setGridMarkerSec →
            the same engine + persist path (sync.gridMarkers[0].sourceTimeSec), so saved grids stay
            backward-compatible. Needs a track BPM (read-only until then). */}
        <div className="orbiters-react-ui__playback-item" title={hasBpm ? t('tooltips.playbackToolbar.gridMarker') : t('playbackToolbar.gridMarkerDisabled')}>
          <div className="orbiters-react-ui__playback-item-value">
            <Diamond size={14} strokeWidth={1} className="orbiters-react-ui__playback-item-icon" aria-hidden="true" />
            <ValueParam
              label="Downbeat"
              value={gridSec}
              min={0}
              max={dbMax}
              step={0.01}
              precision={2}
              readOnly={!hasBpm}
              format={(x) => `${x.toFixed(2)}s`}
              onValueCommit={(v) => controls.setGridMarkerSec(v)}
            />
          </div>
          <span className="orbiters-react-ui__playback-item-label">Downbeat</span>
        </div>
        {/* Snap magnet — pick the grid the loop edges + seeks snap to. "Auto" (default) keeps the
            zoom-adaptive step; "Off" disables snapping; the fixed grids force a resolution. Folds in
            the old on/off Snap button (Off = disabled). MIDI-learn on the trigger flips snap off/on.
            QuantizeMenu keeps owning the popover/selection logic (don't fork it); its `trigger` prop
            (added for this) lets us swap in a CornerButton face instead of the default pill. */}
        <QuantizeMenu
          value={snapGrid}
          onValueChange={controls.setSnapGrid}
          presets={SNAP_PRESETS}
          heading="Snap to grid"
          noneLabel="Off"
          container={portalContainer}
          trigger={({ current }) => (
            <CornerButton
              icon={<Magnet size={18} strokeWidth={1} />}
              label={current}
              dropIndicator="down"
              aria-label={`Snap to grid — ${snapEnabled ? snapGrid : 'off'}`}
              {...snapMidi.midiProps}
            />
          )}
        />
        <CornerButton
          kind="kick"
          icon={<FlagTriangleRight size={18} strokeWidth={1} />}
          label="In"
          {...loopInMidi.midiProps}
          onClick={handleLoopIn}
          aria-label={t('tooltips.playbackToolbar.loopIn')}
        />
        <CornerButton
          kind="kick"
          icon={<FlagTriangleLeft size={18} strokeWidth={1} />}
          label="Out"
          disabled={!canLoopOut}
          {...loopOutMidi.midiProps}
          onClick={handleLoopOut}
          aria-label={t('tooltips.playbackToolbar.loopOut')}
        />
        {/* Loop Options — subdivision picker expand/collapse; hides the loop-size presets behind one tap.
            Caption is the CURRENT selection (e.g. "16"), not a static word; the icon rotates 180° open. */}
        <CornerButton
          kind="toggle"
          className="orbiters-react-ui__subdiv-toggle"
          data-mobile={isMobile || undefined}
          pressed={subdivOpen}
          onPressedChange={setSubdivOpen}
          icon={
            <Repeat
              size={18}
              strokeWidth={1}
              style={{ transform: subdivOpen ? 'rotate(180deg)' : undefined, transition: 'transform 160ms ease' }}
            />
          }
          label={currentSizeLabel}
          aria-label="Toggle loop-size presets"
        />
      </div>

      {
        // ALWAYS mounted (hidden via CSS when collapsed), never conditionally unmounted — useTriggerGroup
        // registers each loopSizeMidi target by DOM id in a one-shot effect keyed on the (static)
        // componentId list, not on subdivOpen, so unmounting this block would find no elements to attach
        // to on first render and never re-register when it later mounts (verified in review; matches
        // the pattern CollapsedMidiAnchors.tsx documents for the same class of bug elsewhere).
      }
      <div
        className="orbiters-react-ui__playback-sizes"
        data-mobile={isMobile || undefined}
        role="group"
        aria-label="Loop size"
        style={subdivOpen ? undefined : { display: 'none' }}
      >
        {
          /* Mobile: slide through the 11 presets one at a time (usePagedWindow) instead of
             wrapping onto extra rows. Desktop: the full row (unchanged). All 11 buttons stay
             mounted either way (only their visibility toggles) so every loopSizeMidi MIDI-learn
             trigger stays live off-window too. */
        }
          {isMobile ? (
            <CornerButton
              layout="icon"
              icon={<ChevronLeft size={16} strokeWidth={1.6} />}
              aria-label="Earlier loop sizes"
              disabled={!canPrevSubdiv}
              onClick={prevSubdiv}
            />
          ) : null}
          {LOOP_SIZES.map(({ beats, label }, i) => {
            const hiddenOnMobile = isMobile && (i < subdivStart || i >= subdivStart + visibleLoopSizeCount);
            return (
              <button
                key={label}
                type="button"
                className={`orbiters-react-ui__playback-btn orbiters-react-ui__playback-size${sizeIsActive(selectedSizeBeats, beats) ? ' is-active' : ''}`}
                style={hiddenOnMobile ? { display: 'none' } : undefined}
                disabled={!hasBpm}
                {...loopSizeMidi(loopSizeComponentId(label))}
                onClick={() => controls.selectLoopSize(beats)}
                aria-pressed={sizeIsActive(selectedSizeBeats, beats)}
              >
                {label}
              </button>
            );
          })}
          {isMobile ? (
            <CornerButton
              layout="icon"
              icon={<ChevronRight size={16} strokeWidth={1.6} />}
              aria-label="Later loop sizes"
              disabled={!canNextSubdiv}
              onClick={nextSubdiv}
            />
          ) : null}
      </div>
    </div>
  );
}

const rootStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', minHeight: 0, position: 'relative' };
// `overflow-x: scroll` (not auto) ALWAYS reserves the horizontal scrollbar's space, so zooming
// in/out (overflow appearing/disappearing) never shifts the surface height + everything below it.
const scrollStyle: React.CSSProperties = { overflowX: 'scroll', overflowY: 'hidden', position: 'relative', minHeight: 0 };
// The waveform LANE carries an explicit height (`--waveform-height` — a fraction of the box height so
// it shrinks with the tile); the ruler rows above it are thin (CSS-sized). A `height:100%` chain here
// resolves to 0 because the panel root is content-sized (circular % height) — which collapsed the
// waveform to nothing. The fallback mirrors the token so a body-portalled drawer (no `.orbiters-react-ui`
// ancestor to inherit it) still sizes sanely.
const waveLaneStyle: React.CSSProperties = { position: 'relative', width: '100%', height: 'var(--waveform-height, clamp(4.5rem, calc(20 * var(--orb-vp-h)), 18rem))' };
const waveLayerStyle: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', color: 'var(--color1, #ffffff)' };
