/**
 * @file visual/echoesMoonsLayer.js
 * @description The echoes group's visual layer (delay families) — "moons
 *              answering". Left moons blink with the measured wet level of the
 *              left echo line, right moons with the right, fainter as feedback
 *              dies — exactly when repeats are audible. Delay time eases the
 *              moons' orbit distance outward (a longer echo comes back from
 *              farther away). Space form, plant behaviour: fireflies answering
 *              each other.
 *
 *              A world without moons doesn't lose the visual — the layer
 *              summons ghost moons: translucent stand-ins that grow in while
 *              the delay exists and dissolve with it, visual-only, never part
 *              of the world's data. Real moons are always preferred.
 *
 *              Host-agnostic like the granular disk layer: owns a THREE.Group
 *              (the ghost moons' home) — no renderer, no RAF, no audio. The
 *              host attaches `group`, drives `update` from its render loop
 *              with measured per-side wet levels (already scaled by the wet
 *              mix, so bypass reads as invisible), and passes a canvas adapter
 *              for the world's real moons. The production orbiter scene and
 *              the dev harness render this SAME module.
 */

import * as THREE from 'three';

/** Measured wet RMS → blink brightness. Real music sits low on the wet tap, so
 *  the gain is generous — a quiet echo still clearly lights its moons, a loud
 *  one flares. */
const BLINK_GAIN = 16;
/** Blink ceiling — bold but bounded, so a strong hit reads as an answer, not a
 *  white-out. */
const MAX_BLINK = 4;
/** The moons answer in LIGHT ONLY — they never change size. Driving their scale
 *  from the meter made them twitch: the wet tap peak-holds per frame, so every
 *  repeat snapped the moons bigger and instantly back, and a body that jumps in
 *  size reads as nervous no matter how well it is timed. Light can bloom and fade
 *  where a size change can only pop.
 *
 *  So the blink is an ENVELOPE over the measured level, not the level itself:
 *  it rises quickly enough to land on the repeat, and falls slowly enough to
 *  glow rather than flicker. Fireflies answering, not a strobe. */
const BLINK_ATTACK_PER_SECOND = 9;
const BLINK_RELEASE_PER_SECOND = 1.8;
/** Orbit-distance growth per second of delay time (factor on the resting orbit). */
const RADIUS_PER_DELAY_SECOND = 0.85;
/** Easing rate toward the target orbit factor — time changes glide, not jump. */
const RADIUS_EASE_PER_SECOND = 2.5;
/** Ghost moons grow in over this long — the effect's organ blooming into place. */
const GHOST_GROW_SECONDS = 0.9;
const GHOST_OPACITY = 0.8;
/** Ghost orbit geometry in layer space (planet radius = 1): matches the real
 *  moons' default orbit (3 planet radii). */
const GHOST_ORBIT_RADIUS = 3;
/** Sized like a large real moon (production moons run ~0.03–0.09 planet radii). */
const GHOST_MOON_RADIUS = 0.09;
/** Fixed ghostly palette — deliberately NOT the theme color, so summoned
 *  stand-ins stay distinguishable from a world's real features. */
const GHOST_COLOR = 0x6f7d95;
const GHOST_EMISSIVE = 0xbfd6ff;
/** Per-ghost orbit variety (side, start phase, vertical tilt, angular speed). */
const GHOST_SPECS = [
  { side: -1, phase: 0.1, tilt: 0.2, speed: 0.24 },
  { side: 1, phase: 0.55, tilt: -0.15, speed: 0.19 },
  { side: -1, phase: 0.4, tilt: -0.24, speed: 0.14 },
  { side: 1, phase: 0.85, tilt: 0.22, speed: 0.28 },
];

/**
 * @param {object} [options]
 * @param {number} [options.radius] - Host-scene scale: the planet's radius in
 *        scene units (the layer is authored with planet radius = 1).
 * @param {object|null} [options.canvas] - Adapter for the world's real moons:
 *        `{ sync?(nowSec), exists(): boolean, drive({ blinkL, blinkR,
 *        radiusFactor }), reset() }`. Null (or `exists()` false) makes
 *        the layer summon ghost moons instead.
 * @param {number} [options.summonedMoonCount] - Ghost-moon pool size when the
 *        world has none (a resolved quality setting).
 * @returns {{
 *   group: THREE.Group,
 *   update(nowSec: number, dtSec: number, state: {
 *     levelL: number, levelR: number, delaySec: number, wet: number,
 *   }): void,
 *   dispose(): void,
 * }}
 */
export function createEchoesMoonsLayer({
  radius = 1,
  canvas = null,
  summonedMoonCount = GHOST_SPECS.length,
} = {}) {
  const group = new THREE.Group();
  group.scale.setScalar(radius);
  group.visible = false;

  const ghostCount = Math.max(1, Math.min(GHOST_SPECS.length, Math.round(summonedMoonCount) || 0));
  let ghosts = null;
  let radiusFactor = 1;
  // The per-side blink envelopes — what the moons actually show, as opposed to
  // the raw level the meter reports this frame.
  let blinkL = 0;
  let blinkR = 0;
  let disposed = false;
  // Scratch drive values — mutated in place, never re-allocated per frame.
  const driveValues = { blinkL: 0, blinkR: 0, radiusFactor: 1 };

  /** Rise fast to a new peak, fall slowly away from it. */
  function followBlink(current, target, dt) {
    const rate = target > current ? BLINK_ATTACK_PER_SECOND : BLINK_RELEASE_PER_SECOND;
    const next = current + (target - current) * Math.min(1, dt * rate);
    return next < 1e-3 ? 0 : next;
  }

  function summonGhosts() {
    if (ghosts) return;
    ghosts = GHOST_SPECS.slice(0, ghostCount).map((spec) => {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(GHOST_MOON_RADIUS, 16, 12),
        new THREE.MeshStandardMaterial({
          color: GHOST_COLOR,
          roughness: 0.4,
          emissive: GHOST_EMISSIVE,
          emissiveIntensity: 0,
          transparent: true,
          opacity: GHOST_OPACITY,
          depthWrite: false,
        }),
      );
      mesh.scale.setScalar(0.001);
      group.add(mesh);
      return { mesh, spec, angle: spec.phase * Math.PI * 2, bornAt: null };
    });
    group.visible = true;
  }

  function dissolveGhosts() {
    if (!ghosts) return;
    ghosts.forEach((ghost) => {
      group.remove(ghost.mesh);
      ghost.mesh.geometry.dispose();
      ghost.mesh.material.dispose();
    });
    ghosts = null;
    group.visible = false;
  }

  function update(nowSec, dtSec, state) {
    if (disposed || !state) return;
    const dt = Math.min(0.1, Math.max(0, Number(dtSec) || 0));
    const active = (state.wet ?? 0) > 0.001;
    const targetL = active ? Math.min((state.levelL ?? 0) * BLINK_GAIN, MAX_BLINK) : 0;
    const targetR = active ? Math.min((state.levelR ?? 0) * BLINK_GAIN, MAX_BLINK) : 0;
    blinkL = followBlink(blinkL, targetL, dt);
    blinkR = followBlink(blinkR, targetR, dt);

    // Orbit distance eases toward the delay's distance so time changes glide.
    const targetFactor = 1 + Math.max(0, state.delaySec ?? 0) * RADIUS_PER_DELAY_SECOND;
    radiusFactor += (targetFactor - radiusFactor) * Math.min(1, dt * RADIUS_EASE_PER_SECOND);

    canvas?.sync?.(nowSec);
    if (canvas?.exists()) {
      dissolveGhosts();
      driveValues.blinkL = blinkL;
      driveValues.blinkR = blinkR;
      driveValues.radiusFactor = radiusFactor;
      canvas.drive(driveValues);
      return;
    }

    summonGhosts();
    ghosts.forEach((ghost) => {
      if (ghost.bornAt === null) ghost.bornAt = nowSec;
      const grow = Math.min((nowSec - ghost.bornAt) / GHOST_GROW_SECONDS, 1);
      ghost.angle += ghost.spec.speed * dt;
      const orbit = GHOST_ORBIT_RADIUS * radiusFactor;
      ghost.mesh.position.set(
        Math.cos(ghost.angle) * orbit * ghost.spec.side,
        Math.sin(ghost.angle * 0.7) * ghost.spec.tilt * orbit,
        Math.sin(ghost.angle) * orbit,
      );
      const blink = ghost.spec.side < 0 ? blinkL : blinkR;
      ghost.mesh.material.emissiveIntensity = blink;
      // Light only — the ghosts answer exactly like the real moons do. `grow` is
      // the one scale change they make, and it happens once, as they bloom in.
      ghost.mesh.scale.setScalar(grow);
    });
  }

  return {
    group,
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      dissolveGhosts();
      canvas?.reset?.();
    },
  };
}

export default createEchoesMoonsLayer;
