/**
 * @file playback/stretchPlayer.js
 * @description Prebuffer playback sink backed by the Signalsmith Stretch
 *              WASM/AudioWorklet engine. The worklet consumes the decoded
 *              buffer itself, so the playhead is projected from the engine's
 *              reported input time instead of an AudioBufferSourceNode
 *              playbackRate.
 *
 *              Rate has two interpretations, chosen per active module:
 *              - 'stretch' (default): tempo moves, pitch stays locked.
 *              - 'varispeed': classic tape — pitch follows speed, emulated on
 *                the engine by shifting semitones with the rate ratio.
 *              Independent of rate, `setPitchSemitones` shifts pitch with the
 *              tempo locked.
 *
 *              This sink is the DEFAULT for buffered playback: any voice that
 *              resolves to buffered assets runs on the engine (the classic
 *              buffer-source sink remains only as the engine-init-failure
 *              fallback). Modules declaring `engineRequirement:
 *              'stretch-required'` activate it even for streamed tracks, and
 *              the `?stretchEngine=1` / `?stretchEngine=0` URL flags force it
 *              on or off during rollout.
 */
import { PlayerPlayback } from './player.js';
import { resolveTrackDurationMs } from './trackDuration.js';

// Engine read-ahead means the reported inputTime leads the audible output.
// The lead is estimated live (in output-seconds) and clamped to this window.
const MAX_INPUT_LEAD_SEC = 0.6;
const INPUT_LEAD_EMA_WEIGHT = 0.25;
// Source-seconds epsilon for natural-end detection: late detection only means
// a moment of engine silence before the stop; a larger epsilon would cut the
// audible tail (and slow rates stretch that loss in wall-clock time).
const END_EPSILON_SEC = 0.005;

// A commanded speed magnitude below this reads as "stopped": the output glides
// to silence rather than crawling at the engine's rate floor. This makes a
// through-zero speed knob truly stop at 0 (and a wide tempo module hit silence
// at its extreme) instead of freezing on a drone. The glide keeps the zero
// crossing seamless — no dead zone.
const SPEED_STOP_EPSILON = 0.02;
const SPEED_GATE_RAMP_SEC = 0.03;

// The engine assembles its AudioWorklet processor by stringifying its own
// functions into a Blob module, so NO bundler transform may touch its
// executable source (esbuild prebundle/minify breaks the stringified source
// and the factory promise hangs forever). The source is therefore vendored as
// a STRING module (bundler-proof and bundler-agnostic — resource-query
// imports like `?url` are Vite-only, and this file is also bundled by
// Next/webpack when the host app consumes orbiters source). At runtime the
// string becomes a Blob URL and is dynamic-imported untransformed. Both the
// string module and the blob import load lazily, so the engine weighs nothing
// until a voice actually uses it. The factory is shared: the blob module is
// parsed once per page, not per voice.
let stretchEngineFactoryPromise = null;

// The engine's worklet RPCs settle only when the processor answers — the
// vendored bridge has no reject path, no messageerror handler, no timeout, so
// a reply that never arrives (observed on phones after very large buffer
// uploads) hangs its caller forever. Every awaited engine call goes through
// this finite wrapper: a timeout becomes a normal error the playback layer's
// existing failure paths can report and revert from.
const ENGINE_RPC_TIMEOUT_MS = 30 * 1000;
/** A resume the browser permits settles immediately; one it blocks never settles at all. Short
 *  by design — this is a "can this context run right now?" probe, not a wait worth sitting out. */
const CONTEXT_RESUME_TIMEOUT_MS = 2 * 1000;

function withEngineTimeout(promise, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[StretchPlayerPlayback] Engine ${label} did not answer within ${ENGINE_RPC_TIMEOUT_MS / 1000}s.`)),
      ENGINE_RPC_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function importStretchEngineFactory() {
  const [{ default: engineSource }, { installGranularWorkletOverlay }] = await Promise.all([
    import('./vendor/signalsmithStretchEngine.js'),
    import('./granularWorkletOverlay.js'),
  ]);
  const source = installGranularWorkletOverlay(engineSource);
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const engineModule = await import(/* @vite-ignore */ /* webpackIgnore: true */ blobUrl);
    return engineModule.default;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function loadStretchEngineFactory() {
  if (!stretchEngineFactoryPromise) {
    stretchEngineFactoryPromise = importStretchEngineFactory().catch((error) => {
      // Reset so a later voice can retry (e.g. transient blob/CSP hiccup).
      stretchEngineFactoryPromise = null;
      throw error;
    });
  }
  return stretchEngineFactoryPromise;
}

/** Tone 15 wraps the AudioContext with standardized-audio-context; the engine's
 *  AudioWorkletNode must be constructed on the NATIVE context underneath. */
function resolveNativeContext(rawContext) {
  return rawContext?._nativeAudioContext ?? rawContext?._nativeContext ?? rawContext;
}

export class StretchPlayerPlayback extends PlayerPlayback {
  constructor(options = {}) {
    super(options);
    this.node = null;
    this._output = null;
    this._streamTap = null;
    this._streamSource = null;
    this._bufferEndSec = 0;
    // Distinct strategy label: the adapter swaps engines when the resolved
    // strategy string changes, so 'stretch' must not masquerade as 'prebuffer'.
    this.decodeStrategy = 'stretch';
    // Rate interpretation + independent pitch shift (see file header).
    this._rateMode = 'stretch';
    this._pitchSemitones = 0;
    // Commanded speed MAGNITUDE before the engine's rate floor — the speed gate
    // reads it to glide to silence at ~0 (a true stop), while the engine keeps
    // its 0.01 floor internally. `_speedGateMuted` tracks the gate's committed
    // state so it only ramps the gain on a transition, not every rate update.
    this._commandedRateMag = 1;
    this._speedGateMuted = false;
    // Playhead projection in ENGINE space, which equals forward-material time:
    // the engine reads its one buffer backwards on a negative rate, so engine
    // time descends under reverse rather than the buffer being pre-flipped.
    this._lastEngineSec = 0;
    this._lastEngineAt = 0;
    // Calibration anchor: where the audible playhead SHOULD be, set from
    // intent (play/seek/rate change). The engine's raw inputTime is compared
    // against this to estimate the read-ahead lead.
    this._anchorEngineSec = 0;
    this._anchorAt = 0;
    this._inputLeadOutSec = null;
    this._granularListeners = new Set();
    // Rate-param shim (same shape as the streaming sink's): the engine has no
    // AudioParam for rate, so effect automation ramps land as engine schedules.
    this._playbackRateParam = {
      value: 1,
      rampTo: (target) => {
        this.setPlaybackRate(target, { immediate: true });
      },
      setValueAtTime: (target) => {
        this.setPlaybackRate(target, { immediate: true });
      },
    };
  }

  getPlaybackRateParam() {
    if (!this.node) return super.getPlaybackRateParam();
    return this._playbackRateParam;
  }

  /** Both engine handshakes — worklet construction and buffer upload — await a
   *  reply from the AudioWorklet processor, which only runs while the context is
   *  RUNNING. The play path resumes via triggerPlay's _ensureContextStarted, but
   *  the mid-session buffered unlock builds + feeds the engine through init()/
   *  load() WITHOUT playing, right after tearing down the streamed voice — and
   *  that teardown (audio.src='' + pause) can suspend the shared context on
   *  mobile. Resume the raw context directly here so either handshake can be
   *  answered. Not routed through _ensureContextStarted on purpose: that flag is
   *  the play-gesture latch, and setting it on this non-play path would suppress
   *  the real resume triggerPlay owes the context. A no-op when already running,
   *  so the boot/desktop paths are untouched. */
  async _ensureEngineContextRunning(timeoutMs = CONTEXT_RESUME_TIMEOUT_MS) {
    const rawContext = this.Tone?.getContext?.()?.rawContext ?? this.Tone?.context?.rawContext;
    const context = rawContext ? resolveNativeContext(rawContext) : null;
    // No inspectable context is not evidence of a suspended one. Say yes and let the bounded
    // handshakes below be the judge, exactly as before this guard existed — otherwise an
    // environment whose context simply cannot be read loses the engine for no reason.
    if (!context || typeof context.state !== 'string') {
      return true;
    }
    if (context.state !== 'suspended' || typeof context.resume !== 'function') {
      return context.state === 'running';
    }
    // Chrome does not REJECT resume() when autoplay policy blocks it — it leaves the promise
    // pending until a user gesture arrives, which on a page that boots without one is never.
    // Awaiting it unguarded stalls the whole boot, so bound the wait and report back instead
    // of blocking. A permitted resume settles immediately, so this costs nothing when allowed.
    let timer = null;
    try {
      await Promise.race([
        context.resume(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } catch (_) {
      // A rejected resume is just a context that will not run; the caller decides.
    } finally {
      clearTimeout(timer);
    }
    return context.state === 'running';
  }

  async init({ Tone, effectRacks, effectOrder }) {
    this.Tone = Tone;
    if (!this.Tone) {
      throw new Error('[StretchPlayerPlayback] Tone.js reference is required.');
    }
    if (effectRacks) {
      this.effectRacks = effectRacks;
    }
    if (Array.isArray(effectOrder) && effectOrder.length) {
      this.effectOrder = [...effectOrder];
    }

    const rawContext = this.Tone.getContext?.()?.rawContext ?? this.Tone.context?.rawContext;
    if (!rawContext) {
      throw new Error('[StretchPlayerPlayback] No raw AudioContext available.');
    }
    // The engine's construction handshake waits on a processor 'ready' reply, which only
    // arrives while the context runs: a mid-session unlock builds the engine right after the
    // streamed voice's teardown, which can suspend the context on mobile — resume or it hangs.
    //
    // A context that cannot be resumed is not a failure, it is a page that has not been
    // clicked yet — autoplay policy holds the context suspended until a gesture. Building the
    // worklet now would hang its handshake for the full RPC timeout and then degrade anyway,
    // so take the plain sink immediately and let the voice boot.
    if (!(await this._ensureEngineContextRunning())) {
      console.info(
        '[StretchPlayerPlayback] AudioContext still suspended (no user gesture yet) — booting on varispeed playback instead of the time-stretch engine.'
      );
      this.node = null;
      await super.init({ Tone, effectRacks, effectOrder });
      return;
    }
    try {
      const SignalsmithStretch = await withEngineTimeout(loadStretchEngineFactory(), 'module load');
      const construction = Promise.resolve(SignalsmithStretch(resolveNativeContext(rawContext)));
      try {
        this.node = await withEngineTimeout(construction, 'worklet construction');
      } catch (constructionError) {
        // The construction may still complete AFTER the timeout — a worklet
        // node nobody owns. Disconnect it on late arrival so it can't leak
        // into the native graph while the voice runs on the fallback sink.
        void construction
          .then((lateNode) => {
            try { lateNode?.stop?.(); } catch (_) {}
            try { lateNode?.disconnect?.(); } catch (_) {}
          })
          .catch(() => {});
        throw constructionError;
      }
    } catch (error) {
      // Engine unavailable (worklet/WASM unsupported or blocked): degrade to
      // the plain buffer-source sink so the voice still plays — as varispeed.
      console.error('[StretchPlayerPlayback] Time-stretch engine failed to initialise; falling back to varispeed playback.', error);
      this.node = null;
      await super.init({ Tone, effectRacks, effectOrder });
      return;
    }

    // Tone-facing output wrapper: the adapter rewires the voice source through
    // `this.player` (connect/disconnect), and the gain doubles as a click-free
    // start/stop envelope the raw worklet node doesn't provide.
    this._output = new this.Tone.Gain(1);

    // The worklet is a native node; Tone's standardized-audio-context graph
    // does NOT hear audio injected directly into a wrapper's native gain (its
    // wrapper-to-wrapper edges run through separate native plumbing — verified
    // empirically). Bridge across the graphs with a MediaStream loop: native
    // worklet → MediaStreamDestination → createMediaStreamSource on the
    // wrapper context, which IS a first-class node in Tone's graph. Costs a
    // few ms of extra output latency — revisit if the engine graduates from
    // trial to the default playback path.
    const nativeContext = resolveNativeContext(rawContext);
    this._streamTap = nativeContext.createMediaStreamDestination();
    this.node.connect(this._streamTap);
    this._streamSource = rawContext.createMediaStreamSource(this._streamTap.stream);
    this.Tone.connect(this._streamSource, this._output);
    this.player = this._output;

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

    this.node.setUpdateInterval(0.15, () => this._handleWorkletUpdate());
    this.node.onGranularGrains = (events) => {
      const audioNowSec = resolveNativeContext(rawContext).currentTime;
      for (const event of events || []) {
        this._granularListeners.forEach((listener) => {
          try { listener(event, audioNowSec); } catch (_) {}
        });
      }
    };
    this._applyPlaybackProperties({ immediate: true });
  }

  setGranularParams(params) {
    if (!this.node?.setGranularParams) return false;
    void this.node.setGranularParams(params);
    return true;
  }

  getGranularWorkletSurface() {
    if (!this.node) return null;
    return {
      setParams: (params) => this.setGranularParams(params),
      addGrainListener: (listener) => this.addGranularGrainListener(listener),
    };
  }

  addGranularGrainListener(listener) {
    if (!this.node || typeof listener !== 'function') return null;
    this._granularListeners.add(listener);
    return () => this._granularListeners.delete(listener);
  }

  // ——— UI (forward-material ms) ⇄ engine (buffer seconds) mapping ———

  _durationSec() {
    const duration = Number(this.durationMs);
    return Number.isFinite(duration) && duration > 0 ? duration / 1000 : 0;
  }

  // Engine space == forward-material space: reverse is a negative read rate in
  // the worklet, not a flipped buffer, so these mappings are plain identity.
  _engineSecFromUiMs(ms) {
    return Math.max(0, Number(ms) || 0) / 1000;
  }

  _uiMsFromEngineSec(engineSec) {
    return Math.max(0, Number(engineSec) || 0) * 1000;
  }

  /** Active loop bounds in engine space (== UI space), or null. */
  _engineLoopBounds() {
    if (!this.loopEnabled || !this.loopRange) return null;
    const startSec = this.loopRange.start / 1000;
    const endSec = this.loopRange.end / 1000;
    if (!(endSec > startSec)) return null;
    return { startSec, endSec };
  }

  /** Bridge the playhead across engine updates through the active loop. The
   *  engine wraps its own loop (forward at loopEnd, reverse at loopStart); this
   *  only fills the gap between reported updates, so it mirrors that direction. */
  _wrapEngineSec(engineSec) {
    const bounds = this._engineLoopBounds();
    if (!bounds) return engineSec;
    const length = bounds.endSec - bounds.startSec;
    if (length <= 0) return engineSec;
    if (!this.isReversed) {
      if (engineSec > bounds.endSec) {
        return bounds.startSec + ((engineSec - bounds.startSec) % length);
      }
    } else if (engineSec < bounds.startSec) {
      return bounds.endSec - ((bounds.endSec - engineSec) % length);
    }
    return engineSec;
  }

  _setEngineAnchors(engineSec, atTime) {
    this._anchorEngineSec = engineSec;
    this._anchorAt = atTime;
    this._lastEngineSec = engineSec;
    this._lastEngineAt = atTime;
  }

  /** Feed the decoded buffer to the worklet instead of a Tone.Player. The one
   *  stored buffer serves both directions — reverse is a negative read rate, so
   *  the buffer is never copied or flipped. */
  async _adoptDecodedBuffer(audioBuffer) {
    if (!this.node) return super._adoptDecodedBuffer(audioBuffer);
    // The engine's buffer upload is a worklet RPC — the processor only answers
    // while the AudioContext is running. See _ensureEngineContextRunning: a
    // mid-session unlock reaches here on a context the streamed voice's teardown
    // may have suspended on mobile, or addBuffers waits forever.
    //
    // Waits as long as the engine's own RPC timeout, not the short boot probe: reaching here
    // means a voice is mid-session with a real gesture behind it, so a slow resume is worth
    // waiting for. Failing fast would only push the same wait onto addBuffers below.
    await this._ensureEngineContextRunning(ENGINE_RPC_TIMEOUT_MS);
    const channels = [];
    for (let i = 0; i < audioBuffer.numberOfChannels; i += 1) {
      channels.push(audioBuffer.getChannelData(i));
    }
    try {
      this.node.dropBuffers();
    } catch (_) {}
    // Field diagnostics: on phones the upload of a long track's channel data is
    // where a silent worklet hang was observed — bracket it so a device report
    // can tell "upload never answered" from any later failure.
    const uploadStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    console.info(`[StretchPlayerPlayback] Uploading ${channels.length}ch × ${audioBuffer.length} frames to the engine…`);
    const endSec = await withEngineTimeout(this.node.addBuffers(channels), 'buffer upload');
    console.info(`[StretchPlayerPlayback] Engine buffer upload done in ${Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - uploadStartedAt)}ms.`);
    this._bufferEndSec = Number.isFinite(endSec) && endSec > 0 ? endSec : audioBuffer.duration;

    const decodedDurationMs = Number(audioBuffer.duration || 0) * 1000;
    if (Number.isFinite(decodedDurationMs) && decodedDurationMs > 0) {
      this.durationMs = decodedDurationMs;
    } else {
      this.durationMs = resolveTrackDurationMs(this.trackData);
    }
  }

  async triggerPlay(options = {}) {
    if (!this.node) return super.triggerPlay(options);

    if (!this.isLoaded) {
      await this.load();
    }

    if (this._isPlaying && !options.force) {
      return;
    }

    await this._waitForPendingStop();
    await this._ensureContextStarted();
    this._normalizeStoredLoopRange();

    const offsetMs = Math.max(0, Math.min(this.currentOffsetMs, this.durationMs));
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

    const engineInput = this._engineSecFromUiMs(offsetMs);
    this._applyLoopSettingsToPlayer();
    this.node.schedule({
      output: startTime,
      active: true,
      input: engineInput,
      rate: this._signedRate(),
      semitones: this._currentEffectiveSemitones(),
    });
    // Respect the speed gate: starting at a ~0 speed stays silent. Sync the
    // gate's tracked state so it only ramps again on a real transition.
    this._speedGateMuted = this._isSpeedStopped();
    this._output.gain.rampTo(this._speedGateMuted ? 0 : 1, 0.01);

    this._isPlaying = true;
    this.basePositionMs = offsetMs;
    this.currentOffsetMs = offsetMs;
    this.playStartTimestamp = startTime;
    this._scheduledStartTime = startTime;
    this._setEngineAnchors(engineInput, startTime);
  }

  async pause() {
    if (!this.node) return super.pause();
    if (!this._isPlaying) return;
    const now = this.Tone.now();
    this.currentOffsetMs = this.getCurrentPositionMs();
    const stopTime = now + this._computeReleaseTime();
    this._isPlaying = false;
    this._scheduledStartTime = null;
    this._output.gain.rampTo(0, Math.max(0.005, stopTime - now));
    this.node.stop(stopTime);
    this._registerPendingStop(stopTime);
    this.basePositionMs = this.currentOffsetMs;
    this.playStartTimestamp = now;
    await this._awaitStopAtTime(stopTime);
  }

  async triggerStop() {
    if (!this.node) return super.triggerStop();
    const now = this.Tone.now();
    const stopTime = now + this._computeReleaseTime();
    this._isPlaying = false;
    this._scheduledStartTime = null;
    this._output.gain.rampTo(0, Math.max(0.005, stopTime - now));
    this.node.stop(stopTime);
    this._registerPendingStop(stopTime);
    this.currentOffsetMs = 0;
    this.basePositionMs = 0;
    this.playStartTimestamp = now;
    await this._awaitStopAtTime(stopTime);
  }

  /** Seeks reschedule the engine's input position in place — no stop/restart
   *  cycle like the buffer-source sink needs. */
  async setPosition(ms) {
    if (!this.node) return super.setPosition(ms);
    const clamped = Math.max(0, Math.min(ms, this.durationMs || ms));
    this.currentOffsetMs = clamped;
    const now = this.Tone.now();

    if (this._isPlaying) {
      const engineSec = this._engineSecFromUiMs(clamped);
      this.node.schedule({ input: engineSec });
      this._setEngineAnchors(engineSec, now);
    }
    this.basePositionMs = clamped;
    this.playStartTimestamp = now;
  }

  clearLoop() {
    if (!this.node) return super.clearLoop();
    this.loopRange = null;
    this.loopEnabled = false;
    // Disarm the engine loop too — clearing only local state would leave audio
    // wrapping at the old loop while the UI believes looping is off.
    this._applyLoopSettingsToPlayer();
  }

  _applyLoopSettingsToPlayer() {
    if (!this.node) return super._applyLoopSettingsToPlayer();
    const bounds = this._engineLoopBounds();
    // Equal loop bounds disable looping in the engine.
    const loopStart = bounds ? bounds.startSec : 0;
    const loopEnd = bounds ? Math.max(bounds.endSec, bounds.startSec + 0.01) : 0;
    this.node.schedule({ loopStart, loopEnd });
  }

  /** Positive rate MAGNITUDE (tape-pitch log and the UI rate param need it). */
  _currentRate() {
    return Math.max(0.01, Number(this.playbackRate) || 1);
  }

  /** Rate as the engine consumes it: SIGNED, negative = reverse. Direction is
   *  the only reverse mechanism now — the worklet reads its one stored buffer
   *  backwards on a negative rate (no flipped buffer), so engine time stays
   *  true forward-material time and every UI⇄engine mapping is identity. */
  _signedRate() {
    return this.isReversed ? -this._currentRate() : this._currentRate();
  }

  /** Semitone shift sent to the engine: the tape emulation (pitch tracking the
   *  rate ratio in varispeed mode) plus the independent pitch shift. */
  _currentEffectiveSemitones() {
    const tape = this._rateMode === 'varispeed' ? 12 * Math.log2(this._currentRate()) : 0;
    const total = tape + (Number(this._pitchSemitones) || 0);
    return Number.isFinite(total) ? Math.max(-60, Math.min(60, total)) : 0;
  }

  _applyPlaybackProperties(options = {}) {
    if (!this.node) return super._applyPlaybackProperties(options);
    // The UI rate param stays a positive magnitude; the engine gets the signed
    // rate so a negative value reverses the read direction.
    this._playbackRateParam.value = this._currentRate();
    this.node.schedule({
      rate: this._signedRate(),
      semitones: this._currentEffectiveSemitones(),
    });
    this._applySpeedGate();
  }

  /** True when the commanded speed is ~0 — the knob is at its stop point. */
  _isSpeedStopped() {
    return this._commandedRateMag < SPEED_STOP_EPSILON;
  }

  /** Glide the output to silence when the commanded speed is ~0, back to unity
   *  when it isn't. Only ramps on a state TRANSITION — the moon updates the rate
   *  every frame, so ramping unconditionally would churn the gain AudioParam on
   *  the hot path. Only while playing — play/pause/stop own the envelope
   *  otherwise. This is what makes 0 a real stop (not a rate-floor crawl). */
  _applySpeedGate(ramp = SPEED_GATE_RAMP_SEC) {
    if (!this._isPlaying || !this._output) return;
    const muted = this._isSpeedStopped();
    if (muted === this._speedGateMuted) return;
    this._speedGateMuted = muted;
    this._output.gain.rampTo(muted ? 0 : 1, ramp);
  }

  /** 'stretch' (pitch locked while tempo moves) or 'varispeed' (tape). */
  setRateMode(mode) {
    if (!this.node) return super.setRateMode(mode);
    const normalized = mode === 'varispeed' ? 'varispeed' : 'stretch';
    if (this._rateMode !== normalized) {
      this._rateMode = normalized;
      this._applyPlaybackProperties();
    }
    return true;
  }

  getRateMode() {
    if (!this.node) return super.getRateMode();
    return this._rateMode;
  }

  /** Pitch shift with tempo locked. Returns true when the engine handled it. */
  setPitchSemitones(semitones) {
    if (!this.node) return super.setPitchSemitones(semitones);
    const numeric = Number(semitones);
    this._pitchSemitones = Number.isFinite(numeric) ? Math.max(-48, Math.min(48, numeric)) : 0;
    this._applyPlaybackProperties();
    return true;
  }

  getPitchSemitones() {
    if (!this.node) return super.getPitchSemitones();
    return this._pitchSemitones;
  }

  setPlaybackRate(rate, { immediate = false } = {}) {
    if (!this.node) return super.setPlaybackRate(rate, { immediate });
    if (this._speedControlLocked) return;
    const numeric = Number(rate);
    // Modules send a positive speed MAGNITUDE here (direction rides
    // setPlaybackReverse); remember it pre-floor so the speed gate can silence
    // a true zero instead of playing the engine's 0.01 crawl.
    this._commandedRateMag = Number.isFinite(numeric) ? Math.max(0, Math.abs(numeric)) : 1;
    const target = Number.isFinite(numeric) ? Math.max(0.01, Math.abs(numeric)) : 1;

    if (this._isPlaying) {
      // Re-anchor the playhead projection before the rate changes.
      const positionMs = this.getCurrentPositionMs();
      const now = this.Tone.now();
      this.basePositionMs = positionMs;
      this.currentOffsetMs = positionMs;
      this.playStartTimestamp = now;
      this._setEngineAnchors(this._engineSecFromUiMs(positionMs), now);
    }

    this.playbackRate = target;
    this._applyPlaybackProperties({ immediate });
  }

  /** True reverse with no second buffer: the worklet reads the one stored
   *  buffer backwards on a negative rate. Flipping direction is just a
   *  reschedule at the signed rate from the current position — no buffer
   *  re-upload, no position mirroring, seamless at the zero crossing. */
  async setPlaybackReverse(reverse, options = {}) {
    if (!this.node) return super.setPlaybackReverse(reverse, options);
    const desired = Boolean(reverse);
    if (this.isReversed === desired) return;

    // Capture the playhead in the OLD direction, then flip: engine space equals
    // forward-material time, so the position is unchanged by the flip.
    const positionMs = this._isPlaying ? this.getCurrentPositionMs() : this.currentOffsetMs;
    this.isReversed = desired;
    this._applyLoopSettingsToPlayer();

    const now = this.Tone.now();
    this.currentOffsetMs = positionMs;
    this.basePositionMs = positionMs;
    this.playStartTimestamp = now;
    if (this._isPlaying) {
      const engineSec = this._engineSecFromUiMs(positionMs);
      this.node.schedule({
        input: engineSec,
        active: true,
        rate: this._signedRate(),
        semitones: this._currentEffectiveSemitones(),
      });
      this._setEngineAnchors(engineSec, now);
    }
  }

  getCurrentPositionMs() {
    if (!this.node) return super.getCurrentPositionMs();
    if (!this._isPlaying) {
      return this.currentOffsetMs;
    }
    const now = this.Tone.now();
    if (this._scheduledStartTime && now < this._scheduledStartTime) {
      return this.basePositionMs;
    }

    const elapsed = Math.max(0, now - this._lastEngineAt);
    // Signed rate: engine time descends under reverse.
    let engineSec = this._lastEngineSec + elapsed * this._signedRate();
    // The engine wraps its own loop; only bridge the gap between updates.
    engineSec = this._wrapEngineSec(engineSec);

    const durationSec = this._durationSec();
    if (durationSec > 0) {
      engineSec = Math.min(Math.max(0, engineSec), durationSec);
    }

    const duration = this.durationMs || 0;
    let positionMs = this._uiMsFromEngineSec(engineSec);
    if (duration > 0) {
      positionMs = Math.min(Math.max(0, positionMs), duration);
    }
    this.currentOffsetMs = positionMs;
    return positionMs;
  }

  _handleWorkletUpdate() {
    const raw = Number(this.node?.inputTime);
    if (!Number.isFinite(raw)) return;
    const now = this.Tone?.now?.() ?? 0;
    // Signed rate: the projection descends under reverse. The read-ahead lead
    // is expressed in output-seconds, so it divides/multiplies by the signed
    // rate consistently and stays a positive quantity in either direction.
    const signedRate = this._signedRate();

    // The engine's raw inputTime LEADS the audible output by its read-ahead.
    // Estimate that lead against the intent anchor (set at play/seek/rate
    // change) and rebase the playhead on the corrected value, so UI position
    // tracks what the listener hears.
    if (this._isPlaying && now > this._anchorAt) {
      const expected = this._wrapEngineSec(
        this._anchorEngineSec + (now - this._anchorAt) * signedRate,
      );
      const leadOut = (raw - expected) / signedRate;
      const plausible = Number.isFinite(leadOut) && leadOut >= -0.25 && leadOut <= 1.0;
      // Right after an intent change (seek/rate/play), a worklet update may
      // still carry the PRE-change position; committing it would snap the
      // playhead backwards until the next update. Distrust implausible
      // samples inside that window and keep the anchor projection instead.
      const sinceAnchorSec = now - this._anchorAt;
      if (!plausible && sinceAnchorSec < 0.35) {
        return;
      }
      if (plausible) {
        const clamped = Math.min(MAX_INPUT_LEAD_SEC, Math.max(0, leadOut));
        this._inputLeadOutSec = this._inputLeadOutSec === null
          ? clamped
          : this._inputLeadOutSec * (1 - INPUT_LEAD_EMA_WEIGHT) + clamped * INPUT_LEAD_EMA_WEIGHT;
      }
    }

    const durationSec = this._durationSec();
    let corrected = raw - (this._inputLeadOutSec ?? 0) * signedRate;
    corrected = Math.max(0, durationSec > 0 ? Math.min(corrected, durationSec) : corrected);
    this._lastEngineSec = corrected;
    this._lastEngineAt = now;

    if (!this._isPlaying || this.isLooping()) {
      return;
    }
    // Natural end: forward runs off the buffer end, reverse runs off the start.
    const endSec = Number(this._bufferEndSec);
    const reachedEnd = this.isReversed
      ? corrected <= END_EPSILON_SEC
      : Number.isFinite(endSec) && endSec > 0 && corrected >= endSec - END_EPSILON_SEC;
    if (reachedEnd) {
      this._isPlaying = false;
      this._scheduledStartTime = null;
      try {
        this.node.stop();
      } catch (_) {}
      this._output?.gain?.rampTo?.(0, 0.01);
      this.currentOffsetMs = 0;
      this.basePositionMs = 0;
      this.playStartTimestamp = now;
      this._notifyStopListeners({ reason: 'ended' });
    }
  }

  dispose() {
    if (this.node) {
      try {
        this.node.stop();
      } catch (_) {}
      try {
        this.node.dropBuffers();
      } catch (_) {}
      try {
        this.node.disconnect();
      } catch (_) {}
    }
    try {
      this._streamSource?.disconnect?.();
    } catch (_) {}
    try {
      this._streamTap?.stream?.getTracks?.().forEach((track) => track.stop());
    } catch (_) {}
    this._streamSource = null;
    this._streamTap = null;
    this.node = null;
    this._bufferEndSec = 0;
    this._rateMode = 'stretch';
    this._pitchSemitones = 0;
    this._lastEngineSec = 0;
    this._lastEngineAt = 0;
    this._anchorEngineSec = 0;
    this._anchorAt = 0;
    this._inputLeadOutSec = null;
    this._granularListeners.clear();
    super.dispose();
    this._output = null;
  }
}
