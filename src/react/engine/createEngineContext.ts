/**
 * @file src/react/engine/createEngineContext.ts
 * @description Builds the typed {@link EngineContextValue} from the engine
 * singletons (strategy §3). THIS is the one bridge between the imperative core
 * and the React boundary — the only place allowed to know the singletons' raw
 * shapes. React component code consumes the returned read-models, never this.
 *
 * Dependency-injected: the manager + MIDI controller are passed IN (see
 * `resolveEngineSingletons.ts` for the real wiring at the mount site), so this is
 * unit-testable with fakes and free of `Main.js` / `window.*` imports.
 */

import type {
  EngineContextValue,
  EngineParams,
  EngineMidi,
  EngineDims,
  EnginePanels,
  EngineWaveform,
  EngineWaveformData,
  WaveformLoopRange,
  EngineTransport,
  EngineSync,
  EngineCosmic,
  EngineSensors,
  EngineConnection,
  PairingState,
  PairingSource,
  EngineMonitor,
  MonitorSnapshot,
  EngineInfo,
  InfoTagRow,
  TransportState,
  TransportCountIn,
  DimensionOption,
  PanelOption,
  ParamController,
  ScopedMidiBinding,
  WriteOptions,
} from './engineTypes';
import { voiceRegistry } from '../../voice/VoiceRegistry.js';
import { BROADCAST_ACTIONS, broadcastAction } from '../../multi/multiFocusBroadcast.js';
import { deckFor } from '../../voice/Deck.js';

/** The slice of ParameterManager the `params` facade calls. */
export interface RawParameterManager {
  subscribe(controller: ParamController, name: string, priority?: number, dimensionId?: string | null): void;
  unsubscribe(controller: ParamController, name: string): void;
  setDimensionValue(name: string, dimensionId: string, value: number, source: unknown, priority: number, options: WriteOptions): void;
  setRawValue(name: string, value: number, source: unknown, priority: number, options: WriteOptions): void;
  getDimensionValue(name: string, dimensionId?: string | null): number | null | undefined;
  /** The live normalized (0–1) value per dimension — the real parameter state (incl. at load). This
   *  is the SAME getter the audio engine uses to drive the racks, so mapping it gives the Engine
   *  Monitor the true value rather than the rack's stale `controlNormalized`. */
  getNormalizedValue(name: string, dimensionId?: string | null): number | null | undefined;
  getParameter(name: string): { isMultidimensional?: boolean; activeDimensionId?: string | null } | undefined;
  isParameterLocked(name: string): boolean;
  isParameterDimensionLocked(name: string, dimensionId: string): boolean;
  setActiveDimension(dimensionId: string): void;
}

/** The slice of MIDIController the `midi` facade calls. */
export interface RawMidiController {
  registerMidiLearnTarget(binding: ScopedMidiBinding): void;
  unregisterMidiLearnTarget(id: string): void;
  /** Tear down MIDI-learn mode + its overlays. Optional so an older controller snapshot that
   *  predates it doesn't fail the `readMidiController` shape guard. */
  exitMidiLearnMode?(): void;
  /** The active orbiter id (or null) — for the load-saved-mappings dialog. Optional for the same
   *  snapshot-compatibility reason as above. */
  getActiveOrbiterId?(): string | null;
  /** The collection whose shell MIDI targets are registered (or null outside the collection
   *  studio) — scopes the dialog's shell-mapping transfers. Optional, same reason. */
  getActiveCollectionId?(): string | null;
  /** Re-fetch the active orbiter's scoped mappings and re-apply them live. Optional. */
  reloadPersistedMappings?(): Promise<void>;
}

/**
 * The slice of the dimension owner (OrbitersEditMode) the `dims` facade calls.
 * Provided only in modes that have a dimension catalog (edit); absent otherwise,
 * in which case `dims.list()` is empty and the selector region renders nothing.
 * `setActive` runs the full hydration (not just PM's flat `setActiveDimension`),
 * so React and the legacy chrome stay in sync.
 */
export interface RawDimensionProvider {
  getAvailableDimensions(): DimensionOption[];
  getActiveDimensionId(): string | null;
  setActiveDimension(dimensionId: string): void;
}

/**
 * The slice of PanelManager the `panels` facade calls. PanelManager owns the
 * interaction-mode side effects (sensors/MIDI/cosmic onEnter/onExit). We wrap only
 * activate/active here; change notifications come from the `orbiters:panel-change`
 * window event PanelManager already dispatches (so React stays in sync with the
 * legacy chrome without a new emitter).
 */
export interface RawPanelManager {
  activatePanel(panelId: string): void;
  getActivePanel(): string | null;
}

/**
 * The slice of TransportControl the `transport` facade calls (play/pause/stop/toggle
 * + state reads). TransportControl has no subscribe of its own — it
 * broadcasts `orbiters:transport-state-change` on `window`, which the facade's
 * `subscribe` wraps. The async methods are fire-and-forget here (the facade ignores
 * the returned promise). null when no orbiter/engine is wired (tests) →
 * `transport.available` is false.
 */
export interface RawTransportController {
  getState(): TransportState;
  isPlaying(): boolean;
  play(): void | Promise<void>;
  pause(): void | Promise<void>;
  stop(): void | Promise<void>;
  toggle(): void | Promise<void>;
}

/**
 * The slice of the singleton `SyncCoordinator` the `sync` facade calls. `isEnabled` is an accessor;
 * `enable()` may no-op (and emit no status change) if the transport adapter fails to connect, so the
 * facade re-reads `isEnabled` on the conductor's `onStatusChange` subscription. null in tests /
 * pre-init → `sync.available` false.
 */
export interface RawSyncCoordinator {
  readonly isEnabled: boolean;
  /** Other participants in the sync session, NOT counting self (adapter peer set). */
  readonly peerCount?: number;
  /** LIVE, room-scoped present-peer count for the SYNC badge (0 in-tab). */
  readonly sessionPeerCount?: number;
  /** Σ of other tabs' announced synced-voice counts — the badge's cross-tab source (room-scoped, 0
   *  in-tab). Counts voices, so a remote multi-orbiter tab contributes its N, not 1 connection. */
  readonly sessionRemoteVoiceCount?: number;
  enable(): void;
  disable(): void;
  /** Session-level sync-status subscription (replaces the `orbiters:sync-status-change`
   *  window event). Returns an unsubscribe fn. Optional so a stub coordinator without it is tolerated. */
  onStatusChange?(fn: (detail: unknown) => void): () => void;
}

/**
 * The slice of a per-axis CosmicLFO the `cosmic` facade calls. Enable/source/waveform
 * are the non-PM cosmic controls (freq + amplitude ride their PM params). null when no LFO is
 * wired for that axis → `cosmic.available(axis)` is false.
 */
export interface RawCosmicLfo {
  isCosmicEnabled(): boolean;
  start(): void;
  stop(): void;
  getFrequencySource(): string;
  setFrequencySource(key: string): void;
  getWaveform(): string;
  setWaveform(key: string): void;
  triggerKick?(label: string): void;
}

/**
 * The slice of the singleton `SensorController` the `sensors` facade calls. Toggle state
 * is per-axis-per-dimension: `isAxisEnabled(axis)` reads the ACTIVE dimension's persisted state
 * (order-independent of the dimension-change sync), `setAxisActive(axis, on)` drives the enable +
 * persistence + device-motion listeners, `calibrateDevice()` re-zeros orientation. Resolved
 * through a provider (lazy creation) → null until the controller is up → `sensors` unavailable.
 */
export interface RawSensors {
  isAxisEnabled(axis: string): boolean;
  setAxisActive(axis: string, isActive: boolean): void;
  calibrateDevice(): void;
}

/**
 * The slice of the singleton `WebRTCManager` the `connection` facade calls. `isConnected`
 * is an accessor that dispatches `orbiters:connection-changed` on change; `handleConnectionButtonClick`
 * opens the pairing/QR modal (the legacy connect-button action). null before init / on mobile.
 */
export interface RawWebRTC {
  readonly isConnected: boolean;
  handleConnectionButtonClick(): void;
  /** Choice view → consume an already-connected shared local source. */
  connectToSharedLocalSource(source: PairingSource): void;
  /** Choice view → "connect a new device": resume direct signalling + switch to the QR view. */
  requestDirectConnection(reconnect: boolean): void;
  /** The React dialog was dismissed: clear the manager's modal re-entrancy flag. */
  notifyPairingClosed(): void;
}

/** The slice of AudioEngineAdapter the `monitor` + `transport` facades call (the active voice's engine). */
export interface RawAudioEngine {
  getMonitorSnapshot(getNormalized?: (dimensionId: string, axis: string) => number | null): MonitorSnapshot;
  /** The effective loop state for the UI (loop-on by default until the first play applies
   *  it), so the loop control reflects the real state from interface load. */
  isLoopActive?(): boolean;
  /** The current quantized-start count-in snapshot (so a freshly-mounted Transport reads the
   *  armed state even if it mounted mid-wait). Inactive (or absent) → no count-in. */
  getCountInState?(): TransportCountIn;
  // The lean waveform DATA reads the kit timeline binds to (all already on AudioEngineAdapter).
  /** The current track's waveform JSON url (audiowaveform v2), resolved from trackData. */
  getWaveformUrl?(): string | null;
  /** Track duration in milliseconds. */
  getDurationMs?(): number;
  /** Live playhead position in milliseconds. */
  getCurrentPositionMs?(): number;
  /** Seek the engine to `ms`. */
  seekToMilliseconds?(ms: number): void | Promise<void>;
  /** The active loop range in MILLISECONDS (player.js' native unit), or null. The kit works in
   *  seconds — `waveformData.getLoopRangeSec()` converts; do not read this raw as seconds. */
  getLoopRange?(): { start: number; end: number } | null;
  /** Set (and engage) the loop range in milliseconds. */
  setLoopRange?(startMs: number, endMs: number, opts?: { active?: boolean }): void;
  /** Clear the loop. */
  clearLoop?(): void;
  /** Engage / disengage the loop without changing its range. */
  setLoopEnabled?(enabled: boolean): void;
  /** A loop range is set (even if not engaged). */
  hasLoopRange?(): boolean;
  /** Whether a loop is currently engaged. */
  isLooping?(): boolean;
  /** This voice's DECK — its snapshot carries the native track BPM the loop grid uses, and this
   *  voice's own effective meter. Also exposes `onChange` directly (used for live meter updates). */
  getGridMarkerState?(): {
    getSnapshot?(): { trackBpm?: number | null; meter?: string | null };
    meter?: string | null;
    onChange?(listener: () => void): () => void;
  } | null;
  /** The beat-grid origin (downbeat) in seconds. */
  getGridMarkerTimeSec?(): number;
  /** Set the beat-grid origin (seconds). */
  setGridMarkerTimeSec?(sec: number): void;
}

/** The static info-tag rows the `info` facade exposes, keyed by React info-menu value. Resolved
 *  from the focused orbiter`s `trackData` via `buildInfoTags` at the mount boundary. */
export type RawInfoTags = Record<string, InfoTagRow[]>;

export interface EngineSingletons {
  /** ParameterManager (`parameterManager`). */
  parameterManager: RawParameterManager;
  /**
   * The per-voice event channel engine surfaces subscribe to (panel-change, …). A multi tile
   * passes its own EventTarget so changes don't cross-talk; omit → `window` (single-orbiter, identical).
   */
  eventBus?: EventTarget | null;
  /** The voice this context is bound to (null for single-orbiter). */
  voiceId?: string | null;
  /** Per-voice sync ENABLE backend. Null → direct single-orbiter coordinator path. */
  syncEnableState?: {
    isEnabled: () => boolean;
    setEnabled: (enabled: boolean) => void;
    /** How many sibling voices in this tab want sync (in-tab session size). */
    syncedCount?: () => number;
  } | null;
  /**
   * MIDIController (`MIDIControllerInstance`); null when MIDI is unsupported.
   * A one-shot SNAPSHOT — fine for tests / when MIDI is already up. For the live
   * shell prefer `midiControllerProvider`, since the controller is created lazily
   * on first MIDI activation and may not exist yet at mount.
   */
  midiController?: RawMidiController | null;
  /**
   * Lazy resolver for the MIDIController, called on EVERY `midi` access. Lets
   * `midi.available` flip true (and registrations start working) once MIDI is
   * activated AFTER the shell mounted, instead of being frozen at mount time.
   * Takes precedence over `midiController` when provided.
   */
  midiControllerProvider?: () => RawMidiController | null;
  /** OrbitersEditMode (the dimension owner); null outside edit mode. */
  dimensionProvider?: RawDimensionProvider | null;
  /** PanelManager (the interaction-mode owner); null before it initializes. */
  panelManager?: RawPanelManager | null;
  /** The interaction panels to expose (id+action+label); empty when unwired. */
  panelOptions?: PanelOption[];
  /** TransportControl (`transportControl`); null when no engine/orbiter is wired
   *  (e.g. tests) → `transport.available` is false. */
  transportController?: RawTransportController | null;
  /** SyncCoordinator (`syncCoordinator`, a module singleton); null in tests → `sync.available` false. */
  syncCoordinator?: RawSyncCoordinator | null;
  /** Per-axis CosmicLFO resolver (the active voice's `cosmicLFOManager[axis]`), called on every
   *  access so it tolerates the LFO not existing yet. Returns null when no LFO is wired for the axis
   *  → `cosmic.available(axis)` is false. */
  cosmicLfoProvider?: ((axis: string) => RawCosmicLfo | null) | null;
  /** Lazy resolver for the singleton SensorController, called on EVERY `sensors` access (it's
   *  created lazily — PanelManager builds it on first Sensors-panel use — so a mount-time snapshot
   *  could be frozen null). Returns null until it's up → `sensors.available()` is false. */
  sensorsProvider?: (() => RawSensors | null) | null;
  /** Lazy resolver for the singleton WebRTCManager (desktop), called on EVERY `connection` access
   *  (created lazily with SensorController on first Sensors-panel use). Returns null until up / on
   *  mobile → `connection.available()` is false. */
  webRtcProvider?: (() => RawWebRTC | null) | null;
  /** Lazy resolver for the AudioEngineAdapter (the active voice's engine), called on EVERY `monitor`
   *  access (the engine is built after audio init, so a mount-time snapshot could be frozen null).
   *  Returns null until up → `monitor.available()` is false. */
  audioEngineProvider?: (() => RawAudioEngine | null) | null;
  /** Resolver for the static info-tag rows (track/world/orbiter), called on every `info.getTags`
   *  access so it reflects the loaded track data + active dimension. Returns null/{} before load. */
  infoTagsProvider?: (() => RawInfoTags | null) | null;
}

export interface RawEngineCommands {
  params: EngineParams;
  dims: EngineDims;
  panels: EnginePanels;
  waveform: EngineWaveform;
  transport: EngineTransport;
  cosmic: EngineCosmic;
  sync: EngineSync;
  /** Deck-owned per-player settings the multi-focus gang may replay (launch grid). */
  deck: { setLaunchGridBars(bars: number): void };
}

/**
 * The DOM event the dimension owner dispatches on every active-dimension change
 * (from React OR the legacy chrome). The `dims.subscribe` listener keys on it so
 * the React selector re-reads `active()` whenever anything switches dimension.
 */
const DIMENSION_CHANGED_EVENT = 'orbiters:dimension-changed';

/**
 * The window event PanelManager dispatches on every active-panel change (from
 * React OR the legacy chrome). The `panels.subscribe` listener keys on it so the
 * React interaction menu re-reads `active()` whenever anything switches panel.
 */
const PANEL_CHANGE_EVENT = 'orbiters:panel-change';

/**
 * The window event TransportControl dispatches on every state change (from React OR
 * the legacy chrome). `transport.subscribe` keys on it so React reflects play/pause/stop
 * regardless of what drove the change (button, MIDI, keyboard, playback-end).
 */
const TRANSPORT_STATE_CHANGE_EVENT = 'orbiters:transport-state-change';
// The quantized-start count-in window event (emitted by AudioEngineAdapter when it schedules
// the delayed start, and on fire/cancel). Carries a `TransportCountIn` in `detail`.
const QUANTIZE_COUNTIN_EVENT = 'orbiters:quantize-countin';

/**
 * The window event CosmicLFO dispatches on a non-PM cosmic state change (enable / source /
 * waveform). `cosmic.subscribe` keys on it (+ the dimension-change event) so React re-reads.
 */
const COSMIC_CHANGED_EVENT = 'orbiters:cosmic-changed';

/**
 * The document event broadcast on every loop-ENGAGED change (`detail.enabled`), by both the
 * transport bar's loop toggle (`waveform.setLoopActive`) and the kit Playback panel
 * (`useLoopControls`). `waveform.subscribeLoopActive` keys on it so the two surfaces stay linked
 * to the same engine loop regardless of which drove the change or when each mounted.
 */
const LOOP_TOGGLE_EVENT = 'ui:loop-toggle';

/**
 * The document event SensorController dispatches on every toggle change (from React, a remote
 * peer, or the legacy chrome). `sensors.subscribe` keys on it (+ the dimension-change event) so
 * the React sensor toggles re-read regardless of what drove the change.
 */
const SENSOR_CHANGED_EVENT = 'sensorToggleChanged';

/** The sensor axes the `sensors` facade exposes (x/y/z; 'distance' is not a UI toggle here). */
const SENSOR_AXES = new Set(['x', 'y', 'z']);

/**
 * The document event WebRTCManager dispatches whenever its live-connection state flips (its
 * `isConnected` accessor). `connection.subscribe` keys on it so the React connect button reflects
 * connect/disconnect regardless of what drove it (data channel, ICE failure, the modal).
 */
const CONNECTION_CHANGED_EVENT = 'orbiters:connection-changed';

/** The document event WebRTCManager dispatches to drive the React pairing dialog (Tier-1 migration):
 *  `{ open, view, reconnect, pairingInfo, sources }`. `connection.pairing.subscribe` keys on it. */
const PAIRING_EVENT = 'orbiters:sensor-pairing';

/** The window event DataManager dispatches when the loaded track/orbiter/world config changes
 *  (`dataManager:configUpdated`). The `info` facade keys on it so the static Track/World/Orbiter
 *  rows refresh when a new track loads mid-session, not just on a dimension switch. */
const CONFIG_UPDATED_EVENT = 'dataManager:configUpdated';

/** The axes the `monitor` facade subscribes to on ParameterManager — the same x/y/z that drive the
 *  racks, so a monitor listener fires whenever a rack value moves (knob, MIDI, cosmic, sensor). */
const MONITOR_AXES = ['x', 'y', 'z'] as const;
/** Low priority for the monitor's read-only PM subscription (it never writes / claims). */
const MONITOR_SUBSCRIBE_PRIORITY = 100;
/** Empty snapshot when the audio engine isn't wired yet (pre-init, tests). */
const EMPTY_MONITOR_SNAPSHOT: MonitorSnapshot = { activeDimensionId: null, dimensions: [] };

/**
 * Fire-and-forget a transport action: the React click handlers don't await, and a
 * misbehaving controller whose action rejects must NOT leak an unhandled rejection
 * (TransportControl already try/catches internally, but the boundary stays defensive).
 * Tolerates a sync (void) return too.
 */
function fireAndForget(result: void | Promise<void> | undefined): void {
  if (result && typeof (result as Promise<void>).catch === 'function') {
    (result as Promise<void>).catch(() => {});
  }
}

/**
 * Axis params probed (in order) to recover the active dimension when no dimension
 * provider is wired. The XYZ axes share a single active dimension, so the first
 * multidimensional one answers; probing the set avoids hardcoding a single 'x'.
 */
const FALLBACK_AXIS_PARAMS = ['x', 'y', 'z'] as const;

type BroadcastFacade = keyof typeof BROADCAST_ACTIONS;

function wrapBroadcastSurface<T extends object>(
  voiceId: string | null,
  facade: BroadcastFacade,
  surface: T,
): T {
  // Only multi-voice contexts (a collection tile) can gang. Single-orbiter (voiceId null) has no
  // siblings, so it is never wrapped — its facades are byte-identical to before multi-focus existed.
  if (voiceId == null) return surface;
  const descriptors = Object.getOwnPropertyDescriptors(surface) as PropertyDescriptorMap;
  for (const method of BROADCAST_ACTIONS[facade]) {
    const raw = (surface as Record<string, unknown>)[method];
    if (typeof raw !== 'function') continue;
    descriptors[method] = {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (...args: unknown[]) => {
        const result = raw.apply(surface, args);
        broadcastAction(voiceId, facade, method, args);
        return result;
      },
    };
  }
  return Object.defineProperties({}, descriptors) as T;
}

/**
 * Wrap the singletons in the narrow typed read-models the React UI consumes.
 * Pure: holds no React, performs no side-effects beyond the calls it forwards.
 */
export function createEngineContext({
  parameterManager,
  midiController = null,
  midiControllerProvider,
  dimensionProvider = null,
  panelManager = null,
  panelOptions = [],
  transportController = null,
  syncCoordinator = null,
  cosmicLfoProvider = null,
  sensorsProvider = null,
  webRtcProvider = null,
  audioEngineProvider = null,
  infoTagsProvider = null,
  // The per-voice event channel engine surfaces subscribe to (panel-change, …). Defaults to
  // `window` so single-orbiter is byte-identical; a multi tile passes its own EventTarget.
  eventBus = (typeof window !== 'undefined' ? (window as unknown as EventTarget) : null),
  // The voice this context is bound to (null for single-orbiter).
  voiceId = null,
  // Per-voice sync ENABLE backend (reads/writes this voice's flag, drives the shared
  // coordinator by the realm aggregate). Null → the direct single-orbiter coordinator path.
  syncEnableState = null,
}: EngineSingletons): EngineContextValue {
  // Resolve the controller lazily on every access. With a provider, MIDI can come
  // up AFTER mount and `available`/registration start working without a re-mount;
  // without one, fall back to the (constant) snapshot for tests / already-up MIDI.
  const resolveMidi = midiControllerProvider ?? (() => midiController);

  const rawParams: EngineParams = {
    get: (name, dimensionId = null) => parameterManager.getDimensionValue(name, dimensionId),
    getParameter: (name) => parameterManager.getParameter(name),
    subscribe: (controller, name, priority, dimensionId = null) =>
      parameterManager.subscribe(controller, name, priority, dimensionId),
    unsubscribe: (controller, name) => parameterManager.unsubscribe(controller, name),
    setDimensionValue: (name, dimensionId, value, source, priority, options) =>
      parameterManager.setDimensionValue(name, dimensionId, value, source, priority, options),
    setValue: (name, value, source, priority, options) =>
      parameterManager.setRawValue(name, value, source, priority, options),
    isLocked: (name) => parameterManager.isParameterLocked(name),
    isDimensionLocked: (name, dimensionId) => parameterManager.isParameterDimensionLocked(name, dimensionId),
  };

  const midi: EngineMidi = {
    // Getter, not a snapshot: re-resolves each read so MIDI activated after mount
    // is reflected (was a one-shot `midiController != null`, frozen at mount).
    get available() {
      return resolveMidi() != null;
    },
    registerTarget: (binding) => resolveMidi()?.registerMidiLearnTarget(binding),
    unregisterTarget: (id) => resolveMidi()?.unregisterMidiLearnTarget(id),
    exitLearnMode: () => resolveMidi()?.exitMidiLearnMode?.(),
    currentOrbiterId: () => resolveMidi()?.getActiveOrbiterId?.() ?? null,
    currentCollectionId: () => resolveMidi()?.getActiveCollectionId?.() ?? null,
    reloadPersistedMappings: async () => {
      await resolveMidi()?.reloadPersistedMappings?.();
    },
  };

  const rawDims: EngineDims = {
    list: () => (dimensionProvider ? dimensionProvider.getAvailableDimensions() : []),
    // Prefer the provider's active id (authoritative). With no provider, fall back
    // to the active dimension off the first multidimensional axis param — the axes
    // share one active dimension, so any of them answers. Probing the set (not a
    // single hardcoded 'x') means the fallback survives if 'x' isn't registered or
    // the axis naming changes.
    active: () => {
      if (dimensionProvider) return dimensionProvider.getActiveDimensionId();
      for (const axis of FALLBACK_AXIS_PARAMS) {
        const p = parameterManager.getParameter(axis);
        if (p?.isMultidimensional) return p.activeDimensionId ?? null;
      }
      return null;
    },
    // Through the provider when present (full hydration); otherwise PM's flat switch.
    setActive: (dimensionId) =>
      dimensionProvider
        ? dimensionProvider.setActiveDimension(dimensionId)
        : parameterManager.setActiveDimension(dimensionId),
    // Per-voice: re-read on THIS voice's dimension switch only (a sibling tile's switch is filtered out).
    subscribe: (listener) => onDimensionChanged(listener),
  };

  const rawPanels: EnginePanels = {
    list: () => (panelManager ? panelOptions : []),
    active: () => panelManager?.getActivePanel() ?? null,
    activate: (panelId) => panelManager?.activatePanel(panelId),
    subscribe: (listener) => {
      // Per-voice: this tile's PanelManager broadcasts on the SAME eventBus we listen to here, so a
      // panel change in another tile does not re-render this one. (window for single-orbiter.)
      if (!eventBus || !panelManager) return () => {};
      eventBus.addEventListener(PANEL_CHANGE_EVENT, listener);
      return () => eventBus.removeEventListener(PANEL_CHANGE_EVENT, listener);
    },
  };

  // Some engine signals stay on the shared `document` event (loop-toggle, dimension-
  // changed) because active-voice / legacy listeners depend on them; the per-tile React surfaces filter
  // by voiceId instead. An event targets THIS voice unless BOTH ids are present and differ — so single-
  // orbiter (voiceId null) and any unstamped legacy dispatch always pass (byte-identical).
  const eventTargetsThisVoice = (evtVoiceId: string | null | undefined): boolean =>
    voiceId == null || evtVoiceId == null || evtVoiceId === voiceId;

  // Subscribe to dimension-changed for THIS voice only (filters out sibling tiles' switches so e.g. a
  // dimension change in tile A doesn't clear tile B's monitor). `document`-based: the dispatchers
  // (OrbitersEditMode per-voice, KeyboardController active-voice) stamp the originating voiceId.
  const onDimensionChanged = (handler: (event: Event) => void): (() => void) => {
    if (typeof document === 'undefined') return () => {};
    const wrapped = (event: Event) => {
      const evtVoiceId = (event as CustomEvent<{ voiceId?: string | null }>).detail?.voiceId;
      if (eventTargetsThisVoice(evtVoiceId)) handler(event);
    };
    document.addEventListener(DIMENSION_CHANGED_EVENT, wrapped);
    return () => document.removeEventListener(DIMENSION_CHANGED_EVENT, wrapped);
  };

  // Loop-toggle shares dimension-changed's shape: a `document` event the active-voice Interaction
  // loop-default recorder + the (per-voice) usage-events listener must still hear, so per-tile surfaces
  // stamp/filter by voiceId rather than use a private eventBus. `source` ('transport' vs 'waveform')
  // lets the kit panel ignore its OWN broadcasts. One writer + one filtered subscriber, shared by the
  // transport button (`waveform`) and the kit panel (`waveformData`).
  const dispatchLoopToggle = (enabled: boolean, source: 'transport' | 'waveform'): void => {
    if (typeof document === 'undefined') return;
    // Stamp voiceId ONLY for a multi tile (voiceId set). Single-orbiter (voiceId null) omits it so the
    // `ui:loop-toggle` detail is byte-identical to before — `{ enabled, source }`, no extra field.
    const detail = voiceId == null ? { enabled, source } : { enabled, source, voiceId };
    document.dispatchEvent(new CustomEvent(LOOP_TOGGLE_EVENT, { detail }));
  };
  const onLoopToggle = (handler: (detail: { enabled: boolean; source?: string }) => void): (() => void) => {
    if (typeof document === 'undefined') return () => {};
    const wrapped = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean; source?: string; voiceId?: string | null }>).detail;
      if (!eventTargetsThisVoice(detail?.voiceId)) return; // another tile's loop — ignore
      handler({ enabled: Boolean(detail?.enabled), source: detail?.source });
    };
    document.addEventListener(LOOP_TOGGLE_EVENT, wrapped);
    return () => document.removeEventListener(LOOP_TOGGLE_EVENT, wrapped);
  };

  // The `waveform` facade — the shared LOOP on/off the transport bar's loop button drives.
  // The full loop CHROME lives in the kit Playback panel (`waveformData` + useLoopControls); this only
  // owns the engaged-state toggle, broadcasting `ui:loop-toggle` so the transport button and the kit
  // panel stay linked to the same engine loop.
  const rawWaveform: EngineWaveform = {
    setLoopActive: (enabled) => {
      // Drive the engine loop directly: engage an existing range or create a full-track loop.
      const engine = resolveAudioEngine();
      if (!engine) return;
      if (enabled) {
        if (engine.hasLoopRange?.()) {
          engine.setLoopEnabled?.(true);
        } else {
          const durMs = engine.getDurationMs?.() ?? 0;
          if (durMs > 0) engine.setLoopRange?.(0, durMs, { active: true });
        }
      } else {
        engine.setLoopEnabled?.(false);
      }
      // Stamp this voice's id (see dispatchLoopToggle) so sibling tiles ignore it while the shared
      // document listeners (Interaction loop-default recorder, usage-events) still hear it.
      dispatchLoopToggle(enabled, 'transport');
    },
    // The EFFECTIVE loop state (loop-on by default before the first play applies it), so the
    // header toggle's initial render is correct from frame 0 (no off→on flash).
    getLoopActive: (): boolean => Boolean(resolveAudioEngine()?.isLoopActive?.() ?? false),
    subscribeLoopActive: (listener) => {
      if (typeof document === 'undefined') return () => {};
      // Honour the contract — emit the CURRENT loop state immediately so a control mounted before any
      // loop event (the header loop toggle) reflects it from load.
      listener(rawWaveform.getLoopActive());
      return onLoopToggle((detail) => listener(detail.enabled));
    },
  };

  // TransportControl facade (T5). The async play/pause/stop/toggle are
  // fire-and-forget (the React click handlers don't await). State is read live and
  // changes arrive via the window event, so React tracks transport regardless of what
  // drove it (button, MIDI through the still-mounted legacy chrome, keyboard, end-of-track).
  const rawTransport: EngineTransport = {
    get available() {
      return transportController != null;
    },
    getState: () => transportController?.getState() ?? 'stopped',
    isPlaying: () => transportController?.isPlaying() ?? false,
    play: () => fireAndForget(transportController?.play()),
    pause: () => fireAndForget(transportController?.pause()),
    stop: () => fireAndForget(transportController?.stop()),
    toggle: () => fireAndForget(transportController?.toggle()),
    subscribe: (listener) => {
      if (typeof window === 'undefined') return () => {};
      const handler = (event: Event) => {
        const detail = (event as CustomEvent).detail as { state?: TransportState } | undefined;
        const state = detail?.state;
        if (state === 'playing' || state === 'paused' || state === 'stopped') {
          listener(state);
        }
      };
      // Per-voice: this tile's TransportControl dispatches on the same eventBus (window for single).
      if (!eventBus) return () => {};
      eventBus.addEventListener(TRANSPORT_STATE_CHANGE_EVENT, handler);
      return () => eventBus.removeEventListener(TRANSPORT_STATE_CHANGE_EVENT, handler);
    },
    // The quantized-start count-in. The adapter owns the state (single owner) — read the live
    // snapshot for the initial render (covers mounting mid-wait), then track the window event. The
    // adapter resolver is lazy (audio inits after mount), so `getCountIn` re-resolves on every call.
    getCountIn: () => resolveAudioEngine()?.getCountInState?.() ?? { active: false },
    subscribeCountIn: (listener) => {
      // Per-voice: this tile's AudioEngineAdapter mirrors its count-in on the SAME eventBus we listen to
      // here, so another tile's count-in doesn't drive this one. (window for single-orbiter, identical.)
      if (!eventBus) return () => {};
      const handler = (event: Event) => {
        const detail = (event as CustomEvent).detail as TransportCountIn | undefined;
        listener(detail ?? { active: false });
      };
      eventBus.addEventListener(QUANTIZE_COUNTIN_EVENT, handler);
      return () => eventBus.removeEventListener(QUANTIZE_COUNTIN_EVENT, handler);
    },
  };

  // Per-axis CosmicLFO facade. Resolves the LFO on each call (tolerates it not
  // existing yet). enable/source/waveform call straight into the LFO; freq + amplitude are
  // handled by their PM params via the `params` surface. `subscribe` re-reads on the LFO's
  // own change event + a dimension switch.
  const resolveCosmic = cosmicLfoProvider ?? (() => null);
  // The `sync` facade: the header SYNC enable toggle over the singleton SyncCoordinator. The shared
  // BPM rides its own PM param; this is only the tempo-sync enable. `enable()` can fail silently
  // (adapter won't connect → no status event), so the toggle re-reads `isEnabled` on the event.
  const rawSync: EngineSync = {
    available: syncCoordinator != null,
    // Per-voice sync ENABLE when a `syncEnableState` is supplied (multi tile reads/writes its
    // OWN flag; the shared coordinator is driven by the realm aggregate inside it). No state → the
    // direct single-orbiter coordinator path (byte-identical).
    isEnabled: () => (syncEnableState ? syncEnableState.isEnabled() : Boolean(syncCoordinator?.isEnabled)),
    setEnabled: (enabled) => {
      if (syncEnableState) {
        syncEnableState.setEnabled(enabled);
        return;
      }
      if (!syncCoordinator) return;
      if (enabled) syncCoordinator.enable();
      else syncCoordinator.disable();
    },
    // How many OTHERS are in the session — LIVE + room-scoped. Reads `sessionPeerCount`
    // (the room/WebSocket adapter's server-scoped peer set, 0 for in-tab) so cross-room / cross-tab peers
    // never inflate the badge. The status event carries peer changes so the SyncStack re-reads on
    // `subscribe`. NaN/missing → 0.
    peerCount: () => {
      const n = Number(syncCoordinator?.sessionPeerCount);
      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    // Σ of other tabs' announced synced-voice counts — the badge's cross-tab source, so a multi-orbiter
    // tab counts as its true voice count (not 1 connection). Room-scoped (0 in-tab). NaN/missing → 0.
    remoteSyncedVoiceCount: () => {
      const n = Number(syncCoordinator?.sessionRemoteVoiceCount);
      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    // How many voices in THIS tab want sync (incl. self when this tile is on). Multi reads the
    // per-voice aggregate; single-orbiter (no syncEnableState) counts itself via the coordinator's
    // enable. The SYNC badge adds this to peerCount so two synced in-tab orbiters show "2".
    inTabSyncedCount: () =>
      syncEnableState?.syncedCount
        ? syncEnableState.syncedCount()
        : (Boolean(syncCoordinator?.isEnabled) ? 1 : 0),
    subscribe: (listener) => {
      // Subscribe to the conductor's session-level status surface directly (replaces the
      // `orbiters:sync-status-change` window event). Null coordinator (tests) → no-op subscription.
      if (!syncCoordinator?.onStatusChange) return () => {};
      const unsub = syncCoordinator.onStatusChange(() => listener());
      return () => unsub();
    },
  };

  const rawCosmic: EngineCosmic = {
    available: (axis) => resolveCosmic(axis) != null,
    isEnabled: (axis) => Boolean(resolveCosmic(axis)?.isCosmicEnabled()),
    setEnabled: (axis, enabled) => {
      const lfo = resolveCosmic(axis);
      if (lfo) {
        if (enabled) lfo.start();
        else lfo.stop();
      }
    },
    getSource: (axis) => resolveCosmic(axis)?.getFrequencySource() ?? 'manual',
    setSource: (axis, sourceKey) => resolveCosmic(axis)?.setFrequencySource(sourceKey),
    getWaveform: (axis) => resolveCosmic(axis)?.getWaveform() ?? 'sine',
    setWaveform: (axis, waveformKey) => resolveCosmic(axis)?.setWaveform(waveformKey),
    triggerKick: (axis, label) => resolveCosmic(axis)?.triggerKick?.(label),
    subscribe: (listener) => {
      // Per-voice: this tile's CosmicLFOs mirror cosmic-changed on the SAME eventBus we listen to here,
      // so another tile's cosmic toggle doesn't re-read this one. (window for single-orbiter, identical.)
      // The dimension-change re-read stays on `document` (migrated with the dimension-changed item).
      if (eventBus) eventBus.addEventListener(COSMIC_CHANGED_EVENT, listener);
      // Per-voice dimension re-read (filtered by voiceId); cosmic-changed already per-voice via eventBus.
      const offDim = onDimensionChanged(listener);
      return () => {
        if (eventBus) eventBus.removeEventListener(COSMIC_CHANGED_EVENT, listener);
        offDim();
      };
    },
  };

  // The `sensors` facade: per-axis device-motion enable over the singleton SensorController.
  // Like `cosmic`, the enable is per-axis-per-dimension and not a PM param. Tolerates a null
  // controller (returns unavailable + safe defaults) so tests / pre-init mounts don't throw.
  const resolveSensors = sensorsProvider ?? (() => null);
  const sensors: EngineSensors = {
    available: (axis) => resolveSensors() != null && SENSOR_AXES.has(axis),
    isEnabled: (axis) => (SENSOR_AXES.has(axis) ? Boolean(resolveSensors()?.isAxisEnabled(axis)) : false),
    setEnabled: (axis, enabled) => {
      if (!SENSOR_AXES.has(axis)) return;
      resolveSensors()?.setAxisActive(axis, enabled);
    },
    calibrate: () => resolveSensors()?.calibrateDevice(),
    subscribe: (listener) => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener(SENSOR_CHANGED_EVENT, listener);
      const offDim = onDimensionChanged(listener); // per-voice dimension re-read
      return () => {
        document.removeEventListener(SENSOR_CHANGED_EVENT, listener);
        offDim();
      };
    },
  };

  // The `connection` facade: device-pairing (WebRTC) state + the connect modal, for the sensor
  // connection button. Lazy provider (the manager is built with SensorController on Sensors-panel
  // use). Null-tolerant so tests / pre-init / mobile don't throw.
  const resolveWebRtc = webRtcProvider ?? (() => null);
  const connection: EngineConnection = {
    available: () => resolveWebRtc() != null,
    isConnected: () => Boolean(resolveWebRtc()?.isConnected),
    openConnect: () => resolveWebRtc()?.handleConnectionButtonClick(),
    subscribe: (listener) => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener(CONNECTION_CHANGED_EVENT, listener);
      return () => document.removeEventListener(CONNECTION_CHANGED_EVENT, listener);
    },
    pairing: {
      // The manager publishes the pairing view on `orbiters:sensor-pairing` (Tier-1 migration);
      // re-shape the CustomEvent detail into the typed PairingState (or null on close).
      subscribe: (listener) => {
        if (typeof document === 'undefined') return () => {};
        const handler = (event: Event) => {
          const detail = (event as CustomEvent).detail as
            | (PairingState & { open: boolean })
            | undefined;
          if (!detail || detail.open === false) {
            listener(null); // always forward CLOSE so no tile's dialog gets stuck open
            return;
          }
          // The device connection is realm-global (ONE WebRTCManager for all voices), but this
          // pairing event is on `document` and every voice's dialog subscribes to it — so N open orbiters
          // used to stack N identical connect/reconnect modals. Show it on exactly ONE voice: the active
          // one (the orbiter you're pairing/reconnecting for). Single-orbiter (voiceId null) always owns.
          if (voiceId != null && voiceId !== voiceRegistry.activeId) return;
          listener({
            view: detail.view,
            reconnect: detail.reconnect,
            pairingInfo: detail.pairingInfo,
            sources: detail.sources ?? [],
          });
        };
        document.addEventListener(PAIRING_EVENT, handler);
        return () => document.removeEventListener(PAIRING_EVENT, handler);
      },
      useConnectedSource: (source) => resolveWebRtc()?.connectToSharedLocalSource(source),
      connectNewDevice: (reconnect) => resolveWebRtc()?.requestDirectConnection(reconnect),
      close: () => resolveWebRtc()?.notifyPairingClosed(),
    },
  };

  // The `monitor` facade: the per-dimension audio label+value readout (Info panel's Monitor view).
  // Reads the snapshot from the AudioEngineAdapter (which owns the value math via the racks) and
  // subscribes to the same ParameterManager x/y/z changes that drive those racks — coalesced to one
  // callback per frame, since cosmic modulation ticks PM at audio rate and the UI only needs frames.
  const resolveAudioEngine = audioEngineProvider ?? (() => null);
  // The REAL per-(dim,axis) normalized input, from ParameterManager — so the monitor maps the true
  // parameter state (incl. at load, before audio drives the racks) instead of stale preset defaults.
  const liveNormalized = (dimensionId: string, axis: string): number | null =>
    parameterManager.getNormalizedValue(axis, dimensionId) ?? null;
  const monitor: EngineMonitor = {
    available: () => resolveAudioEngine() != null,
    getSnapshot: () => resolveAudioEngine()?.getMonitorSnapshot(liveNormalized) ?? EMPTY_MONITOR_SNAPSHOT,
    subscribe: (listener) => {
      // Coalesce to one callback per frame. Track the handle + a cancelled flag so unsubscribe
      // cancels any in-flight frame — otherwise a queued callback fires `listener` once AFTER the
      // consumer unmounted (a stale-closure update on a torn-down component).
      const hasRaf = typeof requestAnimationFrame === 'function';
      const schedule = hasRaf ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16);
      const unschedule = hasRaf ? cancelAnimationFrame : (id: number) => clearTimeout(id);
      let frame: number | null = null;
      let cancelled = false;
      const fire = () => {
        if (frame !== null) return;
        frame = schedule(() => {
          frame = null;
          if (!cancelled) listener();
        }) as number;
      };
      // `dimensionId: null` → PM notifies us only for ACTIVE-dimension changes (it gates null
      // subscribers on the changed dim being active). The Info panel renders the active dimension
      // only, so that is exactly the scope it needs; the DIMENSION_CHANGED listener re-reads the full
      // snapshot on a switch, so inactive rows are correct after a switch. A future all-dimensions
      // view would subscribe per-(axis, dimension) instead. See EngineMonitor's doc.
      const controller: ParamController = { onParameterChanged: fire };
      MONITOR_AXES.forEach((axis) =>
        parameterManager.subscribe(controller, axis, MONITOR_SUBSCRIBE_PRIORITY, null),
      );
      // Per-voice: re-read on THIS voice's dimension switch only — a sibling tile's switch must NOT
      // clear this tile's monitor (the cross-talk the A2 plan calls out).
      const offDim = onDimensionChanged(fire);
      return () => {
        cancelled = true;
        if (frame !== null) {
          unschedule(frame);
          frame = null;
        }
        MONITOR_AXES.forEach((axis) => parameterManager.unsubscribe(controller, axis));
        offDim();
      };
    },
  };

  // The `waveformData` facade — the kit timeline's DATA surface. Thin, seconds-normalized
  // wrappers over the active voice's AudioEngineAdapter (the existing position/seek/loop owner). No
  // ticker here: the kit panel runs the single RAF for the playhead while it is mounted (the Peaks
  // path's TonePeaksAdapter is the same single owner when Peaks renders instead — only one mounts).
  const waveformData: EngineWaveformData = {
    getWaveformUrl: () => resolveAudioEngine()?.getWaveformUrl?.() ?? null,
    getDurationSec: () => (resolveAudioEngine()?.getDurationMs?.() ?? 0) / 1000,
    getPositionSec: () => (resolveAudioEngine()?.getCurrentPositionMs?.() ?? 0) / 1000,
    seek: (sec) => {
      void resolveAudioEngine()?.seekToMilliseconds?.(Math.max(0, sec) * 1000);
    },
    getLoopRangeSec: (): WaveformLoopRange | null => {
      // player.js stores + returns the loop range in MILLISECONDS (set via setLoopRange(startMs,endMs));
      // the kit works in seconds, so convert here (mirrors the sec→ms in setLoopSec below).
      const r = resolveAudioEngine()?.getLoopRange?.();
      return r ? { startSec: r.start / 1000, endSec: r.end / 1000 } : null;
    },
    setLoopSec: (loop) => {
      const engine = resolveAudioEngine();
      if (!engine) return;
      if (loop) engine.setLoopRange?.(loop.startSec * 1000, loop.endSec * 1000, { active: true });
      else engine.clearLoop?.();
    },
    // Use the EFFECTIVE loop state (loop-on-by-default before the first play applies it) —
    // the same read the transport loop button uses — so the kit panel + transport button agree.
    isLoopActive: () => resolveAudioEngine()?.isLoopActive?.() ?? resolveAudioEngine()?.isLooping?.() ?? false,
    setLoopActive: (active) => resolveAudioEngine()?.setLoopEnabled?.(active),
    hasLoopRange: () => resolveAudioEngine()?.hasLoopRange?.() ?? false,
    getTrackBpm: () => {
      const bpm = resolveAudioEngine()?.getGridMarkerState?.()?.getSnapshot?.()?.trackBpm;
      return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : null;
    },
    getMeterId: () => resolveAudioEngine()?.getGridMarkerState?.()?.meter ?? null,
    // The deck's own onChange (not the eventBus/window pattern the other subscribes here use).
    // Meter is per-voice — changed only by a local edit (Deck.setMeter). The listener re-reads
    // getMeterId on any deck change; useSyncExternalStore's string-equality bail-out ignores
    // non-meter ones.
    subscribeMeterChange: (listener) => {
      const unsub = resolveAudioEngine()?.getGridMarkerState?.()?.onChange?.(() => listener());
      return typeof unsub === 'function' ? unsub : () => {};
    },
    getGridMarkerSec: () => resolveAudioEngine()?.getGridMarkerTimeSec?.() ?? 0,
    setGridMarkerSec: (sec) => resolveAudioEngine()?.setGridMarkerTimeSec?.(sec),
    // Per-voice: this tile's DataManager dispatches config-update on the SAME eventBus, so the kit
    // waveform re-reads on ITS voice's track load, not a sibling tile's. (window for single-orbiter.)
    subscribeConfig: (listener) => {
      if (!eventBus) return () => {};
      eventBus.addEventListener(CONFIG_UPDATED_EVENT, listener);
      return () => eventBus.removeEventListener(CONFIG_UPDATED_EVENT, listener);
    },
    // The kit panel's loop broadcast/subscribe — same shared `document` event +
    // voiceId stamp/filter as the transport button (`dispatchLoopToggle`/`onLoopToggle`). `source:
    // 'waveform'` lets useLoopControls ignore its OWN broadcasts (re-read only on external changes).
    broadcastLoopToggle: (enabled) => dispatchLoopToggle(enabled, 'waveform'),
    subscribeLoopToggle: (listener) => onLoopToggle(listener),
  };

  // The `info` facade: the static metadata rows for the Info panel's non-Monitor views. Resolves
  // the focused orbiter`s `trackData` → `buildInfoTags` on each read (cheap; reflects the active dimension for
  // the orbiter view). Re-reads on a dimension switch (orbiter axis rows) AND on a config update
  // (a new track/orbiter/world loaded mid-session → all rows change).
  const resolveInfoTags = infoTagsProvider ?? (() => null);
  const info: EngineInfo = {
    getTags: (mode) => resolveInfoTags()?.[mode] ?? [],
    subscribe: (listener) => {
      // Per-voice: this tile's DataManager dispatches config-update on the SAME eventBus we listen to
      // here, so a new track loading in another tile doesn't refresh this one's info rows. (window for
      // single-orbiter, identical.) The dimension re-read stays on `document` (migrated separately).
      if (eventBus) eventBus.addEventListener(CONFIG_UPDATED_EVENT, listener);
      // Per-voice dimension re-read (filtered by voiceId); config-update already per-voice via eventBus.
      const offDim = onDimensionChanged(listener);
      return () => {
        if (eventBus) eventBus.removeEventListener(CONFIG_UPDATED_EVENT, listener);
        offDim();
      };
    },
  };

  const rawCommands: RawEngineCommands = {
    params: rawParams,
    dims: rawDims,
    panels: rawPanels,
    waveform: rawWaveform,
    transport: rawTransport,
    cosmic: rawCosmic,
    sync: rawSync,
    // The gang replay target for a launch-grid pick: writes THIS voice's own deck.
    deck: { setLaunchGridBars: (bars: number) => deckFor(voiceId)?.setLaunchGridBars(bars) },
  };
  if (voiceId != null) {
    const voice = voiceRegistry.get(voiceId);
    if (voice) voice.engineCommands = rawCommands;
  }

  const params = wrapBroadcastSurface(voiceId, 'params', rawParams);
  const dims = wrapBroadcastSurface(voiceId, 'dims', rawDims);
  const panels = wrapBroadcastSurface(voiceId, 'panels', rawPanels);
  const waveform = wrapBroadcastSurface(voiceId, 'waveform', rawWaveform);
  const transport = wrapBroadcastSurface(voiceId, 'transport', rawTransport);
  const cosmic = wrapBroadcastSurface(voiceId, 'cosmic', rawCosmic);
  const sync = wrapBroadcastSurface(voiceId, 'sync', rawSync);

  return { voiceId, params, midi, dims, panels, waveform, waveformData, transport, sync, cosmic, sensors, connection, monitor, info };
}
