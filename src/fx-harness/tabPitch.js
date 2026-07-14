/**
 * @file fx-harness/tabPitch.js
 * @description Pitch group tab (pitch/frequency shifters) — "doppler".
 *              Harness audio is the dry source's detune (a varispeed
 *              stand-in — production binds to the real pitch-shift engine's
 *              state; the visual contract is identical). Pure state, no
 *              meter: shifting down reddens the body and ring, shifting up
 *              blues them — redshift and blueshift, the sky's own vocabulary.
 *              Plant behaviour: ripening. Canvas = body + ring tint.
 */

import * as THREE from 'three';
import { addSliderRows, addHint } from './controls.js';

const REDSHIFT = new THREE.Color(0xff5533);
const BLUESHIFT = new THREE.Color(0x6688ff);
const MAX_TINT = 0.85;

export function createPitchTab(rig) {
  return {
    id: 'pitch',
    label: 'Pitch · shift',
    mount(container) {
      rig.ensureContext();
      const stage = rig.ensureStage();

      const params = { cents: 0 };

      function applyParams() {
        rig.setSourceDetune(params.cents);
      }

      stage.setFrameCallback(() => {
        const norm = params.cents / 1200;
        const strength = Math.min(Math.abs(norm), 1) * MAX_TINT;
        const tint = norm < 0 ? REDSHIFT : BLUESHIFT;
        stage.ring.material.emissive.copy(tint);
        stage.ring.material.emissiveIntensity = 0.5 + strength * 1.6;
        stage.planet.material.emissive.copy(tint);
        stage.planet.material.emissiveIntensity = strength * 0.22;
      });

      addSliderRows(container, [
        { key: 'cents', label: 'Shift', min: -1200, max: 1200, step: 10, unit: '¢' },
      ], params, applyParams);

      addHint(container,
        'Down shifts redden the world, up shifts blue it — redshift and blueshift, exactly as '
        + 'the sky does it. (Harness audio is a varispeed stand-in; the production visual binds '
        + 'to the real pitch-shift engine the same way.) Double-click the slider to reset.');

      return {
        dispose() {
          stage.setFrameCallback(null);
          rig.setSourceDetune(0);
          stage.ring.material.emissive.set(0x44506a);
          stage.ring.material.emissiveIntensity = 0.5;
          stage.planet.material.emissive.set(0x000000);
          stage.planet.material.emissiveIntensity = 0;
        },
      };
    },
  };
}
