/**
 * @file src/ui/react/OrbitersUI.tsx
 * @description The single React root for the orbiters UI shell (strategy §5) — the
 * sole UI now (the legacy `.ui-overlay`/WAC chrome has been removed). Renders the
 * React-owned regions inside the EngineProvider, over the Three.js canvas.
 *
 * The root element itself is pointer-transparent; each region opts pointer events
 * back in via `data-ui-interactive`, so clicks pass through to the canvas elsewhere.
 *
 * The dimension selector is a standalone bottom-left region — a
 * column of I/II/III buttons above the transport — not inside the header.
 */
import { useRef } from 'react';
import { IconProvider } from 'plantasia.space-design/icons';
import { EngineProvider } from '../../react/engine/EngineContext';
import type { EngineContextValue } from '../../react/engine/engineTypes';
import { getHerbariumBase } from '../../utils/cdnAssets.js';
import { NumericKeyboardProvider } from '../../react/numeric-keyboard/NumericKeyboardProvider';
import { PortalContainerProvider } from './PortalContainerProvider';
import { RegionErrorBoundary } from './RegionErrorBoundary';
import { GridOverlay } from './regions/GridOverlay';
import { HeaderBar } from './regions/HeaderBar';
import { CameraFocusToggle } from './regions/CameraFocusToggle';
import { DimensionSelector } from './regions/DimensionSelector';
import { LeftRail } from './regions/LeftRail';
import { XYZControls } from './regions/XYZControls';
import { InteractionMenu } from './regions/InteractionMenu';
import { NavViewportProvider, useMeasuredNavViewportState } from './regions/useNavViewportState';
import { PlaybackPanel } from './regions/PlaybackPanel';
import { InfoPanel } from './regions/InfoPanel';
import { InfoPanelStoreProvider } from './regions/InfoPanelStoreContext';
import { MultiOrbiterFocusFrame } from './regions/MultiOrbiterFocusFrame';
import { AttributionSweep } from './regions/AttributionSweep';
import { SensorPairingDialog } from './regions/SensorPairingDialog';
import { CaptureDialog } from './regions/CaptureDialog';
import { LoadMappingsDialog } from './regions/LoadMappingsDialog';
import { ToasterHost } from './ToasterHost';
import { useControlTooltipRegistration } from './regions/useControlTooltips';
import { isStudioEnabled } from './studio/studioMode';
import { StudioShell } from './studio/StudioShell';
import { EditPanelStateProvider } from '../../orbiter/edit/react/editPanelState';
import { ReactEditPanel } from '../../orbiter/edit/react/ReactEditPanel';

export interface OrbitersUIProps {
  engine: EngineContextValue;
}

export function OrbitersUI({ engine }: OrbitersUIProps) {
  // Icon bytes are fetched live from the Herbarium CDN by the design-lib `<Icon>`.
  // The lib's baked `ICON_BASE_URL` points at PRODUCTION herbarium, so in development
  // it serves the stale prod icons instead of the dev ones. Respect the orbiters
  // env var (`VITE_PUBLIC_HERBARIUM_BASE` → dev-herbarium in dev, herbarium in prod —
  // the same source the legacy `cdnAssets` util reads) by overriding the lib base via
  // `IconProvider`. Empty/unset → undefined → the lib's own default (production), so
  // there's no regression when the env var is absent.
  const herbariumBase = getHerbariumBase() || undefined;
  // Register the React controls with the legacy control-tooltip system so hovering a button
  // /knob shows what it is (the legacy boot-time activation only covered the now-hidden legacy chrome).
  const rootRef = useRef<HTMLDivElement>(null);
  useControlTooltipRegistration(rootRef);
  // Measure the play-UI's own box HERE (the ref owner) — a descendant provider can't, because its
  // layout effect runs before this root div's ref is attached. Feeds the discrete responsive state
  // (per-tile in multi-orbiter) down through NavViewportProvider.
  const navViewportState = useMeasuredNavViewportState(rootRef);
  // Each region is isolated: a runtime crash falls back to the legacy chrome
  // mounted underneath (RegionErrorBoundary), so one broken region can't blank
  // the shell or take down its siblings — important while `?ui=react` is still
  // being verified region-by-region.
  // In Studio mode the play UI becomes the LEFT placeholder of the StudioShell (which docks
  // the edit panel on the right). It's still ONE root under the same providers — the shell just wraps
  // the play regions; the edit panel inherits EngineProvider / Icon / theme / NumericKeyboard.
  // Play mode renders the play shell full-screen exactly as before.
  const studio = isStudioEnabled();
  const playShell = (
    <div className="orbiters-react-ui" data-ui-react-region="root" ref={rootRef}>
        {/* Responsive state is measured against THIS tile's box (rootRef), so the discrete
            breakpoints (action-group collapse, dimension tabs, desktop-only chrome) track the tile
            the same way the continuous cq sizing does — a small multi-orbiter tile collapses like a
            small window instead of inheriting the whole window's desktop state. */}
        <NavViewportProvider value={navViewportState}>
          {/* Focused-tile marker in the multi-orbiter view — the design-kit corner brackets on the
              focused tile only (renders nothing in single-orbiter). Pointer-transparent overlay.
              Boundaried like the real regions: a lib render throw drops only the marker, not the tile. */}
          <RegionErrorBoundary region="MultiOrbiterFocusFrame">
            <MultiOrbiterFocusFrame />
          </RegionErrorBoundary>
          {/* Debug-only: a visible tint of the named grid areas (`?grid=1`). Direct grid
              children so they line up with the regions. Off by default, pointer-transparent. */}
          <GridOverlay />
          <RegionErrorBoundary region="HeaderBar">
            <HeaderBar />
          </RegionErrorBoundary>
          {/* XYZControls renders the per-axis cosmic stack inline (gated to the
              COSMIC_LFO panel), mirroring the legacy `.xyz-column` — so there is no
              separate Cosmic region to mount. */}
          <RegionErrorBoundary region="XYZControls">
            <XYZControls />
          </RegionErrorBoundary>
          {/* The bottom-LEFT button column, answering the panel stack in the bottom right: what
              you are looking AT (the dimensions, and which body the camera orbits) against what
              you are playing WITH. Four buttons each side, one grid of identical cells — which is
              why the dimensions no longer size themselves to their own numerals ("I" is not "III").
              The camera sits at the FOOT of the column: the dimensions are a one-of-N choice and
              read as a set, so the odd one out belongs at the end, not in the middle of them. */}
          <div className="orbiters-react-ui__view-rail" data-ui-react-region="view-rail">
            <RegionErrorBoundary region="DimensionSelector">
              <DimensionSelector />
            </RegionErrorBoundary>
            <RegionErrorBoundary region="CameraFocusToggle">
              <CameraFocusToggle />
            </RegionErrorBoundary>
          </div>
          {/* Playback owns distinct bottom-area DOM (the waveform + zoom strip), so it
              is its OWN region — gated internally to the `playback` panel. */}
          <RegionErrorBoundary region="PlaybackPanel">
            <PlaybackPanel />
          </RegionErrorBoundary>
          {/* Right rail: the volume fader (grows to fill) stacked above the interaction
              menu (pinned to the bottom), as ONE column spanning the middle+bottom grid rows. This
              decouples the right column from the CENTER column's height — when the Cosmic LFO stack
              makes the center tall, the fader uses the right column's freed vertical space instead of
              being squeezed by the shared middle row (Bruna). */}
          <div className="orbiters-react-ui__right-rail" data-ui-react-region="right-rail">
            <RegionErrorBoundary region="LeftRail">
              <LeftRail />
            </RegionErrorBoundary>
            <RegionErrorBoundary region="InteractionMenu">
              <InteractionMenu />
            </RegionErrorBoundary>
          </div>
          {/* Phase 2: the Info panel (Engine Monitor / Track / World / Orbiter) — a top slide-down
              overlay opened from the header Information menu, replacing the legacy info grid. */}
          <RegionErrorBoundary region="InfoPanel">
            <InfoPanel />
          </RegionErrorBoundary>
          {/* In the capture window, auto-sweep the credits (Track/World/Orbiter) into the
              recorded video when capture starts, then return to the engine view. No-op elsewhere. */}
          <AttributionSweep />
        </NavViewportProvider>
        </div>
  );

  return (
    <EngineProvider value={engine}>
      <IconProvider baseUrl={herbariumBase}>
        {/* The per-voice, orbiter-themed portal container. Every orbiter chrome portal
            (keypad, menus, tooltips, dialogs) renders into it so it carries the ORBITER's theme,
            not the host page's (the feed realm's root/user theme). Inside EngineProvider so it can
            read `voiceId`; wraps the keypad + dialogs so they can consume it. */}
        <PortalContainerProvider>
        <NumericKeyboardProvider>
          {/* Per-voice Info-panel (Engine Monitor / "Monitor Control") open-state. Scoped to
              THIS OrbitersUI root so each multi-orbiter tile toggles its monitor independently. The
              producer (HeaderBar menu) + consumers (InfoPanel, AttributionSweep) all read this one
              store. Wraps the whole shell incl. the portal'd dialogs (harmless — they don't use it). */}
          <InfoPanelStoreProvider>
            {studio ? (
              // ONE edit-bridge subscription for the whole studio, above the shell: mobile mounts BOTH
              // sheet modes so they can slide, and the panel state must not be built twice (nor the
              // shell's mode labels a third time). The bodies below are pure presentation off it.
              <EditPanelStateProvider>
                <StudioShell
                  renderPanel={(mode, onModeChange, showModeToggle) => (
                    <ReactEditPanel mode={mode} onModeChange={onModeChange} showModeToggle={showModeToggle} />
                  )}
                >
                  {playShell}
                </StudioShell>
              </EditPanelStateProvider>
            ) : (
              playShell
            )}
            {/* App-wide pairing dialog (Tier-1 migration): a portal'd Dialog driven by the
                `connection.pairing` surface. Outside the per-region boundaries since it isn't a
                grid region — it overlays the whole shell when the manager opens it. */}
            <SensorPairingDialog />
            {/* App-wide capture-format dialog (RECORD flow): a portal'd Dialog opened by the Transport
                RECORD button via `captureDialogStore`; picks the aspect, then opens the capture window. */}
            <CaptureDialog />
            {/* App-wide load-saved-MIDI-mappings dialog: a portal'd Dialog opened by the
                MIDI-mode header "Open" button via `loadMappingsDialogStore`. */}
            <LoadMappingsDialog />
            {/* App-wide toaster (Tier-1 migration): mounts sonner + registers the sink that
                `AppNotifications.showToast` forwards to when the shell is up. */}
            <ToasterHost />
          </InfoPanelStoreProvider>
        </NumericKeyboardProvider>
        </PortalContainerProvider>
      </IconProvider>
    </EngineProvider>
  );
}
