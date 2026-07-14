/**
 * @file src/config/audioPerformance.js
 * @description Audio-focused performance presets plus helpers for persisting the user's selection.
 */
import {
  THROTTLE_LOW_MS,
  THROTTLE_MID_MS,
  THROTTLE_HIGH_MS,
} from './Constants.js';
import { resolveTrackDurationSec } from '../audio/playback/trackDuration.js';

/**
 * Audio performance presets control decoding format, DSP quality knobs, and
 * the cadence at which we emit feedback to external systems (MIDI, sensors).
 * Throttle timing is kept alongside each preset so UI selections can update
 * both fidelity and cadence in one step.
 */
export const AUDIO_PERFORMANCE_PRESETS = {
  LOW: {
    key: 'LOW',
    label: 'low',
    assetFormat: 'mp3',
    audioContextLatencyHint: 'playback',
    effectQuality: {
      oversampling: 'none',
      convolutionIRQuality: 'low',
      fftSize: 512,
      interpMode: 'linear',
      filterModel: 'basic',
      modSmoothingMs: 60,
    },
    safeRampTimeMs: 60,
    feedbackThrottleMs: THROTTLE_HIGH_MS, // 50ms = ~20fps (lower performance = slower updates)
  },
  MID: {
    key: 'MID',
    label: 'mid',
    assetFormat: 'mp3',
    audioContextLatencyHint: 'playback',
    effectQuality: {
      oversampling: 'none',
      convolutionIRQuality: 'mid',
      fftSize: 1024,
      interpMode: 'linear',
      filterModel: 'hq',
      modSmoothingMs: 45,
    },
    safeRampTimeMs: 45,
    feedbackThrottleMs: THROTTLE_MID_MS, // 33ms = ~30fps (balanced)
  },
  HIGH: {
    key: 'HIGH',
    label: 'high',
    assetFormat: 'pcm',
    audioContextLatencyHint: 'playback',
    effectQuality: {
      oversampling: 'none',
      convolutionIRQuality: 'high',
      fftSize: 2048,
      interpMode: 'cubic',
      filterModel: 'hq',
      modSmoothingMs: 30,
    },
    safeRampTimeMs: 30,
    feedbackThrottleMs: THROTTLE_LOW_MS, // 16ms = ~60fps (higher performance = faster updates)
  },
};

const PRESET_ALIAS = {
  low: 'LOW',
  LOW: 'LOW',
  mid: 'MID',
  MID: 'MID',
  high: 'HIGH',
  HIGH: 'HIGH',
};

const STORAGE_KEY = 'audioProfile';

/**
 * Maps ?audioBuffer=low|mid|high to Web Audio API latencyHint values.
 * low  = smallest buffers, lowest latency, highest CPU cost
 * mid  = balanced buffers
 * high = largest buffers, highest latency, lowest CPU cost
 */
const AUDIO_BUFFER_ALIAS = {
  low: 'interactive',
  LOW: 'interactive',
  mid: 'balanced',
  MID: 'balanced',
  high: 'playback',
  HIGH: 'playback',
};

function normalizeAudioBufferParam(value) {
  if (!value) return null;
  return AUDIO_BUFFER_ALIAS[String(value).trim()] ?? null;
}

function normalizeKey(value) {
  if (!value) return null;
  return PRESET_ALIAS[String(value).trim()] ?? null;
}

function tryReadStorage(key = STORAGE_KEY) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function toUrlSearchParams(params) {
  if (params instanceof URLSearchParams) return params;
  if (typeof params === 'string') return new URLSearchParams(params);
  if (typeof window !== 'undefined') {
    return new URLSearchParams(window.location?.search ?? '');
  }
  return new URLSearchParams('');
}

export function resolveAdaptiveAudioMode(params) {
  void params;
  // Adaptive mode is always-on in current product strategy.
  // URL/storage mode flags are intentionally ignored to reduce mode complexity.
  return true;
}

function resolveCompressedAudioBytes(trackData = {}, assetFormat = 'mp3') {
  const metadata = trackData?.metadata || {};
  const assets = trackData?.assets || {};
  const format = String(assetFormat || '').toLowerCase() === 'pcm' ? 'lossless' : 'compressed';
  const candidates = format === 'lossless'
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
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return null;
}

export function estimateDecodedAudioBytes(trackData = {}, {
  sampleRate = 44100,
  channels = 2,
  bytesPerSample = 4,
} = {}) {
  const durationSec = resolveTrackDurationSec(trackData);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return null;
  }
  return durationSec * sampleRate * channels * bytesPerSample;
}

export function resolvePrebufferSafety(trackData = {}, {
  deviceMemoryGB = null,
  isMobile = false,
  assetFormat = 'mp3',
} = {}) {
  const decodedBytes = estimateDecodedAudioBytes(trackData);
  const compressedBytes = resolveCompressedAudioBytes(trackData, assetFormat);
  const mobile = Boolean(isMobile);

  const decodedBudgetBytes = mobile
    ? 48 * 1024 * 1024
    : Number.isFinite(deviceMemoryGB) && deviceMemoryGB > 0 && deviceMemoryGB < 4
      ? 128 * 1024 * 1024
      : 256 * 1024 * 1024;
  const compressedBudgetBytes = mobile ? 12 * 1024 * 1024 : Number.POSITIVE_INFINITY;

  if (Number.isFinite(decodedBytes) && decodedBytes >= decodedBudgetBytes) {
    return {
      safe: false,
      reason: 'decoded-budget-exceeded',
      decodedBytes,
      compressedBytes,
      decodedBudgetBytes,
      compressedBudgetBytes,
    };
  }

  if (Number.isFinite(compressedBytes) && compressedBytes >= compressedBudgetBytes) {
    return {
      safe: false,
      reason: 'compressed-budget-exceeded',
      decodedBytes,
      compressedBytes,
      decodedBudgetBytes,
      compressedBudgetBytes,
    };
  }

  return {
    safe: true,
    reason: 'within-budget',
    decodedBytes,
    compressedBytes,
    decodedBudgetBytes,
    compressedBudgetBytes,
  };
}

/**
 * Resolves the active audio performance preset using URL parameter (?audio=),
 * optional localStorage override, and default behaviour (MID/mp3).
 * @param {URLSearchParams|string|undefined} params
 * @returns {{ key: 'LOW'|'MID'|'HIGH', preset: typeof AUDIO_PERFORMANCE_PRESETS.HIGH, source: string }}
 */
export function resolveAudioPerformancePreset(params) {
  const search = toUrlSearchParams(params);
  const adaptiveAudioMode = resolveAdaptiveAudioMode(search);

  // ?audioBuffer=low|mid|high overrides the preset's latencyHint independently
  const bufferOverride = normalizeAudioBufferParam(search.get('audioBuffer'));

  const applyOverrides = (preset) => {
    const result = { ...preset, adaptiveAudioMode };
    if (bufferOverride) {
      result.audioContextLatencyHint = bufferOverride;
    }
    return result;
  };

  const fromUrl = normalizeKey(search.get('audio'));
  if (fromUrl && AUDIO_PERFORMANCE_PRESETS[fromUrl]) {
    return {
      key: fromUrl,
      preset: applyOverrides(AUDIO_PERFORMANCE_PRESETS[fromUrl]),
      source: 'audio',
    };
  }

  const fromStorage = normalizeKey(tryReadStorage());
  if (fromStorage && AUDIO_PERFORMANCE_PRESETS[fromStorage]) {
    return {
      key: fromStorage,
      preset: applyOverrides(AUDIO_PERFORMANCE_PRESETS[fromStorage]),
      source: 'storage',
    };
  }

  return {
    key: 'MID',
    preset: applyOverrides(AUDIO_PERFORMANCE_PRESETS.MID),
    source: 'default',
  };
}

export function getAudioPerformancePresetByKey(key) {
  const preset = AUDIO_PERFORMANCE_PRESETS[key] ?? AUDIO_PERFORMANCE_PRESETS.MID;
  return {
    ...preset,
    adaptiveAudioMode: resolveAdaptiveAudioMode(),
  };
}

export function normalizeAudioPerformanceKey(value) {
  return normalizeKey(value);
}

/**
 * Returns the throttle duration (ms) that should be used for external feedback
 * when the provided audio preset is active.
 * @param {string|null|undefined} value
 * @returns {number}
 */
export function getAudioPerformanceThrottleMs(value) {
  const key = normalizeKey(value) ?? 'MID';
  const fallback = key === 'LOW' ? THROTTLE_HIGH_MS : key === 'HIGH' ? THROTTLE_LOW_MS : THROTTLE_MID_MS;
  const preset = AUDIO_PERFORMANCE_PRESETS[key];
  return Number(preset?.feedbackThrottleMs) || fallback;
}

export function persistAudioPerformanceKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return;
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, normalized);
  } catch (_) {
    // ignore persistence errors
  }
}
