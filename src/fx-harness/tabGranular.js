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

/**
 * Waveform strip mirroring the classic granular-instrument display: the track's
 * waveform with the dry playhead, a translucent spray band around where grains
 * actually land, and one solid pill per grain spanning the audio slice it plays
 * (vertical offset = pan; reversed grains render hollow). Clicking the strip
 * hands back the normalized x so the caller can anchor the Position module
 * there.
 */
function createWaveformViz(container, { onPickPosition }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'waveviz';

  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 110;
  wrapper.appendChild(canvas);

  const spray = document.createElement('div');
  spray.className = 'waveviz-spray';
  wrapper.appendChild(spray);

  const playhead = document.createElement('div');
  playhead.className = 'waveviz-playhead';
  wrapper.appendChild(playhead);

  wrapper.addEventListener('pointerdown', (event) => {
    const rect = wrapper.getBoundingClientRect();
    if (rect.width <= 0) return;
    onPickPosition(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
  });
  container.appendChild(wrapper);

  let drawnBuffer = null;
  let grainCenterNorm = null;
  let lastGrainAtMs = 0;
  let liveDots = 0;
  let trackDurationSec = 0;

  function drawBuffer(buffer) {
    const ctx2d = canvas.getContext('2d');
    ctx2d.fillStyle = '#101318';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    if (!buffer) return;
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.ceil(data.length / canvas.width));
    const amp = canvas.height / 2;
    ctx2d.fillStyle = '#82b4d1';
    for (let x = 0; x < canvas.width; x += 1) {
      let min = 1;
      let max = -1;
      const start = x * step;
      for (let i = 0; i < step && start + i < data.length; i += 1) {
        const sample = data[start + i];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
      if (min > max) continue;
      ctx2d.fillRect(x, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }
  }

  return {
    onGrain(spawn) {
      // Smoothed grain center drives the spray band — it works identically for
      // follow, anchored and seeking pointers because it reads where grains
      // actually landed, not engine internals.
      grainCenterNorm = grainCenterNorm === null
        ? spawn.positionNorm
        : grainCenterNorm + (spawn.positionNorm - grainCenterNorm) * 0.35;
      lastGrainAtMs = performance.now();
      if (liveDots >= 48) return;
      liveDots += 1;
      const dot = document.createElement('div');
      dot.className = spawn.reversed ? 'waveviz-grain waveviz-grain--reversed' : 'waveviz-grain';
      // A tool marker, not an effect: the pill sits solid on its slice for as
      // long as the grain sounds, then snaps away (short floor so micro grains
      // still register).
      const lifeSec = Math.max(0.15, Math.min(1.2, spawn.durationSec));
      // The pill spans the actual audio slice the grain plays, so grain SIZE
      // is read directly off the strip; micro grains clamp down to a dot.
      // Track duration derives from the spawn itself (positionSec/positionNorm)
      // so the width never depends on the frame loop having run.
      if (spawn.positionNorm > 0.001 && spawn.positionSec > 0) {
        trackDurationSec = spawn.positionSec / spawn.positionNorm;
      }
      const stripWidth = wrapper.clientWidth || 640;
      const slicePx = trackDurationSec > 0
        ? (spawn.durationSec / trackDurationSec) * stripWidth
        : 0;
      dot.style.left = `${(spawn.positionNorm * stripWidth).toFixed(1)}px`;
      dot.style.width = `${Math.max(6, slicePx).toFixed(1)}px`;
      dot.style.top = `${(50 + spawn.pan * 38).toFixed(1)}%`;
      dot.style.animationDuration = `${lifeSec.toFixed(2)}s`;
      // animationend is the normal cleanup; the timer covers a hidden tab
      // (frozen CSS animations) so dots can never pile up at the cap.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        liveDots -= 1;
        dot.remove();
      };
      dot.addEventListener('animationend', release);
      setTimeout(release, lifeSec * 1000 + 500);
      wrapper.appendChild(dot);
    },
    onFrame(engine, buffer, positionMs) {
      if (buffer !== drawnBuffer) {
        drawnBuffer = buffer;
        drawBuffer(buffer);
      }
      const duration = Number(buffer?.duration) || 0;
      trackDurationSec = duration;
      if (duration <= 0) {
        playhead.style.opacity = '0';
        spray.style.opacity = '0';
        return;
      }
      playhead.style.opacity = '1';
      playhead.style.left = `${Math.min(100, (positionMs / 1000 / duration) * 100).toFixed(2)}%`;
      const params = engine?.peekParams() ?? null;
      const active = params && params.wet > 0.001 && grainCenterNorm !== null
        && performance.now() - lastGrainAtMs < 400;
      if (!active) {
        spray.style.opacity = '0';
        return;
      }
      const widthNorm = Math.min(1, (params.positionSpray * 2) / duration);
      spray.style.opacity = '1';
      spray.style.left = `${(grainCenterNorm * 100).toFixed(2)}%`;
      spray.style.width = `${Math.max(0.4, widthNorm * 100).toFixed(2)}%`;
    },
    dispose() {
      wrapper.remove();
    },
  };
}

export function createGranularTab(rig) {
  return {
    id: 'granular',
    label: 'Granular',
    mount(container) {
      const stage = rig.ensureStage();
      let engine = null;
      let removeGrainListener = null;
      let removeVizGrainListener = null;
      const attachments = new Map();
      const moduleControls = new Map();

      const viz = createWaveformViz(container, {
        // Clicking the waveform anchors the Position module there — the same
        // interaction as the classic display's seeker, through the rack mapping.
        onPickPosition(norm) {
          const position = moduleControls.get('position');
          if (!position) return;
          position.setValue(Math.round((norm - 0.5) * 200));
        },
      });

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
        removeVizGrainListener = engine.addGrainListener(viz.onGrain);
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
        viz.onFrame(engine, rig.getBuffer(), rig.getPositionMs());
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

        const setValue = (next) => {
          slider.value = String(next);
          value.textContent = String(next);
          applyModuleValue(moduleSpec, Number(next));
        };
        slider.addEventListener('input', () => setValue(slider.value));
        slider.addEventListener('dblclick', () => setValue(0));
        moduleControls.set(moduleSpec.id, { setValue });
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
          viz.dispose();
          removeGrainListener?.();
          removeVizGrainListener?.();
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
