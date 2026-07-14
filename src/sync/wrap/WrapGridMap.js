function toPositiveNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

const MAX_GRID_LINES_PER_RENDER = 2048;

export function getSecondsPerBeat(trackBpm) {
  const bpm = toPositiveNumber(trackBpm, null);
  return bpm ? 60 / bpm : null;
}

export function getSourceAudioTimeSec({ syncBeat = 1, gridStartTimeSec = 0, trackBpm = null } = {}) {
  const secondsPerBeat = getSecondsPerBeat(trackBpm);
  const beat = Number(syncBeat);
  const startSec = Number(gridStartTimeSec);
  if (!secondsPerBeat || !Number.isFinite(beat) || !Number.isFinite(startSec)) {
    return null;
  }
  return startSec + ((beat - 1) * secondsPerBeat);
}

export function wrapSourcePositionMs({ sourceTimeSec = 0, durationMs = 0, loopRange = null } = {}) {
  const sourceMs = Number(sourceTimeSec) * 1000;
  if (!Number.isFinite(sourceMs)) return null;

  const loopStart = Number(loopRange?.start);
  const loopEnd = Number(loopRange?.end);
  const hasLoop = Number.isFinite(loopStart) && Number.isFinite(loopEnd) && loopEnd > loopStart;
  const loopLength = hasLoop ? loopEnd - loopStart : null;

  if (hasLoop && loopLength > 0) {
    const offset = ((sourceMs - loopStart) % loopLength + loopLength) % loopLength;
    return loopStart + offset;
  }

  const totalDuration = Number(durationMs);
  if (Number.isFinite(totalDuration) && totalDuration > 0) {
    return ((sourceMs % totalDuration) + totalDuration) % totalDuration;
  }

  return Math.max(0, sourceMs);
}

export function getBeatLinesInRange({
  rangeStartSec = 0,
  rangeEndSec = 0,
  gridStartTimeSec = 0,
  trackBpm = null,
  beatsPerBar = 4,
} = {}) {
  const secondsPerBeat = getSecondsPerBeat(trackBpm);
  const start = Number(rangeStartSec);
  const end = Number(rangeEndSec);
  const gridStart = Number(gridStartTimeSec);
  const beatsInBar = Math.max(1, Math.round(Number(beatsPerBar) || 4));

  if (!secondsPerBeat || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(gridStart)) {
    return [];
  }

  const epsilon = secondsPerBeat * 0.0001;
  const firstIndex = Math.max(0, Math.ceil(((start - gridStart) / secondsPerBeat) - epsilon));
  const lastIndex = Math.max(firstIndex, Math.floor(((end - gridStart) / secondsPerBeat) + epsilon));
  const lineCount = lastIndex - firstIndex + 1;

  if (!Number.isFinite(lineCount) || lineCount <= 0) {
    return [];
  }

  // Defend against pathological zoom/range states that would otherwise try to
  // create an unbounded number of grid DOM nodes and lock the browser.
  if (lineCount > MAX_GRID_LINES_PER_RENDER) {
    return [];
  }

  const lines = [];

  for (let beatIndex = firstIndex; beatIndex <= lastIndex; beatIndex += 1) {
    const timeSec = gridStart + (beatIndex * secondsPerBeat);
    if (timeSec < start - epsilon || timeSec > end + epsilon) continue;
    lines.push({
      beatIndex,
      beatNumber: beatIndex + 1,
      barNumber: Math.floor(beatIndex / beatsInBar) + 1,
      isBarLine: beatIndex % beatsInBar === 0,
      timeSec,
    });
  }

  return lines;
}
