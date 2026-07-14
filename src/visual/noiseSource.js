/**
 * @file visual/noiseSource.js
 * @description A shared noise field, and the seam that lets any body wear it.
 *
 *              Nothing here knows what a moon is. Two pieces:
 *
 *              1. `acquireNoiseTexture` — ONE tiling noise texture, generated
 *                 once and reference-counted. Generating noise per object is the
 *                 expensive way to do this; generating it once and sampling it
 *                 from many objects is the cheap way, and the whole point. The
 *                 last release disposes it.
 *
 *              2. `applyNoiseSurface` — patches any MeshStandardMaterial so the
 *                 noise LIGHTS its surface: the field becomes a living bump that
 *                 catches the light and stirs, without a single vertex moving.
 *                 Per-object variety comes from optional per-instance attributes,
 *                 so one shared material can drive a whole InstancedMesh of bodies
 *                 that all look different — same texture, same material, different
 *                 result.
 *
 *              THE GEOMETRY IS NEVER TOUCHED, and that is a decision, not a
 *              shortcut. Displacing the vertices of a textured sphere tears it:
 *              a sphere's UV seam carries two rows of vertices in the same place
 *              (and the poles carry many), so noise read at the UV gives those
 *              coincident vertices different displacements and the mesh splits
 *              along exactly the seam the moon texture works hardest to hide.
 *              Sampling in 3D would close it, but only by paying for triplanar
 *              fetches on a re-tessellated sphere — and the texture would still
 *              stretch over a moving surface. Lighting the noise per pixel gives
 *              the same living surface for less: the silhouette stays clean, the
 *              texture never warps, and no seam can appear because no vertex moves.
 *
 *              An InstancedMesh (many moons, one draw call) and a plain Mesh (a
 *              planet body) take the SAME patch: the shader falls back to the
 *              uniform values when the per-instance attributes are absent.
 */

import * as THREE from 'three';

/** Value-noise lattice size. The texture is smooth-interpolated from this grid,
 *  so this — not the texture size — is what sets the noise's feature scale. */
const LATTICE = 16;
/** Octaves folded into the texture. Three is enough for an organic surface and
 *  keeps generation instant; more just costs startup time nobody sees. */
const OCTAVES = 3;

/** The live shared texture, and how many consumers hold it. */
let sharedTexture = null;
let refCount = 0;

/** Deterministic hash → [0,1). Seeded, so every device generates the SAME field. */
function hash2(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Smoothstep-interpolated value noise on a wrapping lattice (so the texture tiles). */
function valueNoise(x, y, lattice) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  // Smoothstep the fractional part — linear interpolation would show the lattice.
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  // Wrap the lattice coordinates so the field is seamless across the texture edge.
  const wrap = (v) => ((v % lattice) + lattice) % lattice;
  const xa = wrap(x0);
  const xb = wrap(x0 + 1);
  const ya = wrap(y0);
  const yb = wrap(y0 + 1);
  const v00 = hash2(xa, ya);
  const v10 = hash2(xb, ya);
  const v01 = hash2(xa, yb);
  const v11 = hash2(xb, yb);
  const top = v00 + (v10 - v00) * ux;
  const bottom = v01 + (v11 - v01) * ux;
  return top + (bottom - top) * uy;
}

/**
 * Build the tiling fbm texture. One channel — the height is a scalar, so a
 * red-only texture is a quarter of the memory of RGBA for exactly the same result.
 *
 * @param {number} size - Texture edge in pixels.
 * @returns {THREE.DataTexture}
 */
function buildNoiseTexture(size) {
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let amplitude = 1;
      let frequency = 1;
      let sum = 0;
      let total = 0;
      for (let octave = 0; octave < OCTAVES; octave += 1) {
        const lattice = LATTICE * frequency;
        const nx = (x / size) * lattice;
        const ny = (y / size) * lattice;
        sum += valueNoise(nx, ny, lattice) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2;
      }
      data[y * size + x] = Math.round((sum / total) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Take a reference on the shared noise texture, generating it on first use.
 * Every consumer MUST pair this with `releaseNoiseTexture`.
 *
 * @param {number} [size] - Requested edge in pixels (a resolved quality knob).
 *        The first acquirer's size wins for the lifetime of the texture — one
 *        field, shared; a second consumer asking for a different size gets the
 *        existing one rather than forcing a regeneration nobody would see.
 * @returns {THREE.DataTexture}
 */
export function acquireNoiseTexture(size = 256) {
  if (!sharedTexture) {
    sharedTexture = buildNoiseTexture(Math.max(32, Math.round(size) || 256));
  }
  refCount += 1;
  return sharedTexture;
}

/** Drop a reference; the last one out disposes the field. */
export function releaseNoiseTexture() {
  if (refCount === 0) return;
  refCount -= 1;
  if (refCount === 0 && sharedTexture) {
    sharedTexture.dispose();
    sharedTexture = null;
  }
}

/** Test seam: how many consumers currently hold the shared field. */
export function noiseTextureRefCount() {
  return refCount;
}

/** Attribute names the patch reads for per-object variety. Absent = uniform fallback. */
export const NOISE_INSTANCE_ATTRIBUTES = Object.freeze({
  scale: 'aNoiseScale',
  offset: 'aNoiseOffset',
  strength: 'aNoiseStrength',
  phase: 'aNoisePhase',
});

/**
 * Light a body's surface with the shared noise field.
 *
 * The field is read at the body's own UVs and turned into a per-pixel bump: the
 * surface normal tilts to the slope of the noise, so light pools in its hollows
 * and catches on its ridges. It scrolls with `uTime` and is scaled by `uAmount`
 * (the effect's presence) and the effect's reconstructed LFO (`uWobble`), so the
 * surface stirs at the rate you hear and goes perfectly smooth when the effect is
 * bypassed. No vertex moves, so the body's own texture and silhouette are exactly
 * as the world built them.
 *
 * @param {THREE.Material} material - The body's material (a standard/physical
 *        material — this patches its shaders, it does not replace it).
 * @param {object} options
 * @param {THREE.Texture} options.noiseTexture - The shared field.
 * @param {boolean} [options.instanced] - True when the geometry carries the
 *        per-object attributes (see `addNoiseInstanceAttributes`). False for a
 *        single body like a planet, which takes the uniform values instead.
 * @returns {{
 *   uniforms: object,
 *   restore(): void,
 * }|null} A handle whose uniforms are written per frame, and a `restore()` that
 *         puts the material back exactly as it was. Null if there is nothing to patch.
 */
export function applyNoiseSurface(material, { noiseTexture, instanced = false } = {}) {
  if (!material || !noiseTexture) return null;

  const uniforms = {
    uNoiseTex: { value: noiseTexture },
    uTime: { value: 0 },
    uWobble: { value: 0 },
    uAmount: { value: 0 },
    uNoiseScale: { value: 1 },
    /** How hard the light reacts to the noise's slope. */
    uBumpScale: { value: 1 },
    // The accent channel: a bright seam sweeping the surface (the phaser's
    // whoosh). Width 0 = no band, so every other family pays nothing for it.
    uBandWidth: { value: 0 },
    uBandPhase: { value: 0 },
  };

  const previousOnBeforeCompile = material.onBeforeCompile;
  const hadInstancingDefine = Boolean(material.defines?.USE_NOISE_INSTANCING);
  if (instanced) {
    material.defines = material.defines ?? {};
    material.defines.USE_NOISE_INSTANCING = '';
  }

  material.onBeforeCompile = (shader) => {
    // Chain, don't clobber: the host may already patch this material.
    previousOnBeforeCompile?.call(material, shader);
    Object.assign(shader.uniforms, uniforms);

    // The vertex stage only FORWARDS the body's coordinates and its per-object
    // variety. It moves nothing.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         #ifdef USE_NOISE_INSTANCING
           attribute float ${NOISE_INSTANCE_ATTRIBUTES.scale};
           attribute vec2 ${NOISE_INSTANCE_ATTRIBUTES.offset};
           attribute float ${NOISE_INSTANCE_ATTRIBUTES.strength};
           attribute float ${NOISE_INSTANCE_ATTRIBUTES.phase};
         #endif
         // Our own UV varying — the body may carry no colour map, in which case
         // three would not have declared \`vUv\` at all.
         varying vec2 vNoiseUv;
         // (scale, offset.x, offset.y, strength) — the body's own place in the field.
         varying vec4 vNoiseVary;
         varying float vNoisePhase;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vNoiseUv = uv;
         #ifdef USE_NOISE_INSTANCING
           vNoiseVary = vec4(
             ${NOISE_INSTANCE_ATTRIBUTES.scale},
             ${NOISE_INSTANCE_ATTRIBUTES.offset},
             ${NOISE_INSTANCE_ATTRIBUTES.strength}
           );
           vNoisePhase = ${NOISE_INSTANCE_ATTRIBUTES.phase};
         #else
           vNoiseVary = vec4(1.0, 0.0, 0.0, 1.0);
           vNoisePhase = 0.0;
         #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uNoiseTex;
         uniform float uTime;
         uniform float uWobble;
         uniform float uAmount;
         uniform float uNoiseScale;
         uniform float uBumpScale;
         uniform float uBandWidth;
         uniform float uBandPhase;
         varying vec2 vNoiseUv;
         varying vec4 vNoiseVary;
         varying float vNoisePhase;

         // The field's height at a point on the body, centred on zero.
         float orbNoiseHeight(vec2 uvIn) {
           float scale = uNoiseScale * vNoiseVary.x;
           vec2 offset = vNoiseVary.yz;
           // AROUND the body (u), the field must repeat a WHOLE number of times,
           // or it will not meet itself where the texture wraps and a shading seam
           // appears down the exact join the body's texture works to hide. The
           // family accent is free to ask for any grain it likes — it gets rounded
           // to the nearest whole turn here, and never breaks the seam. Scrolling
           // in u is safe: a constant shift moves both edges of the wrap equally.
           float turns = max(1.0, floor(scale + 0.5));
           vec2 noiseUv = vec2(uvIn.x * turns, uvIn.y * scale)
             + offset + vec2(uTime * 0.05, uTime * 0.03);
           return texture2D(uNoiseTex, noiseUv).r - 0.5;
         }

         // Tilt the surface normal to the slope of the noise. Screen-space
         // derivatives give the slope for free — this is how a bump map works,
         // and it needs no extra geometry and no tangents on the mesh.
         vec3 orbPerturbNormal(vec3 surfPos, vec3 surfNorm, vec2 slope) {
           vec3 sigmaX = dFdx(surfPos);
           vec3 sigmaY = dFdy(surfPos);
           vec3 r1 = cross(sigmaY, surfNorm);
           vec3 r2 = cross(surfNorm, sigmaX);
           float det = dot(sigmaX, r1);
           vec3 grad = sign(det) * (slope.x * r1 + slope.y * r2);
           return normalize(abs(det) * surfNorm - grad);
         }`,
      )
      // After three has resolved the body's own normal (its normal map included),
      // stir it with the noise. The body's material is respected, not replaced.
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         if (uAmount > 0.0) {
           // The LFO the effect is actually running, at this body's own place in
           // the cycle, so a field of moons does not pulse in lockstep.
           float lfo = sin(uWobble + vNoisePhase * 6.2831853);
           float height = orbNoiseHeight(vNoiseUv) * vNoiseVary.w * uAmount * lfo;
           vec2 slope = vec2(dFdx(height), dFdy(height)) * uBumpScale;
           normal = orbPerturbNormal(-vViewPosition, normal, slope);
           if (uBandWidth > 0.0) {
             // A bright seam riding the noise — the sweep you hear as the phaser moves.
             float band = smoothstep(uBandWidth, 0.0, abs(orbNoiseHeight(vNoiseUv) - uBandPhase));
             diffuseColor.rgb += band * uAmount * 0.5;
           }
         }`,
      );
  };
  material.needsUpdate = true;

  return {
    uniforms,
    restore() {
      material.onBeforeCompile = previousOnBeforeCompile;
      if (instanced && !hadInstancingDefine && material.defines) {
        delete material.defines.USE_NOISE_INSTANCING;
      }
      material.needsUpdate = true;
    },
  };
}

/**
 * Give a geometry the per-object variety attributes the patch reads. Seeded, so
 * a world's moons look the same on every device and every reload.
 *
 * The u-scale is quantised to whole numbers ON PURPOSE: the field then repeats a
 * whole number of times around the body, so the noise meets itself exactly at the
 * UV seam and no shading edge appears where the texture wraps.
 *
 * @param {THREE.BufferGeometry} geometry - The body geometry (mutated: the
 *        attributes are added to it — `removeNoiseInstanceAttributes` takes them off).
 * @param {number} count - How many instances the InstancedMesh draws.
 * @param {number} [seed] - Deterministic variety seed.
 */
export function addNoiseInstanceAttributes(geometry, count, seed = 1) {
  if (!geometry || !(count > 0)) return;
  const scales = new Float32Array(count);
  const offsets = new Float32Array(count * 2);
  const strengths = new Float32Array(count);
  const phases = new Float32Array(count);

  let state = Math.abs(Math.round(seed)) || 1;
  const random = () => {
    // Same LCG the moon field itself is generated with — deterministic per world.
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  for (let i = 0; i < count; i += 1) {
    // Whole numbers only — see the seam note above. 1..3 repeats around the body:
    // broad, slow-featured surfaces through to fine, busy ones.
    scales[i] = 1 + Math.floor(random() * 3);
    offsets[i * 2] = random();
    offsets[i * 2 + 1] = random();
    strengths[i] = 0.45 + random() * 0.9;    // some barely stir, some churn
    phases[i] = random();                    // each body at its own point in the cycle
  }

  geometry.setAttribute(
    NOISE_INSTANCE_ATTRIBUTES.scale,
    new THREE.InstancedBufferAttribute(scales, 1),
  );
  geometry.setAttribute(
    NOISE_INSTANCE_ATTRIBUTES.offset,
    new THREE.InstancedBufferAttribute(offsets, 2),
  );
  geometry.setAttribute(
    NOISE_INSTANCE_ATTRIBUTES.strength,
    new THREE.InstancedBufferAttribute(strengths, 1),
  );
  geometry.setAttribute(
    NOISE_INSTANCE_ATTRIBUTES.phase,
    new THREE.InstancedBufferAttribute(phases, 1),
  );
}

/** Take the variety attributes back off a geometry the world owns. */
export function removeNoiseInstanceAttributes(geometry) {
  if (!geometry) return;
  Object.values(NOISE_INSTANCE_ATTRIBUTES).forEach((name) => {
    geometry.deleteAttribute(name);
  });
}
