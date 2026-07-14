/**
 * @file src/ui/react/regions/headerActions.ts
 * @description The header dropdown ACTIONS, owned by React (replaces the
 * `legacyHeaderActions` bridge that `.click()`ed hidden legacy `ButtonGroup` items). Each action runs
 * the real logic directly: no legacy DOM, no double UI.
 *
 *  - INFO menu (monitor / track / entangled-world / orbiter): the React InfoPanel owns the DISPLAY
 *    (it reads the `info`/`monitor` engine surfaces); here we only emit the view telemetry the legacy
 *    `handleInformationDropdown` did. The old monitor-visible gate is dropped — `getMonitorVisible`
 *    has no readers (dead state).
 *  - MORE menu: midi (enter MIDI-learn), tooltips (toggle), share (copy track link), fullscreen.
 *
 * Ported from `ButtonGroup.handleInformationDropdown` / `handleMoreDropdown` (+ helpers). Plain TS so
 * any layer can call it; the real handlers (clipboard, fullscreen, telemetry) come along unchanged.
 */
import { Constants } from '../../../config/Constants.js';
import { getCurrentOrbiter } from '../../Interaction.js';
import notifications from '../../../core/AppNotifications.js';
import { toggleControlTooltips } from '../../controlTooltips.js';
import { voiceRegistry } from '../../../voice/VoiceRegistry.js';

/** Track id for share/telemetry — read off the focused orbiter's combined config (the
 *  per-voice source, replacing the removed Constants.TRACK_ID/TRACK_DATA single-current globals). */
function resolveCurrentTrackId(): string | null {
  const orbiter = getCurrentOrbiter() as
    | { trackData?: { track?: { trackId?: string }; trackId?: string } }
    | null;
  const candidates = [
    orbiter?.trackData?.track?.trackId,
    orbiter?.trackData?.trackId,
  ];
  return candidates.find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? null;
}

/** World id for the world-view telemetry. */
function resolveCurrentWorldId(): string | null {
  const orbiter = getCurrentOrbiter() as
    | { trackData?: { entangledWorld?: { worldId?: string }; worldId?: string } }
    | null;
  const candidates = [
    orbiter?.trackData?.entangledWorld?.worldId,
    orbiter?.trackData?.worldId,
  ];
  return candidates.find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? null;
}

function buildShareUrl(trackId: string): string | null {
  const base = (Constants.ROOT_BASE as string | undefined)
    || (typeof window !== 'undefined' ? window.location?.origin : '')
    || '';
  const sanitizedBase = typeof base === 'string' && base.trim().length ? base.replace(/\/+$/, '') : '';
  if (!sanitizedBase) return null;
  return `${sanitizedBase}/track/${encodeURIComponent(trackId)}`;
}

function emitShareTelemetry(trackId: string | null, method: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('orbiters:share-clicked', { detail: { trackId, method } }));
}

function promptShareLink(shareUrl: string, trackId: string | null): void {
  emitShareTelemetry(trackId, 'prompt');
  notifications.showToast('Copy the share link shown in the dialog.', 'info');
  try {
    window.prompt('Share this link with your collaborators:', shareUrl);
  } catch {
    notifications.showToast(`Share URL: ${shareUrl}`, 'info');
  }
}

function copyShareLink(shareUrl: string, trackId: string | null): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(shareUrl)
      .then(() => {
        emitShareTelemetry(trackId, 'clipboard');
        notifications.showToast('Share link copied to clipboard.', 'success');
      })
      .catch(() => promptShareLink(shareUrl, trackId));
    return;
  }
  promptShareLink(shareUrl, trackId);
}

/** Copy the current track's share link (clipboard, with a prompt fallback). */
export function shareCurrentTrack(): void {
  const trackId = resolveCurrentTrackId();
  if (!trackId) {
    notifications.showToast('Unable to find a track to share.', 'warning');
    return;
  }
  const shareUrl = buildShareUrl(trackId);
  if (!shareUrl) {
    notifications.showToast('Share link could not be generated.', 'warning');
    return;
  }
  copyShareLink(shareUrl, trackId);
}

/** The element to fullscreen for a voice. In a shared realm (feed / collection / multi) each voice
 *  owns a `.multi-orbiter-cell` (its `themeRoot`); fullscreen must fill the screen with THAT cell (the
 *  ViewportCompositor moves the shared canvas into it and solo-renders the voice), not root's
 *  whole page. Single-orbiter has no cell (`themeRoot` null), so it falls back to `documentElement` —
 *  which IS the orbiter's page standalone/in an iframe (byte-identical to before). */
function resolveFullscreenTarget(voiceId?: string | null): HTMLElement {
  const entry = voiceId != null ? voiceRegistry.get(voiceId) : voiceRegistry.getActive();
  const cell = (entry as { themeRoot?: unknown } | null)?.themeRoot;
  return cell instanceof HTMLElement ? cell : document.documentElement;
}

/** Toggle fullscreen (with iOS new-tab + edit-mode handling). Must run inside a user gesture. In a
 *  shared realm, pass the owning voice's id so the RIGHT voice's cell fills the screen. */
export async function toggleFullscreen(voiceId?: string | null): Promise<void> {
  const doc = document as Document & {
    webkitFullscreenElement?: Element;
    webkitExitFullscreen?: () => Promise<void>;
  };
  const el = resolveFullscreenTarget(voiceId) as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
  };
  const isFullscreen = doc.fullscreenElement || doc.webkitFullscreenElement;

  if (isFullscreen) {
    try {
      await (doc.exitFullscreen?.() || doc.webkitExitFullscreen?.());
      notifications.showToast('Exited fullscreen mode.');
    } catch (err) {
      console.warn('[Fullscreen] Exit failed:', err);
    }
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const worldMode = urlParams.get('worldMode') || urlParams.get('mode') || '';
  const isEditMode = worldMode.toLowerCase() === 'edit';
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as { MSStream?: unknown }).MSStream;

  if (isIOS && !isEditMode) {
    try {
      window.open(window.location.href, '_blank');
      notifications.showToast('Opening in new tab...');
    } catch (err) {
      console.warn('[Fullscreen] Failed to open new tab:', err);
    }
    return;
  }
  if (isIOS && isEditMode) {
    notifications.showToast('Fullscreen not available in edit mode.', 'info');
    return;
  }

  try {
    await (el.requestFullscreen?.() || el.webkitRequestFullscreen?.());
  } catch (err) {
    console.warn('[Fullscreen] Request failed:', err);
    notifications.showToast('Fullscreen not available.', 'warning');
  }
}

/** Enter (toggle) MIDI-learn mode. `toggleMidiLearnMode` (Interaction.js) activates Web MIDI access via
 *  `MIDIController.activateMIDI()` on first use — no WAC dependency — then flips learn mode. Runs from a
 *  user gesture (the menu click) so the permission prompt is allowed. */
export async function enterMidiLearn(): Promise<void> {
  const toggleFn = (window as { __orbitersToggleMidiLearnMode?: () => Promise<void> | void })
    .__orbitersToggleMidiLearnMode;
  if (typeof toggleFn === 'function') {
    try {
      await toggleFn();
    } catch (error) {
      console.error('[headerActions] Failed to toggle MIDI Learn mode:', error);
    }
  }
}

/** React info value → telemetry infoType (monitor has none, matching legacy `infoTypeMap`). */
const INFO_TELEMETRY_TYPE: Record<string, string> = {
  track: 'track',
  'entangled-world': 'world',
  orbiter: 'orbiter',
};

/** Emit the info-panel-viewed telemetry for a chosen info view (the React InfoPanel owns the display). */
export function handleInfoAction(value: string): void {
  if (typeof window === 'undefined') return;
  const infoType = INFO_TELEMETRY_TYPE[value];
  if (!infoType) return;
  window.dispatchEvent(new CustomEvent('orbiters:info-panel-viewed', {
    detail: {
      infoType,
      trackId: resolveCurrentTrackId(),
      worldId: infoType === 'world' ? resolveCurrentWorldId() : null,
    },
  }));
}

/** Run a MORE-menu action (midi / tooltips / share / fullscreen). `voiceId` (a shared-realm tile's
 *  owning voice) scopes fullscreen to THAT voice's cell; omitted single-orbiter uses the active voice. */
export function handleMoreAction(value: string, voiceId?: string | null): void {
  switch (value) {
    case 'midi':
      void enterMidiLearn();
      break;
    case 'tooltips':
      toggleControlTooltips();
      break;
    case 'share':
      shareCurrentTrack();
      break;
    case 'fullscreen':
      void toggleFullscreen(voiceId);
      break;
    default:
      console.warn(`[headerActions] Unknown more action: ${value}`);
  }
}
