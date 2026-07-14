/**
 * @file fx-harness/tabTime.js
 * @description Time group tab (varispeed, stretch) — "star trails".
 *              Real varispeed on the dry source. The visual is a long
 *              exposure, not a speed change: nothing in the world moves
 *              differently (rotation and orbital speed are a saturated
 *              channel — the worlds already orbit and the camera already
 *              moves). Instead, slowing time makes the moons leave fading
 *              trails behind them, like star-trail photography — time smears;
 *              at normal speed and above the sky stays crisp. Pure state, no
 *              meter. Canvas = ghost copies along the moons' own paths.
 */

import * as THREE from 'three';
import { addSliderRows, addHint } from './controls.js';

const TRAIL_GHOSTS = 6;
const SAMPLE_INTERVAL_SEC = 0.09;
const TRAIL_OPACITY = 0.55;

export function createTimeTab(rig) {
  return {
    id: 'time',
    label: 'Time · speed',
    mount(container) {
      rig.ensureContext();
      const stage = rig.ensureStage();

      const params = { rate: 1 };

      function applyParams() {
        rig.setSourceRate(params.rate);
      }
      applyParams();

      // One shared geometry; per-ghost materials so each fades independently.
      const ghostGeometry = new THREE.SphereGeometry(0.07, 12, 8);
      const trails = stage.moons.map(() => {
        const history = [];
        const ghosts = [];
        for (let i = 0; i < TRAIL_GHOSTS; i += 1) {
          const mesh = new THREE.Mesh(
            ghostGeometry,
            new THREE.MeshBasicMaterial({
              color: 0xbfd6ff,
              transparent: true,
              opacity: 0,
              depthWrite: false,
            }),
          );
          mesh.visible = false;
          stage.overlay.add(mesh);
          ghosts.push(mesh);
          history.push(new THREE.Vector3());
        }
        return { history, ghosts, filled: 0, sampleClock: 0 };
      });

      stage.setFrameCallback((now, dt) => {
        // Trails appear as time stretches below 1× — the long exposure.
        const strength = Math.max(0, 1 - params.rate);
        trails.forEach((trail, moonIndex) => {
          const moon = stage.moons[moonIndex];
          trail.sampleClock += dt;
          if (trail.sampleClock >= SAMPLE_INTERVAL_SEC) {
            trail.sampleClock = 0;
            const recycled = trail.history.pop();
            recycled.copy(moon.mesh.position);
            trail.history.unshift(recycled);
            if (trail.filled < TRAIL_GHOSTS) trail.filled += 1;
          }
          trail.ghosts.forEach((ghost, i) => {
            const age = (i + 1) / (TRAIL_GHOSTS + 1);
            const opacity = strength * TRAIL_OPACITY * (1 - age);
            ghost.visible = i < trail.filled && opacity > 0.01;
            if (!ghost.visible) return;
            ghost.position.copy(trail.history[i]);
            ghost.material.opacity = opacity;
            ghost.scale.setScalar(1 - age * 0.5);
          });
        });
      });

      addSliderRows(container, [
        { key: 'rate', label: 'Rate', min: 0.25, max: 2, step: 0.01, unit: '×' },
      ], params, applyParams);

      addHint(container,
        'A long exposure of the sky: slow the music down and the moons smear into fading star '
        + 'trails — time itself stretches. At normal speed and above the sky stays crisp. '
        + 'Nothing orbits faster or slower; only the way motion is seen changes.');

      return {
        dispose() {
          stage.setFrameCallback(null);
          rig.setSourceRate(1);
          trails.forEach((trail) => {
            trail.ghosts.forEach((ghost) => {
              stage.overlay.remove(ghost);
              ghost.material.dispose();
            });
          });
          ghostGeometry.dispose();
        },
      };
    },
  };
}
