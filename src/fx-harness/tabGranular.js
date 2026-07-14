/**
 * @file fx-harness/tabGranular.js
 * @description Texture group tab — the granular engine heard through the same
 *              module mapping table the rack effect uses, rendered by the
 *              production accretion-disk layer on the shared stage. This tab
 *              is the vocabulary's reference implementation: an event-rich
 *              engine that earns a dedicated visual layer.
 */

import { GranularEngine } from '../audio/granular/GranularEngine.js';
import { EFFECT_MANIFEST } from '../audio/effects/granular/v1/manifest.js';
import { mapModuleValueToEngineParams } from '../audio/effects/granular/v1/factory.js';

export function createGranularTab(rig) {
  return {
    id: 'granular',
    label: 'Texture · granular',
    mount(container) {
      const stage = rig.ensureStage();
      let engine = null;
      let removeGrainListener = null;
      const attachments = new Map();

      function ensureEngine() {
        if (engine) return engine;
        const ctx = rig.ensureContext();
        engine = new GranularEngine({
          context: ctx,
          getBuffer: rig.getBuffer,
          getPositionMs: rig.getPositionMs,
          isPlaying: rig.isPlaying,
          onDryLevelChange: (level) => rig.setDryLevel(level),
        });
        removeGrainListener = engine.addGrainListener(stage.diskLayer.onGrain);
        engine.outputNode.connect(rig.getDestination());
        return engine;
      }

      function applyModuleValue(moduleSpec, value) {
        const active = ensureEngine();
        let attachment = attachments.get(moduleSpec.id);
        if (!attachment) {
          attachment = active.attach();
          attachments.set(moduleSpec.id, attachment);
        }
        attachment.setParams(mapModuleValueToEngineParams(moduleSpec, value));
      }

      stage.setFrameCallback(() => {
        if (engine) stage.diskLayer.setEngineParams(engine.peekParams());
      });

      EFFECT_MANIFEST.modules.forEach((moduleSpec) => {
        const row = document.createElement('div');
        row.className = 'module';

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = moduleSpec.label;
        row.appendChild(name);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(moduleSpec.valueRange.min);
        slider.max = String(moduleSpec.valueRange.max);
        slider.value = '0';

        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = '0';

        slider.addEventListener('input', () => {
          value.textContent = slider.value;
          applyModuleValue(moduleSpec, Number(slider.value));
        });
        slider.addEventListener('dblclick', () => {
          slider.value = '0';
          value.textContent = '0';
          applyModuleValue(moduleSpec, 0);
        });
        row.appendChild(slider);
        row.appendChild(value);

        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = `${moduleSpec.segments.negative.label} ← 0 → ${moduleSpec.segments.positive.label} · ${moduleSpec.description}`;
        row.appendChild(desc);

        container.appendChild(row);
      });

      const readout = document.createElement('pre');
      readout.textContent = 'engine idle';
      container.appendChild(readout);
      const readoutTimer = setInterval(() => {
        if (!engine) return;
        readout.textContent = JSON.stringify(
          { params: engine.getParams(), stats: engine.stats },
          null,
          2,
        );
      }, 500);

      return {
        dispose() {
          clearInterval(readoutTimer);
          stage.setFrameCallback(null);
          removeGrainListener?.();
          attachments.forEach((attachment) => attachment.setParams({}));
          attachments.clear();
          if (engine) {
            try {
              engine.outputNode.disconnect();
            } catch (_) {}
            engine.dispose?.();
            engine = null;
          }
          rig.setDryLevel(1);
        },
      };
    },
  };
}
