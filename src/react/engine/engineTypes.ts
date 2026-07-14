/**
 * @file src/react/engine/engineTypes.ts
 * @description Typed read-models + actions for the orbiters `EngineContext`
 * boundary (React-UI ground-up strategy §3).
 *
 * THE RULE (Phase-0 hard gate): React component code consumes ONLY these typed
 * surfaces. It never imports `Main.js`, never reads `window.__orbiters*` /
 * `window.MIDIControllerInstance`, never reaches a raw singleton. The single
 * place that bridges the singletons into these shapes is `createEngineContext.ts`,
 * called once at the mount boundary.
 *
 * These are deliberately NARROW — only the methods the React UI actually needs —
 * so the boundary stays honest and the singletons can be reshaped behind it
 * (e.g. the `params` write side moving onto the `InputSource` seam) without
 * touching component code.
 */

export type UpdateIntent = 'live' | 'commit';

export interface WriteOptions {
  updateIntent: UpdateIntent;
  notifyIfUnchanged?: boolean;
}

/** A parameter subscriber: the React seam implements this to receive changes. */
export interface ParamController {
  onParameterChanged(name: string, value: number, dimensionId?: string, metadata?: unknown): void;
  onParameterLocked?(name: string, locked: boolean, dimensionId?: string): void;
}

/**
 * The `params` read-model + actions — a narrow facade over ParameterManager.
 * `dimensionId = null` means "follow the active dimension" (Option C).
 */
export interface EngineParams {
  /** Current value for a param in a dimension (null dim → active dimension). */
  get(name: string, dimensionId?: string | null): number | null | undefined;
  /** Param descriptor (whether multidimensional + which dimension is active). */
  getParameter(name: string): { isMultidimensional?: boolean; activeDimensionId?: string | null } | undefined;
  /** Subscribe a controller (null dim → active-dimension display, Option C). */
  subscribe(controller: ParamController, name: string, priority?: number, dimensionId?: string | null): void;
  unsubscribe(controller: ParamController, name: string): void;
  /** Write to a specific dimension (the gesture-captured one). */
  setDimensionValue(name: string, dimensionId: string, value: number, source: unknown, priority: number, options: WriteOptions): void;
  /** Write to the active dimension / a non-dimensional param. */
  setValue(name: string, value: number, source: unknown, priority: number, options: WriteOptions): void;
  isLocked(name: string): boolean;
  isDimensionLocked(name: string, dimensionId: string): boolean;
}

/**
 * A scoped MIDI-learn target. `componentId` MUST match the WAC widget being
 * replaced (e.g. "x.knob") so persisted mappings carry over; the scoped key
 * derives from it. `id` is a STABLE LOGICAL id (componentId+dimension), not a
 * remount-churning `useId()` (strategy §6).
 */
export interface ScopedMidiBinding {
  id: string;
  element: HTMLElement;
  componentId: string;
  /**
   * Multi-orbiter: the voice/tile this control belongs to ('v1'…; null in single-orbiter).
   * Inbound MIDI routes the value to THIS voice's ParameterManager, so a CC drives the orbiter it was
   * mapped on — never whichever orbiter happens to be focused. Null → the single active PM (byte-identical).
   */
  voiceId?: string | null;
  componentType?: 'knob' | 'slider' | 'param' | 'switch' | 'kick' | 'toggle' | 'select';
  scope?: 'DIMENSION' | 'GLOBAL';
  axis?: string;
  min?: number;
  max?: number;
  /**
   * Momentary-trigger action (kick switches). When set with
   * `componentType: 'kick'`, inbound MIDI fires this on a rising edge instead of
   * writing a value to ParameterManager. Re-supplied on every mount (the CC mapping
   * persists; the action does not).
   */
  onTrigger?: () => void;
  /**
   * On/off toggle FLIP action (cosmic-enable, sensor-enable, loop). When set with
   * `componentType: 'toggle'`, inbound MIDI fires this on a RISING edge (a press, CC crossing 64
   * upward) to LATCH-flip the maintained state — not on the level — so a momentary pad flips on
   * press and flips back on the next press. The seam closure inverts the control's CURRENT state
   * (read fresh) and applies it; it owns persistence + the active dimension. Re-supplied on every
   * mount (the CC mapping persists; the action does not).
   */
  onToggle?: () => void;
  /**
   * Option count for a stepped SELECT (cosmic source / waveform). With
   * `componentType: 'select'`, inbound MIDI maps the CC value across these options by index.
   */
  selectCount?: number;
  /**
   * Select-by-index action for a stepped SELECT. Inbound MIDI fires this with the resolved
   * option index (deduped per index) instead of writing a value to ParameterManager. The
   * callback maps the index to the option and applies it. Re-supplied on every mount.
   */
  onSelectIndex?: (index: number) => void;
}

/** The `midi` read-model + actions — a narrow facade over MIDIController. */
export interface EngineMidi {
  /** Register a control as a scoped MIDI-learn target. */
  registerTarget(binding: ScopedMidiBinding): void;
  unregisterTarget(id: string): void;
  /** True when MIDI is available in this environment (no controller → false). */
  readonly available: boolean;
  /** Exit MIDI-learn mode (tears down the learn overlays). Gives React a reliable click-to-exit —
   *  the legacy UI lacked a working way out of learn mode. No-op if MIDI isn't up. */
  exitLearnMode(): void;
  /** The active orbiter id (or null) — used by the load-saved-mappings dialog to scope the
   *  transfer and exclude the current orbiter from the source list. */
  currentOrbiterId(): string | null;
  /** The collection whose shell MIDI targets are registered (or null outside the collection
   *  studio) — scopes the dialog's shell-mapping transfers the same way. */
  currentCollectionId(): string | null;
  /** Re-fetch the active orbiter's scoped mappings and re-apply them live. Called after the
   *  load-saved-mappings dialog copies a source orbiter's bindings in. */
  reloadPersistedMappings(): Promise<void>;
}

/** A selectable dimension (strategy §3 `dims.list`). */
export interface DimensionOption {
  id: string;
  label: string;
}

/** The `dims` read-model + action: the dimension list, which is active, how to
 *  switch, and a change subscription (strategy §3). */
export interface EngineDims {
  /** The selectable dimensions. Empty when no dimension provider is wired
   *  (e.g. non-edit modes) — the selector region renders nothing then. */
  list(): DimensionOption[];
  /** The active dimension id (or null when none / non-multidimensional). */
  active(): string | null;
  /** Switch the active dimension (full hydration when a provider is wired). */
  setActive(dimensionId: string): void;
  /** Subscribe to active-dimension changes (from React OR the legacy chrome).
   *  Returns an unsubscribe. No-op subscription when no provider is wired. */
  subscribe(listener: () => void): () => void;
}

/** A selectable interaction panel (strategy §3 `panels`). */
export interface PanelOption {
  /** The PanelManager panel id (e.g. "SENSORS_PANEL"). */
  id: string;
  /** The interaction-menu action token from index.html (e.g. "sensors"). */
  action: string;
  /** Display label. */
  label: string;
}

/**
 * The `panels` read-model + actions — a narrow facade over PanelManager (strategy
 * §3). PanelManager mutates DOM + dispatches events; this surface exposes ONLY the
 * activate/active/subscribe seam the interaction menu needs (no raw DOM), so the
 * imperative coupling stays at the mount boundary (Codex P0).
 */
export interface EnginePanels {
  /** The selectable interaction panels (Sensors / Cosmic / Playback / Jamming). */
  list(): PanelOption[];
  /** The active panel id (or null before the first activation). */
  active(): string | null;
  /** Activate a panel by id (runs PanelManager's onExit/onEnter side effects). */
  activate(panelId: string): void;
  /** Subscribe to active-panel changes (from React OR the legacy chrome).
   *  Returns an unsubscribe. No-op subscription when no panel manager is wired. */
  subscribe(listener: () => void): () => void;
}

/**
 * The `waveform` loop-engage surface — the engine-backed LOOP on/off the transport bar's loop
 * button drives. The Playback panel's full loop CHROME (in/out/snap/size/grid + the
 * range geometry) now lives in the kit panel via {@link EngineWaveformData} + `useLoopControls`;
 * this is only the shared engaged-state toggle so the transport button and the kit panel agree
 * (both reflect via the `ui:loop-toggle` document event).
 */
export interface EngineWaveform {
  /** Toggle the loop engaged — engages an existing range or creates a full-track loop. */
  setLoopActive(enabled: boolean): void;
  /** The EFFECTIVE loop-engaged state (loop-on by default before the first play applies
   *  the range), so a control renders the right state from its first frame (no off→on flash). */
  getLoopActive(): boolean;
  /**
   * Subscribe to LOOP-ENGAGED (on/off) changes, DURABLE across mount timing: keys on the
   * `ui:loop-toggle` document event broadcast on every loop-engaged change (the transport button,
   * the kit panel, or MIDI). Calls back with the current `loopActive`. Returns unsubscribe.
   */
  subscribeLoopActive(listener: (active: boolean) => void): () => void;
}

/** A loop range in seconds — the shape the design-lib timeline kit `LoopRegion` reads. */
export interface WaveformLoopRange {
  startSec: number;
  endSec: number;
}

/**
 * The lean, read-mostly waveform DATA surface the React timeline kit binds to —
 * the orbiter's live waveform url, duration, playhead position, seek, and loop range, all
 * in SECONDS. A sibling to {@link EngineWaveform} (which owns the Peaks loop CHROME): this
 * exposes the geometry the kit `Waveform`/`Playhead`/`TimelineRuler`/`LoopRegion` need so the
 * orbiter timeline can be rebuilt from the kit instead of Peaks.js. Thin wrappers over the
 * active voice's `AudioEngineAdapter` (the existing position/seek/loop owner) — no second
 * playback-rate owner, no new ticker (the kit panel runs the one RAF while it is mounted).
 */
export interface EngineWaveformData {
  /** The current track's waveform JSON url (audiowaveform v2), or null before a track loads. */
  getWaveformUrl(): string | null;
  /** Track duration in seconds (0 until known). */
  getDurationSec(): number;
  /** Live playhead position in seconds. */
  getPositionSec(): number;
  /** Seek the engine to `sec` (clamped at 0). */
  seek(sec: number): void;
  /** The active loop range in seconds, or null when no loop is set. */
  getLoopRangeSec(): WaveformLoopRange | null;
  /** Set the loop range (engaged) from seconds, or clear it when null. */
  setLoopSec(loop: WaveformLoopRange | null): void;
  /** Whether a loop is currently engaged. */
  isLoopActive(): boolean;
  /** Engage / disengage the loop WITHOUT changing its range (the LOOP toggle). */
  setLoopActive(active: boolean): void;
  /** A loop range exists (set), even if not currently engaged. */
  hasLoopRange(): boolean;
  /** The track tempo (BPM) used for beat-grid loop math, or null when unknown. */
  getTrackBpm(): number | null;
  /** The beat-grid origin (the downbeat) in seconds — the snap reference. */
  getGridMarkerSec(): number;
  /** Set the beat-grid origin (seconds) — the GRID button; persist separately via the UI commit. */
  setGridMarkerSec(sec: number): void;
  /** This voice's own per-track meter id (e.g. "3/4"). Meter is always per-voice — never shared, even
   *  between two synced voices. Null before a track has loaded. */
  getMeterId(): string | null;
  /** Subscribe to this voice's own meter changing (a local edit via `setOwnMeter`). Returns
   *  unsubscribe. */
  subscribeMeterChange(listener: () => void): () => void;
  /** Subscribe to this voice's track-config change (a new track/orbiter/world loaded
   *  mid-session), so the kit waveform re-reads its OWN voice's data — not on a sibling tile's load.
   *  Keys on the per-voice `dataManager:configUpdated` (window for single-orbiter). Returns unsubscribe. */
  subscribeConfig(listener: () => void): () => void;
  /** Broadcast a loop engaged/disengaged change from the kit panel. Dispatched on the
   *  shared `ui:loop-toggle` document event (so the active-voice Interaction recorder + usage-events
   *  hear it) but stamped with this voice's id so sibling tiles ignore it. `source` is 'waveform'. */
  broadcastLoopToggle(enabled: boolean): void;
  /** Subscribe to loop-toggle changes for THIS voice (other tiles' toggles are
   *  filtered out by voiceId). The listener receives `{ enabled, source }` so the kit panel can ignore
   *  its OWN 'waveform' broadcasts and re-read only on external (transport/MIDI) changes. */
  subscribeLoopToggle(listener: (detail: { enabled: boolean; source?: string }) => void): () => void;
}

/** Transport playback state (mirrors TransportControl.currentState). */
export type TransportState = 'playing' | 'paused' | 'stopped';

/**
 * The quantized-start count-in (the wait between pressing Play and the next launch-grid
 * boundary, on a shared clock). While `active`, playback is ARMED — the UI shows a count-down so the
 * wait reads as "armed", not "broken". Emitted by `AudioEngineAdapter` when it schedules the delayed
 * start, and cleared (`active:false`) when the start fires or is canceled (pause / superseding play).
 */
export interface TransportCountIn {
  /** True while waiting for the launch bar; false (the only guaranteed field) once fired/canceled. */
  active: boolean;
  /** `performance.now()` timestamp the quantized start fires at — drive the countdown against this. */
  targetTime?: number;
  /** Shared tempo (BPM) — converts the remaining time to beats for the countdown. */
  bpm?: number;
  /**
   * For a quantized SEEK (not a launch), the track position the seek will land on, in
   * seconds. Present only for a pending seek — lets the waveform blink a marker AT the set position (the
   * count shown in the action), not just at the top. Absent for a quantized play/launch.
   */
  seekTargetSec?: number;
}

/**
 * The `transport` read-model + actions — a narrow facade over TransportControl
 * (play / pause / stop / toggle). The legacy `.action-stack--transport`
 * dropdown drove TransportControl directly; under `?ui=react` the React Transport
 * region is the visible control, so it reaches the same singleton through this surface
 * instead of `window.transportControl` (keeps the no-globals boundary). State changes
 * broadcast on the `orbiters:transport-state-change` window event; `subscribe` wraps it.
 * `record` (a capture-window flow) and `loop` (a waveform concern) are intentionally NOT
 * here — they belong to their own surfaces.
 */
export interface EngineTransport {
  /** True when transport is wired (a TransportControl was provided at the boundary). */
  readonly available: boolean;
  /** Current playback state. */
  getState(): TransportState;
  isPlaying(): boolean;
  play(): void;
  pause(): void;
  stop(): void;
  /** Toggle play/pause (mirrors the legacy `play-toggle`). */
  toggle(): void;
  /** Subscribe to state changes (from React OR the legacy chrome). Returns unsubscribe. */
  subscribe(listener: (state: TransportState) => void): () => void;
  /** The current quantized-start count-in (inactive when no quantized start is pending). */
  getCountIn(): TransportCountIn;
  /** Subscribe to quantized-start count-in changes (armed → cleared). Returns unsubscribe. */
  subscribeCountIn(listener: (state: TransportCountIn) => void): () => void;
}

/**
 * The `sync` read-model — a facade over the singleton `SyncCoordinator` for the header SYNC toggle.
 * The shared tempo (BPM) is a PM param (the `sync-bpm` Param via `params`); THIS surface is just the
 * enable toggle for the tempo-sync engine (the multiplayer/clock sync). `enable()` can fail silently
 * if the transport adapter won't connect, so consumers re-read `isEnabled()` on the
 * `orbiters:sync-status-change` event rather than assuming the toggle took. null coordinator (tests /
 * pre-init) → `available` false + safe defaults.
 */
export interface EngineSync {
  /** True when the SyncCoordinator is wired. */
  readonly available: boolean;
  /** Whether the tempo-sync engine is currently enabled. */
  isEnabled(): boolean;
  /** Enable/disable the tempo-sync engine (SyncCoordinator.enable/disable). */
  setEnabled(enabled: boolean): void;
  /** Other participants in the sync session (NOT counting self). The SYNC badge shows the
   *  total in-session count as `peerCount + 1` (legacy `Interaction.js` `SYNC ${peerCount + 1}`). */
  peerCount(): number;
  /** Σ of the OTHER tabs' announced SYNCED-voice counts (never self), room-scoped. The badge adds this
   *  to `inTabSyncedCount` for the true session total — a multi-orbiter tab counts as its N voices, not
   *  the 1 connection `peerCount` sees. 0 for the in-tab-only path. */
  remoteSyncedVoiceCount(): number;
  /** Voices in THIS tab that want sync, incl. self when this tile is on (in-tab session size).
   *  The SYNC badge adds this to `remoteSyncedVoiceCount` so two synced in-tab orbiters show "2". */
  inTabSyncedCount(): number;
  /** Subscribe to sync status changes (enable/disable/tempo/mode/peers). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/**
 * The `cosmic` read-model + actions — a narrow per-axis facade over the CosmicLFO instances
 * The freq + amplitude knobs go through their PM params (the `params` surface); this
 * surface is for the NON-PM cosmic controls: the enable toggle, the modulation-source select,
 * and the waveform select. Each is per-axis ('x'|'y'|'z'). `subscribe` keys on the
 * `orbiters:cosmic-changed` window event CosmicLFO dispatches (+ dimension change), so React
 * re-reads enable/source/waveform whatever drove the change (this UI, the legacy chrome, a
 * dimension switch, or world-data seeding).
 */
export interface EngineCosmic {
  /** True when the per-axis CosmicLFO is wired. */
  available(axis: string): boolean;
  /** Whether the cosmic LFO is enabled (running) for the axis' active dimension. */
  isEnabled(axis: string): boolean;
  /** Enable/disable the cosmic LFO for the axis (start/stop on the active dimension). */
  setEnabled(axis: string, enabled: boolean): void;
  /** Current modulation-source key (catalog key, e.g. 'manual' / 'minimumCosmicLfo'). */
  getSource(axis: string): string;
  /** Select the modulation source (drives CosmicLFO.setFrequencySource). */
  setSource(axis: string, sourceKey: string): void;
  /** Current waveform key (e.g. 'sine'). */
  getWaveform(axis: string): string;
  /** Select the LFO waveform (drives CosmicLFO.setWaveform). */
  setWaveform(axis: string, waveformKey: string): void;
  /** Trigger a momentary CosmicLFO frequency multiplier kick. */
  triggerKick(axis: string, label: string): void;
  /** Subscribe to cosmic state changes (enable/source/waveform + dimension). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/**
 * The `sensors` read-model — a per-axis facade over the singleton `SensorController` for the
 * device-motion enable toggles. Like `cosmic`, the enable is per-axis-per-dimension and
 * NOT a PM param (it drives SensorController.start/stop-listening + persists scoped toggle state),
 * so it's a surface rather than `useParameter`. Re-reads on the controller's `sensorToggleChanged`
 * event (+ dimension change).
 */
export interface EngineSensors {
  /** True when the SensorController is wired and the axis is a sensor axis (x/y/z). */
  available(axis: string): boolean;
  /** Whether device-sensor input is enabled for the axis' active dimension. */
  isEnabled(axis: string): boolean;
  /** Enable/disable device-sensor input for the axis on the active dimension (persists + may
   *  request the device-orientation permission + start/stop the motion listeners). */
  setEnabled(axis: string, enabled: boolean): void;
  /** Re-zero the device orientation reference (SensorController.calibrateDevice). */
  calibrate(): void;
  /** Subscribe to sensor toggle changes (+ dimension). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** One available local (same-machine) sensor source offered in the "choice" pairing view. */
export interface PairingSource {
  sourceId: string;
  label?: string;
  ownerInstanceId?: string | null;
  [key: string]: unknown;
}

/** The pairing-modal view state React renders, published by `WebRTCManager` on
 *  `orbiters:sensor-pairing` (Tier-1 React migration). `null` = no pairing modal open. */
export interface PairingState {
  /** `qr` = QR code + manual link; `choice` = "use connected" vs "connect new device" cards. */
  view: 'qr' | 'choice';
  /** Reconnect copy (device dropped) vs first-connect copy. */
  reconnect: boolean;
  /** The pairing URL — encoded into the QR and shown as the manual link. */
  pairingInfo: string;
  /** Available local sources for the `choice` view (empty for `qr`). */
  sources: PairingSource[];
}

/**
 * The `connection` read-model — a facade over the singleton `WebRTCManager` for the sensor
 * device-pairing button. Reflects live-connection state + drives the React pairing dialog.
 */
export interface EngineConnection {
  /** True when the WebRTCManager is wired (desktop, post-init). */
  available(): boolean;
  /** True when a mobile sensor device is live-connected. */
  isConnected(): boolean;
  /** Open the "Connect External Sensor" pairing modal (QR + link) — the connect-button action. */
  openConnect(): void;
  /** Subscribe to connect/disconnect changes. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Pairing-modal surface (Tier-1 React migration): the React `SensorPairingDialog` reads its view
   *  state + drives the choice/close actions through here instead of the legacy vanilla modal. */
  pairing: {
    /** Subscribe to pairing-modal open/close/view changes. Returns unsubscribe. */
    subscribe(listener: (state: PairingState | null) => void): () => void;
    /** Choice view → "use this connected device": consume the shared local source. */
    useConnectedSource(source: PairingSource): void;
    /** Choice view → "connect a new device": switch to the direct-QR view. */
    connectNewDevice(reconnect: boolean): void;
    /** Dialog dismissed: reset the manager's modal re-entrancy flags. */
    close(): void;
  };
}

/** One audio module slot's monitor readout: the effect's label + its current value mapped into the
 *  module's domain (with units). Mirrors `EffectsRack.getMonitorReadout()` (the single owner of the
 *  value math). */
export interface MonitorSlotReadout {
  /** Slot letter within the axis ('A' | 'B'). */
  slot: string;
  /** The audio module / effect name driven on this axis slot, or null when empty. */
  label: string | null;
  /** The current value in the module's domain (Hz/dB/%/…), or null when unmapped. */
  value: number | null;
  /** The value's units, or null. */
  units: string | null;
  /** The display string (value + units), already formatted. */
  formatted: string;
}

/** One dimension's monitor readout: its label + the per-axis module readouts. */
export interface MonitorDimension {
  dimensionId: string;
  dimensionLabel: string;
  /** Axis key ('x'|'y'|'z') → that axis' slot readouts. */
  axes: Record<string, MonitorSlotReadout[]>;
}

/** The engine monitor across ALL dimensions (the React per-dimension matrix reads this). */
export interface MonitorSnapshot {
  /** The currently active dimension (its row is highlighted in the UI). */
  activeDimensionId: string | null;
  /** Every dimension, in stack order. */
  dimensions: MonitorDimension[];
}

/**
 * The `monitor` read-model — the audio-engine label+value readout PER DIMENSION (the Info panel's
 * Monitor view). It is NOT the x/y/z rotation (that's the knobs); it's the audio parameter each
 * rotation drives, mapped into the effect's domain. A narrow facade over
 * `AudioEngineAdapter.getMonitorSnapshot`, which reads each dimension's racks via the rack's own
 * `getMonitorReadout` (one owner for the value math).
 *
 * `getSnapshot` returns every dimension, but `subscribe` follows the ACTIVE dimension (it keys on the
 * ParameterManager x/y/z changes for `dimensionId = null`, coalesced per frame) plus dimension
 * switches. So the active dimension updates LIVE (knob, MIDI, cosmic, sensor); inactive dimensions in
 * the snapshot refresh on a dimension switch (and on the next active-dim tick), not the instant they
 * change. The Info panel renders the active dimension only, so this is exact for what it shows; a
 * future all-dimensions view would need the subscription broadened to per-(axis,dimension).
 */
export interface EngineMonitor {
  /** True when the audio engine monitor source is wired. */
  available(): boolean;
  /** The per-dimension audio label+value snapshot (empty when not wired). */
  getSnapshot(): MonitorSnapshot;
  /** Subscribe to monitor value changes (coalesced per frame). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** One metadata row in a static Info view: a label and its display value. */
export interface InfoTagRow {
  label: string;
  value: string;
}

/**
 * The `info` read-model — the STATIC metadata rows for the Info panel's non-Monitor views
 * (track / entangled-world / orbiter). A narrow facade over `buildInfoTags` (the row form of the
 * same tag builders the legacy grid uses), reading the loaded the focused orbiter`s `trackData`. The Monitor
 * view is the separate `monitor` surface (live audio values). `subscribe` keys on dimension changes
 * (the orbiter view's axis-module rows follow the active dimension) AND on config updates (a new
 * track/orbiter/world loaded mid-session).
 */
export interface EngineInfo {
  /** Metadata rows for a static info mode ('track' | 'entangled-world' | 'orbiter'); [] if unwired. */
  getTags(mode: string): InfoTagRow[];
  /** Subscribe to info-data changes: an active-dimension switch (orbiter axis rows) or a config
   *  update (a new track/orbiter/world loaded). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/**
 * The injected engine boundary. `params`/`midi`/`dims`/`panels`/`waveform`/`transport`/`cosmic`/
 * `sensors`/`connection`/`monitor`/`info` are present; `scene` (strategy §3) is added as its region
 * lands — kept off this type until then so nothing depends on an unbuilt surface.
 */
export interface EngineContextValue {
  /** The voice this UI is bound to (null for single-orbiter). Lets single-focus surfaces
   *  (e.g. the capture/record dialog) know which tile they belong to. */
  voiceId: string | null;
  params: EngineParams;
  midi: EngineMidi;
  dims: EngineDims;
  panels: EnginePanels;
  waveform: EngineWaveform;
  /** The waveform DATA surface (url/duration/position/seek/loop in seconds) the kit binds to. */
  waveformData: EngineWaveformData;
  transport: EngineTransport;
  sync: EngineSync;
  cosmic: EngineCosmic;
  sensors: EngineSensors;
  connection: EngineConnection;
  monitor: EngineMonitor;
  info: EngineInfo;
}
