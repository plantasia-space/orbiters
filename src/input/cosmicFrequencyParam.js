/**
 * Shared constants + helpers for the manual Cosmic LFO frequency parameter
 * (Option B). The manual frequency is promoted to a dimensional ParameterManager
 * param (`${axis}-cosmic-frequency`) so a React knob + MIDI drive it uniformly with
 * the axis knobs. The param is KEPT (strategy §7); `<CosmicLfoPanel>` (Phase 2) is
 * its next consumer, via the InputSource seam.
 *
 * Range constants live here (single source of truth — `FrequencySourceManager.ts`
 * re-exports them as MIN/MAX_FREQUENCY_HZ) so the typed cosmic kernel and the JS
 * edit-mode registration share them without coupling their import graphs.
 */

// Physical range of the manual cosmic LFO frequency (Hz).
export const COSMIC_FREQ_MIN = 0.001;
export const COSMIC_FREQ_MAX = 21;

/** PM param name for an axis's manual cosmic frequency (e.g. "x-cosmic-frequency"). */
export function cosmicFrequencyParamId(axis) {
  return `${axis}-cosmic-frequency`;
}
