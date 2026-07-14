// @vitest-environment jsdom
/**
 * Ring oscilloscope per-frame cost.
 *
 * The ring is a single flat color, yet `draw()` rewrote the whole color buffer + re-uploaded it every
 * frame (×N voices). These pin: (1) the color buffer is only rewritten + flagged for GPU upload when
 * the color actually changes (positions still update every frame), and (2) a LOW/mobile profile can
 * shrink the segment count, rebuilding the geometry at the smaller size.
 *
 * Note: three's `BufferAttribute.needsUpdate` is a write-only setter that bumps `.version`, so upload
 * intent is observed via `.version` increments, not by reading `needsUpdate`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { RingOscilloscope } from '../../src/world/Ring.js';

// draw() only does work on even frame counters (it throttles %2), so pump two calls per "real" draw.
function pumpDraw(osc, amplitude = 0.5) {
  osc.draw(amplitude); // odd counter — early return
  osc.draw(amplitude); // even counter — does the work
}

describe('RingOscilloscope — draw() color-skip + profile segments', () => {
  let scene;
  let osc;
  const colorVer = () => osc.orbitGeometry.attributes.color.version;
  const posVer = () => osc.orbitGeometry.attributes.position.version;

  beforeEach(() => {
    scene = new THREE.Scene();
    osc = new RingOscilloscope({ orbitSegments: 256 });
    osc.setRequirePlaybackState(false); // don't gate on playback state in the test
    osc.ensureOverlay(scene);
  });

  it('re-uploads the color buffer only when the color changes; positions always upload', () => {
    // First real draw: color is "new" (tracker starts NaN) -> writes color + bumps its version.
    let c0 = colorVer();
    let p0 = posVer();
    pumpDraw(osc);
    expect(colorVer()).toBeGreaterThan(c0);
    expect(posVer()).toBeGreaterThan(p0);

    // Second real draw, same color: color version unchanged, positions still bump.
    c0 = colorVer();
    p0 = posVer();
    pumpDraw(osc, 0.9);
    expect(colorVer()).toBe(c0);
    expect(posVer()).toBeGreaterThan(p0);

    // Change the color -> the next real draw rewrites the color buffer.
    c0 = colorVer();
    osc.customColor = new THREE.Color(1, 0, 0);
    pumpDraw(osc);
    expect(colorVer()).toBeGreaterThan(c0);
    const colors = osc.orbitGeometry.attributes.color.array;
    expect(colors[0]).toBe(1); // r
    expect(colors[1]).toBe(0); // g
    expect(colors[2]).toBe(0); // b
  });

  it('setPerformanceProfile shrinks the segment count and rebuilds the geometry (LOW/mobile)', () => {
    expect(osc.orbitGeometry.attributes.position.count).toBe(256);

    osc.setPerformanceProfile({ ringOrbitSegments: 128 });
    expect(osc.orbitSegments).toBe(128);
    expect(osc.orbitGeometry.attributes.position.count).toBe(128);

    // Clearing the override restores the constructor default.
    osc.setPerformanceProfile({});
    expect(osc.orbitSegments).toBe(256);
    expect(osc.orbitGeometry.attributes.position.count).toBe(256);
  });

  it('shrinking segments caps ampHistory by dropping the OLDEST samples (keeps most recent)', () => {
    // ampHistory index 0 is oldest; push appends newest. Seed 0..255 (255 = newest).
    osc.ampHistory = Array.from({ length: 256 }, (_v, i) => i);
    osc.setPerformanceProfile({ ringOrbitSegments: 128 });
    expect(osc.ampHistory.length).toBe(128);
    expect(osc.ampHistory[0]).toBe(128); // oldest 128 dropped
    expect(osc.ampHistory[127]).toBe(255); // newest retained
  });

  it('a rebuilt geometry re-writes the color on the next draw (fresh buffer starts zeroed)', () => {
    pumpDraw(osc);

    // Shrinking rebuilds resources with a zeroed color buffer -> color must be re-written.
    osc.setPerformanceProfile({ ringOrbitSegments: 128 });
    const c0 = colorVer();
    pumpDraw(osc);
    expect(colorVer()).toBeGreaterThan(c0);
  });
});
