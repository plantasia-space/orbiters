/**
 * @file fx-harness/tabGrit.js
 * @description Grit group tab (distortion, bitcrusher, chebyshev) — "scorched
 *              surface". A real waveshaper (tanh drive curve); wet crossfades
 *              dry↔driven. Pure state, no meter: grit speckles the body with
 *              dark pocks and, as it climbs, glowing embers — a clean world
 *              weathering into cracked, scorched ground. Surface-only by
 *              contract: a generated texture on the material, the geometry
 *              never distorts. Canvas = the body, always present.
 */

import * as THREE from 'three';
import { addSliderRows, addHint } from './controls.js';

const CURVE_SIZE = 1024;
const TEXTURE_SIZE = 256;

function buildDriveCurve(amount) {
  const drive = 1 + amount * 24;
  const curve = new Float32Array(CURVE_SIZE);
  const norm = Math.tanh(drive);
  for (let i = 0; i < CURVE_SIZE; i += 1) {
    const x = (i / (CURVE_SIZE - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

/** Dark pocks over white — the color map multiplies the base, so pocks darken it. */
function drawPockCanvas(canvas, grit) {
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const pocks = Math.round(grit * grit * 700);
  for (let i = 0; i < pocks; i += 1) {
    const r = 2 + Math.random() * 6;
    const shade = 15 + Math.random() * 60;
    g.fillStyle = `rgba(${shade},${shade * 0.9},${shade * 0.8},0.9)`;
    g.beginPath();
    g.arc(Math.random() * TEXTURE_SIZE, Math.random() * TEXTURE_SIZE, r, 0, Math.PI * 2);
    g.fill();
  }
}

/** Embers over black — used as the emissive map so they glow regardless of the base color. */
function drawEmberCanvas(canvas, grit) {
  const g = canvas.getContext('2d');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const embers = Math.round(Math.max(0, grit - 0.5) * 260);
  for (let i = 0; i < embers; i += 1) {
    g.fillStyle = `rgba(255,${90 + Math.random() * 80},40,0.95)`;
    g.beginPath();
    g.arc(Math.random() * TEXTURE_SIZE, Math.random() * TEXTURE_SIZE, 1 + Math.random() * 2.6, 0, Math.PI * 2);
    g.fill();
  }
}

export function createGritTab(rig) {
  return {
    id: 'grit',
    label: 'Grit · distortion',
    mount(container) {
      const ctx = rig.ensureContext();
      const stage = rig.ensureStage();

      const shaper = ctx.createWaveShaper();
      shaper.oversample = '2x';
      const wetOut = ctx.createGain();
      rig.getInputBus().connect(shaper);
      shaper.connect(wetOut);
      wetOut.connect(rig.getDestination());

      const params = { amount: 0.3, wet: 0 };
      const baseRoughness = stage.planet.material.roughness;

      const pockCanvas = document.createElement('canvas');
      pockCanvas.width = TEXTURE_SIZE;
      pockCanvas.height = TEXTURE_SIZE;
      const pockTexture = new THREE.CanvasTexture(pockCanvas);
      const emberCanvas = document.createElement('canvas');
      emberCanvas.width = TEXTURE_SIZE;
      emberCanvas.height = TEXTURE_SIZE;
      const emberTexture = new THREE.CanvasTexture(emberCanvas);

      let redrawTimer = null;

      function applyParams() {
        shaper.curve = buildDriveCurve(params.amount);
        wetOut.gain.setTargetAtTime(params.wet, ctx.currentTime, 0.05);
        rig.setDryLevel(1 - params.wet);

        // Surface responses at knob cadence, not per frame: redraw the pock +
        // ember textures (debounced) and roughen the material with grit.
        const grit = params.amount * params.wet;
        stage.planet.material.roughness = baseRoughness + (1 - baseRoughness) * grit;
        clearTimeout(redrawTimer);
        redrawTimer = setTimeout(() => {
          const material = stage.planet.material;
          if (grit > 0.01) {
            drawPockCanvas(pockCanvas, grit);
            drawEmberCanvas(emberCanvas, grit);
            pockTexture.needsUpdate = true;
            emberTexture.needsUpdate = true;
            if (material.map !== pockTexture) {
              material.map = pockTexture;
              material.emissiveMap = emberTexture;
              material.emissive.set(0xffffff);
              material.emissiveIntensity = 0.9;
              material.needsUpdate = true;
            }
          } else if (material.map) {
            material.map = null;
            material.emissiveMap = null;
            material.emissive.set(0x000000);
            material.emissiveIntensity = 0;
            material.needsUpdate = true;
          }
        }, 90);
      }
      applyParams();

      addSliderRows(container, [
        { key: 'amount', label: 'Drive', min: 0, max: 1, step: 0.01, unit: '' },
        { key: 'wet', label: 'Wet', min: 0, max: 1, step: 0.01, unit: '' },
      ], params, applyParams);

      addHint(container,
        'Grit weathers the surface: dark pocks speckle the body as the drive bites, and past '
        + 'halfway glowing embers crack through — scorched, dry ground. Strictly surface-deep: '
        + 'the shape itself never changes.');

      return {
        dispose() {
          clearTimeout(redrawTimer);
          try {
            rig.getInputBus().disconnect(shaper);
          } catch (_) {}
          [shaper, wetOut].forEach((node) => {
            try {
              node.disconnect();
            } catch (_) {}
          });
          rig.setDryLevel(1);
          const material = stage.planet.material;
          material.roughness = baseRoughness;
          if (material.map) {
            material.map = null;
            material.emissiveMap = null;
            material.emissive.set(0x000000);
            material.emissiveIntensity = 0;
            material.needsUpdate = true;
          }
          pockTexture.dispose();
          emberTexture.dispose();
        },
      };
    },
  };
}
