const SILENT_AUDIO_SELECTOR = '[data-silent-audio-unlock]';
const SILENT_AUDIO_ID = 'silent-audio-unlock';
const SILENT_AUDIO_SRC =
  'data:audio/mp3;base64,//MkxAAHiAICWABElBeKPL/RANb2w+yiT1g/gTok//lP/W/l3h8QO/OCdCqCW2Cw//MkxAQHkAIWUAhEmAQXWUOFW2dxPu//9mr60ElY5sseQ+xxesmHKtZr7bsqqX2L//MkxAgFwAYiQAhEAC2hq22d3///9FTV6tA36JdgBJoOGgc+7qvqej5Zu7/7uI9l//MkxBQHAAYi8AhEAO193vt9KGOq+6qcT7hhfN5FTInmwk8RkqKImTM55pRQHQSq//MkxBsGkgoIAABHhTACIJLf99nVI///yuW1uBqWfEu7CgNPWGpUadBmZ////4sL//MkxCMHMAH9iABEmAsKioqKigsLCwtVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVV//MkxCkECAUYCAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

let unlockPromise = null;
let unlocked = false;

function locateSilentAudioElement() {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.querySelector(SILENT_AUDIO_SELECTOR);
}

function getOrCreateSilentAudioElement() {
  const existing = locateSilentAudioElement();
  if (existing) {
    return existing;
  }
  if (typeof document === 'undefined') {
    return null;
  }

  const audioElement = document.createElement('audio');
  audioElement.id = SILENT_AUDIO_ID;
  audioElement.src = SILENT_AUDIO_SRC;
  audioElement.loop = false;
  audioElement.preload = 'auto';
  audioElement.muted = true;
  audioElement.volume = 0;
  audioElement.setAttribute('data-silent-audio-unlock', '');
  audioElement.setAttribute('playsinline', 'true');
  audioElement.setAttribute('aria-hidden', 'true');
  audioElement.style.position = 'absolute';
  audioElement.style.width = '1px';
  audioElement.style.height = '1px';
  audioElement.style.opacity = '0';
  audioElement.style.pointerEvents = 'none';
  document.body?.appendChild(audioElement);
  return audioElement;
}

function resetPendingState() {
  unlockPromise = null;
}

export function hasUnlockedAudio() {
  return unlocked;
}

export function ensureSilentAudioUnlock() {
  if (unlocked) {
    return Promise.resolve(true);
  }
  if (unlockPromise) {
    return unlockPromise;
  }

  const audioElement = getOrCreateSilentAudioElement();
  if (!audioElement) {
    // Retry on the next user interaction if the DOM is not yet writable.
    return Promise.resolve(false);
  }

  try {
    const playResult = audioElement.play();

    if (!playResult || typeof playResult.then !== 'function') {
      unlocked = true;
      resetPendingState();
      return Promise.resolve(true);
    }

    unlockPromise = playResult
      .then(() => {
        try {
          audioElement.pause();
          audioElement.currentTime = 0;
        } catch {
          // Best effort; failures here are non-fatal.
        }
        unlocked = true;
        resetPendingState();
        return true;
      })
      .catch((error) => {
        console.warn('[SilentAudioUnlock] Failed to unlock audio via silent element:', error);
        resetPendingState();
        return false;
      });

    return unlockPromise;
  } catch (error) {
    console.warn('[SilentAudioUnlock] Silent audio playback threw an error:', error);
    return Promise.resolve(false);
  }
}
