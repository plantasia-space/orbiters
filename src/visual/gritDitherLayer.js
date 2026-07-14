/**
 * @file visual/gritDitherLayer.js
 * @description The grit group's visual: the dirt crushes the PICTURE. As the sound
 *              overdrives, bit-crushes or waveshapes, the voice's whole frame
 *              pixelates, its colours collapse to a few steps, and an ordered dither
 *              breaks the gradients — the image goes lo-fi exactly as the sound does.
 *
 *              Owns no scene object: it is a change to how the voice's frame is DRAWN,
 *              not a thing added to the world. It writes ONE CHANNEL of the voice's
 *              frame pass, which it shares with the reverb — a voice has a single
 *              post-pass slot, so the two compose there instead of fighting over it.
 *
 *              Clean sound, untouched world: at grit 0 the channel is silent, so the
 *              picture is bit-for-bit what it would have been without it.
 *
 *              Takes its quality knobs resolved (`effectVisualPolicy`), never reads a
 *              preset or a setting itself.
 */

import { FRAME_PASS_DEFAULTS } from './voiceFramePass.js';

/** Colour steps a clean picture is allowed — high enough to be invisible. */
const CLEAN_LEVELS = 32;

/** The picture must not go dirty before the SOUND does. A distortion driven a little
 *  way off centre is still clean to the ear, so the first stretch of the knob's travel
 *  draws nothing at all — the visual starts where the dirt starts. */
const AUDIBLE_FLOOR = 0.32;
/** …and past that it grows LATE: an exponent above 1 keeps the picture nearly clean
 *  through the gentle part of the drive and saves the crush for a sound that has
 *  really broken up. Linear made the world lo-fi long before the ear agreed. */
const GROWTH = 1.8;

/** How dirty the sound is → how dirty the picture is allowed to be. */
function pictureDirt(drive) {
  const past = (drive - AUDIBLE_FLOOR) / (1 - AUDIBLE_FLOOR);
  if (past <= 0) return 0;
  return Math.min(1, past) ** GROWTH;
}

/**
 * @param {object} options
 * @param {{ set(params: object): void, release(): void }} options.channel - The grit
 *        channel of the voice's shared frame pass.
 * @param {number} [options.pixelSize] - Block size at full grit (px).
 * @param {number} [options.levels] - Colour steps per channel at full grit.
 * @param {number} [options.ditherScale] - Bayer cell size (px).
 * @returns {{ update(nowSec: number, dtSec: number, state: object): void, dispose(): void }}
 */
export function createGritDitherLayer({
  channel,
  pixelSize = FRAME_PASS_DEFAULTS.grit.pixelSize,
  levels = FRAME_PASS_DEFAULTS.grit.levels,
  ditherScale = FRAME_PASS_DEFAULTS.grit.ditherScale,
} = {}) {
  // Last drive seen per kind — the uniforms only move when the sound does.
  const last = { crush: -1, clip: -1, fold: -1 };

  return {
    /**
     * @param {number} nowSec
     * @param {number} dtSec
     * @param {{ crush: number, clip: number, fold: number }} state - How hard each KIND
     *        of dirt is driven, 0..1. A rack can hold more than one at a time, and each
     *        makes its own picture: they are not averaged into a single smear of dirt.
     */
    update(nowSec, dtSec, state) {
      const crushDrive = Math.min(1, Math.max(0, state.crush ?? 0));
      const clipDrive = Math.min(1, Math.max(0, state.clip ?? 0));
      const foldDrive = Math.min(1, Math.max(0, state.fold ?? 0));
      if (
        crushDrive === last.crush
        && clipDrive === last.clip
        && foldDrive === last.fold
      ) {
        return;
      }
      last.crush = crushDrive;
      last.clip = clipDrive;
      last.fold = foldDrive;

      // Everything eases out of "untouched", so the world is never dirtied by a drive
      // the ear cannot hear yet.
      const crush = pictureDirt(crushDrive);
      channel.set({
        crush,
        clip: pictureDirt(clipDrive),
        fold: pictureDirt(foldDrive),
        // The blocks and the colour steps belong to the bit-crusher alone: they are what
        // losing bits looks like. A distortion clips and a waveshaper folds — neither of
        // them pixelates anything.
        pixelSize: 1 + (pixelSize - 1) * crush,
        levels: CLEAN_LEVELS - (CLEAN_LEVELS - levels) * crush,
        ditherScale,
      });
    },
    dispose() {
      channel.set({ crush: 0, clip: 0, fold: 0 });
      channel.release();
    },
  };
}

export default createGritDitherLayer;
