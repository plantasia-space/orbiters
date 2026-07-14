/**
 * @file visual/granularDiskLayer.js
 * @description The granular texture's visual layer: protoplanetary accretion —
 *              dust particles condense from an outer disk and spiral into the
 *              orbiter body. One pooled THREE.Points cloud; per-grain
 *              attributes are written ONCE on each engine grain-spawn event,
 *              envelope + motion run in the vertex shader off a time uniform.
 *              No per-frame JS per grain, no allocations after construction.
 *
 *              Fixed sound→visual vocabulary (engine-level, module-agnostic):
 *              grain spawn → particle spawn · duration → lifetime + scale ·
 *              buffer position → orbit angle · pan → disk thickness offset ·
 *              pitch → height above/below the disk plane and a color gradient
 *              derived from the host's base color · reversed → drifts against
 *              the orbital flow · wet → amount (echo copies) + occupied space
 *              + disk precession.
 *
 *              Scene-agnostic: owns a THREE.Group (points + shader material) —
 *              no renderer, no camera, no RAF, no DOM. The host attaches
 *              `group` to its scene, forwards engine grain events and merged
 *              params, and drives `update` from its own render loop. The
 *              production orbiter scene and the dev harness page render this
 *              SAME module; all tuned constants live here.
 */

import * as THREE from 'three';

/** Particle pool. Sized for the worst engine-allowed case: max density (80/s)
 *  × max echo copies × (lifetime + scheduler lookahead + echo jitter) stays
 *  under this, so live particles are never overwritten. The rig proved this
 *  size on phones. */
const MAX_GRAINS = 256;
/** Upper bound for visual echo copies per audio grain (amount legibility at high wet). */
const MAX_ECHO_COPIES = 5;
/** Visual lifetime per second of audio grain — long enough that the spiral-in reads. */
const LIFE_SCALE = 2.4;
/** Hue deviation (turns) of the pitch gradient around the host's base color —
 *  close to the palette, never identical. */
const HUE_DEVIATION = 0.07;

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uRadius;
  attribute float aBirth;
  attribute float aLife;
  attribute float aAngle;
  attribute float aPan;
  attribute float aPitch;
  attribute float aReversed;
  attribute float aSeed;
  varying float vEnv;
  varying float vPitch;

  const float PI = 3.141592653589793;

  void main() {
    float age = uTime - aBirth;
    float lifeN = aLife > 0.0 ? clamp(age / aLife, 0.0, 1.0) : 1.0;
    // Grain gain envelope, mirrored visually: quick swell in, ease out.
    float env = sin(lifeN * PI);
    env *= step(0.0, age) * (1.0 - step(1.0, lifeN));
    vEnv = env;
    vPitch = clamp((log2(aPitch) + 1.0) * 0.5, 0.0, 1.0); // 0.5x..2x -> 0..1

    float dir = aReversed > 0.5 ? -1.0 : 1.0;
    float pitchLift = (vPitch - 0.5) * 0.9;

    // The disk takes more SPACE as intensity grows. Motion runs on a globally
    // slowed clock (envelope/lifetime stay tied to real grain time).
    float grow = 0.4 + uIntensity * 1.6;
    float motionAge = age * 0.35;

    // Dust condenses from an outer disk and spirals into the body (radius 1 in
    // layer space). Travel completes at ~70% of the grain's life — the landing
    // happens while the envelope is still bright, and the particle spends its
    // remaining life glowing ON the surface as it fades. (Travel and fade must
    // not share the clock: finishing both at once makes every arrival
    // invisible.)
    // The source ring hugs the planet: 1.2 at bypass, 1.73 at full wet.
    float outer = 1.075 + grow * 0.325;
    float travelN = clamp(lifeN * 1.45, 0.0, 1.0);
    float travel = 1.0 - (1.0 - travelN) * (1.0 - travelN);
    float radius = mix(outer, 1.06, travel);
    float angle = aAngle + dir * motionAge * (0.9 + aSeed * 0.6);
    float thickness = 0.15 + grow * 0.45;
    vec3 pos = vec3(cos(angle) * radius, aPan * thickness + pitchLift * 0.5, sin(angle) * radius);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    // uRadius keeps the sprite size proportional to the host scene's planet
    // scale (gl_PointSize ignores the group's scale transform).
    float sizePx = (14.0 + aLife * 90.0) * (0.35 + env * 0.65) * (0.6 + uIntensity * 0.9);
    gl_PointSize = sizePx * uRadius * (3.2 / max(0.5, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;
  uniform vec3 uLowColor;
  uniform vec3 uHighColor;
  varying float vEnv;
  varying float vPitch;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float alpha = smoothstep(1.0, 0.0, d);
    alpha *= alpha * vEnv;
    if (alpha < 0.01) discard;
    // Pitch gradient between two hue-deviated derivations of the host's base
    // color (see setBaseColor) — low grains one way, high grains the other.
    vec3 color = mix(uLowColor, uHighColor, vPitch);
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} [options]
 * @param {number} [options.radius] - Host-scene scale: the planet's radius in
 *        scene units (the layer is authored with planet radius = 1).
 * @returns {{
 *   group: THREE.Group,
 *   onGrain(spawn: object, audioNowSec?: number): void,
 *   setEngineParams(params: object): void,
 *   setEchoCap(cap: number): void,
 *   setBaseColor(color: {r: number, g: number, b: number}): void,
 *   update(nowSec: number, dtSec: number): void,
 *   dispose(): void,
 * }}
 */
export function createGranularDiskLayer({ radius = 1 } = {}) {
  const geometry = new THREE.BufferGeometry();
  const attrs = {
    position: new THREE.BufferAttribute(new Float32Array(MAX_GRAINS * 3), 3),
    aBirth: new THREE.BufferAttribute(new Float32Array(MAX_GRAINS).fill(-1e3), 1),
    aLife: new THREE.BufferAttribute(new Float32Array(MAX_GRAINS), 1),
    aAngle: new THREE.BufferAttribute(new Float32Array(MAX_GRAINS), 1),
    aPan: new THREE.BufferAttribute(new Float32Array(MAX_GRAINS), 1),
    aPitch: new THREE.BufferAttribute(new Float32Array(MAX_GRAINS).fill(1), 1),
    aReversed: new THREE.BufferAttribute(new Float32Array(MAX_GRAINS), 1),
    aSeed: new THREE.BufferAttribute(new Float32Array(MAX_GRAINS), 1),
  };
  Object.entries(attrs).forEach(([name, attribute]) => geometry.setAttribute(name, attribute));
  // Positions are computed in the vertex shader; only these CPU-side
  // attributes are (re)written, one grain slot at a time.
  const grainAttrs = [
    attrs.aBirth, attrs.aLife, attrs.aAngle, attrs.aPan, attrs.aPitch, attrs.aReversed, attrs.aSeed,
  ];

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uRadius: { value: radius },
      // Defaults hold until the host feeds a base color (ember → ice).
      uLowColor: { value: new THREE.Color(1.0, 0.55, 0.25) },
      uHighColor: { value: new THREE.Color(0.45, 0.8, 1.0) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  // Particle positions live in the shader; the CPU-side bounds (all zeros)
  // would cull the cloud the moment the origin leaves the frustum.
  points.frustumCulled = false;

  // Everything lives in one slowly precessing group, so the (invisible) feeder
  // source keeps orbiting even when the playhead angle barely moves (long
  // tracks = slow angle). Precession is one transform — free. `radius` maps
  // layer space (planet radius = 1) onto the host scene.
  const group = new THREE.Group();
  group.scale.setScalar(radius);
  group.visible = false;
  group.add(points);

  let cursor = 0;
  let disposed = false;
  let nowSec = 0;
  let echoCap = MAX_ECHO_COPIES;
  // Grain times arrive in audio-context time; the layer clock is the host's
  // update clock. Keep a running offset between the two (captured per spawn).
  let audioToVisualOffset = null;
  // When the newest particle's envelope closes; the disk hides itself after
  // (covers both wet≈0 and a stopped transport — no spawns, tails drain).
  let lastGrainEndSec = -Infinity;

  function writeParticle(spawn, birth, echo) {
    const index = cursor;
    cursor = (cursor + 1) % MAX_GRAINS;
    // Echo copies jitter around the real grain so amount reads immediately.
    const jitter = echo ? 0.25 : 0;
    const birthSec = birth + (echo ? Math.random() * 0.04 : 0);
    const lifeSec = Math.max(0.05, spawn.durationSec || 0.1) * LIFE_SCALE;
    attrs.aBirth.array[index] = birthSec;
    attrs.aLife.array[index] = lifeSec;
    attrs.aAngle.array[index] = (spawn.positionNorm ?? 0) * Math.PI * 2 + (Math.random() * 2 - 1) * jitter;
    attrs.aPan.array[index] = (spawn.pan || 0) + (echo ? (Math.random() * 2 - 1) * 0.3 : 0);
    attrs.aPitch.array[index] = spawn.pitch || 1;
    attrs.aReversed.array[index] = spawn.reversed ? 1 : 0;
    attrs.aSeed.array[index] = Math.random();
    for (const attribute of grainAttrs) {
      attribute.addUpdateRange(index, 1);
      attribute.needsUpdate = true;
    }
    if (birthSec + lifeSec > lastGrainEndSec) {
      lastGrainEndSec = birthSec + lifeSec;
    }
  }

  /**
   * One engine grain-spawn event → 1–4 particles (echo copies scale visual
   * amount beyond audio polyphony: GPU points are cheap, audio grains aren't).
   * @param {object} spawn - The engine's spawn event ({ time, positionNorm, durationSec, pan, pitch, reversed }).
   * @param {number} [audioNowSec] - The audio context's current time at spawn,
   *        used to align scheduled-ahead grain times with the layer clock.
   */
  function onGrain(spawn, audioNowSec) {
    if (disposed) return;
    if (Number.isFinite(audioNowSec)) {
      audioToVisualOffset = nowSec - audioNowSec;
    }
    const birth = audioToVisualOffset !== null && Number.isFinite(spawn.time)
      ? spawn.time + audioToVisualOffset
      : nowSec;

    // Floor of 2 so the texture is visible even at low wet; the host's echo
    // cap (performance profile / concurrent layers) can still force 1.
    const copies = Math.min(echoCap, 2 + Math.round(material.uniforms.uIntensity.value * 3));
    for (let i = 0; i < copies; i += 1) {
      writeParticle(spawn, birth, i > 0);
    }
  }

  /** Feed the engine's merged params; wet drives the global intensity that
   *  scales amount, particle size, and how much space the disk takes. */
  function setEngineParams(params) {
    const wet = Number(params?.wet);
    if (Number.isFinite(wet)) {
      material.uniforms.uIntensity.value = Math.min(1, Math.max(0, wet));
    }
  }

  /** Host-side echo ceiling (performance profile / concurrent visible layers). */
  function setEchoCap(cap) {
    const numeric = Math.round(Number(cap));
    echoCap = Number.isFinite(numeric) ? Math.min(MAX_ECHO_COPIES, Math.max(1, numeric)) : MAX_ECHO_COPIES;
  }

  const appliedBaseColor = new THREE.Color(NaN, NaN, NaN);

  /**
   * Anchor the particle palette to the host's base color (the voice's orbit
   * ring — designer-themed, changes per dimension). The pitch gradient becomes
   * two derivations around it: hue deviated a little each way and lifted for
   * the additive glow — close to the palette, never identical. Compare-set:
   * feeding the same color every frame costs three number compares.
   */
  function setBaseColor(color) {
    if (disposed || !color) return;
    if (
      color.r === appliedBaseColor.r
      && color.g === appliedBaseColor.g
      && color.b === appliedBaseColor.b
    ) {
      return;
    }
    appliedBaseColor.copy(color);
    // Lightness diverges (low end darker, high end lighter) so the gradient
    // survives even a white/near-white base, where setHSL's clamp would
    // otherwise collapse both ends to the same color.
    material.uniforms.uLowColor.value.copy(color).offsetHSL(-HUE_DEVIATION, 0.1, -0.08);
    material.uniforms.uHighColor.value.copy(color).offsetHSL(HUE_DEVIATION, 0.1, 0.14);
  }

  /**
   * Advance the layer clock — call once per host frame. While no particle is
   * alive the group hides itself and this early-returns (no draw, no work).
   */
  function update(now, dtSec) {
    if (disposed || !Number.isFinite(now)) return;
    nowSec = now;
    const visible = now < lastGrainEndSec;
    if (group.visible !== visible) {
      group.visible = visible;
    }
    if (!visible) return;
    material.uniforms.uTime.value = now;
    // Disk precession speed follows the wet level: frozen at bypass, spinning
    // faster as the texture takes over — the (invisible) feeder source orbits
    // with it, so the stream's birth direction keeps traveling.
    const dt = Math.min(0.1, Math.max(0, Number(dtSec) || 0));
    group.rotation.y += dt * material.uniforms.uIntensity.value * 0.2;
  }

  return {
    group,
    onGrain,
    setEngineParams,
    setEchoCap,
    setBaseColor,
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      group.visible = false;
      group.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}

export default createGranularDiskLayer;
