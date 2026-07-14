/**
 * @file src/multi/stageGeometry.js
 * @description Pure geometry for the multi-stage Orbiter Studio (decisions/0004) — a verbatim
 * port of root's resizable-slot math (`plantasia.space-root` `orbiter-grid.tsx`). No DOM, no React: the
 * React shell (`MultiStageStudio`) consumes these to lay out 1–4 resizable stages, and the compositor
 * reads the resulting rects. Kept framework-free so the exact UX constants (snap magnets, min/max, gap,
 * handle) are one source of truth and unit-testable.
 */

// --- Ported constants (exact values from root's orbiter-grid.tsx) ---
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;
export const SPLIT_SNAP_POINTS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
export const SNAP_THRESHOLD = 0.045; // ratio units (~4.5% of the container edge)
export const SLOT_GAP = 8; // px between stages (half is inlined into the calc() offsets)
export const HALF_GAP = SLOT_GAP / 2; // 4px
export const HANDLE_SIZE = 12; // px divider hit-size
export const HALF_HANDLE = HANDLE_SIZE / 2; // 6px
export const LAYOUT_TRANSITION_MS = 340;
// Slot identity labels for the four collection stages. LETTERS (not Roman numerals) on purpose:
// dimensions already own Roman numerals (I…X), so slots use A–D to stay unambiguously distinct.
export const SLOT_LABELS = ['A', 'B', 'C', 'D'];

export const clampRatio = (v) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, v));

/** Clamp to [MIN,MAX], then snap to the nearest magnet if within SNAP_THRESHOLD (else the clamped value). */
export function snapRatio(v) {
  const clamped = clampRatio(v);
  let nearest = clamped;
  let nearestDist = Infinity;
  for (const point of SPLIT_SNAP_POINTS) {
    const dist = Math.abs(clamped - point);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = point;
    }
  }
  return nearestDist <= SNAP_THRESHOLD ? nearest : clamped;
}

/** Clamp a stage count into the supported 1–4 range. */
export function clampSubtype(n) {
  return Math.min(4, Math.max(1, Math.floor(Number.isFinite(n) ? n : 1)));
}

/** The initial visible stage count: a saved subtype if present, else the roster length (clamped 1–4).
 *  ONE source for both the layout's initial state and the realm's initially-booted voice slice. */
export function defaultSubtype(savedLayout, rosterLength) {
  return clampSubtype(savedLayout?.subtype ?? Math.max(1, rosterLength || 1));
}

const pct = (r) => `${r * 100}%`;

/**
 * Per-count stage rectangles as CSS `left/top/width/height` strings, derived from the three split
 * ratios. A direct transcription of root's per-`slotCount` branches (2px→4px half-gap offsets inlined).
 * @returns {Array<{left:string, top:string, width:string, height:string}>}
 */
export function slotStylesFor(count, splitY, splitXPrimary, splitXSecondary) {
  if (count <= 1) {
    return [{ left: '0', top: '0', width: '100%', height: '100%' }];
  }
  if (count === 2) {
    return [
      { left: '0', top: '0', width: `calc(${pct(splitXPrimary)} - ${HALF_GAP}px)`, height: '100%' },
      {
        left: `calc(${pct(splitXPrimary)} + ${HALF_GAP}px)`,
        top: '0',
        width: `calc(${pct(1 - splitXPrimary)} - ${HALF_GAP}px)`,
        height: '100%',
      },
    ];
  }
  if (count === 3) {
    return [
      { left: '0', top: '0', width: '100%', height: `calc(${pct(splitY)} - ${HALF_GAP}px)` },
      {
        left: '0',
        top: `calc(${pct(splitY)} + ${HALF_GAP}px)`,
        width: `calc(${pct(splitXSecondary)} - ${HALF_GAP}px)`,
        height: `calc(${pct(1 - splitY)} - ${HALF_GAP}px)`,
      },
      {
        left: `calc(${pct(splitXSecondary)} + ${HALF_GAP}px)`,
        top: `calc(${pct(splitY)} + ${HALF_GAP}px)`,
        width: `calc(${pct(1 - splitXSecondary)} - ${HALF_GAP}px)`,
        height: `calc(${pct(1 - splitY)} - ${HALF_GAP}px)`,
      },
    ];
  }
  // count === 4 (2×2)
  return [
    {
      left: '0',
      top: '0',
      width: `calc(${pct(splitXPrimary)} - ${HALF_GAP}px)`,
      height: `calc(${pct(splitY)} - ${HALF_GAP}px)`,
    },
    {
      left: `calc(${pct(splitXPrimary)} + ${HALF_GAP}px)`,
      top: '0',
      width: `calc(${pct(1 - splitXPrimary)} - ${HALF_GAP}px)`,
      height: `calc(${pct(splitY)} - ${HALF_GAP}px)`,
    },
    {
      left: '0',
      top: `calc(${pct(splitY)} + ${HALF_GAP}px)`,
      width: `calc(${pct(splitXSecondary)} - ${HALF_GAP}px)`,
      height: `calc(${pct(1 - splitY)} - ${HALF_GAP}px)`,
    },
    {
      left: `calc(${pct(splitXSecondary)} + ${HALF_GAP}px)`,
      top: `calc(${pct(splitY)} + ${HALF_GAP}px)`,
      width: `calc(${pct(1 - splitXSecondary)} - ${HALF_GAP}px)`,
      height: `calc(${pct(1 - splitY)} - ${HALF_GAP}px)`,
    },
  ];
}

/**
 * The dividers for a given count: which axis (`x` drives a vertical bar / col-resize; `y` drives a
 * horizontal bar / row-resize), which ratio they control, and their box. Mirrors root's handle layout.
 * @returns {Array<{ratio:'y'|'xPrimary'|'xSecondary', axis:'x'|'y', style:{left:string,top:string,width:string,height:string}}>}
 */
export function dividersFor(count, splitY, splitXPrimary, splitXSecondary) {
  if (count === 2) {
    return [
      {
        ratio: 'xPrimary',
        axis: 'x',
        style: { left: `calc(${pct(splitXPrimary)} - ${HALF_HANDLE}px)`, top: '0', width: `${HANDLE_SIZE}px`, height: '100%' },
      },
    ];
  }
  if (count === 3) {
    return [
      {
        ratio: 'y',
        axis: 'y',
        style: { left: '0', top: `calc(${pct(splitY)} - ${HALF_HANDLE}px)`, width: '100%', height: `${HANDLE_SIZE}px` },
      },
      {
        ratio: 'xSecondary',
        axis: 'x',
        style: {
          left: `calc(${pct(splitXSecondary)} - ${HALF_HANDLE}px)`,
          top: `calc(${pct(splitY)} + ${HALF_GAP}px)`,
          width: `${HANDLE_SIZE}px`,
          height: `calc(${pct(1 - splitY)} - ${HALF_GAP}px)`,
        },
      },
    ];
  }
  if (count >= 4) {
    return [
      {
        ratio: 'y',
        axis: 'y',
        style: { left: '0', top: `calc(${pct(splitY)} - ${HALF_HANDLE}px)`, width: '100%', height: `${HANDLE_SIZE}px` },
      },
      {
        ratio: 'xPrimary',
        axis: 'x',
        style: {
          left: `calc(${pct(splitXPrimary)} - ${HALF_HANDLE}px)`,
          top: '0',
          width: `${HANDLE_SIZE}px`,
          height: `calc(${pct(splitY)} - ${HALF_GAP}px)`,
        },
      },
      {
        ratio: 'xSecondary',
        axis: 'x',
        style: {
          left: `calc(${pct(splitXSecondary)} - ${HALF_HANDLE}px)`,
          top: `calc(${pct(splitY)} + ${HALF_GAP}px)`,
          width: `${HANDLE_SIZE}px`,
          height: `calc(${pct(1 - splitY)} - ${HALF_GAP}px)`,
        },
      },
    ];
  }
  return [];
}
