/**
 * @file fx-harness/tabSpace.js
 * @description Space/air group tab (reverb family) — "atmosphere and mist".
 *              A convolver reverb over a generated exponential-decay impulse.
 *              The visual is the PRODUCTION layer module
 *              (`visual/spaceAirLayer.js`) rendered against the harness stage:
 *              the tab feeds it the measured wet tail (scaled by wet, as
 *              production does) and canvas adapters wrapping the stage's cloud
 *              shell and glow sprite. Toggling the atmosphere off proves the
 *              summoned-canvas rule — the layer grows its own fainter mist and
 *              halo, existing only while the effect does.
 */

import { createSpaceAirLayer } from '../visual/spaceAirLayer.js';

const HALO_BASE_SCALE = 2.6;
const HALO_DECAY_SCALE = 1.8;

function buildImpulse(ctx, decaySeconds) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * decaySeconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.2);
    }
  }
  return impulse;
}

export function createSpaceTab(rig) {
  return {
    id: 'space',
    label: 'Space/air · reverb',
    mount(container) {
      const ctx = rig.ensureContext();
      const stage = rig.ensureStage();

      const convolver = ctx.createConvolver();
      const wetOut = ctx.createGain();
      rig.getInputBus().connect(convolver);
      convolver.connect(wetOut);
      wetOut.connect(rig.getDestination());
      // Pre-wet tap, like production's wet-only returns; the frame feed
      // scales by wet so bypass reads as invisible.
      const meter = rig.createMeter(ctx, convolver);

      const params = { decay: 2.5, wet: 0 };
      let impulseTimer = null;

      function applyParams({ rebuildImpulse = false } = {}) {
        wetOut.gain.setTargetAtTime(params.wet, ctx.currentTime, 0.05);
        if (rebuildImpulse) {
          // Debounced: generating sampleRate×decay samples on every slider tick would stutter.
          clearTimeout(impulseTimer);
          impulseTimer = setTimeout(() => {
            convolver.buffer = buildImpulse(ctx, params.decay);
          }, 120);
        }
      }
      convolver.buffer = buildImpulse(ctx, params.decay);
      applyParams();

      let worldHasAtmosphere = true;

      // The stage's shell/glow as the layer's canvases (production adapts the
      // world's cloud shell and fresnel glow the same way).
      const shellCanvas = {
        exists: () => worldHasAtmosphere,
        drive({ opacityBoost, scaleFactor }) {
          stage.cloudShell.visible = opacityBoost > 0.002;
          stage.cloudShell.material.opacity = opacityBoost;
          stage.cloudShell.scale.setScalar(scaleFactor);
          stage.cloudShell.rotation.y += 0.0012;
        },
        reset() {
          stage.cloudShell.visible = false;
          stage.cloudShell.material.opacity = 0;
          stage.cloudShell.scale.setScalar(1);
        },
      };
      const glowCanvas = {
        exists: () => worldHasAtmosphere,
        drive({ strength, decayNorm }) {
          stage.glow.visible = strength > 0.004;
          stage.glow.material.opacity = strength;
          stage.glow.scale.setScalar(HALO_BASE_SCALE + decayNorm * HALO_DECAY_SCALE);
        },
        reset() {
          stage.glow.visible = false;
          stage.glow.material.opacity = 0;
        },
      };

      const layer = createSpaceAirLayer({ radius: 1, shellCanvas, glowCanvas });
      stage.overlay.add(layer.group);

      stage.setFrameCallback((now, dt) => {
        layer.update(now, dt, {
          tailLevel: meter.read() * params.wet,
          wet: params.wet,
          decaySec: params.decay,
        });
      });

      const rows = [
        { key: 'decay', label: 'Decay', min: 0.3, max: 8, step: 0.1, unit: 's', impulse: true },
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
          applyParams({ rebuildImpulse: Boolean(spec.impulse) });
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
        worldHasAtmosphere = checkbox.checked;
      });
      toggle.append(checkbox, document.createTextNode('world has atmosphere (unchecked: the reverb summons its own mist)'));
      toggleRow.appendChild(toggle);
      container.appendChild(toggleRow);

      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent =
        'The shell thickens with the knobs; the glow follows a wet-path meter, so stop the dry '
        + 'loop with a long decay and watch the mist keep breathing exactly as long as the tail '
        + 'rings. A world without an atmosphere gets a summoned, fainter mist instead of nothing.';
      container.appendChild(hint);

      return {
        dispose() {
          clearTimeout(impulseTimer);
          stage.setFrameCallback(null);
          meter.dispose();
          try {
            rig.getInputBus().disconnect(convolver);
          } catch (_) {}
          [convolver, wetOut].forEach((node) => {
            try {
              node.disconnect();
            } catch (_) {}
          });
          layer.dispose();
          stage.overlay.remove(layer.group);
        },
      };
    },
  };
}
