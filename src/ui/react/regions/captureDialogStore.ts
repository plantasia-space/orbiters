/**
 * @file src/ui/react/regions/captureDialogStore.ts
 * @description OPEN state for the React capture-format dialog (the RECORD flow). A tiny module-level
 * store shared between the producer (the Transport RECORD button) and the consumer (the CaptureDialog
 * region) — siblings under `OrbitersUI`, so neither owns the other's state.
 *
 * UI state, NOT engine state, so it deliberately stays off the EngineContext. Mirrors the
 * subscribe/getter shape of the engine surfaces (and `infoPanelStore`) so `useEngineSubscription`
 * drives the dialog's re-render with no bespoke wiring.
 */

let open = false;
// Capture is a single-focus (active-voice) surface, but every tile mounts its own
// CaptureDialog. Track WHICH voice opened it so only that tile's dialog renders — otherwise one
// RECORD click opened all N dialogs at once. null = single-orbiter (the one dialog always matches).
let openVoiceId: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Whether the capture-format dialog is open. */
export function isCaptureDialogOpen(): boolean {
  return open;
}

/** The voice that opened the capture dialog (null for single-orbiter). */
export function getCaptureDialogVoiceId(): string | null {
  return openVoiceId;
}

/** Open the capture-format dialog (the RECORD button) for a specific voice (null = single-orbiter). */
export function openCaptureDialog(voiceId: string | null = null): void {
  if (open) return;
  open = true;
  openVoiceId = voiceId;
  notify();
}

/** Close the capture-format dialog (dismiss / after starting the capture). */
export function closeCaptureDialog(): void {
  if (!open) return;
  open = false;
  openVoiceId = null;
  notify();
}

/** Subscribe to open/close changes. Returns an unsubscribe. */
export function subscribeCaptureDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
