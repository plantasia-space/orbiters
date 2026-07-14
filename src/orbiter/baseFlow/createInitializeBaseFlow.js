import { cloneStacksState } from '../../core/stackUtils.js';
import { createLoadProgress } from '../../boot/loadProgress.js';
import { Constants, AXIS_ROTATION_CONSTRAINTS } from '../../config/Constants.js';
import { consumePendingOrbiterSession } from '../../utils/iFrameParams.js';
import { AudioEngineAdapter } from '../../audio/AudioEngineAdapter.js';
import { setupInteractions, applyColorsFromTrackData } from '../../ui/Interaction.js';
import { applyDesignSettings } from '../../ui/designManager.js';
import { linear } from '../../core/Transformations.js';
import { initSync } from '../../sync/init.js';
import { initExternalSyncControl } from '../../sync/externalControl.js';
import { voiceRegistry } from '../../voice/VoiceRegistry.js';
import { hydrateVisualFeedback } from '../../visual/visualFeedbackSettings.js';
import { initializeRootParams, hydrateRootAxesFromTrack } from './rootParams.js';

const DEFAULT_DIMENSION_ID = 'EW::I';

function resolveInitialDimensionId(stacks = {}, selection = {}) {
  if (!stacks || typeof stacks !== 'object') {
    return DEFAULT_DIMENSION_ID;
  }

  const stackIds = Object.keys(stacks);
  if (!stackIds.length) {
    return DEFAULT_DIMENSION_ID;
  }

  const chosenStackId =
    selection.activeStackId && stacks[selection.activeStackId]
      ? selection.activeStackId
      : stackIds[0];
  const stack = stacks[chosenStackId];
  const dimensionIds = stack?.dimensions && typeof stack.dimensions === 'object'
    ? Object.keys(stack.dimensions)
    : [];

  if (dimensionIds.includes(DEFAULT_DIMENSION_ID)) {
    return DEFAULT_DIMENSION_ID;
  }

  return dimensionIds[0] || DEFAULT_DIMENSION_ID;
}

function extractDesignFromStacks(stacks = {}, selection = {}) {
  if (!stacks || typeof stacks !== 'object') return null;
  const stackIds = Object.keys(stacks);
  if (!stackIds.length) return null;
  const chosenStackId =
    selection.activeStackId && stacks[selection.activeStackId]
      ? selection.activeStackId
      : stackIds[0];
  const stack = stacks[chosenStackId];
  if (!stack || typeof stack !== 'object' || !stack.dimensions) return null;
  const dimensionIds = Object.keys(stack.dimensions);
  if (!dimensionIds.length) return null;
  const chosenDimensionId =
    selection.activeDimensionId && stack.dimensions[selection.activeDimensionId]
      ? selection.activeDimensionId
      : resolveInitialDimensionId(stacks, selection);
  const dimension = stack.dimensions[chosenDimensionId];
  const design = dimension?.design;
  return design && typeof design === 'object' ? { ...design } : null;
}

function extractDesignMapFromStacks(stacks = {}) {
  if (!stacks || typeof stacks !== 'object') return null;
  const map = {};
  Object.values(stacks).forEach((stack) => {
    if (!stack || typeof stack !== 'object' || !stack.dimensions) return;
    Object.entries(stack.dimensions).forEach(([dimensionId, dimensionState]) => {
      if (!dimensionId || !dimensionState?.design) return;
      map[dimensionId] = { ...dimensionState.design };
    });
  });
  return Object.keys(map).length ? map : null;
}

export function createInitializeBaseFlow({
  voiceId,
  orbiterModeController,
  renderer,
  scene,
  dataManager,
  parameterManager,
  primeCosmicLfoUi,
  hydrateMonitorPanels,
  getAudioEngine,
  setAudioEngine,
  getAudioEngineDisposeBound,
  setAudioEngineDisposeBound,
  isIframe,
  // The DOM element this voice's orbiter theme (--color1/2/3, font) is scoped to. Null
  // for single-orbiter → applyDesignSettings falls back to documentElement (byte-identical).
  themeRoot = null,
  // De-singletonization: this voice's PanelManager instance (no longer a singleton).
  panelManager = null,
  // De-singletonization: this voice's TransportControl instance (no longer a singleton).
  transportControl = null,
  // This voice's event bus, injected into the AudioEngineAdapter so its count-in
  // snapshot mirrors onto the per-voice bus the React Transport subscribes to. Window for single-orbiter.
  eventBus = (typeof window !== 'undefined' ? window : null),
  // This voice's load-progress reporter. Null → a global-mirroring default (legacy
  // single-orbiter overlay); a multi voice injects its own so boots don't thrash the global state.
  loadProgress = null,
}) {
  const reportLoadProgress = loadProgress ?? createLoadProgress();
  return async function initializeBaseFlow({
    worldModeKey,
    worldModeArgs = {},
    trackData,
    entangledWorld = null,
    audioEngineOptions = null,
    skipAudioPreload = false,
    mappingDefaults = null,
    stacksDefaults = null,
    stackSelection = null,
    designDefaults = null,
    reuseAudioEngine = false,
  }) {
    const modeArgs = {
      renderer,
      scene,
      ...worldModeArgs,
    };

    // The embedded editor is handed its session by the host; every other boot reads the one the
    // assembler loaded. Taken BEFORE the mode is set, because activating edit mode emits the session
    // straight back out — and an emit that ran before this voice's choices were in would carry the
    // PREVIOUS track's switches and save them onto the new one.
    let pendingConfig = (isIframe && worldModeKey === 'edit') ? consumePendingOrbiterSession() : null;

    // Which modules answer in the world. Hydrated before the mode is set (which emits) and before the
    // audio engine is assigned (which mounts the visual bridges) — so a module switched off is never
    // built, rather than built and then torn down.
    hydrateVisualFeedback(
      voiceId,
      pendingConfig?.visualFeedback ?? trackData?.orbiter?.sessionState?.visualFeedback ?? null,
    );

    const modeResult = await orbiterModeController.setMode(worldModeKey, modeArgs);

    let pendingDesign = null;
    let hydratedDesignMap = null;

    if (isIframe && worldModeKey === 'edit') {
      if (pendingConfig) {
        if (pendingConfig.stacks && typeof pendingConfig.stacks === 'object') {
          stacksDefaults = cloneStacksState(pendingConfig.stacks);
          hydratedDesignMap = extractDesignMapFromStacks(stacksDefaults);
        }
        if (pendingConfig.selection && typeof pendingConfig.selection === 'object') {
          stackSelection = {
            ...(stackSelection || {}),
            ...pendingConfig.selection,
          };
        }
        pendingDesign = extractDesignFromStacks(
          stacksDefaults,
          stackSelection || pendingConfig.selection || {},
        );
        if (pendingDesign) {
          designDefaults = { ...pendingDesign };
          if (pendingDesign.colorPrimary || pendingDesign.colorSecondary) {
            applyColorsFromTrackData({
              orbiter: {
                orbiterColors: {
                  color1: pendingDesign.colorPrimary,
                  color2: pendingDesign.colorSecondary,
                  color3: pendingDesign.colorC,
                },
              },
            }, themeRoot);
          }
        }
      }
    }

    const resolvedInitialDimensionId = resolveInitialDimensionId(
      stacksDefaults,
      stackSelection || {},
    );

    stackSelection = {
      ...(stackSelection || {}),
      activeDimensionId: resolvedInitialDimensionId,
    };

    if (trackData) {
      if (!reuseAudioEngine) {
        hydrateRootAxesFromTrack(parameterManager, trackData);
        initializeRootParams(parameterManager, trackData);
      }
      if (!pendingDesign && !reuseAudioEngine) {
        applyColorsFromTrackData(trackData, themeRoot);
      }
    }

    const editMode = orbiterModeController?.modes?.edit ?? null;
    if (editMode?.applyExternalState) {
      if (!reuseAudioEngine) {
        editMode.applyExternalState({
          stacks: stacksDefaults,
          selection: stackSelection,
          mappingDefaults,
          designDefaults,
          designByDimension: hydratedDesignMap,
        });
        const designToApply =
          pendingDesign ||
          (editMode.design && typeof editMode.design === 'object' ? editMode.design : null) ||
          designDefaults;
        if (designToApply) {
          applyDesignSettings(designToApply, themeRoot);
        }
      }
    } else if (!reuseAudioEngine) {
      if (designDefaults) {
        applyDesignSettings(designDefaults, themeRoot);
      } else if (pendingDesign) {
        applyDesignSettings(pendingDesign, themeRoot);
      }
    }

    const resolvedWorld =
      entangledWorld ?? trackData?.entangledWorld ?? modeArgs?.trackData?.entangledWorld ?? null;
    primeCosmicLfoUi(resolvedWorld);
    hydrateMonitorPanels(dataManager);
    dataManager.setParameterManager(parameterManager);

    let audioEngine = getAudioEngine();
    let audioEngineDisposeBound = getAudioEngineDisposeBound();
    let engineReady = false;
    const performanceProfile =
      audioEngineOptions?.performanceProfile || worldModeArgs?.audioProfile || null;

    if (reuseAudioEngine && audioEngine) {
      if (performanceProfile && typeof audioEngine.setPerformanceProfile === 'function') {
        audioEngine.setPerformanceProfile(performanceProfile);
      }
      engineReady = true;
    } else {
      if (audioEngine && typeof audioEngine.dispose === 'function') {
        try {
          audioEngine.dispose();
        } catch (disposeError) {
          console.warn('[AudioEngine] Previous engine dispose failed:', disposeError);
        }
      }

      const engineConfigOptions =
        audioEngineOptions || { trackData: null, engineConfig: null, userManager: null };
      if (performanceProfile) {
        engineConfigOptions.performanceProfile = performanceProfile;
      }
      // Bind the adapter to this voice's event bus (count-in mirror) unless the caller
      // already supplied one. Single-orbiter → window default → byte-identical.
      if (engineConfigOptions.eventBus == null) {
        engineConfigOptions.eventBus = eventBus;
      }
      // Audio download counters report through this voice's channel, not the global overlay.
      if (engineConfigOptions.loadProgress == null) {
        engineConfigOptions.loadProgress = reportLoadProgress;
      }
      audioEngine = new AudioEngineAdapter(engineConfigOptions);

      if (!audioEngineDisposeBound && typeof window !== 'undefined') {
        window.addEventListener(
          'beforeunload',
          () => {
            const currentEngine = getAudioEngine?.() || audioEngine;
            if (currentEngine && typeof currentEngine.dispose === 'function') {
              currentEngine.dispose();
            }
          },
          { once: true },
        );
        audioEngineDisposeBound = true;
      }

      try {
        await audioEngine.initialize();
        if (!skipAudioPreload) {
          await audioEngine.preload?.();
        }
        engineReady = true;

        // Two-phase: the voice was registered at boot with its sync fields; fill in the
        // audio engine now that its async init has completed, so registry readers resolve it.
        // Write to THIS voice (voiceId), not getActive() — a secondary voice booting while
        // the primary is focused must not land its engine on the primary. Single-orbiter: voiceId =
        // PRIMARY = the only/active voice, so this is identical (defensive fallback to the active id).
        // The registry's assignment method is also the observation seam: engine-lifetime
        // consumers (the granular visual bridge) fire off it, not off register time (the
        // engine can even be created DURING the init above, while persisted effects config
        // is applied).
        const targetId = voiceId && voiceRegistry.has(voiceId) ? voiceId : voiceRegistry.activeId;
        if (targetId) {
          voiceRegistry.assignAudioEngine(targetId, audioEngine);
        }
        initSync(audioEngine, trackData, parameterManager);
        initExternalSyncControl({ parameterManager, audioEngine });
      } catch (engineError) {
        const level = skipAudioPreload ? 'info' : 'error';
        console[level](`[AudioEngine][${worldModeKey}] Initialization failed:`, engineError);
      }
    }

    reportLoadProgress.setStep('trackLoaded', true);
    reportLoadProgress.setStep('orbiterLoaded', engineReady || skipAudioPreload || reuseAudioEngine);
    // World visuals were built by the mode activation above (textured or plain sphere) — the
    // step tracks that, not the presence of a GLB URL (worlds are never loaded as GLB).
    reportLoadProgress.setStep('modelLoaded', modeResult !== false);

    if (!reuseAudioEngine || !getAudioEngine()) {
      setupInteractions(dataManager, audioEngine, parameterManager, orbiterModeController, panelManager, transportControl);
      // The React PlaybackPanel renders its own waveform chrome — no legacy toolbar drawer.
    }

    if (!reuseAudioEngine || !getAudioEngine()) {
      setAudioEngine(audioEngine);
      setAudioEngineDisposeBound(audioEngineDisposeBound);
    }

    return {
      worldLoaded: modeResult !== false,
      engineReady,
    };
  };
}
