/**
 * @file playback/streamingPlayer.js
 * @description HTMLMediaElement-backed streaming playback controller.
 */

import { isMobileDevice } from '../../config/Constants.js';
import { resolveTrackDurationMs } from './trackDuration.js';
import { writeNetworkSpeedSample } from './networkHint.js';
import { registerStableAudioProxyFailure, resolvePlaybackAudioSource } from './audioAssetSource.js';
import { normalizeLoopRange } from './loopRange.js';

const INITIAL_BUFFER_DESKTOP_MS = 2500;
const INITIAL_BUFFER_MOBILE_MS = 5000;
const RUNTIME_BUFFER_BASE_MS = 2500;
const MIN_BUFFER_TIMEOUT_MS = 15000;
const DEFAULT_RATE_THROTTLE_MS = 45;
const MIN_RATE_THROTTLE_MS = 24;
const MAX_RATE_THROTTLE_MS = 90;

export class StreamingPlayer {
  constructor({ trackData, userManager, effectRacks, effectOrder, performanceProfile } = {}) {
    this.trackData = trackData;
    this.userManager = userManager;
    this.effectRacks = effectRacks;
    this.effectOrder = Array.isArray(effectOrder) && effectOrder.length ? [...effectOrder] : ['x', 'y', 'z'];
    this.performanceProfile = performanceProfile || null;

    this.Tone = null;
    this.audio = null;
    this.mediaElementSource = null;
    this.explicitInputNode = null;

    this.isLoaded = false;
    this._isPlaying = false;
    this.durationMs = resolveTrackDurationMs(trackData);
    this.currentOffsetMs = 0;
    this.basePositionMs = 0;
    this.loopRange = null;
    this.loopEnabled = false;
    this.playbackRate = 1;
    this._speedControlLocked = false;
    this.isReversed = false;
    this.decodeStrategy = 'stream';
    this.assetFormatPreference = 'mp3';
    this._currentAssetUrl = null;
    this._currentAssetSourceKey = null;
    this._contextStarted = false;
    this._stopListeners = new Set();
    this._bufferingListeners = new Set();
    this._isBuffering = false;
    this._bufferedAheadMs = 0;
    this._playbackRateParam = {
      value: 1,
      rampTo: (target) => {
        this.setPlaybackRate(target, { immediate: true });
      },
      setValueAtTime: (target) => {
        this.setPlaybackRate(target, { immediate: true });
      },
    };
    this._boundHandlers = null;
    this._loopCheckInterval = null;
    this._loopCheckAnimationFrame = null;
    this._rateControlTimer = null;
    this._ratePendingTarget = null;
    this._rateLastAppliedAtMs = 0;
    this._rateControlConfig = this._resolveRateControlConfig(performanceProfile);

    this.setPerformanceProfile(performanceProfile);
  }

  setPerformanceProfile(profile = null) {
    this.performanceProfile = profile && typeof profile === 'object' ? { ...profile } : null;
    const assetFormat = String(this.performanceProfile?.assetFormat || '').toLowerCase();
    this.assetFormatPreference = assetFormat === 'pcm' ? 'pcm' : 'mp3';
    this._rateControlConfig = this._resolveRateControlConfig(this.performanceProfile);
  }

  _resolveRateControlConfig(profile = null) {
    const key = String(profile?.key || '').toUpperCase();
    const feedbackThrottleMs = Number(profile?.feedbackThrottleMs);
    const modSmoothingMs = Number(profile?.effectQuality?.modSmoothingMs);
    const mergedThrottle = Number.isFinite(modSmoothingMs) && modSmoothingMs > 0
      ? modSmoothingMs
      : feedbackThrottleMs;
    const throttleMs = Math.max(
      MIN_RATE_THROTTLE_MS,
      Math.min(
        MAX_RATE_THROTTLE_MS,
        Number.isFinite(mergedThrottle) && mergedThrottle > 0 ? mergedThrottle : DEFAULT_RATE_THROTTLE_MS,
      ),
    );

    // Lower deadband + higher slew for high-quality presets to keep responsiveness.
    if (key === 'HIGH') {
      return { throttleMs, deadband: 0.008, maxSlewPerSecond: 10.0 };
    }
    if (key === 'LOW') {
      return { throttleMs, deadband: 0.016, maxSlewPerSecond: 6.0 };
    }
    return { throttleMs, deadband: 0.012, maxSlewPerSecond: 8.0 };
  }

  _applyPlaybackProperties() {
    if (!this.audio) return;
    const rate = Number.isFinite(this.playbackRate) ? Math.max(0.01, this.playbackRate) : 1;
    this.playbackRate = rate;
    this._playbackRateParam.value = rate;
    this._applyAudioPlaybackRate(rate);
  }

  _nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  _getAppliedPlaybackRate() {
    const applied = Number(this.audio?.playbackRate);
    if (Number.isFinite(applied) && applied > 0) return applied;
    const fallback = Number(this.playbackRate);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
  }

  _applyAudioPlaybackRate(rate) {
    if (!this.audio) return;
    this.audio.playbackRate = rate;
    this._rateLastAppliedAtMs = this._nowMs();
  }

  _clearRateControlTimer() {
    if (this._rateControlTimer) {
      clearTimeout(this._rateControlTimer);
      this._rateControlTimer = null;
    }
  }

  _scheduleRateControlFlush(delayMs = 0) {
    this._clearRateControlTimer();
    const delay = Math.max(0, Number(delayMs) || 0);
    this._rateControlTimer = setTimeout(() => {
      this._rateControlTimer = null;
      this._flushPendingPlaybackRate({ force: false });
    }, delay);
  }

  _flushPendingPlaybackRate({ force = false } = {}) {
    if (!this.audio) return;
    if (!Number.isFinite(this._ratePendingTarget)) return;

    const target = Math.max(0.01, Number(this._ratePendingTarget) || 1);
    const config = this._rateControlConfig || this._resolveRateControlConfig(this.performanceProfile);
    const current = this._getAppliedPlaybackRate();
    const nowMs = this._nowMs();
    const elapsedMs = Math.max(0, nowMs - (this._rateLastAppliedAtMs || 0));
    const throttleMs = Math.max(MIN_RATE_THROTTLE_MS, Number(config?.throttleMs) || DEFAULT_RATE_THROTTLE_MS);
    const deadband = Math.max(0, Number(config?.deadband) || 0);
    const maxSlewPerSecond = Math.max(0.25, Number(config?.maxSlewPerSecond) || 8.0);

    let next = target;
    const delta = target - current;
    const absDelta = Math.abs(delta);

    if (!force) {
      if (absDelta <= deadband) {
        this._ratePendingTarget = null;
        return;
      }

      const effectiveElapsedSec = Math.max(elapsedMs, throttleMs) / 1000;
      const maxDelta = maxSlewPerSecond * effectiveElapsedSec;
      if (absDelta > maxDelta) {
        next = current + Math.sign(delta) * maxDelta;
      }
    }

    this._applyAudioPlaybackRate(next);

    if (!force && Math.abs(target - next) > deadband) {
      this._scheduleRateControlFlush(throttleMs);
      return;
    }

    this._ratePendingTarget = null;
  }

  _applyPitchPreservationPolicy() {
    if (!this.audio) return;
    const preservePitch = false;
    try {
      if ('preservesPitch' in this.audio) {
        this.audio.preservesPitch = preservePitch;
      }
      if ('webkitPreservesPitch' in this.audio) {
        this.audio.webkitPreservesPitch = preservePitch;
      }
      if ('mozPreservesPitch' in this.audio) {
        this.audio.mozPreservesPitch = preservePitch;
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[StreamingPlayer] Failed to set pitch preservation policy:', error);
      }
    }
  }

  getDecodeStrategy() {
    return this.decodeStrategy;
  }

  _resolvePreferredAssetUrl() {
    return resolvePlaybackAudioSource(this.trackData, {
      assetFormatPreference: this.assetFormatPreference,
    });
  }

  _getEffectInputNode() {
    if (this.explicitInputNode) {
      return this.explicitInputNode;
    }
    if (!this.effectRacks) return null;
    const firstAxis = this.effectOrder.find((axis) => this.effectRacks[axis]);
    if (firstAxis) {
      return this.effectRacks[firstAxis]?.getInputNode?.() ?? null;
    }
    const firstRack = Object.values(this.effectRacks).find(Boolean);
    return firstRack?.getInputNode?.() ?? null;
  }

  _resolveConnectTarget(node) {
    if (!node || typeof node !== 'object') return null;
    const isAudioNode = (candidate) => {
      try {
        return typeof AudioNode !== 'undefined' && candidate instanceof AudioNode;
      } catch (_) {
        return false;
      }
    };

    let target = node;
    for (let depth = 0; depth < 6; depth += 1) {
      if (!target || typeof target !== 'object') {
        return null;
      }
      if (isAudioNode(target)) {
        return target;
      }
      if (!target.input || typeof target.input !== 'object') {
        break;
      }
      target = target.input;
    }
    return isAudioNode(target) ? target : null;
  }

  _connectToCurrentInput() {
    if (!this.mediaElementSource) return;
    try {
      this.mediaElementSource.disconnect();
    } catch (_) {}

    const preferredInputNode = this._getEffectInputNode();
    if (preferredInputNode && typeof this.Tone?.connect === 'function') {
      try {
        this.Tone.connect(this.mediaElementSource, preferredInputNode);
        return;
      } catch (_) {}
    }
    const inputNode = this._resolveConnectTarget(preferredInputNode);
    if (inputNode && typeof this.mediaElementSource.connect === 'function') {
      try {
        this.mediaElementSource.connect(inputNode);
        return;
      } catch (error) {
        console.warn('[StreamingPlayer] Failed to connect media source to rack input.', error);
      }
    }

    // Fallback: ensure audio is still audible even if rack input unwrapping fails.
    const fallbackDestination = this._resolveConnectTarget(this.Tone?.Destination)
      || this.Tone?.context?.rawContext?.destination
      || null;
    if (fallbackDestination && typeof this.mediaElementSource.connect === 'function') {
      try {
        this.mediaElementSource.connect(fallbackDestination);
      } catch (error) {
        console.warn('[StreamingPlayer] Failed to connect media source fallback destination.', error);
      }
    }
  }

  _attachAudioHandlers() {
    if (!this.audio || this._boundHandlers) return;
    this._boundHandlers = {
      ended: () => {
        if (this.loopEnabled && this.loopRange) {
          this.audio.currentTime = this.loopRange.start / 1000;
          this.currentOffsetMs = this.loopRange.start;
          this.basePositionMs = this.loopRange.start;
          this.audio.play().then(() => {
            this._isPlaying = true;
            this._startLoopChecker();
          }).catch((error) => {
            this._isPlaying = false;
            this._stopLoopChecker();
            console.warn('[StreamingPlayer] Failed to restart loop after ended event.', error);
            this._notifyStopListeners({ reason: 'ended' });
          });
          return;
        }
        this._isPlaying = false;
        this._stopLoopChecker();
        this._emitBufferingState(false, { reason: 'ended' });
        this.currentOffsetMs = this.loopRange?.start ?? 0;
        this.basePositionMs = this.currentOffsetMs;
        this._notifyStopListeners({ reason: 'ended' });
      },
      pause: () => {
        this._isPlaying = false;
        this._stopLoopChecker();
        this._emitBufferingState(false, { reason: 'pause' });
        this.currentOffsetMs = this.getCurrentPositionMs();
        this.basePositionMs = this.currentOffsetMs;
      },
      timeupdate: () => {
        this.currentOffsetMs = this.getCurrentPositionMs();
        this._refreshBufferedAhead();
        this._enforceLoopRange();
      },
      progress: () => {
        this._refreshBufferedAhead();
      },
      waiting: () => {
        this._emitBufferingState(true, { reason: 'waiting' });
      },
      stalled: () => {
        this._emitBufferingState(true, { reason: 'stalled' });
      },
      canplay: () => {
        this._refreshBufferedAhead();
        this._emitBufferingState(false, { reason: 'canplay' });
      },
      canplaythrough: () => {
        this._refreshBufferedAhead();
        this._emitBufferingState(false, { reason: 'canplaythrough' });
      },
      playing: () => {
        this._refreshBufferedAhead();
        this._emitBufferingState(false, { reason: 'playing' });
      },
      seeked: () => {
        this._refreshBufferedAhead();
        const ready = this.audio?.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
        this._emitBufferingState(!ready, { reason: 'seeked' });
      },
    };
    this.audio.addEventListener('ended', this._boundHandlers.ended);
    this.audio.addEventListener('pause', this._boundHandlers.pause);
    this.audio.addEventListener('timeupdate', this._boundHandlers.timeupdate);
    this.audio.addEventListener('progress', this._boundHandlers.progress);
    this.audio.addEventListener('waiting', this._boundHandlers.waiting);
    this.audio.addEventListener('stalled', this._boundHandlers.stalled);
    this.audio.addEventListener('canplay', this._boundHandlers.canplay);
    this.audio.addEventListener('canplaythrough', this._boundHandlers.canplaythrough);
    this.audio.addEventListener('playing', this._boundHandlers.playing);
    this.audio.addEventListener('seeked', this._boundHandlers.seeked);
  }

  _detachAudioHandlers() {
    if (!this.audio || !this._boundHandlers) return;
    this.audio.removeEventListener('ended', this._boundHandlers.ended);
    this.audio.removeEventListener('pause', this._boundHandlers.pause);
    this.audio.removeEventListener('timeupdate', this._boundHandlers.timeupdate);
    this.audio.removeEventListener('progress', this._boundHandlers.progress);
    this.audio.removeEventListener('waiting', this._boundHandlers.waiting);
    this.audio.removeEventListener('stalled', this._boundHandlers.stalled);
    this.audio.removeEventListener('canplay', this._boundHandlers.canplay);
    this.audio.removeEventListener('canplaythrough', this._boundHandlers.canplaythrough);
    this.audio.removeEventListener('playing', this._boundHandlers.playing);
    this.audio.removeEventListener('seeked', this._boundHandlers.seeked);
    this._boundHandlers = null;
  }

  _refreshBufferedAhead() {
    this._bufferedAheadMs = this._computeBufferedAheadMs();
    return this._bufferedAheadMs;
  }

  _resolveRateAwareThresholdMs(baseThresholdMs) {
    const base = Math.max(250, Number(baseThresholdMs) || 0);
    const rate = Math.max(1, this._getAppliedPlaybackRate());
    return Math.round(base * rate);
  }

  _resolveInitialBufferThresholdMs() {
    const base = isMobileDevice() ? INITIAL_BUFFER_MOBILE_MS : INITIAL_BUFFER_DESKTOP_MS;
    return this._resolveRateAwareThresholdMs(base);
  }

  _resolveRuntimeBufferThresholdMs() {
    return this._resolveRateAwareThresholdMs(RUNTIME_BUFFER_BASE_MS);
  }

  _computeBufferedAheadMs() {
    if (!this.audio || !this.audio.buffered) {
      return 0;
    }
    const current = Number(this.audio.currentTime) || 0;
    const ranges = this.audio.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      const start = Number(ranges.start(i));
      const end = Number(ranges.end(i));
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        continue;
      }
      if (current >= start && current <= end) {
        return Math.max(0, (end - current) * 1000);
      }
    }
    return 0;
  }

  _emitBufferingState(isBuffering, { reason = 'runtime' } = {}) {
    const next = Boolean(isBuffering);
    const bufferedAheadMs = this._refreshBufferedAhead();
    const changed = this._isBuffering !== next;
    this._isBuffering = next;
    if (!changed && !next) {
      return;
    }
    const payload = {
      isBuffering: next,
      bufferedAheadMs,
      readyState: Number(this.audio?.readyState) || 0,
      reason,
      timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    };
    this._bufferingListeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        console.error('[StreamingPlayer] buffering listener error', error);
      }
    });
  }

  async init({ Tone, effectRacks, effectOrder }) {
    this.Tone = Tone;
    if (!this.Tone?.context?.rawContext) {
      throw new Error('[StreamingPlayer] Tone.js context is required.');
    }

    if (effectRacks) this.effectRacks = effectRacks;
    if (Array.isArray(effectOrder) && effectOrder.length) this.effectOrder = [...effectOrder];

    if (!this.audio) {
      this.audio = new Audio();
      this.audio.crossOrigin = 'anonymous';
      this.audio.preload = 'auto';
      this._applyPitchPreservationPolicy();
    }

    if (!this.mediaElementSource) {
      this.mediaElementSource = this.Tone.context.rawContext.createMediaElementSource(this.audio);
    }

    this._connectToCurrentInput();

    this._attachAudioHandlers();
    this._applyPlaybackProperties();
  }

  async _ensureContextStarted() {
    if (this._contextStarted) return;
    await this.Tone.start();
    this._contextStarted = true;
  }

  async _waitForCanPlay(timeoutMs = 12000) {
    if (!this.audio) return;
    if (this.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      return;
    }

    await new Promise((resolve, reject) => {
      let timeoutId = null;
      const cleanup = () => {
        if (!this.audio) return;
        this.audio.removeEventListener('canplay', onReady);
        this.audio.removeEventListener('error', onError);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('[StreamingPlayer] Failed to buffer audio stream.'));
      };
      this.audio.addEventListener('canplay', onReady, { once: true });
      this.audio.addEventListener('error', onError, { once: true });
      timeoutId = setTimeout(() => {
        cleanup();
        if (this.audio && this.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          resolve();
        } else {
          reject(new Error('[StreamingPlayer] canplay timeout.'));
        }
      }, Math.max(1000, timeoutMs));
    });
  }

  async _waitForMinBuffer({ thresholdMs = null, reason = 'min-buffer' } = {}) {
    if (!this.audio) return;
    const threshold = Number.isFinite(Number(thresholdMs))
      ? Math.max(250, Number(thresholdMs))
      : this._resolveInitialBufferThresholdMs();
    const buffered = this._computeBufferedAheadMs();
    if (buffered >= threshold) return;

    this._emitBufferingState(true, { reason });

    await new Promise((resolve) => {
      let timeoutId = null;
      let intervalId = null;

      const check = () => {
        if (!this.audio || this._computeBufferedAheadMs() >= threshold) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        if (intervalId) { clearInterval(intervalId); intervalId = null; }
        if (this.audio) {
          this.audio.removeEventListener('progress', check);
          this.audio.removeEventListener('canplaythrough', check);
        }
      };

      this.audio.addEventListener('progress', check);
      this.audio.addEventListener('canplaythrough', check);
      // Fallback poll for browsers that fire progress events infrequently
      intervalId = setInterval(check, 250);
      timeoutId = setTimeout(() => { cleanup(); resolve(); }, MIN_BUFFER_TIMEOUT_MS);
    });
  }

  _captureNetworkHintFromConnectionApi() {
    try {
      if (typeof navigator === 'undefined') return false;
      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      const downlinkMbps = Number(connection?.downlink);
      if (!Number.isFinite(downlinkMbps) || downlinkMbps <= 0) return false;
      return Boolean(writeNetworkSpeedSample(downlinkMbps));
    } catch (_) {
      return false;
    }
  }

  _captureNetworkHintFromResourceTiming(audioURL, loadStartedAtMs = null) {
    try {
      if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') {
        return false;
      }
      const entries = performance.getEntriesByName(audioURL);
      if (!Array.isArray(entries) || entries.length === 0) {
        return false;
      }
      const startFloor = Number.isFinite(loadStartedAtMs) ? Number(loadStartedAtMs) - 5 : null;
      const entry = [...entries]
        .reverse()
        .find((candidate) => {
          if (!candidate || candidate.entryType !== 'resource') return false;
          if (startFloor === null) return true;
          const startedAt = Number(candidate.startTime);
          return Number.isFinite(startedAt) && startedAt >= startFloor;
        });
      if (!entry) {
        return false;
      }
      const bytes = Number(entry.transferSize) || Number(entry.encodedBodySize) || Number(entry.decodedBodySize);
      const durationSec = Number(entry.duration) / 1000;
      if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) {
        return false;
      }
      const mbps = (bytes * 8) / (durationSec * 1_000_000);
      return Boolean(writeNetworkSpeedSample(mbps));
    } catch (_) {
      return false;
    }
  }

  async load() {
    if (!this.audio) {
      throw new Error('[StreamingPlayer] Player not initialised.');
    }
    if (this.isLoaded) return;

    const audioSource = this._resolvePreferredAssetUrl();
    if (!audioSource?.url) {
      throw new Error('[StreamingPlayer] No audio file URL provided.');
    }

    const candidateUrls = [...new Set([audioSource.url, audioSource.fallbackUrl].filter(Boolean))];
    let lastError = null;

    for (const candidateUrl of candidateUrls) {
      const loadStartedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const isStableCandidate = candidateUrl === audioSource.stableUrl;
      const desiredCrossOrigin = isStableCandidate ? 'use-credentials' : 'anonymous';

      if (
        candidateUrl !== this._currentAssetUrl ||
        audioSource.identityKey !== this._currentAssetSourceKey ||
        this.audio.crossOrigin !== desiredCrossOrigin
      ) {
        this.audio.crossOrigin = desiredCrossOrigin;
        this.audio.src = candidateUrl;
        this._currentAssetUrl = candidateUrl;
        this._currentAssetSourceKey = audioSource.identityKey || candidateUrl;
        this.audio.load();
      }

      this._emitBufferingState(true, { reason: 'load-start' });

      try {
        await this._waitForCanPlay();
        await this._waitForMinBuffer({ reason: 'min-buffer-initial' });
        this._emitBufferingState(false, { reason: 'load-ready' });

        const mediaDurationSec = Number(this.audio.duration);
        if (Number.isFinite(mediaDurationSec) && mediaDurationSec > 0) {
          this.durationMs = mediaDurationSec * 1000;
        } else {
          this.durationMs = resolveTrackDurationMs(this.trackData);
        }

        this.currentOffsetMs = 0;
        this.basePositionMs = 0;
        this.isLoaded = true;
        this._normalizeStoredLoopRange();
        this._applyPlaybackProperties();
        const sampledFromResource = this._captureNetworkHintFromResourceTiming(candidateUrl, loadStartedAtMs);
        if (!sampledFromResource) {
          this._captureNetworkHintFromConnectionApi();
        }
        return;
      } catch (error) {
        if (isStableCandidate) {
          registerStableAudioProxyFailure(audioSource, error);
        }
        lastError = error;
        this._emitBufferingState(false, { reason: 'load-failed' });
      }
    }

    throw lastError || new Error('[StreamingPlayer] Failed to load audio source.');
  }

  async triggerPlay() {
    if (!this.audio) return;
    if (!this.isLoaded) {
      await this.load();
    }
    await this._ensureContextStarted();
    this._applyPlaybackProperties();
    this._normalizeStoredLoopRange();

    if (Number.isFinite(this.currentOffsetMs) && this.currentOffsetMs >= 0) {
      const targetTime = this.currentOffsetMs / 1000;
      if (Math.abs((this.audio.currentTime || 0) - targetTime) > 0.02) {
        this.audio.currentTime = targetTime;
      }
    }

    await this.audio.play();
    this._isPlaying = true;
    this.basePositionMs = this.currentOffsetMs;

    // Start high-frequency loop checker for precise looping
    if (this.loopEnabled && this.loopRange) {
      this._startLoopChecker();
    }
  }

  async resumeAfterInterruption() {
    if (!this.audio) return false;
    await this._ensureContextStarted();
    this._applyPlaybackProperties();

    if (!this._isPlaying && !this.audio.paused) {
      this._isPlaying = true;
    }

    if (!this._isPlaying) {
      return false;
    }

    if (!this.audio.paused) {
      this._refreshBufferedAhead();
      return true;
    }

    try {
      await this.audio.play();
      this._isPlaying = true;
      this._refreshBufferedAhead();
      if (this.loopEnabled && this.loopRange) {
        this._startLoopChecker();
      }
      return true;
    } catch (error) {
      console.warn('[StreamingPlayer] Failed to resume after interruption.', error);
      return false;
    }
  }

  async pause() {
    if (!this.audio) return;
    this.currentOffsetMs = this.getCurrentPositionMs();
    this.basePositionMs = this.currentOffsetMs;
    this.audio.pause();
    this._isPlaying = false;
    this._stopLoopChecker();
  }

  async triggerStop() {
    if (!this.audio) return;
    this._stopLoopChecker();
    this.audio.pause();
    this._emitBufferingState(false, { reason: 'stop' });
    this.audio.currentTime = 0;
    this.currentOffsetMs = 0;
    this.basePositionMs = 0;
    this._isPlaying = false;
    this._notifyStopListeners({ reason: 'stop' });
  }

  async setPosition(ms) {
    if (!this.audio) return;
    const max = this.durationMs || Number(this.audio.duration || 0) * 1000 || ms;
    const clamped = Math.max(0, Math.min(Number(ms) || 0, max));
    this.currentOffsetMs = clamped;
    this.basePositionMs = clamped;
    this.audio.currentTime = clamped / 1000;
  }

  _getLoopDurationLimitMs() {
    const mediaDurationMs = Number(this.audio?.duration || 0) * 1000;
    if (Number.isFinite(mediaDurationMs) && mediaDurationMs > 0) {
      return mediaDurationMs;
    }
    return Number.isFinite(this.durationMs) && this.durationMs > 0 ? this.durationMs : null;
  }

  _normalizeLoopRange(startMs, endMs) {
    return normalizeLoopRange(startMs, endMs, {
      durationMs: this._getLoopDurationLimitMs(),
    });
  }

  _normalizeStoredLoopRange() {
    if (!this.loopRange) return;

    const normalized = this._normalizeLoopRange(this.loopRange.start, this.loopRange.end);
    if (!normalized) {
      this.loopRange = null;
      this.loopEnabled = false;
      this._stopLoopChecker();
      return;
    }

    this.loopRange = normalized;
    if (this._isPlaying && this.loopEnabled) {
      this._startLoopChecker();
    }
  }

  setLoopRange(startMs, endMs, { active = true } = {}) {
    const normalized = this._normalizeLoopRange(startMs, endMs);
    if (!normalized) {
      this.loopRange = null;
      this.loopEnabled = false;
      this._stopLoopChecker();
      return;
    }

    this.loopRange = normalized;
    this.loopEnabled = Boolean(active);

    // Restart loop checker if currently playing
    if (this._isPlaying && this.loopEnabled) {
      this._startLoopChecker();
    } else {
      this._stopLoopChecker();
    }
  }

  setLoopEnabled(enabled) {
    this.loopEnabled = Boolean(enabled) && Boolean(this.loopRange);
    if (this._isPlaying && this.loopEnabled) {
      this._startLoopChecker();
      return;
    }
    this._stopLoopChecker();
  }

  clearLoop() {
    this.loopRange = null;
    this.loopEnabled = false;
    this._stopLoopChecker();
  }

  _enforceLoopRange() {
    if (!this.audio || !this.loopEnabled || !this.loopRange || !this._isPlaying) return;
    if (this.isReversed) {
      return;
    }
    const timeMs = (this.audio.currentTime || 0) * 1000;
    // Use a small threshold (50ms) to catch the loop point more reliably
    if (timeMs >= this.loopRange.end - 50) {
      this.audio.currentTime = this.loopRange.start / 1000;
      this.currentOffsetMs = this.loopRange.start;
      this.basePositionMs = this.loopRange.start;
    }
  }

  _startLoopChecker() {
    this._stopLoopChecker();
    if (!this.loopEnabled || !this.loopRange || this.isReversed) {
      return;
    }

    // Use requestAnimationFrame for more frequent loop checks (60fps vs timeupdate's ~4fps)
    // This provides much more precise loop points for streaming playback
    const checkLoop = () => {
      if (!this._isPlaying || !this.loopEnabled || !this.loopRange) {
        this._stopLoopChecker();
        return;
      }
      this._enforceLoopRange();
      this._loopCheckAnimationFrame = requestAnimationFrame(checkLoop);
    };

    this._loopCheckAnimationFrame = requestAnimationFrame(checkLoop);
  }

  _stopLoopChecker() {
    if (this._loopCheckInterval) {
      clearInterval(this._loopCheckInterval);
      this._loopCheckInterval = null;
    }
    if (this._loopCheckAnimationFrame) {
      cancelAnimationFrame(this._loopCheckAnimationFrame);
      this._loopCheckAnimationFrame = null;
    }
  }

  addStopListener(listener) {
    if (typeof listener === 'function') {
      this._stopListeners.add(listener);
      return () => {
        this._stopListeners.delete(listener);
      };
    }
    return () => {};
  }

  removeStopListener(listener) {
    if (listener) {
      this._stopListeners.delete(listener);
    }
  }

  _notifyStopListeners(payload = {}) {
    this._stopListeners.forEach((listener) => {
      try {
        const result = listener(payload);
        if (result && typeof result.then === 'function') {
          result.catch((error) => {
            console.error('[StreamingPlayer] stop listener error', error);
          });
        }
      } catch (error) {
        console.error('[StreamingPlayer] stop listener error', error);
      }
    });
  }

  /**
   * The mobile speed lock. When engaged, EVERY playback-rate write is ignored — the
   * knob (via the adapter), the transport/sync warp (via `_syncWrapPlaybackRate`), and the effect
   * automation bridge (which routes through `setPlaybackRate` via the synthetic rate param) — so
   * audio stays pinned to its native speed instead of time-stretching an HTMLMediaElement, which
   * is unstable on mobile. This sink is the single gate every rate-change path passes through.
   */
  setSpeedControlLocked(locked) {
    const next = Boolean(locked);
    if (this._speedControlLocked === next) return;
    this._speedControlLocked = next;
    if (next && this.playbackRate !== 1) {
      // Undo any rate already applied before the lock engaged; play at native speed.
      this.playbackRate = 1;
      this._playbackRateParam.value = 1;
      this._ratePendingTarget = null;
      this._clearRateControlTimer();
      this._applyAudioPlaybackRate(1);
    }
  }

  setPlaybackRate(rate, { immediate = false } = {}) {
    if (this._speedControlLocked) return;
    const numeric = Number(rate);
    const target = Number.isFinite(numeric) ? Math.max(0.01, numeric) : 1;
    this.playbackRate = target;
    this._playbackRateParam.value = target;
    if (!this.audio) return;

    const mobile = isMobileDevice();
    if (!mobile || immediate) {
      this._ratePendingTarget = null;
      this._clearRateControlTimer();
      this._applyAudioPlaybackRate(target);
    } else {
      this._ratePendingTarget = target;
      const config = this._rateControlConfig || this._resolveRateControlConfig(this.performanceProfile);
      const throttleMs = Math.max(MIN_RATE_THROTTLE_MS, Number(config?.throttleMs) || DEFAULT_RATE_THROTTLE_MS);
      const elapsedMs = this._nowMs() - (this._rateLastAppliedAtMs || 0);
      if (elapsedMs >= throttleMs) {
        this._flushPendingPlaybackRate({ force: false });
      } else {
        this._scheduleRateControlFlush(throttleMs - elapsedMs);
      }
    }

    // When rate increases, consume buffer faster. Surface buffering state early
    // so UI can reflect catch-up before a hard stall event.
    if (this._isPlaying) {
      const bufferedAheadMs = this._refreshBufferedAhead();
      const threshold = this._resolveRuntimeBufferThresholdMs();
      if (bufferedAheadMs < threshold) {
        this._emitBufferingState(true, { reason: 'rate-buffer-thin' });
      }
    }
  }

  getPlaybackRate() {
    return this.playbackRate;
  }

  getPlaybackRateParam() {
    return this._playbackRateParam;
  }

  async setPlaybackReverse(reverse) {
    this.isReversed = Boolean(reverse);
    if (this.isReversed) {
      console.warn('[StreamingPlayer] Reverse playback is not supported in streaming mode.');
    }
    this._applyPlaybackProperties();
  }

  isPlaybackReverse() {
    return Boolean(this.isReversed);
  }

  getReverseParam() {
    return null;
  }

  getCurrentPositionMs() {
    if (!this.audio) return this.currentOffsetMs;
    const position = (this.audio.currentTime || 0) * 1000;
    this.currentOffsetMs = position;
    return position;
  }

  getDurationMs() {
    return this.durationMs;
  }

  addBufferingListener(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    this._bufferingListeners.add(listener);
    return () => {
      this._bufferingListeners.delete(listener);
    };
  }

  removeBufferingListener(listener) {
    if (listener) {
      this._bufferingListeners.delete(listener);
    }
  }

  getBufferingState() {
    return {
      isBuffering: Boolean(this._isBuffering),
      bufferedAheadMs: this._refreshBufferedAhead(),
      readyState: Number(this.audio?.readyState) || 0,
    };
  }

  isLooping() {
    return Boolean(this.loopEnabled && this.loopRange);
  }

  hasLoopRange() {
    return Boolean(this.loopRange);
  }

  getLoopRange() {
    if (!this.loopRange) return null;
    return { ...this.loopRange };
  }

  isPlaying() {
    return this._isPlaying;
  }

  setEffectRacks(effectRacks, effectOrder = null) {
    this.effectRacks = effectRacks || null;
    if (Array.isArray(effectOrder) && effectOrder.length) {
      this.effectOrder = [...effectOrder];
    }
    this._connectToCurrentInput();
  }

  setInputNode(inputNode) {
    this.explicitInputNode = inputNode || null;
    this._connectToCurrentInput();
  }

  dispose() {
    this._clearRateControlTimer();
    this._stopLoopChecker();
    this._detachAudioHandlers();
    try {
      this.audio?.pause?.();
    } catch (_) {}
    if (this.audio) {
      try {
        this.audio.src = '';
        this.audio.load();
      } catch (_) {}
    }
    try {
      this.mediaElementSource?.disconnect?.();
    } catch (_) {}
    this.mediaElementSource = null;
    this.explicitInputNode = null;
    this.audio = null;
    this.isLoaded = false;
    this._isPlaying = false;
    this.durationMs = 0;
    this.currentOffsetMs = 0;
    this.basePositionMs = 0;
    this.loopRange = null;
    this.loopEnabled = false;
    this.playbackRate = 1;
    this.isReversed = false;
    this._currentAssetUrl = null;
    this._currentAssetSourceKey = null;
    this._contextStarted = false;
    this._stopListeners.clear();
    this._bufferingListeners.clear();
    this._isBuffering = false;
    this._bufferedAheadMs = 0;
  }
}

export default StreamingPlayer;
