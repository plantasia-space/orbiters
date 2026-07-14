function resolveDurationSecFromWaveformJson(waveformJson = null) {
  if (!waveformJson || typeof waveformJson !== 'object') return null;
  const directDuration = Number(
    waveformJson.duration ?? waveformJson.duration_sec ?? waveformJson.durationSec,
  );
  if (Number.isFinite(directDuration) && directDuration > 0) {
    return directDuration;
  }
  const frames = Number(waveformJson.length);
  const samplesPerPixel = Number(
    waveformJson.samples_per_pixel ?? waveformJson.samplesPerPixel,
  );
  const sampleRate = Number(waveformJson.sample_rate ?? waveformJson.sampleRate);
  if (!Number.isFinite(frames) || frames <= 0) return null;
  if (!Number.isFinite(samplesPerPixel) || samplesPerPixel <= 0) return null;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const derived = (frames * samplesPerPixel) / sampleRate;
  return Number.isFinite(derived) && derived > 0 ? derived : null;
}

export async function hydrateTrackDurationFromWaveform(track = null, { timeoutMs = 1500 } = {}) {
  if (!track || typeof track !== 'object') return track;
  const knownDurationSec = Number(
    track.durationSec ??
    track.metadata?.durationSec ??
    track.metadata?.audioAnalysis?.duration_sec,
  );
  if (Number.isFinite(knownDurationSec) && knownDurationSec > 0) return track;

  const waveformUrl = track.waveformJSONURL || track.waveformURL || track.waveformJsonUrl || null;
  if (!waveformUrl) return track;

  let timeoutId = null;
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.round(Number(timeoutMs))
      : 1500;
    timeoutId = controller
      ? setTimeout(() => {
          try {
            controller.abort();
          } catch (_) {}
        }, timeout)
      : null;
    const response = await fetch(waveformUrl, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) return track;
    const waveformJson = await response.json();
    const durationSec = resolveDurationSecFromWaveformJson(waveformJson);
    if (!Number.isFinite(durationSec) || durationSec <= 0) return track;

    const metadata = track.metadata && typeof track.metadata === 'object'
      ? { ...track.metadata }
      : {};
    const audioAnalysis = metadata.audioAnalysis && typeof metadata.audioAnalysis === 'object'
      ? { ...metadata.audioAnalysis }
      : {};
    if (!Number.isFinite(Number(audioAnalysis.duration_sec)) || Number(audioAnalysis.duration_sec) <= 0) {
      audioAnalysis.duration_sec = durationSec;
    }
    metadata.audioAnalysis = audioAnalysis;
    metadata.durationSec = Number.isFinite(Number(metadata.durationSec)) && Number(metadata.durationSec) > 0
      ? metadata.durationSec
      : durationSec;

    return {
      ...track,
      metadata,
      durationSec,
      durationMs: Math.round(durationSec * 1000),
    };
  } catch (_) {
    return track;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export default hydrateTrackDurationFromWaveform;
