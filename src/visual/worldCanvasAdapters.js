/**
 * @file visual/worldCanvasAdapters.js
 * @description Canvas adapters binding the effect-visual layers to the REAL
 *              world elements of a voice's scene (the layers themselves are
 *              host-agnostic — the dev harness passes its own adapters).
 *
 *              Contract per adapter: `sync(nowSec)` refreshes the element
 *              handle (world/mode changes rebuild these objects, so handles
 *              are re-queried when detached — throttled while absent);
 *              `exists()` answers "does this world have the element right
 *              now"; `drive(values)` applies the layer's computed values;
 *              `reset()` restores the element's captured base state. Adapters
 *              only MODULATE world elements — creation and disposal stay with
 *              their owners.
 */

import {
  acquireNoiseTexture,
  addNoiseInstanceAttributes,
  applyNoiseSurface,
  releaseNoiseTexture,
  removeNoiseInstanceAttributes,
} from './noiseSource.js';

/** While the element is absent, re-query the scene at most this often. */
const REQUERY_INTERVAL_SEC = 1;
/** Blink → per-instance tint boost of the answering moons (values above 1 brighten). */
const MOON_COLOR_BOOST_PER_BLINK = 1.4;
/** Measured tail strength → fresnel rim swell of the world's glow. */
const GLOW_FRESNEL_BOOST = 2.4;

function isAttachedTo(object, root) {
  let node = object;
  while (node) {
    if (node === root) return true;
    node = node.parent;
  }
  return false;
}

/**
 * Shared handle tracking: keeps `current` pointing at a live scene element,
 * re-querying (throttled) when the world rebuild detaches it.
 */
function trackSceneElement({ scene, find, onAcquire, onLost }) {
  let current = null;
  let lastQueryAt = -Infinity;

  return {
    sync(nowSec) {
      if (current && isAttachedTo(current, scene)) return;
      if (current) {
        // Hand the detached element back so an adapter that modulated it can
        // restore its base BEFORE the handle is dropped — otherwise a later
        // re-acquire of the SAME element would capture the modulated state as
        // its new base.
        const lost = current;
        current = null;
        onLost?.(lost);
      }
      const now = Number.isFinite(nowSec) ? nowSec : 0;
      if (now - lastQueryAt < REQUERY_INTERVAL_SEC) return;
      lastQueryAt = now;
      const found = find() ?? null;
      if (found) {
        current = found;
        onAcquire?.(found);
      }
    },
    get: () => current,
  };
}

/**
 * The echoes group's canvas: the world's moons — one InstancedMesh with a
 * shared material, static by construction. Per-moon response therefore runs
 * through the instance channels only: tint boost (`instanceColor`) for the
 * blink and a matrix rewrite for the size pop + orbit-distance factor. Base
 * matrices/colors are captured on acquire and restored on reset.
 *
 * @param {object} options
 * @param {import('three').Scene} options.scene - The voice's scene.
 */
export function createWorldMoonsCanvas({ scene }) {
  let count = 0;
  let baseMatrices = null;
  let baseColors = null;
  let sides = null;
  // Last applied drive values — one reused record, no per-frame allocation.
  const lastApplied = { blinkL: NaN, blinkR: NaN, radiusFactor: NaN };

  function clearLastApplied() {
    lastApplied.blinkL = NaN;
    lastApplied.blinkR = NaN;
    lastApplied.radiusFactor = NaN;
  }

  const tracker = trackSceneElement({
    scene,
    find: () => {
      const group = scene?.getObjectByName?.('moonsGroup');
      return group?.children?.find((child) => child.isInstancedMesh) ?? null;
    },
    onAcquire(mesh) {
      count = mesh.count;
      baseMatrices = mesh.instanceMatrix.array.slice(0, count * 16);
      baseColors = mesh.instanceColor ? mesh.instanceColor.array.slice(0, count * 3) : null;
      sides = new Int8Array(count);
      for (let i = 0; i < count; i += 1) {
        // Stereo side = which half of the orbit the moon sits on (local x sign).
        sides[i] = baseMatrices[i * 16 + 12] < 0 ? -1 : 1;
      }
      clearLastApplied();
    },
    onLost() {
      // The world owns (and already disposed) the old mesh — drop captures only.
      count = 0;
      baseMatrices = null;
      baseColors = null;
      sides = null;
      clearLastApplied();
    },
  });

  function apply(mesh, { blinkL, blinkR, radiusFactor }) {
    const matrices = mesh.instanceMatrix.array;
    const colors = mesh.instanceColor?.array ?? null;
    for (let i = 0; i < count; i += 1) {
      const side = sides[i];
      const blink = side < 0 ? blinkL : blinkR;
      const m = i * 16;
      // The moons keep their SIZE — the echo answers in light alone. Only the
      // orbit distance moves, pushed outward in the orbit plane (local y
      // untouched, so the moons keep their height) and eased by the layer.
      matrices[m + 12] = baseMatrices[m + 12] * radiusFactor;
      matrices[m + 14] = baseMatrices[m + 14] * radiusFactor;
      if (colors && baseColors) {
        const c = i * 3;
        const boost = 1 + blink * MOON_COLOR_BOOST_PER_BLINK;
        colors[c] = baseColors[c] * boost;
        colors[c + 1] = baseColors[c + 1] * boost;
        colors[c + 2] = baseColors[c + 2] * boost;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return {
    sync: tracker.sync,
    exists: () => tracker.get() !== null,
    drive(values) {
      const mesh = tracker.get();
      if (!mesh || !baseMatrices) return;
      // Idle frames repeat the same values — skip the buffer rewrite + upload.
      // The threshold is a perceptual floor, not machine epsilon: sub-visible
      // deltas (the fading end of an echo tail) settle to base once and then
      // stop churning the buffers, so a decaying effect idles sooner.
      if (
        Math.abs(lastApplied.blinkL - values.blinkL) < 2e-3
        && Math.abs(lastApplied.blinkR - values.blinkR) < 2e-3
        && Math.abs(lastApplied.radiusFactor - values.radiusFactor) < 2e-3
      ) {
        return;
      }
      lastApplied.blinkL = values.blinkL;
      lastApplied.blinkR = values.blinkR;
      lastApplied.radiusFactor = values.radiusFactor;
      apply(mesh, values);
    },
    reset() {
      const mesh = tracker.get();
      if (!mesh || !baseMatrices) return;
      mesh.instanceMatrix.array.set(baseMatrices);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor && baseColors) {
        mesh.instanceColor.array.set(baseColors);
        mesh.instanceColor.needsUpdate = true;
      }
      clearLastApplied();
    },
  };
}

/**
 * The wobble group's canvas: the SURFACE of the world's moons.
 *
 * Deliberately disjoint from `createWorldMoonsCanvas` above, which owns the
 * moons' `instanceMatrix` and `instanceColor` and rewrites both arrays wholesale
 * every frame for the echoes visual. This adapter never touches either. It works
 * only through the material's shader, so a delay and a chorus can be on the same
 * rack and the moons will blink AND stir with neither erasing the other.
 *
 * It does not move a single vertex either: the noise LIGHTS the moons rather than
 * reshaping them. Displacing a textured sphere splits it along its UV seam (the
 * seam and poles carry coincident vertices that would be pushed different ways),
 * which is exactly the join the moon texture works hardest to hide. So the
 * geometry and the texture stay precisely as the world built them, and only the
 * shading breathes. See `noiseSource.js`.
 *
 * Borrowed from the world and given back on reset: the shared material (patched,
 * not replaced, so the moons keep their colour map, emissive map and lighting)
 * and the geometry's spare attribute slots (the per-moon variety, removed again).
 *
 * @param {object} options
 * @param {import('three').Scene} options.scene - The voice's scene.
 * @param {number} [options.bumpScale] - Resolved quality: how hard the light reacts
 *        to the noise's slope.
 * @param {number} [options.noiseTextureSize] - Resolved quality: the shared field's size.
 */
export function createWorldMoonsSurfaceCanvas({ scene, bumpScale = 1, noiseTextureSize = 256 } = {}) {
  let noiseTexture = null;
  let patch = null;
  let attributedGeometry = null;

  function restore() {
    patch?.restore();
    patch = null;
    if (attributedGeometry) {
      removeNoiseInstanceAttributes(attributedGeometry);
      attributedGeometry = null;
    }
    if (noiseTexture) {
      releaseNoiseTexture();
      noiseTexture = null;
    }
  }

  const tracker = trackSceneElement({
    scene,
    find: () => {
      const group = scene?.getObjectByName?.('moonsGroup');
      return group?.children?.find((child) => child.isInstancedMesh) ?? null;
    },
    onAcquire(mesh) {
      // The world's own geometry, kept: it only gains the per-moon variety the
      // shader reads, and loses it again on reset. Seeded from the moon field the
      // world actually built (its first moon's placement, not just how MANY it
      // has), so two different worlds never stir in the same pattern — while one
      // world stirs identically on every device and every reload.
      const seed = Math.round(
        Math.abs(mesh.instanceMatrix.array[12] + mesh.instanceMatrix.array[14]) * 1e6,
      ) + mesh.count;
      addNoiseInstanceAttributes(mesh.geometry, mesh.count, seed);
      attributedGeometry = mesh.geometry;

      noiseTexture = acquireNoiseTexture(noiseTextureSize);
      patch = applyNoiseSurface(mesh.material, { noiseTexture, instanced: true });
      if (patch) {
        patch.uniforms.uBumpScale.value = bumpScale;
      }
    },
    onLost() {
      // Hand the material and geometry back BEFORE the handle drops — the world is
      // about to dispose this field, and a re-acquire of the rebuilt one must start
      // from a clean, unpatched material.
      restore();
    },
  });

  return {
    sync: tracker.sync,
    exists: () => tracker.get() !== null && patch !== null,
    drive({ timeSec, wobble, amount, noiseScale, bandWidth, bandPhase }) {
      if (!patch) return;
      const { uniforms } = patch;
      uniforms.uTime.value = timeSec;
      uniforms.uWobble.value = wobble;
      uniforms.uAmount.value = amount;
      uniforms.uNoiseScale.value = noiseScale;
      uniforms.uBandWidth.value = bandWidth;
      uniforms.uBandPhase.value = bandPhase;
    },
    reset() {
      restore();
    },
  };
}

/**
 * The colour group's canvas: the world's moons, taking the colour on their own
 * material rather than through the light that falls on them.
 *
 * A third, disjoint owner of the same moons. `createWorldMoonsCanvas` owns the
 * instance buffers and `createWorldMoonsSurfaceCanvas` owns the material's shader;
 * this one owns the material's `color`, which nothing else writes. The three
 * compose by construction — the renderer's own multiply is what mixes them:
 * `diffuse = material.color * instanceColor * map`. So the moons can blink from a
 * delay, stir from a chorus and take the colour of an EQ at the same time, and no
 * layer erases another.
 *
 * Only the lit colour shifts. The moons' emissive glow is not multiplied by
 * `color`, so the tint weighs the surface without ever putting a moon out.
 *
 * The moon field is rebuilt (not re-coloured in place) whenever the world or the
 * moon count changes, so the base is captured on acquire and simply dropped when
 * the field goes — unlike the lights, there is no rival writer to re-base against.
 *
 * @param {object} options
 * @param {import('three').Scene} options.scene - The voice's scene.
 */
export function createWorldMoonsTintCanvas({ scene }) {
  /** The current field's material colour, and the base it was built at. */
  let color = null;
  const base = { r: 1, g: 1, b: 1 };
  // The tint standing on the moons, held here rather than only in the layer. A held knob
  // makes the layer stop writing — it has nothing new to say — so when the world swaps its
  // moon field under a driven EQ, the layer would not speak again until a band next moved
  // and the new moons would come up untinted. The canvas owns putting the tint on whatever
  // field is current, so it re-applies it the moment it acquires one.
  const held = { r: 1, g: 1, b: 1 };
  let tinted = false;

  function apply() {
    if (!color) return;
    color.setRGB(base.r * held.r, base.g * held.g, base.b * held.b);
  }

  const tracker = trackSceneElement({
    scene,
    find: () => {
      const group = scene?.getObjectByName?.('moonsGroup');
      return group?.children?.find((child) => child.isInstancedMesh) ?? null;
    },
    onAcquire(mesh) {
      color = mesh.material?.color ?? null;
      if (!color) return;
      base.r = color.r;
      base.g = color.g;
      base.b = color.b;
      if (tinted) apply();
    },
    onLost() {
      // The world owns (and already disposed) the old field's material — drop the handle
      // only. Writing a base back into a disposed material would be a no-op at best, and
      // the rebuilt field starts from its own.
      color = null;
    },
  });

  return {
    sync: tracker.sync,
    exists: () => color !== null,
    /** @param {{ r: number, g: number, b: number }} gain - Per-channel factor; 1 is untouched. */
    drive(gain) {
      held.r = gain.r;
      held.g = gain.g;
      held.b = gain.b;
      tinted = true;
      apply();
    },
    reset() {
      held.r = 1;
      held.g = 1;
      held.b = 1;
      tinted = false;
      apply();
    },
  };
}

/**
 * The space/air group's density canvas: the world's own cloud shell (an
 * alpha-masked standard material — its opacity is the world's baseline look,
 * so the effect boosts FROM that base and reset restores it).
 *
 * @param {object} options
 * @param {import('three').Scene} options.scene - The voice's scene.
 */
export function createWorldCloudShellCanvas({ scene }) {
  let baseOpacity = 0;
  let baseScale = 1;
  let live = false;

  function restore(mesh) {
    if (!mesh?.material) return;
    mesh.material.opacity = baseOpacity;
    mesh.scale.setScalar(baseScale);
  }

  const tracker = trackSceneElement({
    scene,
    find: () => scene?.getObjectByName?.('worldCloudShell') ?? null,
    onAcquire(mesh) {
      live = true;
      baseOpacity = mesh.material?.opacity ?? 0;
      baseScale = mesh.scale?.x ?? 1;
    },
    onLost(mesh) {
      // Hand the boosted shell back to base BEFORE the handle drops, or a
      // re-acquire of the SAME shell would capture the boost as its new base
      // and the mist would compound with every world rebuild.
      if (live) restore(mesh);
      live = false;
    },
  });

  return {
    sync: tracker.sync,
    exists: () => tracker.get() !== null,
    drive({ opacityBoost, scaleFactor }) {
      const mesh = tracker.get();
      if (!mesh?.material) return;
      mesh.material.opacity = Math.min(1, baseOpacity + opacityBoost);
      mesh.scale.setScalar(baseScale * scaleFactor);
    },
    reset() {
      restore(tracker.get());
    },
  };
}

/**
 * The space/air group's tail canvas: the world's fresnel rim glow (name
 * differs by world render mode). The measured tail swells the rim from its
 * captured base — it breathes exactly as long as the reverb rings.
 *
 * @param {object} options
 * @param {import('three').Scene} options.scene - The voice's scene.
 */
export function createWorldGlowCanvas({ scene }) {
  let baseFresnelScale = 1;
  let live = false;

  function restore(mesh) {
    const uniform = mesh?.material?.uniforms?.fresnelScale ?? null;
    if (!uniform) return;
    uniform.value = baseFresnelScale;
  }

  const tracker = trackSceneElement({
    scene,
    find: () =>
      scene?.getObjectByName?.('worldTextureGlow')
      ?? scene?.getObjectByName?.('worldNormalGlow')
      ?? null,
    onAcquire(mesh) {
      live = true;
      baseFresnelScale = mesh.material?.uniforms?.fresnelScale?.value ?? 1;
    },
    onLost(mesh) {
      // Same reason as the cloud shell: settle the rim back to base before the
      // handle drops, so a re-acquire can't capture a swollen glow as its base.
      if (live) restore(mesh);
      live = false;
    },
  });

  function fresnelScaleUniform() {
    return tracker.get()?.material?.uniforms?.fresnelScale ?? null;
  }

  return {
    sync: tracker.sync,
    exists: () => fresnelScaleUniform() !== null,
    drive({ strength }) {
      const uniform = fresnelScaleUniform();
      if (!uniform) return;
      uniform.value = baseFresnelScale * (1 + strength * GLOW_FRESNEL_BOOST);
    },
    reset() {
      restore(tracker.get());
    },
  };
}
