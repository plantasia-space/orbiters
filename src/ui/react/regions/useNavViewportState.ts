/**
 * @file src/ui/react/regions/useNavViewportState.ts
 * @description React access to the orbiters RESPONSIVE state machine — measured against
 * the play-UI's OWN box (the tile), not the window.
 *
 * The play UI's CONTINUOUS sizing is already tile-relative: `.orbiters-react-ui` re-bases
 * the viewport-unit aliases onto container units (`1cqmin/1cqw/1cqh`) inside a
 * `container-type: size` host (single: `#orbiters-react-ui-root`; multi: each
 * `.multi-orbiter-cell` stage). The DISCRETE breakpoints (collapse the bottom action
 * groups to a drop-up; dimension tabs → dropdown; hide desktop-only chrome) must key off
 * the SAME box, or a small multi-orbiter tile keeps its full desktop stack while its
 * sizing shrinks — the two halves disagree and the rail overflows into the header.
 *
 * So this reads the box directly: a `ResizeObserver` on the `.orbiters-react-ui` root
 * (provided via `NavViewportProvider`) → `computeNavViewportState` (the SAME breakpoint
 * function `viewport.js` feeds from `window.inner*`, so single-orbiter — where the tile
 * fills the window — is byte-identical to the old window-driven behaviour). Multi-orbiter
 * tiles each get their own state. `viewport.js` still writes `data-nav-*` for the legacy
 * chrome CSS (`data-nav-shell` in `style.css`); that contract is untouched.
 */
import {
  createContext,
  createElement,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  computeNavViewportState,
  isMobileState,
} from '../../../config/breakpoints.js';

export interface NavViewportState {
  /** The box is at a mobile width (below the shared nav breakpoint). Consumed by the header. */
  isMobile: boolean;
  /** The box is shorter than the collapse height — drives the vertical action-stack collapse. */
  isShort: boolean;
}

// The height below which the box is "short" — mirrors `viewport.js`'s `heightClass` so the
// tile-measured state matches the window-measured legacy attribute in single-orbiter.
const SHORT_HEIGHT = 720;

/** Derive the discrete responsive state from a box's width/height (px). */
function deriveState(width: number, height: number): NavViewportState {
  return {
    isMobile: isMobileState(computeNavViewportState(width, height)),
    isShort: height < SHORT_HEIGHT,
  };
}

function sameState(a: NavViewportState, b: NavViewportState): boolean {
  return a.isMobile === b.isMobile && a.isShort === b.isShort;
}

/**
 * The box to measure is the SAME one the CSS container queries resolve against — the nearest
 * `container-type` ancestor (single play/edit: `#orbiters-react-ui-root`, viewport-filling even when
 * the Studio panel insets the visible play UI; multi: the `.multi-orbiter-cell` stage). Measuring the
 * inner `.orbiters-react-ui` instead would read the Studio-narrowed stage and flip the state in
 * single-orbiter edit mode. Walk up from the play-UI root; fall back to it if no container is found.
 */
function findMeasuredBox(from: HTMLElement): HTMLElement {
  let el: HTMLElement | null = from;
  while (el) {
    // A browser without container-query support reports `containerType` as undefined/'' — treat that
    // as "not a container" (falsy) so we don't stop at the first element and mis-measure a narrowed box.
    const containerType = getComputedStyle(el).containerType;
    if (containerType && containerType !== 'normal') return el;
    el = el.parentElement;
  }
  return from;
}

// Default = window-measured (a sensible base before a provider mounts, and the value for any
// consumer rendered outside a provider). SSR-safe: falls back to a desktop-sized box.
const DEFAULT_STATE = deriveState(
  typeof window !== 'undefined' ? window.innerWidth : 1280,
  typeof window !== 'undefined' ? window.innerHeight : 800,
);

const NavViewportContext = createContext<NavViewportState>(DEFAULT_STATE);

/**
 * Measures `targetRef`'s box with a `ResizeObserver` and returns the derived responsive state.
 * One observer per play-UI root (≤4 in the multi-orbiter grid) — cheap, event-driven.
 *
 * MUST be called by the component that OWNS `targetRef` (the play-UI root, e.g. `OrbitersUI`), NOT by a
 * descendant: React attaches a host element's ref bottom-up, so a descendant's layout effect runs while
 * the ancestor's ref is still null. The ref owner's own layout effect runs AFTER its subtree's refs are
 * attached, so `targetRef.current` is set here. `useLayoutEffect` lands the first measure before paint,
 * so a multi-orbiter tile commits its collapsed state on the first frame (no desktop-stack flash).
 */
export function useMeasuredNavViewportState(targetRef: RefObject<HTMLElement | null>): NavViewportState {
  const [state, setState] = useState<NavViewportState>(DEFAULT_STATE);
  useLayoutEffect(() => {
    const root = targetRef.current;
    if (!root) return;
    const el = findMeasuredBox(root);
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // A not-yet-laid-out / hidden box (either axis zero) would misreport as a tiny mobile box —
      // keep the last real state; a later real resize re-fires the observer and corrects it.
      if (rect.width <= 0 || rect.height <= 0) return;
      setState((prev) => {
        const next = deriveState(rect.width, rect.height);
        return sameState(prev, next) ? prev : next;
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [targetRef]);
  return state;
}

/** Pure context provider — feed it the state from `useMeasuredNavViewportState` in the ref owner. */
export function NavViewportProvider({
  value,
  children,
}: {
  value: NavViewportState;
  children: ReactNode;
}) {
  return createElement(NavViewportContext.Provider, { value }, children);
}

export function useNavViewportState(): NavViewportState {
  return useContext(NavViewportContext);
}
