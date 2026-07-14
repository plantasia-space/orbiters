/**
 * @file src/ui/react/regions/loadMappingsDialogStore.ts
 * @description OPEN state for the load-saved-MIDI-mappings dialog. A tiny module-level
 * store shared between the producer (the "Open" button in the MIDI-mode header) and the consumer
 * (the LoadMappingsDialog region). Mirrors `captureDialogStore` — UI state, not engine state, so it
 * stays off the EngineContext and drives re-render via `useEngineSubscription`.
 */

let open = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Whether the load-saved-mappings dialog is open. */
export function isLoadMappingsDialogOpen(): boolean {
  return open;
}

/** Open the load-saved-mappings dialog (the MIDI-mode header "Open" button). */
export function openLoadMappingsDialog(): void {
  if (open) return;
  open = true;
  notify();
}

/** Close the load-saved-mappings dialog (dismiss / after a successful load). */
export function closeLoadMappingsDialog(): void {
  if (!open) return;
  open = false;
  notify();
}

/** Subscribe to open/close changes. Returns an unsubscribe. */
export function subscribeLoadMappingsDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
