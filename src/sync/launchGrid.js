/**
 * @file sync/launchGrid.js
 * @description the launch-quantize GRID boot seed, in bars. Live-style launch quantization
 * (2 bars / 1 bar / 1/2 / 1/4 / 1/8 ...), plus 0 = "none" (no snap — the launch fires immediately).
 *
 * The live grid is PER-DECK (each player owns `launchGridBars` on its Deck, like meter). This module
 * holds only the realm BOOT value — the URL-pinnable seed a new deck starts from — plus the id/beat
 * conversion helpers. It is not a live source of truth after boot.
 */
import { DEFAULT_METER_ID, sharedBeatsPerBar } from './meter.js';

// Default NONE (product decision): quantized launching is opt-in — a fresh player fires Play
// immediately until the user picks a grid, synced or not.
export const DEFAULT_LAUNCH_GRID_BARS = 0;
export const DEFAULT_LAUNCH_GRID_BEATS = 4; // legacy 4/4-compatible alias for URL/tests
export const LAUNCH_GRID_NONE = 0; // no quantization — the launch fires immediately (no snap)

let gridBars = DEFAULT_LAUNCH_GRID_BARS;
const listeners = new Set();

/** The current launch grid, in bars (0 = none / no snap). */
export function getLaunchGridBars() {
  return gridBars;
}

/** The current launch grid expressed in quarter-note beats for a meter. */
export function getLaunchGridQuarterBeats(meter = DEFAULT_METER_ID) {
  if (!(gridBars > 0)) return LAUNCH_GRID_NONE;
  return gridBars * sharedBeatsPerBar(meter);
}

/** Legacy 4/4-compatible read seam; prefer getLaunchGridBars/getLaunchGridQuarterBeats. */
export function getLaunchGridBeats() {
  return gridBars === 0 ? 0 : gridBars * DEFAULT_LAUNCH_GRID_BEATS;
}

/**
 * Subscribe to launch-grid changes so every surface (all in-tab orbiter pickers) reflects the ONE
 * grid — the module var is the single source of truth, the UI never keeps a private copy. Returns an
 * unsubscribe fn.
 * @param {(bars: number) => void} fn
 * @returns {() => void}
 */
export function subscribeLaunchGrid(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Set the launch grid (bars per launch boundary; 0 = none / no snap). Ignores null/undefined and
 * non-finite / negative values so a stray UI/URL value can never disable quantization by accident.
 * Notifies subscribers only on a real change. Returns the effective grid.
 * @param {number} bars
 */
export function setLaunchGridBars(bars) {
  if (bars == null) return gridBars; // no-op on null/undefined (never a stray disable)
  const n = Number(bars);
  if (Number.isFinite(n) && n >= 0 && n !== gridBars) {
    gridBars = n;
    for (const fn of listeners) {
      try {
        fn(gridBars);
      } catch (e) {
        console.warn('[launchGrid] subscriber threw:', e);
      }
    }
  }
  return gridBars;
}

/** Legacy 4/4-compatible write seam; converts beat counts to bar counts. */
export function setLaunchGridBeats(beats) {
  if (beats == null) return getLaunchGridBeats();
  const n = Number(beats);
  if (!Number.isFinite(n) || n < 0) return getLaunchGridBeats();
  setLaunchGridBars(n === 0 ? 0 : n / DEFAULT_LAUNCH_GRID_BEATS);
  return getLaunchGridBeats();
}
