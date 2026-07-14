/**
 * @file src/ui/react/toastBridge.ts
 * @description One-way bridge so the vanilla `AppNotifications.showToast` can render through the React
 * design-lib `<Toaster>` (sonner) when the React shell is mounted (Tier-1 migration).
 *
 * The React `ToasterHost` registers a sink at mount; `showToast` forwards to it when present, else
 * falls back to the legacy DOM toast. The gate is "is the sink registered" (i.e. the shell is up) — NOT
 * a URL flag — so toasts work whether or not `?ui=react` is on. Plain TS, no React import, so the
 * vanilla singleton can import it without pulling React into the base bundle.
 */
export type ToastType = 'info' | 'success' | 'warning' | 'error';

/**
 * Optional toast metadata. `kind` tags a category of toast so it can be muted: some toasts teach the
 * user something (e.g. "Perform a MIDI action to assign it"). Helpful the first time, noise on every
 * repeat. When the user deliberately closes a kinded toast, that kind is muted (see {@link suppressToastKind}).
 */
export interface ToastOptions {
  duration?: number;
  /** Category tag — a user-dismissed kind is muted for all future toasts (persisted). */
  kind?: string;
}

export type ToastSink = (message: string, type: ToastType, options?: ToastOptions) => void;

let sink: ToastSink | null = null;

/** Registered by the React `ToasterHost` on mount; cleared on unmount. */
export function setToastSink(next: ToastSink | null): void {
  sink = next;
}

/** The current React toast sink, or null when the shell isn't mounted (→ legacy DOM path). */
export function getToastSink(): ToastSink | null {
  return sink;
}

// ── Suppress-by-kind ─────────────────────────────────────────────────────────────────────────────
// The first time a teaching toast appears it's useful; repeating it on every action is annoying. When
// the user DELIBERATELY closes a toast of a given `kind` (close button or swipe — not an auto-timeout),
// we mute that kind from then on (persisted) — they've learned it. Lives here (plain TS) so both the
// vanilla `showToast` (skip-if-muted) and the React sink (mute-on-dismiss) share one store.
const SUPPRESS_KEY = 'orbiters.suppressedToastKinds';

/**
 * Acquire localStorage defensively. Merely READING `localStorage` can throw a SecurityError in some
 * privacy modes / sandboxed frames (a throwing getter), so the access itself must be guarded — not
 * just the `getItem`/`setItem` calls. Returns null when storage is unavailable; muting just won't persist.
 */
function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readSuppressedKinds(): Set<string> {
  const storage = safeLocalStorage();
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(SUPPRESS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** True if the user has dismissed (and thereby muted) toasts of this kind before. */
export function isToastKindSuppressed(kind: string): boolean {
  return readSuppressedKinds().has(kind);
}

/** Mute this kind of toast from now on — the user closed one deliberately. Persisted, best-effort. */
export function suppressToastKind(kind: string): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  const kinds = readSuppressedKinds();
  if (kinds.has(kind)) return;
  kinds.add(kind);
  try {
    storage.setItem(SUPPRESS_KEY, JSON.stringify([...kinds]));
  } catch {
    /* storage full / unavailable — best-effort; the toast just won't be muted */
  }
}
