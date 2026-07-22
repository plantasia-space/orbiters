import * as Tone from 'tone';
import { TransportController } from './transport/index.js';
import { Deck } from '../voice/Deck.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { PlayerPlayback } from './playback/player.js';
import { StreamingPlayer } from './playback/streamingPlayer.js';
import { StretchPlayerPlayback } from './playback/stretchPlayer.js';
import { MediaSessionController } from './MediaSessionController.js';
import { resolvePlaybackStrategy } from './playback/strategyResolver.js';
import { ParameterLockCoordinator } from './parameterLockCoordinator.js';
import { EffectsRack } from './effects/rack.js';
import { sanitizeMappings } from './effects/mappingManager.js';
import { ENGINE_REQUIREMENT, resolveModuleEngineRequirement } from './effects/index.js';
import { MAX_MODULES, isMobileDevice, setPlaybackState } from '../config/Constants.js';
import { AUDIO_PERFORMANCE_PRESETS } from '../config/audioPerformance.js';
import { ensureSilentAudioUnlock } from './SilentAudioUnlock.js';
import { createSourceEngineHost } from './sourceEngineHost.js';
import { syncCoordinator } from '../sync/SyncCoordinator.js';
import { getManualAudioOffsetMs } from '../config/audioOffset.js';
import { enforceStereo } from './audioNodeUtils.js';
import { isDebugSyncLoggingEnabled, isQuantizeStartForced } from '../sync/debugSync.js';

const AXES = ['x', 'y', 'z'];
// The source tag the display mirror stamps on its own `sync-bpm` writes, so the
// control→setTempo bridge can tell its own echo apart from a real user/MIDI edit and not loop.
// (`sync-bpm` is bidirectional, so ParameterManager notifies even the writing controller — the
// source tag, not controller-identity skip, is what breaks the loop.)
const SYNC_BPM_DISPLAY_SOURCE = { id: 'sync-bpm-display-mirror' };
const DEFAULT_DIMENSION_ID = 'EW::I';
const DEFAULT_DIMENSION_ORDER = ['EW::I', 'EW::II', 'EW::III'];
const PREMIX_PARAM = 'premix-deck-i';
const PARAM_DEBUG_FLAG = '__DEBUG_PARAM_ROUTE';
// The buffered-reload watchdog: generous (the attempt includes a full track
// download on a possibly slow mobile network), but finite — a hung await in
// the chain must surface as a reported failure, never as silence.
const BUFFERED_RELOAD_WATCHDOG_MS = 5 * 60 * 1000;
const RELOAD_WATCHDOG_TIMEOUT = Symbol('buffered-reload-timeout');
// Per-stage input headroom. The orbiter runs 3 dimension stages (EW::I/II/III)
// in SERIES. The original -6 dB per stage (at the deck channel, end-of-stage) both
// over-attenuated (3 × -6 = -18 dB) and gave the processors no input headroom. Instead,
// apply a small cut at the INPUT of each stage: every processor then has headroom and
// can't clip internally, and the cuts distribute the deck headroom across the chain
// rather than lumping it at the output. -1 dB per stage plus a small -0.5 dB final output
// trim ≈ 3 dB total, landing a -6 dBFS reference at ~-9 dBFS (no gain) / ~-3 dBFS (max
// premix +6 dB) — verified with offline analysis (pink-noise in/out RMS + LUFS).
const STAGE_HEADROOM_DB = -1;
// Final global output trim, applied once at masterGain (after the per-stage input headroom).
const OUTPUT_HEADROOM_DB = -0.5;
const dbToLinear = (db) => (Tone.dbToGain ? Tone.dbToGain(db) : Math.pow(10, db / 20));

function shouldDebugParamRoute() {
  try {
    if (typeof window === 'undefined') return false;
    if (!(PARAM_DEBUG_FLAG in window)) {
      Object.defineProperty(window, PARAM_DEBUG_FLAG, {
        value: false,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    return Boolean(window[PARAM_DEBUG_FLAG]);
  } catch (_) {
    return false;
  }
}

function debugParamRoute(message, payload = {}) {
  if (!shouldDebugParamRoute()) return;
  try {
    console.debug(`[AudioParamRoute] ${message}`, payload);
  } catch (_) {}
}

function shouldDebugEngineStacks() {
  try {
    if (typeof window === 'undefined') return false;
    return Boolean(window.__DEBUG_ENGINE_STACKS);
  } catch (_) {
    return false;
  }
}

function debugEngineStacks(message, payload = {}) {
  if (!shouldDebugEngineStacks()) return;
  try {
    console.debug(`[AudioEngineStacks] ${message}`, payload);
  } catch (_) {}
}

function cloneModuleConfig(config = {}, fallbackDimensionId = null) {
  const range = config?.range || {};
  return {
    effectId: config?.effectId ?? null,
    moduleId: config?.moduleId ?? null,
    inputParamId: config?.inputParamId ?? null,
    range: {
      min: Number.isFinite(range.min) ? Number(range.min) : null,
      max: Number.isFinite(range.max) ? Number(range.max) : null,
      equilibrium: Number.isFinite(range.equilibrium ?? range.init)
        ? Number(range.equilibrium ?? range.init)
        : null,
    },
    settings: config?.settings ? { ...config.settings } : undefined,
    mappings: sanitizeMappings(config?.mappings),
    dimensionId: config?.dimensionId ?? fallbackDimensionId ?? null,
    dimensionLabel: config?.dimensionLabel ?? null,
    controlNormalized: Number.isFinite(config?.controlNormalized)
      ? Math.min(1, Math.max(0, Number(config.controlNormalized)))
      : null,
  };
}

function cloneRackConfig(config = {}, fallbackDimensionId = null) {
  // Do NOT enforce MAX_MODULES here; cloning should preserve all modules.
  // Limiting to MAX_MODULES must happen AFTER per-dimension filtering.
  const modules = Array.isArray(config.modules)
    ? config.modules.map((module) => cloneModuleConfig(module, fallbackDimensionId))
    : [];

  return {
    dimensionId: config?.dimensionId ?? fallbackDimensionId ?? null,
    dimensionLabel: config?.dimensionLabel ?? null,
    modules,
  };
}

function shouldPrimeDimensionConfig(config) {
  return Boolean(config && (config.x || config.y || config.z));
}

export class AudioEngineAdapter {
  constructor({ trackData, engineConfig, userManager, performanceProfile, transport, outputNode, deck, eventBus, loadProgress } = {}) {
    this.trackData = trackData;
    // This voice's load-progress reporter; audio download counters report through it
    // (per-tile in the multi realm) instead of the one global overlay. Null → the playback layer
    // falls back to the legacy window.updateLoadingProgress hook (single-orbiter unchanged).
    this._loadProgress = loadProgress ?? null;
    this.playbackTrackData = trackData?.track ?? trackData ?? null;
    this.engineConfig = engineConfig || {};
    this.userManager = userManager;
    // Multi-orbiter seams (decision 0001). Both default to today's behavior, so a
    // single-orbiter instance is unchanged. A multi-orbiter owner can inject a SHARED transport
    // (so N voices run off one shared-package Transport instead of each owning its own) and a shared
    // output node (so N voices mix into one master bus instead of each hitting Tone.Destination).
    this._injectedTransport = transport ?? null;
    this._outputNode = outputNode ?? null;
    // The per-voice event bus the count-in snapshot mirrors onto (the React Transport
    // surface subscribes to the SAME bus). Defaults to `window` so single-orbiter is byte-identical; a
    // multi tile injects its own EventTarget so one voice's count-in doesn't drive another's UI.
    this._eventBus = eventBus ?? (typeof window !== 'undefined' ? window : null);
    // This voice's DECK — the one owner of its sync/warp flags, tempo, meter, grid, and beat clock.
    // Injected by the session (registered on the voice record); a deck-less path (some tests)
    // gets a private solo-semantics deck so grid/meter reads keep working.
    this.deck = deck ?? new Deck({ voiceId: null, collection: false });
    this.performanceProfile = this.#resolvePerformanceProfile(performanceProfile);
    this.performanceProfileKey = this.performanceProfile?.key ?? 'MID';
    this.safeRampSeconds = this.#computeSafeRampSeconds();
    this._speedControlDisabled = false;
    this._speedControlDisableReason = null;
    // Engine-requiring modules present but not runnable on the current
    // (streaming) backend: their parameters are locked until an explicit
    // buffered unlock. All ParameterManager dimension locks go through the
    // one coordinator (see parameterLockCoordinator.js) — its manager getter
    // is lazy because userManager can be attached after construction.
    // Initialized BEFORE the first #resolveDecodeStrategy below, which runs
    // the lock sync.
    this._engineFeaturesBlocked = false;
    this._emittedEngineFeaturesBlocked = false;
    this._parameterLocks = new ParameterLockCoordinator({
      getManager: () => this.userManager,
    });

    this.axisOrder = [...AXES];
    this.transport = this._injectedTransport ?? new TransportController();
    this.playback = this.#createPlayback(this.#resolveDecodeStrategy(this.performanceProfile));
    this.mediaSession = new MediaSessionController(this);

    this.normalizationGain = null;
    this.masterGain = null;
    this.limiter = null;
    this.masterMeter = null;
    this.bodyLevelGain = null;

    // This voice's source-level engine host (granular today; a companion family attaches at the
    // same seam). The host owns graph construction — context, mix-bus connect, dry leg — plus
    // refcounted lifetime and observation; control modules acquire, visual layers peek/observe.
    // Wired as live reads because the mix bus and buffer exist only after initialize().
    this._sourceEngines = createSourceEngineHost({
      getContext: () => Tone.getContext?.()?.rawContext ?? Tone.context?.rawContext ?? null,
      getMixBus: () => this.getSourceMixBus(),
      connect: (outputNode, mixBus) => Tone.connect(outputNode, mixBus),
      getBuffer: () => this.getDecodedAudioBuffer(),
      getPositionMs: () => this.getCurrentPositionMs(),
      isPlaying: () => this.isPlaying(),
      setDryLevel: (level) => this.setSourceDryLevel(level),
      getWorkletSurface: () => this.playback?.getGranularWorkletSurface?.() ?? null,
    });

    this.effectRacks = { x: null, y: null, z: null };

    // Rack-effect slot observers (the visual seam): every rack this adapter
    // builds relays its slot lifecycle here — see observeEffectSlots().
    this._effectSlotObservers = new Set();

    this._dimensionChains = new Map();
    this._dimensionOrder = [...DEFAULT_DIMENSION_ORDER];
    this._dimensionIds = new Set([DEFAULT_DIMENSION_ID]);
    this._effectsMeta = { activeDimensionId: null };
    this.effectsConfigByDimension = new Map();
    this._lastDiscreteValues = {};
    this._subscribedParams = new Set();
    this._subscriptionsRegistered = false;
    this._deferredLoopRange = null;
    this.__desiredLoopMode = true;
    this._cosmicManager = null;
    this._cosmicLfoCache = { x: null, y: null, z: null };
    this._defaultLoopApplied = false;
    this._playbackStopSubscription = null;
    this._playbackBufferingSubscription = null;
    this._bufferingState = {
      isBuffering: false,
      bufferedAheadMs: 0,
      readyState: 0,
      source: null,
      timestamp: 0,
    };
    this._playbackState = 'stopped';
    this._playbackStateListeners = new Set();
    this._pendingDecodeStrategy = null;
    // NOT reset here: the first #resolveDecodeStrategy already ran above (playback
    // construction) and stored the resolution — nulling it would disarm the
    // unlock feasibility guard until the next resolve.
    this._playbackStrategyResolution = this._playbackStrategyResolution ?? null;
    // "Unlock speed": sticky user override of the adaptive streaming decision + its in-flight guard.
    this._forcePrebuffer = false;
    this._bufferedReloadPromise = null;
    this._bufferedReloadToken = null;
    this._pendingQuantizedStart = null;
    // A seek armed to fire on the next bar so it lands in phase (joined + playing only).
    this._pendingQuantizedSeek = null;
    // The quantized-start count-in snapshot (the wait between Play and the launch bar). Read
    // by the React Transport via the `transport` surface; mirrored on the `orbiters:quantize-countin`
    // window event. Inactive until a delayed start is scheduled.
    this._countInState = { active: false };
    // Seed the deck from this voice's loaded trackData (two-phase: the deck was constructed at voice
    // registration, before audio existed) — its native tempo, meter, and grid marker; a collection
    // deck still riding its native also seeds its transport tempo (ratio 1 — nothing audibly changes
    // at load, and the header number is honest from first paint, whatever the registry size was when
    // this tile constructed).
    this.deck.seedFromTrackData(this.trackData);
    // The deck's own playback position feeds its beat clock (`deck.clock()`) when it isn't on the
    // shared clock — the metronome and any per-player beat consumer read the deck, not the engine.
    this.deck.setPositionSource(() => ({
      playing: this.isPlaying?.() === true,
      positionMs: this.getCurrentPositionMs?.(),
    }));
    // The "BPM" number IS `deck.tempo` — the deck's continuous transport tempo (master-driven while
    // synced, its own while unsynced, held across sync toggles). ONE display source; the deck's
    // change stream below keeps the readout current. Editing the number BY ANY METHOD (type/wheel/
    // keypad/MIDI) converges on `setRawValue('sync-bpm', …)`, so ONE subscriber catches them all and
    // routes through `deck.setTempo` — synced proposes the master (the coordinator's single gate
    // stays the authority), unsynced sets the deck's own transport tempo (session-only; the track's
    // persisted tempo is its NATIVE tempo, edited via the kit panel). It skips the display mirror's
    // own echo (tagged SYNC_BPM_DISPLAY_SOURCE) and the subscribe replay, so it never loops.
    this._syncBpmBridgeSub = null;
    if (typeof this.userManager?.subscribe === 'function') {
      const controller = {
        onParameterChanged: (_name, value, _dim, metadata) => {
          // ParameterManager replays the current/default value to a new subscriber immediately
          // (reason:'subscribe'); driving setTempo from that would clobber a live master tempo with the
          // sync-bpm default when a voice inits while a session is already running. Ignore the replay.
          if (metadata?.reason === 'subscribe') return;
          if (metadata?.sourceController === SYNC_BPM_DISPLAY_SOURCE) return; // our own display echo
          const bpm = Number(value);
          if (Number.isFinite(bpm) && bpm > 0) this.deck.setTempo(bpm);
        },
      };
      this.userManager.subscribe(controller, 'sync-bpm');
      this._syncBpmBridgeSub = () => {
        try { this.userManager.unsubscribe(controller, 'sync-bpm'); } catch (_) {}
      };
    }
    this._deckSubscription = this.deck.onChange((snapshot, reason) => {
      if (reason === 'bpm' || reason === 'sync-status') {
        this._syncWrapPlaybackRate({ immediate: false });
        this._refreshSyncBpmReadout();
      }
      // Cancel any pending quantized start if sync was just disabled — the
      // quantization target (shared session beat) no longer exists.
      if (reason === 'sync-status' && syncCoordinator?.isEnabled !== true) {
        this._cancelPendingQuantizedStart();
      }
      // Position alignment only when NOT actively playing.
      // During playback, rate control alone keeps the track aligned.
      // Seeking a streaming HTMLMediaElement mid-playback invalidates buffered
      // data and causes progressive freezes when events arrive faster than the
      // browser can re-buffer.
      if (
        syncCoordinator?.isEnabled === true &&
        !this.playback?.isPlaying?.() &&
        (reason === 'grid-marker' || reason === 'grid-start' || reason === 'bpm' || reason === 'sync-status')
      ) {
        this._alignWrapPlaybackPosition({ force: false }).catch(() => {});
      }
    });
    // Boot: the readout starts on the deck's tempo (a collection tile's own native; solo the master —
    // the same value the old master mirror wrote on the coordinator's init emission).
    this._refreshSyncBpmReadout();
    this._handlePlaybackStopped = this._handlePlaybackStopped.bind(this);
    this._handlePlaybackBuffering = this._handlePlaybackBuffering.bind(this);
    this._initialized = false;

    this.refreshCosmicLfoCache();
    this._primeDimensionIdsFromStacks(this.engineConfig?.stacks);
  }

  // The resolver owns the WHOLE decision (final sink, engine-requirement
  // block, speed lock — incl. the URL flags and the sticky unlock override);
  // this method only feeds it the adapter's state and APPLIES the verdict.
  #resolveDecodeStrategy(profile = this.performanceProfile, effectsConfig = this.engineConfig?.effects) {
    const resolution = resolvePlaybackStrategy({
      profile,
      effectsConfig,
      trackData: this.playbackTrackData,
      forceBuffered: this._forcePrebuffer === true,
    });
    this._playbackStrategyResolution = resolution || null;
    const strategy = resolution?.sink ?? 'stream';

    // Engine-requiring modules that can't run on the decided sink: their
    // parameters lock and the UI offers the buffered unlock where it is sane.
    this._engineFeaturesBlocked = resolution?.requirementBlocked === true;
    this.#setSpeedControlDisabled(resolution?.shouldLockSpeed === true, {
      reason: resolution?.speedLockReason ?? null,
      strategy,
      prebufferThresholdSec: resolution?.prebufferThresholdSec ?? resolution?.longFormThresholdSec ?? null,
      source: 'strategy-resolution',
    });
    // Runs on EVERY resolve (not only on lock-state flips): the effects config
    // may have changed which parameters need locking while the lock states
    // themselves stayed put.
    this.#syncParameterLocks();
    if (this._engineFeaturesBlocked !== this._emittedEngineFeaturesBlocked) {
      this._emittedEngineFeaturesBlocked = this._engineFeaturesBlocked;
      this.#emitControlLockEvent({
        disabled: this._speedControlDisabled,
        reason: this._speedControlDisableReason,
        strategy,
        prebufferThresholdSec: resolution?.prebufferThresholdSec ?? null,
        source: 'strategy-resolution',
      });
    }

    return strategy;
  }

  /** Feasibility + lock state for UI decisions (unlock affordances). */
  getPlaybackStrategyInfo() {
    const resolution = this._playbackStrategyResolution || null;
    return {
      strategy: this.playback?.getDecodeStrategy?.() ?? null,
      bufferedFeasible: Boolean(resolution?.bufferedFeasible),
      requirementBlocked: Boolean(resolution?.requirementBlocked),
      engineFeaturesBlocked: this._engineFeaturesBlocked === true,
      speedControlDisabled: this._speedControlDisabled === true,
      durationSec: resolution?.durationSec ?? null,
      predictedPrebufferSec: resolution?.predictedPrebufferSec ?? null,
      mobile: Boolean(resolution?.mobile),
    };
  }

  #setSpeedControlDisabled(disabled, {
    reason = null,
    strategy = null,
    prebufferThresholdSec = null,
    source = 'runtime',
  } = {}) {
    const next = Boolean(disabled);
    if (this._speedControlDisabled === next && this._speedControlDisableReason === reason) {
      return;
    }
    this._speedControlDisabled = next;
    this._speedControlDisableReason = next ? reason : null;

    // Mobile speed lock: enforcement lives at the playback-engine sink — the ONE gate every rate write
    // (knob, transport warp, effect automation) passes through. Pushing the flag here means no
    // transport-driven tempo change can bypass the lock on mobile.
    this.playback?.setSpeedControlLocked?.(next);

    // Warp's only job is that (now-blocked) stretch — force it off + lock the control on the deck so
    // the UI can grey it out, and so the metronome/grid stay on the deck's native tempo, not a
    // transport tempo the audio isn't playing.
    this.deck?.setSpeedLocked?.(next);

    // Parameter locks are applied by the one shared owner (speed lock and the
    // engine-feature block can target the same dimensions).
    this.#syncParameterLocks();

    this.#emitControlLockEvent({ disabled: next, reason, strategy, prebufferThresholdSec, source });
  }

  #emitControlLockEvent({ disabled, reason = null, strategy = null, prebufferThresholdSec = null, source = 'runtime' }) {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent('orbiters:speed-control-lock', {
      detail: {
        disabled: Boolean(disabled),
        reason: disabled ? reason : null,
        strategy: strategy || this.playback?.getDecodeStrategy?.() || null,
        prebufferThresholdSec,
        // Engine-requiring modules blocked on the current backend (distinct
        // from the mobile speed lock — either can be active without the other).
        engineFeaturesBlocked: this._engineFeaturesBlocked === true,
        source,
        timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      },
    }));
  }

  /**
   * Feed both lock causes to the coordinator (the one owner of ParameterManager
   * dimension locks — see parameterLockCoordinator.js). Runs on every strategy
   * resolve and effects-config install: the causes may be unchanged while the
   * TARGETS moved with the config.
   */
  #syncParameterLocks() {
    this._parameterLocks.setCauses({
      'speed-lock': this._speedControlDisabled ? this.#getSpeedControlTargets() : [],
      'engine-block': this._engineFeaturesBlocked ? this.#getEngineFeatureTargets() : [],
    });
  }

  /**
   * The ONE walk over the effects configuration: per axis+dimension, the
   * modules matching `match` — from the resolved per-dimension map when
   * populated, else the raw config (early init), where the dimension id comes
   * from the first matched module. Every target enumeration (speed effects,
   * engine-requiring modules, tempo-managed modules) is a predicate + mapping
   * over this.
   * @param {(moduleConfig: object) => boolean} match
   * @returns {{ axis: string, dimensionId: string, modules: object[] }[]}
   */
  #collectAxisModuleTargets(match) {
    const targets = [];
    if (this.effectsConfigByDimension && this.effectsConfigByDimension.size > 0) {
      this.effectsConfigByDimension.forEach((dimConfig, dimensionId) => {
        for (const axis of AXES) {
          const modules = Array.isArray(dimConfig?.[axis]?.modules) ? dimConfig[axis].modules : [];
          const matched = modules.filter(match);
          if (matched.length) {
            targets.push({ axis, dimensionId, modules: matched });
          }
        }
      });
      return targets;
    }

    const effectsConfig = this.engineConfig?.effects || {};
    for (const axis of AXES) {
      const axisConfig = effectsConfig[axis];
      const modules = Array.isArray(axisConfig?.modules) ? axisConfig.modules : [];
      const matched = modules.filter(match);
      if (matched.length) {
        targets.push({
          axis,
          dimensionId: matched[0].dimensionId || axisConfig?.dimensionId || DEFAULT_DIMENSION_ID,
          modules: matched,
        });
      }
    }
    return targets;
  }

  /**
   * {axis, dimensionId, effectIds} for every axis+dimension carrying a
   * speed-related effect (what the mobile speed lock freezes).
   */
  #getSpeedControlTargets() {
    const SPEED_EFFECT_IDS = new Set(['tone.tempoPitch', 'tone.timeReverse']);
    return this.#collectAxisModuleTargets((moduleConfig) => SPEED_EFFECT_IDS.has(moduleConfig?.effectId))
      .map(({ axis, dimensionId, modules }) => ({
        axis,
        dimensionId,
        effectIds: Array.from(new Set(modules.map((moduleConfig) => moduleConfig.effectId))),
      }));
  }

  getSpeedControlTargets() {
    return this.#getSpeedControlTargets();
  }

  /**
   * {axis, dimensionId} for every axis+dimension carrying a module that needs
   * a buffered engine (granular, stretch/pure-pitch) — what the engine-feature
   * block locks while the voice streams.
   */
  #getEngineFeatureTargets() {
    const needsEngine = (moduleConfig) => {
      const effectId = moduleConfig?.effectId ?? null;
      if (!effectId) return false;
      return resolveModuleEngineRequirement(effectId, moduleConfig?.moduleId ?? null)
        !== ENGINE_REQUIREMENT.STREAM_SAFE;
    };
    return this.#collectAxisModuleTargets(needsEngine)
      .map(({ axis, dimensionId }) => ({ axis, dimensionId }));
  }

  hasSpeedControlTarget(axis, dimensionId = null) {
    if (!axis || !AXES.includes(axis)) return false;
    const targets = this.#getSpeedControlTargets();
    return targets.some((target) => {
      if (target.axis !== axis) return false;
      if (!dimensionId) return true;
      return target.dimensionId === dimensionId;
    });
  }

  hasTempoManagedSpeedTarget(axis, dimensionId = null) {
    if (!axis || !AXES.includes(axis)) return false;
    const targets = this.getTempoManagedTargets();
    return targets.some((target) => {
      if (target.axis !== axis) return false;
      if (dimensionId && target.dimensionId !== dimensionId) return false;
      return true;
    });
  }

  getTempoManagedTargets() {
    const targets = [];
    // Historical semantics: the FIRST tempoPitch module on the axis decides —
    // if it isn't a tempo* module, the axis doesn't count even if a later
    // module were one.
    for (const { axis, dimensionId, modules } of this.#collectAxisModuleTargets(
      (moduleConfig) => moduleConfig?.effectId === 'tone.tempoPitch',
    )) {
      const tempoModule = modules[0];
      const moduleId = typeof tempoModule.moduleId === 'string' ? tempoModule.moduleId : '';
      if (!moduleId.startsWith('tempo')) continue;
      targets.push({
        axis,
        dimensionId,
        moduleId: moduleId || null,
        range: tempoModule.range ? { ...tempoModule.range } : null,
      });
    }
    return targets;
  }

  #createPlayback(strategy = 'stream') {
    const useStretchEngine = strategy === 'stretch';
    if (useStretchEngine && !this._loggedStretchEngine) {
      this._loggedStretchEngine = true;
      console.info('[AudioEngineAdapter] Time-stretch engine enabled for this voice (speed changes keep pitch).');
    }
    const PlaybackCtor = useStretchEngine
      ? StretchPlayerPlayback
      : (strategy === 'prebuffer' ? PlayerPlayback : StreamingPlayer);
    const playback = new PlaybackCtor({
      trackData: this.playbackTrackData,
      userManager: this.userManager,
      effectOrder: this.axisOrder,
      performanceProfile: this.performanceProfile,
      onLoadProgress: this._loadProgress ? (message) => this._loadProgress.setMessage(message) : null,
    });
    // A freshly created / swapped engine inherits the current speed lock, so a
    // prebuffer→stream swap on mobile can never briefly reopen the rate path.
    playback.setSpeedControlLocked?.(this._speedControlDisabled);
    return playback;
  }

  async #swapPlayback(strategy) {
    const currentStrategy = typeof this.playback?.getDecodeStrategy === 'function'
      ? this.playback.getDecodeStrategy()
      : null;
    if (currentStrategy === strategy) {
      return;
    }

    // Unsubscribe from old playback listeners first
    if (this._playbackStopSubscription) {
      try {
        this._playbackStopSubscription();
      } catch (_) {}
      this._playbackStopSubscription = null;
    }
    if (this._playbackBufferingSubscription) {
      try {
        this._playbackBufferingSubscription();
      } catch (_) {}
      this._playbackBufferingSubscription = null;
    }

    // CRITICAL: Ensure old playback is fully stopped and disposed before creating new one
    // This prevents duplicate audio playback when swapping between streaming and prebuffer modes
    const oldPlayback = this.playback;
    // Capture loop intent so the new backend keeps looping after the swap.
    const preservedLoopRange = typeof oldPlayback?.getLoopRange === 'function'
      ? oldPlayback.getLoopRange()
      : null;
    const preservedLoopActive = typeof oldPlayback?.isLooping === 'function'
      ? Boolean(oldPlayback.isLooping())
      : false;
    if (oldPlayback) {
      // First, ensure playback is stopped (with proper await to let audio fade out)
      if (typeof oldPlayback.triggerStop === 'function') {
        try {
          await oldPlayback.triggerStop();
        } catch (error) {
          console.warn('[AudioEngineAdapter] Failed to stop old playback during swap:', error);
        }
      }

      // Then dispose all resources
      if (typeof oldPlayback.dispose === 'function') {
        try {
          oldPlayback.dispose();
        } catch (error) {
          console.warn('[AudioEngineAdapter] Failed to dispose old playback during swap:', error);
        }
      }

      // Small delay to ensure audio context has time to release resources
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Create and configure new playback engine
    this.playback = this.#createPlayback(strategy);
    this.playback.setPerformanceProfile(this.performanceProfile);

    if (this._initialized) {
      await this.playback.init({
        Tone,
        effectRacks: this.effectRacks,
        effectOrder: this.axisOrder,
      });
      this._rewireGlobalChain();
      this._playbackStopSubscription = this.playback.addStopListener(this._handlePlaybackStopped);
      if (typeof this.playback.addBufferingListener === 'function') {
        this._playbackBufferingSubscription = this.playback.addBufferingListener(this._handlePlaybackBuffering);
      }
    }

    // The rendering backend changed: rebind hosted source engines (granular)
    // to the new sink's surface. An engine keeps its construction-time mode
    // otherwise — one built beside the streamed voice renders natively, which
    // is inaudible next to the stretch worklet, so granular would stay dead
    // after the full-track unlock for every module, including ones added later.
    this._sourceEngines.rebind();

    if (
      preservedLoopRange &&
      Number.isFinite(preservedLoopRange.start) &&
      Number.isFinite(preservedLoopRange.end) &&
      preservedLoopRange.end > preservedLoopRange.start
    ) {
      this.setLoopRange(preservedLoopRange.start, preservedLoopRange.end, {
        active: preservedLoopActive,
      });
    }
  }

  #resolvePerformanceProfile(profile) {
    const fallback = AUDIO_PERFORMANCE_PRESETS.MID;
    if (!profile || typeof profile !== 'object') {
      return {
        ...fallback,
        adaptiveAudioMode: false,
        effectQuality: { ...fallback.effectQuality },
      };
    }
    const key =
      typeof profile.key === 'string' && AUDIO_PERFORMANCE_PRESETS[profile.key.toUpperCase()]
        ? profile.key.toUpperCase()
        : null;
    const base = key ? AUDIO_PERFORMANCE_PRESETS[key] : fallback;
    const adaptiveMode = typeof profile.adaptiveAudioMode === 'boolean'
      ? profile.adaptiveAudioMode
      : false;
    const resolved = {
      ...base,
      ...profile,
      adaptiveAudioMode: adaptiveMode,
      key: key || profile.key || base.key,
      effectQuality: {
        ...base.effectQuality,
        ...(typeof profile.effectQuality === 'object' ? profile.effectQuality : {}),
      },
    };

    // Mobile devices always use compressed assets to reduce memory pressure.
    try {
      if (isMobileDevice()) {
        resolved.assetFormat = 'mp3';
      }
    } catch {}

    return resolved;
  }

  #computeSafeRampSeconds(profile = this.performanceProfile) {
    const fallbackMs = AUDIO_PERFORMANCE_PRESETS.MID.safeRampTimeMs || 45;
    const ms = Number(profile?.safeRampTimeMs);
    const resolvedMs = Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
    return Math.max(0.001, resolvedMs / 1000);
  }

  #applyContextLatencyHint() {
    const hint = this.performanceProfile?.audioContextLatencyHint;
    if (!hint) return;

    const hasSetter = (target, property) => {
      if (!target) return false;
      const own = Object.getOwnPropertyDescriptor(target, property);
      if (own && typeof own.set === 'function') return true;
      const proto = Object.getPrototypeOf(target);
      if (!proto) return false;
      const inherited = Object.getOwnPropertyDescriptor(proto, property);
      return Boolean(inherited && typeof inherited.set === 'function');
    };

    const tryApply = (target) => {
      if (!target) return false;
      if (typeof target.setLatencyHint === 'function') {
        try {
          target.setLatencyHint(hint);
          return true;
        } catch (_) {
          return false;
        }
      }
      if (!hasSetter(target, 'latencyHint')) {
        return false;
      }
      try {
        target.latencyHint = hint;
        return true;
      } catch (_) {
        return false;
      }
    };

    const context = typeof Tone.getContext === 'function' ? Tone.getContext() : Tone.context;
    const raw = context?.rawContext ?? Tone.context?.rawContext ?? null;

    tryApply(context) || tryApply(raw);
  }

  setPerformanceProfile(profile) {
    const resolved = this.#resolvePerformanceProfile(profile);
    this.performanceProfile = resolved;
    this.performanceProfileKey = resolved?.key ?? this.performanceProfileKey ?? 'MID';
    this.safeRampSeconds = this.#computeSafeRampSeconds(resolved);
    const desiredStrategy = this.#resolveDecodeStrategy(resolved);
    const currentStrategy = typeof this.playback?.getDecodeStrategy === 'function'
      ? this.playback.getDecodeStrategy()
      : null;
    if (currentStrategy && currentStrategy !== desiredStrategy) {
      if (this.playback?.isPlaying?.() || this.transport?.isRunning) {
        this._pendingDecodeStrategy = desiredStrategy;
      } else {
        this._pendingDecodeStrategy = null;
        void this.#swapPlayback(desiredStrategy);
      }
    }
    this.playback?.setPerformanceProfile(resolved);
    this.#applyContextLatencyHint();
    Object.values(this.effectRacks).forEach((rack) => {
      rack?.setPerformanceProfile?.(resolved);
    });
  }

  async initialize() {
    this.masterMeter?.dispose?.();
    this.masterMeter = null;

    this.playback.setPerformanceProfile(this.performanceProfile);
    this.#applyContextLatencyHint();

    // Create audio chain: normalizationGain → [effects] → bodyLevelGain → masterGain → limiter → output
    // Note: normalizationGain connects dynamically in _rewireGlobalChain
    this.normalizationGain = new Tone.Gain(1);
    this.bodyLevelGain = new Tone.Gain(1);
    // Final global output trim (deck headroom is mostly at each stage input; this is the last touch).
    this.masterGain = new Tone.Gain(dbToLinear(OUTPUT_HEADROOM_DB));

    enforceStereo(this.normalizationGain);
    enforceStereo(this.bodyLevelGain);
    enforceStereo(this.masterGain);

    // Connect master chain (normalizationGain connects dynamically)
    this.bodyLevelGain.connect(this.masterGain);

    this.masterMeter = new Tone.Meter({ smoothing: 0.8 });
    enforceStereo(this.masterMeter);

    // Terminal output (decision 0001): single-orbiter → own limiter → speakers; multi-orbiter
    // (an injected shared master bus) → mix in WITHOUT a per-voice limiter (the shared host limits).
    this._connectTerminalOutput();

    // Apply normalization gain from track metadata
    this._applyNormalizationGain();

    const effectsConfig = this.engineConfig?.effects || {};
    const meta = effectsConfig?.__meta || {};
    if (Array.isArray(meta.dimensionOrder)) {
      this._setDimensionOrder(meta.dimensionOrder);
    }
    if (typeof meta.activeDimensionId === 'string' && meta.activeDimensionId.length) {
      this._effectsMeta.activeDimensionId = meta.activeDimensionId;
    }
    const clonedConfig = this._cloneEffectsConfig(effectsConfig);
    const initialDimensionId =
      effectsConfig?.__meta?.activeDimensionId
      ?? clonedConfig.x?.dimensionId
      ?? clonedConfig.y?.dimensionId
      ?? clonedConfig.z?.dimensionId
      ?? DEFAULT_DIMENSION_ID;

    if (shouldPrimeDimensionConfig(clonedConfig)) {
      this._primeDimensionIdsFromConfig(clonedConfig);
    }

    await this.transport.init({ Tone });

    await this.playback.init({ Tone, effectOrder: this.axisOrder });
    if (this._playbackStopSubscription) {
      this._playbackStopSubscription();
    }
    this._playbackStopSubscription = this.playback.addStopListener(this._handlePlaybackStopped);
    if (this._playbackBufferingSubscription) {
      this._playbackBufferingSubscription();
    }
    this._playbackBufferingSubscription =
      typeof this.playback.addBufferingListener === 'function'
        ? this.playback.addBufferingListener(this._handlePlaybackBuffering)
        : null;

    const knownDimensionIds = new Set([
      initialDimensionId,
      ...Array.from(this._dimensionIds || []),
      ...Array.from(this._collectDimensionIdsFromEffectsConfig(clonedConfig)),
    ]);

    const initialDimensionConfig = this._ensureEffectsConfigDimension(clonedConfig, initialDimensionId);
    this.effectsConfigByDimension.set(initialDimensionId, initialDimensionConfig);

    knownDimensionIds.forEach((dimensionId) => {
      if (!dimensionId) return;
      if (dimensionId === initialDimensionId) {
        return;
      }
      const scopedConfig = this._ensureEffectsConfigDimension(clonedConfig, dimensionId);
      this.effectsConfigByDimension.set(dimensionId, scopedConfig);
    });

    this._dimensionOrder.forEach((dimensionId) => {
      if (!dimensionId) return;
      const config = this.effectsConfigByDimension.get(dimensionId);
      this._ensureDimensionChain(dimensionId, config);
    });
    this._rewireGlobalChain();
    this.setActiveDimension(initialDimensionId);
    this._registerParameterSubscriptions();
    this._updatePlaybackState('stopped', { force: true, source: 'initialize' });
    this.mediaSession?.init?.();
    this._initialized = true;
  }

  /**
   * Wire the voice's terminal output (decision 0001).
   * - Single-orbiter (no injected `_outputNode`): this adapter owns the path to the speakers, so it
   *   builds its own limiter (-1 dB ceiling) → meter + `Tone.Destination`. Byte-identical to before.
   * - Multi-orbiter (an `outputNode` = the shared master bus was injected): the voice mixes straight
   *   into the shared bus and builds NO limiter — the `MultiOrbiterAudioHost` owns the single limiter
   *   on the summed mix (avoid N limiters). The meter taps `masterGain` (pre-sum) for per-voice level.
   * `this.limiter` stays null in that case; every consumer of it is null-guarded (`?.`).
   */
  _connectTerminalOutput() {
    if (this._outputNode) {
      this.limiter = null;
      this.masterGain.connect(this.masterMeter);
      this.masterGain.connect(this._outputNode);
      return;
    }
    this.limiter = new Tone.Limiter(-1); // Ceiling at -1 dB to prevent clipping
    enforceStereo(this.limiter);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.masterMeter);
    this.limiter.connect(Tone.Destination);
  }

  async preload() {
    await this.playback.load();
  }

  async play({ quantize = 'auto' } = {}) {
    await ensureSilentAudioUnlock();

    // A play during an in-flight "Unlock speed" reload JOINS it (the reload owns the backend and
    // the one download — a parallel load() here would start a second fetch/decode of the same asset).
    if (this._bufferedReloadPromise) {
      try { await this._bufferedReloadPromise; } catch (_) {}
    }

    // A fresh play supersedes any pending quantized start.
    this._cancelPendingQuantizedStart();

    const canApplyPendingStrategy = !this.playback?.isPlaying?.() && !this.transport?.isRunning;
    if (this._pendingDecodeStrategy && canApplyPendingStrategy) {
      try {
        await this.#swapPlayback(this._pendingDecodeStrategy);
        const currentStrategy = this.playback?.getDecodeStrategy?.();
        if (currentStrategy === this._pendingDecodeStrategy) {
          this._pendingDecodeStrategy = null;
        }
      } catch (error) {
        console.error('[AudioEngineAdapter] Failed to apply pending decode strategy:', error);
        // Keep pending so we can retry later
      }
    }
    if (!this.playback.isLoaded) {
      await this.playback.load();
    }
    this._ensureDefaultLoopRange();
    if (this.playback.isPlaying()) {
      return;
    }

    // Flag is absolute: 'bar' and 'auto' both require _shouldQuantizeStart().
    // 'off' disables even when the flag is on. To force quantization for
    // testing, call setQuantizeStartForced(true) (src/sync/debugSync.js) explicitly.
    const shouldQuantize = quantize !== 'off' && this._shouldQuantizeStart();
    if (!shouldQuantize) {
      await this._alignWrapPlaybackPosition({ force: true });
      // Unsynced launch snap: an UNSYNCED deck with warp on comes in on its OWN bar — the align
      // above no-ops without a live sync session, and this snaps the paused position to the
      // nearest launch-grid boundary of the deck's own grid instead. Mutually exclusive gates.
      if (quantize !== 'off') await this._snapStartPositionToOwnGrid();
      await this._startTransportAndPlayback();
      this._updatePlaybackState('playing', { source: 'play' });
      return;
    }

    const delayMs = this._computeBarDelayMs();
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      await this._alignWrapPlaybackPosition({ force: true });
      await this._startTransportAndPlayback();
      this._updatePlaybackState('playing', { source: 'play' });
      return;
    }

    if (isDebugSyncLoggingEnabled()) {
      try {
        console.debug('[quantize] scheduling bar-quantized start', {
          delayMs,
          bpm: syncCoordinator?.bpm,
          nowBeat: syncCoordinator?.getCurrentBeat?.(),
        });
      } catch (_) {}
    }

    const pending = { timer: null, canceled: false };
    this._pendingQuantizedStart = pending;

    // Surface the count-in so the UI shows the wait is ARMED (not broken). Emitted with the
    // target fire time + tempo/grid so the Transport can render a beat countdown; cleared on
    // fire (_firePendingQuantizedStart) and on cancel (_cancelPendingQuantizedStart).
    this._emitCountIn(delayMs);

    pending.timer = setTimeout(() => {
      pending.timer = null;
      this._firePendingQuantizedStart(pending);
    }, delayMs);
  }

  /**
   * Publish the quantized-start count-in (the launch-grid wait). The target fire time +
   * tempo let the UI render a beat countdown that matches the scheduled start. Tempo comes from the
   * SAME shared-clock/SyncCoordinator source the bar-delay used (read synchronously right after, so
   * it can't drift). No-op without a valid tempo or a `performance` clock the UI can share.
   * @param {number} delayMs the scheduled delay before the start fires.
   */
  _emitCountIn(delayMs, { seekTargetSec } = {}) {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    // The UI computes `targetTime - performance.now()`, so the cue needs that same monotonic clock.
    if (typeof performance === 'undefined') return;
    // Tempo for the countdown: the shared clock (synced), else this deck's OWN running clock (an
    // unsynced own-grid wait counts at the tempo actually playing — varispeed included), else the
    // coordinator master (the legacy forced-quantize path).
    const shared = this._sharedClockBeat();
    const own = shared ? null : (this.deck.clock?.() ?? null);
    const bpm = Number(shared ? shared.tempoBpm : (own ? 60 / own.secondsPerBeat : syncCoordinator?.bpm));
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    const state = { active: true, targetTime: performance.now() + delayMs, bpm };
    // Piece 6: a quantized SEEK carries its target position so the waveform can blink a marker there.
    if (Number.isFinite(seekTargetSec)) state.seekTargetSec = seekTargetSec;
    this._setCountInState(state);
  }

  /** Clear the count-in (the launch bar fired, or the pending start was canceled). */
  _clearCountIn() {
    if (!this._countInState?.active) return;
    this._setCountInState({ active: false });
  }

  /** Single writer of the count-in snapshot + its `orbiters:quantize-countin` mirror event.
   *  Dispatched on this voice's eventBus (window for single-orbiter → byte-identical). */
  _setCountInState(state) {
    this._countInState = state;
    if (this._eventBus && typeof this._eventBus.dispatchEvent === 'function') {
      this._eventBus.dispatchEvent(new CustomEvent('orbiters:quantize-countin', { detail: state }));
    }
  }

  /** The current count-in snapshot (read by the React Transport surface). */
  getCountInState() {
    return this._countInState;
  }

  async _firePendingQuantizedStart(pending) {
    if (!pending || pending.canceled) return;
    // The launch bar arrived — the count-in is over; playback takes over below.
    this._clearCountIn();
    try {
      await this._alignWrapPlaybackPosition({ force: true });
      if (pending.canceled) return;
      await this._startTransportAndPlayback();
      // Race: cancel may have fired during transport.start / triggerPlay awaits.
      // If so, playback has actually begun — tear it down before returning.
      if (pending.canceled) {
        await this._abortStartedPlayback();
        this._updatePlaybackState('stopped', { source: 'play-quantized-canceled' });
        return;
      }
      this._updatePlaybackState('playing', { source: 'play-quantized' });
    } catch (err) {
      if (isDebugSyncLoggingEnabled()) {
        try {
          console.warn('[quantize] delayed play rejected, retrying immediately', err);
        } catch (_) {}
      }
      if (pending.canceled) return;
      try {
        await this._startTransportAndPlayback();
        if (pending.canceled) {
          await this._abortStartedPlayback();
          this._updatePlaybackState('stopped', { source: 'play-quantized-canceled' });
          return;
        }
        this._updatePlaybackState('playing', { source: 'play-quantized-fallback' });
      } catch (err2) {
        // Transport was stopped inside the helper; force UI to a stable stopped
        // state so we don't leave it stuck in whatever prior state.
        try { console.warn('[quantize] fallback start also failed', err2); } catch (_) {}
        this._updatePlaybackState('stopped', { force: true, source: 'play-quantized-error' });
      }
    } finally {
      if (this._pendingQuantizedStart === pending) {
        this._pendingQuantizedStart = null;
      }
    }
  }

  async _startTransportAndPlayback() {
    // Preserve existing order: transport first, then playback. If playback
    // fails, stop the transport so we don't leave it running without audio.
    await this.transport.start();
    try {
      await this.playback.triggerPlay();
    } catch (error) {
      try { await this.transport.stop(); } catch (_) {}
      throw error;
    }
  }

  async _abortStartedPlayback() {
    // Tear down a just-started transport+playback pair after a cancel race.
    // Stop playback first so it doesn't keep advancing while transport winds
    // down, then stop transport.
    try { await this.playback?.triggerStop?.(); } catch (_) {}
    try { await this.transport?.stop?.(); } catch (_) {}
  }

  /**
   * The read-only shared-clock snapshot, iff a shared session is joined.
   * Returns `{ beatNow, tempoBpm, quantum, … }` from the validated `BeatTimeline` (single-device or
   * network), else null. The audio path NEVER imports BeatTimeline — it only reads this snapshot.
   * @returns {{ joined: true, beatNow: number, phaseNow: number, tempoBpm: number, quantum: number } | null}
   */
  _sharedClockBeat() {
    // Gate on THIS deck's own sync-enabled state first. The shared clock is REALM-WIDE — "joined" as
    // soon as ANY two voices in the collection are synced — so without this check, a voice with its
    // own sync explicitly OFF would still quantize its play/seek against siblings' sessions
    // (bar-delay + count-in), purely because other voices opted in.
    if (this.deck.getStatusDetail()?.enabled !== true) return null;
    // Read the shared-clock snapshot through this deck (its source points at the realm-wide shared
    // clock today; later a per-voice or remote clock, with no adapter change). The joined filter
    // stays here — the deck's source is a pass-through.
    const state = this.deck.getSharedClockState();
    return state && state.joined === true ? state : null;
  }

  /** The loop range an own-grid snap may wrap into: only a loop that is ENGAGED and CONTAINS the
   *  position — the same rule _seekNow applies. A disabled loop's markers are inert, and a position
   *  outside an engaged loop must stay outside (never yanked back in by the wrap). */
  _snapLoopRange(positionMs) {
    const range = typeof this.playback?.getLoopRange === 'function' ? this.playback.getLoopRange() : null;
    const looping = typeof this.playback?.isLooping === 'function' ? this.playback.isLooping() : false;
    if (!looping || !range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) return null;
    return positionMs >= range.start && positionMs <= range.end ? range : null;
  }

  /** Unsynced launch snap: with warp on and a launch grid set, Play starts ON this deck's own grid
   *  — the paused position moves to the NEAREST launch-grid boundary (grid marker + native tempo).
   *  A SYNCED deck is aligned to the shared beat by `_alignWrapPlaybackPosition` instead, and solo
   *  keeps its historical no-snap behavior (`deck.following` is false there while the session is
   *  off). The deck owns the snap math (`snapToOwnGridMs`); 'none' on the launch grid = no snap. */
  async _snapStartPositionToOwnGrid() {
    if (this.deck.getStatusDetail()?.enabled === true) return; // the synced path aligns instead
    const currentMs = Number(this.playback?.getCurrentPositionMs?.() ?? 0);
    const durationMs = Number(this.getDurationMs?.() ?? this.playback?.getDurationMs?.() ?? 0);
    const targetMs = this.deck.snapToOwnGridMs(currentMs, {
      launchGridQuarterBeats: this.deck.launchGridQuarterBeats,
      durationMs,
      loopRange: this._snapLoopRange(currentMs),
    });
    if (!Number.isFinite(targetMs) || Math.abs(targetMs - currentMs) < 1) return;
    await this.playback?.setPosition?.(targetMs);
    this.mediaSession?.syncPositionState?.();
  }

  _shouldQuantizeStart() {
    // Launch quantize follows WARP, not sync: a warp-off player starts immediately — it plays at
    // its natural speed, so making it wait for a bar line it won't track is a stumble, not a snap.
    // And the SHARED bar-delay belongs only to a deck that is itself synced: an unsynced deck's
    // launches ride its OWN grid (the position-snap path), never the session's bar.
    if (this.deck?.following !== true) return false;
    const synced = this.deck?.isCollection === true
      ? this.deck?.syncEnabled === true
      : syncCoordinator?.isEnabled === true;
    if (!synced) return false;
    // A joined shared clock self-enables quantize — it already proves a shared session (≥2 in-tab
    // sibling voices in-tab by default, or a joined room) + a valid tempo, so no need to also force
    // the legacy path below.
    if (this._sharedClockBeat() !== null) return true;
    if (!isQuantizeStartForced()) return false;
    if (syncCoordinator?.isEnabled !== true) return false;
    const bpm = Number(syncCoordinator?.bpm);
    if (!Number.isFinite(bpm) || bpm <= 0) return false;
    const peerCount = Number(syncCoordinator?.peerCount);
    if (!Number.isFinite(peerCount) || peerCount < 1) return false;
    return true;
  }

  _computeBarDelayMs() {
    const QUANTIZE_SLACK_MS = 40;
    // Prefer the precise, server/device-aligned shared clock when it's driving; fall back to the
    // SyncCoordinator's loose frame-sampled epoch otherwise. Same bar-delay math either way.
    const shared = this._sharedClockBeat();
    // The selectable launch grid is stored in bars. Bars follow THIS voice's OWN meter (a 6/8 voice
    // snaps to a 6/8 bar, a 4/4 voice to a 4/4 bar) over the shared beat clock — the shared clock is
    // meter-agnostic and supplies only the beat + tempo (beatNow / tempoBpm) below.
    const beatsPerBar = this.deck.launchGridQuarterBeats;
    // Launch grid = none (0) → no snap: fire immediately (delay 0 → play() takes the un-quantized path).
    if (!(beatsPerBar > 0)) return 0;
    const bpm = Number(shared ? shared.tempoBpm : syncCoordinator?.bpm);
    const nowBeat = Number(shared ? shared.beatNow : syncCoordinator?.getCurrentBeat?.());
    if (!Number.isFinite(bpm) || bpm <= 0) return 0;
    if (!Number.isFinite(nowBeat)) return 0;
    const secondsPerBeat = 60 / bpm;
    const msPerBar = beatsPerBar * secondsPerBeat * 1000;
    const EPS = 1e-6;
    const nextBarBeat = Math.ceil((nowBeat + EPS) / beatsPerBar) * beatsPerBar;
    let delayMs = (nextBarBeat - nowBeat) * secondsPerBeat * 1000;
    if (delayMs < QUANTIZE_SLACK_MS) delayMs += msPerBar;
    return delayMs;
  }

  _cancelPendingQuantizedStart() {
    const pending = this._pendingQuantizedStart;
    if (!pending) return;
    pending.canceled = true;
    if (pending.timer) {
      try { clearTimeout(pending.timer); } catch (_) {}
      pending.timer = null;
    }
    this._pendingQuantizedStart = null;
    // The armed start was abandoned (pause / superseding play) — drop the count-in so the UI doesn't
    // keep counting toward a bar that will never fire.
    this._clearCountIn();
  }

  async pause() {
    // Cancel before the "not playing" early-return: a pending quantized start
    // is logically not-yet-playing but must still be canceled on pause.
    this._cancelPendingQuantizedStart();
    this._cancelPendingQuantizedSeek(); // an armed seek must not fire after we pause

    if (!this.playback.isPlaying() && !this.transport.isRunning) {
      return;
    }
    await this.transport.pause();
    await this.playback.pause();
    this._updatePlaybackState('paused', { source: 'pause' });
  }

  async stop() {
    this._cancelPendingQuantizedStart();
    this._cancelPendingQuantizedSeek();
    if (!this.playback.isPlaying() && !this.transport.isRunning && this._playbackState === 'stopped') {
      return;
    }
    const stopPromise = this.playback.triggerStop();
    await this.transport.stop();
    await stopPromise;
    if (this._pendingDecodeStrategy) {
      try {
        await this.#swapPlayback(this._pendingDecodeStrategy);
        const currentStrategy = this.playback?.getDecodeStrategy?.();
        if (currentStrategy === this._pendingDecodeStrategy) {
          this._pendingDecodeStrategy = null;
        }
      } catch (error) {
        console.error('[AudioEngineAdapter] Failed to apply pending decode strategy:', error);
        // Keep pending so we can retry later
      }
    }
    this._updatePlaybackState('stopped', { source: 'stop' });
  }

  async resumeAfterInterruption() {
    const shouldResume =
      this._playbackState === 'playing' ||
      this.playback?.isPlaying?.() ||
      this.transport?.isRunning;

    if (!shouldResume) {
      return false;
    }

    try {
      await ensureSilentAudioUnlock();
      await Tone.start();
    } catch (_) {}

    if (typeof this.playback?.resumeAfterInterruption === 'function') {
      const resumed = await this.playback.resumeAfterInterruption();
      if (resumed) {
        this._updatePlaybackState('playing', { force: true, source: 'resume-after-interruption' });
        this.mediaSession?.syncPositionState?.();
        return true;
      }
    }

    return false;
  }

  /**
   * A seek lands IN PHASE. When a shared session is live AND we're playing, defer the
   * seek to the next bar boundary (symmetric to the quantized launch) so it re-anchors on the grid
   * instead of jumping off-phase and losing sync. Solo / not-playing → immediate (byte-identical).
   */
  async seekToMilliseconds(ms) {
    this._cancelPendingQuantizedSeek(); // a superseding seek replaces a pending one
    if (this._shouldQuantizeSeek()) {
      this._scheduleQuantizedSeek(ms);
      return;
    }
    await this._seekNow(ms);
  }

  /**
   * Quantize a seek while PLAYING and there is a grid to stay in phase with — the joined shared
   * clock (synced), or this deck's OWN running clock (unsynced, warp on, launch grid set). A seek
   * while stopped/paused has no phase to preserve. (Strictly the clocks — NOT `_shouldQuantizeStart()`
   * whose legacy fallback reads raw adapter peers.)
   */
  _shouldQuantizeSeek() {
    if (!this.playback?.isPlaying?.()) return false;
    return this._sharedClockBeat() !== null || this._ownGridBarDelayMs() !== null;
  }

  /**
   * Wall ms until this deck's OWN next launch-grid boundary — the unsynced counterpart of
   * `_computeBarDelayMs` (which reads the shared clock). Needs an unsynced deck with a RUNNING own
   * clock (playing) and a launch grid; null otherwise. The deck clock's beats live on the source
   * grid and its `secondsPerBeat` is the wall period at the tempo actually playing, so varispeed is
   * respected. Same slack rule as the shared-clock bar delay.
   */
  _ownGridBarDelayMs() {
    if (this.deck.getStatusDetail()?.enabled === true) return null; // synced → the shared clock path
    const beatsPerBar = this.deck.launchGridQuarterBeats;
    if (!(beatsPerBar > 0)) return null; // launch grid 'none'
    const clock = this.deck.clock(); // null when not playing / not following anything usable
    if (!clock) return null;
    const beatNow = Number(clock.beatNow);
    const secondsPerBeat = Number(clock.secondsPerBeat);
    if (!Number.isFinite(beatNow) || !(secondsPerBeat > 0)) return null;
    const QUANTIZE_SLACK_MS = 40;
    const EPS = 1e-6;
    const posInBar = ((beatNow % beatsPerBar) + beatsPerBar) % beatsPerBar;
    let beatsToBoundary = beatsPerBar - posInBar;
    if (beatsToBoundary < EPS) beatsToBoundary = beatsPerBar;
    const msPerBar = beatsPerBar * secondsPerBeat * 1000;
    let delayMs = beatsToBoundary * secondsPerBeat * 1000;
    if (delayMs < QUANTIZE_SLACK_MS) delayMs += msPerBar;
    return delayMs;
  }

  _scheduleQuantizedSeek(ms) {
    const shared = this._sharedClockBeat() !== null;
    let targetMs = ms;
    if (!shared) {
      // Own-grid seek: the deck's beat IS its position, so landing mid-bar would shift the groove —
      // snap the target to the nearest own-grid boundary so the jump leaves phase continuous (fires
      // ON a boundary, lands ON a boundary). The count-in marker then blinks at the real landing spot.
      const durationMs = Number(this.getDurationMs?.() ?? this.playback?.getDurationMs?.() ?? 0);
      const snapped = this.deck.snapToOwnGridMs(ms, {
        launchGridQuarterBeats: this.deck.launchGridQuarterBeats,
        durationMs,
        loopRange: this._snapLoopRange(ms),
      });
      if (Number.isFinite(snapped)) targetMs = snapped;
    }
    const delayMs = shared ? this._computeBarDelayMs() : this._ownGridBarDelayMs();
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      // No valid bar delay (e.g. tempo not resolved) → seek immediately.
      void this._seekNow(targetMs);
      return;
    }
    const pending = { timer: null, canceled: false, ms: targetMs };
    this._pendingQuantizedSeek = pending;
    // Reuse the launch count-in so the UI shows the seek is ARMED — WITH the target position so the
    // waveform blinks a marker at the set spot (the count in the action), per Bruna's UX note.
    this._emitCountIn(delayMs, { seekTargetSec: targetMs / 1000 });
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void this._firePendingQuantizedSeek(pending);
    }, delayMs);
  }

  async _firePendingQuantizedSeek(pending) {
    if (pending.canceled) return;
    this._clearCountIn();
    try {
      await this._seekNow(pending.ms);
    } finally {
      if (this._pendingQuantizedSeek === pending) this._pendingQuantizedSeek = null;
    }
  }

  _cancelPendingQuantizedSeek() {
    const pending = this._pendingQuantizedSeek;
    if (!pending) return;
    pending.canceled = true;
    if (pending.timer) { try { clearTimeout(pending.timer); } catch (_) {} pending.timer = null; }
    this._pendingQuantizedSeek = null;
    this._clearCountIn();
  }

  async _seekNow(ms) {
    const loopRange = typeof this.playback.getLoopRange === 'function'
      ? this.playback.getLoopRange()
      : null;
    const isLooping = typeof this.playback?.isLooping === 'function'
      ? this.playback.isLooping()
      : false;
    const hasLoop = Boolean(
      isLooping &&
      loopRange &&
      Number.isFinite(loopRange.start) &&
      Number.isFinite(loopRange.end),
    );
    const outsideLoop = hasLoop && (ms < loopRange.start || ms > loopRange.end);

    // Carry the per-device manual audio offset through a seek too, so a seek during a synced
    // session keeps this device's output-latency compensation instead of silently dropping it (the
    // seek path does NOT go through _alignWrapPlaybackPosition). Lead the target the SAME way the
    // aligned start does — via the deck (the one owner of that math). Wrap within the loop when staying inside it,
    // else within the track. When sync is off or the offset is 0 this is a no-op → `target === ms`.
    const target = this._leadSeekPositionMs(ms, { loopRange: outsideLoop ? null : (hasLoop ? loopRange : null) });

    if (!outsideLoop) {
      await this.transport.seek(target);
      await this.playback.setPosition(target);
      this.mediaSession?.syncPositionState?.();
      return;
    }

    const preservedRange = { start: loopRange.start, end: loopRange.end };
    this.transport.clearLoop();
    this.playback.clearLoop();

    try {
      await this.transport.seek(target);
      await this.playback.setPosition(target);
      this.mediaSession?.syncPositionState?.();
    } finally {
      this._deferredLoopRange = preservedRange;
    }
  }

  /**
   * Lead a raw seek target (ms) by the manual audio offset, but only while sync is enabled
   * (the compensation is inaudible solo). Delegates the wall-ms→source lead + wrap to the deck
   * owner. Offset 0 / sync off → returns `ms` untouched (seek stays byte-identical).
   */
  _leadSeekPositionMs(ms, { loopRange = null } = {}) {
    if (syncCoordinator?.isEnabled !== true) return ms;
    const outputLeadMs = getManualAudioOffsetMs();
    if (!outputLeadMs) return ms;
    const durationMs = Number(this.getDurationMs?.() ?? this.playback?.getDurationMs?.() ?? 0);
    const led = this.deck.leadSourcePositionMs(ms, { durationMs, loopRange, outputLeadMs });
    return Number.isFinite(led) ? led : ms;
  }

  setLoopRange(startMs, endMs, { active = true } = {}) {
    const nextActive = Boolean(active);
    // `__desiredLoopMode` is the single loop-intent flag `_ensureDefaultLoopRange` reads to decide
    // whether to (re)engage the loop on play. It must follow the intent from EVERY path, not just
    // `setLoopEnabled`: editing/redrawing markers while loop is OFF passes `active:false` here, and if
    // this didn't clear the flag it would stay stuck `true` from a prior enable — so the next play would
    // re-loop a range the user disabled instead of playing straight through from the playhead.
    this.__desiredLoopMode = nextActive;
    const currentRange = typeof this.playback?.getLoopRange === 'function'
      ? this.playback.getLoopRange()
      : null;
    const currentActive = typeof this.playback?.isLooping === 'function'
      ? Boolean(this.playback.isLooping())
      : false;
    const rangeMatches = Boolean(
      currentRange &&
      Math.abs(Number(currentRange.start) - Number(startMs)) < 0.5 &&
      Math.abs(Number(currentRange.end) - Number(endMs)) < 0.5,
    );
    const transportMatches = nextActive
      ? Boolean(
          this.transport?.isLooping &&
          Math.abs((Number(this.transport.loopStartSeconds) * 1000) - Number(startMs)) < 0.5 &&
          Math.abs((Number(this.transport.loopEndSeconds) * 1000) - Number(endMs)) < 0.5,
        )
      : !this.transport?.isLooping;

    if (rangeMatches && currentActive === nextActive && transportMatches) {
      this._deferredLoopRange = null;
      return;
    }

    this.playback.setLoopRange(startMs, endMs, { active: nextActive });
    const appliedRange = typeof this.playback?.getLoopRange === 'function'
      ? this.playback.getLoopRange()
      : null;
    if (nextActive && appliedRange?.start != null && appliedRange?.end != null) {
      this.transport.setLoopRange(appliedRange.start, appliedRange.end);
    } else {
      this.transport.clearLoop();
    }
    this._deferredLoopRange = null;
  }

  setLoopEnabled(enabled) {
    const active = Boolean(enabled);
    // Record the user's desired loop mode BEFORE any early-return. Pre-first-play the loop range
    // isn't engaged yet (isLooping()===false), so disabling here is otherwise a no-op (the guard
    // below) and `_ensureDefaultLoopRange()` would re-engage the default loop on the next
    // play — i.e. the user couldn't turn the default loop off. `__desiredLoopMode` is the intent
    // flag `_ensureDefaultLoopRange`/`isLoopActive` read, so it must follow every enable/disable.
    this.__desiredLoopMode = active;
    const currentActive = typeof this.playback?.isLooping === 'function'
      ? Boolean(this.playback.isLooping())
      : false;
    const transportActive = Boolean(this.transport?.isLooping);
    if (currentActive === active && transportActive === active) {
      return;
    }

    if (typeof this.playback?.setLoopEnabled === 'function') {
      this.playback.setLoopEnabled(active);
    } else if (!active) {
      this.playback?.clearLoop?.();
    }

    const loopRange = typeof this.playback?.getLoopRange === 'function'
      ? this.playback.getLoopRange()
      : null;
    if (active && loopRange?.start != null && loopRange?.end != null) {
      this.transport.setLoopRange(loopRange.start, loopRange.end);
    } else {
      this.transport.clearLoop();
    }
  }

  clearLoop() {
    this.transport.clearLoop();
    this.playback.clearLoop();
    this._deferredLoopRange = null;
  }

  _ensureDefaultLoopRange() {
    if (this.__desiredLoopMode !== true) {
      this._defaultLoopApplied = false;
      return false;
    }
    const hasLoopRange = typeof this.playback?.hasLoopRange === 'function'
      ? Boolean(this.playback.hasLoopRange())
      : Boolean(this.playback?.getLoopRange?.());
    if (hasLoopRange) {
      this._defaultLoopApplied = true;
      if (typeof this.playback?.isLooping === 'function' && !this.playback.isLooping()) {
        this.setLoopEnabled(true);
      }
      return true;
    }
    const durationMs = Number(this.getDurationMs?.() ?? this.playback?.getDurationMs?.() ?? 0);
    if (!Number.isFinite(durationMs) || durationMs <= 20) {
      this._defaultLoopApplied = false;
      return false;
    }
    this.setLoopRange(0, durationMs, { active: true });
    this._defaultLoopApplied = true;
    return true;
  }

  async _handlePlaybackStopped() {
    console.debug('[PlaybackSync] _handlePlaybackStopped fired', {
      state: this._playbackState,
      playerPlaying: this.playback?.isPlaying?.(),
      audioPaused: this.playback?.audio?.paused,
    });
    const positionMs = typeof this.playback?.getCurrentPositionMs === 'function'
      ? this.playback.getCurrentPositionMs()
      : 0;
    await this.transport.pause();
    await this.transport.seek(positionMs);
    this._updatePlaybackState('stopped', { source: 'player-stop' });
  }

  _handlePlaybackBuffering(payload = {}) {
    const isBuffering = Boolean(payload?.isBuffering);
    const bufferedAheadMs = Number(payload?.bufferedAheadMs);
    const readyState = Number(payload?.readyState);
    this._bufferingState = {
      isBuffering,
      bufferedAheadMs: Number.isFinite(bufferedAheadMs) ? bufferedAheadMs : 0,
      readyState: Number.isFinite(readyState) ? readyState : 0,
      source: payload?.reason || 'streaming',
      timestamp: Number(payload?.timestamp) || (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    };

    if (isBuffering) {
      this._updatePlaybackState('buffering', { transient: true, source: 'streaming-buffering' });
      return;
    }
    this._updatePlaybackState(this._playbackState, { transient: true, source: 'streaming-buffering-end' });
  }

  setActiveDimension(dimensionId) {
    if (!dimensionId) {
      console.warn('[AudioEngineAdapter.setActiveDimension] No dimensionId provided');
      return;
    }

    this._effectsMeta.activeDimensionId = dimensionId;
    const cachedConfig = this._getCachedEffectsConfig(dimensionId) || this._cloneEffectsConfig();
    const chain = this._ensureDimensionChain(dimensionId, cachedConfig);
    this.effectRacks = chain
      ? {
          x: chain.axisRacks.x ?? null,
          y: chain.axisRacks.y ?? null,
          z: chain.axisRacks.z ?? null,
        }
      : { x: null, y: null, z: null };
    this.playback.effectRacks = this.effectRacks;
    this.playback.setInputNode?.(chain?.inputGain ?? null);
    this.playback.setEffectRacks?.(this.effectRacks, this.axisOrder);
  }

  // Public getter used by monitorUtils/rack display filtering
  getActiveDimensionId() {
    return this._effectsMeta?.activeDimensionId ?? null;
  }

  /**
   * Snapshot of the engine monitor across ALL dimensions (not just the active one).
   * Reads each dimension's per-axis racks via {@link EffectsRack#getMonitorReadout}, so the
   * value math has a single owner. Drives the React Engine Monitor.
   *
   * @param {((dimensionId: string, axis: string) => (number|null))} [getNormalized] Optional source
   *   for the REAL normalized (0–1) input per (dimension, axis) — pass ParameterManager's live
   *   normalized value so the monitor reflects the true parameter state (incl. at load, before audio
   *   drives the racks) instead of each rack's last-applied/preset-default `controlNormalized`.
   * @returns {{
   *   activeDimensionId: (string|null),
   *   dimensions: Array<{
   *     dimensionId: string,
   *     dimensionLabel: string,
   *     axes: Object<string, Array<{slot:string,label:(string|null),value:(number|null),units:(string|null),formatted:string}>>
   *   }>
   * }}
   */
  getMonitorSnapshot(getNormalized = null) {
    const activeDimensionId = this.getActiveDimensionId();
    const dimensions = [];

    this._dimensionOrder.forEach((dimensionId) => {
      const chain = this._dimensionChains.get(dimensionId);
      if (!chain || !chain.axisRacks) return;

      const axes = {};
      let dimensionLabel = dimensionId;
      this.axisOrder.forEach((axis) => {
        const rack = chain.axisRacks[axis];
        if (!rack || typeof rack.getMonitorReadout !== 'function') {
          axes[axis] = [];
          return;
        }
        if (rack.dimensionLabel) dimensionLabel = rack.dimensionLabel;
        const normalized = typeof getNormalized === 'function' ? getNormalized(dimensionId, axis) : null;
        axes[axis] = rack.getMonitorReadout(Number.isFinite(normalized) ? normalized : null);
      });

      dimensions.push({ dimensionId, dimensionLabel, axes });
    });

    return { activeDimensionId, dimensions };
  }

  setParameter(paramName, value, dimensionId = null, context = {}) {
    if (!paramName) return;

    if (paramName === PREMIX_PARAM) {
      this._handleBodyLevelParameter(value);
      return;
    }

    if (!AXES.includes(paramName)) {
      console.warn('[AudioEngineAdapter.setParameter] Unsupported parameter', { paramName });
      return;
    }

    const targetDimensionId = dimensionId || this._effectsMeta.activeDimensionId;
    if (!targetDimensionId) {
      console.warn('[AudioEngineAdapter.setParameter] Missing dimension context for axis', {
        paramName,
        dimensionId,
      });
      return;
    }

    const chain = this._ensureDimensionChain(targetDimensionId, this._getCachedEffectsConfig(targetDimensionId));
    const rack = chain?.axisRacks?.[paramName];
    if (!rack) {
      console.warn('[AudioEngineAdapter.setParameter] Rack not found for axis/dimension', {
        axis: paramName,
        dimensionId: targetDimensionId,
      });
      return;
    }

    let cosmicLfo = this._cosmicLfoCache?.[paramName] ?? null;
    if (!cosmicLfo && !this._cosmicManager) {
      this.refreshCosmicLfoCache();
      cosmicLfo = this._cosmicLfoCache?.[paramName] ?? null;
    }
    if (cosmicLfo && cosmicLfo.isActive && typeof cosmicLfo.isAudioConnected === 'function' && cosmicLfo.isAudioConnected()) {
      debugParamRoute('engine:axis-skip-cosmic', { axis: paramName, dimensionId: targetDimensionId });
      return;
    }

    const normalized = typeof this.userManager?.getNormalizedValue === 'function'
      ? this.userManager.getNormalizedValue(paramName, targetDimensionId)
      : undefined;

    const fallback = Number.isFinite(Number(normalized)) ? Number(normalized) : Number(value);
    const clamped = Number.isFinite(fallback) ? Math.max(0, Math.min(1, fallback)) : 0;

    const discreteKey = `${paramName}:${targetDimensionId}`;
    const supportsContinuous = typeof rack.supportsContinuousAutomation === 'function'
      ? rack.supportsContinuousAutomation()
      : true;

    if (!supportsContinuous) {
      const last = this._lastDiscreteValues?.[discreteKey];
      if (last !== null && last !== undefined && Math.abs(last - clamped) < 0.05) {
        return;
      }
      this._lastDiscreteValues[discreteKey] = clamped;
    } else if (this._lastDiscreteValues && this._lastDiscreteValues[discreteKey] !== null) {
      this._lastDiscreteValues[discreteKey] = null;
    }

    debugParamRoute('engine:apply-axis', { axis: paramName, dimensionId: targetDimensionId, clamped, value });

    try {
      if (typeof window !== 'undefined' && window.__DEBUG_AXIS_X_DIM3 && paramName === 'x' && targetDimensionId === 'EW::III') {
        
      }
    } catch (_) {}

    rack.applyInputValue(clamped, {
      axis: paramName,
      dimensionId: targetDimensionId,
      rawValue: value,
      updateIntent: context?.updateIntent === 'commit' ? 'commit' : 'live',
      sourceController: context?.sourceController ?? null,
      reason: context?.reason ?? 'parameter-change',
    });
  }

  getAmplitude() {
    if (!this.masterMeter) return 0;
    const meterValue = this.masterMeter.getValue();
    const db = Array.isArray(meterValue) ? meterValue[0] : meterValue;
    if (!Number.isFinite(db)) return 0;
    return Tone.dbToGain ? Tone.dbToGain(db) : Math.pow(10, db / 20);
  }

  isPlaying() {
    return typeof this.playback?.isPlaying === 'function'
      ? this.playback.isPlaying()
      : false;
  }

  getCurrentPositionMs() {
    let position = 0;
    if (typeof this.playback?.getCurrentPositionMs === 'function') {
      position = this.playback.getCurrentPositionMs();
    } else if (typeof this.transport?.getCurrentPositionMs === 'function') {
      position = this.transport.getCurrentPositionMs();
    }
    this._maybeRestoreDeferredLoop(position);
    return position;
  }

  getDurationMs() {
    return typeof this.playback?.getDurationMs === 'function'
      ? this.playback.getDurationMs()
      : 0;
  }

  /** Decoded source buffer for source-level engines (granular). Null while
   *  streaming, before load, or when the active sink doesn't retain one. */
  getDecodedAudioBuffer() {
    return this.playback?.getDecodedBuffer?.() ?? null;
  }

  /** The bus where source-level engine output joins the dry player signal
   *  (before the effects chain), so both take the same voice path. */
  getSourceMixBus() {
    return this.normalizationGain ?? null;
  }

  /** Dry-leg level (0–1) for a source-level engine's wet/dry crossfade. */
  setSourceDryLevel(level) {
    this.playback?.setSourceDryLevel?.(level);
  }

  /** Acquire this voice's source-level engine for a family (first acquire builds it, last
   *  release disposes it) — see sourceEngineHost.js for the build contract. */
  acquireSourceEngine(id, build) {
    return this._sourceEngines.acquire(id, build);
  }

  /** The family's live source engine, if one exists right now. Does not create or refcount. */
  peekSourceEngine(id) {
    return this._sourceEngines.peek(id);
  }

  /** Observe source-engine lifetime: `cb(id, engine)` on create, `cb(id, null)` on dispose.
   *  Observers (the visual seam) must never extend an engine's refcount. */
  observeSourceEngines(cb) {
    return this._sourceEngines.observe(cb);
  }

  /** Every live rack-effect slot across ALL dimension chains (the chains run in
   *  series and are all always audible, so consumers must not filter by the
   *  active dimension). Classify by `slot.config.effectId`. */
  peekEffectSlots() {
    const slots = [];
    this._dimensionChains.forEach((chain) => {
      Object.values(chain?.axisRacks ?? {}).forEach((rack) => {
        rack?.slots?.forEach((slot) => {
          if (slot) slots.push(slot);
        });
      });
    });
    return slots;
  }

  /** Observe rack-effect slot lifetime across all dimension chains: `cb(slot, true)`
   *  on create, `cb(slot, false)` right before dispose (the visual seam — same
   *  contract as `EffectsRack.observeSlots`). Racks built after subscription are
   *  covered; racks only relay while this adapter lives. */
  observeEffectSlots(cb) {
    if (typeof cb !== 'function') return () => {};
    this._effectSlotObservers.add(cb);
    return () => {
      this._effectSlotObservers.delete(cb);
    };
  }

  _notifyEffectSlot(slot, present) {
    for (const cb of this._effectSlotObservers) {
      try {
        cb(slot, present);
      } catch (error) {
        console.warn('[AudioEngineAdapter] Effect-slot observer failed', error);
      }
    }
  }

  isLooping() {
    return typeof this.playback?.isLooping === 'function'
      ? this.playback.isLooping()
      : false;
  }

  /**
   * The EFFECTIVE loop state for the UI. Loop is on by default (`__desiredLoopMode`), but
   * the loop range only engages on the first `play()` (`_ensureDefaultLoopRange`), so a raw
   * `isLooping()` reads false at interface load and the loop control showed a fake "off". Until the
   * default has been applied (or the user has changed it), report the desired default so the loop
   * icon reflects the real state from load; afterwards follow the live loop.
   */
  isLoopActive() {
    if (this.isLooping()) {
      return true;
    }
    if (this._defaultLoopApplied) {
      return false;
    }
    return this.__desiredLoopMode === true;
  }

  hasLoopRange() {
    return typeof this.playback?.hasLoopRange === 'function'
      ? this.playback.hasLoopRange()
      : Boolean(this.getLoopRange());
  }

  getLoopRange() {
    return typeof this.playback?.getLoopRange === 'function'
      ? this.playback.getLoopRange()
      : null;
  }

  /**
   * The current track's waveform JSON url (audiowaveform v2) — the SAME field
   * PeaksView reads to fetch its peaks, surfaced so the React timeline kit can fetch and
   * render the exact same data without going through Peaks. Resolves from the playback
   * track data (same precedence waveformMount uses), then the documented url fields.
   */
  getWaveformUrl() {
    const td = this.playbackTrackData || this.trackData?.track || this.trackData || null;
    return td?.waveformJSONURL || td?.waveformURL || td?.waveformJsonUrl || null;
  }

  setPlaybackRate(rate, options = {}) {
    if (this._speedControlDisabled) {
      return;
    }
    if (typeof this.playback?.setPlaybackRate === 'function') {
      this.playback.setPlaybackRate(rate, options);
      this.mediaSession?.syncPositionState?.();
    }
  }

  getPlaybackRate() {
    return typeof this.playback?.getPlaybackRate === 'function'
      ? this.playback.getPlaybackRate()
      : 1;
  }

  /** How the sink interprets rate: 'stretch' (pitch locked) or 'varispeed'
   *  (tape). Returns false when the sink has no stretch engine. */
  setRateMode(mode) {
    return this.playback?.setRateMode?.(mode) === true;
  }

  getRateMode() {
    return typeof this.playback?.getRateMode === 'function'
      ? this.playback.getRateMode()
      : 'varispeed';
  }

  /** Pitch shift with tempo locked (stretch engine only). Returns false when
   *  unhandled so callers can fall back to tape mappings. */
  setPitchSemitones(semitones) {
    return this.playback?.setPitchSemitones?.(semitones) === true;
  }

  getPitchSemitones() {
    return typeof this.playback?.getPitchSemitones === 'function'
      ? this.playback.getPitchSemitones()
      : 0;
  }

  getGridMarkerState() {
    return this.deck;
  }

  /** This voice's OWN native track tempo (its grid reference, never the shared session/singleton) —
   *  the uncontaminated per-voice value a scoped persist should fall back to when a caller only
   *  means to update a different field (e.g. meter) and mustn't accidentally overwrite this voice's
   *  saved tempo with whatever the shared coordinator currently holds. */
  getOwnTrackBpm() {
    return this.deck.nativeTempo;
  }

  /** Mirror the deck's transport tempo into the `sync-bpm` readout — the number IS `deck.tempo`
   *  (master-driven while synced, the deck's own while unsynced, held across sync toggles). Tagged
   *  as the display mirror so the edit bridge ignores the echo. */
  _refreshSyncBpmReadout() {
    const bpm = this.deck.tempo;
    if (Number.isFinite(bpm) && bpm > 0) {
      try { this.userManager?.setRawValue?.('sync-bpm', bpm, SYNC_BPM_DISPLAY_SOURCE); } catch (_) {}
    }
  }

  /** Set THIS voice's own native track tempo (a per-track edit from the kit panel — the persisted
   *  value): the deck updates its grid reference + follow rate WITHOUT touching the shared
   *  coordinator, so one voice's tempo edit never retunes a synced sibling. */
  setOwnTrackBpm(trackBpm) {
    this.deck.setNativeTempo(trackBpm);
  }

  getGridMarkers() {
    return this.deck.getGridMarkers();
  }

  getGridMarker() {
    return this.deck.getGridMarker();
  }

  getGridMarkerTimeSec() {
    return this.deck.getGridMarkerTimeSec();
  }

  /**
   * Updates the source-audio time used as the current grid marker for sync alignment.
   *
   * @param {number} value
   */
  setGridMarkerTimeSec(value) {
    this.deck.setGridMarkerTimeSec(value);
    if (syncCoordinator?.isEnabled === true) {
      this._alignWrapPlaybackPosition({ force: true }).catch((error) => {
        console.warn('[AudioEngineAdapter] Failed to update grid marker.', error);
      });
    }
  }

  getWrapGridState() {
    return this.getGridMarkerState();
  }

  setWrapGridStartTimeSec(value) {
    this.setGridMarkerTimeSec(value);
  }

  getWrapGridStartTimeSec() {
    return this.getGridMarkerTimeSec();
  }

  isSpeedControlDisabled() {
    return Boolean(this._speedControlDisabled);
  }

  getSpeedControlState() {
    return {
      disabled: Boolean(this._speedControlDisabled),
      reason: this._speedControlDisableReason,
      strategy: this.playback?.getDecodeStrategy?.() || null,
    };
  }

  /** Whether a user-requested buffered reload is currently in flight (UI reads this for a busy state). */
  isBufferedReloadPending() {
    return this._bufferedReloadPromise != null;
  }

  /**
   * "Unlock speed": a conscious user overrides the adaptive streaming decision and forces this
   * track into the buffered/RAM backend — the mobile speed lock exists only because streaming
   * can't stretch, so a successful buffered load lifts it. Automatic streaming stays the default;
   * this is the explicit escape hatch.
   *
   * Order matters: swap → AWAIT THE REAL DOWNLOAD/DECODE → only then re-run the strategy owner to
   * lift the lock. Declaring success at swap time would unlock speed for an asset that may still
   * fail to decode. On failure everything reverts: streaming backend back, lock re-engaged (via
   * the same one owner), position kept. Single-flight: repeat calls join the in-flight attempt.
   * Playback parity with the effects-driven engine swap: we stop first and stay stopped — the
   * user restarts (a forced mid-play backend swap can't be seamless).
   * @returns {Promise<boolean>} true when buffered playback is live and speed is unlocked.
   */
  async requestBufferedReload() {
    if (this._bufferedReloadPromise) return this._bufferedReloadPromise;
    // Watchdog: the attempt must ALWAYS settle. A hung await inside (a worklet
    // RPC that never answers, a decode that never returns) would otherwise
    // leave the single-flight promise set forever — every retry tap silently
    // no-ops and the user sees nothing. On timeout: report failure, revert to
    // streaming, and free the single-flight slot so a retry is possible. The
    // attempt TOKEN fences the orphan: a timed-out attempt that resumes later
    // finds its token stale and bails before touching playback state (a late
    // seek / strategy re-resolve would otherwise fight the next retry).
    const token = Symbol('buffered-reload-attempt');
    this._bufferedReloadToken = token;
    let watchdogTimer = null;
    const watchdog = new Promise((resolve) => {
      watchdogTimer = setTimeout(() => resolve(RELOAD_WATCHDOG_TIMEOUT), BUFFERED_RELOAD_WATCHDOG_MS);
    });
    const attempt = this.#performBufferedReload(token)
      .catch((error) => {
        // Belt for a throw outside the attempt's own try (nothing should, but
        // a reject here must still settle as a reported failure, not silence).
        console.warn('[AudioEngineAdapter] Buffered reload rejected unexpectedly:', error);
        return false;
      });
    this._bufferedReloadPromise = Promise.race([attempt, watchdog])
      .then(async (outcome) => {
        if (outcome !== RELOAD_WATCHDOG_TIMEOUT) return outcome;
        console.warn('[AudioEngineAdapter] Buffered reload timed out — reverting to streaming.');
        this._bufferedReloadToken = null; // fence the orphaned attempt out
        this._forcePrebuffer = false;
        try {
          if (this.playback?.getDecodeStrategy?.() !== 'stream') {
            await this.#swapPlayback('stream');
          }
          this.#resolveDecodeStrategy(); // re-engages the lock through the one owner
        } catch (revertError) {
          console.error('[AudioEngineAdapter] Failed to revert to streaming after reload timeout:', revertError);
        }
        return false;
      })
      .finally(() => {
        clearTimeout(watchdogTimer);
        this._bufferedReloadPromise = null;
      });
    return this._bufferedReloadPromise;
  }

  async #performBufferedReload(token) {
    // Stale-token fence: true only while THIS attempt still owns the reload.
    const owns = () => this._bufferedReloadToken === token;
    const bufferedStrategies = ['prebuffer', 'stretch'];
    if (bufferedStrategies.includes(this.playback?.getDecodeStrategy?.()) && !this._speedControlDisabled) {
      return true; // already buffered + unlocked — nothing to do
    }
    // No feasibility refusal here: the unlock is an explicit user choice and
    // always gets its attempt, whatever the device — a failed load reverts
    // cleanly and reports through the failure toast.
    // Capture BEFORE stopping (stop can rewind the readhead).
    const positionMs = this.getCurrentPositionMs();
    this._forcePrebuffer = true;
    try {
      if (this.playback?.isPlaying?.() || this.transport?.isRunning) {
        // Stop THIS voice — the unlock is voice-scoped (a collection tile), so never reach for the
        // ACTIVE voice's transport: that can stop a sibling tile and leave this one running. Use
        // this adapter's own registry entry (its transport control keeps the play button honest),
        // else stop the engine directly.
        const entry = voiceRegistry.all().find((v) => v?.audioEngine === this) ?? null;
        const transport = entry?.transportControl ?? null;
        if (transport) await transport.stop();
        else await this.stop();
      }
      if (!owns()) return false;
      this._pendingDecodeStrategy = null;
      // Ask the resolver which sink a forced-buffered resolve WOULD pick (a
      // pure probe — running the strategy owner itself here would lift the
      // speed lock before the download/decode has actually succeeded).
      const probe = resolvePlaybackStrategy({
        profile: this.performanceProfile,
        effectsConfig: this.engineConfig?.effects,
        trackData: this.playbackTrackData,
        forceBuffered: true,
      });
      await this.#swapPlayback(probe.sink);
      if (!owns()) return false;
      // The swap only builds the backend — the download/decode IS the feature. Await it.
      if (!this.playback.isLoaded) {
        await this.playback.load();
      }
      if (!owns()) return false;
      if (Number.isFinite(positionMs) && positionMs > 0) {
        try { await this.seekToMilliseconds(positionMs); } catch (_) {}
      }
      if (!owns()) return false;
      // Buffered audio is truly live — NOW let the one strategy owner lift the lock (it resolves
      // a buffered strategy under the sticky override, so the mobile-stream lock no longer applies).
      this.#resolveDecodeStrategy();
      console.info('[AudioEngineAdapter] Buffered reload complete — engine features unlocked.');
      return true;
    } catch (error) {
      console.warn('[AudioEngineAdapter] Buffered reload failed — staying on streaming:', error);
      if (!owns()) return false; // the timeout path already reverted for us
      this._forcePrebuffer = false;
      try {
        if (this.playback?.getDecodeStrategy?.() !== 'stream') {
          await this.#swapPlayback('stream');
          if (Number.isFinite(positionMs) && positionMs > 0) {
            try { await this.seekToMilliseconds(positionMs); } catch (_) {}
          }
        }
        this.#resolveDecodeStrategy(); // re-engages the lock through the same owner
      } catch (revertError) {
        console.error('[AudioEngineAdapter] Failed to revert to streaming after buffered reload failure:', revertError);
      }
      return false;
    }
  }

  /**
   * Get the playback rate parameter (Tone.Signal) for audio-rate modulation.
   * Used by effects that need to modulate playback speed continuously.
   * @returns {Tone.Signal|null} Signal if available (prebuffer mode), null otherwise (streaming mode)
   */
  getPlaybackRateParam() {
    return typeof this.playback?.getPlaybackRateParam === 'function'
      ? this.playback.getPlaybackRateParam()
      : null;
  }

  /**
   * Get the reverse parameter (Tone.Signal) for audio-rate reverse control.
   * Used by effects that need to control playback direction continuously.
   * @returns {Tone.Signal|null} Signal if available (prebuffer mode), null otherwise (streaming mode)
   */
  getReverseParam() {
    return typeof this.playback?.getReverseParam === 'function'
      ? this.playback.getReverseParam()
      : null;
  }

  /**
   * Check if playback is currently in reverse mode.
   * @returns {boolean} True if playing in reverse, false otherwise
   */
  isPlaybackReverse() {
    return typeof this.playback?.isPlaybackReverse === 'function'
      ? this.playback.isPlaybackReverse()
      : false;
  }

  /**
   * Set playback direction (forward or reverse).
   * Only supported in prebuffer mode with compatible effects.
   * @param {boolean} reverse - True for reverse playback, false for forward
   * @param {object} options - Optional playback options
   * @returns {Promise<void>}
   */
  async setPlaybackReverse(reverse, options = {}) {
    const desired = Boolean(reverse);
    if (typeof this.playback?.setPlaybackReverse === 'function') {
      await this.playback.setPlaybackReverse(desired, options);
    }
  }

  /**
   * Update the effects configuration with new axis settings.
   * This method is async to handle automatic playback strategy changes.
   *
   * IMPORTANT: When a module requires prebuffer mode (e.g., reverse effects),
   * this method will automatically swap from streaming to prebuffer BEFORE
   * configuring the effects, ensuring the correct backend is available.
   *
   * @param {object} effectsConfig - Effects configuration with axis settings
   * @returns {Promise<void>}
   */
  async updateEffectsConfig(effectsConfig = {}) {
    const { __meta: meta = {}, ...axesConfig } = effectsConfig || {};
    const fallbackDimensionId = meta.activeDimensionId
      ?? this._effectsMeta.activeDimensionId
      ?? DEFAULT_DIMENSION_ID;

    if (!fallbackDimensionId) {
      console.warn('[AudioEngineAdapter.updateEffectsConfig] Missing dimensionId');
      return;
    }

    if (Array.isArray(meta.dimensionOrder)) {
      this._setDimensionOrder(meta.dimensionOrder);
    }

    const baseConfig = this._cloneEffectsConfig(axesConfig);

    // Check if playback strategy needs to change BEFORE configuring effects.
    // This ensures reverse effects get prebuffer mode before being mounted.
    const desiredStrategy = this.#resolveDecodeStrategy(this.performanceProfile, baseConfig);
    const currentStrategy = typeof this.playback?.getDecodeStrategy === 'function'
      ? this.playback.getDecodeStrategy()
      : null;

    if (currentStrategy && currentStrategy !== desiredStrategy) {
      if (this.playback?.isPlaying?.() || this.transport?.isRunning) {
        // CRITICAL: Some effects (like reverse) require a different playback engine.
        // We cannot apply them while audio is playing, so we must stop playback first,
        // swap the engine, then allow the user to restart.
        if (process.env.NODE_ENV === 'development') {
          console.info('[AudioEngineAdapter] Stopping playback to apply engine strategy change.', {
            currentStrategy,
            desiredStrategy,
            reason: 'effect-requires-different-engine',
          });
        }

        // Store current position for potential resume
        const currentPositionMs = this.getCurrentPositionMs();

        // Use the active voice's transport control to stop (updates button too)
        const transport = voiceRegistry.getActive()?.transportControl ?? null;
        if (transport) {
          await transport.stop();
        } else {
          await this.stop();
        }

        // Now swap the playback strategy
        this._pendingDecodeStrategy = null;
        await this.#swapPlayback(desiredStrategy);

        // Restore position after engine swap
        if (Number.isFinite(currentPositionMs) && currentPositionMs > 0) {
          try {
            await this.seekToMilliseconds(currentPositionMs);
          } catch (error) {
            console.warn('[AudioEngineAdapter] Failed to restore position after engine swap:', error);
          }
        }
      } else {
        // Swap playback strategy immediately and AWAIT completion.
        // This blocks effect configuration until the correct backend is ready.
        this._pendingDecodeStrategy = null;
        await this.#swapPlayback(desiredStrategy);
      }
    }

    const discoveredIds = this._collectDimensionIdsFromEffectsConfig(baseConfig);
    if (!discoveredIds.size) {
      discoveredIds.add(fallbackDimensionId);
    } else {
      discoveredIds.add(fallbackDimensionId);
    }

    const configsByDimension = new Map();
    discoveredIds.forEach((dimensionId) => {
      const scopedConfig = this._ensureEffectsConfigDimension(baseConfig, dimensionId);
      configsByDimension.set(dimensionId, {
        next: scopedConfig,
        previous: this.effectsConfigByDimension.get(dimensionId),
      });
      this._dimensionIds.add(dimensionId);
    });

    this._registerDimensionParameters(discoveredIds);

    let topologyChanged = false;
    discoveredIds.forEach((dimensionId) => {
      const record = configsByDimension.get(dimensionId);
      if (!record) return;
      const scopedConfig = record.next;
      const previousConfig = record.previous;
      const changedAxes = this._getChangedAxes(previousConfig, scopedConfig);
      let chain = this._dimensionChains.get(dimensionId);

      if (!chain) {
        chain = this._ensureDimensionChain(dimensionId, scopedConfig);
        topologyChanged = true;
      } else if (changedAxes.length) {
        chain = this._ensureDimensionChain(dimensionId, scopedConfig, changedAxes);
        // Axes changed may or may not affect node graph; EffectsRack.configure will now avoid rewiring
      }

      this.effectsConfigByDimension.set(dimensionId, scopedConfig);

      if (dimensionId === fallbackDimensionId && chain) {
        this.effectRacks = {
          x: chain.axisRacks?.x ?? null,
          y: chain.axisRacks?.y ?? null,
          z: chain.axisRacks?.z ?? null,
        };
        this.playback.effectRacks = this.effectRacks;
      }
    });

    this._effectsMeta.activeDimensionId = fallbackDimensionId;
    if (topologyChanged) {
      this._rewireGlobalChain();
    }

    // Update engineConfig after successful strategy change and effects configuration
    this.engineConfig = {
      ...(this.engineConfig || {}),
      effects: {
        ...baseConfig,
      },
    };

    // Re-sync parameter locks now that the NEW config is installed: the resolve
    // above ran against the candidate config while the lock targets were still
    // scanned from the previous one, so a freshly added engine-requiring module
    // would otherwise miss its lock (and a removed one would stay locked).
    this.#syncParameterLocks();

    debugParamRoute('engine:updateEffectsConfig:applied', {
      dimensionId: fallbackDimensionId,
      dimensionIds: Array.from(this._dimensionIds),
    });
  }

  dispose() {
    this._cancelPendingQuantizedStart();
    this._cancelPendingQuantizedSeek();
    if (this._playbackStopSubscription) {
      try {
        this._playbackStopSubscription();
      } catch (_) {}
      this._playbackStopSubscription = null;
    }
    if (this._playbackBufferingSubscription) {
      try {
        this._playbackBufferingSubscription();
      } catch (_) {}
      this._playbackBufferingSubscription = null;
    }
    this._playbackStateListeners.clear();
    this._playbackState = 'stopped';
    this._initialized = false;
    if (this._deckSubscription) {
      try {
        this._deckSubscription();
      } catch (_) {}
      this._deckSubscription = null;
    }
    if (this._syncBpmBridgeSub) {
      try { this._syncBpmBridgeSub(); } catch (_) {}
      this._syncBpmBridgeSub = null;
    }
    // The deck itself outlives the engine (it belongs to the VOICE — the session disposes it at
    // voice teardown); only this engine's position feed is released here.
    this.deck.setPositionSource(null);
    setPlaybackState('stopped');
    this.mediaSession?.dispose?.();
    try {
      this.transport.stop?.();
    } catch (_) {}

    try {
      this.playback.triggerStop?.();
    } catch (_) {}
    try {
      this.playback.dispose?.();
    } catch (_) {}

    this._dimensionChains.forEach((chain) => {
      Object.values(chain.axisRacks || {}).forEach((rack) => rack?.dispose?.());
      try { chain.inputGain?.disconnect?.(); } catch (_) {}
      try { chain.outputGain?.disconnect?.(); } catch (_) {}
      chain.inputGain?.dispose?.();
      chain.outputGain?.dispose?.();
    });
    this._dimensionChains.clear();
    this._dimensionOrder = [];
    // Racks have already notified `(slot, false)` for every live slot above.
    this._effectSlotObservers.clear();

    // Disconnect and dispose normalization gain
    try { this.normalizationGain?.disconnect?.(); } catch (_) {}
    this.normalizationGain?.dispose?.();
    this.normalizationGain = null;

    this.bodyLevelGain?.disconnect?.();
    this.bodyLevelGain?.dispose?.();
    this.bodyLevelGain = null;

    // Disconnect all of masterGain's outgoing edges — mode-agnostic: single-orbiter feeds the limiter,
    // multi-orbiter feeds the meter + the shared master bus. Never connected to a shared node
    // that outlives this voice, so disconnect-all is safe.
    try { this.masterGain?.disconnect?.(); } catch (_) {}
    this.masterGain?.dispose?.();
    this.masterGain = null;

    // Disconnect and dispose the per-voice limiter (null in multi-orbiter mode — the shared host owns it).
    try { this.limiter?.disconnect?.(this.masterMeter); } catch (_) {}
    try { this.limiter?.disconnect?.(this._outputNode ?? Tone.Destination); } catch (_) {}
    this.limiter?.dispose?.();
    this.limiter = null;

    this.masterMeter?.dispose?.();
    this.masterMeter = null;
  }

  async _alignWrapPlaybackPosition({ force = false } = {}) {
    if (syncCoordinator?.isEnabled !== true) return;
    const durationMs = Number(this.getDurationMs?.() ?? this.playback?.getDurationMs?.() ?? 0);
    const loopRange = typeof this.playback?.getLoopRange === 'function'
      ? this.playback.getLoopRange()
      : null;
    // Lead the aligned playhead by the per-device manual audio offset so THIS device's audio
    // comes out that many ms earlier (compensating output latency the browser can't measure — see
    // config/audioOffset.js). Applied here, at the one owner of the beat→playhead mapping, it survives
    // the re-alignment at fire time and every periodic re-align, and covers seek too — so the device's
    // whole output is uniformly shifted. Positive offset = play slightly ahead of the grid = earlier
    // acoustically. Offset 0 (default) leaves the aligned position byte-identical.
    const outputLeadMs = getManualAudioOffsetMs();
    const targetMs = this.deck.computeAlignedSourcePositionMs({ durationMs, loopRange, outputLeadMs });
    if (!Number.isFinite(targetMs)) return;
    const currentMs = Number(this.playback?.getCurrentPositionMs?.() ?? this.getCurrentPositionMs?.() ?? 0);
    if (!force && Number.isFinite(currentMs) && Math.abs(currentMs - targetMs) < 12) {
      return;
    }
    await this.playback?.setPosition?.(targetMs);
    this.mediaSession?.syncPositionState?.();
  }

  _syncWrapPlaybackRate({ immediate = false } = {}) {
    // Only owns the rate for voices with NO speed-control effect at all. A tempoPitch effect (whether its
    // active module is a tempo OR a pitch module) is the factory's to own — gate on the WIDER speed-target
    // set, not getTempoManagedTargets() (tempo* modules only), or a voice on a pitch module gets its rate
    // double-written here and in the factory.
    if (this.#getSpeedControlTargets().length > 0) {
      return;
    }
    // On mobile the speed lock pins audio to its native rate. Don't compute or push a
    // transport warp ratio the sink would only reject — the engine stays the authoritative gate,
    // this early-out just avoids the needless work on constrained devices.
    if (this._speedControlDisabled) {
      return;
    }
    // WARP: a voice with no tempoPitch effect time-stretches to its deck's transport tempo. The deck
    // owns the whole rule — followRatio is transport/native while following (warp on; synced OR an
    // unsynced collection deck on its own tempo; solo additionally requires the session enabled,
    // byte-identical to the historical single-orbiter behavior) and exactly 1 otherwise.
    const targetRate = Math.max(0.01, Number(this.deck.followRatio) || 1);
    if (typeof this.playback?.setPlaybackRate === 'function') {
      this.playback.setPlaybackRate(targetRate, { immediate });
      this.mediaSession?.syncPositionState?.();
    }
  }

  _handleBodyLevelParameter(value) {
    const targetGain = this.bodyLevelGain ?? this.masterGain;
    if (!Tone || !targetGain) return;
    const rawDb = typeof value === 'number' ? value : this.userManager?.getRawValue?.(PREMIX_PARAM) ?? 0;
    const dbValue = Math.max(-60, Math.min(6, rawDb));
    const gain = Tone.dbToGain ? Tone.dbToGain(dbValue) : Math.pow(10, dbValue / 20);
    const now = typeof Tone.now === 'function' ? Tone.now() : 0;

    if (typeof targetGain.gain?.rampTo === 'function') {
      targetGain.gain.rampTo(gain, 0.05);
    } else if (typeof targetGain.gain?.setTargetAtTime === 'function') {
      const audioContext = Tone.getContext?.()?.rawContext ?? Tone.context?.rawContext ?? null;
      const time = audioContext?.currentTime ?? now;
      targetGain.gain.setTargetAtTime(gain, time, 0.05);
    } else if (typeof targetGain.gain?.linearRampToValueAtTime === 'function') {
      const audioContext = Tone.getContext?.()?.rawContext ?? Tone.context?.rawContext ?? null;
      const time = audioContext?.currentTime ?? now;
      try { targetGain.gain.setValueAtTime(targetGain.gain.value, time); } catch (_) {}
      targetGain.gain.linearRampToValueAtTime(gain, time + 0.05);
    } else {
      targetGain.gain.value = gain;
    }
  }

  /**
   * Extracts playbackGainDb from track metadata
   * @returns {number} Gain in dB (0 if not available)
   */
  _extractNormalizationGainDb() {
    const metadata = this.playbackTrackData?.metadata || {};
    const normalization = metadata?.audioNormalization;

    if (!normalization) return 0;

    const playbackGainDb = Number(normalization.playbackGainDb);

    if (!Number.isFinite(playbackGainDb)) return 0;

    // Optional: Safety check against maxAllowableGainDb
    const maxGainDb = Number(normalization.maxAllowableGainDb);
    if (Number.isFinite(maxGainDb) && playbackGainDb > maxGainDb) {
      console.warn(
        `[AudioEngine] Clamping normalization gain ${playbackGainDb.toFixed(2)} dB to max ${maxGainDb.toFixed(2)} dB`
      );
      return maxGainDb;
    }

    return playbackGainDb;
  }

  /**
   * Applies normalization gain from track metadata
   * Called once during engine initialization
   */
  _applyNormalizationGain() {
    if (!this.normalizationGain) return;

    const gainDb = this._extractNormalizationGainDb();
    // Use Tone.dbToGain if available (more accurate), fallback to manual conversion
    const gainLinear = Tone.dbToGain ? Tone.dbToGain(gainDb) : Math.pow(10, gainDb / 20);

    this.normalizationGain.gain.value = gainLinear;

    if (gainDb !== 0) {
      console.log(
        `[AudioEngine] Applied normalization gain: ${gainDb.toFixed(2)} dB (${gainLinear.toFixed(3)}x)`
      );
    }
  }

  _ensureDimensionChain(dimensionId, effectsConfig = null, axesToRefresh = AXES) {
    if (!dimensionId) return null;

    const existing = this._dimensionChains.get(dimensionId);
    const config = this._ensureEffectsConfigDimension(
      effectsConfig || this._getCachedEffectsConfig(dimensionId) || this._cloneEffectsConfig(),
      dimensionId,
    );

    if (existing) {
      const refreshSet = new Set(
        Array.isArray(axesToRefresh) && axesToRefresh.length ? axesToRefresh : AXES,
      );
      if (!refreshSet.size) {
        return existing;
      }
      AXES.forEach((axis) => {
        if (!refreshSet.has(axis)) return;
        const rack = existing.axisRacks[axis];
        if (rack) {
          rack.setPerformanceProfile?.(this.performanceProfile);
          rack.configure(config[axis] || cloneRackConfig({ dimensionId }));
        }
      });
      return existing;
    }

    const ToneRef = Tone;
    // Per-stage input headroom: attenuate at the START of each dimension stage so
    // its processors have headroom and can't clip internally. 3 stages × STAGE_HEADROOM_DB.
    const inputGain = new ToneRef.Gain(dbToLinear(STAGE_HEADROOM_DB));
    const outputGain = new ToneRef.Gain(1);
    enforceStereo(inputGain);
    enforceStereo(outputGain);

  const axisRacks = {};
  let previousNode = inputGain;

    // Final deck channel (explicit stereo panner at end-of-chain for this dimension).
    // Unity gain: the old -6 dB here both over-attenuated (3 × -6 = -18 dB in
    // series) and gave processors no input headroom. Headroom now lives at each stage's
    // inputGain (STAGE_HEADROOM_DB); this node is purely the panner.
    const deckChannel = new ToneRef.Channel({ volume: 0, pan: 0 });
    // Force stereo semantics where supported to avoid accidental mono
    try {
      enforceStereo(deckChannel);
    } catch (_) {}

    this.axisOrder.forEach((axis) => {
      const rack = new EffectsRack({
        channel: axis,
        dimensionId,
        controllers: { playback: this, deckChannel },
        performanceProfile: this.performanceProfile,
        deck: this.deck,
      });
      rack.init({
        Tone: ToneRef,
        config: config[axis] || cloneRackConfig({ dimensionId }),
        performanceProfile: this.performanceProfile,
      });
      rack.observeSlots((slot, present) => this._notifyEffectSlot(slot, present));
      axisRacks[axis] = rack;

      const inputNode = rack.getInputNode();
      const outputNode = rack.getOutputNode();

      if (inputNode && typeof previousNode.connect === 'function') {
        previousNode.connect(inputNode);
      } else if (typeof previousNode.connect === 'function') {
        previousNode.connect(outputNode);
      }

      previousNode = outputNode;
    });

    // Ensure deck-level channel is last before output gain
    try {
      previousNode.connect(deckChannel);
      deckChannel.connect(outputGain);
    } catch (error) {
      console.warn('[AudioEngineAdapter] Failed to connect deck channel', error);
      try { previousNode.connect(outputGain); } catch (_) {}
    }

    const chain = {
      dimensionId,
      inputGain,
      outputGain,
      axisRacks,
      deckChannel,
    };

    // Optional targeted debug for X axis on EW::III
    try {
      if (typeof window !== 'undefined' && window.__DEBUG_AXIS_X_DIM3 && dimensionId === 'EW::III') {
        const xr = axisRacks.x;
        const configX = (effectsConfig || {})?.x;
        void xr; void configX;
      }
    } catch (_) {}

    this._dimensionChains.set(dimensionId, chain);
    this._dimensionIds.add(dimensionId);
    if (!this._dimensionOrder.includes(dimensionId)) {
      this._dimensionOrder.push(dimensionId);
    }
    this._registerDimensionParameters([dimensionId]);

    this._rewireGlobalChain();

    return chain;
  }

  _cloneEffectsConfig(effects = {}) {
    return {
      x: cloneRackConfig(effects.x),
      y: cloneRackConfig(effects.y),
      z: cloneRackConfig(effects.z),
    };
  }

  _ensureEffectsConfigDimension(config, dimensionId) {
    if (!config || !dimensionId) return config;
    const next = this._cloneEffectsConfig(config);
    const axisSummaries = [];
    AXES.forEach((axis) => {
      const axisConfig = next[axis] || cloneRackConfig({ dimensionId });
      const axisDimensionId = axisConfig.dimensionId ?? dimensionId;
      const axisDimensionLabel = axisConfig.dimensionLabel ?? axisDimensionId ?? dimensionId;
      const modules = Array.isArray(axisConfig.modules) ? axisConfig.modules : [];

      // Prepare module list: prefer modules scoped to this dimension, then fall back to global
      const prepared = modules.map((moduleConfig = {}) => {
        const scoped = cloneModuleConfig(moduleConfig, axisDimensionId);
        scoped.dimensionLabel = scoped.dimensionLabel ?? axisDimensionLabel;
        return scoped;
      });
      const specific = prepared.filter((m) => m.dimensionId === dimensionId);
      const global = prepared.filter((m) => !m.dimensionId);
      const filteredModules = [...specific, ...global].slice(0, MAX_MODULES);

      axisConfig.dimensionId = axisDimensionId;
      axisConfig.dimensionLabel = axisDimensionLabel;
      axisConfig.modules = filteredModules;
      next[axis] = axisConfig;
      axisSummaries.push({
        axis,
        dimensionId: axisDimensionId,
        moduleIds: filteredModules.map((module) => module?.effectId ?? null),
        populated: filteredModules.filter((module) => module?.effectId).length,
      });
    });
    debugEngineStacks('ensureEffectsConfigDimension', { dimensionId, axes: axisSummaries });
    return next;
  }

  _getCachedEffectsConfig(dimensionId) {
    if (!dimensionId) return null;
    const cached = this.effectsConfigByDimension.get(dimensionId);
    return cached ? this._cloneEffectsConfig(cached) : null;
  }

  _primeDimensionIdsFromConfig(effectsConfig = {}) {
    const ids = this._collectDimensionIdsFromEffectsConfig(effectsConfig);
    ids.forEach((id) => {
      if (id) {
        this._dimensionIds.add(id);
      }
    });
    if (ids.size) {
      debugEngineStacks('Prime dimension ids from effects config', {
        dimensionIds: [...ids],
      });
    }
  }

  _primeDimensionIdsFromStacks(stacks = null) {
    if (!stacks || typeof stacks !== 'object') return;
    const discovered = [];
    Object.entries(stacks).forEach(([stackId, stack]) => {
      if (!stack || typeof stack !== 'object') return;
      const dimensionIds = Object.keys(stack.dimensions || {}).filter(Boolean);
      dimensionIds.forEach((dimensionId) => this._dimensionIds.add(dimensionId));
      if (dimensionIds.length) {
        discovered.push({ stackId, dimensionIds });
      }
    });
    if (discovered.length) {
      debugEngineStacks('Prime dimension ids from stacks', { discovered });
    }
  }

  _collectDimensionIdsFromEffectsConfig(effectsConfig = {}) {
    const ids = new Set();
    AXES.forEach((axis) => {
      const axisConfig = effectsConfig[axis];
      if (!axisConfig) return;
      if (axisConfig.dimensionId) {
        ids.add(axisConfig.dimensionId);
      }
      const modules = Array.isArray(axisConfig.modules) ? axisConfig.modules : [];
      modules.forEach((module) => {
        if (module?.dimensionId) {
          ids.add(module.dimensionId);
        }
      });
    });
    return ids;
  }

  _getChangedAxes(previousConfig, nextConfig) {
    if (!previousConfig) return [...AXES];
    return AXES.filter((axis) =>
      this._hasAxisDefinitionChanged(previousConfig[axis], nextConfig[axis]),
    );
  }

  _hasAxisDefinitionChanged(prevAxisConfig, nextAxisConfig) {
    if (!prevAxisConfig && !nextAxisConfig) return false;
    if (!prevAxisConfig || !nextAxisConfig) return true;
    const prevSnapshot = this._buildAxisDefinitionSnapshot(prevAxisConfig);
    const nextSnapshot = this._buildAxisDefinitionSnapshot(nextAxisConfig);
    return JSON.stringify(prevSnapshot) !== JSON.stringify(nextSnapshot);
  }

  _buildAxisDefinitionSnapshot(axisConfig) {
    if (!axisConfig) return null;
    const modules = Array.isArray(axisConfig.modules) ? axisConfig.modules : [];
    // Consider an axis changed as soon as an effectId appears, even if moduleId
    // has not been selected yet. Racks can pick a default module on configure.
    const populatedModules = modules
      .filter((module) => module?.effectId)
      .map((module) => this._normalizeModuleDefinition(module));
    return {
      dimensionId: axisConfig.dimensionId ?? null,
      modules: populatedModules,
    };
  }

  _normalizeModuleDefinition(moduleConfig = {}) {
    return {
      effectId: moduleConfig.effectId ?? null,
      moduleId: moduleConfig.moduleId ?? null,
      inputParamId: moduleConfig.inputParamId ?? null,
      range: moduleConfig.range
        ? {
            min: Number.isFinite(moduleConfig.range.min) ? Number(moduleConfig.range.min) : null,
            max: Number.isFinite(moduleConfig.range.max) ? Number(moduleConfig.range.max) : null,
            equilibrium: Number.isFinite(moduleConfig.range.equilibrium ?? moduleConfig.range.init)
              ? Number(moduleConfig.range.equilibrium ?? moduleConfig.range.init)
              : null,
          }
        : null,
      settings: this._normalizePlainObject(moduleConfig.settings),
      mappings: sanitizeMappings(moduleConfig.mappings),
    };
  }

  _normalizePlainObject(value) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      return value.map((item) => (typeof item === 'object' ? this._normalizePlainObject(item) : item));
    }
    if (typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((acc, key) => {
          const entry = value[key];
          acc[key] =
            entry && typeof entry === 'object'
              ? this._normalizePlainObject(entry)
              : entry;
          return acc;
        }, {});
    }
    return value;
  }

  _parseAxisParameterName(parameterName) {
    if (typeof parameterName !== 'string') return null;
    const match = parameterName.match(/^([xyz])(?::(.+))?$/i);
    if (!match) return null;
    return {
      axis: match[1].toLowerCase(),
      dimensionId: match[2] || null,
    };
  }

  _registerParameterSubscriptions() {
    if (this._subscriptionsRegistered) return;
    if (!this.userManager || typeof this.userManager.subscribe !== 'function') {
      console.warn('[AudioEngineAdapter] Cannot subscribe to parameters - missing userManager.subscribe');
      return;
    }
    AXES.forEach((axis) => this._subscribeParameter(axis));
    this._subscribeParameter(PREMIX_PARAM);
    this._registerDimensionParameters(this._dimensionIds);
    this._subscriptionsRegistered = true;
  }

  _subscribeParameter(parameterName, dimensionId = null) {
    if (!this.userManager || typeof this.userManager.subscribe !== 'function') return;
    const key = dimensionId ? `${parameterName}::${dimensionId}` : parameterName;
    if (this._subscribedParams.has(key)) return;
    try {
      this.userManager.subscribe(this, parameterName, 2, dimensionId);
      this._subscribedParams.add(key);
    } catch (error) {
      console.warn(`[AudioEngineAdapter] Failed to subscribe to parameter '${parameterName}'`, error);
    }
  }

  _registerDimensionParameters(dimensionIds) {
    if (!dimensionIds) return;
    const list = Array.isArray(dimensionIds) ? dimensionIds : Array.from(dimensionIds);
    list.forEach((dimensionId) => {
      if (!dimensionId) return;
      this._dimensionIds.add(dimensionId);
      AXES.forEach((axis) => {
        this._subscribeParameter(axis, dimensionId);
      });
    });
  }

  onParameterChanged(parameterName, value, dimensionId = null, metadata = null) {
    if (!parameterName) return;

    if (parameterName === PREMIX_PARAM) {
      this.setParameter(PREMIX_PARAM, value, null, metadata || {});
      return;
    }

    const axisInfo = this._parseAxisParameterName(parameterName);
    if (axisInfo) {
      const targetDimensionId = dimensionId || axisInfo.dimensionId || this._effectsMeta.activeDimensionId;
      this.setParameter(axisInfo.axis, value, targetDimensionId, metadata || {});
      return;
    }

    if (AXES.includes(parameterName)) {
      this.setParameter(parameterName, value, dimensionId || this._effectsMeta.activeDimensionId, metadata || {});
    }
  }

  addPlaybackStateListener(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    this._playbackStateListeners.add(listener);
    return () => {
      this._playbackStateListeners.delete(listener);
    };
  }

  removePlaybackStateListener(listener) {
    if (!listener) return;
    this._playbackStateListeners.delete(listener);
  }

  getPlaybackState() {
    return this._playbackState;
  }

  getBufferingState() {
    if (typeof this.playback?.getBufferingState === 'function') {
      const state = this.playback.getBufferingState();
      return {
        ...this._bufferingState,
        ...state,
      };
    }
    return { ...this._bufferingState };
  }

  refreshCosmicLfoCache(manager = null) {
    const resolved = manager ?? this._resolveCosmicManager();
    this._cosmicManager = resolved;
    this._cosmicLfoCache = {
      x: resolved?.x ?? null,
      y: resolved?.y ?? null,
      z: resolved?.z ?? null,
    };
  }

  _resolveCosmicManager() {
    return voiceRegistry.getActive()?.cosmicLFOManager ?? null;
  }

  _maybeRestoreDeferredLoop(positionMs) {
    if (!this._deferredLoopRange) return;
    if (!Number.isFinite(positionMs)) return;
    const { start, end } = this._deferredLoopRange;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
      this._deferredLoopRange = null;
      return;
    }
    if (positionMs < start || positionMs > end) {
      return;
    }
    this.transport.setLoopRange(start, end);
    this.playback.setLoopRange(start, end);
    this._deferredLoopRange = null;
  }

  _updatePlaybackState(nextState, { force = false, transient = false, source = 'adapter' } = {}) {
    if (!nextState) return;
    const previousState = this._playbackState;
    const stableStates = new Set(['playing', 'paused', 'stopped']);
    const isStable = stableStates.has(nextState);

    if (!force && !transient && previousState === nextState) {
      return;
    }

    if (isStable) {
      this._playbackState = nextState;
      setPlaybackState(nextState);
    } else if (force) {
      this._playbackState = nextState;
    }

    const payload = {
      state: nextState,
      previousState,
      stable: isStable,
      transient: Boolean(transient),
      source,
      timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    };

    this._playbackStateListeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        console.error('[AudioEngineAdapter] playback state listener error', error);
      }
    });
  }


  _setDimensionOrder(order = []) {
    const filtered = Array.isArray(order)
      ? order.filter((id) => typeof id === 'string' && id.length)
      : [];
    const existing = this._dimensionOrder.filter((id) => !filtered.includes(id));
    const nextOrder = [...filtered, ...existing];

    const sameLength = nextOrder.length === this._dimensionOrder.length;
    const sameOrder = sameLength && nextOrder.every((id, i) => id === this._dimensionOrder[i]);

    if (!sameOrder) {
      this._dimensionOrder = nextOrder;
      this._dimensionChains.forEach((_, dimensionId) => {
        if (!this._dimensionOrder.includes(dimensionId)) {
          this._dimensionOrder.push(dimensionId);
        }
      });
      this._rewireGlobalChain();
      return;
    }

    // Ensure any new chains are included without forcing a rewire if order stayed the same
    let pushed = false;
    this._dimensionChains.forEach((_, dimensionId) => {
      if (!this._dimensionOrder.includes(dimensionId)) {
        this._dimensionOrder.push(dimensionId);
        pushed = true;
      }
    });
    if (pushed) {
      this._rewireGlobalChain();
    }
  }

  _rewireGlobalChain() {
    const player = this.playback?.player;
    const hasPlayerSource = Boolean(player && typeof player.connect === 'function');

    if (hasPlayerSource) {
      try {
        player.disconnect();
      } catch (_) {}
    }

    // Disconnect previous chain outputs (keep per-rack internal wiring intact).
    this._dimensionChains.forEach((chain) => {
      try { chain.outputGain.disconnect(); } catch (_) {}
    });

    // Teardown above always runs; only the re-connect below needs somewhere to connect TO.
    //
    // The master bus is built when a session loads. If the load failed there is nothing to
    // wire into, and every later parameter change would otherwise throw on a null
    // destination — the engine must stay inert until a session actually arrives, not fail
    // loudly once per knob. Placed after the disconnects so a bus torn down mid-session still
    // gets its stale edges cleared rather than left feeding a dead graph.
    if (!this.bodyLevelGain && !this.masterGain) {
      return;
    }

    const orderedChains = this._dimensionOrder
      .map((id) => this._dimensionChains.get(id))
      .filter(Boolean);

    if (!orderedChains.length) {
      if (hasPlayerSource) {
        try {
          // No effects: Player → normalizationGain → bodyLevelGain
          if (this.normalizationGain) {
            player.connect(this.normalizationGain);
            // Connect normalizationGain to bodyLevelGain (no effects in between)
            try { this.normalizationGain.disconnect(); } catch (_) {}
            this.normalizationGain.connect(this.bodyLevelGain || this.masterGain);
          } else {
            // Fallback if no normalizationGain
            player.connect(this.bodyLevelGain || this.masterGain);
          }
        } catch (error) {
          console.warn('[AudioEngineAdapter] Failed to connect player to master', error);
        }
      }
      return;
    }

    // Keep dimension chain outputs connected to master regardless of playback source type.
    for (let i = 0; i < orderedChains.length - 1; i += 1) {
      const current = orderedChains[i];
      const next = orderedChains[i + 1];
      try {
        current.outputGain.connect(next.inputGain);
      } catch (error) {
        console.warn('[AudioEngineAdapter] Failed to connect dimension chain output', {
          fromDimensionId: current.dimensionId,
          toDimensionId: next.dimensionId,
          error,
        });
      }
    }

    const lastChain = orderedChains[orderedChains.length - 1];
    try {
      // Connect effects output to bodyLevelGain (master fader)
      const outputTarget = this.bodyLevelGain || this.masterGain;
      lastChain.outputGain.connect(outputTarget);
    } catch (error) {
      console.warn('[AudioEngineAdapter] Failed to connect final chain to master', error);
    }

    // Prebuffer mode source wiring: Player → normalizationGain → first effect (input gain before processing)
    if (hasPlayerSource) {
      try {
        if (this.normalizationGain) {
          // Player → normalizationGain → first effect → ... → last effect → bodyLevelGain
          player.connect(this.normalizationGain);
          try { this.normalizationGain.disconnect(); } catch (_) {}
          this.normalizationGain.connect(orderedChains[0].inputGain);
        } else {
          // Fallback: Player → first effect directly
          player.connect(orderedChains[0].inputGain);
        }
      } catch (error) {
        console.warn('[AudioEngineAdapter] Failed to connect player to first dimension chain', {
          dimensionId: orderedChains[0]?.dimensionId,
          error,
        });
      }
    }
  }
}

export default AudioEngineAdapter;
