/**
 * @file visual/positionLensLayer.js
 * @description The position group's visual: where the sound sits in the stereo field
 *              becomes the camera's LENS. The stereo widener opens and closes the field
 *              of view — narrow the image and the world looms, widen it and the world
 *              pulls back into space. The panner shifts the lens sideways, so the sound
 *              travelling right carries the frame right with it.
 *
 *              Owns the camera's PROJECTION and nothing else. The camera's placement —
 *              where it is, what it looks at — belongs to the scene's camera automation
 *              and is never touched here, so the two can run on the same frame without
 *              fighting: one moves the camera, this one changes its lens.
 *
 *              At rest the lens is the scene's own, written back exactly (not merely
 *              near it) and then left alone — a centred, unwidened sound sees the world
 *              it would see with no module at all, and pays nothing per frame for it.
 *              The lens follows the control with nothing in between: no easing, no state
 *              of its own. Smoothing the lens would leave it still moving after the
 *              control had already come to rest, which is exactly the moment the world is
 *              supposed to be untouched.
 *
 *              Takes its knobs resolved (`effectVisualPolicy`), never reads a preset.
 */

const DEG_TO_RAD = Math.PI / 180;

/**
 * The sideways lens shift, in the millimetres of film three.js expresses it in, for a
 * shift of `fraction` of the frame's WIDTH.
 *
 * The raw `filmOffset` is not a constant amount of picture: three divides it by the film
 * width, which itself collapses on a portrait aspect, so the same millimetres that nudge
 * a desktop frame would throw a phone's clean off the screen. Asking for a fraction of
 * the frame and converting per aspect keeps the move the same size on every device.
 *
 * @param {import('three').PerspectiveCamera} camera
 * @param {number} fovDeg - The field of view the shift is measured against (we drive it too).
 * @param {number} fraction - Shift as a share of frame width.
 * @returns {number}
 */
function filmOffsetForFrameFraction(camera, fovDeg, fraction) {
  return fraction * camera.getFilmWidth() * camera.aspect * 2 * Math.tan(fovDeg * DEG_TO_RAD * 0.5);
}

function clampSigned(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
}

/**
 * @param {object} options
 * @param {import('three').PerspectiveCamera} options.camera - THIS voice's camera. A
 *        sibling orbiter has its own; nothing here reaches past this one.
 * @param {number} [options.fovNarrowDeg] - Degrees the lens closes by at a fully narrowed field.
 * @param {number} [options.fovWideDeg] - Degrees the lens opens by at a fully widened field.
 * @param {number} [options.shiftFrac] - Frame widths the lens slides by at a hard pan.
 * @returns {{ update(nowSec: number, dtSec: number, state: object): void, dispose(): void }}
 */
export function createPositionLensLayer({
  camera,
  fovNarrowDeg = 14,
  fovWideDeg = 20,
  shiftFrac = 0.12,
} = {}) {
  // The lens as the scene set it. Restored to the number, so returning to rest leaves no
  // residue of the visual behind.
  const restFov = camera.fov;
  const restFilmOffset = camera.filmOffset;

  // Whether the lens is currently ours. At rest it is the scene's again and we write nothing.
  let held = false;

  function releaseLens() {
    if (!held) return;
    camera.fov = restFov;
    camera.filmOffset = restFilmOffset;
    camera.updateProjectionMatrix();
    held = false;
  }

  return {
    /**
     * @param {number} nowSec
     * @param {number} dtSec
     * @param {{ pan: number, width: number }} state - Signed −1..1, how far each module is
     *        driven from equilibrium and to which side: pan left/right, field narrow/wide.
     */
    update(nowSec, dtSec, state) {
      const width = clampSigned(state.width);
      const pan = clampSigned(state.pan);

      if (width === 0 && pan === 0) {
        releaseLens();
        return;
      }

      // A narrowed field closes the lens, a widened one opens it — the amount of answering
      // is the same at both ends of the sweep, only the direction differs.
      const fov = restFov + width * (width >= 0 ? fovWideDeg : fovNarrowDeg);
      // The frame follows the sound: pan right and the picture slides right, which means the
      // lens's window on the world moves the other way.
      camera.fov = fov;
      camera.filmOffset = restFilmOffset - pan * filmOffsetForFrameFraction(camera, fov, shiftFrac);
      camera.updateProjectionMatrix();
      held = true;
    },
    dispose() {
      releaseLens();
    },
  };
}

export default createPositionLensLayer;
