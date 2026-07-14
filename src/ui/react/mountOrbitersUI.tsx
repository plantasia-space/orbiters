/**
 * @file src/ui/react/mountOrbitersUI.tsx
 * @description The single mount point for the orbiters React-UI shell — the sole UI
 * (the legacy `.ui-overlay` / WAC chrome has been removed). React renders its owned
 * regions into one root appended to `document.body`, over the Three.js canvas.
 *
 * Responsibilities (kept minimal — this is the boundary, not a region):
 *   1. Import the design-lib's compiled Tailwind ONCE (styles.css) + the shell's
 *      overlay CSS. No orbiters-side Tailwind toolchain (strategy §9 decision).
 *   2. Build the typed `EngineContext` from the real singletons via
 *      `resolveEngineContext` (the DI boundary) — React code never touches them.
 *   3. createRoot into a dedicated host element and render <OrbitersUI>.
 *
 * Dynamically imported from Main.js so React stays out of the bundle unless the
 * flag is set (mirrors mountReactEditPanel's lazy-import pattern).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The design-lib's self-contained compiled Tailwind. Imported ONCE here (the
// shell root) so every lib control downstream is styled. Do NOT re-import Tailwind.
import 'plantasia.space-design/styles.css';
import './orbitersUI.css';
import { OrbitersUI } from './OrbitersUI';
import { resolveEngineContext } from './resolveEngineSingletons';
import { warnOnMissingExpectedSurfaces } from './engineResolution';
import type { RawParameterManager } from '../../react/engine/createEngineContext';

const HOST_ID = 'orbiters-react-ui-root';

/**
 * The body data-attribute the legacy-hide CSS keys on. When the shell is mounted
 * we set `data-ui-react="on"` on <body>; `orbitersUI.css` then hides ONLY the
 * legacy `data-ui-region` blocks the React shell has replaced (top / left-rail /
 * bottom-center / bottom-transport / bottom-interaction). Everything else legacy
 * — modals, MIDI overlays, the floating edit panel, waveform/zoom — stays
 * mounted AND visible (compatibility shell, strategy §2.3). Pure CSS gate: NOT
 * deleting legacy, and removed again on unmount so a non-react re-bootstrap is clean.
 */
const UI_REACT_BODY_ATTR = 'data-ui-react';

/**
 * The design-lib themes light/dark via a `.dark` class on an ancestor (tokens.css
 * `.dark { … }` + the `&:is(.dark *)` Tailwind variant). The orbiters play UI is
 * light-on-dark (black canvas, white-ish ink), so the shell runs the lib in dark
 * mode. We add `dark` to `documentElement` (not just the shell root) so lib
 * content that PORTALS to `<body>` — dropdowns, the interaction drop-up, dialogs,
 * MIDI overlays — gets the right light/dark base. The brand-primitive aliases are
 * NOT on `:root`: the orbiter theme lives on `.orbiters-react-ui` (+ the play-UI
 * `[data-slot="action-button-group-content"]` portals), and the Studio chrome theme
 * on `.orb-studio__panel` / `.orb-studio__portal-surface` (orbitersUI.css +
 * studioChromeTheme.js) — so each body-portalled surface carries its own scope and
 * only needs the `.dark` ancestor here. Legacy chrome doesn't read lib tokens, so
 * this is inert for it. The shell OWNS this class exclusively (orbiters sets `.dark`
 * nowhere else), so it's added on mount and removed on unmount unconditionally.
 */
const DARK_CLASS = 'dark';

type HostWithCleanup = HTMLElement & { __orbitersCleanup?: () => void };

export interface OrbitersUIHandle {
  unmount: () => void;
}

export interface MountOrbitersUIOptions {
  /** The real ParameterManager (`parameterManager`), passed in from Main.js. */
  parameterManager: RawParameterManager;
  /** Where to append the React root. Defaults to document.body (single-orbiter). */
  container?: HTMLElement;
  /**
   * Bind this UI to a specific roster voice. Omit → the focused voice (single-orbiter,
   * byte-identical). A multi-orbiter per-tile mount passes its own voiceId so the host id is unique
   * (no last-writer-wins teardown) and the engine context reads THIS voice.
   */
  voiceId?: string;
  /**
   * Whether this mount owns the realm-global side effects (the `data-ui-react` body attr + the `.dark`
   * class on documentElement). Single-orbiter (no container) always owns them; in a multi grid exactly
   * ONE voice (the primary) should, so a sibling tile's unmount can't strip them from the others.
   */
  isPrimary?: boolean;
}

/**
 * Mount the React-UI shell. Idempotent: a second call for the SAME host id unmounts the prior root
 * first (so a re-bootstrap after a session change doesn't stack roots). Multi-orbiter tiles each pass
 * a distinct voiceId → distinct host id → N independent UIs coexist.
 */
export function mountOrbitersUI({
  parameterManager,
  container,
  voiceId,
  isPrimary,
}: MountOrbitersUIOptions): OrbitersUIHandle {
  const parent = container ?? document.body;
  // Per-voice host id so N tiles don't tear each other down (single-orbiter keeps the legacy id).
  const hostId = voiceId ? `${HOST_ID}-${voiceId}` : HOST_ID;
  // Single-orbiter (no container) always owns the body/documentElement globals; in a grid only the
  // primary does, so a secondary tile's unmount never strips the legacy-hide gate from its siblings.
  const ownsGlobals = !container || Boolean(isPrimary);

  // Fully tear down any prior mount for THIS host (React root AND its global side effects) via the
  // SAME cleanup the handle uses, so a re-bootstrap never leaks a root or leaves the body attr /
  // `.dark` stuck. Then mount onto a fresh host.
  (document.getElementById(hostId) as HostWithCleanup | null)?.__orbitersCleanup?.();

  // A grid cell holds exactly ONE orbiter interface. The cell outlives the voice (the slot layout owns
  // it), and each placement mints a fresh voiceId → a fresh host id, so the same-id teardown above can
  // never reap a host left behind by a previous placement in this cell. Reap them here instead, so a
  // stale interface can't stack under the new one. Scoped to `container`: the single-orbiter mount
  // parents to <body>, where sibling hosts are legitimate.
  if (container) {
    for (const stale of Array.from(container.children)) {
      if (stale.id !== hostId && stale.id.startsWith(`${HOST_ID}-`)) {
        (stale as HostWithCleanup).__orbitersCleanup?.();
        stale.remove();
      }
    }
  }

  const host = document.createElement('div') as HostWithCleanup;
  host.id = hostId;
  // In a grid cell, fill it: the cell is `position:relative`, so an absolutely-positioned host (and
  // the `position:absolute; inset:0` `.orbiters-react-ui` inside it) covers exactly that tile rather
  // than the whole viewport. Single-orbiter appends a plain div to <body> (unchanged → viewport-fill).
  // pointer-events:none — this full-bleed host must NOT eat the voice's camera drag. It matches
  // the single-orbiter host (`#orbiters-react-ui-root` in orbitersUI.css), but that rule is exact-id so it
  // doesn't reach these suffixed hosts; set it inline so an empty-area pointerdown falls through to the
  // cell (the voice's input surface) instead of landing on this wrapper. Controls re-enable via :auto.
  if (container) host.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  parent.appendChild(host);

  const { context: engine, report } = resolveEngineContext(parameterManager, voiceId);
  // Loud in dev when an expected singleton failed to resolve (shape drift) — the
  // silent legacy fallback that used to mask this is gone.
  warnOnMissingExpectedSurfaces(report);
  const root = createRoot(host);
  // Gate the legacy-hide CSS on (owner only). The React regions now own these regions' screen
  // real-estate, so the duplicated legacy chrome must hide to avoid overlap; it stays MOUNTED
  // (compatibility shell) — only its visibility is suppressed.
  if (ownsGlobals) {
    document.body?.setAttribute(UI_REACT_BODY_ATTR, 'on');
    document.documentElement.classList.add(DARK_CLASS); // run the lib in dark mode (see DARK_CLASS)
  }
  root.render(
    <StrictMode>
      <OrbitersUI engine={engine} />
    </StrictMode>,
  );

  // One cleanup path for both the remount above and the returned handle.
  const cleanup = () => {
    root.unmount();
    if (ownsGlobals) {
      document.body?.removeAttribute(UI_REACT_BODY_ATTR);
      document.documentElement.classList.remove(DARK_CLASS);
    }
    host.remove();
  };
  host.__orbitersCleanup = cleanup;

  return { unmount: cleanup };
}
