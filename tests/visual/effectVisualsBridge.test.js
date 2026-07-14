// @vitest-environment jsdom
/**
 * The rack-effect visual bridge: effect lifetimes → group layers, create on
 * demand and dispose when idle. Coverage: the already-exists case at mount
 * (peek), the created-later case (observer), per-group classification by
 * effectId, wet-only meters (per side for ping-pong), full teardown when the
 * group's last effect leaves (attach/detach + callback add/remove + meter
 * connect/disconnect all balanced), the settings gate, the per-module visual
 * switch (a module switched off binds NOTHING, and `refresh()` flips it live),
 * and the app-owned dispose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { mountEffectVisuals } from '../../src/visual/effectVisualsBridge.js';
import {
  hydrateVisualFeedback,
  setVisualFeedbackEnabled,
} from '../../src/visual/visualFeedbackSettings.js';

function createStubWorldController() {
  return {
    scene: new THREE.Scene(),
    overlays: new Set(),
    callbacks: new Set(),
    attaches: 0,
    detaches: 0,
    frame: { nowSec: 0, dtSec: 0 },
    attachOverlay(group) { this.overlays.add(group); this.attaches += 1; },
    detachOverlay(group) { this.overlays.delete(group); this.detaches += 1; },
    addRenderCallback(cb) { this.callbacks.add(cb); },
    removeRenderCallback(cb) { this.callbacks.delete(cb); },
    // The grit group hands the controller a full-frame pass instead of a scene object.
    postPass: null,
    renderer: { getPixelRatio: () => 1, getDrawingBufferSize: (v) => v.set(320, 200) },
    setPostPass(pass) { this.postPass = pass; },
    runFrame(dtSec = 0.016) {
      this.frame.nowSec += dtSec;
      this.frame.dtSec = dtSec;
      this.callbacks.forEach((cb) => cb(this.frame));
    },
  };
}

/**
 * Draw one frame through the voice's post pass with a renderer that records HOW it
 * was drawn: `['render']` alone means the pass bypassed itself and the frame went
 * straight to the screen; a `'to-target'` means it earned its keep.
 */
function createRecordingRenderer(calls) {
  return {
    autoClear: true,
    getPixelRatio: () => 1,
    getDrawingBufferSize: (v) => v.set(320, 200),
    getRenderTarget: () => null,
    setRenderTarget: (t) => calls.push(t ? 'to-target' : 'to-screen'),
    getViewport: (v) => v.set(0, 0, 320, 200),
    setViewport: () => {},
    getScissor: (v) => v.set(0, 0, 320, 200),
    setScissor: () => {},
    getScissorTest: () => false,
    setScissorTest: () => {},
    clear: () => {},
    render: () => calls.push('render'),
  };
}

function recordFrame(worldController) {
  const calls = [];
  const renderer = createRecordingRenderer(calls);
  worldController.postPass.render(renderer, new THREE.Scene(), new THREE.Camera(), null);
  return calls;
}

/** A fake audio context whose analysers replay their tap's `level` field. */
const fakeContext = {
  createAnalyser() {
    const analyser = {
      fftSize: 2048,
      smoothingTimeConstant: 1,
      level: 0,
      getFloatTimeDomainData(target) { target.fill(analyser.level); },
    };
    return analyser;
  },
};

/** A wet-signal tap: `connect` hands the analyser a live line to this level. */
function createTap(level = 0) {
  const tap = {
    level,
    analysers: new Set(),
    connect: vi.fn((analyser) => {
      tap.analysers.add(analyser);
      Object.defineProperty(analyser, 'level', { get: () => tap.level });
    }),
    disconnect: vi.fn(),
  };
  return tap;
}

function createDelaySlot({ effectId = 'tone.feedbackdelay', wet = 1, delayTime = 0.35 } = {}) {
  const tap = createTap();
  return {
    tap,
    config: { effectId },
    effectNode: {
      context: { rawContext: fakeContext },
      wet: { value: wet },
      delayTime: { value: delayTime },
      effectReturn: tap,
    },
  };
}

function createPingPongSlot({ wet = 1, delayTime = 0.35 } = {}) {
  const leftTap = createTap();
  const rightTap = createTap();
  return {
    leftTap,
    rightTap,
    config: { effectId: 'tone.pingpongdelay' },
    effectNode: {
      context: { rawContext: fakeContext },
      wet: { value: wet },
      delayTime: { value: delayTime },
      _leftDelay: leftTap,
      _rightDelay: rightTap,
    },
  };
}

function createReverbSlot({ effectId = 'tone.reverb', wet = 1, roomSize = 0.5 } = {}) {
  const tap = createTap();
  return {
    tap,
    config: { effectId },
    effectNode: {
      context: { rawContext: fakeContext },
      wet: { value: wet },
      roomSize: { value: roomSize },
      _merge: tap,
    },
  };
}

function createStubAdapter(initialSlots = []) {
  const observers = new Set();
  return {
    peekEffectSlots: () => [...initialSlots],
    observeEffectSlots(cb) {
      observers.add(cb);
      return () => observers.delete(cb);
    },
    emit(slot, present) {
      observers.forEach((cb) => cb(slot, present));
    },
    observers,
  };
}

/** The voice's normalized parameters — the source a visual reads how-far-driven from.
 *  Equilibrium is the middle of the normalized travel (0.5), by the rack's own mapping. */
function createStubParameterManager(values = {}) {
  return {
    values: { x: 0.5, y: 0.5, z: 0.5, ...values },
    getNormalizedValue(axis) { return this.values[axis]; },
  };
}

function createVoiceEntry(initialSlots = []) {
  return {
    worldController: createStubWorldController(),
    audioEngine: createStubAdapter(initialSlots),
    parameterManager: createStubParameterManager(),
  };
}

describe('effect visuals bridge', () => {
  it('mounts nothing for voices without a scene or an engine adapter', () => {
    expect(() => mountEffectVisuals(null).dispose()).not.toThrow();
    expect(() => mountEffectVisuals({ worldController: null, audioEngine: {} }).dispose()).not.toThrow();
    const noScene = { worldController: { scene: null }, audioEngine: createStubAdapter() };
    expect(() => mountEffectVisuals(noScene).dispose()).not.toThrow();
  });

  it('mounts the echoes layer for a delay that already exists (peek), tears down when it leaves', () => {
    const slot = createDelaySlot();
    const entry = createVoiceEntry([slot]);
    const { worldController } = entry;

    const handle = mountEffectVisuals(entry);
    expect(worldController.overlays.size).toBe(1);
    expect(worldController.callbacks.size).toBe(1);
    expect(slot.tap.connect).toHaveBeenCalledTimes(1);

    entry.audioEngine.emit(slot, false);
    expect(worldController.overlays.size).toBe(0);
    expect(worldController.callbacks.size).toBe(0);
    expect(slot.tap.disconnect).toHaveBeenCalledTimes(1);
    expect(worldController.attaches).toBe(worldController.detaches);

    handle.dispose();
  });

  it('mounts on effect create (observer) and ignores uncovered effect families', () => {
    const entry = createVoiceEntry();
    const { worldController } = entry;
    const handle = mountEffectVisuals(entry);
    expect(worldController.overlays.size).toBe(0);

    entry.audioEngine.emit({ config: { effectId: 'tone.chorus' }, effectNode: {} }, true);
    expect(worldController.overlays.size).toBe(0);

    const slot = createDelaySlot();
    entry.audioEngine.emit(slot, true);
    expect(worldController.overlays.size).toBe(1);

    handle.dispose();
    expect(worldController.overlays.size).toBe(0);
    expect(worldController.callbacks.size).toBe(0);
  });

  it('one layer per group across many slots; teardown only when the LAST slot leaves', () => {
    const delayA = createDelaySlot();
    const delayB = createPingPongSlot();
    const entry = createVoiceEntry([delayA, delayB]);
    const { worldController } = entry;

    const handle = mountEffectVisuals(entry);
    expect(worldController.overlays.size).toBe(1);

    entry.audioEngine.emit(delayA, false);
    expect(worldController.overlays.size).toBe(1);
    entry.audioEngine.emit(delayB, false);
    expect(worldController.overlays.size).toBe(0);

    handle.dispose();
  });

  it('feeds the echoes layer measured per-side levels from the ping-pong echo lines', () => {
    const slot = createPingPongSlot({ wet: 1, delayTime: 0.3 });
    const entry = createVoiceEntry([slot]);
    const { worldController } = entry;
    const handle = mountEffectVisuals(entry);

    // No world moons in the scene → the layer summons ghost moons.
    slot.leftTap.level = 0.3;
    slot.rightTap.level = 0;
    worldController.runFrame(); // ghosts born
    worldController.runFrame(2); // grown in, driven by the held levels
    const layerGroup = [...worldController.overlays][0];
    const ghosts = layerGroup.children;
    expect(ghosts.length).toBeGreaterThan(0);
    const left = ghosts[0]; // spec order: left, right, …
    const right = ghosts[1];
    expect(left.material.emissiveIntensity).toBeGreaterThan(0);
    expect(right.material.emissiveIntensity).toBe(0);

    handle.dispose();
  });

  it('scales levels by the live wet mix — bypass reads as invisible', () => {
    const slot = createDelaySlot({ wet: 0 });
    const entry = createVoiceEntry([slot]);
    const { worldController } = entry;
    const handle = mountEffectVisuals(entry);

    slot.tap.level = 0.9;
    worldController.runFrame();
    worldController.runFrame(2);
    const ghosts = [...worldController.overlays][0].children;
    ghosts.forEach((ghost) => expect(ghost.material.emissiveIntensity).toBe(0));

    handle.dispose();
  });

  it('mounts the space/air layer for reverbs and maps room size onto the decay range', () => {
    const slot = createReverbSlot({ wet: 0.5, roomSize: 0.5 });
    const entry = createVoiceEntry([slot]);
    const { worldController } = entry;
    const handle = mountEffectVisuals(entry);
    // The reverb adds nothing to the scene — it changes how the frame is DRAWN.
    expect(worldController.overlays.size).toBe(0);
    expect(worldController.postPass).not.toBeNull();
    expect(slot.tap.connect).toHaveBeenCalledTimes(1);

    // The reverb has to actually RING before anything shows — settle the
    // presence envelope on a tail hot enough to reach its ceiling (the bridge
    // scales the measured level by the wet mix before the layer sees it).
    slot.tap.level = 0.3;
    for (let i = 0; i < 60; i += 1) worldController.runFrame();

    // Once it rings, the pass earns its keep: the frame goes through a target and
    // comes back smeared, instead of straight to the screen.
    const calls = recordFrame(worldController);
    expect(calls).toContain('to-target');

    handle.dispose();
    // The pass is handed back, or the next effect that wants it would find it taken.
    expect(worldController.postPass).toBeNull();
  });

  it('a reverb that is loaded but silent renders nothing — the world does not fog on load', () => {
    // A reverb loads at wet 0.5 by default. Driving the visual off that setting
    // used to thicken the world's sky the moment the orbiter loaded, before a
    // single note played. Presence is the measured tail, so silence shows nothing.
    const slot = createReverbSlot({ wet: 0.5, roomSize: 0.5 });
    const entry = createVoiceEntry([slot]);
    const { worldController } = entry;
    const handle = mountEffectVisuals(entry);

    slot.tap.level = 0; // loaded, mixed in — but nothing is playing through it
    for (let i = 0; i < 60; i += 1) worldController.runFrame();

    // Nothing added to the scene, and the pass is BYPASSED: one straight draw, no
    // target, no quad. A silent reverb costs nothing and changes not one pixel.
    expect(worldController.overlays.size).toBe(0);
    expect(recordFrame(worldController)).toEqual(['render']);

    handle.dispose();
  });

  it('the resolved settings gate a group\'s layer (bindings still track for a later re-gate)', () => {
    const delay = createDelaySlot();
    const reverb = createReverbSlot();
    const entry = createVoiceEntry([delay, reverb]);
    const { worldController } = entry;

    const handle = mountEffectVisuals(entry, {
      getVisualSettings: () => ({ echoes: { enabled: false }, spaceAir: { enabled: true } }),
    });
    // Only the space/air layer mounted; the delay's meter still tracks. The reverb's
    // layer owns no scene object, so it shows up as the post pass, not an overlay.
    expect(worldController.overlays.size).toBe(0);
    expect(worldController.postPass).not.toBeNull();
    expect(delay.tap.connect).toHaveBeenCalledTimes(1);

    handle.dispose();
    expect(delay.tap.disconnect).toHaveBeenCalledTimes(1);
    expect(reverb.tap.disconnect).toHaveBeenCalledTimes(1);
    expect(worldController.overlays.size).toBe(0);
    expect(worldController.callbacks.size).toBe(0);
  });

  it('quality settings size the summoned stand-ins', () => {
    const slot = createDelaySlot();
    const entry = createVoiceEntry([slot]);
    const { worldController } = entry;
    const handle = mountEffectVisuals(entry, {
      getVisualSettings: () => ({ echoes: { enabled: true, summonedMoonCount: 2 } }),
    });

    worldController.runFrame();
    expect([...worldController.overlays][0].children.length).toBe(2);

    handle.dispose();
  });

  it('filters have NO visual — they mount nothing and cost nothing', () => {
    // A filter changes the sound and leaves the world alone. Nothing is built for
    // it: no layer, no canvas, no render callback, no touching body or ring.
    const worldController = createStubWorldController();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    body.name = 'worldTextureSphere';
    worldController.scene.add(body);
    const ringGroup = new THREE.Group();
    ringGroup.name = 'orbitRingGroup';
    ringGroup.rotation.x = 1.2;
    worldController.scene.add(ringGroup);

    const slots = [
      { config: { effectId: 'tone.biquadFilter' }, effectNode: { type: 'lowpass', frequency: { value: 160 } } },
      { config: { effectId: 'tone.autoWah' }, effectNode: { baseFrequency: 100, wet: { value: 1 } } },
    ];
    const adapter = { peekEffectSlots: () => slots, observeEffectSlots: () => () => {} };
    const handle = mountEffectVisuals({ id: 'v', worldController, audioEngine: adapter });

    expect(worldController.overlays.size).toBe(0);
    expect(worldController.callbacks.size).toBe(0); // nothing to drive → no frame work at all

    // The world is untouched: body colour and ring tilt exactly as built.
    expect(body.material.color.r).toBeCloseTo(1, 5);
    expect(ringGroup.rotation.x).toBeCloseTo(1.2, 5);

    handle.dispose();
  });

  describe('wobble — the LFO modulators churn the moons\' surfaces', () => {
    /** A moon field shaped like the world's: one InstancedMesh in a `moonsGroup`. */
    function addMoons(worldController, count = 4) {
      const mesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.1, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0xffffff }),
        count,
      );
      const group = new THREE.Group();
      group.name = 'moonsGroup';
      group.add(mesh);
      worldController.scene.add(group);
      return mesh;
    }

    const WOBBLE_SETTINGS = {
      wobble: { enabled: true, bumpScale: 1, noiseTextureSize: 64 },
    };

    function chorusSlot(overrides = {}) {
      return {
        config: { effectId: 'tone.chorus' },
        effectNode: { frequency: { value: 2 }, depth: 0.8, wet: { value: 1 }, ...overrides },
      };
    }

    it('lights the moons without touching their geometry, adding no draw call', () => {
      const worldController = createStubWorldController();
      const mesh = addMoons(worldController);
      const originalGeometry = mesh.geometry;
      const originalPositions = mesh.geometry.getAttribute('position').array.slice();
      const adapter = {
        peekEffectSlots: () => [chorusSlot()],
        observeEffectSlots: () => () => {},
      };
      const handle = mountEffectVisuals(
        { id: 'v', worldController, audioEngine: adapter },
        { getVisualSettings: () => WOBBLE_SETTINGS },
      );
      worldController.runFrame();

      // The layer owns no scene object — the moons are already drawn.
      expect(worldController.overlays.size).toBe(0);
      expect(worldController.callbacks.size).toBe(1);
      // The world's OWN geometry, kept: displacing a textured sphere would tear it
      // open along the very UV seam the moon texture works to hide. Not one vertex
      // moves; the geometry only gains the per-moon variety the shader reads.
      expect(mesh.geometry).toBe(originalGeometry);
      expect(mesh.geometry.getAttribute('position').array).toEqual(originalPositions);
      expect(mesh.geometry.getAttribute('aNoiseStrength').count).toBe(mesh.count);
      expect(mesh.material.defines.USE_NOISE_INSTANCING).toBeDefined();

      handle.dispose();
      // Everything borrowed is given back — the world's geometry is left as it was.
      expect(mesh.geometry.getAttribute('aNoiseStrength')).toBeUndefined();
      expect(mesh.material.defines.USE_NOISE_INSTANCING).toBeUndefined();
    });

    it('the surface moves at the effect\'s own rate and settles flat when bypassed', () => {
      const worldController = createStubWorldController();
      const mesh = addMoons(worldController);
      const slot = chorusSlot();
      const adapter = {
        peekEffectSlots: () => [slot],
        observeEffectSlots: () => () => {},
      };
      const handle = mountEffectVisuals(
        { id: 'v', worldController, audioEngine: adapter },
        { getVisualSettings: () => WOBBLE_SETTINGS },
      );

      // The material is patched when the adapter acquires the moons, on the first
      // frame — so run one, THEN reach the live uniforms the way the renderer does.
      worldController.runFrame(1 / 60);
      const shader = { uniforms: {}, vertexShader: BASE_VERTEX, fragmentShader: BASE_FRAGMENT };
      mesh.material.onBeforeCompile(shader);

      // Engaged: presence climbs and the reconstructed LFO advances.
      for (let i = 0; i < 30; i += 1) worldController.runFrame(1 / 60);
      expect(shader.uniforms.uAmount.value).toBeGreaterThan(0.3);
      const phaseA = shader.uniforms.uWobble.value;
      worldController.runFrame(1 / 60);
      expect(shader.uniforms.uWobble.value).not.toBeCloseTo(phaseA, 6);

      // Bypassed: the surface goes still — presence decays to exactly zero.
      slot.effectNode.wet.value = 0;
      for (let i = 0; i < 240; i += 1) worldController.runFrame(1 / 60);
      expect(shader.uniforms.uAmount.value).toBe(0);

      handle.dispose();
    });

    it('runs alongside the echoes visual without either erasing the other', () => {
      // Echoes owns instanceMatrix/instanceColor; wobble owns the material +
      // geometry attributes. A delay and a chorus on one rack must coexist.
      const worldController = createStubWorldController();
      const mesh = addMoons(worldController);
      const adapter = {
        peekEffectSlots: () => [createDelaySlot(), chorusSlot()],
        observeEffectSlots: () => () => {},
      };
      const handle = mountEffectVisuals(
        { id: 'v', worldController, audioEngine: adapter },
        {
          getVisualSettings: () => ({
            ...WOBBLE_SETTINGS,
            echoes: { enabled: true, summonedMoonCount: 4 },
          }),
        },
      );
      for (let i = 0; i < 10; i += 1) worldController.runFrame(1 / 60);

      // Wobble patched the material (and moved no vertex)...
      expect(mesh.material.defines.USE_NOISE_INSTANCING).toBeDefined();
      expect(mesh.geometry.getAttribute('aNoiseStrength')).toBeDefined();
      // ...and echoes still owns the instance arrays it always did (three exposes
      // `needsUpdate` as write-only, so the upload shows up as a version bump).
      expect(mesh.instanceMatrix.version).toBeGreaterThan(0);

      handle.dispose();
    });
  });

  describe('the grit group — the dirt crushes the picture', () => {
    /** A grit slot. How far it is driven comes from the voice's ParameterManager, keyed
     *  by the module's own identity — its dimension and its axis. */
    function createGritSlot({ effectId = 'tone.distortion', axis = 'x' } = {}) {
      return {
        config: { effectId },
        dimensionId: 'dim-1',
        axis,
        effectNode: { context: { rawContext: fakeContext }, wet: { value: 1 } },
      };
    }

    it('hands the world controller a post pass, and takes it back when the effect leaves', () => {
      const slot = createGritSlot();
      const entry = createVoiceEntry([slot]);
      const { worldController } = entry;
      entry.parameterManager.values.x = 1;

      const handle = mountEffectVisuals(entry);
      expect(worldController.postPass).not.toBeNull();
      // It owns no scene object: nothing is added to the world, the frame is drawn differently.
      expect(worldController.overlays.size).toBe(0);
      expect(worldController.callbacks.size).toBe(1);

      entry.audioEngine.emit(slot, false);
      expect(worldController.postPass).toBeNull();
      expect(worldController.callbacks.size).toBe(0);

      handle.dispose();
    });

    it('binds no meter — a visual must not touch the audio graph to read a knob', () => {
      const slot = createGritSlot();
      const entry = createVoiceEntry([slot]);
      const created = [];
      slot.effectNode.context = {
        rawContext: { createAnalyser: () => { created.push(1); return fakeContext.createAnalyser(); } },
      };

      const handle = mountEffectVisuals(entry);
      expect(created).toHaveLength(0);
      handle.dispose();
    });

    it('AT EQUILIBRIUM THE VISUAL IS ABSENT — the picture is untouched, not merely subtle', () => {
      const entry = createVoiceEntry([createGritSlot()]);
      const { worldController } = entry;   // the axis rests at equilibrium (0.5 normalized)
      const handle = mountEffectVisuals(entry);

      const seen = [];
      worldController.postPass.setGrit = (params) => seen.push(params);
      worldController.runFrame();

      expect(seen[0].clip).toBe(0);       // no clipping, no colour shift
      expect(seen[0].crush).toBe(0);      // no quantisation
      expect(seen[0].fold).toBe(0);       // no folding
      expect(seen[0].pixelSize).toBe(1);  // no blocks
      expect(seen[0].levels).toBe(32);    // full colour
      handle.dispose();
    });

    it('AT REST THE PASS IS BYPASSED, not merely mixed to zero — the frame is drawn straight', () => {
      const entry = createVoiceEntry([createGritSlot()]);
      const { worldController } = entry;
      const handle = mountEffectVisuals(entry);

      // A renderer that records HOW the frame was drawn: straight, or through a target.
      const calls = [];
      const renderer = createRecordingRenderer(calls);

      worldController.runFrame();
      worldController.postPass.render(renderer, new THREE.Scene(), new THREE.Camera(), null);
      // One straight draw. No target, no quad: the cost is not paid, and the renderer's
      // antialiasing is not thrown away while the effect is silent.
      expect(calls).toEqual(['render']);

      entry.parameterManager.values.x = 1; // driven to +100%
      worldController.runFrame();
      calls.length = 0;
      worldController.postPass.render(renderer, new THREE.Scene(), new THREE.Camera(), null);
      expect(calls).toContain('to-target'); // now it earns its keep
      expect(calls.filter((c) => c === 'render')).toHaveLength(2); // scene + quad

      handle.dispose();
    });

    it('THE PICTURE DOES NOT GO DIRTY BEFORE THE SOUND DOES, then grows late', () => {
      const entry = createVoiceEntry([createGritSlot()]); // a distortion: it CLIPS
      const { worldController } = entry;
      const handle = mountEffectVisuals(entry);

      const seen = [];
      worldController.postPass.setGrit = (params) => seen.push(params);

      entry.parameterManager.values.x = 0.6;  // a gentle nudge — the sound is still clean
      worldController.runFrame();
      expect(seen.at(-1).clip).toBe(0);       // …so the picture is untouched

      entry.parameterManager.values.x = 0.75; // halfway to +100%
      worldController.runFrame();
      const halfway = seen.at(-1).clip;
      expect(halfway).toBeGreaterThan(0);
      expect(halfway).toBeLessThan(0.25);     // grows LATE: not yet a broken picture

      entry.parameterManager.values.x = 1;    // +100%
      worldController.runFrame();
      expect(seen.at(-1).clip).toBeCloseTo(1, 5);

      entry.parameterManager.values.x = 0;    // −100% — the sound differs, the ANSWER is as full
      worldController.runFrame();
      expect(seen.at(-1).clip).toBeCloseTo(1, 5);

      handle.dispose();
    });

    it('A DISTORTION NEVER PIXELATES — the blocks belong to the bit-crusher alone', () => {
      // The three dirts sound nothing alike, so they must not look alike. Losing bits is
      // what makes blocks; clipping does not.
      const entry = createVoiceEntry([createGritSlot({ effectId: 'tone.distortion' })]);
      const { worldController } = entry;
      entry.parameterManager.values.x = 1;
      const handle = mountEffectVisuals(entry);

      const seen = [];
      worldController.postPass.setGrit = (params) => seen.push(params);
      worldController.runFrame();

      expect(seen.at(-1).clip).toBeCloseTo(1, 5);
      expect(seen.at(-1).crush).toBe(0);
      expect(seen.at(-1).pixelSize).toBe(1);  // no blocks
      expect(seen.at(-1).levels).toBe(32);    // full colour
      handle.dispose();
    });

    it('EACH EFFECT DRIVES ITS OWN LOOK — a crusher and a distortion on one rack both speak', () => {
      const distortion = createGritSlot({ effectId: 'tone.distortion', axis: 'x' });
      const crusher = createGritSlot({ effectId: 'tone.bitcrusher', axis: 'y' });
      const entry = createVoiceEntry([distortion, crusher]);
      const { worldController } = entry;
      entry.parameterManager.values.x = 0.5;  // the distortion rests
      entry.parameterManager.values.y = 0.95; // the crusher is driven

      const handle = mountEffectVisuals(entry);
      const seen = [];
      worldController.postPass.setGrit = (params) => seen.push(params);
      worldController.runFrame();

      // The crusher's drive lands on the crusher's channel — it is not averaged with the
      // resting distortion, and it does not leak into the distortion's look.
      expect(seen.at(-1).crush).toBeGreaterThan(0);
      expect(seen.at(-1).clip).toBe(0);
      expect(seen.at(-1).pixelSize).toBeGreaterThan(1); // the crusher's blocks, and only its

      // Now drive the distortion too: BOTH pictures are on, neither cancels the other.
      entry.parameterManager.values.x = 1;
      worldController.runFrame();
      expect(seen.at(-1).crush).toBeGreaterThan(0);
      expect(seen.at(-1).clip).toBeCloseTo(1, 5);

      handle.dispose();
    });

    it('within ONE kind, the module driven furthest owns the picture', () => {
      // Averaging would let a module sitting at equilibrium wash out the one you hear.
      const restingCrusher = createGritSlot({ effectId: 'tone.bitcrusher', axis: 'x' });
      const drivenCrusher = createGritSlot({ effectId: 'tone.bitcrusher', axis: 'y' });
      const entry = createVoiceEntry([restingCrusher, drivenCrusher]);
      const { worldController } = entry;
      entry.parameterManager.values.x = 0.5;
      entry.parameterManager.values.y = 1;

      const handle = mountEffectVisuals(entry);
      const seen = [];
      worldController.postPass.setGrit = (params) => seen.push(params);
      worldController.runFrame();

      expect(seen.at(-1).crush).toBeCloseTo(1, 5);
      handle.dispose();
    });

    it('keeps driving the picture when a DIFFERENT group\'s effect leaves', () => {
      const gritSlot = createGritSlot({ axis: 'x' });
      const delaySlot = Object.assign(createDelaySlot(), { dimensionId: 'dim-1', axis: 'y' });
      const entry = createVoiceEntry([gritSlot, delaySlot]);
      const { worldController } = entry;
      const handle = mountEffectVisuals(entry);

      // The delay goes; grit stays — and must keep being driven every frame.
      entry.audioEngine.emit(delaySlot, false);
      expect(worldController.callbacks.size).toBe(1);

      const seen = [];
      worldController.postPass.setGrit = (params) => seen.push(params);
      entry.parameterManager.values.x = 0.95;
      worldController.runFrame();
      expect(seen.at(-1).clip).toBeGreaterThan(0); // not frozen at its last value

      handle.dispose();
    });

    it('a grit module with its visual switched OFF builds no pass at all', () => {
      hydrateVisualFeedback('voice-grit', { 'dim-1': { x: { enabled: false } } });
      const entry = { ...createVoiceEntry([createGritSlot()]), id: 'voice-grit' };

      const handle = mountEffectVisuals(entry);
      expect(entry.worldController.postPass).toBeNull();
      expect(entry.worldController.callbacks.size).toBe(0);

      handle.dispose();
      hydrateVisualFeedback('voice-grit', null);
    });
  });

  describe('the per-module visual switch', () => {
    const VOICE = 'voice-1';

    beforeEach(() => {
      hydrateVisualFeedback(VOICE, null);
    });

    /** A slot carries its own identity: which dimension, and which axis of it. */
    function withModule(slot, { dimensionId = 'dim-1', axis = 'x' } = {}) {
      return Object.assign(slot, { dimensionId, axis });
    }

    it('a module switched off binds NOTHING at load — no meter, no layer, no callback', () => {
      hydrateVisualFeedback(VOICE, { 'dim-1': { x: { enabled: false } } });
      const slot = withModule(createDelaySlot());
      const entry = { ...createVoiceEntry([slot]), id: VOICE };
      const { worldController } = entry;

      const handle = mountEffectVisuals(entry);

      // The cost is never paid: nothing on the audio graph, nothing in the scene.
      expect(slot.tap.connect).not.toHaveBeenCalled();
      expect(worldController.overlays.size).toBe(0);
      expect(worldController.callbacks.size).toBe(0);

      handle.dispose();
    });

    it('gates per module: the switched-off axis binds nothing, its sibling still answers', () => {
      hydrateVisualFeedback(VOICE, { 'dim-1': { x: { enabled: false } } });
      const off = withModule(createDelaySlot(), { axis: 'x' });
      const on = withModule(createReverbSlot(), { axis: 'y' });
      const entry = { ...createVoiceEntry([off, on]), id: VOICE };

      const handle = mountEffectVisuals(entry);

      expect(off.tap.connect).not.toHaveBeenCalled();
      expect(on.tap.connect).toHaveBeenCalledTimes(1);
      // Only the space/air layer (the reverb's) mounted — the echoes layer never
      // existed. It adds no overlay: it takes the frame's post pass instead.
      expect(entry.worldController.overlays.size).toBe(0);
      expect(entry.worldController.postPass).not.toBeNull();

      handle.dispose();
    });

    it('the same module on another dimension is a different switch', () => {
      hydrateVisualFeedback(VOICE, { 'dim-2': { x: { enabled: false } } });
      const slot = withModule(createDelaySlot(), { dimensionId: 'dim-1', axis: 'x' });
      const entry = { ...createVoiceEntry([slot]), id: VOICE };

      const handle = mountEffectVisuals(entry);
      expect(entry.worldController.overlays.size).toBe(1);

      handle.dispose();
    });

    it('refresh() flips a live module both ways, and never touches the effect node', () => {
      const slot = withModule(createDelaySlot());
      const entry = { ...createVoiceEntry([slot]), id: VOICE };
      const { worldController } = entry;
      const effectNode = slot.effectNode;

      const handle = mountEffectVisuals(entry);
      expect(worldController.overlays.size).toBe(1);

      // Switch it off: the visual is torn down...
      setVisualFeedbackEnabled(VOICE, 'dim-1', 'x', false);
      handle.refresh();
      expect(worldController.overlays.size).toBe(0);
      expect(worldController.callbacks.size).toBe(0);
      expect(slot.tap.disconnect).toHaveBeenCalledTimes(1);

      // ...and back on: it builds exactly what it would have built at load.
      setVisualFeedbackEnabled(VOICE, 'dim-1', 'x', true);
      handle.refresh();
      expect(worldController.overlays.size).toBe(1);
      expect(worldController.callbacks.size).toBe(1);
      expect(slot.tap.connect).toHaveBeenCalledTimes(2);

      // The sound is untouched through all of it: same node, never disposed or rebuilt.
      expect(slot.effectNode).toBe(effectNode);
      expect(worldController.attaches).toBe(worldController.detaches + 1);

      handle.dispose();
    });

    it('a module created later is gated too (the observer path)', () => {
      setVisualFeedbackEnabled(VOICE, 'dim-1', 'z', false);
      const entry = { ...createVoiceEntry(), id: VOICE };
      const handle = mountEffectVisuals(entry);

      const slot = withModule(createDelaySlot(), { axis: 'z' });
      entry.audioEngine.emit(slot, true);

      expect(slot.tap.connect).not.toHaveBeenCalled();
      expect(entry.worldController.overlays.size).toBe(0);

      handle.dispose();
    });
  });
});

/** Minimal stand-ins for the three.js chunks the patch splices into. */
const BASE_VERTEX = '#include <common>\nvoid main() {\n#include <begin_vertex>\n}';
const BASE_FRAGMENT = '#include <common>\nvoid main() {\n#include <normal_fragment_maps>\n}';
