/**
 * @file src/input/CameraController.js
 * @description High-level controls for the world camera, translating pointer/touch gestures
 * into azimuth/polar/distance parameters managed by `ParameterManager`.
 */
import * as THREE from 'three';
import { getPriority } from '../config/Constants.js';
import { createInputRouter } from './source/InputRouter.ts';
import { voiceRegistry } from '../voice/VoiceRegistry.js';

const TWO_PI = Math.PI * 2;
// Wrap an angular delta into (-PI, PI]. Pure — hoisted so the per-frame velocity read doesn't
// re-allocate the closure every tick.
const normDelta = (d) => ((d + Math.PI + TWO_PI) % TWO_PI) - Math.PI;

export class CameraController {
  constructor(worldSceneController, parameterManager, voiceId = null) {
    if (!worldSceneController) throw new Error('[CameraController] worldSceneController is required');
    this.world = worldSceneController;
    this.params = parameterManager;
    // The voice this controller drives + focuses. Its ONE input surface is this voice's own cell
    // (`world.inputElement`), so any pointer event that reaches this controller is, by construction, for
    // THIS voice — there is no cross-voice gating. On pointerdown the controller focuses this voice
    // (`voiceRegistry.setActive`), which is what the realm used to do with a document-level hit-test.
    this._voiceId = voiceId;

    this._listeners = new Set();
    this._last = { az: null, polar: null, dist: null, t: performance.now() };
    // Per-frame scratch so the fallback velocity read allocates nothing (the render loop runs it
    // every tick when a listener is attached). Reused in-place by `_readVelocities`.
    this._scratch = {
      offset: new THREE.Vector3(),
      spherical: new THREE.Spherical(),
      zeroTarget: new THREE.Vector3(),
    };

    // --- added: pointer-driven param deltas + multi-touch pinch ---
    this._pointerActive = false;
    this._pointerId = null;
    this._lastPos = { x: 0, y: 0 };
    this._pointers = new Map(); // pointerId -> { x, y }
    this._pinch = { active: false, prevDist: 0 };
    // pixels -> normalized delta gains (tune to taste)
    this._sens = { x: 0.001, y: 0.001, wheel: 0.0005, pinch: 0.0015 };
    this._paramDriveEnabled = true; // default ON
    this._controllerTag = 'CameraController';
    // The seam this controller pushes through. Lazily bound (see _inputSource()).
    this._inputSourceHandle = null;
    this._supportsPointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window;
    this._doubleTap = { time: 0, x: 0, y: 0 };
    this._doubleTapDelay = 300;
    this._doubleTapToleranceSq = 625;
    this._installPointerDeltaInput();
    // --- end added ---

    this._onTick = this._onTick.bind(this);
    if (typeof this.world.addRenderCallback === 'function') {
      this.world.addRenderCallback(this._onTick);
    }
  }

  // Public API
  onUpdate(fn) {
    if (typeof fn !== 'function') return () => {};
    // `_readVelocities` no longer runs while there are no listeners, so `_last` can be stale.
    // Re-baseline on the empty→non-empty transition so the first tick after attach reports a
    // zero delta (no velocity spike) instead of diffing against a stale pose.
    if (this._listeners.size === 0) {
      this._last.az = this._last.polar = this._last.dist = null;
      this._last.t = performance.now();
    }
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // enable/disable pointer-driven param deltas
  enablePointerParamDrive(enable = true) { this._paramDriveEnabled = !!enable; }

  // adjust sensitivities (pixels->normalized, wheel/pinch->normalized)
  setPointerSensitivity({ x, y, wheel, pinch } = {}) {
    if (Number.isFinite(x)) this._sens.x = x;
    if (Number.isFinite(y)) this._sens.y = y;
    if (Number.isFinite(wheel)) this._sens.wheel = wheel;
    if (Number.isFinite(pinch)) this._sens.pinch = pinch;
  }

  /**
   * @param {{nowSec: number, dtSec: number}} [frame] - The render loop's frame
   *        clock. Frameless callers (tests, ad-hoc reads) fall back to an
   *        internal timestamp.
   */
  getSnapshot(frame) {
    const v = this._readVelocities(frame);
    const root = this._readRootParams();
    return { velocities: v, root };
  }

  dispose() {
    if (typeof this.world.removeRenderCallback === 'function') {
      this.world.removeRenderCallback(this._onTick);
    }
    // remove pointer listeners and restore touch-action
    this._removePointerDeltaInput();
    this._listeners.clear();
  }

  // Internal
  _onTick(frame) {
    // Guard first: with no listeners the snapshot is discarded, so skip the whole read (it
    // otherwise allocates + runs trig every frame — WorldSceneController exposes no velocity
    // getters, so `_readVelocities` always takes the fallback path).
    if (!this._listeners.size) return;
    const snap = this.getSnapshot(frame);
    this._listeners.forEach((fn) => fn(snap));
  }

  // pointer delta input -> ParameterManager.addDeltaNormalized (mouse + touch/pinch)
  _installPointerDeltaInput() {
    // ONE input surface per voice = its own cell. The voice session sets `world.inputElement`
    // to this voice's cell (multi) or the app's fullscreen canvas (single-orbiter) — always present. The
    // shared realm canvas is render-only and never bound, so a pointer event on this controller can only
    // ever be for THIS voice. No shared-canvas binding, no `_isActiveVoice` gating.
    const el =
      this.world?.inputElement ||
      this.world?.renderer?.domElement ||
      this.world?.controls?.domElement ||
      null;
    if (!el) return;
    this._inputEl = el;
    this._usingPointerEvents = !!this._supportsPointerEvents;

    // prevent browser gestures on the input surface (pinch-zoom/scroll), restore on dispose
    this._prevTouchAction = el.style.touchAction;
    el.style.touchAction = 'none';

    const dispatchTouches = (touchList, baseEvent, handler) => {
      Array.from(touchList || []).forEach((touch) => {
        handler({
          pointerId: touch.identifier,
          clientX: touch.clientX,
          clientY: touch.clientY,
          pointerType: 'touch',
          target: baseEvent.target,
          preventDefault: () => baseEvent.preventDefault(),
          stopPropagation: () => baseEvent.stopPropagation?.()
        });
      });
    };

    this._onPointerDown = (e) => {
      // Focus THIS voice on any pointerdown that reaches its cell — the planet, empty tile area,
      // or a control that bubbled up. Re-selecting the active tile still notifies (the shell re-mirrors
      // its accent for menus opened after async color load). Single-orbiter: the sole voice is already
      // active and nothing subscribes, so this is a cheap no-op. Replaces the realm document-capture hit-test.
      // A shift-pointerdown TOGGLES this tile in/out of the multi-selection instead of
      // collapsing to single focus; a plain pointerdown collapses back to single focus.
      if (this._voiceId != null) {
        try {
          if (e.shiftKey) {
            voiceRegistry.toggleSelection(this._voiceId);
            return; // a shift-click is a selection gesture only — do not also start a camera drag
          }
          // Editing a CONTROL (knob/slider — target isn't the bare cell) on a tile that is ALREADY part
          // of a multi-selection must NOT collapse the selection: this is the pointerdown that begins a
          // multi-edit drag, and collapsing here would defeat it (the drag would then touch one tile).
          // Only a press on the bare surface, or on a tile outside the selection, focuses/collapses to
          // this single tile. This handler is capture-phase (runs before the control), so the guard has
          // to live here, before the control's own drag begins.
          const editingSelectedControl =
            voiceRegistry.selectionSize > 1 &&
            voiceRegistry.isSelected(this._voiceId) &&
            e.target !== this._inputEl;
          if (!editingSelectedControl) voiceRegistry.setActive(this._voiceId);
        } catch { /* voice may be mid-teardown */ }
      }
      // Panel filter: camera drive only in jamming mode (was a create/destroy trigger — now a gate).
      if (!this._paramDriveEnabled) return;
      // Drag only when the pointer landed on the BARE surface, not a control layered above it. The cell is
      // the ancestor of the voice's chrome, but `#orbiters-react-ui-root` is pointer-events:none (buttons
      // opt back to :auto), so an empty-area pointerdown targets the cell itself while a control targets its
      // own element. Focus is already set above, so a control click still focuses the tile.
      if (e.target !== this._inputEl) return;
      const now = performance.now();
      if (this._checkDoubleTap(e, now)) {
        this._resetPointerState();
        this._resetAxes();
        return;
      }
      if (e.pointerType === 'touch') e.preventDefault?.();
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size === 1) {
        // single-finger tracking
        this._pointerActive = true;
        this._pointerId = e.pointerId;
        this._lastPos.x = e.clientX;
        this._lastPos.y = e.clientY;
      } else if (this._pointers.size === 2) {
        // start pinch
        const pts = [...this._pointers.values()];
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        this._pinch.active = true;
        this._pinch.prevDist = Math.hypot(dx, dy);
      }

      try { e.target.setPointerCapture?.(e.pointerId); } catch {}
    };

    this._onPointerMove = (e) => {
      if (e.pointerType === 'touch') e.preventDefault?.();
      if (!this._paramDriveEnabled || !this.params) return;

      // update pointer position
      if (this._pointers.has(e.pointerId)) {
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (this._pinch.active && this._pointers.size >= 2) {
        // handle pinch zoom -> z delta
        const pts = [...this._pointers.values()];
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        const dist = Math.hypot(dx, dy);
        const d = dist - (this._pinch.prevDist || dist);
        this._pinch.prevDist = dist;

        if (d !== 0) {
          const dzNorm = d * this._sens.pinch;
          this._applyAxisDelta('z', dzNorm);
        }
        return;
      }

      // single pointer -> XY deltas
      if (!this._pointerActive || e.pointerId !== this._pointerId) return;

      const dx = (e.movementX ?? (e.clientX - this._lastPos.x)) || 0;
      const dy = (e.movementY ?? (e.clientY - this._lastPos.y)) || 0;
      this._lastPos.x = e.clientX;
      this._lastPos.y = e.clientY;

      if (dx) this._applyAxisDelta('x', dx * this._sens.x);
      if (dy) this._applyAxisDelta('y', -dy * this._sens.y);
    };

    this._onPointerUp = (e) => {
      if (e.pointerType === 'touch') e.preventDefault?.();
      this._pointers.delete(e.pointerId);

      // stop pinch when fewer than two pointers remain
      if (this._pointers.size < 2) {
        this._pinch.active = false;
        this._pinch.prevDist = 0;
      }

      // if primary pointer lifted, promote another pointer if present
      if (e.pointerId === this._pointerId) {
        this._pointerActive = false;
        this._pointerId = null;
        const next = this._pointers.keys().next();
        if (!next.done) {
          const newId = next.value;
          const p = this._pointers.get(newId);
          this._pointerActive = true;
          this._pointerId = newId;
          this._lastPos.x = p.x;
          this._lastPos.y = p.y;
        }
      }

      try { e.target.releasePointerCapture?.(e.pointerId); } catch {}
    };

    this._onPointerCancel = (e) => {
      if (e.pointerType === 'touch') e.preventDefault?.();
      this._onPointerUp(e);
    };

    this._onDoubleClick = (e) => {
      if (!this._paramDriveEnabled) return; // recenter only while camera drive is active (jamming)
      if (e.target !== this._inputEl) return; // bare surface only, not a control (see _onPointerDown)
      e.preventDefault?.();
      this._resetPointerState();
      this._resetAxes();
    };

    this._onWheel = (e) => {
      if (!this._paramDriveEnabled || !this.params) return; // jamming-only + params required
      if (e.target !== this._inputEl) return; // bare surface only, not a control (see _onPointerDown)
      try { e.preventDefault(); } catch {}
      const dzNorm = -e.deltaY * this._sens.wheel;
      if (dzNorm !== 0) this._applyAxisDelta('z', dzNorm);
    };

    if (this._usingPointerEvents) {
      // Capture-phase pointerdown: the focus write (voiceRegistry.setActive) must run before any descendant
      // control's own handler, so a control that stops pointerdown propagation can't prevent its tile from
      // focusing. This preserves the immunity the removed document-capture realm listener had.
      el.addEventListener('pointerdown', this._onPointerDown, { passive: false, capture: true });
      el.addEventListener('pointermove', this._onPointerMove, { passive: false });
      el.addEventListener('pointerup', this._onPointerUp, { passive: false });
      el.addEventListener('pointercancel', this._onPointerCancel, { passive: false });
    } else {
      this._onTouchStart = (e) => {
        e.preventDefault();
        dispatchTouches(e.changedTouches, e, this._onPointerDown);
      };
      this._onTouchMove = (e) => {
        e.preventDefault();
        dispatchTouches(e.changedTouches, e, this._onPointerMove);
      };
      this._onTouchEnd = (e) => {
        e.preventDefault();
        dispatchTouches(e.changedTouches, e, this._onPointerUp);
      };
      this._onTouchCancel = (e) => {
        e.preventDefault();
        dispatchTouches(e.changedTouches, e, this._onPointerUp);
      };
      el.addEventListener('touchstart', this._onTouchStart, { passive: false, capture: true });
      el.addEventListener('touchmove', this._onTouchMove, { passive: false });
      el.addEventListener('touchend', this._onTouchEnd, { passive: false });
      el.addEventListener('touchcancel', this._onTouchCancel, { passive: false });
    }
    el.addEventListener('dblclick', this._onDoubleClick, { passive: false });
    el.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _removePointerDeltaInput() {
    const el = this._inputEl;
    if (!el) return;
    if (this._usingPointerEvents) {
      el.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
      el.removeEventListener('pointermove', this._onPointerMove);
      el.removeEventListener('pointerup', this._onPointerUp);
      el.removeEventListener('pointercancel', this._onPointerCancel);
    } else {
      el.removeEventListener('touchstart', this._onTouchStart, { capture: true });
      el.removeEventListener('touchmove', this._onTouchMove);
      el.removeEventListener('touchend', this._onTouchEnd);
      el.removeEventListener('touchcancel', this._onTouchCancel);
      this._onTouchStart = this._onTouchMove = this._onTouchEnd = this._onTouchCancel = null;
    }
    el.removeEventListener('dblclick', this._onDoubleClick);
    el.removeEventListener('wheel', this._onWheel);
    this._usingPointerEvents = false;
    // restore the surface's prior touch-action
    if (this._prevTouchAction !== undefined) el.style.touchAction = this._prevTouchAction;
    this._prevTouchAction = undefined;
    this._inputEl = null;
  }

  _readVelocities(frame) {
    // Use WorldSceneController velocity getters if available
    if (this.world &&
        typeof this.world.getAzimuthVelocity === 'function' &&
        typeof this.world.getPolarVelocity === 'function' &&
        typeof this.world.getDollyVelocity === 'function') {
      return {
        azimuth: this.world.getAzimuthVelocity(),
        polar: this.world.getPolarVelocity(),
        dolly: this.world.getDollyVelocity()
      };
    }

    // Compute signed deltas per tick from camera pose. On the render path the
    // loop's frame clock supplies dt; frameless calls keep their own timestamp.
    let dt;
    if (frame && Number.isFinite(frame.dtSec)) {
      dt = Math.max(1e-6, frame.dtSec);
    } else {
      const now = performance.now();
      dt = Math.max(1e-6, (now - (this._last.t || now)) / 1000);
      this._last.t = now;
    }

    const controls = this.world?.controls;
    const camera = this.world?.camera;
    const target = controls?.target || this._scratch.zeroTarget;
    const offset = this._scratch.offset.copy(camera.position).sub(target);
    const az = Math.atan2(offset.x, offset.z); // (-PI, PI]
    const polar = this._scratch.spherical.setFromVector3(offset).phi; // [0, PI]
    const dist = offset.length();

    if (this._last.az == null) { this._last.az = az; }
    if (this._last.polar == null) { this._last.polar = polar; }
    if (this._last.dist == null) { this._last.dist = dist; }

    const dAz = normDelta(az - this._last.az);
    const dPolar = normDelta(polar - this._last.polar);
    const dDist = dist - this._last.dist;

    this._last.az = az;
    this._last.polar = polar;
    this._last.dist = dist;

    return {
      azimuth: dAz / dt,  // rad/s (right adds, left subtracts)
      polar: dPolar / dt, // rad/s (up adds, down subtracts)
      dolly: dDist / dt   // units/s (out adds, in subtracts)
    };
  }

  _readRootParams() {
    const pm = this.params;
    if (!pm) return { x: 0, y: 0, z: 0 };

    // Try common method names first
    const root =
      (typeof pm.getActiveRootParams === 'function' && pm.getActiveRootParams()) ||
      (typeof pm.getActiveRootParameters === 'function' && pm.getActiveRootParameters()) ||
      (typeof pm.getRootParameters === 'function' && pm.getRootParameters()) ||
      (typeof pm.getCurrentRoot === 'function' && pm.getCurrentRoot()) ||
      pm.root || pm.activeRoot || pm.currentRoot || pm;

    const x = Number(root?.x ?? 0);
    const y = Number(root?.y ?? 0);
    const z = Number(root?.z ?? 0);
    return { x, y, z };
  }

  /**
   * Lazily bind the seam this controller pushes through. Created from `this.params`
   * (the ParameterManager) the first time it's available; null until then.
   */
  _inputSource() {
    if (!this.params) return null;
    if (!this._inputSourceHandle) {
      this._inputSourceHandle = createInputRouter(this.params)
        .source(this._controllerTag, getPriority('camera'));
    }
    return this._inputSourceHandle;
  }

  _applyAxisDelta(axis, deltaNorm) {
    if (!this.params || !deltaNorm) return;
    const inputSource = this._inputSource();
    if (!inputSource) return;
    const pm = this.params;
    const info = typeof pm.getParameter === 'function' ? pm.getParameter(axis) : null;
    const range = info && Number.isFinite(info.max) && Number.isFinite(info.min) ? info.max - info.min : null;
    // Priority is the source's bound default (PRIORITY_MAP['camera'] = 1), so it's
    // omitted here. A known range scales the delta into the param's units (rawDelta);
    // otherwise stay normalized.
    if (range) {
      inputSource.set(axis, deltaNorm * range, { kind: 'rawDelta' });
    } else {
      inputSource.set(axis, deltaNorm, { kind: 'delta' });
    }
  }

  _resetAxes() {
    const inputSource = this._inputSource();
    if (!inputSource) return;
    // A deliberate recenter wins over everything (PRIORITY_MAP['camera-reset'] = 0).
    const priority = getPriority('camera-reset');
    ['x', 'y', 'z'].forEach((axis) => {
      inputSource.set(axis, 0, { kind: 'raw', priority });
    });
  }

  _checkDoubleTap(e, now) {
    if (e.pointerType !== 'touch' || this._pointers.size > 0) return false;
    const dt = now - (this._doubleTap.time || 0);
    const dx = e.clientX - this._doubleTap.x;
    const dy = e.clientY - this._doubleTap.y;
    const distSq = dx * dx + dy * dy;
    const isDouble = dt > 0 && dt <= this._doubleTapDelay && distSq <= this._doubleTapToleranceSq;
    this._doubleTap = isDouble ? { time: 0, x: 0, y: 0 } : { time: now, x: e.clientX, y: e.clientY };
    return isDouble;
  }

  _resetPointerState() {
    this._pointers.clear();
    this._pointerActive = false;
    this._pointerId = null;
    this._pinch.active = false;
    this._pinch.prevDist = 0;
    this._doubleTap = { time: 0, x: 0, y: 0 };
  }
}
