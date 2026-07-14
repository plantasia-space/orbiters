import * as THREE from 'three';
import { getPlaybackState } from '../config/Constants.js';
import { activeRoot } from '../voice/voiceDom.js';

const COLOR_REGEX = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/;
const RGB_REGEX = /rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/;
const DEFAULT_MAX_HISTORY_RINGS = 64;
// The fixed orbit/ring tilt (degrees). The oscilloscope ring and the moon group share it so they sit
// on the same plane; it is never changed at runtime, so it lives as a module constant rather than
// being read off an oscilloscope instance (the moon group has no voice/oscilloscope reference).
export const ORBIT_TILT_DEG = 15;
// CSS custom properties are read from the ACTIVE VOICE's root and cached per-root,
// not in one flat module Map — a shared cache would hand voice B the colors voice A read from its own
// subtree. Single-orbiter (root = document → documentElement) caches exactly one entry, byte-identical.
const cssVariableCacheByRoot = new WeakMap();
let cssVariableCacheBound = false;

/** The element to read computed CSS vars from: `documentElement` for a document, the element itself for a subtree. */
function resolveCssVariableRoot() {
  const root = activeRoot();
  if (!root) return null;
  return root.documentElement ?? root;
}

function clearCssVariableCache() {
  const root = resolveCssVariableRoot();
  if (root) cssVariableCacheByRoot.delete(root);
}

function ensureCssVariableCacheBinding() {
  if (cssVariableCacheBound || typeof document === 'undefined') {
    return;
  }
  document.addEventListener('orbiters:design-updated', clearCssVariableCache);
  cssVariableCacheBound = true;
}

function resolvePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.max(1, Math.round(numeric));
}

function readCssVariable(varName) {
  if (typeof window === 'undefined') {
    return null;
  }
  const root = resolveCssVariableRoot();
  if (!root) {
    return null;
  }

  let cache = cssVariableCacheByRoot.get(root);
  if (cache?.has(varName)) {
    return cache.get(varName);
  }

  const styles = getComputedStyle(root);
  const value = styles.getPropertyValue(varName)?.trim() || null;
  if (!cache) {
    cache = new Map();
    cssVariableCacheByRoot.set(root, cache);
  }
  cache.set(varName, value);
  return value;
}

function parseCssColor(cssValue, targetColor) {
  if (!cssValue) return null;

  const rgbaMatch = cssValue.match(COLOR_REGEX);
  if (rgbaMatch) {
    targetColor.setRGB(
      parseInt(rgbaMatch[1], 10) / 255,
      parseInt(rgbaMatch[2], 10) / 255,
      parseInt(rgbaMatch[3], 10) / 255
    );
    const alpha = rgbaMatch[4] != null ? Number.parseFloat(rgbaMatch[4]) : 1.0;
    return { color: targetColor.clone(), alpha };
  }

  if (cssValue.startsWith('#')) {
    try {
      targetColor.set(cssValue);
      return { color: targetColor.clone(), alpha: 1.0 };
    } catch (error) {
      console.warn('[RingOscilloscope] Failed to parse hex color:', cssValue, error);
      return null;
    }
  }

  const rgbMatch = cssValue.match(RGB_REGEX);
  if (rgbMatch) {
    targetColor.setRGB(
      parseInt(rgbMatch[1], 10) / 255,
      parseInt(rgbMatch[2], 10) / 255,
      parseInt(rgbMatch[3], 10) / 255
    );
    return { color: targetColor.clone(), alpha: 1.0 };
  }

  return null;
}

export class RingOscilloscope {
  constructor({
    orbitRadius = 1.0,
    orbitSegments = 256,
    amplitudeScale = 7,
    maxHistoryRings = DEFAULT_MAX_HISTORY_RINGS,
    historyInterval = 4,
    layerOffset = 0.000001,
    orbitTiltDeg = ORBIT_TILT_DEG,
    baseColorVar = '--color1',
    dynamicColorVar = '--color2',
  } = {}) {
    this.orbitRadius = orbitRadius;
    this.orbitSegments = orbitSegments;
    this.defaultOrbitSegments = orbitSegments; // baseline to restore when a profile clears the override
    this.amplitudeScale = amplitudeScale;
    this.maxHistoryRings = resolvePositiveInteger(maxHistoryRings, DEFAULT_MAX_HISTORY_RINGS);
    this.defaultMaxHistoryRings = this.maxHistoryRings;
    this.historyInterval = historyInterval;
    this.layerOffset = layerOffset;
    this.orbitTiltDeg = orbitTiltDeg;
    this.baseColorVar = baseColorVar;
    this.dynamicColorVar = dynamicColorVar;
    this.performanceProfile = null;

    this.ringGroup = null;
    this.orbitGeometry = null;
    this.orbitLine = null;
    this.ringPool = [];
    this.ringPoolIndex = 0;

    this.firstDrawDone = false;
    this.drawFrameCounter = 0;
    this.spiralOffset = 0;
    this.ampHistory = [];

    this.orbitColor = new THREE.Color(1, 1, 1);
    this.orbitAlpha = 1.0;
    // Last color written into the (uniform) color buffer, so `draw()` can skip the rewrite +
    // GPU re-upload while the color is unchanged. NaN forces the first draw to write.
    this._lastColorR = NaN;
    this._lastColorG = NaN;
    this._lastColorB = NaN;

    this.customColor = null;
    this.customAlpha = null;
    this.radiusMultiplier = 1;
    this.amplitudeMultiplier = 1;
    this.requirePlaybackState = true;
    this.enabled = true;

    ensureCssVariableCacheBinding();
    this.refreshBaseColor();
  }

  setPerformanceProfile(profile = null) {
    this.performanceProfile = profile && typeof profile === 'object' ? { ...profile } : null;
    const nextMaxHistoryRings = resolvePositiveInteger(
      this.performanceProfile?.ringHistoryRings,
      this.defaultMaxHistoryRings
    );
    const nextOrbitSegments = resolvePositiveInteger(
      this.performanceProfile?.ringOrbitSegments,
      this.defaultOrbitSegments
    );
    if (nextMaxHistoryRings === this.maxHistoryRings && nextOrbitSegments === this.orbitSegments) {
      return;
    }
    this.maxHistoryRings = nextMaxHistoryRings;
    if (nextOrbitSegments !== this.orbitSegments) {
      this.orbitSegments = nextOrbitSegments;
      // Cap the amplitude history to the (possibly smaller) segment count, dropping the OLDEST
      // samples (index 0 is oldest) so the ring keeps the most recent data after a profile switch.
      if (this.ampHistory.length > nextOrbitSegments) {
        this.ampHistory.splice(0, this.ampHistory.length - nextOrbitSegments);
      }
    }
    // ensureOverlay rebuilds when the ring pool size OR the segment count no longer matches the geometry.
    if (this.enabled && this.ringGroup) {
      this.ensureOverlay();
    }
  }

  refreshBaseColor() {
    const cssValue = readCssVariable(this.baseColorVar);
    const parsed = parseCssColor(cssValue, this.orbitColor);
    if (parsed) {
      this.orbitColor.copy(parsed.color);
      this.orbitAlpha = parsed.alpha;
    }
  }

  ensureOverlay(targetScene = null) {
    if (!this.ringGroup) {
      this.ringGroup = new THREE.Group();
      // Named so effect-visual layers can find the orbit rings by name (mirrors
      // the moons group / world body handles) — e.g. to sway or split them.
      this.ringGroup.name = 'orbitRingGroup';
      this.ringGroup.rotation.x = THREE.MathUtils.degToRad(this.orbitTiltDeg);
    }

    if (
      !this.orbitGeometry ||
      !this.orbitLine ||
      this.ringPool.length !== this.maxHistoryRings ||
      this.orbitGeometry.attributes.position.count !== this.orbitSegments
    ) {
      this._disposeRenderResources();
      this._buildRenderResources();
    }

    if (targetScene) {
      if (this.ringGroup.parent && this.ringGroup.parent !== targetScene) {
        this.ringGroup.parent.remove(this.ringGroup);
      }
      if (!this.ringGroup.parent) {
        targetScene.add(this.ringGroup);
      }
    }

    return this.ringGroup;
  }

  _buildRenderResources() {
    if (!this.ringGroup) return;

    // Fresh color buffer starts zeroed — force the next draw() to write the current color.
    this._lastColorR = this._lastColorG = this._lastColorB = NaN;
    // The new orbitLine starts hidden; re-arm the one-time reveal so a rebuild (e.g. a graphics-profile
    // switch that changes the segment count) shows the ring again instead of leaving it invisible.
    this.firstDrawDone = false;

    this.orbitGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(this.orbitSegments * 3);
    positions.fill(0);
    const colors = new Float32Array(this.orbitSegments * 3);

    for (let i = 0; i < this.orbitSegments; i++) {
      const theta = (i / this.orbitSegments) * Math.PI * 2;
      positions[i * 3] = this.orbitRadius * Math.cos(theta);
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = this.orbitRadius * Math.sin(theta);
    }

    this.orbitGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
    this.orbitGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(colors, 3)
    );
    this.orbitGeometry.computeBoundingSphere();

    const orbitMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: this.customAlpha ?? this.orbitAlpha,
      linewidth: 2,
    });

    this.orbitLine = new THREE.LineLoop(this.orbitGeometry, orbitMaterial);
    this.orbitLine.visible = false;
    this.ringGroup.add(this.orbitLine);

    for (let i = 0; i < this.maxHistoryRings; i++) {
      const historyGeometry = new THREE.BufferGeometry();
      historyGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(this.orbitSegments * 3), 3)
      );
      historyGeometry.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(this.orbitSegments * 3), 3)
      );

      const historyMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.25,
      });

      const historyMesh = new THREE.LineLoop(historyGeometry, historyMaterial);
      historyMesh.visible = false;
      this.ringPool.push(historyMesh);
      this.ringGroup.add(historyMesh);
    }
  }

  _disposeRenderResources() {
    if (this.orbitLine) {
      try { this.ringGroup?.remove(this.orbitLine); } catch (_) {}
      try { this.orbitLine.geometry?.dispose?.(); } catch (_) {}
      try { this.orbitLine.material?.dispose?.(); } catch (_) {}
      this.orbitLine = null;
    }

    this.ringPool.forEach((mesh) => {
      if (!mesh) return;
      try { this.ringGroup?.remove(mesh); } catch (_) {}
      try { mesh.geometry?.dispose?.(); } catch (_) {}
      try { mesh.material?.dispose?.(); } catch (_) {}
    });
    this.ringPool = [];

    if (this.orbitGeometry) {
      try { this.orbitGeometry.dispose?.(); } catch (_) {}
    }
    this.orbitGeometry = null;
    this.ringPoolIndex = 0;
  }

  updateOrbitColor() {
    if (this.customColor) {
      return;
    }

    const cssValue = readCssVariable(this.dynamicColorVar);
    const parsed = parseCssColor(cssValue, this.orbitColor);

    if (parsed) {
      this.orbitColor.copy(parsed.color);
      this.orbitAlpha = parsed.alpha;
      if (this.orbitLine?.material) {
        this.orbitLine.material.opacity = this.orbitAlpha;
      }
      return;
    }

    console.warn(
      `[RingOscilloscope] Could not parse CSS color for ${this.dynamicColorVar}:`,
      cssValue
    );
  }

  draw(amplitude) {
    if (!this.enabled) {
      return;
    }
    if (this.requirePlaybackState && getPlaybackState() !== 'playing') {
      return;
    }
    if (!this.orbitGeometry) {
      console.warn('[RingOscilloscope] draw() – no geometry available');
      return;
    }

    if (!this.firstDrawDone && this.orbitLine) {
      this.orbitLine.visible = true;
      this.firstDrawDone = true;
    }

    this.drawFrameCounter += 1;
    if (this.drawFrameCounter % 2 !== 0) return;

    const safeAmplitude = Number.isFinite(amplitude) ? amplitude : 0;
    this.ampHistory.push(safeAmplitude);
    if (this.ampHistory.length > this.orbitSegments) {
      this.ampHistory.shift();
    }

    this.spiralOffset += this.layerOffset;
    const baseRadius = Math.max(0, this.orbitRadius * Math.max(0, this.radiusMultiplier));
    if (this.spiralOffset > baseRadius - 0.1) {
      this.spiralOffset = 0;
    }

    const currentRadius = Math.max(0, baseRadius - this.spiralOffset);
    const positions = this.orbitGeometry.attributes.position.array;
    const colors = this.orbitGeometry.attributes.color.array;
    const angleIncrement = (2 * Math.PI) / this.orbitSegments;
    const activeColor = this.customColor ?? this.orbitColor;
    const amplitudeScale = this.amplitudeScale * Math.max(0, this.amplitudeMultiplier);
    const orbitAlpha = this.customAlpha ?? this.orbitAlpha;

    if (this.orbitLine?.material && typeof this.orbitLine.material.opacity === 'number') {
      this.orbitLine.material.opacity = orbitAlpha;
    }

    // The ring is a single flat color — only rewrite the color buffer (and re-upload it) when the
    // color actually changed. Positions still move every frame with the amplitude.
    const colorChanged =
      this._lastColorR !== activeColor.r ||
      this._lastColorG !== activeColor.g ||
      this._lastColorB !== activeColor.b;

    for (let i = 0; i < this.orbitSegments; i++) {
      const amp = this.ampHistory[i] ?? 0;
      const theta = i * angleIncrement;
      const radial = currentRadius + amp * amplitudeScale;

      positions[i * 3] = radial * Math.cos(theta);
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = radial * Math.sin(theta);

      if (colorChanged) {
        colors[i * 3] = activeColor.r;
        colors[i * 3 + 1] = activeColor.g;
        colors[i * 3 + 2] = activeColor.b;
      }
    }

    if (colorChanged) {
      this._lastColorR = activeColor.r;
      this._lastColorG = activeColor.g;
      this._lastColorB = activeColor.b;
    }

    if (this.drawFrameCounter % this.historyInterval === 0) {
      const historyMesh = this.ringPool[this.ringPoolIndex];
      if (historyMesh) {
        historyMesh.visible = true;
        historyMesh.geometry.attributes.position.array.set(positions);
        historyMesh.geometry.attributes.color.array.set(colors);
        historyMesh.geometry.attributes.position.needsUpdate = true;
        historyMesh.geometry.attributes.color.needsUpdate = true;
        this.ringPoolIndex = (this.ringPoolIndex + 1) % this.maxHistoryRings;
      }
    }

    this.orbitGeometry.attributes.position.needsUpdate = true;
    if (colorChanged) {
      this.orbitGeometry.attributes.color.needsUpdate = true;
    }
    this.orbitGeometry.setDrawRange(0, this.orbitSegments);
  }

  setRequirePlaybackState(flag) {
    this.requirePlaybackState = Boolean(flag);
  }

  setAmplitudeMultiplier(value) {
    const numeric = Number(value);
    this.amplitudeMultiplier = Number.isFinite(numeric) && numeric >= 0 ? numeric : 1;
  }

  setRadiusMultiplier(value) {
    const numeric = Number(value);
    this.radiusMultiplier = Number.isFinite(numeric) && numeric >= 0 ? numeric : 1;
    const maxRadius = Math.max(0, this.orbitRadius * this.radiusMultiplier);
    if (this.spiralOffset > maxRadius) {
      this.spiralOffset = 0;
    }
  }

  setEnabled(flag) {
    const next = Boolean(flag);
    if (this.enabled === next) {
      return;
    }
    this.enabled = next;
    this.firstDrawDone = false;
    this.drawFrameCounter = 0;
    this.spiralOffset = 0;
    this.ampHistory.length = 0;
    this.ringPoolIndex = 0;

    if (!next) {
      this._disposeRenderResources();
      return;
    }

    if (next && this.ringGroup && !this.orbitLine) {
      this.ensureOverlay();
    }
  }

  destroy() {
    this._disposeRenderResources();
    if (this.ringGroup?.parent) {
      try { this.ringGroup.parent.remove(this.ringGroup); } catch (_) {}
    }
    this.ringGroup = null;
  }

  setCustomColor(input) {
    if (!input && input !== 0) {
      this.customColor = null;
      this.customAlpha = null;
      if (this.orbitLine?.material && typeof this.orbitLine.material.opacity === 'number') {
        this.orbitLine.material.opacity = this.orbitAlpha;
      }
      this.updateOrbitColor();
      return;
    }

    const value = String(input).trim();
    if (!value.length) {
      this.customColor = null;
      this.customAlpha = null;
      if (this.orbitLine?.material && typeof this.orbitLine.material.opacity === 'number') {
        this.orbitLine.material.opacity = this.orbitAlpha;
      }
      this.updateOrbitColor();
      return;
    }

    const parsed = parseCssColor(value, this.orbitColor);
    if (!parsed) {
      console.warn('[RingOscilloscope] setCustomColor received unparseable value:', input);
      return;
    }
    this.customColor = parsed.color.clone();
    this.customAlpha = parsed.alpha;
    if (this.orbitLine?.material && typeof this.orbitLine.material.opacity === 'number') {
      this.orbitLine.material.opacity = this.customAlpha;
    }
  }
}
