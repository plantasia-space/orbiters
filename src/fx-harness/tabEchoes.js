/**
 * @file fx-harness/tabEchoes.js
 * @description Echoes group tab (delay family) — "moons answering".
 *              A real ping-pong delay: two cross-fed delay lines panned hard
 *              left/right, with one wet-path meter per side. The visual is the
 *              PRODUCTION layer module (`visual/echoesMoonsLayer.js`) rendered
 *              against the harness stage: the tab feeds it measured per-side
 *              levels (scaled by wet, as production does) and a canvas adapter
 *              wrapping the stage's moons. Toggling the world's moons off
 *              proves the summoned-canvas rule — the layer grows its own ghost
 *              moons and dissolves them with the effect.
 */

import { createEchoesMoonsLayer } from '../visual/echoesMoonsLayer.js';

/** The stage moons' resting orbit radius (stage space, planet radius = 1). */
const MOON_BASE_ORBIT = 1.9;

export function createEchoesTab(rig) {
  return {
    id: 'echoes',
    label: 'Echoes · delay',
    mount(container) {
      const ctx = rig.ensureContext();
      const stage = rig.ensureStage();

      // input → delayL ⇄ delayR (cross-feedback) → panners → wet → out
      const delayL = ctx.createDelay(2);
      const delayR = ctx.createDelay(2);
      const feedbackLR = ctx.createGain();
      const feedbackRL = ctx.createGain();
      const panL = ctx.createStereoPanner();
      const panR = ctx.createStereoPanner();
      panL.pan.value = -0.8;
      panR.pan.value = 0.8;
      const wetL = ctx.createGain();
      const wetR = ctx.createGain();
      const wetOut = ctx.createGain();

      rig.getInputBus().connect(delayL);
      delayL.connect(feedbackLR);
      feedbackLR.connect(delayR);
      delayR.connect(feedbackRL);
      feedbackRL.connect(delayL);
      delayL.connect(wetL);
      delayR.connect(wetR);
      wetL.connect(panL);
      wetR.connect(panR);
      panL.connect(wetOut);
      panR.connect(wetOut);
      wetOut.connect(rig.getDestination());

      // Pre-wet taps, like production's wet-only returns; the frame feed
      // scales by wet so bypass reads as invisible.
      const meterL = rig.createMeter(ctx, wetL);
      const meterR = rig.createMeter(ctx, wetR);

      const params = { time: 0.35, feedback: 0.45, wet: 0 };

      function applyParams() {
        const now = ctx.currentTime;
        delayL.delayTime.setTargetAtTime(params.time, now, 0.05);
        delayR.delayTime.setTargetAtTime(params.time, now, 0.05);
        feedbackLR.gain.setTargetAtTime(params.feedback, now, 0.05);
        feedbackRL.gain.setTargetAtTime(params.feedback, now, 0.05);
        wetOut.gain.setTargetAtTime(params.wet, now, 0.05);
      }
      applyParams();

      let useWorldMoons = true;

      // The stage's per-mesh moons as the layer's canvas (production adapts
      // the world's InstancedMesh the same way).
      const moonsCanvas = {
        exists: () => useWorldMoons,
        drive({ blinkL, blinkR, radiusFactor }) {
          stage.moons.forEach((moon) => {
            moon.radius = MOON_BASE_ORBIT * radiusFactor;
            const left = moon.side < 0;
            // Light only — the moons never change size (a size pop off the meter
            // read as nervous twitching; light can bloom and fade, size can only snap).
            moon.mesh.material.emissiveIntensity = left ? blinkL : blinkR;
          });
        },
        reset() {
          stage.moons.forEach((moon) => {
            moon.mesh.material.emissiveIntensity = 0;
            moon.mesh.scale.setScalar(1);
            moon.radius = MOON_BASE_ORBIT;
          });
        },
      };

      const layer = createEchoesMoonsLayer({ radius: 1, canvas: moonsCanvas });
      stage.overlay.add(layer.group);

      stage.setFrameCallback((now, dt) => {
        layer.update(now, dt, {
          levelL: meterL.read() * params.wet,
          levelR: meterR.read() * params.wet,
          delaySec: params.time,
          wet: params.wet,
        });
      });

      const rows = [
        { key: 'time', label: 'Delay time', min: 0.05, max: 1.2, step: 0.01, unit: 's' },
        { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, unit: '' },
        { key: 'wet', label: 'Wet', min: 0, max: 1, step: 0.01, unit: '' },
      ];
      rows.forEach((spec) => {
        const row = document.createElement('div');
        row.className = 'module';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = spec.label;
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(spec.min);
        slider.max = String(spec.max);
        slider.step = String(spec.step);
        slider.value = String(params[spec.key]);
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = `${params[spec.key]}${spec.unit}`;
        slider.addEventListener('input', () => {
          params[spec.key] = Number(slider.value);
          value.textContent = `${slider.value}${spec.unit}`;
          applyParams();
        });
        row.append(name, slider, value);
        container.appendChild(row);
      });

      const toggleRow = document.createElement('div');
      toggleRow.className = 'row';
      const toggle = document.createElement('label');
      toggle.className = 'toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.addEventListener('change', () => {
        useWorldMoons = checkbox.checked;
        stage.moonsGroup.visible = checkbox.checked;
      });
      toggle.append(checkbox, document.createTextNode('world has moons (unchecked: the delay summons ghost moons)'));
      toggleRow.appendChild(toggle);
      container.appendChild(toggleRow);

      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent =
        'Left moons answer the left echo line, right moons the right — brightness is the measured '
        + 'wet level, so blinks land exactly when repeats are audible. Longer delay = farther moons. '
        + 'Without world moons, translucent ghost moons grow in with the effect and dissolve with it.';
      container.appendChild(hint);

      return {
        dispose() {
          stage.setFrameCallback(null);
          meterL.dispose();
          meterR.dispose();
          try {
            rig.getInputBus().disconnect(delayL);
          } catch (_) {}
          [delayL, delayR, feedbackLR, feedbackRL, panL, panR, wetL, wetR, wetOut].forEach((node) => {
            try {
              node.disconnect();
            } catch (_) {}
          });
          layer.dispose();
          stage.overlay.remove(layer.group);
          stage.moonsGroup.visible = true;
        },
      };
    },
  };
}
