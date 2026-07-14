/**
 * @file playback/player.js
 * @description Tone.Player wrapper responsible for loading audio buffers,
 *              triggering playback, and keeping track of transport position.
 */
import i18next from 'i18next';
import { resolveTrackDurationMs } from './trackDuration.js';
import { writeNetworkSpeedSample } from './networkHint.js';
import { fetchPrebufferAudioSource, resolvePlaybackAudioSource } from './audioAssetSource.js';
import { normalizeLoopRange } from './loopRange.js';

export class PlayerPlayback {
  constructor({ trackData, userManager, effectRacks, effectOrder, performanceProfile, onLoadProgress } = {}) {
    this.trackData = trackData;
    // Per-voice download-progress sink. Falls back to the legacy global overlay hook
    // (window.updateLoadingProgress) so direct constructions keep the single-orbiter behavior.
    this.onLoadProgress = typeof onLoadProgress === 'function' ? onLoadProgress : null;
    this.userManager = userManager;
    this.effectRacks = effectRacks;
    this.effectOrder = Array.isArray(effectOrder) && effectOrder.length ? [...effectOrder] : ['x', 'y', 'z'];

    this.Tone = null;
    this.player = null;
    this.isLoaded = false;
    this._isPlaying = false;

    this.durationMs = resolveTrackDurationMs(trackData);
    this.currentOffsetMs = 0;
    this.basePositionMs = 0;
    this.loopRange = null;
    this.loopEnabled = false;
    this.playStartTimestamp = 0;
    this.lengthProfile = 'unknown';
    this.customLookAhead = null;
    this.playbackRate = 1;
    this._speedControlLocked = false;
    this.isReversed = false;
    this._contextStarted = false;
    this._scheduledStartTime = null;
    this._stopListeners = new Set();
    this._ignoreNextStopEvent = false;
    this._pendingStopTime = null;
    this._pendingStopPromise = null;
    this.loopCrossfadeMs = 6;
    this.performanceProfile = null;
    this.assetFormatPreference = 'mp3';
    this.decodeStrategy = 'prebuffer';
    this._currentAssetUrl = null;
    this._currentAssetSourceKey = null;
    this._decodedBuffer = null;
    this._sourceDryLevel = 1;

    this.setPerformanceProfile(performanceProfile);
  }

  setPerformanceProfile(profile = null) {
    if (!profile || typeof profile !== 'object') {
      this.performanceProfile = null;
      this.assetFormatPreference = 'mp3';
      return;
    }
    const nextProfile = { ...profile };
    this.performanceProfile = nextProfile;
    const assetFormat = String(nextProfile.assetFormat || '').toLowerCase();
    this.assetFormatPreference = assetFormat === 'pcm' ? 'pcm' : 'mp3';

    if (this.isLoaded) {
      const preferredSource = this._resolvePreferredAssetUrl();
      if (
        preferredSource?.url &&
        preferredSource.identityKey !== this._currentAssetSourceKey
      ) {
        this.isLoaded = false;
        this._currentAssetUrl = null;
        this._currentAssetSourceKey = null;
        this.durationMs = resolveTrackDurationMs(this.trackData);
        this.currentOffsetMs = 0;
        this.basePositionMs = 0;
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

  async init({ Tone, effectRacks, effectOrder }) {
    this.Tone = Tone;
    if (!this.Tone) {
      throw new Error('[PlayerPlayback] Tone.js reference is required.');
    }

    if (effectRacks) {
      this.effectRacks = effectRacks;
    }
    if (Array.isArray(effectOrder) && effectOrder.length) {
      this.effectOrder = [...effectOrder];
    }

    this.player = new this.Tone.Player({
      autostart: false,
      loop: false,
      fadeIn: 0.01,
      fadeOut: 0.1,
      volume: 0, // Unity gain (0dB) - Player defaults to -12dB
    });
    this.player.onstop = () => {
      this._handleTonePlayerStop();
    };

    if (this.effectRacks) {
      const firstAxis = this.effectOrder.find((axis) => this.effectRacks[axis]);
      if (firstAxis) {
        const input = this.effectRacks[firstAxis]?.getInputNode?.();
        if (input) {
          this.player.connect(input);
        }
      } else {
        Object.values(this.effectRacks).forEach((rack) => {
          const input = rack.getInputNode?.();
          if (input) {
            this.player.connect(input);
          }
        });
      }
    }

    this._applyPlaybackProperties({ immediate: true });
    this._applyLoopCrossfade();
    if (this._sourceDryLevel !== 1) {
      this._applySourceDryLevel();
    }
  }

  async load() {
    if (!this.player) throw new Error('[PlayerPlayback] Player not initialised.');

    if (this.isLoaded) return;

    const audioSource = this._resolvePreferredAssetUrl();
    if (!audioSource?.url) {
      throw new Error('[PlayerPlayback] No audio file URL provided.');
    }

    // Fetch audio with progress tracking (per-voice reporter, or the legacy global overlay hook)
    const updateLoadingProgress =
      this.onLoadProgress ?? (typeof window !== 'undefined' ? window.updateLoadingProgress : null);

    const download = await fetchPrebufferAudioSource(audioSource, {
      onProgress: (loaded, total, speed) => {
        if (updateLoadingProgress) {
          const loadedMB = (loaded / (1024 * 1024)).toFixed(2);
          const totalMB = total > 0 ? (total / (1024 * 1024)).toFixed(2) : '?';
          const speedMBps = speed > 0 ? (speed / (1024 * 1024)).toFixed(2) : '0';

          // Format as 3 lines: title (translated), size, speed
          const loadingText = i18next.t('loading.audio', 'Loading Audio');
          const progressText = `${loadingText}\n${loadedMB} / ${totalMB} MB\n${speedMBps} MB/s`;
          updateLoadingProgress(progressText);
        }
      },
    });
    const arrayBuffer = download?.arrayBuffer;

    // Decode the audio buffer using Tone.js context
    const audioContext = this.player.context.rawContext;
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Hand the decoded buffer to the playback node (subclasses may route it elsewhere).
    await this._adoptDecodedBuffer(audioBuffer);
    this.isLoaded = true;
    this._currentAssetUrl = download?.resolvedUrl || audioSource.url;
    this._currentAssetSourceKey = audioSource.identityKey || this._currentAssetUrl;
    this.currentOffsetMs = 0;
    this.basePositionMs = 0;
    this.isReversed = false;
    this.playbackRate = Number.isFinite(this.playbackRate) ? this.playbackRate : 1;
    this._normalizeStoredLoopRange();
    this._applyLengthProfile();
    this._applyPlaybackProperties({ immediate: true });
    this._applyLoopCrossfade();

    const loadedBytes = Number(download?.loadedBytes);
    const elapsedSeconds = Number(download?.elapsedSeconds);
    if (Number.isFinite(loadedBytes) && loadedBytes > 0 && Number.isFinite(elapsedSeconds) && elapsedSeconds > 0) {
      const mbps = (loadedBytes * 8) / (elapsedSeconds * 1_000_000);
      writeNetworkSpeedSample(mbps);
    }
  }

  /** Adopt a freshly decoded AudioBuffer as the playback source and resolve the
   *  real duration from it. Seam for engine variants that feed a different node. */
  async _adoptDecodedBuffer(audioBuffer) {
    this._decodedBuffer = audioBuffer;
    this.player.buffer.set(audioBuffer);
    const decodedDurationMs = Number(this.player.buffer?.duration || 0) * 1000;
    if (Number.isFinite(decodedDurationMs) && decodedDurationMs > 0) {
      this.durationMs = decodedDurationMs;
    } else {
      this.durationMs = resolveTrackDurationMs(this.trackData);
    }
  }

  async triggerPlay(options = {}) {
    if (!this.player) return;

    if (!this.isLoaded) {
      await this.load();
    }

    if (this._isPlaying && !options.force) {
      return;
    }

    await this._waitForPendingStop();
    await this._ensureContextStarted();
    this._normalizeStoredLoopRange();

    const loopStart = this.loopRange ? this.loopRange.start / 1000 : null;
    const loopEnd = this.loopRange ? this.loopRange.end / 1000 : null;
    if (this.loopEnabled && this.loopRange && this.loopRange.end > this.loopRange.start) {
      this.player.loop = true;
      this.player.loopStart = loopStart;
      this.player.loopEnd = loopEnd;
    } else {
      this.player.loop = false;
    }

    const offsetMs = Math.max(0, Math.min(this.currentOffsetMs, this.durationMs));
    const offsetSeconds = offsetMs / 1000;
    const lookAhead = this._computeLookAhead();
    const now = this.Tone.now();
    const earliestStartTime = Number.isFinite(options?.earliestStartTime)
      ? options.earliestStartTime
      : null;
    let startTime = now + lookAhead;
    if (Number.isFinite(this._pendingStopTime) && startTime < this._pendingStopTime) {
      startTime = this._pendingStopTime;
    }
    if (earliestStartTime !== null && startTime < earliestStartTime) {
      startTime = earliestStartTime;
    }
    this._applyPlaybackProperties({ immediate: true });
    this.player.start(startTime, offsetSeconds);
    this._isPlaying = true;
    this.basePositionMs = offsetMs;
    this.currentOffsetMs = offsetMs;
    this.playStartTimestamp = startTime;
    this._scheduledStartTime = startTime;
  }

  async resumeAfterInterruption() {
    if (!this.player || !this._isPlaying) {
      return false;
    }
    try {
      await this._ensureContextStarted();
      this._applyPlaybackProperties({ immediate: true });
      return true;
    } catch (error) {
      console.warn('[PlayerPlayback] Failed to resume after interruption.', error);
      return false;
    }
  }

  _applyLoopCrossfade() {
    if (!this.player) {
      return;
    }
    const fadeSeconds = Math.max(0.002, (this.loopCrossfadeMs ?? 0) / 1000);
    this.player.fadeIn = fadeSeconds;
    this.player.fadeOut = fadeSeconds;
  }

  async pause() {
    if (!this.player || !this._isPlaying) return;
    const now = this.Tone.now();
    this.currentOffsetMs = this.getCurrentPositionMs();
    const stopTime = now + this._computeReleaseTime();
    this._isPlaying = false;
    this._scheduledStartTime = null;
    this._ignoreNextStopEvent = true;
    this.player.stop(stopTime);
    this._registerPendingStop(stopTime);
    this.basePositionMs = this.currentOffsetMs;
    this.playStartTimestamp = now;
    await this._awaitStopAtTime(stopTime);
  }

  async triggerStop() {
    if (!this.player) return;
    const now = this.Tone.now();
    const stopTime = now + this._computeReleaseTime();
    this._isPlaying = false;
    this._scheduledStartTime = null;
    this._ignoreNextStopEvent = true;
    this.player.stop(stopTime);
    this._registerPendingStop(stopTime);
    this.currentOffsetMs = 0;
    this.basePositionMs = 0;
    this.playStartTimestamp = now;
    await this._awaitStopAtTime(stopTime);
  }

  async setPosition(ms) {
    const clamped = Math.max(0, Math.min(ms, this.durationMs || ms));
    this.currentOffsetMs = clamped;

    if (this._isPlaying) {
      const now = this.Tone.now();
      const stopTime = now + this._computeReleaseTime(true);
      this._ignoreNextStopEvent = true;
      this.player.stop(stopTime);
      this._registerPendingStop(stopTime);
      this._isPlaying = false;
      this._scheduledStartTime = null;
      this.basePositionMs = clamped;
      this.playStartTimestamp = now;
      await this.triggerPlay({ earliestStartTime: stopTime });
    } else {
      this.basePositionMs = clamped;
      this.playStartTimestamp = this.Tone.now();
    }
  }

  _getLoopDurationLimitMs() {
    const bufferDurationMs = Number(this.player?.buffer?.duration || 0) * 1000;
    if (Number.isFinite(bufferDurationMs) && bufferDurationMs > 0) {
      return bufferDurationMs;
    }
    return Number.isFinite(this.durationMs) && this.durationMs > 0 ? this.durationMs : null;
  }

  _normalizeLoopRange(startMs, endMs) {
    return normalizeLoopRange(startMs, endMs, {
      durationMs: this._getLoopDurationLimitMs(),
      endEpsilonMs: 0.001, // Keep Tone.Player loopEnd inside the decoded buffer.
    });
  }

  _applyLoopSettingsToPlayer() {
    if (!this.player) return;

    this.player.loop = Boolean(this.loopEnabled && this.loopRange);
    if (this.player.loop && this.loopRange) {
      this.player.loopStart = this.loopRange.start / 1000;
      this.player.loopEnd = Math.max(
        this.loopRange.end / 1000,
        this.player.loopStart + 0.01,
      );
      this._applyLoopCrossfade();
    }
  }

  _normalizeStoredLoopRange() {
    if (!this.loopRange) return;

    const normalized = this._normalizeLoopRange(this.loopRange.start, this.loopRange.end);
    if (!normalized) {
      this.loopRange = null;
      this.loopEnabled = false;
      this._applyLoopSettingsToPlayer();
      return;
    }

    this.loopRange = normalized;
    this._applyLoopSettingsToPlayer();
  }

  setLoopRange(startMs, endMs, { active = true } = {}) {
    const normalized = this._normalizeLoopRange(startMs, endMs);
    if (!normalized) {
      this.loopRange = null;
      this.loopEnabled = false;
      this._applyLoopSettingsToPlayer();
      return;
    }

    this.loopRange = normalized;
    this.loopEnabled = Boolean(active);
    this._applyLoopSettingsToPlayer();
  }

  setLoopEnabled(enabled) {
    this.loopEnabled = Boolean(enabled) && Boolean(this.loopRange);
    this._normalizeStoredLoopRange();
  }

  clearLoop() {
    this.loopRange = null;
    this.loopEnabled = false;
    if (this.player) {
      this.player.loop = false;
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
            console.error('[PlayerPlayback] stop listener error', error);
          });
        }
      } catch (error) {
        console.error('[PlayerPlayback] stop listener error', error);
      }
    });
  }

  _handleTonePlayerStop() {
    if (this._ignoreNextStopEvent) {
      this._ignoreNextStopEvent = false;
      return;
    }
    if (!this._isPlaying) {
      return;
    }
    this._isPlaying = false;
    this._scheduledStartTime = null;
    const now = this.Tone?.now?.() ?? 0;
    const targetPosition = this.loopEnabled && this.loopRange ? this.loopRange.start : 0;
    const maxDuration = Number.isFinite(this.durationMs) ? this.durationMs : targetPosition;
    const clampedPosition = Number.isFinite(targetPosition)
      ? Math.max(0, Math.min(maxDuration, targetPosition))
      : 0;
    this.currentOffsetMs = clampedPosition;
    this.basePositionMs = clampedPosition;
    this.playStartTimestamp = now;
    if (this.loopEnabled && this.loopRange) {
      this.triggerPlay({ force: true }).catch((error) => {
        console.warn('[PlayerPlayback] Failed to restart loop after natural stop.', error);
        this._notifyStopListeners({ reason: 'ended' });
      });
      return;
    }
    this._notifyStopListeners({ reason: 'ended' });
  }

  async _ensureContextStarted() {
    if (this._contextStarted) return;
    await this.Tone.start();
    this._contextStarted = true;
  }

  _computeLookAhead() {
    if (Number.isFinite(this.customLookAhead)) {
      return Math.max(0, this.customLookAhead);
    }
    const context = this.Tone.getContext?.() ?? this.Tone.context ?? null;
    const lookAhead = Number(context?.lookAhead);
    const baseLookAhead = Number.isFinite(lookAhead) ? Math.max(0, lookAhead) : 0.05;
    return baseLookAhead;
  }

  _computePlaybackRampDuration() {
    switch (this.lengthProfile) {
      case 'short':
        return 0.015;
      case 'medium':
        return 0.03;
      case 'long':
        return 0.05;
      default:
        return 0.02;
    }
  }

  _applyPlaybackProperties({ immediate = false } = {}) {
    if (!this.player) return;
    const targetRate = Math.max(0.01, Number(this.playbackRate) || 1);
    const now = this.Tone.now();
    const playbackRateParam = this.player.playbackRate ?? null;
    const isParamObject =
      playbackRateParam &&
      (typeof playbackRateParam === 'object' || typeof playbackRateParam === 'function');

    if (!immediate && isParamObject && typeof playbackRateParam.rampTo === 'function') {
      playbackRateParam.rampTo(targetRate, this._computePlaybackRampDuration());
    } else if (isParamObject && typeof playbackRateParam.setValueAtTime === 'function') {
      playbackRateParam.setValueAtTime(targetRate, now);
    } else if (isParamObject && Object.prototype.hasOwnProperty.call(playbackRateParam, 'value')) {
      playbackRateParam.value = targetRate;
    } else {
      this.player.playbackRate = targetRate;
    }

    this.player.reverse = Boolean(this.isReversed);
  }

  _computeReleaseTime(tight = false) {
    if (!this.player) return 0.02;
    const fadeOut = Number(this.player.fadeOut);
    if (Number.isFinite(fadeOut)) {
      const maxRelease = tight ? 0.035 : 0.15;
      return Math.min(Math.max(0.005, fadeOut), maxRelease);
    }
    return tight ? 0.015 : 0.05;
  }

  _awaitStopAtTime(stopTime) {
    if (!Number.isFinite(stopTime) || !this.Tone) {
      return Promise.resolve();
    }
    const now = this.Tone.now();
    const waitMs = Math.max(0, (stopTime - now) * 1000);
    if (waitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      setTimeout(resolve, waitMs + 5);
    });
  }

  _registerPendingStop(stopTime) {
    if (!Number.isFinite(stopTime) || !this.Tone) {
      this._pendingStopTime = null;
      this._pendingStopPromise = null;
      return Promise.resolve();
    }
    this._pendingStopTime = stopTime;
    const pending = this._awaitStopAtTime(stopTime).finally(() => {
      if (this._pendingStopPromise === pending) {
        this._pendingStopPromise = null;
        this._pendingStopTime = null;
      }
    });
    this._pendingStopPromise = pending;
    return pending;
  }

  async _waitForPendingStop() {
    if (!this._pendingStopPromise) {
      return;
    }
    try {
      await this._pendingStopPromise;
    } catch (_) {}
  }

  /**
   * Mirror of the streaming sink's speed lock so the `?forceSpeedLock=1` debug override
   * behaves the same when a track resolves to prebuffer. Blocks knob and transport-warp rate
   * writes that route through `setPlaybackRate`. (Effect automation that writes the Tone rate
   * signal directly is a desktop-debug edge only — the mobile lock always runs on the streaming
   * engine, so it is fully covered there.)
   */
  setSpeedControlLocked(locked) {
    const next = Boolean(locked);
    if (this._speedControlLocked === next) return;
    this._speedControlLocked = next;
    if (next && this.playbackRate !== 1) {
      this.playbackRate = 1;
      this._applyPlaybackProperties({ immediate: true });
    }
  }

  setPlaybackRate(rate, { immediate = false } = {}) {
    if (this._speedControlLocked) return;
    const numeric = Number(rate);
    const target = Number.isFinite(numeric) ? Math.max(0.01, numeric) : 1;
    if (!this.player) {
      this.playbackRate = target;
      return;
    }

    const now = this.Tone.now();
    if (this._isPlaying) {
      const position = this.getCurrentPositionMs();
      this.basePositionMs = position;
      this.currentOffsetMs = position;
      this.playStartTimestamp = now;
    }

    this.playbackRate = target;
    this._applyPlaybackProperties({ immediate });
  }

  getPlaybackRate() {
    const playbackRateParam = this.player?.playbackRate ?? null;
    if (
      playbackRateParam &&
      (typeof playbackRateParam === 'object' || typeof playbackRateParam === 'function') &&
      typeof playbackRateParam.value === 'number'
    ) {
      return playbackRateParam.value;
    }
    return this.playbackRate;
  }

  getPlaybackRateParam() {
    return this.player?.playbackRate ?? null;
  }

  /** Buffer-source playback is inherently varispeed (pitch follows speed).
   *  The stretch-engine sink overrides these; callers use the return value to
   *  fall back to tape mappings when the engine isn't available. */
  setRateMode() {
    return false;
  }

  getRateMode() {
    return 'varispeed';
  }

  setPitchSemitones() {
    return false;
  }

  getPitchSemitones() {
    return 0;
  }

  async setPlaybackReverse(reverse, { retrigger = false } = {}) {
    const desired = Boolean(reverse);
    if (!this.player) {
      this.isReversed = desired;
      return;
    }

    if (this.isReversed === desired && !retrigger) {
      this.player.reverse = desired;
      return;
    }

    this.isReversed = desired;
    this.player.reverse = desired;

    if (this._isPlaying && retrigger) {
      const now = this.Tone.now();
      const stopTime = now + this._computeReleaseTime(true);
      const position = this.getCurrentPositionMs();
      const mirrored = Math.max(0, (this.durationMs || 0) - position);
      this.currentOffsetMs = desired ? mirrored : position;
      this.basePositionMs = this.currentOffsetMs;
      this.playStartTimestamp = now;
      this._ignoreNextStopEvent = true;
      this.player.stop(stopTime);
      this._registerPendingStop(stopTime);
      this._isPlaying = false;
      this._scheduledStartTime = null;
      await this.triggerPlay({ earliestStartTime: stopTime });
    }
  }

  isPlaybackReverse() {
    return Boolean(this.isReversed);
  }

  getReverseParam() {
    return null;
  }

  _desiredLatencyHintForProfile(profile) {
    switch (profile) {
      case 'short':
        return 'interactive';
      case 'medium':
        return 'balanced';
      case 'long':
        return 'playback';
      default:
        return null;
    }
  }

  _selectLengthProfile(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return 'unknown';
    if (durationMs <= 10000) return 'short';
    if (durationMs <= 180000) return 'medium';
    return 'long';
  }

  _applyLengthProfile() {
    if (!this.player) return;
    const profile = this._selectLengthProfile(this.durationMs);
    this.lengthProfile = profile;

    switch (profile) {
      case 'short':
        this.player.fadeIn = 0.003;
        this.player.fadeOut = 0.03;
        this.customLookAhead = 0.012;
        break;
      case 'medium':
        this.player.fadeIn = 0.005;
        this.player.fadeOut = 0.065;
        this.customLookAhead = 0.028;
        break;
      case 'long':
        this.player.fadeIn = 0.008;
        this.player.fadeOut = 0.12;
        this.customLookAhead = 0.05;
        break;
      default:
        this.player.fadeIn = 0.01;
        this.player.fadeOut = 0.1;
        this.customLookAhead = null;
        break;
    }

    const context = this.Tone.getContext?.() ?? this.Tone.context ?? null;
    const desiredHint = this._desiredLatencyHintForProfile(profile);
    if (context && desiredHint && context.latencyHint !== desiredHint) {
      try {
        context.latencyHint = desiredHint;
      } catch (_) {
        // ignore if the host context does not allow reassignment
      }
    }
  }

  /** The decoded source buffer, for source-level engines (granular) that read
   *  it directly. Only the prebuffer sink retains one; engine variants that
   *  hand the samples elsewhere (or streaming) return null. */
  getDecodedBuffer() {
    return this._decodedBuffer;
  }

  /**
   * Level of the dry player signal (0–1) while a source-level engine
   * crossfades against it. The engine output joins the chain past the player,
   * so the player's own volume is the dry leg — it has no other owner after
   * construction. Neutral is 1.
   */
  setSourceDryLevel(level) {
    const numeric = Number(level);
    const target = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 1;
    this._sourceDryLevel = target;
    this._applySourceDryLevel();
  }

  _applySourceDryLevel() {
    const volumeParam = this.player?.volume ?? null;
    if (!volumeParam || typeof volumeParam.rampTo !== 'function') return;
    // Floor keeps the dB ramp finite (gain 0 would be -Infinity dB).
    const gain = Math.max(this._sourceDryLevel, 0.0005);
    const db = typeof this.Tone?.gainToDb === 'function'
      ? this.Tone.gainToDb(gain)
      : 20 * Math.log10(gain);
    volumeParam.rampTo(db, 0.05);
  }

  getCurrentPositionMs() {
    if (!this.player) {
      return this.currentOffsetMs;
    }
    if (!this._isPlaying) {
      return this.currentOffsetMs;
    }
    const now = this.Tone.now();
    if (this._scheduledStartTime && now < this._scheduledStartTime) {
      return this.basePositionMs;
    }

    const playbackRateParam = this.player?.playbackRate ?? null;
    const effectiveRate = Number(playbackRateParam?.value ?? this.playbackRate ?? 1);
    const elapsed = (now - this.playStartTimestamp) * 1000 * Math.max(0, effectiveRate);
    let position = this.isReversed
      ? this.basePositionMs - elapsed
      : this.basePositionMs + elapsed;
    const duration = this.durationMs || 0;

    if (this.loopEnabled && this.loopRange) {
      const loopLength = this.loopRange.end - this.loopRange.start;
      if (loopLength > 0) {
        const { start } = this.loopRange;
        const end = this.loopRange.end;
        if (!this.isReversed) {
          if (position >= start) {
            const distance = position - start;
            const remainder = distance % loopLength;
            if (distance >= loopLength) {
              this.basePositionMs = start + remainder;
              this.playStartTimestamp = now - (remainder / 1000) / Math.max(0.0001, effectiveRate);
            }
            position = start + remainder;
          }
        } else {
          if (position <= end) {
            const distance = end - position;
            const remainder = distance % loopLength;
            if (distance >= loopLength) {
              this.basePositionMs = end - remainder;
              this.playStartTimestamp = now - (remainder / 1000) / Math.max(0.0001, effectiveRate);
            }
            position = end - remainder;
          }
        }
      }
    }

    if (duration > 0) {
      if (this.isReversed) {
        position = Math.max(0, Math.min(duration, position));
      } else {
        position = Math.min(Math.max(0, position), duration);
      }
    }

    this.currentOffsetMs = position;
    return position;
  }

  getDurationMs() {
    return this.durationMs;
  }

  isLooping() {
    return Boolean(this.loopEnabled && this.loopRange);
  }

  hasLoopRange() {
    return Boolean(this.loopRange);
  }

  getLoopRange() {
    if (!this.loopRange) return null;
    const { start, end } = this.loopRange;
    return {
      start,
      end
    };
  }

  isPlaying() {
    return this._isPlaying;
  }

  dispose() {
    if (this.player) {
      try {
        this._ignoreNextStopEvent = true;
        const stopNow = this.Tone?.now?.() ?? 0;
        this.player.stop(stopNow);
      } catch (_) {}
      this.player.dispose();
    }
    this.player = null;
    this.isLoaded = false;
    this._isPlaying = false;
    this.durationMs = 0;
    this.currentOffsetMs = 0;
    this.basePositionMs = 0;
    this.loopRange = null;
    this.loopEnabled = false;
    this.playStartTimestamp = 0;
    this.lengthProfile = 'unknown';
    this.customLookAhead = null;
    this.playbackRate = 1;
    this.isReversed = false;
    this._scheduledStartTime = null;
    this._contextStarted = false;
    this._stopListeners.clear();
    this._ignoreNextStopEvent = false;
    this._pendingStopTime = null;
    this._pendingStopPromise = null;
    this._currentAssetUrl = null;
    this._currentAssetSourceKey = null;
    this._decodedBuffer = null;
    this._sourceDryLevel = 1;
  }
}
