// @vitest-environment jsdom
/**
 * The granular visual bridge: engine lifetime → accretion disk layer, create
 * on demand and dispose when idle. Coverage: the already-exists case at mount
 * (peek), the created-later case (observer), full teardown when the last
 * module releases the engine (attach/detach + callback add/remove all
 * balanced), repeated insert/remove cycles, per-adapter + per-family
 * filtering, and the app-owned dispose.
 */
import { describe, it, expect, vi } from 'vitest';
import { mountGranularVisual } from '../../src/visual/granularVisualBridge.js';
import { GRANULAR_ENGINE_ID } from '../../src/audio/granular/GranularEngine.js';
import { createSourceEngineHost } from '../../src/audio/sourceEngineHost.js';

function createStubWorldController() {
  return {
    overlays: new Set(),
    callbacks: new Set(),
    attaches: 0,
    detaches: 0,
    // Mirrors the real controller's frame clock: one reused object per frame.
    frame: { nowSec: 0, dtSec: 0 },
    attachOverlay(group) { this.overlays.add(group); this.attaches += 1; },
    detachOverlay(group) { this.overlays.delete(group); this.detaches += 1; },
    addRenderCallback(cb) { this.callbacks.add(cb); },
    removeRenderCallback(cb) { this.callbacks.delete(cb); },
    runFrame(dtSec = 0.016) {
      this.frame.nowSec += dtSec;
      this.frame.dtSec = dtSec;
      this.callbacks.forEach((cb) => cb(this.frame));
    },
  };
}

function createStubEngine(params = { wet: 0.5 }) {
  return {
    listeners: new Set(),
    params,
    addGrainListener(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
    peekParams() { return this.params; },
    emitGrain(spawn, audioNowSec) {
      this.listeners.forEach((fn) => fn(spawn, audioNowSec));
    },
    dispose: vi.fn(),
  };
}

function countWrittenSlots(group) {
  const births = group.children[0].geometry.getAttribute('aBirth').array;
  let written = 0;
  for (let i = 0; i < births.length; i += 1) {
    if (births[i] !== -1e3) written += 1;
  }
  return written;
}

/** A voice's adapter as the bridge sees it: the source-engine host surface,
 *  backed by a real host wired to a fake graph. */
function createStubAdapter() {
  const host = createSourceEngineHost({
    getContext: () => ({}),
    getMixBus: () => ({}),
    connect: () => {},
    getBuffer: () => null,
    getPositionMs: () => 0,
    isPlaying: () => false,
    setDryLevel: () => {},
  });
  return {
    acquireSourceEngine: (id, build) => host.acquire(id, build),
    peekSourceEngine: (id) => host.peek(id),
    observeSourceEngines: (cb) => host.observe(cb),
  };
}

function createVoiceEntry() {
  return { worldController: createStubWorldController(), audioEngine: createStubAdapter() };
}

describe('granular visual bridge', () => {
  it('mounts nothing for voices without a scene or an engine adapter', () => {
    expect(() => mountGranularVisual(null).dispose()).not.toThrow();
    expect(() => mountGranularVisual({ worldController: null, audioEngine: {} }).dispose()).not.toThrow();
    const sceneOnly = { worldController: createStubWorldController(), audioEngine: null };
    mountGranularVisual(sceneOnly).dispose();
    expect(sceneOnly.worldController.attaches).toBe(0);
  });

  it('mounts immediately when the engine already exists (created during adapter init)', () => {
    const entry = createVoiceEntry();
    const engine = createStubEngine();
    const lease = entry.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => engine);

    const handle = mountGranularVisual(entry);
    expect(entry.worldController.overlays.size).toBe(1);
    expect(entry.worldController.callbacks.size).toBe(1);
    expect(engine.listeners.size).toBe(1);

    handle.dispose();
    lease.release();
  });

  it('mounts on engine create, tears fully down on last release, and survives cycles', () => {
    const entry = createVoiceEntry();
    const { worldController } = entry;
    const handle = mountGranularVisual(entry);
    expect(worldController.overlays.size).toBe(0);
    expect(worldController.callbacks.size).toBe(0);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const engine = createStubEngine();
      const lease = entry.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => engine);
      expect(worldController.overlays.size).toBe(1);
      expect(worldController.callbacks.size).toBe(1);
      expect(engine.listeners.size).toBe(1);

      const [group] = [...worldController.overlays];
      const material = group.children[0].material;
      worldController.runFrame();
      expect(material.uniforms.uIntensity.value).toBeCloseTo(0.5, 5);

      lease.release();
      expect(worldController.overlays.size).toBe(0);
      expect(worldController.callbacks.size).toBe(0);
      expect(engine.listeners.size).toBe(0);
    }
    // Every attach/add was balanced by a detach/remove.
    expect(worldController.attaches).toBe(3);
    expect(worldController.detaches).toBe(3);
    handle.dispose();
  });

  it('ignores other voices\' engines and other engine families on the same adapter', () => {
    const entry = createVoiceEntry();
    const handle = mountGranularVisual(entry);
    // Another voice's adapter hosts its own engines — nothing crosses over.
    const otherLease = createStubAdapter().acquireSourceEngine(GRANULAR_ENGINE_ID, () => createStubEngine());
    expect(entry.worldController.overlays.size).toBe(0);
    otherLease.release();
    // A different family on THIS adapter is not the granular layer's business.
    const familyLease = entry.audioEngine.acquireSourceEngine('other-family', () => createStubEngine());
    expect(entry.worldController.overlays.size).toBe(0);
    familyLease.release();
    handle.dispose();
  });

  it('feeds the voice\'s live orbit-ring color into the layer palette', () => {
    const entry = createVoiceEntry();
    entry.oscilloscope = { orbitColor: { r: 0, g: 0, b: 1 } };
    const engine = createStubEngine({ wet: 0.5 });
    const lease = entry.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => engine);
    const handle = mountGranularVisual(entry);
    entry.worldController.runFrame();

    const [group] = [...entry.worldController.overlays];
    const { uLowColor, uHighColor } = group.children[0].material.uniforms;
    // Both palette ends derive from blue (hue ~2/3), not the ember/ice defaults.
    expect(uLowColor.value.getHSL({}).h).toBeCloseTo(2 / 3 - 0.07, 2);
    expect(uHighColor.value.getHSL({}).h).toBeCloseTo(2 / 3 + 0.07, 2);

    handle.dispose();
    lease.release();
  });

  it('caps echo copies by the resolved texture-group budget', () => {
    const entry = createVoiceEntry();
    const engine = createStubEngine({ wet: 1 });
    const lease = entry.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => engine);
    const handle = mountGranularVisual(entry, {
      getVisualSettings: () => ({ texture: { enabled: true, echoCopies: 2 } }),
    });
    entry.worldController.runFrame();

    const [group] = [...entry.worldController.overlays];
    // Full wet asks for 4 echo copies; the constrained settings allow 2.
    engine.emitGrain({ time: 0, positionNorm: 0.5, durationSec: 0.1, pan: 0, pitch: 1 }, 0);
    expect(countWrittenSlots(group)).toBe(2);

    handle.dispose();
    lease.release();
  });

  it('mounts nothing when the texture group is disabled by settings', () => {
    const entry = createVoiceEntry();
    const engine = createStubEngine({ wet: 1 });
    const lease = entry.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => engine);
    const handle = mountGranularVisual(entry, {
      getVisualSettings: () => ({ texture: { enabled: false, echoCopies: 2 } }),
    });

    expect(entry.worldController.overlays.size).toBe(0);

    handle.dispose();
    lease.release();
  });

  it('drops every layer to single particles when more than 2 disks are visible', () => {
    const mounted = [];
    for (let i = 0; i < 3; i += 1) {
      const entry = createVoiceEntry();
      const engine = createStubEngine({ wet: 1 });
      const lease = entry.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => engine);
      const handle = mountGranularVisual(entry);
      // Live particles are what makes a disk count against the shared budget.
      engine.emitGrain({ time: 0, positionNorm: 0.5, durationSec: 0.1, pan: 0, pitch: 1 }, 0);
      mounted.push({ entry, engine, lease, handle });
    }
    // Frame 1 flips each disk visible; frame 2 counts it; frame 3 applies the
    // over-threshold cap to every layer's echo budget.
    for (let i = 0; i < 3; i += 1) {
      mounted.forEach(({ entry }) => entry.worldController.runFrame());
    }

    const { entry, engine } = mounted[2];
    const [group] = [...entry.worldController.overlays];
    const before = countWrittenSlots(group);
    engine.emitGrain({ time: 0.05, positionNorm: 0.5, durationSec: 0.1, pan: 0, pitch: 1 }, 0.05);
    expect(countWrittenSlots(group) - before).toBe(1);

    // Tearing two layers down lifts the clamp for the survivor (full wet → 5 copies).
    mounted[0].handle.dispose();
    mounted[1].handle.dispose();
    entry.worldController.runFrame();
    const beforeLift = countWrittenSlots(group);
    engine.emitGrain({ time: 0.1, positionNorm: 0.5, durationSec: 0.1, pan: 0, pitch: 1 }, 0.1);
    expect(countWrittenSlots(group) - beforeLift).toBe(5);

    mounted.forEach(({ handle, lease }) => { handle.dispose(); lease.release(); });
  });

  it('a stopped voice with a hot knob (wet > 0, no grains) never clamps its siblings', () => {
    const idle = createVoiceEntry();
    const idleEngine = createStubEngine({ wet: 1 }); // knob up, transport stopped — no spawns
    const idleLease = idle.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => idleEngine);
    const idleHandle = mountGranularVisual(idle);
    for (let i = 0; i < 3; i += 1) idle.worldController.runFrame();

    const active = createVoiceEntry();
    const activeEngine = createStubEngine({ wet: 1 });
    const activeLease = active.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => activeEngine);
    const activeHandle = mountGranularVisual(active);
    active.worldController.runFrame();

    const [group] = [...active.worldController.overlays];
    activeEngine.emitGrain({ time: 0, positionNorm: 0.5, durationSec: 0.1, pan: 0, pitch: 1 }, 0);
    // The idle disk never became visible, so the active one keeps its full budget.
    expect(countWrittenSlots(group)).toBe(5);

    idleHandle.dispose(); idleLease.release();
    activeHandle.dispose(); activeLease.release();
  });

  it('dispose unsubscribes the observer and tears down a mounted layer', () => {
    const entry = createVoiceEntry();
    const engine = createStubEngine();
    const lease = entry.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => engine);
    const handle = mountGranularVisual(entry);
    expect(entry.worldController.overlays.size).toBe(1);

    handle.dispose();
    expect(entry.worldController.overlays.size).toBe(0);
    expect(entry.worldController.callbacks.size).toBe(0);
    expect(engine.listeners.size).toBe(0);

    // After dispose the bridge is inert: a fresh engine mounts nothing.
    lease.release();
    const again = entry.audioEngine.acquireSourceEngine(GRANULAR_ENGINE_ID, () => createStubEngine());
    expect(entry.worldController.overlays.size).toBe(0);
    again.release();
    // Double dispose is inert.
    expect(() => handle.dispose()).not.toThrow();
  });
});
