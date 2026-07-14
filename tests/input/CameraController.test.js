// @vitest-environment jsdom
/**
 * CameraController render-loop cost.
 *
 * `_onTick` runs every frame. With no listeners the snapshot is discarded, so it must skip the whole
 * read (guard-first) — otherwise `_readVelocities` allocates + runs trig every frame for nothing.
 * These pin: (1) the guard skips the snapshot when there are no listeners, (2) the fallback velocity
 * read reuses instance scratch (no per-frame Vector3/Spherical churn), and (3) adding the first
 * listener re-baselines `_last` so the first post-attach tick reports a zero delta (no velocity spike).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../../src/input/CameraController.js';

function fakeWorld() {
  return {
    renderer: { domElement: document.createElement('canvas') },
    controls: { target: new THREE.Vector3(0, 0, 0) },
    camera: { position: new THREE.Vector3(1, 2, 3) },
    addRenderCallback: vi.fn(),
    removeRenderCallback: vi.fn(),
  };
}

describe('CameraController — per-frame guard + scratch pool', () => {
  let world;
  beforeEach(() => {
    world = fakeWorld();
  });

  it('_onTick skips the snapshot entirely when there are no listeners', () => {
    const cc = new CameraController(world, null);
    const snap = vi.spyOn(cc, 'getSnapshot');

    cc._onTick();
    expect(snap).not.toHaveBeenCalled();

    const fn = vi.fn();
    cc.onUpdate(fn);
    cc._onTick();
    expect(snap).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
    cc.dispose();
  });

  it('reuses the same scratch Vector3/Spherical across velocity reads (no per-frame alloc)', () => {
    const cc = new CameraController(world, null);
    cc.onUpdate(() => {});

    const offset = cc._scratch.offset;
    const spherical = cc._scratch.spherical;
    cc.getSnapshot();
    cc.getSnapshot();
    expect(cc._scratch.offset).toBe(offset);
    expect(cc._scratch.spherical).toBe(spherical);
    cc.dispose();
  });

  it('re-baselines _last when the first listener attaches so the first tick reports zero velocity', () => {
    const cc = new CameraController(world, null);
    // Simulate a stale pose left over from a previous listener session.
    cc._last.az = 5;
    cc._last.polar = 5;
    cc._last.dist = 99;

    cc.onUpdate(() => {}); // empty -> non-empty transition re-baselines
    expect(cc._last.az).toBeNull();
    expect(cc._last.polar).toBeNull();
    expect(cc._last.dist).toBeNull();

    const snap = cc.getSnapshot();
    expect(snap.velocities.azimuth).toBe(0);
    expect(snap.velocities.polar).toBe(0);
    expect(snap.velocities.dolly).toBe(0);
    cc.dispose();
  });

  it('does NOT re-baseline when a second listener is added (a session is already active)', () => {
    const cc = new CameraController(world, null);
    cc.onUpdate(() => {});
    cc.getSnapshot(); // populate _last with a real pose
    cc._last.az = 1.23;

    cc.onUpdate(() => {}); // second listener — must not reset
    expect(cc._last.az).toBe(1.23);
    cc.dispose();
  });
});
