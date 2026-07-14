// src/Scene.js

/**
 * @file Scene.js
 * @version 2.0.0
 * @autor 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2024-12-08
 * @example
 * // Example of initializing the renderer and adding lights
 * import { initRenderer, addLights } from './Scene.js';
 *
 * const canvas = document.getElementById('three-canvas');
 *
 * const renderer = initRenderer(canvas);
 *
 * addLights(scene);
 * 
 * function animate() {
 *   requestAnimationFrame(animate);
 *   controls.update();
 *   renderer.render(scene, camera);
 * }
 * animate();
 */

import * as THREE from 'three';

import { getPlaybackState } from "../config/Constants.js";
import { ORBIT_TILT_DEG } from './Ring.js';

const isCameraDebugEnabled = () =>
  typeof window !== 'undefined' && Boolean(window.__DEBUG_CAMERA__);

const cameraDebugLog = (...args) => {
  if (isCameraDebugEnabled()) {
    console.log('[CameraAutomation]', ...args);
  }
};

// ---------- Configurable Parameters ----------
// Min/max camera radius for zoom control
const CAMERA_RADIUS_MIN       = 1;
const CAMERA_RADIUS_MAX       = 4;

// ---------- Moon focus ----------
// The camera is the orbiter's point of view: focusing a moon moves the CENTRE of
// its orbit from the world's origin to the moon. Always the first moon — the
// world is guaranteed to have one, so instance 0 always resolves.
const MOON_FOCUS_INSTANCE = 0;
// Orbit distance while focused, expressed in MOON radii — a moon is only 1–4% of
// the planet's radius, so the world's own 1–4 unit range would leave it a speck.
// The z macro slides between these two, exactly as it slides the world's range.
// CALIBRATION KNOBS: raise for a wider shot, lower to sit closer to the moon.
const MOON_ORBIT_RADII_NEAR = 7;    // z at max (closest)
const MOON_ORBIT_RADII_FAR  = 18;   // z at min (widest)
// The near plane clips anything closer than 0.1 units, so a very small moon's
// "closest" distance is floored to keep the moon in front of it, not inside it.
// This floor — not the range above — is what actually limits how close we can get
// to a small moon; shrink it and the near plane starts eating the moon.
const MOON_NEAR_CLEARANCE = 0.02;
// How fast the camera travels between orbiting the world and orbiting the moon.
const FOCUS_EASE_PER_SECOND = 1.6;

const DEFAULT_WORLD_ROTATION_SPEED = THREE.MathUtils.degToRad(0.72);   // radians per second
const DEFAULT_MOON_ORBIT_SPEED     = THREE.MathUtils.degToRad(.0266);  // radians per second

let worldRotationSpeed = DEFAULT_WORLD_ROTATION_SPEED;
let moonOrbitSpeed = DEFAULT_MOON_ORBIT_SPEED;

const clampDeltaSeconds = (deltaSeconds) => {
  if (!Number.isFinite(deltaSeconds)) return 0;
  if (deltaSeconds <= 0) return 0;
  return Math.min(deltaSeconds, 0.5); // cap to avoid large jumps after tab inactivity
};

const ensureMoonGroup = (scene) => {
  if (!scene || !scene.isScene) return null;
  // The cache must be re-validated, not just type-checked: the moon field is
  // REBUILT (old group disposed and detached, a new one added) whenever the moon
  // count or texture changes, so a cached group that has left the scene is a dead
  // object — still an Object3D, but drawn by nobody. Anything reading it (the
  // orbit animation, the camera's focus centre) would be following a ghost.
  const cached = scene.userData?.moonGroup;
  if (cached?.isObject3D && cached.parent === scene) {
    return cached;
  }
  const found = typeof scene.getObjectByName === 'function'
    ? scene.getObjectByName('moonsGroup')
    : null;
  if (found?.isObject3D) {
    scene.userData = scene.userData || {};
    scene.userData.moonGroup = found;
    return found;
  }
  return null;
};

// Scratch for reading the focused moon — module-level and reused, so following a
// moon every frame allocates nothing.
const moonMatrix = new THREE.Matrix4();
const moonLocalPosition = new THREE.Vector3();
const moonQuaternion = new THREE.Quaternion();
const moonScale = new THREE.Vector3();

/**
 * World position + radius of the moon the camera focuses (instance 0 of the
 * world's moon field — both moon builders produce one `moonsGroup` holding one
 * InstancedMesh).
 *
 * Read fresh every frame rather than snapshotted once: the moon group keeps
 * rotating, so a frozen centre would let the moon drift straight out of frame.
 *
 * @param {THREE.Scene|null} scene
 * @param {THREE.Vector3} outPosition - Receives the moon's world position.
 * @returns {number} The moon's world radius in scene units; 0 when there is no moon.
 */
const resolveMoonFocus = (scene, outPosition) => {
  const moonGroup = ensureMoonGroup(scene);
  const mesh = moonGroup?.children?.find((child) => child.isInstancedMesh) ?? null;
  if (!mesh || mesh.count <= MOON_FOCUS_INSTANCE) return 0;
  // Ancestors first: the moon group is re-rotated every frame, and the renderer
  // only refreshes world matrices at draw time — reading a stale one would make
  // the camera follow where the moon WAS.
  mesh.updateWorldMatrix(true, false);
  mesh.getMatrixAt(MOON_FOCUS_INSTANCE, moonMatrix);
  moonMatrix.decompose(moonLocalPosition, moonQuaternion, moonScale);
  outPosition.copy(moonLocalPosition).applyMatrix4(mesh.matrixWorld);
  if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
  const geometryRadius = mesh.geometry.boundingSphere?.radius ?? 0;
  return geometryRadius * moonScale.x;
};

const applyWorldAnimation = (scene, deltaSeconds) => {
  const delta = clampDeltaSeconds(deltaSeconds);
  if (!scene?.isScene || delta === 0) {
    return;
  }

  const target = scene.userData?.worldRoot?.isObject3D
    ? scene.userData.worldRoot
    : scene;

  if (worldRotationSpeed !== 0 && target?.isObject3D) {
    target.rotation.y += worldRotationSpeed * delta;
  }

  const moonGroup = ensureMoonGroup(scene);
  if (moonGroup) {
    const relativeSpeed = moonOrbitSpeed - worldRotationSpeed;
    if (relativeSpeed !== 0) {
      moonGroup.rotation.y += relativeSpeed * delta;
    }
  }
};

export const getWorldRotationSpeed = () => worldRotationSpeed;
export const setWorldRotationSpeed = (value) => {
  const numeric = Number(value);
  worldRotationSpeed = Number.isFinite(numeric) ? numeric : 0;
};

export const getMoonOrbitSpeed = () => moonOrbitSpeed;
export const setMoonOrbitSpeed = (value) => {
  const numeric = Number(value);
  moonOrbitSpeed = Number.isFinite(numeric) ? numeric : 0;
};

// The oscilloscope is owned per-voice (one `RingOscilloscope` per orbiter voice,
// stored on its VoiceContext as `voice.oscilloscope`). These overlay/draw helpers operate on the
// PASSED instance — the boot path and render loop hand in the voice's own oscilloscope, the
// active-voice consumers resolve `voiceRegistry.getActive()?.oscilloscope`. Optional chaining keeps a
// missing instance inert (no crash) rather than reaching for a module singleton.
export const updateOrbitColor = (oscilloscope) => oscilloscope?.updateOrbitColor();
export const ensureOscilloscopeOverlay = (oscilloscope, targetScene = null) =>
  oscilloscope?.ensureOverlay(targetScene);
export const updateOscilloscopePerformanceProfile = (oscilloscope, profile) =>
  oscilloscope?.setPerformanceProfile(profile);
export const drawRing = (oscilloscope, amplitude) => oscilloscope?.draw(amplitude);
export const isRingEnabled = (oscilloscope) => oscilloscope?.enabled;
export const destroyOscilloscopeOverlay = (oscilloscope) => oscilloscope?.destroy();

export function configureCameraAutomation(
  controller,
  parameterManager,
  resolvePlaybackState = getPlaybackState,
  resolveCameraFocus = () => 'world',
) {
  if (!controller?.camera) {
    throw new Error('[Scene] configureCameraAutomation requires a controller with a camera');
  }
  if (!parameterManager) {
    throw new Error('[Scene] configureCameraAutomation requires a ParameterManager');
  }

  const camera = controller.camera;
  const paramManager = parameterManager;

  const baseForward = new THREE.Vector3(0, 0, 1);
  const baseUp = new THREE.Vector3(0, 1, 0);
  const baseRight = new THREE.Vector3(1, 0, 0);
  const worldUp = new THREE.Vector3(0, 1, 0);
  const orbitQuat = new THREE.Quaternion();
  const tempQuat = new THREE.Quaternion();
  const currentForward = new THREE.Vector3();
  const currentUp = new THREE.Vector3();
  const currentRight = new THREE.Vector3();
  const initialDirection = camera.position.clone().normalize();
  orbitQuat.setFromUnitVectors(baseForward, initialDirection);

  let azimuthSpeed = 0;
  let polarSpeed = 0;
  let currentRadius = camera.position.length();
  let targetRadius = currentRadius;
  let isAnimating = false;
  let frameCounter = 0;

  // The centre of the orbit. The world's origin until a moon is focused — which
  // is why the camera behaves exactly as it always has when nothing is focused.
  const orbitCentre = new THREE.Vector3();
  const moonCentre = new THREE.Vector3();
  // 0 = orbiting the world, 1 = orbiting the moon. Eased, so the camera visibly
  // TRAVELS from one body to the other while it keeps orbiting.
  let focusBlend = 0;
  let orbitRadius = currentRadius;
  // The z macro as 0..1, DERIVED from the radius it already sets rather than
  // stored beside it — one knob, one source of truth. The moon's own (much
  // smaller) distance range is driven by the same value.
  const zoomNorm = () => THREE.MathUtils.clamp(
    (CAMERA_RADIUS_MAX - targetRadius) / (CAMERA_RADIUS_MAX - CAMERA_RADIUS_MIN),
    0,
    1,
  );

  paramManager.subscribe(
    {
      onParameterChanged: () => {
        const normalizedX = paramManager.getNormalizedValue('x');
        azimuthSpeed = (normalizedX - 0.5) * 0.01;
        cameraDebugLog('Param x changed', { normalizedX, azimuthSpeed });
      }
    },
    'x'
  );

  paramManager.subscribe(
    {
      onParameterChanged: () => {
        const normalizedY = paramManager.getNormalizedValue('y');
        polarSpeed = -(normalizedY - 0.5) * 0.003;
        cameraDebugLog('Param y changed', { normalizedY, polarSpeed });
      }
    },
    'y'
  );

  paramManager.subscribe(
    {
      onParameterChanged: () => {
        const normZ = paramManager.getNormalizedValue('z');
        targetRadius = THREE.MathUtils.lerp(CAMERA_RADIUS_MAX, CAMERA_RADIUS_MIN, normZ);
        cameraDebugLog('Param z changed', { normalizedZ: normZ, targetRadius });
      }
    },
    'z'
  );

  // The orbit is centred on `orbitCentre`, not on the origin — that one vector is
  // the whole of moon focus. With it at (0,0,0) this is the placement the scene
  // has always done.
  const updateCameraPlacement = () => {
    currentForward.copy(baseForward).applyQuaternion(orbitQuat).normalize();
    camera.position.copy(currentForward).multiplyScalar(orbitRadius).add(orbitCentre);
    currentUp.copy(baseUp).applyQuaternion(orbitQuat).normalize();
    camera.up.copy(currentUp);
    camera.lookAt(orbitCentre);
    // The camera-as-input-source reads its azimuth / polar / dolly from
    // `camera.position - controls.target`. Leaving the target at the origin while
    // the camera orbits a MOON would read the whole focus travel as one enormous
    // dolly-and-swing gesture and modulate whatever is mapped to it — a visual
    // choice must never change the sound. The orbit's centre IS the target.
    if (controller.controls?.target) {
      controller.controls.target.copy(orbitCentre);
    }
  };

  updateCameraPlacement();

  const onFrame = (frame) => {
    // The scene controller's frame clock is already inactivity-clamped.
    applyWorldAnimation(controller.scene ?? null, frame?.dtSec ?? 0);

    // Gate the camera orbit on THIS voice's playback, not the realm-global state. In the multi-stage
    // collection view every voice shares one realm, so a global getPlaybackState() made all cameras
    // animate the moment any voice played; the caller injects a per-voice resolver so only the voice
    // that is actually playing animates. Single-orbiter passes no resolver and reads the global as before.
    const playbackState = resolvePlaybackState();

    if (playbackState === 'playing') {
      if (!isAnimating) {
        isAnimating = true;
      }

      if (azimuthSpeed !== 0) {
        tempQuat.setFromAxisAngle(worldUp, azimuthSpeed);
        orbitQuat.premultiply(tempQuat);
      }

      if (polarSpeed !== 0) {
        currentRight.copy(baseRight).applyQuaternion(orbitQuat).normalize();
        if (currentRight.lengthSq() > 1e-10) {
          tempQuat.setFromAxisAngle(currentRight, polarSpeed);
          orbitQuat.premultiply(tempQuat);
        }
      }

      currentRadius += (targetRadius - currentRadius) * 0.1;

      frameCounter += 1;
      if (frameCounter % 120 === 0) {
        const euler = new THREE.Euler().setFromQuaternion(orbitQuat, 'YXZ');
        cameraDebugLog('Frame state', {
          yawDeg: THREE.MathUtils.radToDeg(euler.y),
          pitchDeg: THREE.MathUtils.radToDeg(euler.x),
          radius: currentRadius,
        });
      }
    } else if (isAnimating) {
      isAnimating = false;
    }

    // Focus travel runs whether or not the transport is playing: the camera must
    // be able to move to the moon on a stopped orbiter, and while it is out there
    // the moon keeps orbiting, so the centre has to be re-read every frame.
    const wantsMoon = resolveCameraFocus() === 'moon';
    const moonRadius = wantsMoon || focusBlend > 0
      ? resolveMoonFocus(controller.scene ?? null, moonCentre)
      : 0;
    const focusTarget = wantsMoon && moonRadius > 0 ? 1 : 0;
    const dt = clampDeltaSeconds(frame?.dtSec ?? 0);
    focusBlend += (focusTarget - focusBlend) * Math.min(1, dt * FOCUS_EASE_PER_SECOND);
    if (focusBlend < 1e-4) focusBlend = 0;

    // Centre and distance travel together: as the orbit's centre slides out to the
    // moon, the camera closes in from the world's range to the moon's much smaller
    // one — so it arrives genuinely NEAR the moon, with the planet looming behind.
    orbitCentre.set(0, 0, 0).lerp(moonCentre, focusBlend);
    const moonOrbitRadius = moonRadius > 0
      ? Math.max(
        camera.near + moonRadius + MOON_NEAR_CLEARANCE,
        moonRadius * THREE.MathUtils.lerp(MOON_ORBIT_RADII_FAR, MOON_ORBIT_RADII_NEAR, zoomNorm()),
      )
      : currentRadius;
    orbitRadius = THREE.MathUtils.lerp(currentRadius, moonOrbitRadius, focusBlend);
    updateCameraPlacement();
  };

  // The scene controller's loop is the ONE loop and the one frame-clock
  // source — camera automation requires it (no private-RAF fallback).
  controller.addRenderCallback(onFrame);
  return () => controller.removeRenderCallback?.(onFrame);
}
export function initRenderer(canvas) {
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true
    });
    renderer.autoClear = true;        // clear framebuffer each frame
    renderer.setClearColor(0x000000, .7); // transparent black
    
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    return renderer;
}

/**
 * Adds ambient and directional lights to the scene.
 * @param {THREE.Scene} scene - The scene to which the lights will be added.
 */
export function addLights(scene) {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
    directionalLight.position.set(5, 10, 7.5);
    scene.add(directionalLight);
}

/**
 * Adjusts the camera and renderer settings when the window is resized.
 * @param {THREE.PerspectiveCamera} camera - The scene's camera.
 * @param {THREE.WebGLRenderer} renderer - The renderer.
 */
export function handleWindowResize(camera, renderer) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}


/**
 * Initializes moon objects based on the given number and adds them to the scene.
 * @param {THREE.Scene} scene - The scene to which moons will be added.
 * @param {number} numMoons - The number of moons to create.
 */
// TEMP DEV OVERRIDE — set to null to disable override
const DEV_OVERRIDE_NUM_MOONS = null;

export function harvestMoons(scene, numMoons) {
  const finalNumMoons = DEV_OVERRIDE_NUM_MOONS ?? numMoons;

  // Shared geometry and material with per-instance colors enabled
  const moonGeometry = new THREE.SphereGeometry(0.1, 16, 16);
  const moonMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.2,
    emissive: new THREE.Color(0xE1E1E1),
    emissiveIntensity: 0.2,
    flatShading: true
  });

  // Create an InstancedMesh for performance with many moons
  const instancedMesh = new THREE.InstancedMesh(moonGeometry, moonMaterial, finalNumMoons);

  // Helper objects for setting transforms and colors
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const orbitRadius = 1.5;

  // Define a fixed color palette for moons
  const palette = [
    new THREE.Color('#f8f8f8'),
    new THREE.Color('#f0f0f0'),
    new THREE.Color('#e8e8e8'),
    new THREE.Color('#e0e0e0'),
    new THREE.Color('#d8d8d8'),
    new THREE.Color('#d0d0d0'),
    new THREE.Color('#c8c8c8'),
    new THREE.Color('#c0c0c0'),
    new THREE.Color('#b8b8b8'),
    new THREE.Color('#b0b0b0'),
    new THREE.Color('#a8a8a8'),
    new THREE.Color('#a0a0a0'),
    new THREE.Color('#989898'),
    new THREE.Color('#909090'),
    new THREE.Color('#888888'),
    new THREE.Color('#808080'),
    new THREE.Color('#787878'),
    new THREE.Color('#707070'),
    new THREE.Color('#686868'),
    new THREE.Color('#606060'),
    new THREE.Color('#585858'),
    new THREE.Color('#505050'),
    new THREE.Color('#484848'),
    new THREE.Color('#404040')
  ];

  for (let i = 0; i < finalNumMoons; i++) {
    // Base angular placement around a circle
    const angle = (i / finalNumMoons) * Math.PI * 2;
    // Add slight random variation to orbital radius and vertical offset
    const radiusVar = orbitRadius + (Math.random() - 0.5) * 0.3;
    const yOffset = (Math.random() - 0.5) * 0.2;
    const x = radiusVar * Math.cos(angle);
    const z = radiusVar * Math.sin(angle);

    // Position and random scale for size variation
    dummy.position.set(x, yOffset, z);
    const scaleValue = 0.05 + Math.random() * 0.15;
    dummy.scale.set(scaleValue, scaleValue, scaleValue);
    dummy.updateMatrix();

    // Apply transform to instance
    instancedMesh.setMatrixAt(i, dummy.matrix);

    // Assign a color from the fixed palette, cycling through in order, with random alpha multiplier
    const baseColor = palette[i % palette.length];
    const alpha = 0.5 + Math.random() * 0.5; // random alpha between 0.5 and 1
    const paletteColor = baseColor.clone();
    paletteColor.multiplyScalar(alpha);
    instancedMesh.setColorAt(i, paletteColor);
  }

  // Flag the buffers for update
  instancedMesh.instanceMatrix.needsUpdate = true;
  if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;

  // Wrap instancedMesh in a group and apply global tilt
  const moonGroup = new THREE.Group();
  moonGroup.rotation.x = THREE.MathUtils.degToRad(ORBIT_TILT_DEG);
  moonGroup.add(instancedMesh);
  moonGroup.name = 'moonsGroup';

  if (scene.userData?.moonGroup?.isObject3D && scene.userData.moonGroup.parent === scene) {
    scene.remove(scene.userData.moonGroup);
  }

  scene.add(moonGroup);
  scene.userData = scene.userData || {};
  scene.userData.moonGroup = moonGroup;
}
