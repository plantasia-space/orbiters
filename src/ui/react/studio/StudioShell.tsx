/**
 * @file src/ui/react/studio/StudioShell.tsx
 * @description The Orbiter Studio shell — the top-level edit-mode layout that WRAPS the play
 * UI. The orbiter (canvas + the full live play UI) stays in the LEFT placeholder; the edit panel docks
 * in the RIGHT placeholder (desktop) or opens as a bottom Drawer (mobile).
 *
 * Composed from shared-library components (no re-implemented behavior/layout):
 *  • Desktop — a frosted right rail holding the panel body (dimension tabs + Panel/Engine toggle +
 *    Section/FieldRow content, all from the library).
 *  • Mobile — a persistent `BottomNavBar` (Engine / Panel, icon + label) that toggles the library
 *    `Drawer` to that mode. The Drawer is NON-MODAL (`modal={false}`) + docked `aboveBar`, so the bar
 *    stays visible/interactive: tapping a mode opens it, tapping the other mode SLIDES to it (the drawer
 *    stays open — both modes are mounted as `DrawerPanels`), and re-tapping the active mode (or dragging
 *    the handle down) closes it. Non-modal has no tap-outside.
 *    The bar is PORTALLED to <body> so it out-stacks the body-portalled drawer (bar z 51 > drawer z 50)
 *    and the sheet slides down BEHIND it; in place it would be trapped inside this shell's own fixed,
 *    z-indexed stacking context and the sheet would animate over it.
 *
 * The shell owns the Panel/Engine `mode` (shared by the desktop toggle + the mobile bar) and the canvas
 * reframe: `WorldSceneController.setViewportInset` re-fits renderer size + camera aspect together (no
 * deformation); mobile clears the inset (orbiter full-bleed under the drawer).
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  Drawer, DrawerContent, DrawerTitle, DrawerDescription, DrawerPanels, DrawerPanel,
  BottomNavBar, BottomNavBarItem, useIsMobileNav,
} from 'plantasia.space-design/react';
import {
  applyStudioChromeTheme,
  clearStudioChromeTheme,
  prewarmStudioChromeTheme,
  resetStudioChromeThemeCache,
} from '../../studioChromeTheme.js';
import { useEditPanelState } from '../../../orbiter/edit/react/editPanelState';
import { PANEL_MODES, type PanelMode } from '../../../orbiter/edit/react/ReactEditPanel';

// The desktop rail width (rem). ONE source for the rail's CSS width and the orbiter's right-inset px.
// Wide enough for the 9.75rem label column AND a comfortable control column (so 14px labels and the
// selects/sliders both breathe instead of the controls getting compressed against the labels).
const PANEL_WIDTH_REM = 25;
const PANEL_WIDTH = `${PANEL_WIDTH_REM}rem`;

// The mobile sheet is the disclosure the bottom-bar buttons operate: they carry `aria-controls` +
// `aria-expanded` pointing here, so a screen reader can tell that a mode button opens/closes it.
// One studio shell is mounted at a time, so a constant id is unambiguous.
const SHEET_ID = 'orb-studio-sheet';

export interface StudioShellProps {
  children: ReactNode;
  /** Renders the bridge-backed panel body for a mode; `showToggle` is true only on desktop. */
  renderPanel: (mode: PanelMode, onModeChange: (m: PanelMode) => void, showToggle: boolean) => ReactNode;
}

/** The bar/sheet mode labels, off the shared panel state's `t` (which re-derives on language change). */
function useModeLabels(): Record<PanelMode, string> {
  const t = useEditPanelState()?.t;
  return Object.fromEntries(
    PANEL_MODES.map(({ key, labelKey }) => [
      key,
      t ? t(labelKey) : key.charAt(0).toUpperCase() + key.slice(1),
    ]),
  ) as Record<PanelMode, string>;
}

export function StudioShell({ children, renderPanel }: StudioShellProps) {
  const isMobile = useIsMobileNav();
  const [mode, setMode] = useState<PanelMode>('engine');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const labels = useModeLabels();

  // CHROME theme: the shell panel follows the USER's chosen preset from `/me/users/settings`
  // (`design.theme.id`, matching plantasia.space-root; stale label/variantMap are fallback-only).
  // It is scoped to THIS element so it cannot overwrite the orbiter entity theme used by
  // `.orbiters-react-ui`. The orbiter's own content theme is still saved on the orbiter and remains
  // on the play/orbiter surface.
  // Resolve the chrome theme ONCE, up front, so it's cached and warm before any surface mounts — the
  // apply below then writes it synchronously (no flash, no per-open refetch). See studioChromeTheme.js.
  useEffect(() => {
    prewarmStudioChromeTheme();
  }, []);

  // Each chrome surface registers via a ref-callback and gets the (cached) theme applied on mount.
  // There are up to three: the desktop panel, the mobile bottom SHEET (remounts on every open), and
  // the mobile bottom BAR (was previously left on the default theme). All share the one resolved cache.
  const panelElRef = useRef<HTMLElement | null>(null);
  const barElRef = useRef<HTMLElement | null>(null);
  const makeChromeRef = (ref: MutableRefObject<HTMLElement | null>) =>
    (el: HTMLElement | null) => {
      if (!el) {
        if (ref.current) clearStudioChromeTheme(ref.current);
        ref.current = null;
        return;
      }
      ref.current = el;
      void applyStudioChromeTheme(el).catch(() => {});
    };
  const applyChrome = useCallback(makeChromeRef(panelElRef), []);
  const applyChromeBar = useCallback(makeChromeRef(barElRef), []);

  // In the embedded dashboard the auth token arrives AFTER mount, so the first resolve fetched no
  // settings and surfaces showed the DEFAULT preset. Once the token lands (`loaders.js` dispatches
  // `orbiters:auth-token`), invalidate the cache, re-resolve the user's real preset ONCE, then
  // re-apply to whichever surfaces are currently mounted (panel/sheet + bar).
  useEffect(() => {
    const onAuth = () => {
      resetStudioChromeThemeCache(); // drop the pre-auth DEFAULT; next apply re-resolves the user preset
      if (panelElRef.current) void applyStudioChromeTheme(panelElRef.current).catch(() => {});
      if (barElRef.current) void applyStudioChromeTheme(barElRef.current).catch(() => {});
    };
    document.addEventListener('orbiters:auth-token', onAuth);
    return () => document.removeEventListener('orbiters:auth-token', onAuth);
  }, []);

  useEffect(() => () => {
    clearStudioChromeTheme(panelElRef.current);
    clearStudioChromeTheme(barElRef.current);
  }, []);

  // The mobile sheet's panels SHARE one scroll container (the lib DrawerPanels element owns the
  // vertical scroll so the sheet keeps a constant height). Scrolling deep into a tall mode and then
  // switching would therefore land the next mode at the same scrollTop — partway down, or past the end
  // of a shorter mode, showing blank space. Each mode arrives from its top.
  const panelsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (panelsRef.current) panelsRef.current.scrollTop = 0;
  }, [mode]);

  // Sliding between modes needs BOTH mode bodies mounted — but mounting both on the opening tap put a
  // second full edit-panel build on the interaction path and the sheet visibly lagged the finger. So the
  // tap mounts only the mode it opens, and the other one is built once the browser is idle, before it is
  // ever asked for. The sheet is height-capped (below), so the late arrival can't resize it.
  // The `timeout` is not optional: the orbiter renders continuously, so the main thread is never truly
  // idle and a plain idle callback can be starved indefinitely — the second mode would then still be
  // empty when the bar asks for it. Safari has no requestIdleCallback at all, hence the timer fallback.
  const [bothModesMounted, setBothModesMounted] = useState(false);
  useEffect(() => {
    if (!drawerOpen || bothModesMounted) return undefined;
    const hydrate = () => setBothModesMounted(true);
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(hydrate, { timeout: 500 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(hydrate, 300);
    return () => window.clearTimeout(handle);
  }, [drawerOpen, bothModesMounted]);

  useEffect(() => {
    const setInset = (window as unknown as {
      __orbitersSetViewportInset?: (rightPx: number) => void;
    }).__orbitersSetViewportInset;
    if (typeof setInset !== 'function') return undefined;
    if (isMobile) {
      setInset(0);
      return undefined;
    }
    const rootFontPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    setInset(PANEL_WIDTH_REM * rootFontPx);
    return () => setInset(0);
  }, [isMobile]);

  if (isMobile) {
    return (
      // `data-mobile-bar` marks the branch that renders the bottom bar. The bar itself is PORTALLED to
      // <body> (below), so it is no longer a child of this element — the play grid's bottom clearance
      // keys off this attribute instead of the bar's DOM position.
      <div className="orb-studio" data-mobile-bar="on">
        <div className="orb-studio__stage">{children}</div>
        {/* Library Drawer = real bottom sheet. Non-modal (`modal={false}` + `overlay={false}`) so the
            orbiter + bottom bar behind it stay interactive, and `aboveBar` docks it above the bar so the
            bar stays visible/tappable. Closes via drag-down on the handle OR re-tapping the active mode in
            the bar (non-modal = no tap-outside).
            Both modes are MOUNTED as DrawerPanels: switching Engine <-> Panel keeps the one drawer open and
            slides the content horizontally, and the sheet keeps the height of the tallest panel instead of
            resizing under the finger on every switch. */}
        <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} modal={false}>
          {/* FIXED height, not fit-to-content and not a max: left to itself the sheet sizes to its TALLEST
              mode (the design one), which buries the orbiter — the canvas is not reframed on mobile, so
              whatever the sheet covers is simply hidden. A mere cap wouldn't do either: the sheet would fit
              the short mode on open and then GROW when the tall body mounts. A fixed height is the same
              surface in every mode and at every moment — the short mode (engine) renders complete inside
              it, the tall one scrolls, and the rest of the screen stays orbiter. `dvh` so the mobile
              browser's collapsing chrome doesn't move it under the finger. */}
          <DrawerContent
            ref={applyChrome}
            className="dark"
            aboveBar
            overlay={false}
            id={SHEET_ID}
            style={{ height: '60dvh' }}
          >
            <DrawerTitle className="px-4 pt-1 text-sm font-semibold">{labels[mode]}</DrawerTitle>
            <DrawerDescription className="sr-only">Orbiter {labels[mode]} settings</DrawerDescription>
            {/* `data-vaul-no-drag`: scrolling/dragging inside the panels must not drag the sheet away. */}
            <DrawerPanels ref={panelsRef} active={mode} className="orb-studio__panels" data-vaul-no-drag>
              {PANEL_MODES.map(({ key }) => (
                <DrawerPanel key={key} value={key}>
                  {(key === mode || bothModesMounted) ? renderPanel(key, setMode, false) : null}
                </DrawerPanel>
              ))}
            </DrawerPanels>
          </DrawerContent>
        </Drawer>
        {/* Persistent bottom bar (Engine / Panel) — the toggle for the non-modal drawer, themed (chrome)
            like the sheet so it isn't stuck on the default preset.
            `portal` mounts the bar on <body>, as a SIBLING of the drawer, so the two z-indices compete
            directly (bar `--nav-mobile-bar-z` 51 > drawer 50) and the drawer slides DOWN BEHIND the bar on
            close. Rendered in place it would sit inside `.orb-studio` — a `position: fixed`, z-indexed
            stacking context — which traps it below the body-portalled drawer no matter what z it sets, so
            the sheet animated OVER the bar.
            Tapping a mode opens the drawer to it; tapping the OTHER mode slides to it (drawer stays open);
            tapping the ACTIVE mode closes it — the bar is the close affordance, as a non-modal drawer has
            no tap-outside. */}
        {/* `surface="solid"`: the bar is an opaque chrome shelf, not a translucent pane — the drawer
            slides down behind it and must disappear behind it cleanly, and a blurred/see-through bar over
            a moving orbiter reads as smudge. */}
        <BottomNavBar
          portal
          orientation="bottom"
          surface="solid"
          ref={applyChromeBar}
          className="orb-studio__bar"
        >
          {PANEL_MODES.map(({ key, Icon }) => (
            <BottomNavBarItem
              key={key}
              icon={Icon}
              label={labels[key]}
              aria-current={drawerOpen && mode === key ? 'page' : undefined}
              aria-expanded={drawerOpen && mode === key}
              aria-controls={SHEET_ID}
              className={drawerOpen && mode === key ? 'text-primary' : 'text-muted-foreground'}
              onClick={() => {
                if (drawerOpen && mode === key) { setDrawerOpen(false); return; }
                // Switching modes while OPEN slides one body out and the other in, so BOTH must be
                // mounted for that frame. Idle hydration may not have landed yet (the tap can beat it),
                // and without this the outgoing body would unmount in the very render that mounts the
                // incoming one — sliding a blank panel out.
                if (drawerOpen) setBothModesMounted(true);
                setMode(key);
                setDrawerOpen(true);
              }}
            />
          ))}
        </BottomNavBar>
      </div>
    );
  }

  // Desktop: a frosted right rail holding the panel body (with its in-panel Panel/Engine toggle).
  return (
    <div className="orb-studio">
      <div className="orb-studio__stage">{children}</div>
      <aside ref={applyChrome} className="orb-studio__panel dark surface-frosted" style={{ width: PANEL_WIDTH }}>
        <div className="orb-studio__scroll">{renderPanel(mode, setMode, true)}</div>
      </aside>
    </div>
  );
}
