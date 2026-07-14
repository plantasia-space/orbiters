// @vitest-environment node
/**
 * Headless coverage of the accretion disk layer (the granular texture's
 * visual): grain spawns write into the pooled attribute ring buffer (no
 * geometry growth), echo copies track intensity and honor the host's cap,
 * scheduled-ahead grain times are aligned onto the layer clock, the disk
 * hides itself once the last particle's envelope closes, and dispose releases
 * the GPU resources exactly once.
 *
 * Note: three's `BufferAttribute.needsUpdate` is a write-only setter that
 * bumps `.version`, so upload intent is observed via `.version` increments.
 */
import { describe, it, expect } from 'vitest';
import { createGranularDiskLayer } from '../../src/visual/granularDiskLayer.js';

const SPAWN = Object.freeze({
  time: 0,
  positionSec: 2,
  positionNorm: 0.25,
  durationSec: 0.1,
  pan: 0.5,
  pitch: 1.5,
  reversed: true,
});

function attr(layer, name) {
  return layer.group.children[0].geometry.getAttribute(name);
}

describe('granular disk layer — spawn writes', () => {
  it('writes the grain into the ring buffer with the visual seam mappings', () => {
    const layer = createGranularDiskLayer({ radius: 1 });
    layer.setEchoCap(1);
    layer.update(1, 0.016);
    const births = attr(layer, 'aBirth');
    const poolSize = births.array.length;
    const versionBefore = births.version;

    layer.onGrain({ ...SPAWN, time: 1.05 }, 1);
    expect(births.version).toBe(versionBefore + 1);
    expect(births.array[0]).toBeCloseTo(1.05, 5);
    expect(attr(layer, 'aLife').array[0]).toBeCloseTo(0.24, 5);
    expect(attr(layer, 'aAngle').array[0]).toBeCloseTo(0.25 * Math.PI * 2, 5);
    expect(attr(layer, 'aPan').array[0]).toBeCloseTo(0.5, 5);
    expect(attr(layer, 'aPitch').array[0]).toBeCloseTo(1.5, 5);
    expect(attr(layer, 'aReversed').array[0]).toBe(1);
    // Slot 1 untouched — one grain, one particle at echo cap 1.
    expect(births.array[1]).toBe(-1e3);
    expect(births.array.length).toBe(poolSize);
    layer.dispose();
  });

  it('aligns scheduled-ahead grain times onto the layer clock', () => {
    const layer = createGranularDiskLayer({ radius: 1 });
    layer.update(10, 0.016);
    // Audio clock at 100, grain scheduled 0.08 ahead → births 0.08 after layer-now.
    layer.onGrain({ ...SPAWN, time: 100.08 }, 100);
    expect(attr(layer, 'aBirth').array[0]).toBeCloseTo(10.08, 5);
    layer.dispose();
  });

  it('wraps the pool cursor instead of growing the geometry', () => {
    const layer = createGranularDiskLayer({ radius: 1 });
    layer.setEchoCap(1);
    layer.update(1, 0.016);
    const births = attr(layer, 'aBirth');
    const poolSize = births.array.length;
    for (let i = 0; i < poolSize + 3; i += 1) {
      layer.onGrain({ ...SPAWN, time: 1 + i * 0.01 }, 1);
    }
    expect(births.array.length).toBe(poolSize);
    // The cursor wrapped: slot 0 now holds a recent grain, not the first one.
    expect(births.array[0]).toBeCloseTo(1 + poolSize * 0.01, 5);
    layer.dispose();
  });
});

describe('granular disk layer — echo copies', () => {
  function countWrittenSlots(layer) {
    const births = attr(layer, 'aBirth').array;
    let written = 0;
    for (let i = 0; i < births.length; i += 1) {
      if (births[i] !== -1e3) written += 1;
    }
    return written;
  }

  it('spawns 2 particles at low wet and 5 at full wet', () => {
    const low = createGranularDiskLayer({ radius: 1 });
    low.update(1, 0.016);
    low.setEngineParams({ wet: 0 });
    low.onGrain({ ...SPAWN, time: 1 }, 1);
    expect(countWrittenSlots(low)).toBe(2);
    low.dispose();

    const high = createGranularDiskLayer({ radius: 1 });
    high.update(1, 0.016);
    high.setEngineParams({ wet: 1 });
    high.onGrain({ ...SPAWN, time: 1 }, 1);
    expect(countWrittenSlots(high)).toBe(5);
    high.dispose();
  });

  it('honors the host echo cap', () => {
    const layer = createGranularDiskLayer({ radius: 1 });
    layer.update(1, 0.016);
    layer.setEngineParams({ wet: 1 });
    layer.setEchoCap(2);
    layer.onGrain({ ...SPAWN, time: 1 }, 1);
    expect(countWrittenSlots(layer)).toBe(2);
    layer.dispose();
  });
});

describe('granular disk layer — visibility + params', () => {
  it('hides until the first grain, shows while envelopes are open, hides after the tails drain', () => {
    const layer = createGranularDiskLayer({ radius: 1 });
    layer.update(1, 0.016);
    expect(layer.group.visible).toBe(false);

    layer.onGrain({ ...SPAWN, time: 1, durationSec: 0.1 }, 1); // life = 0.16s
    layer.update(1.05, 0.016);
    expect(layer.group.visible).toBe(true);

    layer.update(1.5, 0.016);
    expect(layer.group.visible).toBe(false);
    layer.dispose();
  });

  it('wet drives intensity and disk precession; the precession clock only runs while visible', () => {
    const layer = createGranularDiskLayer({ radius: 1 });
    const material = layer.group.children[0].material;
    layer.setEngineParams({ wet: 0.5 });
    expect(material.uniforms.uIntensity.value).toBeCloseTo(0.5, 5);
    layer.setEngineParams({ wet: 2 });
    expect(material.uniforms.uIntensity.value).toBe(1);
    // A params object without a numeric wet leaves the intensity untouched.
    layer.setEngineParams(null);
    layer.setEngineParams({});
    expect(material.uniforms.uIntensity.value).toBe(1);

    // Invisible (no grains): no precession.
    layer.update(1, 0.016);
    expect(layer.group.rotation.y).toBe(0);

    layer.onGrain({ ...SPAWN, time: 1, durationSec: 0.3 }, 1);
    layer.update(1.1, 0.1);
    expect(layer.group.rotation.y).toBeCloseTo(0.1 * 1 * 0.2, 5);
    layer.dispose();
  });

  it('scales the group to the host radius', () => {
    const layer = createGranularDiskLayer({ radius: 0.5 });
    expect(layer.group.scale.x).toBeCloseTo(0.5, 5);
    layer.dispose();
  });

  it('derives the pitch palette from the host base color, hue-deviated each way', () => {
    const layer = createGranularDiskLayer({ radius: 1 });
    const { uLowColor, uHighColor } = layer.group.children[0].material.uniforms;
    const base = { r: 1, g: 0, b: 0 }; // pure red

    layer.setBaseColor(base);
    const lowHsl = uLowColor.value.getHSL({});
    const highHsl = uHighColor.value.getHSL({});
    // Deviated around the base hue (0), one to each side, neither identical to it.
    expect(lowHsl.h).toBeCloseTo(1 - 0.07, 3);
    expect(highHsl.h).toBeCloseTo(0.07, 3);
    // Lifted for the additive glow.
    expect(highHsl.l).toBeGreaterThan(0.5);

    // Same color again: compare-set, uniforms untouched (no re-derivation).
    const lowBefore = uLowColor.value.clone();
    layer.setBaseColor({ r: 1, g: 0, b: 0 });
    expect(uLowColor.value.equals(lowBefore)).toBe(true);
    layer.dispose();
  });

  it('keeps a visible gradient even for a white base color', () => {
    const layer = createGranularDiskLayer({ radius: 1 });
    const { uLowColor, uHighColor } = layer.group.children[0].material.uniforms;
    layer.setBaseColor({ r: 1, g: 1, b: 1 });
    // Lightness diverges in opposite directions, so the two ends never
    // collapse to the same color under setHSL's clamp.
    expect(uLowColor.value.equals(uHighColor.value)).toBe(false);
    expect(uLowColor.value.getHSL({}).l).toBeLessThan(uHighColor.value.getHSL({}).l);
    layer.dispose();
  });
});

describe('granular disk layer — dispose', () => {
  it('releases geometry + material once and goes inert', () => {
    const layer = createGranularDiskLayer({ radius: 1 });
    const pointsObject = layer.group.children[0];
    let geometryDisposals = 0;
    let materialDisposals = 0;
    pointsObject.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });
    pointsObject.material.addEventListener('dispose', () => { materialDisposals += 1; });

    layer.dispose();
    layer.dispose();
    expect(geometryDisposals).toBe(1);
    expect(materialDisposals).toBe(1);
    expect(layer.group.children.length).toBe(0);

    // Post-dispose calls are inert, not throwing.
    expect(() => {
      layer.onGrain({ ...SPAWN, time: 2 }, 2);
      layer.update(2, 0.016);
      layer.setEngineParams({ wet: 0.5 });
    }).not.toThrow();
  });
});
