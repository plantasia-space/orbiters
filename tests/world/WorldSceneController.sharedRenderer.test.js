// @vitest-environment jsdom
/**
 * WorldSceneController `sharedRenderer` mode (the multi-orbiter compositor seam).
 *
 * Single-orbiter (no sharedRenderer) constructs a real THREE.WebGLRenderer, which jsdom can't back, so
 * that path is browser-verified. This pins the SHARED path (renderer injected, no WebGL): the controller
 * borrows the renderer, never owns the loop / resize / window globals, and never disposes what it borrowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorldSceneController } from '../../src/world/WorldSceneController.js';

function fakeSharedRenderer() {
  return {
    domElement: document.createElement('canvas'),
    setViewport: vi.fn(),
    setScissor: vi.fn(),
    setScissorTest: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

let canvas;
beforeEach(() => {
  canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
});
afterEach(() => {
  delete window.__EW_RENDERER;
  delete window.__orbitersSetViewportInset;
  delete window.__orbitersFrameStats;
  canvas.remove();
});

describe('WorldSceneController — sharedRenderer mode', () => {
  it('borrows the renderer and installs NONE of the single-orbiter realm globals', () => {
    const shared = fakeSharedRenderer();
    const c = new WorldSceneController(canvas, { sharedRenderer: shared });

    expect(c.renderer).toBe(shared);
    expect(c._ownsRenderer).toBe(false);
    // The compositor owns these — a borrowed-renderer voice must not touch them.
    expect(window.__EW_RENDERER).toBeUndefined();
    expect(window.__orbitersSetViewportInset).toBeUndefined();
    expect(window.__orbitersFrameStats).toBeUndefined();
    c.dispose();
  });

  it('renderViewport runs the per-frame callbacks then scissor-renders this voice into the rect', () => {
    const shared = fakeSharedRenderer();
    const c = new WorldSceneController(canvas, { sharedRenderer: shared });
    const cb = vi.fn();
    c.addRenderCallback(cb);

    const rect = { x: 10, y: 20, width: 300, height: 400 };
    c.renderViewport(rect);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(shared.setViewport).toHaveBeenCalledWith(10, 20, 300, 400);
    expect(shared.setScissor).toHaveBeenCalledWith(10, 20, 300, 400);
    expect(shared.setScissorTest).toHaveBeenCalledWith(true);
    expect(shared.render).toHaveBeenCalledWith(c.scene, c.camera);
    c.dispose();
  });

  it('renderViewport is a no-op while paused (setRenderActive(false)) or disposed', () => {
    const shared = fakeSharedRenderer();
    const c = new WorldSceneController(canvas, { sharedRenderer: shared });

    c.setRenderActive(false); // shared mode: flips the flag, no rAF to cancel
    expect(c.renderActive).toBe(false);
    c.renderViewport({ x: 0, y: 0, width: 100, height: 100 });
    expect(shared.render).not.toHaveBeenCalled();

    c.setRenderActive(true);
    c.renderViewport({ x: 0, y: 0, width: 100, height: 100 });
    expect(shared.render).toHaveBeenCalledTimes(1);

    c.dispose();
    c.renderViewport({ x: 0, y: 0, width: 100, height: 100 });
    expect(shared.render).toHaveBeenCalledTimes(1); // still once — disposed is inert
  });

  it('passes the frame clock to callbacks: reused object, clamped dt, reset on pause', () => {
    const shared = fakeSharedRenderer();
    const c = new WorldSceneController(canvas, { sharedRenderer: shared });
    const frames = [];
    // Retaining the object across frames is exactly what callers must NOT do —
    // this test does it deliberately to pin the reuse contract.
    c.addRenderCallback((frame) => frames.push({ ref: frame, nowSec: frame.nowSec, dtSec: frame.dtSec }));

    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1000);
    c.renderViewport({ x: 0, y: 0, width: 100, height: 100 });
    nowSpy.mockReturnValue(1016);
    c.renderViewport({ x: 0, y: 0, width: 100, height: 100 });
    // A 2s gap (backgrounded tab) is clamped to 0.5s.
    nowSpy.mockReturnValue(3016);
    c.renderViewport({ x: 0, y: 0, width: 100, height: 100 });

    expect(frames[0].dtSec).toBe(0); // first frame has no predecessor
    expect(frames[0].nowSec).toBeCloseTo(1, 6);
    expect(frames[1].dtSec).toBeCloseTo(0.016, 6);
    expect(frames[2].dtSec).toBe(0.5);
    // One reused object — no per-frame allocation.
    expect(frames[1].ref).toBe(frames[0].ref);

    // Pause resets the clock: the first resumed frame reports dt 0, not the pause.
    c.setRenderActive(false);
    c.setRenderActive(true);
    nowSpy.mockReturnValue(9000);
    c.renderViewport({ x: 0, y: 0, width: 100, height: 100 });
    expect(frames[3].dtSec).toBe(0);

    nowSpy.mockRestore();
    c.dispose();
  });

  it('setViewportSize re-aspects the camera to the cell', () => {
    const shared = fakeSharedRenderer();
    const c = new WorldSceneController(canvas, { sharedRenderer: shared });
    c.setViewportSize(800, 400);
    expect(c.camera.aspect).toBeCloseTo(2);
    c.dispose();
  });

  it('dispose does NOT dispose the borrowed renderer (the compositor owns it)', () => {
    const shared = fakeSharedRenderer();
    const c = new WorldSceneController(canvas, { sharedRenderer: shared });
    c.dispose();
    expect(shared.dispose).not.toHaveBeenCalled();
  });
});
