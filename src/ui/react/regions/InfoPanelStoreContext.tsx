/**
 * @file src/ui/react/regions/InfoPanelStoreContext.tsx
 * @description Per-voice provider + hook for the Info-panel open-state store. Each OrbitersUI
 * root creates ONE store, so the Engine Monitor / Info view ("Monitor Control") toggles INDEPENDENTLY
 * per orbiter tile in the multi-orbiter realm. Single-orbiter mounts one root → one store, so behavior
 * is byte-identical there. The producer (HeaderBar menu) and consumers (InfoPanel, AttributionSweep)
 * are siblings under OrbitersUI, so the provider owns the shared-per-voice state neither sibling owns.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { NAV_MOBILE_MEDIA_QUERY } from 'plantasia.space-design/react';
import { createInfoPanelStore, type InfoPanelStore } from './infoPanelStore';

const InfoPanelStoreContext = createContext<InfoPanelStore | null>(null);

/** Is the viewport in the mobile-nav range RIGHT NOW? Read synchronously (orbiters is a client-only SPA,
 *  so `window` exists at mount) — unlike the `useIsMobileNav` hook, which is SSR-safe and returns `false`
 *  on the first render, so it can't seed a once-only store initializer. Matches the hook's media query. */
function isMobileViewportNow(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(NAV_MOBILE_MEDIA_QUERY).matches
  );
}

/** Provides one Info-panel store for this OrbitersUI root (this voice's tile). */
export function InfoPanelStoreProvider({ children }: { children: ReactNode }) {
  // Mobile starts with the panel (Engine Monitor) CLOSED — screen space is scarce there, and the user
  // opens it on demand from the header menu. Desktop keeps the monitor open on load. The store
  // is created once and stable for its lifetime, so the mode is decided from the viewport at mount.
  const [store] = useState(() => createInfoPanelStore(isMobileViewportNow() ? null : 'monitor'));
  return <InfoPanelStoreContext.Provider value={store}>{children}</InfoPanelStoreContext.Provider>;
}

/** This tile's Info-panel store. Throws if used outside an `InfoPanelStoreProvider`. */
export function useInfoPanelStore(): InfoPanelStore {
  const store = useContext(InfoPanelStoreContext);
  if (!store) {
    throw new Error('useInfoPanelStore must be used within an InfoPanelStoreProvider');
  }
  return store;
}
