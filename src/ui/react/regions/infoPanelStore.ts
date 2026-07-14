/**
 * @file src/ui/react/regions/infoPanelStore.ts
 * @description The OPEN/active-mode state for the React Info panel (Phase 2) — the Engine Monitor /
 * Track / World / Orbiter view the HeaderBar information menu opens and the InfoPanel renders.
 *
 * This is a PER-VOICE factory, NOT a module singleton. In the multi-orbiter realm each tile
 * mounts its own OrbitersUI, so each must own its OWN "Monitor Control" open-state — a module-level
 * singleton was shared realm-wide, so opening the Engine Monitor on one tile opened it on every tile.
 * One store is created per OrbitersUI root (`InfoPanelStoreProvider`) and reached via
 * `useInfoPanelStore()`. Single-orbiter mounts exactly one root → one store → byte-identical behavior.
 *
 * It mirrors the subscribe/getter shape of the engine surfaces (it IS an `EngineSubscribable` via
 * `subscribe`), so `useEngineSubscription(store)` drives the panel's re-render with no bespoke wiring.
 * This is UI state, NOT engine state, so it deliberately does NOT live on the EngineContext (which
 * bridges the imperative core).
 */

/** The Info menu values (index.html `#information-dropdown`); also the InfoPanel's view modes. */
export type InfoMode = 'monitor' | 'track' | 'entangled-world' | 'orbiter';

const INFO_MODES: readonly InfoMode[] = ['monitor', 'track', 'entangled-world', 'orbiter'];

/** A per-voice Info-panel store. Stable for the life of its OrbitersUI root (created once). */
export interface InfoPanelStore {
  /** The active Info view, or null when the panel is closed. */
  getMode(): InfoMode | null;
  /** Open the panel on `mode`, or close it (`null`). No-op if already in that state. */
  setMode(mode: InfoMode | null): void;
  /** Subscribe to open/mode changes (the `EngineSubscribable` shape). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/**
 * Create a per-voice Info-panel store. Defaults to the Engine Monitor OPEN (`null` would be closed) so
 * the monitor's values show on load — matching the legacy default (`isMonitorVisible` started true) and
 * the header menu's default selected icon (`monitor`). Closing (re-selecting the open view) sets null.
 */
export function createInfoPanelStore(initial: InfoMode | null = 'monitor'): InfoPanelStore {
  let current: InfoMode | null = initial;
  const listeners = new Set<() => void>();
  return {
    getMode: () => current,
    setMode: (mode) => {
      if (current === mode) return;
      current = mode;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Type guard: is `value` a known Info mode? (Pure — not tied to any store instance.) */
export function isInfoMode(value: string): value is InfoMode {
  return (INFO_MODES as readonly string[]).includes(value);
}
