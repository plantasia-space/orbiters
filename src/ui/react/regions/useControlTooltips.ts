/**
 * @file src/ui/react/regions/useControlTooltips.ts
 * @description React bridge to the legacy control-tooltip system. The legacy tooltips
 * (`src/ui/controlTooltips.js`) are registration-based and were activated once at boot over the
 * legacy chrome — so the React play-UI controls (which mount later, and replace the now-hidden
 * legacy chrome under `?ui=react`) never got hover tooltips. These hooks restore them:
 *
 *  - `useControlTooltipRegistration(rootRef)` — registers every control button + knob under the
 *    React root with `attachControlTooltip` so hovering tells you what the control is (the legacy
 *    title resolver falls back to the control's `aria-label`). Re-runs via a MutationObserver as
 *    panels / menus / collapse states mount new controls. Idempotent: `attachControlTooltip` stamps
 *    `data-tooltip-role`, so the `:not([data-tooltip-role])` filter skips already-registered nodes.
 *  - `useTooltipsEnabled()` — reads + subscribes to the tooltips on/off flag (for the more-menu
 *    toggle's checked state), via the `orbiters:tooltips-changed` signal the legacy module now emits.
 *
 * Tooltips/helpers now work on touch too. The registration is identical; the legacy module
 * picks the interaction model per device — desktop reveals on hover, mobile reveals on tap (a brief,
 * non-blocking helper). Both are gated by the same tooltips-enabled flag (the more-menu toggle).
 */
import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { attachControlTooltip, isControlTooltipsEnabled } from '../../controlTooltips.js';

/** Register every not-yet-registered control button + knob under `root`. Cheap to re-run: the
 *  `:not([data-tooltip-role])` filter means only NEW controls are touched. */
function registerControls(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('button:not([data-tooltip-role])').forEach((el) => {
    attachControlTooltip(el, 'button');
  });
  root.querySelectorAll<HTMLElement>('[data-slot="knob"]:not([data-tooltip-role])').forEach((el) => {
    attachControlTooltip(el, 'knob');
  });
  // The lib arrow Switch + Slider are canvas controls, NOT <button> — the Cosmic LFO ×0.5/×2
  // multiplier kicks, the cosmic/sensor enable hexagons, and the premix fader. Register them as
  // `button`-role so they get a hover tooltip too (text from their aria-label).
  root
    .querySelectorAll<HTMLElement>('[data-slot="switch"]:not([data-tooltip-role]), [data-slot="slider"]:not([data-tooltip-role])')
    .forEach((el) => {
      attachControlTooltip(el, 'button');
    });
}

export function useControlTooltipRegistration(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof MutationObserver === 'undefined') {
      return;
    }
    registerControls(root);
    // New controls mount as panels switch, the interaction menu collapses, or the transport swaps a
    // glyph — re-register on structural (childList) changes only (NOT attributes, so `data-active`
    // ticks during playback don't churn this).
    const observer = new MutationObserver(() => registerControls(root));
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rootRef]);
}

function subscribeTooltipsEnabled(onChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  window.addEventListener('orbiters:tooltips-changed', onChange);
  return () => window.removeEventListener('orbiters:tooltips-changed', onChange);
}

/** The current tooltips-enabled flag, re-rendering on the `orbiters:tooltips-changed` signal. */
export function useTooltipsEnabled(): boolean {
  return useSyncExternalStore(
    subscribeTooltipsEnabled,
    () => isControlTooltipsEnabled(),
    () => false,
  );
}
