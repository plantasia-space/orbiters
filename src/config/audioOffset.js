/**
 * @file src/config/audioOffset.js
 * @description Per-device MANUAL audio offset (ms) — the by-ear latency calibration.
 *
 * WHY THIS EXISTS
 * ---------------
 * A device's true acoustic output latency (how long after we schedule a sound it actually leaves
 * the speaker) cannot be reliably measured or inferred in the browser. `AudioContext.outputLatency`
 * is non-standard (absent on e.g. Safari) and, where present, under-reports on some platforms — iOS
 * has been observed reporting ~12.6 ms when a microphone measured ~125 ms. There is no automatic
 * signal we can trust to compensate it.
 *
 * So we give the user a MANUAL escape hatch: a single per-device number, in milliseconds, that they
 * dial by EAR until two devices playing the same shared session line up acoustically. A POSITIVE
 * offset means "this device's speaker is N ms late" → fire its audio N ms EARLIER so the sound
 * leaves the speaker on the beat instead of one output-latency later.
 *
 * This is a per-DEVICE value (all voices on the device share it), not per-track or per-session. It
 * only matters for cross-device acoustic alignment (synced sessions); when playing solo it shifts
 * this device's own audio uniformly, which is inaudible.
 *
 * Mirrors the SYNC clock/killgate spike control (`src/clock-killgate/*`):
 *   "Manual audio offset (ms) — fires this device's clicks earlier — dial until two devices line up
 *    acoustically."
 *
 * The value is applied to the sink timing in `AudioEngineAdapter` (the bar-quantized start), which
 * is where an orbiter's audio joins the shared timeline.
 */

/** localStorage key holding the persisted per-device offset (ms). */
const STORAGE_KEY = 'audioOffsetMs';
/** URL param that pre-loads / overrides the offset for a page load (bookmark per device). */
const URL_PARAM = 'audioOffset';
/**
 * Bound on the magnitude, in ms. ±500 ms covers integrated-speaker + Bluetooth output latencies
 * (Bluetooth can be 150–300 ms), the same range the clock/killgate spike exposes.
 */
export const MAX_ABS_OFFSET_MS = 500;

/** Event dispatched on `window` whenever the offset changes, so any UI can reflect it live. */
export const AUDIO_OFFSET_CHANGED_EVENT = 'orbiters:audio-offset-changed';

/** Clamp to a finite, integer ms value within ±MAX_ABS_OFFSET_MS. Non-numbers → 0. */
export function clampAudioOffsetMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_ABS_OFFSET_MS, Math.min(MAX_ABS_OFFSET_MS, Math.round(n)));
}

function readStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function readUrl() {
  try {
    if (typeof window === 'undefined') return null;
    const raw = new URLSearchParams(window.location?.search ?? '').get(URL_PARAM);
    return raw == null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/**
 * The live cached offset (ms). Resolved lazily on first read: URL param wins (per-load override),
 * then persisted localStorage, else 0. Cached so the hot audio path never touches storage/URL.
 */
let cachedOffsetMs = null;

function resolveInitial() {
  const fromUrl = readUrl();
  if (fromUrl != null) return clampAudioOffsetMs(fromUrl);
  const fromStorage = readStorage();
  if (fromStorage != null) return clampAudioOffsetMs(fromStorage);
  return 0;
}

/**
 * The current per-device manual audio offset, in ms (integer, ±MAX_ABS_OFFSET_MS). Positive = fire
 * earlier. Cheap: reads a module-cached number after the first resolve.
 * @returns {number}
 */
export function getManualAudioOffsetMs() {
  if (cachedOffsetMs === null) cachedOffsetMs = resolveInitial();
  return cachedOffsetMs;
}

/** The offset expressed in SECONDS, for subtracting from audio-clock scheduling. */
export function getManualAudioOffsetSec() {
  return getManualAudioOffsetMs() / 1000;
}

/**
 * Set the per-device offset (ms). Persists to localStorage by default and notifies listeners via
 * the `AUDIO_OFFSET_CHANGED_EVENT` window event. Takes effect on the NEXT scheduled start.
 * @param {number} ms
 * @param {{ persist?: boolean }} [opts]
 * @returns {number} the clamped value actually stored
 */
export function setManualAudioOffsetMs(ms, { persist = true } = {}) {
  const next = clampAudioOffsetMs(ms);
  cachedOffsetMs = next;
  if (persist) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      }
    } catch {
      // ignore persistence errors (private mode / disabled storage)
    }
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(AUDIO_OFFSET_CHANGED_EVENT, { detail: { offsetMs: next } }));
    }
  } catch {
    // ignore (e.g. CustomEvent unavailable)
  }
  return next;
}

/**
 * Install a tiny runtime handle for by-ear tuning from the console/bookmarklet without a built UI:
 *   orbitersAudioOffset.set(90)   // fire 90 ms earlier, persisted
 *   orbitersAudioOffset.get()
 * Idempotent; safe to call at app bootstrap. No-op outside the browser.
 */
export function installAudioOffsetRuntimeHandle() {
  if (typeof window === 'undefined') return;
  window.orbitersAudioOffset = {
    get: getManualAudioOffsetMs,
    set: (ms) => setManualAudioOffsetMs(ms),
    maxAbsMs: MAX_ABS_OFFSET_MS,
  };
}

/** Test-only: reset the module cache so the next read re-resolves from URL/storage. */
export function __resetAudioOffsetCacheForTests() {
  cachedOffsetMs = null;
}
