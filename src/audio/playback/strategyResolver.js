import { ENGINE_REQUIREMENT, resolveEngineRequirementForEffectsConfig } from '../effects/index.js';
import { resolveTrackDurationSec } from './trackDuration.js';
import { isMobileDevice } from '../../config/Constants.js';
import {
  estimatePrebufferSeconds,
  readNetworkSpeedHint,
  resolveCompressedTrackBytes,
} from './networkHint.js';

/**
 * Adaptive policy defaults for playback strategy resolution.
 * These values are intentionally centralized so they can be tuned without
 * touching policy flow logic.
 */
export const ADAPTIVE_POLICY_DEFAULTS = Object.freeze({
  // Duration thresholds for strategy selection.
  mobilePrebufferMaxDurationSec: 300, // 5 minutes
  desktopPrebufferMaxDurationSec: 600, // 10 minutes
  // Separate predicted-wait ceilings allow tighter mobile tuning.
  mobileMaxPredictedPrebufferWaitSec: 25,
  desktopMaxPredictedPrebufferWaitSec: 25,
  prebufferPredictionSafetyFactor: 1.2,
});

/**
 * Resolves per-device prebuffer threshold used by adaptive playback policy.
 *
 * Override path for calibration/testing:
 * - Mobile: `?adaptiveMobilePrebufferMaxSec=<seconds>`
 * - Desktop: `?adaptiveDesktopPrebufferMaxSec=<seconds>`
 *
 * Notes:
 * - This is a playback-policy threshold only.
 * - We clamp to sane bounds to avoid accidental extreme values.
 *
 * @param {{ mobile?: boolean }} [options]
 * @returns {number} threshold in seconds
 */
function resolvePrebufferThresholdSec({ mobile = false } = {}) {
  const fallback = mobile
    ? ADAPTIVE_POLICY_DEFAULTS.mobilePrebufferMaxDurationSec
    : ADAPTIVE_POLICY_DEFAULTS.desktopPrebufferMaxDurationSec;
  const paramName = mobile ? 'adaptiveMobilePrebufferMaxSec' : 'adaptiveDesktopPrebufferMaxSec';
  try {
    if (typeof window === 'undefined') return fallback;
    const value = Number(new URLSearchParams(window.location?.search ?? '').get(paramName));
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.max(60, Math.min(60 * 60, Math.round(value)));
  } catch (_) {
    return fallback;
  }
}

/**
 * Resolves per-device predicted prebuffer wait threshold.
 *
 * Override path for calibration/testing:
 * - Mobile: `?adaptiveMobileMaxWaitSec=<seconds>`
 * - Desktop: `?adaptiveDesktopMaxWaitSec=<seconds>`
 *
 * @param {{ mobile?: boolean }} [options]
 * @returns {number} threshold in seconds
 */
function resolveMaxPredictedPrebufferWaitSec({ mobile = false } = {}) {
  const fallback = mobile
    ? ADAPTIVE_POLICY_DEFAULTS.mobileMaxPredictedPrebufferWaitSec
    : ADAPTIVE_POLICY_DEFAULTS.desktopMaxPredictedPrebufferWaitSec;
  const paramName = mobile ? 'adaptiveMobileMaxWaitSec' : 'adaptiveDesktopMaxWaitSec';
  try {
    if (typeof window === 'undefined') return fallback;
    const value = Number(new URLSearchParams(window.location?.search ?? '').get(paramName));
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.max(2, Math.min(120, Number(value.toFixed(2))));
  } catch (_) {
    return fallback;
  }
}

function resolveIsMobile() {
  try {
    return Boolean(isMobileDevice());
  } catch (_) {
    return false;
  }
}

function urlParam(name) {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location?.search ?? '').get(name);
  } catch (_) {
    return null;
  }
}

/** `?stretchEngine=1` forces the stretch engine onto every voice (also forces
 *  buffered assets, so streamed tracks can be tested on it too). */
export function isStretchEngineRequested() {
  return urlParam('stretchEngine') === '1';
}

/** `?stretchEngine=0` rollout escape hatch: buffered voices fall back to the
 *  classic buffer-source sink and stretch-requiring modules degrade to their
 *  tape mappings. */
export function isStretchEngineDisabled() {
  return urlParam('stretchEngine') === '0';
}

/** `?forceSpeedLock=1` engages the speed lock unconditionally — lets the whole
 *  lock UI path be exercised off-mobile. */
function isSpeedLockForced() {
  return urlParam('forceSpeedLock') === '1';
}

/**
 * Centralized playback strategy resolver for Adaptive mode — the ONE owner of
 * the whole playback-policy decision. Returns the final `sink` the voice runs
 * on ('stretch' | 'prebuffer' | 'stream') and `shouldLockSpeed`, not just the
 * auto buffered-vs-stream verdict, so callers apply the decision rather than
 * finishing it: URL flags, the sticky user unlock (`forceBuffered`), the
 * engine-requirement gate, and the mobile speed-lock rule all resolve HERE.
 * Pure (no side effects), so callers may also probe hypotheticals — e.g. the
 * buffered reload asks "which sink WOULD a forced-buffered resolve pick?".
 */
export function resolvePlaybackStrategy({
  profile = null,
  effectsConfig = {},
  trackData = null,
  // Sticky user override ("Unlock speed" / "Load full track"): buffered mode
  // was explicitly requested, later re-resolves must not revert it.
  forceBuffered = false,
} = {}) {
  const requested = 'adaptive';
  const requirement = resolveEngineRequirementForEffectsConfig(effectsConfig || {});
  const autoModeEnabled = true;
  const mobile = resolveIsMobile();
  const durationSec = resolveTrackDurationSec(trackData);
  const prebufferThresholdSec = resolvePrebufferThresholdSec({ mobile });
  const hasKnownDuration = Number.isFinite(durationSec) && durationSec > 0;
  const baseUsePrebuffer = hasKnownDuration && durationSec <= prebufferThresholdSec;
  const assetFormat = profile?.assetFormat || 'mp3';
  const compressedBytes = resolveCompressedTrackBytes(trackData, assetFormat);
  const networkHint = readNetworkSpeedHint();
  const predictedPrebufferSec = estimatePrebufferSeconds(
    compressedBytes,
    networkHint?.mbps,
    ADAPTIVE_POLICY_DEFAULTS.prebufferPredictionSafetyFactor,
  );
  const maxPredictedPrebufferWaitSec = resolveMaxPredictedPrebufferWaitSec({ mobile });
  const predictedTooSlow = Number.isFinite(predictedPrebufferSec) &&
    predictedPrebufferSec > maxPredictedPrebufferWaitSec;
  // Modules that consume the decoded buffer (granular, true reverse, stretch/
  // pure-pitch) want the buffered path — but only when the track can actually
  // be downloaded + decoded here. A hopeless full-prebuffer attempt (hour-long
  // track on a phone, crawling network) is worse than a streamed voice with
  // the modules visibly locked: the requirement never overrides feasibility,
  // it just records that engine features are blocked until an explicit unlock
  // (the buffered-reload flow) or a friendlier device.
  const requiresBuffered = requirement === ENGINE_REQUIREMENT.PREBUFFER_REQUIRED ||
    requirement === ENGINE_REQUIREMENT.STRETCH_REQUIRED;
  const bufferedFeasible = baseUsePrebuffer && !predictedTooSlow;
  const usePrebuffer = bufferedFeasible;

  // ——— The final decision ———
  // Buffered playback runs on the stretch engine (the default player);
  // 'prebuffer' (classic buffer-source sink) survives only behind the
  // ?stretchEngine=0 escape hatch — engine-init failure degrades inside the
  // stretch sink itself, not here. The =1 flag forces the engine even onto
  // stream-resolved tracks (it implies buffered assets).
  const stretchDisabled = isStretchEngineDisabled();
  const wantsBuffered = forceBuffered || usePrebuffer;
  const sink = !stretchDisabled && (wantsBuffered || isStretchEngineRequested())
    ? 'stretch'
    : (wantsBuffered ? 'prebuffer' : 'stream');
  // Engine-requiring modules that won't actually run on the decided sink:
  // computed against the SINK (not raw feasibility) so the force flag and the
  // sticky unlock clear the block exactly when they change the outcome.
  const requirementBlocked = requiresBuffered && sink === 'stream';
  // The mobile speed lock exists because a streaming media element can't
  // change rate reliably there; buffered/engine sinks are never locked.
  const speedLockForced = isSpeedLockForced();
  const shouldLockSpeed = speedLockForced || (sink === 'stream' && mobile);
  const speedLockReason = shouldLockSpeed
    ? (speedLockForced ? 'force-speed-lock-param' : 'mobile-stream')
    : null;
  // NOTE: an EXPLICIT user unlock (the buffered-reload flow) is deliberately
  // NOT gated here — the user always gets the attempt, whatever the device or
  // duration; a failed load reverts to streaming and reports.

  return {
    // The AUTO policy verdict before overrides — diagnostics only. Consumers
    // act on `sink`.
    strategy: usePrebuffer ? 'prebuffer' : 'stream',
    sink,
    shouldLockSpeed,
    speedLockReason,
    autoModeEnabled,
    requested,
    requirement,
    requiresBuffered,
    bufferedFeasible,
    requirementBlocked,
    safety: null,
    mobile,
    durationSec: hasKnownDuration ? durationSec : null,
    networkHintMbps: networkHint?.mbps ?? null,
    compressedBytes: compressedBytes ?? null,
    predictedPrebufferSec: Number.isFinite(predictedPrebufferSec)
      ? Number(predictedPrebufferSec.toFixed(2))
      : null,
    maxPredictedPrebufferWaitSec,
    prebufferThresholdSec,
    longForm: hasKnownDuration ? durationSec >= prebufferThresholdSec : null,
    longFormThresholdSec: prebufferThresholdSec,
    reason: requirementBlocked
      ? 'engine-requirement-blocked-stream'
      : requiresBuffered && usePrebuffer
      ? 'effects-require-prebuffer'
      : predictedTooSlow
      ? (mobile ? 'mobile-predicted-slow-stream' : 'desktop-predicted-slow-stream')
      : usePrebuffer
      ? (mobile ? 'mobile-duration-prebuffer' : 'desktop-duration-prebuffer')
      : (hasKnownDuration
        ? (mobile ? 'mobile-duration-stream' : 'desktop-duration-stream')
        : (mobile ? 'mobile-unknown-duration-stream' : 'desktop-unknown-duration-stream')),
  };
}

export default resolvePlaybackStrategy;
