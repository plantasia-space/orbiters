/**
 * @file granular/GranularEngine.js
 * @description Granular controller for a single voice. On the stretch sink it
 *              delegates rendering to the voice's AudioWorklet, where granular
 *              and Signalsmith share one PCM store. The native buffer-source
 *              renderer remains for the classic fallback sink.
 *
 *              The engine is a SOURCE-LEVEL companion to the dry player: by
 *              default its read pointer follows the player's playhead
 *              (pointer = playhead + spray), and mixes its wet output
 *              into the same bus the dry signal feeds, so transport, seek and
 *              loop behavior stay owned by the player. Two parameters detach
 *              the pointer from the playhead: `positionAnchor` pins it to an
 *              absolute spot in the track, and `seekRate` sends it traveling
 *              on its own (wrapping at the track ends). The dry player is
 *              never affected either way.
 *
 *              One engine per voice; several control modules can attach to it,
 *              each driving its own subset of the parameter surface. Wet is
 *              resolved as the max across attachments (any active module makes
 *              the engine audible; all modules at bypass = silent), dry level
 *              as the min, every other parameter as last-writer-wins.
 *
 *              All collaborators (audio context, timers, playhead, buffer) are
 *              injected so scheduling and pooling are unit-testable headlessly.
 */

/** The family id this engine lives under at the adapter's source-engine host. */
export const GRANULAR_ENGINE_ID = 'granular';

export const GRANULAR_PARAM_DEFAULTS = Object.freeze({
  /** Output level of the granular mix into the voice bus (0–1). 0 = bypass. */
  wet: 0,
  /** Level of the dry source while the engine is active (0–1). */
  dryLevel: 1,
  /** Grains per second. */
  density: 12,
  /** Grain length in seconds. */
  grainSize: 0.12,
  /** Per-grain playback rate (pitch ratio; 1 = source pitch). */
  grainPitch: 1,
  /** Random stereo placement width (0 = center, 1 = full width). */
  panSpread: 0.3,
  /** Random pointer jitter in seconds (bidirectional around the pointer).
   *  Defaults to a small nonzero spray so an engaged engine is immediately
   *  granular rather than a plain echo of the playhead. */
  positionSpray: 0.04,
  /** Normalized read-pointer anchor (0 = track start … 1 = end). Negative =
   *  unanchored: the pointer follows the playhead. */
  positionAnchor: -1,
  /** Autonomous pointer travel, in seconds per second, added to the mode's
   *  natural rate (anchored: 0 = hold the anchor; unanchored: 1 = playback
   *  rate, so -2 travels backwards at 1×). Nonzero decouples the pointer;
   *  it then wraps at the track ends. */
  seekRate: 0,
  /** Chance (0–1) that a grain plays its slice reversed. */
  reverseProbability: 0,
  /** Envelope attack fraction of the grain (0.05 sharp … 0.95 soft swell). */
  envelopeShape: 0.5,
});

const WET_EPSILON = 0.001;
const MIN_GRAIN_SEC = 0.02;
const MAX_GRAIN_SEC = 0.5;
const MIN_DENSITY = 0.5;
const MAX_DENSITY = 80;
/** Seek rates this close to 0 keep the unanchored pointer glued to the playhead. */
const SEEK_EPSILON = 0.001;
const MAX_SEEK_RATE = 3;
/** Poll cadence while attached + engaged but transport is stopped. */
const IDLE_TICK_MS = 250;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

export class GranularEngine {
  /**
   * @param {object} options
   * @param {BaseAudioContext} options.context - Context the grain nodes are created on.
   * @param {() => AudioBuffer|null} options.getBuffer - Returns the voice's decoded buffer (null until loaded).
   * @param {() => number} options.getPositionMs - Playhead position of the dry player.
   * @param {() => boolean} options.isPlaying - Transport state of the dry player.
   * @param {(level: number) => void} [options.onDryLevelChange] - Sink for the dry-leg crossfade level.
   * @param {() => number} [options.random] - Random source (injectable for tests).
   * @param {(fn: Function, ms: number) => any} [options.scheduleTimer] - Timer (injectable for tests).
   * @param {(handle: any) => void} [options.cancelTimer]
   * @param {number} [options.tickIntervalMs] - Scheduler quantum while active.
   * @param {number} [options.lookAheadSec] - How far ahead grains are scheduled.
   * @param {number} [options.maxOverlap] - Ceiling for density × grainSize (polyphony budget).
   * @param {number} [options.maxActiveGrains] - Hard cap on simultaneously sounding grains.
   * @param {object|null} [options.worklet] - Worklet controls when it owns the PCM and rendering.
   */
  constructor({
    context,
    getBuffer,
    getPositionMs,
    isPlaying,
    onDryLevelChange = null,
    random = Math.random,
    scheduleTimer = (fn, ms) => setTimeout(fn, ms),
    cancelTimer = (handle) => clearTimeout(handle),
    tickIntervalMs = 25,
    lookAheadSec = 0.1,
    maxOverlap = 6,
    maxActiveGrains = 20,
    worklet = null,
  } = {}) {
    if (!context || typeof context.createGain !== 'function') {
      throw new Error('[GranularEngine] An audio context with createGain() is required.');
    }
    this._context = context;
    this._getBuffer = typeof getBuffer === 'function' ? getBuffer : () => null;
    this._getPositionMs = typeof getPositionMs === 'function' ? getPositionMs : () => 0;
    this._isPlaying = typeof isPlaying === 'function' ? isPlaying : () => false;
    this._onDryLevelChange = typeof onDryLevelChange === 'function' ? onDryLevelChange : null;
    this._grainListeners = new Set();
    this._random = random;
    this._scheduleTimer = scheduleTimer;
    this._cancelTimer = cancelTimer;
    this._tickIntervalMs = tickIntervalMs;
    this._lookAheadSec = lookAheadSec;
    this._maxOverlap = maxOverlap;
    this._maxActiveGrains = maxActiveGrains;
    this._worklet = worklet && typeof worklet.setParams === 'function' ? worklet : null;

    /** Wet output of the native renderer. The owner connects this into the
     *  voice bus. Always constructed — the backend can swap under a live
     *  engine (see setWorklet), so the native leg must exist even when the
     *  worklet renders today. Idle at gain 0 while the worklet owns rendering. */
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 0;

    this._attachments = new Map();
    this._attachmentSeq = 0;
    this._params = { ...GRANULAR_PARAM_DEFAULTS };

    this._buffer = null;
    this._bufferDurationSec = 0;
    this._running = false;
    this._disposed = false;
    this._timer = null;
    this._nextGrainTime = null;
    this._appliedWet = 0;
    this._appliedDryLevel = 1;

    this._pointerSec = 0;
    this._pointerFollowing = true;
    this._appliedAnchorSec = null;
    this._lastPlayheadSec = 0;
    this._lastTickTime = null;

    this._voicePool = [];
    this._scratchPool = [];
    this._activeGrains = 0;
    this._workletGrainRelay = (spawn, audioNowSec) => {
      this._grainListeners.forEach((listener) => {
        try { listener(spawn, audioNowSec); } catch (_) {}
      });
    };
    this._workletUnsubscribe = this._worklet?.addGrainListener?.(this._workletGrainRelay) ?? null;

    /** Counters for headless verification and perf sampling. */
    this.stats = {
      grainsScheduled: 0,
      grainsSkipped: 0,
      voicesCreated: 0,
      scratchBuffersCreated: 0,
    };
  }

  /**
   * Registers a control module on the engine.
   * @returns {{ setParams(partial: object, opts?: { replace?: boolean }): void, detach(): void }}
   */
  attach() {
    if (this._disposed) {
      throw new Error('[GranularEngine] Cannot attach to a disposed engine.');
    }
    const id = (this._attachmentSeq += 1);
    this._attachments.set(id, { params: {} });
    return {
      setParams: (partial, { replace = false } = {}) => {
        const attachment = this._attachments.get(id);
        if (!attachment || this._disposed) return;
        if (replace) attachment.params = {};
        for (const [key, value] of Object.entries(partial || {})) {
          if (key in GRANULAR_PARAM_DEFAULTS && Number.isFinite(Number(value))) {
            attachment.params[key] = Number(value);
          }
        }
        this._recomputeParams();
      },
      detach: () => {
        if (!this._attachments.delete(id)) return;
        this._recomputeParams();
      },
    };
  }

  /**
   * Rebinds the engine to the voice's CURRENT rendering backend. The playback
   * backend swaps in place during a voice's life (streaming ⇄ buffered — e.g.
   * the explicit full-track unlock), and the engine's render mode is set by
   * which surface exists: built beside a streaming sink it renders natively,
   * but once the stretch worklet owns the PCM it must render THERE — a native
   * engine's output is inaudible beside the worklet sink. The host calls this
   * on every backend swap so existing attachments, and modules added later,
   * drive a live renderer instead of the one the engine was born with.
   * @param {object|null} worklet - The new backend's worklet controls, or null
   *        to render natively.
   */
  setWorklet(worklet) {
    const next = worklet && typeof worklet.setParams === 'function' ? worklet : null;
    if (this._disposed || next === this._worklet) return;
    this._workletUnsubscribe?.();
    this._workletUnsubscribe = null;
    if (this._worklet) {
      // Park the outgoing worklet at defaults so a lingering processor can't
      // keep rendering the old params.
      try { this._worklet.setParams({ ...GRANULAR_PARAM_DEFAULTS }); } catch (_) {}
    } else {
      // Leaving native mode: stop the scheduler, silence the native output,
      // and restore the dry leg its crossfade may have lowered — the new
      // backend owns its own dry path.
      if (this._timer !== null) {
        try { this._cancelTimer(this._timer); } catch (_) {}
        this._timer = null;
      }
      this._running = false;
      this._nextGrainTime = null;
      this._lastTickTime = null;
      this._applyWet(0);
      if (this._appliedDryLevel < 1) {
        this._onDryLevelChange?.(1);
        this._appliedDryLevel = 1;
      }
    }
    this._worklet = next;
    this._workletUnsubscribe = this._worklet?.addGrainListener?.(this._workletGrainRelay) ?? null;
    // Re-assert the merged params on the new backend (the native path also
    // re-engages the scheduler when wet is up).
    this._recomputeParams();
  }

  getParams() {
    return { ...this._params };
  }

  /**
   * The engine's current merged params with no allocation — the per-frame read
   * for visual layers. Contract: call it every frame, never cache the returned
   * reference (the engine replaces the object on every recompute) and never
   * mutate it. Use `getParams()` (copying) for tests/debug.
   */
  peekParams() {
    return this._params;
  }

  /**
   * Subscribes to grain-spawn events — the seam visual layers listen on.
   * The listener fires once per scheduled grain with
   * ({ time, positionSec, positionNorm, durationSec, pan, pitch, reversed },
   * audioNowSec) — attributes are written once per grain; no polling. Listener
   * errors are swallowed: a visual can never break the audio scheduler.
   * @param {(spawn: object, audioNowSec: number) => void} listener
   * @returns {() => void} unsubscribe.
   */
  addGrainListener(listener) {
    if (typeof listener !== 'function' || this._disposed) return () => {};
    this._grainListeners.add(listener);
    return () => this._grainListeners.delete(listener);
  }

  _recomputeParams() {
    const merged = { ...GRANULAR_PARAM_DEFAULTS };
    let wet = 0;
    let dryLevel = 1;
    this._attachments.forEach((attachment) => {
      for (const [key, value] of Object.entries(attachment.params)) {
        if (key === 'wet') wet = Math.max(wet, value);
        else if (key === 'dryLevel') dryLevel = Math.min(dryLevel, value);
        else merged[key] = value;
      }
    });
    merged.wet = clamp01(wet);
    merged.dryLevel = clamp01(dryLevel);
    merged.grainSize = clamp(merged.grainSize, MIN_GRAIN_SEC, MAX_GRAIN_SEC);
    merged.density = clamp(merged.density, MIN_DENSITY, MAX_DENSITY);
    // Polyphony budget: overlap (density × size) is what actually costs CPU.
    if (merged.density * merged.grainSize > this._maxOverlap) {
      merged.density = this._maxOverlap / merged.grainSize;
    }
    merged.positionAnchor = clamp(merged.positionAnchor, -1, 1);
    merged.seekRate = clamp(merged.seekRate, -MAX_SEEK_RATE, MAX_SEEK_RATE);
    merged.reverseProbability = clamp01(merged.reverseProbability);
    merged.panSpread = clamp01(merged.panSpread);
    merged.envelopeShape = clamp(merged.envelopeShape, 0.05, 0.95);
    this._params = merged;

    if (this._worklet) {
      this._worklet.setParams(merged);
      return;
    }

    this._applyDryLevel(merged.dryLevel);
    if (merged.wet > WET_EPSILON) {
      this._ensureRunning();
    }
  }

  _applyDryLevel(level) {
    if (Math.abs(level - this._appliedDryLevel) < 0.002) return;
    this._appliedDryLevel = level;
    this._onDryLevelChange?.(level);
  }

  _applyWet(target) {
    if (Math.abs(target - this._appliedWet) < 0.002) return;
    this._appliedWet = target;
    const gainParam = this.outputNode.gain;
    if (typeof gainParam.setTargetAtTime === 'function') {
      // Audio-rate smoothing: ~30 ms time constant keeps knob sweeps zipper-free.
      gainParam.setTargetAtTime(target, this._context.currentTime, 0.03);
    } else {
      gainParam.value = target;
    }
  }

  _ensureRunning() {
    if (this._worklet) return;
    if (this._running || this._disposed) return;
    this._running = true;
    this._lastTickTime = null;
    this._timer = this._scheduleTimer(() => this.tick(), 0);
  }

  /** One scheduler quantum. Public so headless tests can drive it directly. */
  tick() {
    if (this._worklet) return;
    this._timer = null;
    if (this._disposed) return;

    const params = this._params;
    const now = this._context.currentTime;

    const buffer = this._getBuffer();
    if (buffer !== this._buffer) {
      this._adoptBuffer(buffer);
    }

    const engaged = params.wet > WET_EPSILON && this._attachments.size > 0;
    const active = engaged && Boolean(this._buffer) && this._isPlaying() === true;

    this._applyWet(active ? params.wet : 0);

    if (!active) {
      // Transport stopped / buffer not ready: mute, drop pending schedule, and
      // either keep a slow poll (still engaged — must notice play resuming) or
      // stop entirely once disengaged and the last tails have drained.
      this._nextGrainTime = null;
      this._lastTickTime = null;
      if (engaged || this._activeGrains > 0) {
        this._timer = this._scheduleTimer(() => this.tick(), IDLE_TICK_MS);
      } else {
        this._running = false;
      }
      return;
    }

    this._updatePointer(now, params);

    if (this._nextGrainTime === null || this._nextGrainTime < now - 0.2) {
      this._nextGrainTime = now + 0.005;
    }
    const horizon = now + this._lookAheadSec;
    const interval = 1 / params.density;
    while (this._nextGrainTime < horizon) {
      this._scheduleGrain(this._nextGrainTime, params);
      this._nextGrainTime += interval;
    }

    this._timer = this._scheduleTimer(() => this.tick(), this._tickIntervalMs);
  }

  _adoptBuffer(buffer) {
    this._buffer = buffer || null;
    this._bufferDurationSec = Number(buffer?.duration) > 0 ? Number(buffer.duration) : 0;
    // A new buffer usually means a rebuilt playback backend — reassert the dry
    // crossfade so the fresh dry leg matches the engine's current state.
    if (this._buffer && this._appliedDryLevel < 1) {
      this._onDryLevelChange?.(this._appliedDryLevel);
    }
    this._scratchPool.length = 0;
    this._pointerFollowing = true;
    this._appliedAnchorSec = null;
  }

  _updatePointer(now, params) {
    const playheadSec = Math.max(0, Number(this._getPositionMs()) / 1000 || 0);
    const dt = this._lastTickTime === null ? 0 : Math.max(0, now - this._lastTickTime);
    this._lastTickTime = now;
    const duration = this._bufferDurationSec;
    const anchored = params.positionAnchor >= 0 && duration > 0;

    if (anchored) {
      // The anchor is the pointer's HOME: it sits there whenever seek is idle
      // (including after a seek sweep returns to rest), and seekRate travels
      // from it while engaged.
      const anchorSec = clamp(params.positionAnchor, 0, 1) * duration;
      const seeking = Math.abs(params.seekRate) >= SEEK_EPSILON;
      if (!seeking || this._appliedAnchorSec === null || Math.abs(anchorSec - this._appliedAnchorSec) > 1e-6) {
        this._pointerSec = anchorSec;
        this._appliedAnchorSec = anchorSec;
      } else {
        this._pointerSec += dt * params.seekRate;
      }
      this._pointerFollowing = false;
    } else {
      this._appliedAnchorSec = null;
      if (Math.abs(params.seekRate) < SEEK_EPSILON || this._pointerFollowing !== false) {
        // Follow mode (and the first tick after any reset): pointer = playhead.
        this._pointerSec = playheadSec;
        this._pointerFollowing = Math.abs(params.seekRate) < SEEK_EPSILON;
      } else {
        // Decoupled travel: playback's natural rate plus the seek offset, but
        // any playhead jump (seek, loop wrap) snaps the pointer back to
        // transport truth — the engine never fights the transport.
        const jump = Math.abs(playheadSec - this._lastPlayheadSec);
        if (jump > dt * 4 + 0.25) {
          this._pointerSec = playheadSec;
        } else {
          this._pointerSec += dt * (1 + params.seekRate);
        }
      }
    }
    if (duration > 0) {
      if (this._pointerFollowing) {
        this._pointerSec = clamp(this._pointerSec, 0, duration);
      } else {
        // An autonomous pointer wraps around the track ends.
        this._pointerSec = ((this._pointerSec % duration) + duration) % duration;
      }
    }
    this._lastPlayheadSec = playheadSec;
  }

  _scheduleGrain(startTime, params) {
    if (this._activeGrains >= this._maxActiveGrains) {
      this.stats.grainsSkipped += 1;
      return;
    }
    const buffer = this._buffer;
    const durationSec = this._bufferDurationSec;
    if (!buffer || durationSec <= 0) return;

    const size = Math.min(params.grainSize, Math.max(MIN_GRAIN_SEC, durationSec));
    const spray = params.positionSpray > 0 ? (this._random() * 2 - 1) * params.positionSpray : 0;
    const position = clamp(this._pointerSec + spray, 0, Math.max(0, durationSec - size));

    const source = this._context.createBufferSource();
    let scratch = null;
    if (params.reverseProbability > 0 && this._random() < params.reverseProbability) {
      scratch = this._prepareReversedSlice(buffer, position, size);
    }
    if (scratch) {
      source.buffer = scratch.buffer;
    } else {
      source.buffer = buffer;
    }
    if (source.playbackRate) {
      source.playbackRate.value = clamp(params.grainPitch, 0.25, 4);
    }

    const voice = this._voicePool.pop() ?? this._createVoice();
    const gainParam = voice.gain.gain;
    const attack = Math.max(0.003, size * params.envelopeShape);
    // Overlapping grains sum: normalize per-grain level by the overlap factor
    // so dense clouds don't clip while sparse dots stay audible.
    const peak = 1 / Math.sqrt(Math.max(1, params.density * size));
    gainParam.cancelScheduledValues?.(startTime);
    gainParam.setValueAtTime(0, startTime);
    gainParam.linearRampToValueAtTime(peak, startTime + Math.min(attack, size * 0.95));
    gainParam.linearRampToValueAtTime(0, startTime + size);

    const pan = params.panSpread > 0 ? clamp((this._random() * 2 - 1) * params.panSpread, -1, 1) : 0;
    const panParam = voice.panner.pan;
    if (panParam) {
      panParam.cancelScheduledValues?.(startTime);
      panParam.setValueAtTime(pan, startTime);
    }

    source.connect(voice.gain);
    this._activeGrains += 1;
    this.stats.grainsScheduled += 1;
    source.onended = () => {
      this._activeGrains = Math.max(0, this._activeGrains - 1);
      try {
        source.disconnect();
      } catch (_) {}
      this._releaseVoice(voice);
      if (scratch) this._releaseScratch(scratch);
    };
    source.start(startTime, scratch ? 0 : position, size);

    if (this._grainListeners.size > 0) {
      const spawn = {
        time: startTime,
        positionSec: position,
        positionNorm: durationSec > 0 ? position / durationSec : 0,
        durationSec: size,
        pan,
        pitch: clamp(params.grainPitch, 0.25, 4),
        reversed: Boolean(scratch),
      };
      const audioNowSec = this._context.currentTime;
      this._grainListeners.forEach((listener) => {
        try {
          listener(spawn, audioNowSec);
        } catch (_) {
          // A visual listener must never break the audio scheduler.
        }
      });
    }
  }

  _createVoice() {
    const gain = this._context.createGain();
    gain.gain.value = 0;
    const panner = this._context.createStereoPanner();
    gain.connect(panner);
    panner.connect(this.outputNode);
    this.stats.voicesCreated += 1;
    return { gain, panner };
  }

  _releaseVoice(voice) {
    if (this._disposed) return;
    this._voicePool.push(voice);
  }

  /**
   * Copies the grain's slice reversed into a pooled scratch buffer. True
   * reverse playback isn't supported by AudioBufferSourceNode, and keeping a
   * fully reversed copy of the track would double the decoded-audio memory —
   * a per-grain slice copy is tiny and the pool keeps GC churn flat.
   */
  _prepareReversedSlice(buffer, positionSec, sizeSec) {
    const sampleRate = Number(buffer.sampleRate) || this._context.sampleRate || 44100;
    const maxFrames = Math.ceil(MAX_GRAIN_SEC * sampleRate);
    const frames = Math.min(maxFrames, Math.max(1, Math.floor(sizeSec * sampleRate)));
    const startFrame = Math.max(0, Math.min(
      Math.floor(positionSec * sampleRate),
      (buffer.length || Math.floor(buffer.duration * sampleRate)) - frames,
    ));

    let scratch = this._scratchPool.pop() ?? null;
    if (!scratch) {
      try {
        scratch = {
          buffer: this._context.createBuffer(buffer.numberOfChannels, maxFrames, sampleRate),
        };
        this.stats.scratchBuffersCreated += 1;
      } catch (_) {
        return null;
      }
    }
    const channels = Math.min(buffer.numberOfChannels, scratch.buffer.numberOfChannels);
    for (let ch = 0; ch < channels; ch += 1) {
      const src = buffer.getChannelData(ch);
      const dst = scratch.buffer.getChannelData(ch);
      const last = startFrame + frames - 1;
      for (let i = 0; i < frames; i += 1) {
        dst[i] = src[last - i];
      }
    }
    return scratch;
  }

  _releaseScratch(scratch) {
    if (this._disposed) return;
    this._scratchPool.push(scratch);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._running = false;
    if (this._timer !== null) {
      try {
        this._cancelTimer(this._timer);
      } catch (_) {}
      this._timer = null;
    }
    // Restore the dry leg before letting go — a disposed engine must not
    // leave the voice half-muted.
    if (this._appliedDryLevel < 1) {
      this._onDryLevelChange?.(1);
    }
    this._attachments.clear();
    this._grainListeners.clear();
    this._voicePool.length = 0;
    this._scratchPool.length = 0;
    if (this._worklet) {
      this._worklet.setParams({ ...GRANULAR_PARAM_DEFAULTS });
      this._workletUnsubscribe?.();
      this._workletUnsubscribe = null;
    }
    try {
      this.outputNode?.disconnect();
    } catch (_) {}
  }
}

export default GranularEngine;
