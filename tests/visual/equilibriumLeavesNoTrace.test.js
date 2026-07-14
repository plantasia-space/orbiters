// @vitest-environment jsdom
/**
 * The rule every effect visual lives by, held to the two layers that write into the world
 * the app already owns — the camera's lens, and the moons' own colour.
 *
 * At equilibrium the visual is ABSENT: the lens is the number the scene set, the moons are
 * the colour the world built them, to the bit. And coming back from a drive must leave NO
 * residue — a visual that half-restores is worse than one that never ran, because the user
 * cannot tell where their world went.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createPositionLensLayer } from '../../src/visual/positionLensLayer.js';
import { createColorTintLayer } from '../../src/visual/colorTintLayer.js';
import { createWorldMoonsTintCanvas } from '../../src/visual/worldCanvasAdapters.js';

const AT_REST = { pan: 0, width: 0 };
const FLAT = { low: 0, mid: 0, high: 0 };

function createCamera() {
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 5000);
  camera.filmOffset = 0;
  return camera;
}

/**
 * A world with the moon field the way the shared package builds it: ONE InstancedMesh with
 * one shared material, under a group named `moonsGroup` — the handle the canvas binds to.
 */
function createMoonWorld() {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.name = 'moonsGroup';
  const material = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
  const moons = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 8, 6), material, 4);
  group.add(moons);
  scene.add(group);
  return { scene, group, moons, material };
}

function moonSnapshot({ material }) {
  return material.color.getHex();
}

describe('at equilibrium a visual is absent, and it leaves nothing behind', () => {
  describe('the camera lens (panner + stereo widener)', () => {
    it('does not touch the lens while the modules rest at equilibrium', () => {
      const camera = createCamera();
      const layer = createPositionLensLayer({ camera });

      layer.update(0, 0.016, AT_REST);
      layer.update(1, 0.016, AT_REST);

      expect(camera.fov).toBe(45);
      expect(camera.filmOffset).toBe(0);
      layer.dispose();
    });

    it('moves the lens when driven, and puts it back EXACTLY on the way home', () => {
      const camera = createCamera();
      const layer = createPositionLensLayer({ camera });

      layer.update(0, 0.016, { pan: 0.8, width: 0.6 });
      expect(camera.fov).not.toBe(45);
      expect(camera.filmOffset).not.toBe(0);

      layer.update(1, 0.016, AT_REST);
      expect(camera.fov).toBe(45);        // to the number, not to something close
      expect(camera.filmOffset).toBe(0);
      layer.dispose();
    });

    it('answers a pan to either side, and a field narrowed or widened, in opposite directions', () => {
      const camera = createCamera();
      const layer = createPositionLensLayer({ camera });

      layer.update(0, 0.016, { pan: 1, width: 0 });
      const right = camera.filmOffset;
      layer.update(1, 0.016, { pan: -1, width: 0 });
      expect(camera.filmOffset).toBeCloseTo(-right, 6); // a side, not just an amount

      layer.update(2, 0.016, { pan: 0, width: 1 });
      const wide = camera.fov;
      layer.update(3, 0.016, { pan: 0, width: -1 });
      expect(wide).toBeGreaterThan(45);   // widened opens the lens
      expect(camera.fov).toBeLessThan(45); // narrowed closes it
      layer.dispose();
    });

    it('hands the lens back when the effect leaves the rack (dispose)', () => {
      const camera = createCamera();
      const layer = createPositionLensLayer({ camera });

      layer.update(0, 0.016, { pan: 1, width: 1 });
      layer.dispose();

      expect(camera.fov).toBe(45);
      expect(camera.filmOffset).toBe(0);
    });

    it('a sibling orbiter\'s camera is untouched — each voice holds its own lens', () => {
      const mine = createCamera();
      const sibling = createCamera();
      const layer = createPositionLensLayer({ camera: mine });

      layer.update(0, 0.016, { pan: 1, width: 1 });

      expect(sibling.fov).toBe(45);
      expect(sibling.filmOffset).toBe(0);
      layer.dispose();
    });
  });

  describe('the world\'s moons (EQ)', () => {
    it('does not touch the moons while the EQ is flat', () => {
      const world = createMoonWorld();
      const before = moonSnapshot(world);
      const layer = createColorTintLayer({ canvas: createWorldMoonsTintCanvas({ scene: world.scene }) });

      layer.update(0, 0.016, FLAT);
      layer.update(1, 0.016, FLAT);

      expect(moonSnapshot(world)).toEqual(before);
      layer.dispose();
    });

    it('weighs the moons when a band moves, and gives the colour back EXACTLY at flat', () => {
      const world = createMoonWorld();
      const before = moonSnapshot(world);
      const layer = createColorTintLayer({ canvas: createWorldMoonsTintCanvas({ scene: world.scene }) });

      layer.update(0, 0.016, { low: 1, mid: 0, high: -1 }); // lows boosted, highs cut
      expect(moonSnapshot(world)).not.toEqual(before);

      layer.update(1, 0.016, FLAT);
      expect(moonSnapshot(world)).toEqual(before); // the moons' own colour, to the bit
      layer.dispose();
    });

    it('gives the colour back when the effect leaves the rack (dispose)', () => {
      const world = createMoonWorld();
      const before = moonSnapshot(world);
      const layer = createColorTintLayer({ canvas: createWorldMoonsTintCanvas({ scene: world.scene }) });

      layer.update(0, 0.016, { low: 1, mid: 1, high: -1 });
      layer.dispose();

      expect(moonSnapshot(world)).toEqual(before);
    });

    it('the world itself is never tinted — the moons answer, the planet keeps its colour', () => {
      const world = createMoonWorld();
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(1, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0x88aa66 }),
      );
      planet.name = 'worldTextureBody';
      world.scene.add(planet);
      const layer = createColorTintLayer({ canvas: createWorldMoonsTintCanvas({ scene: world.scene }) });

      layer.update(0, 0.016, { low: 1, mid: -1, high: 1 });

      expect(moonSnapshot(world)).not.toEqual(0xffffff);   // the moons took the colour
      expect(planet.material.color.getHex()).toBe(0x88aa66); // and the world kept its own
      layer.dispose();
    });

    it('a sibling orbiter\'s moons are untouched — each voice tints its own scene', () => {
      const mine = createMoonWorld();
      const sibling = createMoonWorld();
      const siblingBefore = moonSnapshot(sibling);
      const layer = createColorTintLayer({ canvas: createWorldMoonsTintCanvas({ scene: mine.scene }) });

      layer.update(0, 0.016, { low: 1, mid: -1, high: 1 });

      expect(moonSnapshot(sibling)).toEqual(siblingBefore);
      layer.dispose();
    });

    it('the moon field is rebuilt with the world — the tint follows the NEW moons, not the old', () => {
      const world = createMoonWorld();
      const layer = createColorTintLayer({ canvas: createWorldMoonsTintCanvas({ scene: world.scene }) });
      layer.update(0, 0.016, { low: 1, mid: 0, high: -1 });

      // The world swaps its moon field (a new count / a new world builds a new mesh).
      world.group.remove(world.moons);
      const rebuilt = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.1, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xffddaa }),
        6,
      );
      world.group.add(rebuilt);

      // Past the canvas's re-query throttle, the new field takes the tint from ITS own base.
      layer.update(2, 0.016, { low: 1, mid: 0, high: -1 });
      expect(rebuilt.material.color.getHex()).not.toBe(0xffddaa);

      layer.update(3, 0.016, FLAT);
      expect(rebuilt.material.color.getHex()).toBe(0xffddaa); // its own colour, not the old field's
      layer.dispose();
    });
  });
});
