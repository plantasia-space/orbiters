// @vitest-environment jsdom
/**
 * The ViewportCompositor's browser-fullscreen ownership for a voice.
 *
 * The shared canvas lives on <body> (fixed, inset:0) and scissor-renders every cell. When a voice's
 * cell enters browser fullscreen, the fullscreen "top layer" hides the body-level canvas, so the
 * compositor must reparent the ONE canvas INTO the fullscreened cell (behind its chrome) and solo-render
 * that voice — then restore both on exit. This test drives that DOM contract with `three` mocked out
 * (no real WebGL context needed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('three', () => {
  class WebGLRenderer {
    constructor() {
      this.domElement = null;
    }
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    setScissorTest() {}
    setViewport() {}
    setScissor() {}
    clear() {}
    dispose() {}
  }
  return { WebGLRenderer, SRGBColorSpace: 'srgb' };
});

import { createViewportCompositor } from '../../src/multi/renderHost.js';

/** Force a non-zero on-screen box so renderOnce doesn't cull the cell (jsdom returns all-zero rects). */
function stubRect(el, box) {
  el.getBoundingClientRect = () => ({
    left: box.left, top: box.top, right: box.right, bottom: box.bottom,
    width: box.right - box.left, height: box.bottom - box.top, x: box.left, y: box.top,
  });
}

/** A minimal voice controller the compositor's render loop is happy to draw. */
function fakeController() {
  return {
    renderActive: true,
    setViewportSize: vi.fn(),
    renderViewport: vi.fn(),
  };
}

function fireFullscreenChange() {
  document.dispatchEvent(new Event('fullscreenchange'));
}

function setFullscreenElement(el) {
  Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true });
}

describe('ViewportCompositor fullscreen ownership', () => {
  let compositor;

  beforeEach(() => {
    setFullscreenElement(null);
  });

  afterEach(() => {
    compositor?.dispose();
    compositor = null;
    document.body.innerHTML = '';
  });

  it('reparents the shared canvas into the fullscreened cell and restores it on exit', () => {
    compositor = createViewportCompositor();
    const cellA = compositor.createCell(0, 2);
    const cellB = compositor.createCell(1, 2);
    compositor.addVoice({ voiceId: 'A', cell: cellA, controller: fakeController() });
    compositor.addVoice({ voiceId: 'B', cell: cellB, controller: fakeController() });

    const { canvas } = compositor;
    expect(canvas.parentNode).toBe(document.body);
    const homeCss = canvas.style.cssText;

    // Enter fullscreen on cell A.
    setFullscreenElement(cellA);
    fireFullscreenChange();
    expect(canvas.parentNode).toBe(cellA); // canvas moved into the fullscreened cell (top layer)
    expect(canvas.style.zIndex).toBe('0'); // and dropped behind the cell's chrome
    expect(cellA.firstChild).toBe(canvas); // inserted first so later chrome paints above it

    // Exit fullscreen.
    setFullscreenElement(null);
    fireFullscreenChange();
    expect(canvas.parentNode).toBe(document.body); // restored to its realm home
    expect(canvas.style.cssText).toBe(homeCss); // original inline styles (incl. z-index:40) restored
  });

  it('renders ONLY the fullscreen voice while one cell is fullscreen, all voices otherwise', () => {
    compositor = createViewportCompositor();
    const cellA = compositor.createCell(0, 2);
    const cellB = compositor.createCell(1, 2);
    const ctrlA = fakeController();
    const ctrlB = fakeController();
    compositor.addVoice({ voiceId: 'A', cell: cellA, controller: ctrlA });
    compositor.addVoice({ voiceId: 'B', cell: cellB, controller: ctrlB });
    // Give both cells a real on-screen box so the render loop doesn't cull them.
    stubRect(cellA, { left: 0, top: 0, right: 100, bottom: 100 });
    stubRect(cellB, { left: 100, top: 0, right: 200, bottom: 100 });
    stubRect(compositor.canvas, { left: 0, top: 0, right: 200, bottom: 100 });
    Object.defineProperty(compositor.canvas, 'clientWidth', { value: 200, configurable: true });
    Object.defineProperty(compositor.canvas, 'clientHeight', { value: 100, configurable: true });

    // Normal (no fullscreen): both voices render.
    compositor.renderOnce();
    expect(ctrlA.renderViewport).toHaveBeenCalled();
    expect(ctrlB.renderViewport).toHaveBeenCalled();

    ctrlA.renderViewport.mockClear();
    ctrlB.renderViewport.mockClear();

    // Fullscreen A: only A renders.
    setFullscreenElement(cellA);
    fireFullscreenChange();
    compositor.renderOnce();
    expect(ctrlA.renderViewport).toHaveBeenCalled();
    expect(ctrlB.renderViewport).not.toHaveBeenCalled();
  });

  it('restores without throwing when the saved nextSibling was detached during fullscreen', () => {
    // Repro of the NotFoundError: body has a sibling after the canvas; it is removed while a cell is
    // fullscreen, so the saved `nextSibling` is no longer a child of body on exit.
    compositor = createViewportCompositor();
    const cellA = compositor.createCell(0, 1);
    compositor.addVoice({ voiceId: 'A', cell: cellA, controller: fakeController() });
    const { canvas } = compositor;
    // Put a throwaway node right after the canvas on <body> so it becomes canvasHome.next.
    const sibling = document.createElement('div');
    canvas.after(sibling);

    setFullscreenElement(cellA);
    fireFullscreenChange();
    expect(canvas.parentNode).toBe(cellA);

    sibling.remove(); // the saved next is now detached from <body>

    setFullscreenElement(null);
    expect(() => fireFullscreenChange()).not.toThrow(); // must not throw NotFoundError
    expect(canvas.parentNode).toBe(document.body); // canvas back home (appended)
  });

  it('restores the canvas to <body> if the fullscreen voice is removed mid-fullscreen', () => {
    compositor = createViewportCompositor();
    const cellA = compositor.createCell(0, 1);
    compositor.addVoice({ voiceId: 'A', cell: cellA, controller: fakeController() });
    const { canvas } = compositor;

    setFullscreenElement(cellA);
    fireFullscreenChange();
    expect(canvas.parentNode).toBe(cellA);

    // Remove the fullscreen voice: grid-mode removeVoice would cell.remove() — the canvas must be
    // pulled back to <body> first so it isn't detached with the cell.
    compositor.removeVoice('A');
    expect(canvas.parentNode).toBe(document.body);
    expect(cellA.parentNode).toBe(null); // the grid cell itself is gone
  });
});
