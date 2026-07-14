/**
 * @file src/multi/makeAudioVoiceSession.js
 * @description An AUDIO-ONLY orbiter voice for the multi-orbiter view. Secondary voices
 * (every roster entry after the primary) need only an audio graph mixed into the shared
 * `MultiOrbiterAudioHost`; they have no scene, no React UI, no second `#canvas3D` (per
 * decisions/0001-A3-build-plan.md — N live 3D scenes are a separate visual slice). This builds the
 * minimal per-voice audio unit: its own DataManager + ParameterManager + an `AudioEngineAdapter`
 * wired to `outputNode = host.getInputNode()`, registered under its own voiceId.
 *
 * It resolves its track DIRECTLY via `dataManager.fetchTrackData(trackId)` — NOT the window-event
 * session pipeline (`orbiters:session-*`), which is realm-global and would cross-talk between voices
 * (the per-voice event routing is A2 step 8d / deferred). Per-voice transport SYNC (one shared
 * musical clock fanning to all voices) is a later slice; this session only proves the audio MIX (N voices
 * → one master limiter → speakers), so this session does not wire SyncCoordinator.
 *
 * Param hydration reuses the SAME helpers as the full base flow (no forked param path).
 */
import { DataManager } from '../api/dataManager/index.js';
import { ParameterManager } from '../core/ParameterManager.js';
import { AudioEngineAdapter } from '../audio/AudioEngineAdapter.js';
import { Deck } from '../voice/Deck.js';
import { getSharedClockState } from '../sync/init.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { AXIS_ROTATION_CONSTRAINTS } from '../config/Constants.js';
import {
  hydrateRootAxesFromTrack,
  initializeRootParams,
} from '../orbiter/baseFlow/rootParams.js';
import {
  createStubOrbiterFromCombined,
  deriveStacksDefaultsFromCombined,
} from '../session/editModeHelpers.js';

const ROOT_AXES = ['x', 'y', 'z'];

/** Register the root x/y/z axis params (the adapter subscribes to them), matching the full boot. */
function registerRootAxisParams(parameterManager) {
  const { min = 0, max = 1, equilibrium = 0 } = AXIS_ROTATION_CONSTRAINTS || {};
  ROOT_AXES.forEach((axis) => {
    parameterManager.addParameter(axis, equilibrium, min, max, true, 'linear', (v) => v, (v) => v);
  });
}

/**
 * Build one audio-only voice session bound to the shared host.
 * @param {object} ctx
 * @param {{voiceId: string, trackId: string}} ctx.entry the roster descriptor.
 * @param {*} ctx.outputNode the shared master bus (host.getInputNode()).
 * @param {*} [ctx.transport] an optional shared transport (default: the adapter builds its own).
 * @returns {import('./createMultiOrbiterApp.js').VoiceSession}
 */
export function makeAudioVoiceSession({ entry, outputNode, transport = null }) {
  const { voiceId, trackId } = entry;
  const parameterManager = new ParameterManager();
  const dataManager = new DataManager();
  let audioEngine = null;
  let disposed = false;

  // This voice's DECK — the one owner of its sync/warp flags, tempo, meter, grid, and beat clock.
  // The coordinator fans each master/status change to it; its shared-clock source reads the realm
  // clock live (a function so the beat is never cached). Seeded from trackData by the adapter.
  const deck = new Deck({ voiceId, collection: true });
  deck.setSharedClockSource(() => getSharedClockState());

  // Register synchronously (two-phase, like the full boot): identity + managers now, the engine once
  // its async init completes. The primary voice registers first, so it stays the active/focused one.
  voiceRegistry.register(voiceId, {
    id: voiceId,
    parameterManager,
    dataManager,
    deck,
    rootEl: typeof document !== 'undefined' ? document : null,
  });

  async function start() {
    if (disposed) return;
    const combined = await dataManager.fetchTrackData(trackId);
    if (!combined) {
      console.warn(`[multi] audio voice "${voiceId}" — no track data for ${trackId}`);
      return;
    }

    const stacksDefaults = deriveStacksDefaultsFromCombined(combined, null);
    const stubOrbiter = createStubOrbiterFromCombined(combined, { stacksDefaults });

    registerRootAxisParams(parameterManager);
    hydrateRootAxesFromTrack(parameterManager, combined);
    initializeRootParams(parameterManager, combined);

    audioEngine = new AudioEngineAdapter({
      trackData: combined,
      engineConfig: stubOrbiter?.orbiterData,
      userManager: parameterManager,
      outputNode, // mix into the shared master bus → the host's one limiter
      transport,
      deck: voiceRegistry.get(voiceId)?.deck,
    });

    await audioEngine.initialize();
    await audioEngine.preload?.();
    if (disposed) {
      // disposed mid-init — don't leak the freshly built graph
      try { audioEngine.dispose?.(); } catch (_) {}
      audioEngine = null;
      return;
    }

    if (voiceRegistry.has(voiceId)) {
      voiceRegistry.assignAudioEngine(voiceId, audioEngine);
    }
  }

  function resume() {
    void audioEngine?.resumeAfterInterruption?.();
  }

  function dispose() {
    disposed = true;
    try { audioEngine?.dispose?.(); } catch (_) {}
    audioEngine = null;
  }

  // suspend is a no-op — an audio-only voice has no visual/idle resources to release; pausing audio
  // when the tab hides is a product choice the shared transport will own, not this session.
  return { voiceId, parameterManager, start, suspend() {}, resume, dispose };
}
