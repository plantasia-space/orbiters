// @vitest-environment jsdom
/**
 * Per-device manual audio offset store (config/audioOffset.js).
 *
 * The offset is the by-ear latency calibration: positive = fire earlier. These tests pin the
 * resolution order (URL > localStorage > 0), clamping, persistence, and the change event that lets a
 * UI reflect it live.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MAX_ABS_OFFSET_MS,
  AUDIO_OFFSET_CHANGED_EVENT,
  clampAudioOffsetMs,
  getManualAudioOffsetMs,
  getManualAudioOffsetSec,
  setManualAudioOffsetMs,
  installAudioOffsetRuntimeHandle,
  __resetAudioOffsetCacheForTests,
} from '../../src/config/audioOffset.js';

function setSearch(search) {
  // jsdom lets us override the search string without a full navigation.
  window.history.replaceState({}, '', `${window.location.pathname}${search}`);
}

beforeEach(() => {
  window.localStorage.clear();
  setSearch('');
  delete window.orbitersAudioOffset;
  __resetAudioOffsetCacheForTests();
});
afterEach(() => {
  window.localStorage.clear();
  setSearch('');
});

describe('clampAudioOffsetMs', () => {
  it('rounds to an integer and bounds to ±MAX_ABS_OFFSET_MS', () => {
    expect(clampAudioOffsetMs(90.4)).toBe(90);
    expect(clampAudioOffsetMs(-90.6)).toBe(-91);
    expect(clampAudioOffsetMs(9999)).toBe(MAX_ABS_OFFSET_MS);
    expect(clampAudioOffsetMs(-9999)).toBe(-MAX_ABS_OFFSET_MS);
  });
  it('maps non-finite / garbage to 0', () => {
    expect(clampAudioOffsetMs(NaN)).toBe(0);
    expect(clampAudioOffsetMs(Infinity)).toBe(0);
    expect(clampAudioOffsetMs('nope')).toBe(0);
    expect(clampAudioOffsetMs(null)).toBe(0);
  });
});

describe('resolution order', () => {
  it('defaults to 0 with no URL param and no storage', () => {
    expect(getManualAudioOffsetMs()).toBe(0);
    expect(getManualAudioOffsetSec()).toBe(0);
  });

  it('reads the persisted localStorage value', () => {
    window.localStorage.setItem('audioOffsetMs', '120');
    expect(getManualAudioOffsetMs()).toBe(120);
    expect(getManualAudioOffsetSec()).toBeCloseTo(0.12, 6);
  });

  it('URL ?audioOffset= wins over localStorage (per-device bookmark override)', () => {
    window.localStorage.setItem('audioOffsetMs', '120');
    setSearch('?audioOffset=45');
    __resetAudioOffsetCacheForTests();
    expect(getManualAudioOffsetMs()).toBe(45);
  });

  it('clamps a persisted out-of-range value on read', () => {
    window.localStorage.setItem('audioOffsetMs', '99999');
    expect(getManualAudioOffsetMs()).toBe(MAX_ABS_OFFSET_MS);
  });

  it('caches after the first read (storage change alone does not leak in)', () => {
    expect(getManualAudioOffsetMs()).toBe(0);
    window.localStorage.setItem('audioOffsetMs', '200');
    expect(getManualAudioOffsetMs()).toBe(0); // still cached
    __resetAudioOffsetCacheForTests();
    expect(getManualAudioOffsetMs()).toBe(200);
  });
});

describe('setManualAudioOffsetMs', () => {
  it('updates the live value, persists, and returns the clamped result', () => {
    const stored = setManualAudioOffsetMs(90);
    expect(stored).toBe(90);
    expect(getManualAudioOffsetMs()).toBe(90);
    expect(window.localStorage.getItem('audioOffsetMs')).toBe('90');
  });

  it('clamps on set', () => {
    expect(setManualAudioOffsetMs(10_000)).toBe(MAX_ABS_OFFSET_MS);
    expect(getManualAudioOffsetMs()).toBe(MAX_ABS_OFFSET_MS);
  });

  it('persist:false updates the live value without touching storage', () => {
    setManualAudioOffsetMs(60, { persist: false });
    expect(getManualAudioOffsetMs()).toBe(60);
    expect(window.localStorage.getItem('audioOffsetMs')).toBeNull();
  });

  it('dispatches the change event with the new value', () => {
    const seen = [];
    const onChange = (e) => seen.push(e.detail.offsetMs);
    window.addEventListener(AUDIO_OFFSET_CHANGED_EVENT, onChange);
    setManualAudioOffsetMs(-75);
    window.removeEventListener(AUDIO_OFFSET_CHANGED_EVENT, onChange);
    expect(seen).toEqual([-75]);
  });
});

describe('installAudioOffsetRuntimeHandle', () => {
  it('exposes get/set on window.orbitersAudioOffset for by-ear tuning', () => {
    installAudioOffsetRuntimeHandle();
    expect(window.orbitersAudioOffset).toBeTruthy();
    window.orbitersAudioOffset.set(110);
    expect(window.orbitersAudioOffset.get()).toBe(110);
    expect(getManualAudioOffsetMs()).toBe(110);
    expect(window.orbitersAudioOffset.maxAbsMs).toBe(MAX_ABS_OFFSET_MS);
  });
});
