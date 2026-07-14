const DEFAULT_MIN_LOOP_LENGTH_MS = 10;

function toPositiveFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function normalizeLoopRange(startMs, endMs, {
  durationMs = null,
  endEpsilonMs = 0,
  minLengthMs = DEFAULT_MIN_LOOP_LENGTH_MS,
} = {}) {
  const start = Number(startMs);
  const end = Number(endMs);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  const minLength = toPositiveFiniteNumber(minLengthMs, DEFAULT_MIN_LOOP_LENGTH_MS);
  const clampedStart = Math.max(0, Math.min(start, end));
  const desiredEnd = Math.max(clampedStart + minLength, end);
  const durationLimit = toPositiveFiniteNumber(durationMs, null);
  if (!durationLimit) {
    return { start: clampedStart, end: desiredEnd };
  }

  const epsilon = Math.max(0, Number(endEpsilonMs) || 0);
  const safeMaxEnd = Math.max(clampedStart + minLength, durationLimit - epsilon);
  return {
    start: clampedStart,
    end: Math.max(clampedStart + minLength, Math.min(desiredEnd, safeMaxEnd)),
  };
}
