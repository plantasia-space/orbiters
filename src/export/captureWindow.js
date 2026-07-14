// Fixed-size capture window — the orbiters analogue of the studio popup recorder.
//
// "New window" capture opens the SAME orbiter in a separate browser window sized to the
// chosen aspect's exact pixel dimensions, with the full interface intact. The window snaps
// itself to those dims and, as soon as the orbiter has finished loading, auto-starts the
// recording — the user only has to approve the browser's screen-share permission prompt.
// Capture runs via getDisplayMedia + MediaRecorder (clamped to the target resolution); on
// stop the file downloads to the user's device. Orbiters does not upload (unlike the studio,
// which posts the blob back to its opener for ingestion).
//
// Mirrors src/studio/core/renderMode.js: a same-origin popup opened from a user gesture can
// call getDisplayMedia after async work without its own gesture, so the capture starts
// automatically once playback is ready.

import { CAPTURE_STATE_CHANGE_EVENT, CAPTURE_STATES } from './capture.js';
import { getCaptureFormatMeta, normalizeCaptureAspect } from './captureSettings.js';
import notifications from '../core/AppNotifications.js';
import { getT } from '../i18n/index.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';

const CAPTURE_PARAM = 'capture';
const TRACK_PARAM = 'trackId';
const WINDOW_NAME = 'orbiters-capture';
const SNAP_BURST_MS = 600;
const SNAP_BURST_MAX = 3;

function readAspectParam() {
  try {
    return new URLSearchParams(window.location.search).get(CAPTURE_PARAM);
  } catch {
    return null;
  }
}

export function isCaptureWindow() {
  return Boolean(readAspectParam());
}

// ----------------------------------------------------------------------------
// Opener side — launch the fixed-size capture window.
// Must run inside a user gesture (the format-picker button click) so window.open
// is not blocked.
// ----------------------------------------------------------------------------

// The capture window opens the SAME orbiter the RECORD button belongs to. Two contexts:
//   - Standalone app (single-orbiter, or the collection studio at `?collection=`): the current page IS
//     the orbiter, so the capture window reuses this URL — it already carries the trackId / collection +
//     graphics/audio/lang, so those are preserved for free.
//   - Embedded in a host page (the feed's shared realm, where the engine runs INSIDE the site): the
//     current page is the host site, not the orbiter app. Reusing it would reopen the whole feed page
//     (the old `:3000/…&capture=` bug). Instead build the STANDALONE single-orbiter URL for the
//     recording voice's track, off the app base the host publishes on `window.ORBITER_APP_URL`.
function resolveCaptureTargetUrl(voiceId) {
  const appBase = typeof window !== 'undefined' ? window.ORBITER_APP_URL : null;
  if (!appBase) {
    // Standalone app — reuse the current page URL.
    try {
      return new URL(window.location.href);
    } catch {
      return null;
    }
  }
  // Embedded host — target the standalone orbiter app for the recording voice's track. Prefer the voice
  // that opened the RECORD dialog; fall back to the focused voice.
  const voice = (voiceId && voiceRegistry.get(voiceId)) || voiceRegistry.getActive();
  const trackId = voice?.getTrackId?.() ?? null;
  if (!trackId) return null;
  try {
    const url = new URL(appBase, window.location.href);
    url.searchParams.set(TRACK_PARAM, trackId);
    return url;
  } catch {
    return null;
  }
}

/**
 * Open the fixed-size capture window for the chosen aspect.
 * @param {string} aspectId one of CAPTURE_ASPECTS ids.
 * @param {{voiceId?: string|null}} [opts] the voice whose RECORD button opened the dialog — used only
 *   when the engine is embedded in a host page, to target that voice's track in the standalone app.
 */
export function openCaptureWindow(aspectId, { voiceId = null } = {}) {
  const format = getCaptureFormatMeta(aspectId);
  const url = resolveCaptureTargetUrl(voiceId);
  if (!url) return null;
  url.searchParams.set(CAPTURE_PARAM, format.id);

  const features = [
    `width=${format.width}`,
    `height=${format.height}`,
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'noopener=no',
  ].join(',');

  try {
    return window.open(url.toString(), WINDOW_NAME, features);
  } catch (error) {
    console.warn('[CaptureWindow] window.open failed', error);
    return null;
  }
}

// ----------------------------------------------------------------------------
// Capture-window side.
// ----------------------------------------------------------------------------

// Snap the window's INNER content area to the target dims. window.resizeTo sets the OUTER
// window, so we add the chrome offset; run twice because Chrome doesn't always update
// outer/inner in the same frame. A capped snap-back keeps the captured stream from drifting
// if the user drags the window edge, without fighting an unsatisfiable target forever.
function lockWindowToSize(width, height) {
  const resizeToTarget = () => {
    const chromeW = Math.max(0, (window.outerWidth || 0) - (window.innerWidth || 0));
    const chromeH = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0));
    try {
      window.resizeTo(width + chromeW, height + chromeH);
    } catch {
      /* noop — resizeTo can throw on tabs the browser won't resize */
    }
  };

  resizeToTarget();
  setTimeout(resizeToTarget, 50);

  let snapAttempts = 0;
  let snapBurstResetAt = 0;
  const onResize = () => {
    const dw = Math.abs((window.innerWidth || 0) - width);
    const dh = Math.abs((window.innerHeight || 0) - height);
    if (dw <= 1 && dh <= 1) {
      snapAttempts = 0;
      return;
    }
    const now = (typeof performance !== 'undefined' ? performance.now() : 0) || 0;
    if (now - snapBurstResetAt > SNAP_BURST_MS) {
      snapAttempts = 0;
      snapBurstResetAt = now;
    }
    if (snapAttempts >= SNAP_BURST_MAX) return;
    snapAttempts += 1;
    resizeToTarget();
  };
  window.addEventListener('resize', onResize);
}

// Resolve once the orbiter has fully booted. Constants.setLoadingState('uiReady', true)
// sets body[data-ui-ready="true"] right before the loading screen is removed.
function whenOrbiterReady(run) {
  const isReady = () => document.body?.getAttribute('data-ui-ready') === 'true';
  if (isReady()) {
    run();
    return;
  }
  const observer = new MutationObserver(() => {
    if (isReady()) {
      observer.disconnect();
      run();
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ui-ready'] });
}

async function startAutoCapture(format) {
  const t = getT();
  const capture = window.captureControl;
  if (!capture?.isSupported?.()) {
    notifications.showToast(t('captureWindow.unsupported'), 'warning', 5000);
    return;
  }

  const started = await capture.startRecording({
    targetSize: { width: format.width, height: format.height },
  });

  if (!started) {
    // The user dismissed the share prompt (or the browser refused it). Let any click
    // retry — no in-frame button, so the recorded output stays clean.
    notifications.showToast(t('captureWindow.retry'), 'info', 6000);
    window.addEventListener(
      'pointerdown',
      () => startAutoCapture(format),
      { once: true },
    );
    return;
  }

  // Recording is live — start playback from the top so the capture runs from frame 0. Play EVERY voice
  // in the realm CONCURRENTLY (single-orbiter has exactly one voice, so this is identical to before): a
  // multi/collection capture starts each ready stage together rather than staggering them behind each
  // `play()`'s await. Voices that only join the realm AFTER this point (a collection filled by drags in
  // the capture window) aren't caught here — that fuller multi-stage sync is a known follow-up.
  // IMPORTANT: do NOT call transport.stop() here. TransportControl.stop() also calls
  // captureControl.stop(), which would end the recording we just started (producing a
  // sub-second, unplayable file). A freshly loaded window is already at position 0.
  await Promise.all(
    voiceRegistry.all().map((voice) =>
      Promise.resolve(voice?.transportControl?.play?.()).catch((error) =>
        console.warn('[CaptureWindow] failed to start playback for capture', error),
      ),
    ),
  );
}

export function bootCaptureWindow() {
  const aspectId = normalizeCaptureAspect(readAspectParam());
  const format = getCaptureFormatMeta(aspectId);

  lockWindowToSize(format.width, format.height);

  // Confirm to the user once the file is on its way down.
  window.addEventListener(CAPTURE_STATE_CHANGE_EVENT, (event) => {
    if (event?.detail?.state === CAPTURE_STATES.saving) {
      notifications.showToast(getT()('captureWindow.saved'), 'success', 5000);
    }
  });

  whenOrbiterReady(() => startAutoCapture(format));
}
