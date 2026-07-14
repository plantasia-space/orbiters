/**
 * @file fx-harness/harness.js
 * @description Dev rig for the fixed sound→visual vocabulary
 *              (`/fx-harness.html`). Ships as a second build page — like the
 *              granular harness before it — so audio and visual budgets can
 *              be exercised on real phones against the deployed dev env; it
 *              is not linked from the app. One tab per effect group; each tab
 *              drives real
 *              audio over a bare native AudioContext — no Tone, no app boot —
 *              and the group's visual response on a shared standalone stage
 *              (planet, moons, cloud shell, glow, granular disk). The stage
 *              stands in for the orbiter scene: what a tab modulates here is
 *              exactly what the production layer will modulate there, and a
 *              stage element can be toggled off to prove the summoned-canvas
 *              rule (a world without moons gets ephemeral ghost moons that
 *              grow in with the effect and dissolve with it).
 */

import * as THREE from 'three';
import { createGranularDiskLayer } from '../visual/granularDiskLayer.js';
import { createWetPathMeter } from '../visual/wetPathMeter.js';
import { createGranularTab } from './tabGranular.js';
import { createEchoesTab } from './tabEchoes.js';
import { createSpaceTab } from './tabSpace.js';
import { createGritTab } from './tabGrit.js';
import { createPositionTab } from './tabPosition.js';
import { createPitchTab } from './tabPitch.js';
import { createTimeTab } from './tabTime.js';

const app = document.getElementById('app');
// The visual stage lives OUTSIDE #app so control re-renders never tear down the canvas.
const visualHost = document.createElement('div');
app.before(visualHost);

/**
 * The harness's stand-in for the orbiter scene: renderer + camera + the
 * canvas elements the vocabulary binds to (planet body, moons, cloud shell,
 * soft glow, granular disk) + one RAF loop that drives the active tab.
 */
function createStage({ container }) {
  const width = container.clientWidth || 640;
  const height = 300;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 50);
  camera.position.set(0, 1.4, 4.2);
  camera.lookAt(0, 0, 0);

  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 24),
    new THREE.MeshStandardMaterial({ color: 0x1c2733, roughness: 0.85, metalness: 0.1 }),
  );
  scene.add(planet);
  scene.add(new THREE.AmbientLight(0x8899bb, 0.5));
  const sun = new THREE.DirectionalLight(0xffeedd, 1.4);
  sun.position.set(3, 2, 2);
  scene.add(sun);

  // Moons — the echo group's canvas. Two per stereo side, on tilted orbits.
  const moonsGroup = new THREE.Group();
  const moons = [];
  const moonSpecs = [
    { side: -1, phase: 0.15, tilt: 0.18, speed: 0.22 },
    { side: 1, phase: 0.65, tilt: -0.12, speed: 0.17 },
    { side: -1, phase: 0.45, tilt: -0.22, speed: 0.13 },
    { side: 1, phase: 0.9, tilt: 0.25, speed: 0.27 },
  ];
  moonSpecs.forEach((spec) => {
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 16, 12),
      new THREE.MeshStandardMaterial({
        color: 0x9aa4b5,
        roughness: 0.7,
        emissive: 0xbfd6ff,
        emissiveIntensity: 0,
      }),
    );
    moonsGroup.add(moon);
    moons.push({ mesh: moon, side: spec.side, spec, angle: spec.phase * Math.PI * 2, radius: 1.9 });
  });
  scene.add(moonsGroup);

  // Ring — the motion-wobble group's canvas. A thin tilted band standing in
  // for the oscilloscope ring, visible as a world feature like the moons.
  const RING_TILT = (15 * Math.PI) / 180;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.45, 0.012, 8, 96),
    new THREE.MeshStandardMaterial({
      color: 0x7f8ba1,
      roughness: 0.5,
      emissive: 0x44506a,
      emissiveIntensity: 0.5,
    }),
  );
  ring.rotation.x = Math.PI / 2 + RING_TILT;
  scene.add(ring);

  // Cloud shell + soft glow — the space/air group's canvas. Both invisible until driven.
  const cloudShell = new THREE.Mesh(
    new THREE.SphereGeometry(1.16, 32, 24),
    new THREE.MeshStandardMaterial({
      color: 0xaec6e8,
      transparent: true,
      opacity: 0,
      roughness: 1,
      depthWrite: false,
    }),
  );
  cloudShell.visible = false;
  scene.add(cloudShell);

  const glowTexture = (() => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(190,214,255,0.85)');
    grad.addColorStop(0.4, 'rgba(150,180,235,0.35)');
    grad.addColorStop(1, 'rgba(120,150,220,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  })();
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture, transparent: true, opacity: 0, depthWrite: false }),
  );
  glow.scale.setScalar(3);
  glow.visible = false;
  scene.add(glow);

  const diskLayer = createGranularDiskLayer({ radius: 1 });
  scene.add(diskLayer.group);

  // Host group for effect-summoned stand-ins (ghost moons, summoned mist…):
  // ephemeral, visual-only elements a tab grows when the world lacks the
  // group's canvas. Tabs own their children's lifecycle; the group is just
  // the mount point.
  const overlay = new THREE.Group();
  scene.add(overlay);

  const clock = new THREE.Clock();
  let prevNow = 0;
  let disposed = false;
  let frameCallback = null;

  function renderLoop() {
    if (disposed) return;
    const now = clock.getElapsedTime();
    const dt = Math.min(now - prevNow, 0.1);
    prevNow = now;
    planet.rotation.y += 0.0008;
    moons.forEach((m) => {
      m.angle += m.spec.speed * dt;
      m.mesh.position.set(
        Math.cos(m.angle) * m.radius * m.side,
        Math.sin(m.angle * 0.7) * m.spec.tilt * m.radius,
        Math.sin(m.angle) * m.radius,
      );
    });
    if (frameCallback) frameCallback(now, dt);
    diskLayer.update(now, dt);
    renderer.render(scene, camera);
    requestAnimationFrame(renderLoop);
  }
  renderLoop();

  return {
    diskLayer,
    moons,
    moonsGroup,
    ring,
    ringBaseTilt: RING_TILT,
    planet,
    cloudShell,
    glow,
    overlay,
    /** One active per-frame hook — owned by the active tab. */
    setFrameCallback(cb) {
      frameCallback = cb;
    },
    dispose() {
      disposed = true;
      diskLayer.dispose();
      planet.geometry.dispose();
      planet.material.dispose();
      moons.forEach((m) => {
        m.mesh.geometry.dispose();
        m.mesh.material.dispose();
      });
      ring.geometry.dispose();
      ring.material.dispose();
      cloudShell.geometry.dispose();
      cloudShell.material.dispose();
      glow.material.dispose();
      glowTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

const state = {
  ctx: null,
  buffer: null,
  dryGain: null,
  /** Post-source tap the effect tabs feed from (dry stays audible via dryGain). */
  inputBus: null,
  drySource: null,
  playing: false,
  startedAt: 0,
  sourceRate: 1,
  sourceDetuneCents: 0,
  stage: null,
  activeTab: null,
  activeTabId: null,
};

function ensureContext() {
  if (!state.ctx) {
    state.ctx = new AudioContext();
    state.dryGain = state.ctx.createGain();
    state.dryGain.connect(state.ctx.destination);
    state.inputBus = state.ctx.createGain();
  }
  return state.ctx;
}

function ensureStage() {
  if (!state.stage) {
    state.stage = createStage({ container: visualHost });
  }
  return state.stage;
}

function getPositionMs() {
  if (!state.playing || !state.buffer) return 0;
  const elapsed = state.ctx.currentTime - state.startedAt;
  return ((elapsed % state.buffer.duration) + state.buffer.duration) % state.buffer.duration * 1000;
}

function applySourceTuning() {
  if (!state.drySource) return;
  const now = state.ctx.currentTime;
  state.drySource.playbackRate.setTargetAtTime(state.sourceRate, now, 0.05);
  state.drySource.detune.setTargetAtTime(state.sourceDetuneCents, now, 0.05);
}

function startDry() {
  if (state.playing || !state.buffer) return;
  const ctx = ensureContext();
  const source = ctx.createBufferSource();
  source.buffer = state.buffer;
  source.loop = true;
  source.playbackRate.value = state.sourceRate;
  source.detune.value = state.sourceDetuneCents;
  source.connect(state.dryGain);
  source.connect(state.inputBus);
  source.start();
  state.drySource = source;
  state.startedAt = ctx.currentTime;
  state.playing = true;
  renderTransport();
}

function stopDry() {
  if (!state.playing) return;
  try {
    state.drySource?.stop();
    state.drySource?.disconnect();
  } catch (_) {}
  state.drySource = null;
  state.playing = false;
  renderTransport();
}

async function loadFile(file) {
  const ctx = ensureContext();
  if (ctx.state === 'suspended') await ctx.resume();
  stopDry();
  const arrayBuffer = await file.arrayBuffer();
  state.buffer = await ctx.decodeAudioData(arrayBuffer);
  renderTransport();
}

/** The shared surface each tab builds against. */
const rig = {
  ensureContext,
  ensureStage,
  // The production wet-path meter (visual/wetPathMeter.js) — one implementation.
  createMeter: createWetPathMeter,
  getBuffer: () => state.buffer,
  isPlaying: () => state.playing,
  getPositionMs,
  getInputBus: () => {
    ensureContext();
    return state.inputBus;
  },
  getDestination: () => {
    ensureContext();
    return state.ctx.destination;
  },
  /** Ramp the dry loop's level — engines that own a wet/dry blend duck the dry through this. */
  setDryLevel(level) {
    if (!state.ctx) return;
    state.dryGain.gain.setTargetAtTime(level, state.ctx.currentTime, 0.05);
  },
  /** Source detune in cents (pitch group's stand-in — production uses a real shifter). */
  setSourceDetune(cents) {
    state.sourceDetuneCents = cents;
    applySourceTuning();
  },
  /** Source varispeed (time group's harness audio). */
  setSourceRate(rate) {
    state.sourceRate = rate;
    applySourceTuning();
  },
};

const TABS = [
  createGranularTab(rig),
  createEchoesTab(rig),
  createSpaceTab(rig),
  createGritTab(rig),
  createPositionTab(rig),
  createPitchTab(rig),
  createTimeTab(rig),
];

// Static layout: transport row (re-rendered on load/play), tabs row, persistent tab host.
const transportHost = document.createElement('div');
const tabsRow = document.createElement('div');
tabsRow.className = 'row';
const tabHost = document.createElement('div');
app.append(transportHost, tabsRow, tabHost);

function renderTransport() {
  transportHost.innerHTML = '';
  const controls = document.createElement('div');
  controls.className = 'row';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'audio/*';
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) loadFile(fileInput.files[0]);
  });
  controls.appendChild(fileInput);

  const playButton = document.createElement('button');
  playButton.textContent = state.playing ? 'Stop' : 'Play dry loop';
  playButton.disabled = !state.buffer;
  playButton.addEventListener('click', () => (state.playing ? stopDry() : startDry()));
  controls.appendChild(playButton);

  const info = document.createElement('span');
  info.className = 'muted';
  info.textContent = state.buffer
    ? `${state.buffer.duration.toFixed(1)}s · ${state.buffer.numberOfChannels}ch · ${state.buffer.sampleRate}Hz`
    : 'no file loaded';
  controls.appendChild(info);
  transportHost.appendChild(controls);
}

function renderTabButtons() {
  tabsRow.innerHTML = '';
  TABS.forEach((tab) => {
    const button = document.createElement('button');
    button.className = `tab${state.activeTabId === tab.id ? ' active' : ''}`;
    button.textContent = tab.label;
    button.addEventListener('click', () => switchTab(tab.id));
    tabsRow.appendChild(button);
  });
}

function switchTab(tabId) {
  if (state.activeTabId === tabId) return;
  if (state.activeTab) {
    state.activeTab.dispose();
    state.activeTab = null;
  }
  if (state.stage) state.stage.setFrameCallback(null);
  state.activeTabId = tabId;
  renderTabButtons();
  tabHost.innerHTML = '';
  const tab = TABS.find((t) => t.id === tabId);
  if (tab) state.activeTab = tab.mount(tabHost);
}

renderTransport();
renderTabButtons();
switchTab(TABS[0].id);
