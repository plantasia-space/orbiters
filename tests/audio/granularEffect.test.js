// @vitest-environment node
/**
 * The granular rack effect: manifest contract (bipolar ±100 with center
 * bypass, symmetric dry/wet law, prebuffer-required, mappings target real
 * engine params), piecewise segment mapping, module switching within a slot,
 * and the shared-engine lifecycle across slots (one engine per voice via the
 * adapter's source-engine host, refcounted teardown).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EFFECT_MANIFEST } from '../../src/audio/effects/granular/v1/manifest.js';
import {
  createGranularEffect,
  mapModuleValueToEngineParams,
} from '../../src/audio/effects/granular/v1/factory.js';
import { GRANULAR_PARAM_DEFAULTS, GRANULAR_ENGINE_ID } from '../../src/audio/granular/GranularEngine.js';
import { createSourceEngineHost } from '../../src/audio/sourceEngineHost.js';

function createFakeParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; },
    setTargetAtTime(value) { this.value = value; },
    cancelScheduledValues() {},
  };
}

function createFakeContext() {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => ({ gain: createFakeParam(1), connect: vi.fn(), disconnect: vi.fn() }),
    createStereoPanner: () => ({ pan: createFakeParam(0), connect: vi.fn(), disconnect: vi.fn() }),
    createBufferSource: () => ({
      buffer: null,
      playbackRate: createFakeParam(1),
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
    }),
    createBuffer: (channels, frames, rate) => ({
      numberOfChannels: channels,
      length: frames,
      sampleRate: rate,
      duration: frames / rate,
      getChannelData: () => new Float32Array(frames),
    }),
  };
}

function createStubTone() {
  class Gain {
    constructor(value) {
      this.gain = { value };
    }

    connect() {}

    dispose() {
      this.disposed = true;
    }
  }
  return { Gain };
}

/** The adapter surface the factory sees: a real source-engine host wired to a
 *  fake graph (the factory itself carries no construction knowledge). */
function createStubController(rawContext) {
  const connect = vi.fn();
  const host = createSourceEngineHost({
    getContext: () => rawContext,
    getMixBus: () => ({ name: 'normalizationGain' }),
    connect,
    getBuffer: () => null,
    getPositionMs: () => 0,
    isPlaying: () => false,
    setDryLevel: vi.fn(),
  });
  return {
    connect,
    acquireSourceEngine: (id, build) => host.acquire(id, build),
    peekSourceEngine: (id) => host.peek(id),
  };
}

/** The engine a controller's modules share — read via the host's observation
 *  seam, which never creates or refcounts. */
function peekEngine(controller) {
  return controller.peekSourceEngine(GRANULAR_ENGINE_ID);
}

describe('granular manifest contract', () => {
  it('declares six bipolar modules, all prebuffer-required', () => {
    expect(EFFECT_MANIFEST.modules.length).toBe(6);
    EFFECT_MANIFEST.modules.forEach((module) => {
      expect(module.engineRequirement).toBe('prebuffer-required');
      expect(module.valueRange).toMatchObject({ min: -100, max: 100, equilibrium: 0 });
      expect(module.initialRange.equilibrium).toBe(0);
      expect(module.segments.negative).toBeTruthy();
      expect(module.segments.positive).toBeTruthy();
    });
  });

  it('center is full bypass and extremes fully replace the dry signal', () => {
    EFFECT_MANIFEST.modules.forEach((module) => {
      const negative = module.segments.negative.parameterMappings;
      const positive = module.segments.positive.parameterMappings;
      // Negative mappings are inverted: `max` is the center, `min` the -100 extreme.
      expect(negative.wet.max).toBe(0);
      expect(negative.dryLevel.max).toBe(1);
      expect(negative.wet.min).toBe(1);
      expect(negative.dryLevel.min).toBe(0);
      expect(positive.wet.min).toBe(0);
      expect(positive.dryLevel.min).toBe(1);
      expect(positive.wet.max).toBe(1);
      expect(positive.dryLevel.max).toBe(0);
    });
  });

  it('every parameter is continuous through the center (negative.max === positive.min)', () => {
    EFFECT_MANIFEST.modules.forEach((module) => {
      const negative = module.segments.negative.parameterMappings;
      const positive = module.segments.positive.parameterMappings;
      Object.keys(negative).forEach((param) => {
        // Negative mappings are inverted, so its `max` is the center value —
        // it must meet the positive segment's `min` or the texture jumps
        // discontinuously as the knob crosses center.
        expect(negative[param].max, `${module.id}.${param}`).toBe(positive[param].min);
      });
    });
  });

  it('both segments map the same, real engine parameters', () => {
    EFFECT_MANIFEST.modules.forEach((module) => {
      const negativeKeys = Object.keys(module.segments.negative.parameterMappings).sort();
      const positiveKeys = Object.keys(module.segments.positive.parameterMappings).sort();
      // Symmetric key sets: crossing the center can never leave one side's
      // params stale on the shared engine.
      expect(negativeKeys).toEqual(positiveKeys);
      negativeKeys.forEach((param) => {
        expect(param in GRANULAR_PARAM_DEFAULTS).toBe(true);
      });
    });
  });
});

describe('mapModuleValueToEngineParams', () => {
  const cloud = EFFECT_MANIFEST.modules.find((module) => module.id === 'cloud');

  it('maps the center to bypass', () => {
    const params = mapModuleValueToEngineParams(cloud, 0);
    expect(params.wet).toBe(0);
    expect(params.dryLevel).toBe(1);
  });

  it('maps the positive extreme through the positive segment', () => {
    const params = mapModuleValueToEngineParams(cloud, 100);
    expect(params.wet).toBe(1);
    expect(params.dryLevel).toBe(0);
    expect(params.density).toBeCloseTo(40, 5);
    expect(params.panSpread).toBeCloseTo(1, 5);
    expect(params.grainSize).toBeCloseTo(0.08, 5);
  });

  it('maps the negative extreme through the inverted negative segment', () => {
    const params = mapModuleValueToEngineParams(cloud, -100);
    expect(params.wet).toBe(1);
    expect(params.dryLevel).toBe(0);
    expect(params.density).toBeCloseTo(8, 5);
    expect(params.grainSize).toBeCloseTo(0.35, 5);
  });

  it('is proportional inside a segment (half turn = half wet)', () => {
    expect(mapModuleValueToEngineParams(cloud, 50).wet).toBeCloseTo(0.5, 5);
    expect(mapModuleValueToEngineParams(cloud, -50).wet).toBeCloseTo(0.5, 5);
  });

  it('clamps values outside the range', () => {
    expect(mapModuleValueToEngineParams(cloud, 250).wet).toBe(1);
    expect(mapModuleValueToEngineParams(cloud, -250).wet).toBe(1);
  });
});

describe('granular effect factory', () => {
  let Tone;
  let controller;

  beforeEach(() => {
    Tone = createStubTone();
    controller = createStubController(createFakeContext());
  });

  function createEffect() {
    return createGranularEffect({ Tone, settings: { playbackController: controller } });
  }

  it('drives the engine through the active module and bypasses back at center', () => {
    const effect = createEffect();
    const cloud = effect.modules.find((module) => module.id === 'cloud');
    cloud.applyValue(100);

    const engine = peekEngine(controller);
    expect(engine).toBeTruthy();
    const params = engine.getParams();
    expect(params.wet).toBe(1);
    expect(params.dryLevel).toBe(0);
    // density 40 × grainSize 0.08 sits inside the overlap budget — no clamp.
    expect(params.density).toBeCloseTo(40, 5);
    expect(controller.connect).toHaveBeenCalledTimes(1);

    cloud.applyValue(0);
    expect(engine.getParams().wet).toBe(0);
    expect(engine.getParams().dryLevel).toBe(1);
    effect.dispose();
  });

  it('switching modules within the slot clears the previous module\'s params', () => {
    const effect = createEffect();
    effect.modules.find((module) => module.id === 'cloud').applyValue(100);
    const engine = peekEngine(controller);
    expect(engine.getParams().panSpread).toBeCloseTo(1, 5);

    effect.configureModule('shimmer');
    effect.modules.find((module) => module.id === 'shimmer').applyValue(50);
    const params = engine.getParams();
    expect(params.panSpread).toBe(GRANULAR_PARAM_DEFAULTS.panSpread);
    expect(params.grainPitch).toBeCloseTo(1.5, 5);
    effect.dispose();
  });

  it('inactive modules ignore applyValue', () => {
    const effect = createEffect();
    const shimmer = effect.modules.find((module) => module.id === 'shimmer');
    shimmer.applyValue(80);
    const engine = peekEngine(controller);
    expect(engine.getParams().grainPitch).toBe(GRANULAR_PARAM_DEFAULTS.grainPitch);
    effect.dispose();
  });

  it('two slots share one engine, each driving its own parameter subset', () => {
    const slotX = createEffect();
    const slotY = createEffect();
    slotY.configureModule('shimmer');

    slotX.modules.find((module) => module.id === 'cloud').applyValue(50);
    slotY.modules.find((module) => module.id === 'shimmer').applyValue(100);

    expect(controller.connect).toHaveBeenCalledTimes(1);
    const engine = peekEngine(controller);
    const params = engine.getParams();
    // wet resolves as max, dryLevel as min across modules.
    expect(params.wet).toBe(1);
    expect(params.dryLevel).toBe(0);
    expect(params.panSpread).toBeCloseTo(0.6, 5);
    expect(params.grainPitch).toBeCloseTo(2, 5);

    // Dropping one slot keeps the shared engine alive for the other.
    slotY.dispose();
    expect(peekEngine(controller)).toBe(engine);
    expect(engine.getParams().grainPitch).toBe(GRANULAR_PARAM_DEFAULTS.grainPitch);
    expect(engine.getParams().wet).toBeCloseTo(0.5, 5);

    // Last slot out tears the engine down.
    slotX.dispose();
    expect(peekEngine(controller)).toBeNull();
  });

  it('stays inert without a playback controller', () => {
    const effect = createGranularEffect({ Tone, settings: {} });
    expect(() => effect.modules[0].applyValue(80)).not.toThrow();
    effect.dispose();
  });
});
