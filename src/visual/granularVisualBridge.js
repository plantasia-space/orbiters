/**
 * @file visual/granularVisualBridge.js
 * @description Binds a voice's granular engine lifetime to its accretion disk
 *              layer — create on demand, dispose when idle. Nothing exists
 *              until the voice's first granular module creates an engine; the
 *              layer (geometry, material, render callback) is built at that
 *              moment and fully torn down when the last module releases it.
 *
 *              Mounted per voice at the moment the voice's `audioEngine` lands
 *              on its registry entry — the one point where the adapter (whose
 *              source-engine host this bridge observes) and the voice's scene
 *              controller are both known. One `peekSourceEngine` covers an
 *              engine created during adapter init (persisted rack config);
 *              one host observation covers every later create/dispose.
 *              No retries, no polling.
 *
 *              The returned `dispose()` is owned by the app instance that
 *              mounted it (`createOrbitersApp`'s teardown) — the single-orbiter
 *              path never unregisters its voice, so registry events cannot be
 *              the teardown trigger.
 */

import * as THREE from 'three';
import { EARTH_RADIUS_UNITS } from 'entangled-worlds-orbiters-shared/world';
import { GRANULAR_ENGINE_ID } from '../audio/granular/GranularEngine.js';
import { ORBIT_TILT_DEG } from '../world/Ring.js';
import { createGranularDiskLayer } from './granularDiskLayer.js';

/** Disk tilt beyond the shared orbit-ring plane (degrees). 0 = exactly the ring plane. */
const EXTRA_TILT_DEG = 0;
/** Per-grain echo ceiling when more than this many granular disks are visible at once. */
const MAX_CONCURRENT_FULL_LAYERS = 2;

// How many granular disks currently have live particles, across ALL mounted
// bridges (a shared realm renders many voices into one GPU). Above the
// threshold every layer drops to a single particle per grain — amount
// legibility yields to the frame budget. The registry has no "audible voices"
// concept, so this module is the counter's one owner.
let audibleLayerCount = 0;

/**
 * @param {object} voiceEntry - The voice's registry entry; reads
 *        `worldController` (scene host) and `audioEngine` (the adapter hosting
 *        the voice's source engines). Entries without a scene (audio-only feed
 *        voices) mount nothing, by construction.
 * @param {object} [options]
 * @param {() => object|null} [options.getVisualSettings] - Live source of the
 *        voice's resolved effect-visual settings (`effectVisualPolicy.js`);
 *        the `texture` group gates mounting and bounds the per-grain echo
 *        particles (constrained GPUs render fewer copies).
 * @returns {{ dispose(): void }}
 */
export function mountGranularVisual(voiceEntry, { getVisualSettings = null } = {}) {
  const worldController = voiceEntry?.worldController ?? null;
  const adapter = voiceEntry?.audioEngine ?? null;
  // The voice's ring oscilloscope owns the live orbit color (designer theme,
  // per-dimension) — the disk palette derives from it.
  const oscilloscope = voiceEntry?.oscilloscope ?? null;
  if (!worldController || !adapter) {
    return { dispose() {} };
  }

  let layer = null;
  let unsubscribeGrains = null;
  let renderCallback = null;
  let disposed = false;
  let countedAudible = false;

  function setAudible(audible) {
    if (audible === countedAudible) return;
    countedAudible = audible;
    audibleLayerCount += audible ? 1 : -1;
  }

  function teardownLayer() {
    if (!layer) return;
    if (renderCallback) {
      worldController.removeRenderCallback(renderCallback);
      renderCallback = null;
    }
    unsubscribeGrains?.();
    unsubscribeGrains = null;
    setAudible(false);
    worldController.detachOverlay(layer.group);
    layer.dispose();
    layer = null;
  }

  function mountLayer(engine) {
    if (disposed || layer) return;
    // The user-preference gate: resolved settings decide whether the texture
    // group's layer exists at all (quality knobs still apply once mounted).
    if (getVisualSettings?.()?.texture?.enabled === false) return;
    layer = createGranularDiskLayer({ radius: EARTH_RADIUS_UNITS });
    // The disk sits on the same plane as the orbit rings (precession spins the
    // group's local y BEFORE this tilt in the XYZ euler order, so it stays in
    // the disk plane).
    layer.group.rotation.x = THREE.MathUtils.degToRad(ORBIT_TILT_DEG + EXTRA_TILT_DEG);
    worldController.attachOverlay(layer.group);
    unsubscribeGrains = engine.addGrainListener(layer.onGrain);

    // The voice's own render loop drives the layer clock (the frame object is
    // supplied by the scene controller); while the layer has no live particles
    // `update` early-returns after a visibility check.
    renderCallback = (frame) => {
      const params = engine.peekParams();
      // Count by actual visibility (live particles), not raw wet — a stopped
      // voice with a hot knob spawns nothing and must not clamp its siblings.
      setAudible(layer.group.visible === true);
      const budget = getVisualSettings?.()?.texture?.echoCopies ?? 5;
      layer.setEchoCap(audibleLayerCount > MAX_CONCURRENT_FULL_LAYERS ? 1 : budget);
      if (oscilloscope?.orbitColor) {
        // Compare-set inside the layer — tracks theme + dimension changes for free.
        layer.setBaseColor(oscilloscope.orbitColor);
      }
      layer.setEngineParams(params);
      layer.update(frame.nowSec, frame.dtSec);
    };
    worldController.addRenderCallback(renderCallback);
  }

  const existingEngine = adapter.peekSourceEngine?.(GRANULAR_ENGINE_ID) ?? null;
  if (existingEngine) {
    mountLayer(existingEngine);
  }
  const unobserve = adapter.observeSourceEngines?.((id, engine) => {
    if (id !== GRANULAR_ENGINE_ID) return;
    if (engine) {
      mountLayer(engine);
    } else {
      teardownLayer();
    }
  }) ?? (() => {});

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unobserve();
      teardownLayer();
    },
  };
}

export default mountGranularVisual;
