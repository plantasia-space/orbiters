/**
 * @file src/ui/react/regions/HeaderBar.tsx
 * @description The header / top-bar region (strategy §5, reuse-map "Header / top
 * bar"). Reproduces index.html's `<header class="ui-shell__top">` three-column
 * anatomy via the lib `HeaderShell` (left actions / centered brand / right actions):
 *
 *   LEFT  — information dropdown (ActionButtonGroup), the sync stack (BPM Param +
 *           SYNC toggle), and the dimension selector.
 *   BRAND — the responsive title (the active panel name).
 *   RIGHT — calibrate, connection status, loop toggle, and the "more" dropdown.
 *
 * WIRED NOW:
 *   - sync BPM  → `sync-bpm` PM param via ParameterizedParam (20..300).
 *   - SYNC enable → the `sync` surface (SyncCoordinator enable/disable + status event).
 *   - dimension → the `dims` surface (reuses the existing DimensionSelector region).
 *   - title     → the active panel label via the `panels` surface.
 *   - calibrate / connection → the `sensors` / `connection` surfaces.
 *
 * The info & more dropdown ACTIONS run directly in React via `headerActions` (no legacy DOM):
 * info = telemetry + the React InfoPanel; more = MIDI-learn / tooltips / share / fullscreen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HeaderShell,
  ActionButtonGroup,
  CornerButton,
  type ActionOption,
} from 'plantasia.space-design/react';
import { QuantizeMenu } from 'plantasia.space-design/react/timeline/components/quantize-menu';
import { QUANTIZE_PRESETS, quantizeStepBeats, type QuantizeGridId } from 'plantasia.space-design/react/timeline/quantize';
import { Icon } from 'plantasia.space-design/icons';
import { FolderOpen } from 'lucide-react';
import { ParameterizedParam, useTrigger, useToggle } from '../../../react/parameters';
import { isAutofocusEnabled, setAutofocusEnabled } from '../../../input/midi/autofocusSettings.js';
import { openLoadMappingsDialog } from './loadMappingsDialogStore';
import {
  useEngineSensors,
  useEngineConnection,
  useEngineMidi,
  useEngineSync,
  useEngineVoiceId,
} from '../../../react/engine/EngineContext';
import { Transport } from './Transport';
import { SyncSettingsMenu } from './SyncSettingsMenu';
import { LoginPrompt } from './LoginPrompt';
import { RegionErrorBoundary } from '../RegionErrorBoundary';
import { useActivePanel } from './useActivePanel';
import { useNavViewportState } from './useNavViewportState';
import { handleInfoAction, handleMoreAction } from './headerActions';
import { isInfoMode } from './infoPanelStore';
import { useInfoPanelStore } from './InfoPanelStoreContext';
import { useEngineSubscription } from '../../../react/engine/useEngineSubscription';
import { useTooltipsEnabled } from './useControlTooltips';
import { MIDI_SUPPORTED } from '../../../config/Constants.js';
import { deckFor } from '../../../voice/Deck.js';
import { broadcastAction } from '../../../multi/multiFocusBroadcast.js';
import { getT } from '../../../i18n/index.js';
import { usePortalContainer } from '../PortalContainerProvider';

// Launch-quantize grid lives in bars (launchGrid.js); the lib picker speaks quantize-grid ids. Ask the
// design-lib helper for a 1-beat "bar" so its returned step is the bar ratio (2, 1, 0.5, ...).
const LAUNCH_BAR_UNITS = 1;
const launchGridIdForBars = (bars: number): QuantizeGridId => {
  if (!(bars > 0)) return 'none'; // 0 / non-positive = no snap
  let best: QuantizeGridId = '1bar';
  let bestErr = Number.POSITIVE_INFINITY;
  for (const p of QUANTIZE_PRESETS) {
    const b = quantizeStepBeats(p.id, LAUNCH_BAR_UNITS);
    if (b == null) continue;
    const err = Math.abs(b - bars);
    if (err < bestErr) {
      bestErr = err;
      best = p.id;
    }
  }
  return best;
};

// Each menu item carries its icon (matching the design-lib playground reference) — the
// lib renders the icon to the LEFT of the label, so the menu reads as the real corner
// menu rather than a bare text list. Icon names resolve from the herbarium manifest.
// Label text comes from i18n at RENDER time (built inside the component below) — module-level
// constants would capture `t` before/around i18n init. Icons + value/kind are static.
const INFO_OPTION_DEFS = [
  { value: 'monitor', labelKey: 'topBar.menu.engineMonitor', kind: 'select', icon: <Icon name="control-monitor" /> },
  { value: 'track', labelKey: 'topBar.menu.track', kind: 'select', icon: <Icon name="track" /> },
  { value: 'entangled-world', labelKey: 'topBar.menu.entangledWorld', kind: 'select', icon: <Icon name="entangled-world" /> },
  { value: 'orbiter', labelKey: 'topBar.menu.orbiter', kind: 'select', icon: <Icon name="orbiter" /> },
] as const;

// `midi` is a momentary ACTION (enter MIDI-learn), NOT a `select` — `select` rendered it as
// the highlighted/active item (green icon + text). As an `action` it reads like Share/Fullscreen
// (default icon + white text). `tooltips` is a toggle; its `checked` is injected live below.
// Labels resolved from i18n at render (see HeaderRightActions). The `midi` entry is gated on
// `MIDI_SUPPORTED` (Web MIDI present) — omitted entirely on devices/browsers without it (most phones),
// mirroring the legacy `disableMidiUIForUnsupportedEnv` DOM prune. Web MIDI access (MIDIController) is
// itself only constructed on first MIDI-learn entry, so dropping the button means no MIDI runtime is
// ever reached on unsupported devices.
const MORE_OPTION_DEFS = [
  { value: 'midi', labelKey: 'topBar.moreMenu.midi', kind: 'action', icon: <Icon name="midi" />, midiGated: true },
  { value: 'tooltips', labelKey: 'topBar.moreMenu.tooltips', kind: 'toggle', icon: <Icon name="tooltip" /> },
  { value: 'share', labelKey: 'topBar.moreMenu.share', kind: 'action', icon: <Icon name="share" /> },
  { value: 'fullscreen', labelKey: 'topBar.moreMenu.fullscreen', kind: 'action', icon: <Icon name="fullscreen" /> },
] as const;

/** The sync stack: shared BPM (PM param) above the SYNC enable button — a 2-row
 *  stack mirroring the legacy `.sync-stack` (BPM readout + the "SYNC" text button,
 *  NOT a toggle dot). */
function SyncStack() {
  const sync = useEngineSync();
  const { isMobile } = useNavViewportState();
  const [syncOn, setSyncOn] = useState(() => sync.isEnabled());
  // Session size = other tabs' synced VOICES + in-tab synced sibling voices. Cross-tab is a sum of
  // announced voice-counts (not a connection count), so a remote multi-orbiter tab contributes its true
  // N. Both are re-read on the status event, which also fires when any sibling toggles its own sync
  // (notifyVoiceSyncChanged) or a peer's announced count changes.
  const [remoteSynced, setRemoteSynced] = useState(() => sync.remoteSyncedVoiceCount());
  const [inTabSynced, setInTabSynced] = useState(() => sync.inTabSyncedCount());
  // Launch-quantize grid picker — always visible, and PER-DECK (like meter): each player owns its
  // launch grid on its deck; this tile's picker reads/writes only THIS voice's deck and follows it
  // live through the deck's change stream.
  const voiceId = useEngineVoiceId();
  const [launchGridId, setLaunchGridId] = useState<QuantizeGridId>(
    () => launchGridIdForBars(deckFor(voiceId)?.launchGridBars ?? 0),
  );
  const portalContainer = usePortalContainer();
  useEffect(() => {
    const deck = deckFor(voiceId);
    if (!deck) return undefined;
    setLaunchGridId(launchGridIdForBars(deck.launchGridBars));
    return deck.onChange((_snapshot: unknown, reason: string) => {
      if (reason === 'launch-grid') setLaunchGridId(launchGridIdForBars(deck.launchGridBars));
    });
  }, [voiceId]);
  const onLaunchGridChange = useCallback((id: QuantizeGridId) => {
    // 'none' resolves to null → 0 = no snap (launch fires immediately); else the grid in bars.
    const bars = quantizeStepBeats(id, LAUNCH_BAR_UNITS);
    const value = bars == null ? 0 : bars;
    deckFor(voiceId)?.setLaunchGridBars(value);
    // Multi-focus gang: with several players focused, a grid pick applies to every selected deck
    // (same Decision-004 machinery as the other ganged actions; sibling pickers follow via their
    // own deck change streams).
    broadcastAction(voiceId, 'deck', 'setLaunchGridBars', [value]);
  }, [voiceId]);
  // Reflect the REAL tempo-sync engine state, re-reading on the status event (so the button tracks
  // enable/disable from MIDI, a remote peer, or a failed connect — not an optimistic local flip).
  useEffect(() => {
    const read = () => {
      setSyncOn(sync.isEnabled());
      setRemoteSynced(sync.remoteSyncedVoiceCount());
      setInTabSynced(sync.inTabSyncedCount());
    };
    read();
    return sync.subscribe(read);
  }, [sync]);
  // Total participants when THIS tile is synced: in-tab synced voices (incl. self) + other tabs' synced
  // voices. Shown only when ≥2 (a real partner present) — otherwise the bare "SYNC" label (solo / off).
  // Every client sums the same announced voice-counts, so all badges agree on the true total.
  const sessionCount = syncOn && inTabSynced + remoteSynced >= 2 ? inTabSynced + remoteSynced : 0;
  const onSyncEnable = useCallback(() => {
    // enable() can fail silently (the transport adapter won't connect → no status event), so re-read
    // the real state after toggling rather than assuming it took. The status event corrects it too.
    sync.setEnabled(!sync.isEnabled());
    setSyncOn(sync.isEnabled());
  }, [sync]);
  // MIDI-learn target: a latching toggle so a hardware control can enable/disable SYNC. Same owner
  // (onSyncEnable) drives both the click and the learned MIDI press. (The shared BPM control is its
  // own `sync-bpm` value target.)
  //
  // `scope: 'GLOBAL'` here means NON-LAYERED (sync is not a per-axis-per-dimension control),
  // NOT "routes to every voice". The MIDI TARGET is already ORBITER-OWNED / per-voice: `useToggle`
  // threads this tile's `voiceId` (via `useEngineVoiceId`) onto the binding. Inbound MIDI fires THIS
  // tile's registered toggle ACTION (`_toggleActions.handle` → `onToggle` → this tile's sync view) —
  // NOT a PM value write — and the learned mapping persists under the tile's own orbiterId (Pieces
  // 1+2; verified at N=2). The BPM value-param below instead routes its inbound value to
  // `_pmForVoice(voiceId)`. Do NOT change this to a layered/DIMENSION scope to make it "per-voice" —
  // it already is.
  const syncMidi = useToggle({
    componentId: 'sync-enable',
    scope: 'GLOBAL',
    value: syncOn,
    onToggle: () => onSyncEnable(),
  });
  return (
    <div className="orbiters-react-ui__sync-row" data-ui-interactive>
      <div className="orbiters-react-ui__sync-stack">
      {/* The deck's BPM number → `sync-bpm` PM param (20..300). Bidirectional display: a synced tile
          shows/edits the shared master, an unsynced tile shows/edits ITS OWN tempo (routing lives in
          the AudioEngineAdapter mirror+bridge). `midi.scope: 'GLOBAL'` = NON-LAYERED (see the
          sync-enable note above); the target is already per-voice / orbiter-owned via the voiceId
          `ParameterizedParam` threads onto the binding. */}
      <ParameterizedParam
        rootParam="sync-bpm"
        label="BPM"
        min={20}
        max={300}
        precision={1}
        aria-label={syncOn ? 'Shared BPM' : 'BPM'}
        midi={{ componentId: 'sync-bpm', scope: 'GLOBAL' }}
      />
      <button
        type="button"
        className="orbiters-react-ui__sync-btn"
        data-active={syncOn || undefined}
        {...syncMidi.midiProps}
        onClick={onSyncEnable}
        aria-pressed={syncOn}
        aria-label={sessionCount > 0 ? `SYNC — ${sessionCount} in session` : 'SYNC'}
      >
        SYNC
        {sessionCount > 0 && (
          <span className="orbiters-react-ui__sync-count" aria-hidden="true">
            {sessionCount}
          </span>
        )}
      </button>
      </div>
      {/* Mobile: move launch-grid into the sync settings popover to free one header slot. */}
      {!isMobile && (
        <QuantizeMenu
          value={launchGridId}
          onValueChange={onLaunchGridChange}
          heading="Launch grid"
          aria-label="Launch grid"
          container={portalContainer}
        />
      )}
      {/* Per-device sync settings: the manual audio offset lives here. Always available —
          it's a device latency calibration you may dial before joining a session. */}
      <SyncSettingsMenu />
    </div>
  );
}

/** A reliable click-to-EXIT for MIDI-learn mode. Hidden until `body.midi-learn-mode` is
    active (CSS), so it appears only while learning; clicking it tears the learn overlays down via
    the `midi` surface. It carries NO `data-automatable`, so the learn overlay never covers it and
    the click exits instead of starting a mapping. */
function MidiLearnExitButton() {
  const midi = useEngineMidi();
  return (
    <button
      type="button"
      className="orbiters-react-ui__midi-exit"
      onClick={() => midi.exitLearnMode()}
      aria-label="Exit MIDI learn mode"
      title="Exit MIDI learn"
    >
      ✕
    </button>
  );
}

/** The Autofocus toggle. A text-word button mirroring the SYNC button's style
    (`data-active` drives the pressed look). Shown only while `body.midi-learn-mode` is active
    (CSS). Carries NO `data-automatable`, so it isn't a MIDI-learn target. Per-device localStorage,
    default ON. */
function AutofocusToggleButton() {
  const t = getT();
  const [on, setOn] = useState<boolean>(() => isAutofocusEnabled());
  return (
    <button
      type="button"
      className="orbiters-react-ui__autofocus-btn"
      data-active={on || undefined}
      onClick={() => setOn(setAutofocusEnabled(!on))}
      aria-pressed={on}
      aria-label={t('autofocus.label')}
      title={t('autofocus.tooltip')}
    >
      {t('autofocus.label')}
    </button>
  );
}

/** The "Open saved mappings" button. Opens the load-saved-MIDI-mappings dialog. Shown only
    while `body.midi-learn-mode` is active (CSS); carries NO `data-automatable`, so it isn't a
    MIDI-learn target. */
function OpenMappingsButton() {
  const t = getT();
  return (
    <button
      type="button"
      className="orbiters-react-ui__midi-open-btn"
      onClick={() => openLoadMappingsDialog()}
      aria-label={t('midiLoad.openTitle')}
      title={t('midiLoad.openTitle')}
    >
      <FolderOpen size={18} aria-hidden="true" />
    </button>
  );
}

/** Calibration — resets the device-orientation baseline. A momentary KICK. Shown when the
    Sensors panel is active (both desktop + mobile). Wired to the `sensors` surface.
    MIDI-learn target: mirrors the transport play/stop wiring — `useTrigger` registers
    the GLOBAL momentary `sensor-calibration` key (added to stackUtils) and spreads the learn DOM
    attrs onto the button, so a hardware control can be bound to re-zero the sensors. The same
    `onCalibrate` owner drives both the click and the learned MIDI trigger. */
function SensorCalibrationButton() {
  const sensors = useEngineSensors();
  const t = getT();
  const calibrateLabel = t('topBar.calibrateSensor');
  const onCalibrate = useCallback(() => {
    sensors.calibrate();
  }, [sensors]);
  const { midiProps } = useTrigger({
    componentId: 'sensor-calibration',
    scope: 'GLOBAL',
    onTrigger: onCalibrate,
  });
  return (
    <CornerButton
      kind="kick"
      icon={<Icon name="calibrate" />}
      aria-label={calibrateLabel}
      title={calibrateLabel}
      className="orbiters-react-ui__header-corner-btn"
      {...midiProps}
      onClick={onCalibrate}
    />
  );
}

/** Device connection — pair a phone's motion sensors to the desktop session. A TOGGLE whose
    state reads success/green (connected) vs destructive/red (disconnected). Shown when the
    Sensors panel is active AND on DESKTOP only (you pair a device FROM the desktop; on mobile
    this device IS the sensor). State + action deferred. */
function SensorConnectionButton() {
  // Reflect the REAL WebRTC connection state (the button showed "disconnected" while
  // connected because it was hardcoded). Read `connection.isConnected()` and re-read on the
  // `orbiters:connection-changed` event (data-channel open/close, ICE failure, the modal).
  const connection = useEngineConnection();
  const [connected, setConnected] = useState<boolean>(() => connection.isConnected());
  useEffect(() => {
    setConnected(connection.isConnected());
    return connection.subscribe(() => setConnected(connection.isConnected()));
  }, [connection]);
  const onToggle = useCallback(() => {
    // Matches the legacy connect button: clicking opens the "Connect External Sensor" pairing
    // modal (QR + link). Disconnect happens via the modal / connection loss, not a force-toggle.
    connection.openConnect();
  }, [connection]);
  // success (connected) vs destructive (disconnected) — drives the icon + the corner ink.
  const stateColor = connected ? 'var(--success)' : 'var(--destructive)';
  return (
    <CornerButton
      kind="toggle"
      pressed={connected}
      onPressedChange={onToggle}
      icon={<Icon name={connected ? 'ext-mobile-connect' : 'ext-mobile-disconnect'} />}
      aria-label={connected ? 'Device connected' : 'Device disconnected'}
      title={connected ? 'Device connected' : 'Device disconnected'}
      className="orbiters-react-ui__header-corner-btn"
      data-connected={connected || undefined}
      style={{ color: stateColor, ['--corner-active' as string]: stateColor }}
    />
  );
}

/**
 * The right-side header actions: the sensor CALIBRATION + device-CONNECTION buttons (only with the
 * Sensors panel active), then the "more" (…) menu. (The loop toggle moved into the transport group
 * in the header centre — Bruna's mockup.) The sensor buttons are the lib `CornerButton`;
 * the "more" menu is the lib's ActionButtonGroup.
 */
function HeaderRightActions() {
  // The two sensor controls appear only with the SENSORS panel active. Connection is
  // desktop-only (you pair a mobile device FROM the desktop); calibration shows on both.
  const sensorsActive = useActivePanel()?.action === 'sensors';
  const { isMobile } = useNavViewportState();

  // Reflect the live tooltips on/off flag as the toggle's check (the tooltips module emits
  // `orbiters:tooltips-changed`). Clicking it routes through `handleMoreAction` → `toggleControlTooltips()`,
  // so the menu and the `t` shortcut converge.
  const tooltipsOn = useTooltipsEnabled();
  const t = getT();
  const portalContainer = usePortalContainer();
  // This tile's own voice, so the MORE→fullscreen action fullscreens THIS voice's cell (not
  // the active tile, not root's whole page). Null single-orbiter → headerActions uses the active voice.
  const voiceId = useEngineVoiceId();
  const onMoreAction = useCallback((value: string) => handleMoreAction(value, voiceId), [voiceId]);
  const moreOptions = useMemo<ActionOption[]>(
    () =>
      MORE_OPTION_DEFS
        .filter((d) => !('midiGated' in d && d.midiGated) || MIDI_SUPPORTED)
        .map((d) => ({
          value: d.value,
          label: t(d.labelKey),
          kind: d.kind,
          icon: d.icon,
          ...(d.value === 'tooltips' ? { checked: tooltipsOn } : {}),
        })) as ActionOption[],
    [tooltipsOn, t],
  );

  return (
    <div className="orbiters-react-ui__header-right-actions" data-ui-interactive>
      {/* A reliable click way OUT of MIDI-learn mode (the legacy more→close swap never
          worked). Always rendered but only shown while learn mode is active (CSS
          `body.midi-learn-mode`); it is NOT a MIDI-learn target, so its click exits rather than
          starting a new mapping. */}
      <MidiLearnExitButton />
      {/* The MIDI-mode header controls (Autofocus, Open mappings). Both render unconditionally but are shown
          only while `body.midi-learn-mode` is active (CSS), and neither is a MIDI-learn target. */}
      <AutofocusToggleButton />
      <OpenMappingsButton />
      {/* The sensor controls show only with the Sensors panel active, but each lives in a
          fixed-size placeholder slot so the right cluster keeps a constant footprint — the
          buttons fade in/out without shifting the More menu (Bruna: coherent placeholders).
          Calibrate reserves its slot on every viewport; connection is desktop-only (you pair a
          device FROM the desktop), so its slot only exists off-mobile. */}
      <span className="orbiters-react-ui__header-slot">
        {sensorsActive && <SensorCalibrationButton />}
      </span>
      {!isMobile && (
        <span className="orbiters-react-ui__header-slot">
          {sensorsActive && <SensorConnectionButton />}
        </span>
      )}
      {/* Login nudge (Tier-1): sits immediately to the LEFT of the ⋯ (more) button — the last item
          in the right cluster before More. Renders null unless an auth flow triggers it. */}
      <LoginPrompt />
      {/* The more-menu actions (midi / tooltips / share / fullscreen) run directly in React
          (headerActions) — MIDI-learn enter, tooltips toggle, share-link copy, fullscreen. Every
          option kind (select/toggle/action) lands on the same dispatch. "midi" ENTERS MIDI-learn
          mode; the exit affordance is the learn-mode button below. */}
      <ActionButtonGroup
        options={moreOptions}
        triggerIcon={<Icon name="more" />}
        showSelectedAsIcon={false}
        align="end"
        onChange={onMoreAction}
        onToggle={onMoreAction}
        onTrigger={onMoreAction}
        aria-label={t('topBar.moreOptions')}
        container={portalContainer}
      />
    </div>
  );
}

export function HeaderBar() {
  // The info corner's collapsed trigger shows the SELECTED view's icon (e.g. choose "Entangled World"
  // → the trigger shows the world icon), so we track the last-chosen view for the trigger glyph —
  // it persists even when the panel is toggled closed. Default to the monitor view.
  const [infoView, setInfoView] = useState('monitor');
  // The Information dropdown is a single-select TOGGLE (Bruna) — there's no ✕; the panel
  // is closed by re-selecting its active view. Subscribe to the open/active mode so the menu's
  // active-highlight tracks the OPEN view (and shows NONE when the panel is closed).
  // The Info-panel ("Monitor Control") open-state is now PER-VOICE (this tile's store).
  const infoStore = useInfoPanelStore();
  useEngineSubscription(infoStore);
  const openInfoMode = infoStore.getMode();
  const portalContainer = usePortalContainer();
  // Resolve menu labels from i18n at render (module-level constants would capture `t` around init).
  const t = getT();
  const infoOptions = useMemo<ActionOption[]>(
    () => INFO_OPTION_DEFS.map((d) => ({ value: d.value, label: t(d.labelKey), kind: d.kind, icon: d.icon })) as ActionOption[],
    [t],
  );
  // The trigger keeps the last-chosen view's glyph regardless of open/closed (the menu, via `value`,
  // carries the on/off highlight). Falls back to the monitor icon if the view ever has no def.
  const infoTriggerIcon = useMemo(
    () => infoOptions.find((o) => o.value === infoView)?.icon ?? infoOptions[0]?.icon,
    [infoOptions, infoView],
  );

  return (
    <div className="orbiters-react-ui__header" data-ui-interactive data-ui-react-region="header">
      <HeaderShell
        surface="glass"
        left={
          <div className="orbiters-react-ui__header-left">
            {/* Information dropdown (legacy leftmost `[data-group="information-dropdown"]`).
                Shown (not dimmed) so the button is present; actions deferred. */}
            <ActionButtonGroup
              options={infoOptions}
              // `value` drives the MENU's active-highlight: the OPEN view (none when the panel is
              // closed). The trigger glyph is supplied separately so it always shows a view icon.
              value={openInfoMode ?? ''}
              triggerIcon={infoTriggerIcon}
              placement="bottom"
              align="start"
              aria-label={t('topBar.informationToggle')}
              container={portalContainer}
              // Use onTrigger (fires on EVERY selection), NOT onChange (the lib only fires onChange
              // when the value CHANGES). Single-select TOGGLE — re-selecting the view that's
              // already open CLOSES the panel (setMode null); selecting a different view switches
              // to it. Only one of the four can be open at a time.
              onTrigger={(v) => {
                setInfoView(v); // trigger reflects the chosen view's icon (persists when closed)
                if (!isInfoMode(v)) return;
                const willOpen = infoStore.getMode() !== v;
                infoStore.setMode(willOpen ? v : null);
                // Telemetry is a "viewed" event — emit only when OPENING, not when toggling closed.
                if (willOpen) handleInfoAction(v);
              }}
            />
            <SyncStack />
            {/* The dimension selector moved OUT of the header (it crowded the mobile top
                bar + had no room to expand in learn mode) → standalone bottom-left button column
                (see OrbitersUI / DimensionSelector). */}
          </div>
        }
        brand={
          // Own error boundary: a Transport crash must NOT take down the whole header (it lives in
          // the brand slot now, not a top-level region) — fall back to the legacy chrome for it alone.
          <RegionErrorBoundary region="Transport">
            <Transport />
          </RegionErrorBoundary>
        }
        right={<HeaderRightActions />}
      />
    </div>
  );
}
