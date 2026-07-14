const CAPTURE_STATES = Object.freeze({
  unsupported: 'unsupported',
  idle: 'idle',
  recording: 'recording',
  saving: 'saving',
});

export { CAPTURE_STATES };

export const CAPTURE_STATE_CHANGE_EVENT = 'orbiters:capture-state-change';

const DEFAULTS = Object.freeze({
  videoBitsPerSecond: 12_000_000,
  audioBitsPerSecond: 320_000,
  frameRate: 60,
  sampleRate: 48_000,
  channelCount: 2,
  startDelayMs: 600,
});

// Desktop Safari is excluded from in-app capture. Its getDisplayMedia can't do tab
// capture, always includes the window title bar, can't be sized for portrait aspects, degrades
// resolution / produces black frames (WebKit #247310), and ignores tab audio — so the recorded
// output is broken. We treat Safari like mobile: hide the record affordance until backend render
// can produce Safari/mobile videos. Detection: Apple vendor + Safari UA without other engines'
// tokens (Chrome/Chromium/Edge/Firefox, including their iOS CriOS/FxiOS builds).
function isSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /apple/i.test(navigator.vendor || '')
    && /safari/i.test(ua)
    && !/chrome|chromium|crios|fxios|edg|android/i.test(ua);
}

function hasCaptureSupport() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  if (isSafari()) {
    return false;
  }

  return Boolean(
    navigator.mediaDevices?.getDisplayMedia &&
    window.MediaRecorder &&
    typeof window.MediaRecorder.isTypeSupported === 'function',
  );
}

function bestMime() {
  const candidates = [
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((mime) => window.MediaRecorder.isTypeSupported(mime)) || '';
}

class CaptureControl {
  constructor() {
    this.state = hasCaptureSupport() ? CAPTURE_STATES.idle : CAPTURE_STATES.unsupported;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.elapsed = 0;
    this.recordedMimeType = 'video/webm';
    this.ticker = null;
  }

  init() {
    this.state = this.isSupported() ? CAPTURE_STATES.idle : CAPTURE_STATES.unsupported;
    this.emitStateChange();
  }

  isSupported() {
    return hasCaptureSupport();
  }

  getState() {
    if (!this.isSupported()) {
      return CAPTURE_STATES.unsupported;
    }

    return this.state;
  }

  async toggle(options = {}) {
    if (!this.isSupported()) {
      return false;
    }

    if (this.state === CAPTURE_STATES.recording) {
      this.stopRecording();
      return true;
    }

    if (this.state !== CAPTURE_STATES.idle) {
      return false;
    }

    return this.startRecording(options);
  }

  // targetSize: optional { width, height } — when provided (fixed-window capture from
  // the dedicated capture window) the stream is requested at and clamped to those exact
  // dims, so the downloaded file is the chosen resolution rather than the tab size.
  async startRecording({ targetSize = null } = {}) {
    if (!this.isSupported() || this.state !== CAPTURE_STATES.idle) {
      return false;
    }

    let stream;
    const captureWidth = Math.max(1, Number(targetSize?.width) || Number(window.innerWidth) || 1);
    const captureHeight = Math.max(1, Number(targetSize?.height) || Number(window.innerHeight) || 1);

    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        preferCurrentTab: true,
        // Keep the mouse pointer out of the recorded video — the capture should show
        // only the orbiter, not the cursor moving over it.
        cursor: 'never',
        video: {
          frameRate: { ideal: DEFAULTS.frameRate, max: DEFAULTS.frameRate },
          // ideal only for the request — capping with `max` makes some screens throw
          // OverconstrainedError; we clamp precisely with applyConstraints below.
          width: { ideal: captureWidth },
          height: { ideal: captureHeight },
          // Belt-and-suspenders: some Chromium builds read `cursor` from the video
          // constraints rather than the top level.
          cursor: 'never',
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: DEFAULTS.sampleRate,
          channelCount: DEFAULTS.channelCount,
        },
      });
    } catch (error) {
      console.warn('[Capture] getDisplayMedia cancelled or failed', error);
      return false;
    }

    // Clamp the captured track to the exact target dims for fixed-window capture.
    if (targetSize?.width && targetSize?.height) {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack?.applyConstraints) {
        try {
          await videoTrack.applyConstraints({
            width: { ideal: captureWidth, max: captureWidth },
            height: { ideal: captureHeight, max: captureHeight },
          });
        } catch (constraintError) {
          console.warn('[Capture] applyConstraints failed', constraintError);
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, DEFAULTS.startDelayMs));

    this.stream = stream;
    this.chunks = [];
    this.elapsed = 0;
    const mimeType = bestMime();
    this.recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: DEFAULTS.videoBitsPerSecond,
      audioBitsPerSecond: DEFAULTS.audioBitsPerSecond,
    });
    this.recordedMimeType = this.recorder.mimeType || 'video/webm';

    this.recorder.ondataavailable = (event) => {
      if (event.data?.size > 0) {
        this.chunks.push(event.data);
      }
    };

    this.recorder.onstop = () => {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.recorder = null;
      clearInterval(this.ticker);
      this.ticker = null;
      this.setState(CAPTURE_STATES.saving);
      this.save();
    };

    this.recorder.start(1000);
    this.setState(CAPTURE_STATES.recording);

    this.ticker = window.setInterval(() => {
      this.elapsed += 1;
      this.emitStateChange();
    }, 1000);

    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      videoTrack.onended = () => {
        if (this.state === CAPTURE_STATES.recording) {
          this.stopRecording();
        }
      };
    }

    return true;
  }

  stopRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
  }

  stop() {
    if (this.state === CAPTURE_STATES.recording) {
      this.stopRecording();
    }
  }

  setState(nextState) {
    this.state = nextState;
    this.emitStateChange();
  }

  emitStateChange() {
    if (typeof window === 'undefined') {
      return;
    }

    window.dispatchEvent(
      new CustomEvent(CAPTURE_STATE_CHANGE_EVENT, {
        detail: {
          state: this.getState(),
          supported: this.isSupported(),
          elapsed: this.elapsed,
        },
      }),
    );
  }

  save() {
    const mime = this.recordedMimeType || 'video/webm';
    const extension = mime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(this.chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = `orbiters-capture-${Date.now()}.${extension}`;
    anchor.click();

    window.setTimeout(() => URL.revokeObjectURL(url), 10000);

    this.chunks = [];
    this.elapsed = 0;
    this.recordedMimeType = 'video/webm';
    this.setState(CAPTURE_STATES.idle);
  }
}

export const captureControl = new CaptureControl();

export function initCapture() {
  captureControl.init();
  console.log('[Capture] ready');
}

if (typeof window !== 'undefined') {
  window.captureControl = captureControl;
}
