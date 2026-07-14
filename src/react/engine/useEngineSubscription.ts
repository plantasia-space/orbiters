/**
 * @file src/react/engine/useEngineSubscription.ts
 * @description Shared subscribe-and-re-render hook for the EngineContext surfaces
 * whose state is read imperatively (`dims.active()`, `panels.active()/list()`)
 * but changes via a `subscribe(listener): () => void` event seam.
 *
 * Extracts the identical `useReducer(forceRender) + useEffect(subscribe)` boilerplate
 * that HeaderBar / InteractionMenu / DimensionSelector each hand-rolled. The hook
 * forces a re-render whenever the surface notifies (a change from React OR the legacy
 * chrome), so the consuming region re-reads the latest `active()/list()` on render.
 *
 * Why not `useSyncExternalStore`: these surfaces expose no stable value snapshot —
 * their state is read through method calls (and `list()` returns a fresh array each
 * call), so a snapshot getter would tear or loop. A re-render-on-event is the honest
 * fit until the surfaces expose memoised snapshots.
 */
import { useEffect, useReducer, useState, type DependencyList } from 'react';

/** A surface that notifies of changes via a subscribe/unsubscribe pair. */
export interface EngineSubscribable {
  subscribe(listener: () => void): () => void;
}

/**
 * Subscribe to `surface` and force a re-render on every change notification.
 * Re-subscribes only when the surface identity changes; always unsubscribes on
 * unmount / surface change.
 */
export function useEngineSubscription(surface: EngineSubscribable): void {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => surface.subscribe(forceRender), [surface]);
}

/**
 * The value-returning sibling of {@link useEngineSubscription}: subscribe to `surface` and keep a
 * derived snapshot in state, re-reading `read()` on mount and on every change notification. For
 * surfaces that expose a snapshot getter rather than imperative reads (`monitor.getSnapshot`,
 * `info.getTags`). Pass `deps` for any value `read` closes over besides the surface (e.g. a mode),
 * so a change to it re-reads + re-subscribes.
 */
export function useEngineSnapshot<T>(
  surface: EngineSubscribable,
  read: () => T,
  deps: DependencyList = [],
): T {
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    setValue(read());
    return surface.subscribe(() => setValue(read()));
    // `read` is intentionally excluded (a fresh closure each render); `deps` captures its real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, ...deps]);
  return value;
}
