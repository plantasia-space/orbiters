/**
 * @file src/orbiter/edit/react/editBridgeStore.ts
 * @description The ONE narrow boundary between the vanilla `OrbitersEditPanel` (the
 * state + handler owner / bridge) and the React Orbiter Studio that renders it.
 *
 * In Studio mode the panel does NOT mount its own React root; it publishes itself here
 * and the Studio's `EditPanelStateProvider` subscribes. A monotonic `version` bumps on every
 * publish AND on every `notify()` (external state pushes — setDesign / updateStacksConfig /
 * updateRackConfig), so a `useSyncExternalStore` snapshot of `version` re-renders the panel
 * even when the bridge object identity is unchanged. No React imports here so the vanilla
 * panel can import it without pulling React into the lil-gui path.
 *
 * This keeps the single-source-of-truth contract: the React controls are just an
 * alternative event source into the same `OrbitersEditPanel` handlers that feed the iframe
 * autosave snapshot — there is no second write path.
 */
import type { EditPanelBridge } from './editPanelState';

let current: EditPanelBridge | null = null;
let version = 0;
let epoch = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  listeners.forEach((fn) => fn());
}

/** Publish (or clear, with `null`) the live edit-panel bridge. Called by OrbitersEditPanel on mount/dispose. */
export function setEditBridge(bridge: EditPanelBridge | null): void {
  current = bridge;
  epoch += 1;
  emit();
}

/** Force a re-render off the current bridge state (external push). Used as the panel's `refresh`. */
export function notifyEditBridge(): void {
  emit();
}

export function getEditBridge(): EditPanelBridge | null {
  return current;
}

/** useSyncExternalStore snapshot — changes on every publish/notify so React re-reads the bridge. */
export function getEditBridgeVersion(): number {
  return version;
}

/**
 * Which bridge this is, counted from the start of the session — bumps ONLY when a bridge is published
 * or cleared, not on the notifies in between. The panel state is per-bridge (the engine lock, the theme
 * and font catalogs are all about THIS orbiter), so it is keyed on this: a new orbiter's panel starts
 * from scratch instead of inheriting the last one's, without a hand-written reset per piece of state.
 */
export function getEditBridgeEpoch(): number {
  return epoch;
}

export function subscribeEditBridge(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
