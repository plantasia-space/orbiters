/**
 * @file src/multi/renderHost.js
 * @description The orbiter realm's render host. The compositor itself now lives in
 * `entangled-worlds-orbiters-shared/render` — Entangled Worlds needs the same one-canvas/one-renderer
 * host for its feed embeds, and it cannot import from this app. This module is the thin seam that
 * supplies the ORBITER-specific policy the shared module deliberately leaves to its host:
 *
 * - `devHandleKey`: the handle tooling reaches for to force a composited frame when rAF is
 *   throttled. Opt-in in the library, so a coexisting EW realm doesn't get it.
 *
 * (The old `publishRendererGlobal` seam is gone with shared 3.0: every voice threads its renderer
 * explicitly — `orbitersApp` hands `worldController.renderer` to `WorldManagerExtended` — so no
 * loader reads a window global anymore.)
 */
import { createViewportCompositor as createSharedViewportCompositor } from 'entangled-worlds-orbiters-shared/render';

const DEV_HANDLE_KEY = '__orbitersViewportCompositor';

/** @type {typeof createSharedViewportCompositor} */
export function createViewportCompositor(opts = {}) {
  return createSharedViewportCompositor({
    ...opts,
    devHandleKey: DEV_HANDLE_KEY,
  });
}
