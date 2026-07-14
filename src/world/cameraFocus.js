/**
 * @file world/cameraFocus.js
 * @description What a voice's camera orbits: the world, or its first moon.
 *
 *              The camera IS the orbiter's point of view — it orbits a body.
 *              Focusing a moon therefore does not "aim" the camera somewhere
 *              else, it moves the CENTRE of the orbit from the world's origin
 *              to the moon, and the camera keeps orbiting exactly as before
 *              around the new centre. This module holds only that choice, per
 *              voice; `configureCameraAutomation` reads it every frame and owns
 *              the travel.
 *
 *              Per voice, because in a multi-orbiter scene each voice has its
 *              own camera and its own world — one focused moon must never move
 *              a sibling's camera.
 */

/** @typedef {'world'|'moon'} CameraFocus */

/** voiceId → focus. Absent = 'world' (the default the scene has always had). */
const focusByVoice = new Map();
const listeners = new Set();

/**
 * @param {string} voiceId
 * @returns {CameraFocus}
 */
export function getCameraFocus(voiceId) {
  return focusByVoice.get(voiceId) ?? 'world';
}

/**
 * @param {string} voiceId
 * @param {CameraFocus} focus
 */
export function setCameraFocus(voiceId, focus) {
  const next = focus === 'moon' ? 'moon' : 'world';
  if (getCameraFocus(voiceId) === next) return;
  focusByVoice.set(voiceId, next);
  listeners.forEach((listener) => {
    try {
      listener(voiceId, next);
    } catch {
      // A view that throws on notify must not stop the others (or the camera).
    }
  });
}

/**
 * @param {(voiceId: string, focus: CameraFocus) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function subscribeCameraFocus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
