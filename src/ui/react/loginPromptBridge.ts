/**
 * @file src/ui/react/loginPromptBridge.ts
 * @description Bridge so the vanilla login-nudge flows (`ensureLoginPrompt`/`removeLoginPrompt`, called
 * from auth/settings/MIDI) drive the React `LoginPrompt` region (Tier-1 migration).
 *
 * The bridge holds the CURRENTLY-ACTIVE request (the nudge's desired state), not a one-shot buffer, and
 * REPLAYS it whenever a sink registers. This survives two realities: (1) the auth flow fires at BOOT,
 * before the React shell mounts; (2) React.StrictMode double-mounts the region in dev (mount → unmount →
 * remount). A consume-once buffer would be eaten by the throwaway first mount and lost; restoring the
 * active state on every registration shows it on whichever instance ends up live. Plain TS, no React.
 */
export interface LoginPromptRequest {
  text: string;
  href: string;
  ariaLabel: string;
}

export interface LoginPromptSink {
  show(req: LoginPromptRequest): void;
  hide(): void;
}

let sink: LoginPromptSink | null = null;
// The active nudge request, or null when hidden. Persists across sink (un)registration so a remount
// (incl. StrictMode's throwaway mount) restores the correct state.
let active: LoginPromptRequest | null = null;

/** Registered by the React `LoginPrompt` region on mount; cleared on unmount. Restores the active
 *  request into the (re)mounted region so a boot-time / pre-mount nudge isn't lost. */
export function setLoginPromptSink(next: LoginPromptSink | null): void {
  sink = next;
  if (next && active) next.show(active);
}

/** Show the nudge — forwards to the React region (if mounted) and records it as the active state. */
export function requestLoginPrompt(req: LoginPromptRequest): void {
  active = req;
  sink?.show(req);
}

/** Hide the nudge — clears the active state and forwards to the React region. */
export function dismissLoginPrompt(): void {
  active = null;
  sink?.hide();
}
