/**
 * @file src/ui/react/resolveEngineSingletons.ts
 * @description The ONE place the React shell touches the imperative singletons.
 *
 * strategy §3: `EngineContext` is built from the existing singletons "at the
 * mount boundary." This module IS that boundary — it gathers `parameterManager`
 * (the ParameterManager) and `MIDIControllerInstance` and hands them to
 * `createEngineContext` as the DI'd `EngineSingletons`. Component code never
 * imports this; only `mountOrbitersUI` does, once.
 *
 * The ParameterManager is passed IN by the caller (each voice owns its own —
 * no `window.*` needed for it). The MIDIController is read off
 * `window.MIDIControllerInstance` (set in MIDIController.js:1671) because it is
 * created lazily on first MIDI activation and may not exist at mount; we tolerate
 * its absence (`midi.available` becomes false) per the EngineMidi contract.
 */

import { createEngineContext } from '../../react/engine/createEngineContext';
import { PANEL_IDS } from '../../core/PanelManager.js';
import { getCurrentOrbiter } from '../Interaction.js';
import { syncCoordinator } from '../../sync/SyncCoordinator.js';
import { SensorController } from '../../input/SensorsController.js';
import { WebRTCManager } from '../../api/WebRTCManager.js';
import { voiceRegistry } from '../../voice/VoiceRegistry.js';
import { deckFor, syncEnabledDeckCount } from '../../voice/Deck.js';
import { buildInfoTags } from '../../api/dataManager/placeholders.js';
import { getT } from '../../i18n/index.js';
import type { EngineContextValue, PanelOption } from '../../react/engine/engineTypes';
import type { EngineResolutionReport } from './engineResolution';
import type {
  RawParameterManager,
  RawMidiController,
  RawDimensionProvider,
  RawPanelManager,
  RawTransportController,
  RawSyncCoordinator,
  RawCosmicLfo,
  RawSensors,
  RawWebRTC,
  RawAudioEngine,
  RawInfoTags,
} from '../../react/engine/createEngineContext';

/** Read the global MIDIController if MIDI has been activated; null otherwise. */
function readMidiController(): RawMidiController | null {
  const instance = (globalThis as { MIDIControllerInstance?: unknown }).MIDIControllerInstance;
  if (instance == null) return null;
  const candidate = instance as Partial<RawMidiController>;
  // Only treat it as a usable target registry if it exposes the methods the
  // `midi` facade calls; otherwise the shell renders MIDI-less (available=false).
  if (
    typeof candidate.registerMidiLearnTarget === 'function' &&
    typeof candidate.unregisterMidiLearnTarget === 'function'
  ) {
    return instance as RawMidiController;
  }
  return null;
}

/**
 * The voice this UI is bound to. Single-orbiter / focused chrome passes no voiceId → the active voice
 * (byte-identical). A multi-orbiter per-tile UI passes its own voiceId so the tile reads ITS OWN
 * transport / dimensions / cosmic LFO / audio — not whichever voice is currently focused.
 */
type VoiceProvider = () => ReturnType<typeof voiceRegistry.getActive>;

/**
 * Read the dimension owner (OrbitersEditMode) off THIS voice's world-mode controller
 * (`voice.worldMode.modes.edit`). Present only in edit mode; null otherwise → `dims.list()` is empty
 * and the selector region renders nothing.
 */
function readDimensionProvider(getVoice: VoiceProvider): RawDimensionProvider | null {
  const worldMode = getVoice()?.worldMode as
    | { modes?: { edit?: unknown } }
    | undefined;
  const edit = worldMode?.modes?.edit as Partial<RawDimensionProvider> | undefined;
  if (
    edit &&
    typeof edit.getAvailableDimensions === 'function' &&
    typeof edit.getActiveDimensionId === 'function' &&
    typeof edit.setActiveDimension === 'function'
  ) {
    return edit as RawDimensionProvider;
  }
  return null;
}

/**
 * The interaction panels the React menu offers, mapped from index.html's
 * interaction-menu items (`data-action`) to the PanelManager panel ids. This is
 * the same set the legacy `.interaction-button` dropdown drives; ordering mirrors
 * index.html (Sensors / Cosmic LFO / Playback / Jamming).
 */
function readPanelOptions(): PanelOption[] {
  // Labels from i18n (resolved at mount, after initI18n) so the panel switcher localizes.
  const t = getT();
  return [
    { id: PANEL_IDS.SENSORS, action: 'sensors', label: t('panels.sensors') },
    { id: PANEL_IDS.COSMIC_LFO, action: 'cosmic-lfo', label: t('panels.cosmicLfo') },
    { id: PANEL_IDS.PLAYBACK, action: 'playback', label: t('panels.playback') },
    { id: PANEL_IDS.JAMMING, action: 'jamming', label: t('panels.jamming') },
  ];
}

/**
 * The PanelManager singleton (module-level, like `parameterManager`). It exposes
 * `activatePanel`/`getActivePanel` directly; treat it as the raw panel manager.
 */
function readPanelManager(getVoice: VoiceProvider): RawPanelManager | null {
  const candidate = getVoice()?.panelManager as Partial<RawPanelManager> | undefined;
  if (
    candidate &&
    typeof candidate.activatePanel === 'function' &&
    typeof candidate.getActivePanel === 'function'
  ) {
    return candidate as RawPanelManager;
  }
  return null;
}

/**
 * The active voice's TransportControl. It holds the live orbiter ref (set in `init(orbiter)` from
 * Interaction.js on every orbiter mount) and self-resolves the active orbiter, so a stable
 * reference is correct across session swaps. Returned when it exposes the play/stop/toggle + state
 * methods the `transport` facade calls; else null (`transport.available` false).
 */
function readTransportController(getVoice: VoiceProvider): RawTransportController | null {
  const candidate = getVoice()?.transportControl as
    | Partial<RawTransportController>
    | undefined;
  if (
    candidate &&
    typeof candidate.getState === 'function' &&
    typeof candidate.isPlaying === 'function' &&
    typeof candidate.play === 'function' &&
    typeof candidate.pause === 'function' &&
    typeof candidate.stop === 'function' &&
    typeof candidate.toggle === 'function'
  ) {
    return candidate as RawTransportController;
  }
  return null;
}

/**
 * The SyncCoordinator singleton (`syncCoordinator`, a module export). Stable across session swaps
 * (it owns the shared timeline). Returned when it exposes the enable/disable + isEnabled the `sync`
 * facade reads; else null (`sync.available` false).
 */
function readSyncCoordinator(): RawSyncCoordinator | null {
  const candidate = syncCoordinator as Partial<RawSyncCoordinator> | undefined;
  if (
    candidate &&
    typeof candidate.enable === 'function' &&
    typeof candidate.disable === 'function' &&
    typeof candidate.isEnabled === 'boolean'
  ) {
    return syncCoordinator as unknown as RawSyncCoordinator;
  }
  return null;
}

/**
 * Resolve a per-axis CosmicLFO off the active voice's cosmic LFO manager. Returned only when it
 * exposes the methods the `cosmic` facade calls; else null.
 */
function readCosmicLfo(axis: string, getVoice: VoiceProvider): RawCosmicLfo | null {
  const manager = getVoice()?.cosmicLFOManager as
    | Record<string, unknown>
    | undefined;
  const candidate = manager?.[axis] as Partial<RawCosmicLfo> | undefined;
  if (
    candidate &&
    typeof candidate.isCosmicEnabled === 'function' &&
    typeof candidate.start === 'function' &&
    typeof candidate.stop === 'function' &&
    typeof candidate.getFrequencySource === 'function' &&
    typeof candidate.setFrequencySource === 'function' &&
    typeof candidate.getWaveform === 'function' &&
    typeof candidate.setWaveform === 'function'
  ) {
    return candidate as RawCosmicLfo;
  }
  return null;
}

/**
 * Resolve the singleton SensorController if it has been created (PanelManager creates it on first
 * Sensors-panel activation). Returned only when it exposes the methods the `sensors` facade calls;
 * else null (`sensors.available()` false). Uses the static accessor — the controller imports no
 * Main.js/React, so a direct import is cycle-safe (matches the TransportControl reader).
 */
function readSensorsController(): RawSensors | null {
  const candidate = SensorController.getExistingInstance() as Partial<RawSensors> | null;
  if (
    candidate &&
    typeof candidate.isAxisEnabled === 'function' &&
    typeof candidate.setAxisActive === 'function' &&
    typeof candidate.calibrateDevice === 'function'
  ) {
    return candidate as RawSensors;
  }
  return null;
}

/**
 * Resolve the singleton WebRTCManager if it has been created (PanelManager builds it with the
 * SensorController on first Sensors-panel use; null before that, and on mobile). Returned only
 * when it exposes the connect action + the live-connection flag the `connection` facade reads.
 */
function readWebRtc(): RawWebRTC | null {
  const candidate = WebRTCManager.getExistingInstance() as Partial<RawWebRTC> | null;
  if (
    candidate &&
    typeof candidate.handleConnectionButtonClick === 'function' &&
    typeof candidate.connectToSharedLocalSource === 'function' &&
    typeof candidate.requestDirectConnection === 'function' &&
    typeof candidate.notifyPairingClosed === 'function' &&
    typeof candidate.isConnected === 'boolean'
  ) {
    return candidate as RawWebRTC;
  }
  return null;
}

/**
 * Resolve the active voice's AudioEngineAdapter if audio has initialized (filled onto the voice
 * after its async init). Returned only when it exposes the per-dimension monitor snapshot the
 * `monitor` facade reads; null before audio init → `monitor.available()` is false.
 */
function readAudioEngine(getVoice: VoiceProvider): RawAudioEngine | null {
  const candidate = getVoice()?.audioEngine as Partial<RawAudioEngine> | undefined;
  if (candidate && typeof candidate.getMonitorSnapshot === 'function') {
    return candidate as RawAudioEngine;
  }
  return null;
}

/**
 * Build the static info-tag rows (track / entangled-world / orbiter) from the loaded track data.
 * Reads the focused orbiter's `trackData` ({ track, orbiter, entangledWorld }) through `buildInfoTags` — the
 * row form of the same builders the legacy grid uses. Null before a track is loaded. Recomputed on
 * every call so the orbiter view's axis-module rows reflect the active dimension.
 */
function readInfoTags(getVoice: VoiceProvider, scoped: boolean): RawInfoTags | null {
  // Read the voice's combined config off its audio engine (which carries `trackData`) —
  // not the removed Constants.TRACK_DATA single-current global. A per-tile UI (scoped) reads ITS OWN
  // voice's audio engine; single-orbiter/focused chrome keeps the legacy `getCurrentOrbiter()` path
  // (the focused orbiter) for byte-identical behaviour.
  const source = scoped
    ? (getVoice()?.audioEngine as { trackData?: unknown } | null | undefined)
    : (getCurrentOrbiter() as { trackData?: unknown } | null);
  const data = source?.trackData as
    | { track?: unknown; orbiter?: unknown; entangledWorld?: unknown }
    | null
    | undefined;
  if (!data) return null;
  return buildInfoTags(data.track, data.orbiter, data.entangledWorld) as RawInfoTags;
}

/** The engine boundary plus the mount-time resolution report. */
export interface ResolvedEngine {
  context: EngineContextValue;
  report: EngineResolutionReport;
}

/**
 * Build the typed engine boundary from the live singletons, plus a resolution
 * report naming which surfaces resolved live at mount.
 * @param parameterManager the mounting voice's own ParameterManager.
 * @param voiceId bind the per-voice readers (transport/dims/cosmic/audio/info) to THIS voice. Omit
 *   (single-orbiter / focused chrome) → the active voice, byte-identical to before.
 */
export function resolveEngineContext(
  parameterManager: RawParameterManager,
  voiceId?: string,
): ResolvedEngine {
  // The voice this UI reads from: a specific roster voice (per-tile), else the focused voice.
  const getVoice: VoiceProvider = () =>
    voiceId != null ? voiceRegistry.get(voiceId) ?? null : voiceRegistry.getActive();
  const scoped = voiceId != null;

  // The per-voice event channel: engine surfaces (panel-change, …) subscribe to THIS voice's
  // EventTarget so a change in one tile doesn't notify the others. Single-orbiter's eventBus is
  // `window` → byte-identical. Falls back to `window` when a voice didn't supply one.
  const eventBus: EventTarget =
    (getVoice()?.eventBus as EventTarget | undefined) ??
    (typeof window !== 'undefined' ? (window as unknown as EventTarget) : new EventTarget());

  // Snapshot readers — resolved once, at the mount boundary.
  const dimensionProvider = readDimensionProvider(getVoice);
  const panelManager = readPanelManager(getVoice);
  const transportController = readTransportController(getVoice);
  const syncCoordinator = readSyncCoordinator();

  // Per-voice SYNC ENABLE — MULTI ONLY. Each tile's sync button toggles ITS voice's
  // `syncEnabled` flag, not the shared coordinator directly, so pressing sync in one tile no longer
  // toggles every tile. The shared SyncCoordinator / clock / timeline are UNTOUCHED (this still works):
  // the aggregate (`voiceSyncEnable`) only drives the coordinator's existing idempotent enable()/
  // disable() (on iff ≥1 voice wants sync). Single-orbiter (no voiceId) builds NO per-voice state and
  // takes the direct coordinator path below → byte-identical (incl. failed-enable → isEnabled stays
  // false). peerCount + status subscription stay coordinator-level; each tile re-reads its OWN flag.
  const syncEnableState =
    scoped && voiceId != null && syncCoordinator != null
      ? {
          isEnabled: () => deckFor(voiceId)?.syncEnabled === true,
          setEnabled: (enabled: boolean) => deckFor(voiceId)?.setSyncEnabled(enabled),
          // In-tab session size — how many sibling voices in THIS tab want sync (the SYNC
          // badge counts these in-tab partners, so two synced orbiters in one tab show "2").
          syncedCount: () => syncEnabledDeckCount(),
        }
      : null;

  const context = createEngineContext({
    parameterManager,
    // The per-voice event channel engine surfaces subscribe to (panel-change, …).
    eventBus,
    // The voice this context is bound to (null → single-orbiter), so single-focus surfaces
    // (the capture/record dialog) know which tile they belong to.
    voiceId: voiceId ?? null,
    // LAZY: MIDIController is created on first MIDI activation and may not exist at
    // mount. Pass the reader so `midi.available` flips true (and registrations start
    // working) once MIDI comes up, rather than being frozen false at mount.
    midiControllerProvider: readMidiController,
    dimensionProvider,
    panelManager,
    panelOptions: readPanelOptions(),
    transportController,
    syncCoordinator,
    syncEnableState,
    cosmicLfoProvider: (axis) => readCosmicLfo(axis, getVoice),
    // LAZY: SensorController is created on first Sensors-panel use (PanelManager) and may not
    // exist at mount. Pass the reader so `sensors.available()` flips true once it comes up,
    // rather than being frozen false at mount (same shape as the cosmic LFO provider).
    sensorsProvider: readSensorsController,
    // LAZY: WebRTCManager is created alongside SensorController on first Sensors-panel use.
    webRtcProvider: readWebRtc,
    // LAZY: AudioEngineAdapter is created on audio init and may not exist at mount. Pass the reader
    // so `monitor.available()` flips true once audio comes up (same shape as the other lazy providers).
    audioEngineProvider: () => readAudioEngine(getVoice),
    // Static info rows (track/world/orbiter) from this voice's `trackData`. Read lazily so the panel
    // reflects the loaded data + active dimension whenever it's opened.
    infoTagsProvider: () => readInfoTags(getVoice, scoped),
  });

  // Resolution report. The lazy providers (midi/cosmic/sensors/webRtc/audioEngine/info)
  // are probed once here purely for the report; they are STILL passed as re-resolving
  // functions above, so a false here never disables later lazy activation. Every reader
  // is a pure shape-guard over a global/module singleton, so the extra probe call is
  // side-effect-free.
  const report: EngineResolutionReport = {
    midi: readMidiController() != null,
    dims: dimensionProvider != null,
    panels: panelManager != null,
    transport: transportController != null,
    sync: syncCoordinator != null,
    cosmic: readCosmicLfo('x', getVoice) != null,
    sensors: readSensorsController() != null,
    webRtc: readWebRtc() != null,
    audioEngine: readAudioEngine(getVoice) != null,
    info: readInfoTags(getVoice, scoped) != null,
  };

  return { context, report };
}
