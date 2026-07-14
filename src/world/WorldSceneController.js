import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ensureDefaultLights } from 'entangled-worlds-orbiters-shared/core';
import { applyCameraInsetOffset } from '../ui/viewport.js';

/**
 * Centralises Three.js scene, renderer, and camera management for Orbiters.
 * This controller bootstraps the shared Entangled Worlds renderer while
 * keeping hooks for Orbiters-specific overlays (e.g. oscillation rings).
 */
export class WorldSceneController {
  constructor(canvas, options = {}) {
    if (!canvas) {
      throw new Error('[WorldSceneController] canvas element is required');
    }

    this.canvas = canvas;
    this.performanceProfile = this.#resolvePerformanceProfile(options.performanceProfile);
    this._showFpsOverlay = Boolean(options.showFpsOverlay);
    this.scene = new THREE.Scene();
    // In the multi-orbiter realm a single compositor owns ONE renderer + ONE rAF loop and
    // renders each voice's scene into a scissor-rect viewport. A voice passes that `sharedRenderer`
    // here: this controller then borrows it (never creates/sizes/disposes it) and skips its own loop —
    // the compositor calls `renderViewport()` each frame. No `sharedRenderer` → single-orbiter is
    // byte-identical (owns its renderer, its rAF loop, its resize binding, its global slots).
    this._sharedRenderer = options.sharedRenderer || null;
    // This voice's ONE camera-input surface — its DOM cell in a shared realm, or the app's
    // fullscreen canvas single-orbiter. Always set. The CameraController binds exactly this element (never
    // the shared realm canvas, which is render-only), so a pointer event can only ever be for THIS voice.
    this.inputElement = options.inputElement || null;
    this._ownsRenderer = !this._sharedRenderer;
    this.renderer = this._ownsRenderer ? this.#createRenderer(canvas) : this._sharedRenderer;
    this.camera = this.#createCamera();
    this.controls = this.#createControls();
    this.overlayGroups = new Set();
    this.renderCallbacks = new Set();
    // An optional pass that re-draws this voice's frame through a shader (the grit
    // group crushes the picture). The controller owns the ONE draw call on both
    // paths, so this is the only place such a thing can live — and because the pass
    // renders into its own target and lands back inside this voice's scissor rect,
    // a sibling voice sharing the renderer is untouched.
    this._postPass = null;
    this._animationFrame = null;
    this._renderActive = true;
    this._disposed = false;
    // Right-edge inset (px) reserved for the Orbiter Studio panel; 0 = full-bleed (play mode).
    this._viewportInsetRight = 0;
    this._fpsOverlayEl = null;
    this._lastFrameTimestamp = null;
    this._fpsSampleWindow = [];
    this._fpsSampleWindowSize = 90;
    this._fpsSampleTotal = 0; // running sum of the window (avoids a per-frame reduce)
    this._frameStats = null; // the object mutated in place each frame (also on window.__orbitersFrameStats)
    this._fpsOverlayLastPaintAt = 0;
    // The ONE frame clock, passed to every render callback (see addRenderCallback).
    // Mutated in place each frame — no per-frame allocation.
    this._frame = { nowSec: 0, dtSec: 0 };
    this._frameLastNowMs = null;

    ensureDefaultLights(this.scene);

    // Shared-renderer voices don't own the loop, the canvas size, or the singleton window slots — the
    // compositor does. They only contribute a scene+camera and a per-frame callback set.
    if (this._ownsRenderer) {
      this.#initFrameStats();
      this.#startLoop();
      this.#bindResize();

      // Let the React Studio shell reserve the right-edge panel region (mirrors EW's
      // `window.__EW_setEditViewport`). One controller is active at a time, so last-writer-wins is fine.
      if (typeof window !== 'undefined') {
        window.__orbitersSetViewportInset = (rightPx) => this.setViewportInset(rightPx);
      }
    }
  }

  #resolvePerformanceProfile(profile) {
    const defaults = {
      maxDevicePixelRatio: 1.5,
      antialias: true,
      shadowsEnabled: false,
    };

    if (!profile || typeof profile !== 'object') {
      return { ...defaults };
    }

    const resolveNumeric = (value, fallback) => {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) {
        return fallback;
      }
      return number;
    };

    return {
      maxDevicePixelRatio: resolveNumeric(profile.maxDevicePixelRatio, defaults.maxDevicePixelRatio),
      antialias: profile.antialias !== undefined ? Boolean(profile.antialias) : defaults.antialias,
      shadowsEnabled:
        profile.shadowsEnabled !== undefined ? Boolean(profile.shadowsEnabled) : defaults.shadowsEnabled,
    };
  }

  #applyRendererProfile(renderer) {
    if (!renderer) return;

    const dpr =
      typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
        ? window.devicePixelRatio
        : 1;
    const maxDpr = this.performanceProfile.maxDevicePixelRatio || 1.5;
    renderer.setPixelRatio(Math.min(dpr, maxDpr));
    renderer.shadowMap.enabled = Boolean(this.performanceProfile.shadowsEnabled);
    renderer.userData = renderer.userData || {};
    renderer.userData.performanceProfile = {
      ...(renderer.userData.performanceProfile || {}),
      maxDevicePixelRatio: maxDpr,
      antialias: Boolean(this.performanceProfile.antialias),
    };
  }

  #createRenderer(canvas) {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: Boolean(this.performanceProfile.antialias),
      alpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    this.#applyRendererProfile(renderer);
    renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    return renderer;
  }

  #createCamera() {
    const width = this.canvas.clientWidth || window.innerWidth || 1;
    const height = this.canvas.clientHeight || window.innerHeight || 1;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    camera.position.set(0, 0, 2);
    return camera;
  }

  #createControls() {
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    // disable all user interaction
    controls.enabled = false;
    controls.enableRotate = false;
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = false;
    // keep distances as-is (irrelevant when disabled)
    controls.minDistance = 0.5;
    controls.maxDistance = 10;
    return controls;
  }

  #bindResize() {
    this._onResize = () => this.#applySize();
    window.addEventListener('resize', this._onResize);
  }

  /**
   * Fit the renderer + camera to the canvas. For the Orbiter Studio panel we keep the canvas
   * FULL-WIDTH — so the live scene (starfield) renders BEHIND the frosted panel (the semi-transparent
   * look) — and shift the orbiter into the left region with a camera VIEW-OFFSET (`applyCameraInsetOffset`,
   * the same single source the resize handler uses). This never shrinks the canvas, so the WebGL buffer
   * can't squish (a `<canvas>` is a replaced element). With no inset this is the play-mode path (sizes to
   * the canvas client box, no offset) — unchanged.
   */
  #applySize() {
    const inset = this._viewportInsetRight || 0;
    // Canvas is always full-bleed (the stylesheet owns the box); we never confine it via CSS anymore.
    this.canvas.style.removeProperty('left');
    this.canvas.style.removeProperty('width');
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    if (!width || !height) return;

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    applyCameraInsetOffset(this.camera, inset, width, height);
    this.camera.updateProjectionMatrix();
    this.#applyRendererProfile(this.renderer);
  }

  /**
   * Reserve `rightPx` of the canvas's right edge for the Studio panel (0 clears it). The orbiter
   * reframes into the remaining left region without deformation (see #applySize). Exposed on `window` for
   * the React Studio shell to call, mirroring how EW exposes `__EW_setEditViewport`.
   */
  setViewportInset(rightPx) {
    this._viewportInsetRight = Math.max(0, Math.round(Number(rightPx) || 0));
    this.#applySize();
  }

  /** The right-edge inset (px) reserved by the Studio panel — the ONE value any other resize owner
   *  (e.g. `bindViewportHandlers`) must subtract so it frames the SAME left region, not the full tab. */
  get viewportInsetRight() {
    return this._viewportInsetRight;
  }

  #initFrameStats() {
    // One stats object, mutated in place by `#recordFrame` — also published on the window handle
    // so tooling can read it without us allocating a fresh object every frame.
    this._frameStats = { fps: 0, frameTimeMs: 0, sampleCount: 0 };
    if (typeof window !== 'undefined') {
      window.__orbitersFrameStats = this._frameStats;
    }
    if (!this._showFpsOverlay || typeof document === 'undefined') {
      return;
    }

    const overlay = document.createElement('div');
    overlay.setAttribute('data-role', 'fps-overlay');
    overlay.style.position = 'fixed';
    overlay.style.top = '12px';
    overlay.style.right = '12px';
    overlay.style.zIndex = '2000';
    overlay.style.pointerEvents = 'none';
    overlay.style.padding = '6px 8px';
    overlay.style.borderRadius = '8px';
    overlay.style.background = 'rgba(0, 0, 0, 0.55)';
    overlay.style.backdropFilter = 'blur(4px)';
    overlay.style.color = 'var(--color1, rgba(255,255,255,0.92))';
    overlay.style.border = '1px solid rgba(255,255,255,0.18)';
    overlay.style.fontFamily = 'var(--orbiters-font-family, monospace)';
    overlay.style.fontSize = '12px';
    overlay.style.lineHeight = '1.25';
    overlay.style.whiteSpace = 'pre';
    overlay.textContent = 'FPS --\nFT -- ms';
    document.body.appendChild(overlay);
    this._fpsOverlayEl = overlay;
  }

  #recordFrame(now) {
    if (!Number.isFinite(now)) {
      return;
    }

    if (this._lastFrameTimestamp == null) {
      this._lastFrameTimestamp = now;
      return;
    }

    const frameTimeMs = now - this._lastFrameTimestamp;
    this._lastFrameTimestamp = now;
    if (!Number.isFinite(frameTimeMs) || frameTimeMs <= 0) {
      return;
    }

    // Running sum: add the new sample, subtract the one that ages out — avoids a reduce over the
    // whole window every frame.
    this._fpsSampleWindow.push(frameTimeMs);
    this._fpsSampleTotal += frameTimeMs;
    if (this._fpsSampleWindow.length > this._fpsSampleWindowSize) {
      this._fpsSampleTotal -= this._fpsSampleWindow.shift();
    }

    const sampleCount = this._fpsSampleWindow.length;
    const avgFrameTimeMs = sampleCount > 0 ? this._fpsSampleTotal / sampleCount : 0;
    const avgFps = avgFrameTimeMs > 0 ? 1000 / avgFrameTimeMs : 0;

    if (this._frameStats) {
      this._frameStats.fps = avgFps;
      this._frameStats.frameTimeMs = avgFrameTimeMs;
      this._frameStats.sampleCount = sampleCount;
    }

    if (!this._fpsOverlayEl || now - this._fpsOverlayLastPaintAt < 250) {
      return;
    }

    this._fpsOverlayLastPaintAt = now;
    this._fpsOverlayEl.textContent =
      `FPS ${avgFps.toFixed(1)}\nFT ${avgFrameTimeMs.toFixed(1)} ms`;
  }

  /**
   * Advance the frame clock: seconds-now plus a delta capped at 0.5s, so every
   * callback gets tab-inactivity clamping for free. One computation per frame,
   * one reused object.
   */
  #advanceFrame(nowMs) {
    const frame = this._frame;
    frame.nowSec = nowMs / 1000;
    const dtSec = this._frameLastNowMs === null ? 0 : (nowMs - this._frameLastNowMs) / 1000;
    frame.dtSec = dtSec > 0 ? Math.min(dtSec, 0.5) : 0;
    this._frameLastNowMs = nowMs;
    return frame;
  }

  #startLoop() {
    // Shared-renderer voices are driven by the compositor's loop, never their own.
    if (!this._ownsRenderer) {
      return;
    }
    if (this._disposed || !this._renderActive || this._animationFrame != null) {
      return;
    }
    const tick = (now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) => {
      if (this._disposed || !this._renderActive) {
        this._animationFrame = null;
        return;
      }
      this.#recordFrame(now);
      const frame = this.#advanceFrame(now);
      // removed: controls.update(); (controls are disabled)
      this.renderCallbacks.forEach((cb) => cb(frame));
      this.#draw(null);
      this._animationFrame = requestAnimationFrame(tick);
    };
    this._animationFrame = requestAnimationFrame(tick);
  }

  setRenderActive(active, { renderOnce = true } = {}) {
    const next = Boolean(active);
    if (this._disposed || this._renderActive === next) {
      return;
    }
    this._renderActive = next;
    // Reset the frame clock on pause so the first resumed frame reports dt 0
    // instead of the whole pause (both loop-owning and compositor-driven voices).
    if (!next) {
      this._frameLastNowMs = null;
    }
    // Shared-renderer voices have no own loop to start/stop: the compositor reads `renderActive` each
    // frame and skips paused voices. Just flip the flag.
    if (!this._ownsRenderer) {
      return;
    }
    if (!next) {
      if (this._animationFrame != null) {
        cancelAnimationFrame(this._animationFrame);
        this._animationFrame = null;
      }
      this._lastFrameTimestamp = null;
      return;
    }
    if (renderOnce) {
      try {
        // Through the pass, like every other frame — a resumed voice must not flash one
        // clean frame before the effect's picture comes back.
        this.#draw(null);
      } catch (_) {}
    }
    this.#startLoop();
  }

  /** Whether the compositor should render this voice this frame (false while suspended/disposed). */
  get renderActive() {
    return this._renderActive && !this._disposed;
  }

  /**
   * Shared-renderer mode only: draw ONE frame of this voice's scene into `rect` of the
   * compositor's shared renderer. The compositor owns the rAF loop and the rect geometry (device px,
   * GL bottom-left origin); this method runs the voice's per-frame callbacks then scissor-renders so
   * the draw is confined to its cell. No-op while paused or disposed. Single-orbiter never calls this.
   */
  renderViewport(rect) {
    if (this._disposed || !this._renderActive || !rect) {
      return;
    }
    // The compositor owns the rAF but not this voice's clock — derive the frame
    // here so callbacks see the same interface on both render paths.
    const frame = this.#advanceFrame(
      typeof performance !== 'undefined' ? performance.now() : Date.now(),
    );
    this.renderCallbacks.forEach((cb) => cb(frame));
    const r = this.renderer;
    r.setViewport(rect.x, rect.y, rect.width, rect.height);
    r.setScissor(rect.x, rect.y, rect.width, rect.height);
    r.setScissorTest(true);
    this.#draw(rect);
  }

  /**
   * The ONE draw. Straight to the framebuffer, or — when this voice carries a post
   * pass — through it: the scene goes into the pass's own target and comes back as a
   * full-screen quad drawn inside this voice's rect. The shared renderer's scissor is
   * still standing, so the quad lands in this voice's cell and nowhere else.
   *
   * @param {{x:number,y:number,width:number,height:number}|null} rect - The voice's
   *        cell in the shared realm; null when it owns the whole canvas.
   */
  #draw(rect) {
    if (this._postPass) {
      this._postPass.render(this.renderer, this.scene, this.camera, rect);
      return;
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Give this voice a full-frame shader pass, or null to draw straight again. One
   * owner: the caller that sets it disposes it.
   *
   * @param {{ render(renderer: object, scene: object, camera: object, rect: object|null): void }|null} pass
   */
  setPostPass(pass) {
    this._postPass = pass ?? null;
  }

  /**
   * Shared-renderer mode only: size this voice's CAMERA to its cell so the planet keeps its
   * aspect (the shared renderer's drawing-buffer size is owned by the compositor, not this controller).
   * Mirrors #applySize's aspect math without touching renderer size. Call on layout change, not per-frame.
   */
  setViewportSize(width, height) {
    if (!width || !height) {
      return;
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  attachOverlay(group) {
    if (!group || !group.isObject3D) {
      console.warn('[WorldSceneController] attachOverlay expects a THREE.Object3D');
      return;
    }
    if (!this.overlayGroups.has(group)) {
      this.overlayGroups.add(group);
      this.scene.add(group);
    }
  }

  detachOverlay(group) {
    if (this.overlayGroups.has(group)) {
      this.overlayGroups.delete(group);
      this.scene.remove(group);
    }
  }

  /**
   * Register a per-frame callback, run before render on both render paths
   * (own loop and compositor viewport). Each callback receives the frame clock
   * `{ nowSec, dtSec }` — dtSec is already clamped against tab-inactivity
   * jumps. The object is REUSED every frame: read it synchronously, never
   * retain or mutate it. Don't build a private clock in a callback.
   */
  addRenderCallback(cb) {
    if (typeof cb === 'function') {
      this.renderCallbacks.add(cb);
    }
  }

  removeRenderCallback(cb) {
    this.renderCallbacks.delete(cb);
  }

  updatePerformanceProfile(profile) {
    this.performanceProfile = this.#resolvePerformanceProfile(profile);
    this.#applyRendererProfile(this.renderer);
  }

  dispose() {
    this._disposed = true;
    this._renderActive = false;
    cancelAnimationFrame(this._animationFrame);
    this._animationFrame = null;
    this._lastFrameTimestamp = null;
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
    }
    if (this.controls && typeof this.controls.dispose === 'function') {
      this.controls.dispose();
    }
    this.renderCallbacks.clear();
    this.overlayGroups.clear();

    // A shared-renderer voice borrows the compositor's renderer + the realm's global slots — it must
    // NOT dispose the renderer or delete slots it never created (that would kill its siblings).
    if (this._ownsRenderer) {
      this.renderer.dispose();
      delete window.__orbitersSetViewportInset;
      if (window.__orbitersFrameStats) {
        delete window.__orbitersFrameStats;
      }
    }
    this._frameStats = null;
    this._fpsSampleWindow = [];
    this._fpsSampleTotal = 0;
    if (this._fpsOverlayEl?.parentElement) {
      this._fpsOverlayEl.parentElement.removeChild(this._fpsOverlayEl);
    }
    this._fpsOverlayEl = null;
  }
}
