/**
 * Shared duration resolver for playback backends.
 */
export function resolveTrackDurationMs(trackData = {}) {
  const metadata = trackData?.metadata || {};

  const durationMsCandidates = [
    trackData?.durationMs,
    metadata?.durationMs,
    metadata?.audioAnalysis?.duration_ms,
    metadata?.audioAnalysis?.durationMs,
    metadata?.audioNormalization?.duration_ms,
    metadata?.audioNormalization?.durationMs,
  ];
  for (const candidate of durationMsCandidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }

  const durationSecCandidates = [
    trackData?.durationSec,
    metadata?.durationSec,
    metadata?.duration_sec,
    metadata?.audioAnalysis?.duration_sec,
    metadata?.audioAnalysis?.durationSec,
    metadata?.audioNormalization?.durationSec,
    metadata?.audioNormalization?.duration_sec,
    trackData?.duration,
  ];
  for (const candidate of durationSecCandidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric * 1000;
    }
  }

  return 0;
}

/**
 * Shared duration resolver in seconds for adaptive/safety decisions.
 * Returns `null` when a valid positive duration cannot be resolved.
 */
export function resolveTrackDurationSec(trackData = {}) {
  const durationMs = resolveTrackDurationMs(trackData);
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : null;
}

export default resolveTrackDurationMs;
