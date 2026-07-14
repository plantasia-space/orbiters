import { EFFECT_MANIFEST } from './manifest.js';
import { syncCoordinator } from '../../../../sync/SyncCoordinator.js';
import { TEMPO_EPSILON } from '../../../../sync/pulseClock.js';
import { isDebugSyncLoggingEnabled } from '../../../../sync/debugSync.js';

const RATE_EPSILON = 0.0005;

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function semitoneToRatio(semitones, Tone) {
  const numeric = toNumber(semitones, 0);
  if (!Number.isFinite(numeric)) return 1;
  if (Tone?.intervalToFrequencyRatio) {
    return Tone.intervalToFrequencyRatio(numeric);
  }
  return Math.pow(2, numeric / 12);
}

function mapPercentValue(value, range = {}) {
  const min = toNumber(range?.min, -100);
  const max = toNumber(range?.max, 100);
  const percent = clamp(toNumber(value, 0), min, max);
  const rateFactor = 1 + percent / 100;
  const playbackRate = Math.max(0.01, rateFactor);
  return { playbackRate };
}

function mapSemitoneValue(value, range, Tone, quantizeStep = 1) {
  const min = toNumber(range?.min, -12);
  const max = toNumber(range?.max, 12);
  const clamped = clamp(toNumber(value, 0), min, max);
  const snapped = Math.round(clamped / quantizeStep) * quantizeStep;
  const playbackRate = semitoneToRatio(snapped, Tone);
  return { playbackRate, semitones: snapped };
}

function createTempoPitchModule({ moduleSpec, playbackController, Tone, sharedState, deck }) {
  const range = moduleSpec.valueRange || EFFECT_MANIFEST.userParamSpec?.range || null;
  const quantize = range?.quantize;
  const isQuantized = quantize?.unit === 'st';
  const quantizeStep = Number(quantize?.step ?? 1) || 1;
  // A TEMPO module (tempoFine/tempoWide/tempoStretch*) is the deck's PITCH FADER — it controls tempo and,
  // when this deck is following, DRIVES the shared master. A PITCH module (pitchFine/pitchWide/pitchPure*)
  // shifts pitch only and never touches the master tempo.
  const isTempoModule = typeof moduleSpec?.id === 'string' && moduleSpec.id.startsWith('tempo');
  // Stretch-engine axes: a 'stretch' rate module keeps pitch locked while tempo moves; an 'engine'
  // pitch module shifts semitones while tempo stays. Both degrade to the classic tape behavior when
  // the active playback sink has no stretch engine (the setters below report unhandled).
  const wantsStretchRate = moduleSpec?.rateMode === 'stretch';
  const wantsEnginePitch = moduleSpec?.pitchMode === 'engine';
  // A speed-and-reverse module maps ONE bipolar input to a signed velocity:
  // 0 = stop, +full = 1x forward, -full = 1x reverse, linear in between. The
  // magnitude drives the rate and the sign drives the read DIRECTION, combined
  // ONLY here — so there is still one rate owner. The sink glides to silence at
  // ~0 speed (a true stop) and reads its one buffer backwards on reverse.
  const isSpeedReverse = moduleSpec?.speedMode === 'speedReverse';
  let lastReverse = false;

  const commitReverse = (reversed) => {
    if (lastReverse === reversed) return;
    lastReverse = reversed;
    // Async at the sink (reschedules the engine at a signed rate); direction is
    // the only effect, so a failed switch just leaves the current direction.
    void Promise.resolve(playbackController?.setPlaybackReverse?.(reversed))
      .catch((error) => {
        console.warn('[ToneTempoPitchEffect] Failed to switch playback direction.', error);
      });
  };

  const commitPitchSemitones = (semitones) => {
    if (!playbackController || typeof playbackController.setPitchSemitones !== 'function') return false;
    return playbackController.setPitchSemitones(semitones) === true;
  };

  const pushRateMode = () => {
    playbackController?.setRateMode?.(wantsStretchRate ? 'stretch' : 'varispeed');
  };

  let automationBridge = null;
  let lastPlaybackRate = null;
  let lastUserPlaybackRate = null;
  let lastInput = null;
  let isActive = false;
  // DJ-deck anchor (this module's own). The synced+warp fader is an ABSOLUTE position, the master tempo a
  // MOVING value, so the fader drives the master as a deviation from where it is anchored:
  // M = anchorM × (1 + (userRate − anchorUserRate)). null until the deck is following with a known master.
  let anchorM = null;
  let anchorUserRate = 1;

  const commitPlaybackRate = (playbackRate) => {
    if (!playbackController || !Number.isFinite(playbackRate)) return;
    if (
      lastPlaybackRate !== null &&
      Math.abs(lastPlaybackRate - playbackRate) <= RATE_EPSILON
    ) {
      return;
    }
    if (isDebugSyncLoggingEnabled()) {
      console.debug('[tempoPitch] commitPlaybackRate', { from: lastPlaybackRate, to: playbackRate });
    }
    if (automationBridge?.ramp) {
      automationBridge.ramp(playbackRate);
    } else {
      playbackController?.setPlaybackRate?.(playbackRate);
    }
    lastPlaybackRate = playbackRate;
  };

  // Whether this deck time-stretches to its transport tempo — the DECK owns the rule (warp on;
  // synced OR an unsynced collection deck on its own transport; solo additionally requires the sync
  // session enabled). Warp off lets any deck run free at its own natural tempo.
  const isFollowing = () => sharedState.following === true;

  // Re-capture (anchorM, anchorUserRate) whenever the deck's transport tempo moved from a source
  // OTHER than this deck's own fader — i.e. the number, another deck (via the master), or sync/warp
  // just turned following on. Stateless test: if the live transport matches what THIS fader+anchor
  // predicts, it's our own echo (keep the anchor → no compounding); otherwise adopt the transport as
  // the fader's new zero (the stationary fader then means the transport, so it never jumps). Only
  // TEMPO modules drive/anchor the transport.
  const reconcileAnchor = () => {
    if (!isTempoModule) return;
    if (!isFollowing()) {
      anchorM = null;
      return;
    }
    const master = toNumber(sharedState.transportBpm, null);
    if (!(master > 0)) return;
    const userRate = Number.isFinite(lastUserPlaybackRate) ? lastUserPlaybackRate : 1;
    const expectedM = anchorM > 0 ? anchorM * (1 + (userRate - anchorUserRate)) : null;
    if (expectedM === null || Math.abs(master - expectedM) > TEMPO_EPSILON) {
      anchorM = master;
      anchorUserRate = userRate;
    }
  };

  const applyEffectivePlaybackRate = () => {
    if (!isActive) return;
    const userRate = Number.isFinite(lastUserPlaybackRate) ? lastUserPlaybackRate : 1;
    // DJ-deck table. Following: a tempo deck plays the master (baseRate = M / trackBpm); a pitch deck rides
    // its semitone ratio on top of the master (baseRate × userRate). Independent (not following): the fader
    // is the deck's own control — 0% = the song's native tempo (rate = 1 + knob%) for a tempo deck, or a
    // pitch shift on the native track for a pitch deck.
    const baseRate = toNumber(sharedState.baseRate, 1);
    let rate;
    if (isFollowing() && !isSpeedReverse) {
      rate = isTempoModule ? baseRate : baseRate * userRate;
    } else {
      // A speed-and-reverse knob is an absolute speed control (its −1..+3 mapping is
      // the whole point), so it stays INDEPENDENT even on a following deck —
      // scaling it by the follow ratio would distort the mapping.
      rate = userRate;
    }
    commitPlaybackRate(Math.max(0.01, Number.isFinite(rate) ? rate : 1));
  };

  const applyValue = (value) => {
    if (!playbackController) return;
    if (isSpeedReverse) {
      lastInput = value;
      if (!isActive) return;
      // Linear map from the bipolar input onto the module's SIGNED rate range
      // (signalRange, e.g. −1..+3): the input equilibrium sits at 1× normal
      // play, one extreme reaches reverse and the other a fast forward, with a
      // true stop where the rate crosses 0 (the sink glides to silence there).
      const min = toNumber(range?.min, -100);
      const max = toNumber(range?.max, 100);
      const sr = moduleSpec?.control?.signalRange || {};
      const rateMin = toNumber(sr.min, -1);
      const rateMax = toNumber(sr.max, 3);
      const span = max - min;
      const t = span > 0 ? (clamp(toNumber(value, 0), min, max) - min) / span : 0.5;
      const signed = rateMin + t * (rateMax - rateMin);
      // Sign = read direction, magnitude = rate; combined only here.
      commitReverse(signed < 0);
      lastUserPlaybackRate = Math.abs(signed);
      applyEffectivePlaybackRate();
      return;
    }
    if (value === lastInput && lastPlaybackRate !== null) return;
    lastInput = value;

    const mapping = isQuantized
      ? mapSemitoneValue(value, range, Tone, quantizeStep)
      : mapPercentValue(value, range);

    // Pure-pitch module on the stretch engine: semitones land on the engine
    // and the rate side stays neutral (a following deck still tracks its
    // transport tempo). If the sink has no engine, fall through to the
    // classic tape mapping below.
    if (wantsEnginePitch && commitPitchSemitones(mapping.semitones ?? 0)) {
      lastUserPlaybackRate = 1;
      applyEffectivePlaybackRate();
      return;
    }

    lastUserPlaybackRate = mapping.playbackRate;

    // A following TEMPO fader drives the deck's TRANSPORT tempo via its anchor (the DJ nudge):
    // T = anchorM × (1 + (userRate − anchorUserRate)). reconcileAnchor keeps the anchor pinned to
    // wherever the transport is, so the fader is a deviation from it — it never jumps it. The deck
    // routes the write: synced proposes the shared master (every other following deck snaps to it;
    // the coordinator's one gate stays the authority), unsynced moves only this deck's own tempo.
    // `anchorM` is only ever non-null while following (reconcileAnchor nulls it the instant
    // following drops), so it alone gates whether there's a nudge to propose.
    if (isTempoModule && anchorM > 0) {
      const proposed = anchorM * (1 + (mapping.playbackRate - anchorUserRate));
      if (Number.isFinite(proposed) && proposed > 0) {
        deck?.setTempo(proposed, { sourceType: 'module' });
      }
    }
    applyEffectivePlaybackRate();
  };

  return {
    id: moduleSpec.id,
    label: moduleSpec.label,
    description: moduleSpec.description,
    inputParam: EFFECT_MANIFEST.inputParam,
    toneProperty: moduleSpec.target,
    tonePropertyDescription: moduleSpec.description,
    valueRange: range,
    applyValue,
    // Pure-pitch and speed-and-reverse modules drive the engine through applyValue,
    // never the rate param — exposing it would let automation ramp the RATE and
    // lose the sign (direction) a speed-and-reverse knob carries.
    getTargetParam: () =>
      (wantsEnginePitch || isSpeedReverse) ? null : playbackController?.getPlaybackRateParam?.() ?? null,
    // Re-apply the rate when the deck's transport tempo, sync-enable, or warp flag changes
    // (baseRate/transportBpm are updated before this fires). reconcileAnchor handles a false→true
    // follow transition, so the anchor is valid before the next local drive.
    handleSyncChange() {
      reconcileAnchor();
      applyEffectivePlaybackRate();
    },
    setIsActive(active) {
      isActive = active === true;
      if (isSpeedReverse) {
        // Speed + direction from one input. Activating pushes the flavor (tape
        // vs stretch) and applies the held value; leaving restores forward so a
        // removed module can't strand the track playing backwards.
        if (isActive) {
          pushRateMode();
          if (lastInput !== null) applyValue(lastInput);
          else applyEffectivePlaybackRate();
        } else {
          commitReverse(false);
        }
        return;
      }
      if (isActive) {
        // The active module owns how the sink interprets rate (tape vs stretch).
        pushRateMode();
        reconcileAnchor();
        applyEffectivePlaybackRate();
        if (wantsEnginePitch && lastInput !== null) {
          const mapping = mapSemitoneValue(lastInput, range, Tone, quantizeStep);
          commitPitchSemitones(mapping.semitones ?? 0);
        }
      } else if (wantsEnginePitch) {
        // Leaving a pure-pitch module must not freeze its shift on the voice.
        commitPitchSemitones(0);
      }
    },
    setAutomationBridge(bridge) {
      automationBridge = bridge;
      if (bridge && lastPlaybackRate !== null) {
        automationBridge.ramp(lastPlaybackRate);
      }
    },
  };
}

export function createToneTempoPitchEffect({ Tone, settings, deck = null } = {}) {
  if (!Tone?.Gain) {
    throw new Error('[ToneTempoPitchEffect] Tone.Gain constructor is required.');
  }

  const playbackController = settings?.playbackController ?? null;
  const node = new Tone.Gain(1);
  // sharedState (effect-wide), all read from the DECK (the one owner of the follow rule):
  // baseRate = deck.followRatio (transport / native while following, exactly 1 otherwise);
  // transportBpm = the deck's transport tempo (the anchor space the fader drives in — the shared
  // master while synced, the deck's own tempo while unsynced); following = deck.following.
  const sharedState = { baseRate: 1, transportBpm: null, following: false };

  const modules = EFFECT_MANIFEST.modules.map((moduleSpec) =>
    createTempoPitchModule({ moduleSpec, playbackController, Tone, sharedState, deck }),
  );
  let activeModuleId = modules[0]?.id ?? null;

  const applyDeckSnapshot = (snapshot) => {
    const ratio = toNumber(snapshot?.baseRate, null);
    sharedState.baseRate = ratio && ratio > 0 ? ratio : 1;
    const transport = toNumber(snapshot?.bpm, null);
    if (transport && transport > 0) sharedState.transportBpm = transport;
    sharedState.following = snapshot?.following === true;
  };

  const handleDeckChange = (snapshot, reason) => {
    if (reason !== 'bpm' && reason !== 'sync-status') return;
    applyDeckSnapshot(snapshot);
    const activeModule = modules.find((module) => module.id === activeModuleId);
    activeModule?.handleSyncChange?.();
  };

  // Construction-time seed so a voice that mounts mid-session reads current truth (its deck's
  // transport tempo, follow ratio, and follow state) before its first drive — the anchor is then
  // captured by the setIsActive() reconcile below. Live updates arrive via the deck's change stream;
  // deck-less paths keep the independent defaults (not following, ratio 1).
  if (typeof window !== 'undefined' && deck) {
    applyDeckSnapshot(deck.getSnapshot());
  }

  const unsubDeck = deck ? deck.onChange(handleDeckChange) : null;

  modules.forEach((module) => module.setIsActive?.(module.id === activeModuleId));

  return {
    id: EFFECT_MANIFEST.id,
    label: EFFECT_MANIFEST.label,
    version: EFFECT_MANIFEST.version,
    inputParam: EFFECT_MANIFEST.inputParam,
    node,
    modules,
    configureModule(moduleId) {
      activeModuleId = moduleId;
      modules.forEach((module) => module.setIsActive?.(module.id === moduleId));
    },
    dispose() {
      unsubDeck?.();
      // Return the sink to its defaults so a removed effect leaves no frozen
      // tape mode, pitch shift, or reversed direction behind (no-ops on sinks
      // without the engine).
      playbackController?.setRateMode?.('stretch');
      playbackController?.setPitchSemitones?.(0);
      void Promise.resolve(playbackController?.setPlaybackReverse?.(false)).catch(() => {});
      modules.splice(0, modules.length);
      if (typeof node.dispose === 'function') {
        node.dispose();
      }
    },
    manifest: EFFECT_MANIFEST,
  };
}

export default createToneTempoPitchEffect;
