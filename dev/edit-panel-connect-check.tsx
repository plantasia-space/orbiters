/**
 * Connect harness — drives the REAL OrbitersEditPanel with the React panel flag on.
 *
 * Unlike edit-panel-check.tsx (which stubbed the panel), this instantiates the actual
 * `OrbitersEditPanel`, sets `window.__USE_REACT_EDIT_PANEL`, and calls `panel.mount()` — which
 * routes to `_mountReact()` and renders the React panel wired to the panel's own handlers. The
 * harness records the four constructor callbacks so we can confirm the React controls fire
 * onDesignChange / onStacksChange / onRackChange / onAnyChange through the real pipeline, exactly
 * as the lil-gui controls would. (Full in-app verification with a live world needs auth + the
 * primary dev origin; this proves the connect itself.)
 */
import { OrbitersEditPanel } from '../src/orbiter/edit/OrbitersEditPanel.js';
import { initI18n } from '../src/i18n/index.js';

declare global {
  interface Window { __USE_REACT_EDIT_PANEL?: boolean }
}

window.__USE_REACT_EDIT_PANEL = true;

// The real app initialises i18n before edit mode (Main.js); do the same so the panel's translation
// lookups resolve (ThemePresetController etc. expect real strings).
await initI18n();

const log = {
  designChanges: 0,
  stacksChanges: 0,
  rackChanges: 0,
  anyChanges: 0,
  lastDesign: null as unknown,
  lastStacks: null as unknown,
  lastRack: null as unknown,
};

function render() {
  const el = document.getElementById('log');
  if (el) el.textContent = JSON.stringify(log, null, 2);
}

const panel = new OrbitersEditPanel({
  onDesignChange: (design: Record<string, unknown>) => {
    log.designChanges += 1;
    log.lastDesign = {
      colorPrimary: design.colorPrimary,
      ringEnabled: design.ringEnabled,
      roundedCorners: design.roundedCorners,
    };
    render();
  },
  onStacksChange: (payload: { activeDimensionId?: unknown }) => {
    log.stacksChanges += 1;
    log.lastStacks = { activeDimensionId: payload?.activeDimensionId };
    render();
  },
  onRackChange: (axis: string, updated: { modules?: unknown[] }) => {
    log.rackChanges += 1;
    log.lastRack = { axis, moduleCount: updated?.modules?.length ?? 0 };
    render();
  },
  onAnyChange: () => {
    log.anyChanges += 1;
    render();
  },
});

await panel.mount();
render();

// Expose for assertions from the test driver.
(window as unknown as { __panel?: unknown }).__panel = panel;
(window as unknown as { __connectLog?: unknown }).__connectLog = log;
