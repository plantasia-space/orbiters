/**
 * @file visual/wobbleMoonsLayer.js
 * @description The wobble group's visual layer (chorus, phaser, tremolo,
 *              vibrato) — "the moons churn". The effect's own low-frequency
 *              oscillator pushes the moons' surfaces around with noise: the
 *              surface swells and settles at exactly the rate you hear, as
 *              strongly as the effect is set, and goes perfectly still when the
 *              effect is bypassed.
 *
 *              These four modulate the sound with an LFO, and Tone exposes no
 *              live value for it — `LFO.phase` is the configured START phase, a
 *              constant, and the modulated AudioParam reads back its intrinsic
 *              value because Web Audio ignores audio-rate inputs there. But rate,
 *              depth and wet are all public. So the layer RECONSTRUCTS the
 *              oscillator: it integrates the phase off the render clock at the
 *              effect's own frequency. The moon breathes on the real rate, and it
 *              costs nothing — no analyser, no meter, no audio-graph tap.
 *
 *              Space form, plant behaviour: a moon's surface stirring like a tide
 *              pool, not a light show.
 *
 *              Host-agnostic like the other layers: no renderer, no RAF, no audio,
 *              and no scene object of its own — it only drives a canvas adapter
 *              over the moons the world already draws.
 */

const TWO_PI = Math.PI * 2;

/** Per family: how the one shared look is inflected. `noiseScale` sets the grain
 *  of the churn (low = broad swells, high = fine ripple); `band` lights a bright
 *  seam sweeping the surface (the phaser's whoosh — every other family pays
 *  nothing for it, a width of 0 compiles to a no-op branch). */
const FAMILY_ACCENTS = {
  // Ocean — wide, slow swells.
  'tone.chorus': { noiseScale: 0.8, bandWidth: 0 },
  // Orbit — a bright seam sweeping the surface as the phase turns.
  'tone.phaser': { noiseScale: 1.4, bandWidth: 0.16 },
  // Heart Pulse — the whole moon breathes as one.
  'tone.tremolo': { noiseScale: 0.5, bandWidth: 0 },
  // Lunar Flutter — a fine, fast ripple.
  'tone.vibrato': { noiseScale: 2.6, bandWidth: 0 },
};
const DEFAULT_ACCENT = { noiseScale: 1, bandWidth: 0 };

/**
 * @param {object} [options]
 * @param {object|null} [options.canvas] - The moons' surface adapter:
 *        `{ sync?(nowSec), exists(): boolean, drive(values), reset() }`.
 * @returns {{
 *   update(nowSec: number, dtSec: number, state: {
 *     rateHz: number, depth: number, wet: number, effectId: string|null,
 *   }): void,
 *   dispose(): void,
 * }}
 */
export function createWobbleMoonsLayer({ canvas = null } = {}) {
  // The reconstructed oscillator. Integrated rather than derived from `nowSec`
  // so that a rate change bends the wobble from where it currently IS — deriving
  // it from absolute time would make every rate change jump the phase.
  let phase = 0;
  let timeSec = 0;
  let amount = 0;
  let disposed = false;
  // Scratch drive values — mutated in place, never re-allocated per frame.
  const driveValues = {
    timeSec: 0,
    wobble: 0,
    amount: 0,
    noiseScale: 1,
    bandWidth: 0,
    bandPhase: 0,
  };

  function update(nowSec, dtSec, state) {
    if (disposed || !state) return;
    const dt = Math.min(0.1, Math.max(0, Number(dtSec) || 0));

    const wet = Math.min(1, Math.max(0, state.wet ?? 0));
    const depth = Math.min(1, Math.max(0, state.depth ?? 0));
    // Presence follows wet: bypass reads as a still surface, not a hidden one.
    const target = wet * depth;
    // Ease the presence so engaging an effect swells the surface rather than
    // snapping it — the sound fades in on its own wet ramp, the visual should too.
    amount += (target - amount) * Math.min(1, dt * 4);
    if (amount < 1e-4) amount = 0;

    const rateHz = Math.max(0, state.rateHz ?? 0);
    phase = (phase + TWO_PI * rateHz * dt) % TWO_PI;
    timeSec += dt;

    const accent = FAMILY_ACCENTS[state.effectId] ?? DEFAULT_ACCENT;

    canvas?.sync?.(nowSec);
    if (!canvas?.exists()) return;

    driveValues.timeSec = timeSec;
    driveValues.wobble = phase;
    driveValues.amount = amount;
    driveValues.noiseScale = accent.noiseScale;
    driveValues.bandWidth = accent.bandWidth;
    // The band rides the same phase, so the seam sweeps in step with the churn.
    driveValues.bandPhase = Math.sin(phase) * 0.4;
    canvas.drive(driveValues);
  }

  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas?.reset?.();
    },
  };
}

export default createWobbleMoonsLayer;
