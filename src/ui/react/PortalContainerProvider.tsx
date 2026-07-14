/**
 * PortalContainerProvider + usePortalContainer.
 *
 * The single mechanism for theming orbiter chrome that renders through a Radix PORTAL
 * (the numeric keypad, the interaction/sensors menu, header menus, tooltips, dialogs).
 * Those surfaces mount OUTSIDE the voice's `.orbiters-react-ui` tree — by default on the
 * host page's `<body>` — so they inherit whatever theme lives on the host document. In the
 * standalone/collection apps that happens to be the orbiter theme; in the feed realm
 * (engine-in-root) the host is the platform's root app, so the chrome picked up the *user's*
 * theme instead of the *orbiter designer's* theme. That was the bug, and it had been worked around
 * three different ways (documentElement tokens, an active-voice mirror, …).
 *
 * This replaces all of them with ONE rule: every orbiter chrome portal renders into a
 * per-voice, orbiter-themed container. The container is a `<body>`-level `<div>` that carries
 * THIS voice's design tokens (`--color1/2/3`, `--orbiters-font-family`,
 * `--orbiters-rounded-corners`) plus `.dark` (the neutral surface palette the keypad reads)
 * plus `.orbiters-portal-scope` (the token bridge — see orbitersUI.css). So the portalled
 * chrome reads the orbiter's own theme by DOM containment and never the host document — same
 * behaviour in standalone, collection, and feed, one place to change theming forever after.
 *
 * Body-level (not inside the cell) on purpose: the feed card cell is `overflow:hidden` and a
 * container-query root, so portaling into it would clip a fixed dialog and re-anchor it to the
 * tiny card. A plain body-level div is visually inert (it has no box) and lets fixed dialogs
 * center on the viewport exactly as before, while still carrying the orbiter theme.
 *
 * Tokens are copied from the voice's themeRoot on `orbiters:design-updated` — the same event
 * `designManager.applyDesignSettings` fires and that `useOrbiterColors` already listens to —
 * so the container tracks live theme edits with one listener and no polling.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useEngine } from '../../react/engine/EngineContext';

const PortalContainerContext = createContext<HTMLElement | null>(null);

/** The per-voice, orbiter-themed element to portal chrome into. Null before the container mounts
 *  (first render / SSR) — callers pass `container ?? undefined` so Radix falls back to `<body>`. */
export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}

/** The orbiter design tokens the portalled chrome needs. `--color1/2/3` drive the bridge's brand
 *  aliases; font/radius drive `--font-sans`/`--radius`. Neutral surface tokens (`--popover` …) come
 *  from the `.dark` class on the container, not from here. */
const TOKEN_VARS = [
  '--color1',
  '--color2',
  '--color3',
  '--orbiters-font-family',
  '--orbiters-rounded-corners',
] as const;

/** The element whose computed design tokens are THIS voice's: the voice's React host (which inherits
 *  its cell's vars in the multi/feed realm), or `documentElement` for single-orbiter. Mirrors
 *  `resolveColorRoot` in react/parameters — the tile host is the per-voice theme root. */
function resolveThemeRoot(voiceId: string | null): Element | null {
  if (typeof document === 'undefined') return null;
  if (voiceId) {
    const host = document.getElementById(`orbiters-react-ui-root-${voiceId}`);
    if (host) return host;
  }
  return document.documentElement;
}

export function PortalContainerProvider({ children }: { children: ReactNode }) {
  const { voiceId } = useEngine();
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    // `.orbiters-portal-scope` applies the token bridge; `.dark` supplies the neutral surface
    // palette (the keypad/menus read `--popover`/`--background`/`--accent`). Kept visually inert —
    // no size, position, transform or containment — so it doesn't affect layout and fixed children
    // resolve against the viewport.
    el.className = 'orbiters-portal-scope dark';
    if (voiceId) el.dataset.voiceId = voiceId;
    document.body.appendChild(el);

    // Copy the voice's design tokens onto the container (deterministic set-or-remove, so a voice
    // that defines no Color C falls back to the lib default instead of a stale value).
    const syncTokens = () => {
      const root = resolveThemeRoot(voiceId);
      if (!root) return;
      const cs = getComputedStyle(root);
      for (const name of TOKEN_VARS) {
        const value = cs.getPropertyValue(name).trim();
        if (value) el.style.setProperty(name, value);
        else el.style.removeProperty(name);
      }
    };
    syncTokens();
    // Tokens load async (after track data) and change on dimension/theme edits — re-copy then.
    document.addEventListener('orbiters:design-updated', syncTokens);
    setContainer(el);

    return () => {
      document.removeEventListener('orbiters:design-updated', syncTokens);
      el.remove();
      setContainer((current) => (current === el ? null : current));
    };
  }, [voiceId]);

  return <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>;
}
