/**
 * @file fx-harness/tabPosition.js
 * @description Position group tab (panners, widener) — "leaning to the light".
 *              A real stereo panner plus a mid/side width stage, taking over
 *              the voice's output (dry is ducked so both are actually heard).
 *              Pure state, no meter: the body and ring lean toward the side
 *              the sound sits on — phototropism, the plant bending toward its
 *              sun — and the widener accent splits the ring into a stereo
 *              pair, drifting apart as the image widens. Canvas = body and
 *              ring transforms, always present.
 */

import * as THREE from 'three';
import { addSliderRows, addHint } from './controls.js';

const MAX_LEAN_OFFSET = 0.35;
const MAX_LEAN_TILT = 0.12;
const MAX_SPLIT_OFFSET = 0.2;
const SPLIT_OPACITY = 0.6;

export function createPositionTab(rig) {
  return {
    id: 'position',
    label: 'Position · pan',
    mount(container) {
      const ctx = rig.ensureContext();
      const stage = rig.ensureStage();

      // input → panner → mid/side width matrix → out (takeover: dry is ducked)
      const panner = ctx.createStereoPanner();
      const splitter = ctx.createChannelSplitter(2);
      const midSum = ctx.createGain();
      const sideSum = ctx.createGain();
      const halfL = ctx.createGain();
      const halfR = ctx.createGain();
      const halfLSide = ctx.createGain();
      const halfRSideNeg = ctx.createGain();
      const sideWidth = ctx.createGain();
      const sideInvert = ctx.createGain();
      const merger = ctx.createChannelMerger(2);
      const out = ctx.createGain();

      halfL.gain.value = 0.5;
      halfR.gain.value = 0.5;
      halfLSide.gain.value = 0.5;
      halfRSideNeg.gain.value = -0.5;
      sideInvert.gain.value = -1;

      rig.getInputBus().connect(panner);
      panner.connect(splitter);
      splitter.connect(halfL, 0);
      splitter.connect(halfR, 1);
      halfL.connect(midSum);
      halfR.connect(midSum);
      splitter.connect(halfLSide, 0);
      splitter.connect(halfRSideNeg, 1);
      halfLSide.connect(sideSum);
      halfRSideNeg.connect(sideSum);
      sideSum.connect(sideWidth);
      // left = mid + side, right = mid − side
      midSum.connect(merger, 0, 0);
      sideWidth.connect(merger, 0, 0);
      midSum.connect(merger, 0, 1);
      sideWidth.connect(sideInvert);
      sideInvert.connect(merger, 0, 1);
      merger.connect(out);
      out.connect(rig.getDestination());
      rig.setDryLevel(0);

      const params = { pan: 0, width: 0 };

      function applyParams() {
        const now = ctx.currentTime;
        panner.pan.setTargetAtTime(params.pan, now, 0.05);
        // width 0 = natural image, 1 = side channel boosted well past natural
        sideWidth.gain.setTargetAtTime(1 + params.width * 1.8, now, 0.05);
      }
      applyParams();

      // The widener's ring pair — ghostly clones that drift apart with width.
      const ringPair = [-1, 1].map((side) => {
        const clone = new THREE.Mesh(
          stage.ring.geometry,
          stage.ring.material.clone(),
        );
        clone.material.transparent = true;
        clone.material.opacity = 0;
        clone.material.depthWrite = false;
        clone.rotation.copy(stage.ring.rotation);
        clone.visible = false;
        stage.overlay.add(clone);
        return { mesh: clone, side };
      });

      let lean = 0;

      stage.setFrameCallback(() => {
        // The lean eases toward the pan so knob jumps read as a slow bend.
        lean += (params.pan - lean) * 0.06;
        const leanOffset = lean * MAX_LEAN_OFFSET;
        stage.planet.position.x = leanOffset;
        stage.ring.position.x = leanOffset;
        stage.planet.rotation.x = lean * -MAX_LEAN_TILT;

        ringPair.forEach(({ mesh, side }) => {
          const visible = params.width > 0.01;
          mesh.visible = visible;
          if (!visible) return;
          mesh.position.x = leanOffset + side * params.width * MAX_SPLIT_OFFSET;
          mesh.material.opacity = params.width * SPLIT_OPACITY;
        });
      });

      addSliderRows(container, [
        { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, unit: '' },
        { key: 'width', label: 'Width', min: 0, max: 1, step: 0.01, unit: '' },
      ], params, applyParams);

      addHint(container,
        'The body and ring lean toward the side the sound sits on — phototropism, bending '
        + 'toward the light. Width splits the ring into a ghostly stereo pair drifting apart. '
        + 'Headphones recommended; width is only audible on stereo material.');

      return {
        dispose() {
          stage.setFrameCallback(null);
          try {
            rig.getInputBus().disconnect(panner);
          } catch (_) {}
          [panner, splitter, midSum, sideSum, halfL, halfR, halfLSide, halfRSideNeg,
            sideWidth, sideInvert, merger, out].forEach((node) => {
            try {
              node.disconnect();
            } catch (_) {}
          });
          rig.setDryLevel(1);
          ringPair.forEach(({ mesh }) => {
            stage.overlay.remove(mesh);
            mesh.material.dispose();
          });
          stage.planet.position.x = 0;
          stage.ring.position.x = 0;
          stage.planet.rotation.x = 0;
        },
      };
    },
  };
}
