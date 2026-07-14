const NETWORK_SPEED_HINT_KEY = 'orbiters:network-speed-hint:v1';
const NETWORK_SPEED_HINT_MAX_AGE_MS = 30 * 60 * 1000;
const EWMA_ALPHA = 0.35;

function clampMbps(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(0.05, Math.min(500, numeric));
}

export function readNetworkSpeedHint() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(NETWORK_SPEED_HINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const mbps = clampMbps(parsed?.mbps);
    const updatedAt = Number(parsed?.updatedAt);
    const samples = Math.max(0, Number(parsed?.samples) || 0);
    if (!mbps || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    if (Date.now() - updatedAt > NETWORK_SPEED_HINT_MAX_AGE_MS) return null;
    return { mbps, updatedAt, samples };
  } catch (_) {
    return null;
  }
}

export function writeNetworkSpeedSample(mbps) {
  const sampleMbps = clampMbps(mbps);
  if (!sampleMbps) return null;
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const previous = readNetworkSpeedHint();
    const nextMbps = previous
      ? (EWMA_ALPHA * sampleMbps) + ((1 - EWMA_ALPHA) * previous.mbps)
      : sampleMbps;
    const payload = {
      mbps: Number(nextMbps.toFixed(3)),
      updatedAt: Date.now(),
      samples: (previous?.samples || 0) + 1,
    };
    window.localStorage.setItem(NETWORK_SPEED_HINT_KEY, JSON.stringify(payload));
    return payload;
  } catch (_) {
    return null;
  }
}

export function estimatePrebufferSeconds(bytes, mbps, safetyFactor = 1.2) {
  const numericBytes = Number(bytes);
  const numericMbps = clampMbps(mbps);
  const numericSafety = Number.isFinite(Number(safetyFactor)) && Number(safetyFactor) > 0
    ? Number(safetyFactor)
    : 1.2;
  if (!Number.isFinite(numericBytes) || numericBytes <= 0 || !numericMbps) return null;
  return (numericBytes * 8 * numericSafety) / (numericMbps * 1_000_000);
}

export function resolveCompressedTrackBytes(trackData = {}, assetFormat = 'mp3') {
  const metadata = trackData?.metadata || {};
  const assets = trackData?.assets || {};
  const preferLossless = String(assetFormat || '').toLowerCase() === 'pcm';
  const candidates = preferLossless
    ? [
        assets?.losslessBytes,
        assets?.losslessSizeBytes,
        assets?.losslessFileSizeBytes,
        metadata?.audioAnalysis?.losslessFileSizeBytes,
      ]
    : [
        assets?.compressedBytes,
        assets?.compressedSizeBytes,
        assets?.compressedFileSizeBytes,
        metadata?.audioAnalysis?.compressedFileSizeBytes,
      ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
}

