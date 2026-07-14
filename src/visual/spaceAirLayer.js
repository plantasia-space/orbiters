/**
 * @file visual/spaceAirLayer.js
 * @description The space/air group's visual layer (reverb families) — "the room
 *              the world sits in". A reverb takes a sound and lets it go into a
 *              space; the picture does the same. As the tail rings, the sky
 *              AROUND the planet smears outward and the stars pull into streaks;
 *              as the tail dies, the room comes back into focus. The planet
 *              itself stays sharp — the reverb blurs the room, not the world.
 *
 *              The world's own rim glow keeps breathing with the tail exactly as
 *              it always has; this layer does not touch how that halo is tuned.
 *
 *              PRESENCE, NOT SETTINGS. A reverb loads at wet 0.5 with nothing
 *              playing — it is silent, and a silent reverb has no visual. So the
 *              blur is driven by the MEASURED tail (fast attack, slow release),
 *              never by the effect's settings, and below the floor the layer
 *              hands the frame back untouched and costs nothing at all.
 *
 *              Owns no scene object. Like the grit layer, it changes how the
 *              voice's frame is DRAWN: it writes ONE CHANNEL of the voice's shared
 *              frame pass. A voice has a single post-pass slot, so a reverb and a
 *              distortion compose in that one shader instead of silently cancelling
 *              each other. The production orbiter scene and the dev harness render
 *              this SAME module.
 */

/** Measured tail RMS → how far the room is let go. Reverb sits low on the wet
 *  tap, so the gain is generous — the room clearly breathes with the tail. */
const TAIL_GAIN = 12;
/** Decay is normalised against this many seconds of reverb tail. */
const DECAY_NORM_SECONDS = 8;
/** Below this presence the reverb is silent: the pass is bypassed and costs nothing. */
const MIN_PRESENCE = 0.004;
/** It takes more to wake than to sleep, so a tail hovering at the floor can't
 *  thrash the pass on and off frame after frame. */
const WAKE_PRESENCE = 0.02;
/** Presence follows the tail up quickly and lets it go slowly, so the room
 *  breathes with the ring-out instead of flickering on transients. */
const PRESENCE_ATTACK_SEC = 0.08;
const PRESENCE_RELEASE_SEC = 0.9;
/** A small room smears a little even at full tilt; a long one lets go completely. */
const DEPTH_FLOOR = 0.35;
const DEPTH_FROM_DECAY = 0.65;

/** Frame-rate independent glide toward `target`. */
function approach(current, target, dt, tau) {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/**
 * @param {object} options
 * @param {{ set(params: object): void, release(): void }} options.channel - The reverb
 *        channel of the voice's shared frame pass.
 * @param {object|null} [options.glowCanvas] - Adapter for the world's real rim glow:
 *        `{ sync?(nowSec), exists(): boolean, drive({ strength, decayNorm }), reset() }`.
 * @param {number} [options.taps] - Blur samples per pixel in the smeared ring (<= 16).
 * @returns {{
 *   update(nowSec: number, dtSec: number, state: {
 *     tailLevel: number, wet: number, decaySec: number,
 *   }): void,
 *   dispose(): void,
 * }}
 */
export function createSpaceAirLayer({
  channel,
  glowCanvas = null,
  taps,
} = {}) {
  if (taps !== undefined) channel.set({ taps });

  let disposed = false;
  // How present the reverb actually IS — driven by the measured tail, not by the
  // effect's settings. A loaded reverb with nothing playing rings nothing, so it
  // must show nothing. This is why the world must not blur on load.
  let presence = 0;
  // True once the layer has handed the frame back and settled the world; it then
  // costs nothing per frame until the reverb speaks again.
  let idle = false;
  // Scratch drive values — mutated in place, never re-allocated per frame.
  const glowValues = { strength: 0, decayNorm: 0 };

  function settle() {
    channel.set({ strength: 0 });
    glowCanvas?.reset?.();
  }

  return {
    update(nowSec, dtSec, state) {
      if (disposed || !state) return;
      const dt = Math.min(0.1, Math.max(0, Number(dtSec) || 0));
      const wet = Math.min(1, Math.max(0, state.wet ?? 0));
      const decayNorm = Math.min(1, Math.max(0, (state.decaySec ?? 0) / DECAY_NORM_SECONDS));

      const heard = wet > 0.001 ? Math.min((state.tailLevel ?? 0) * TAIL_GAIN, 1) : 0;
      presence = approach(
        presence,
        heard,
        dt,
        heard > presence ? PRESENCE_ATTACK_SEC : PRESENCE_RELEASE_SEC,
      );

      // Hysteresis: once awake it stays awake down to MIN_PRESENCE, but it takes
      // WAKE_PRESENCE to rouse it — a tail hovering at the floor never thrashes.
      const active = idle ? presence > WAKE_PRESENCE : presence > MIN_PRESENCE;
      if (!active) {
        if (!idle) {
          idle = true;
          presence = 0;
          settle();
        }
        return;
      }
      idle = false;

      // How far the room is let go: the measured tail, deepened by the room's size.
      const depth = presence * (DEPTH_FLOOR + decayNorm * DEPTH_FROM_DECAY);
      channel.set({ strength: depth });

      // The world's own rim keeps breathing with the tail, exactly as before.
      glowCanvas?.sync?.(nowSec);
      if (glowCanvas?.exists()) {
        glowValues.strength = depth;
        glowValues.decayNorm = decayNorm;
        glowCanvas.drive(glowValues);
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      settle();
      channel.release();
    },
  };
}

export default createSpaceAirLayer;
