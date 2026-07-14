// @vitest-environment jsdom
/**
 * The echoes group's visual layer: measured per-side wet levels blink the
 * moons, delay time eases their orbit distance out, and a world without moons
 * gets summoned ghost moons that grow in with the effect and dissolve with it
 * (real moons always preferred). Dispose must fully release the ghosts and
 * reset the canvas.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEchoesMoonsLayer } from '../../src/visual/echoesMoonsLayer.js';

function createStubCanvas({ exists = true } = {}) {
  return {
    existsValue: exists,
    sync: vi.fn(),
    exists() { return this.existsValue; },
    drive: vi.fn(),
    reset: vi.fn(),
  };
}

describe('echoes moons layer', () => {
  it('drives the world canvas in LIGHT only (enveloped blink, eased orbit factor, no size)', () => {
    const canvas = createStubCanvas();
    const layer = createEchoesMoonsLayer({ canvas });

    layer.update(0, 0.016, { levelL: 0.2, levelR: 0, delaySec: 1, wet: 1 });
    expect(canvas.sync).toHaveBeenCalledWith(0);
    const values = canvas.drive.mock.calls[0][0];
    // The moons never change size — the echo answers in light alone.
    expect(values.popL).toBeUndefined();
    expect(values.popR).toBeUndefined();
    // The blink is an ENVELOPE over the measured level, so it RISES toward the
    // target rather than snapping to it — that is what stopped the twitching.
    expect(values.blinkL).toBeGreaterThan(0);
    expect(values.blinkL).toBeLessThan(0.2 * 16); // …not the raw level, on frame one
    expect(values.blinkR).toBe(0);
    expect(values.radiusFactor).toBeGreaterThan(1); // easing toward 1 + delay·0.85
    expect(values.radiusFactor).toBeLessThan(1.85); // …but not there in one frame

    // The factor keeps easing toward the target across frames.
    for (let i = 0; i < 400; i += 1) {
      layer.update(0.016 * (i + 1), 0.016, { levelL: 0, levelR: 0, delaySec: 1, wet: 1 });
    }
    const settled = canvas.drive.mock.calls.at(-1)[0];
    expect(settled.radiusFactor).toBeCloseTo(1.85, 2);

    layer.dispose();
    expect(canvas.reset).toHaveBeenCalled();
  });

  it('reads as invisible at bypass: wet 0 zeroes the blinks even with meter level', () => {
    const canvas = createStubCanvas();
    const layer = createEchoesMoonsLayer({ canvas });
    layer.update(0, 0.016, { levelL: 0.9, levelR: 0.9, delaySec: 0.3, wet: 0 });
    const values = canvas.drive.mock.calls[0][0];
    expect(values.blinkL).toBe(0);
    expect(values.blinkR).toBe(0);
    layer.dispose();
  });

  it('summons ghost moons for a world without moons, grows them in, and blinks per side', () => {
    const layer = createEchoesMoonsLayer({ canvas: createStubCanvas({ exists: false }) });

    layer.update(0, 0.016, { levelL: 0.3, levelR: 0, delaySec: 0.3, wet: 1 });
    expect(layer.group.children.length).toBe(4);
    expect(layer.group.visible).toBe(true);
    // Ghosts are born at first update — still growing in (scale ≈ 0).
    expect(layer.group.children[0].scale.x).toBeLessThan(0.1);

    // Past the grow-in window they reach full size and answer their side. The
    // blink is enveloped, so it climbs to the cap over a few frames rather than
    // snapping there — the same smoothing the real moons get.
    for (let i = 0; i < 90; i += 1) {
      layer.update(2 + 0.016 * i, 0.016, { levelL: 0.3, levelR: 0, delaySec: 0.3, wet: 1 });
    }
    const [leftGhost, rightGhost] = layer.group.children;
    expect(leftGhost.material.emissiveIntensity).toBeCloseTo(4, 1); // 0.3 × 16, capped at MAX_BLINK 4
    expect(rightGhost.material.emissiveIntensity).toBe(0);
    // Grown in to full size — and it STAYS there: the echo never resizes a moon.
    expect(leftGhost.scale.x).toBeCloseTo(1, 5);
    // Ghostly, translucent stand-ins — distinguishable from real features.
    expect(leftGhost.material.transparent).toBe(true);
    expect(leftGhost.material.opacity).toBeLessThan(1);

    layer.dispose();
    expect(layer.group.children.length).toBe(0);
  });

  it('sizes the ghost pool from the resolved quality setting', () => {
    const layer = createEchoesMoonsLayer({
      canvas: createStubCanvas({ exists: false }),
      summonedMoonCount: 2,
    });
    layer.update(0, 0.016, { levelL: 0, levelR: 0, delaySec: 0.3, wet: 1 });
    expect(layer.group.children.length).toBe(2);
    layer.dispose();
  });

  it('prefers real moons the moment they exist: ghosts dissolve, canvas takes over', () => {
    const canvas = createStubCanvas({ exists: false });
    const layer = createEchoesMoonsLayer({ canvas });
    const disposeSpies = [];

    layer.update(0, 0.016, { levelL: 0, levelR: 0, delaySec: 0.3, wet: 1 });
    expect(layer.group.children.length).toBe(4);
    layer.group.children.forEach((ghost) => {
      disposeSpies.push(vi.spyOn(ghost.geometry, 'dispose'), vi.spyOn(ghost.material, 'dispose'));
    });

    canvas.existsValue = true;
    layer.update(0.016, 0.016, { levelL: 0, levelR: 0, delaySec: 0.3, wet: 1 });
    expect(layer.group.children.length).toBe(0);
    expect(layer.group.visible).toBe(false);
    disposeSpies.forEach((spy) => expect(spy).toHaveBeenCalled());
    expect(canvas.drive).toHaveBeenCalled();

    layer.dispose();
  });
});
