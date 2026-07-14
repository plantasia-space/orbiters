/**
 * @file src/config/performance.js
 * @description Graphics performance presets and helpers for mapping query params to presets.
 */
/**
 * Graphics performance presets shared across renderer, scene, and UI layers.
 * Each preset keeps the main render loop smooth while exposing knobs that
 * influence GPU cost, texture quality, and monitor refresh cadence.
 */
export const GRAPHICS_PRESETS = {
  LOW: {
    key: 'LOW',
    label: 'low',
    maxDevicePixelRatio: 1, // Clamp DPR aggressively for fill-rate savings on modest GPUs.
    antialias: false, // Disable MSAA at the renderer level to reduce resolve cost.
    shadowsEnabled: false,
    ringHistoryRings: 20, // Smaller ring pool is sufficient at installation distance.
    ringOrbitSegments: 128, // Halve oscilloscope segments — fewer verts to rewrite + upload each frame.
    uiMonitorThrottleMs: 180, // ~5.5 UI updates per second keeps DOM work lightweight.
  },
  MID: {
    key: 'MID',
    label: 'mid',
    maxDevicePixelRatio: 1.25,
    antialias: true,
    shadowsEnabled: true,
    ringHistoryRings: 40,
    ringOrbitSegments: 256,
    uiMonitorThrottleMs: 120, // Keeps UI fluid (~8 fps) without matching render cadence.
  },
  HIGH: {
    key: 'HIGH',
    label: 'high',
    maxDevicePixelRatio: 1.5, // Matches previous default behaviour for visuals.
    antialias: true,
    shadowsEnabled: true,
    ringHistoryRings: 64,
    ringOrbitSegments: 256,
    uiMonitorThrottleMs: 0, // Allow monitors to update every requestAnimationFrame.
  },
};

const PRESET_ALIAS = {
  low: 'LOW',
  LOW: 'LOW',
  mid: 'MID',
  MID: 'MID',
  high: 'HIGH',
  HIGH: 'HIGH',
};

/**
 * Normalises a string value to a known preset key.
 * @param {string|null|undefined} value
 * @returns {'LOW'|'MID'|'HIGH'|null}
 */
export function normalizeGraphicsPresetKey(value) {
  if (!value) return null;
  const candidate = PRESET_ALIAS[String(value).trim()];
  return candidate ?? null;
}

/**
 * Resolves the active graphics preset using public (?graphics=low|high) and
 * internal (?perf=LOW|MID|HIGH) entry points. The internal override wins.
 * @param {URLSearchParams|string|undefined} params
 * @returns {{ key: 'LOW'|'MID'|'HIGH', preset: typeof GRAPHICS_PRESETS.HIGH, source: string }}
 */
export function resolveGraphicsPreset(params) {
  const search =
    params instanceof URLSearchParams
      ? params
      : new URLSearchParams(typeof params === 'string' ? params : window.location?.search ?? '');

  const override = normalizeGraphicsPresetKey(search.get('perf'));
  if (override && GRAPHICS_PRESETS[override]) {
    return {
      key: override,
      preset: GRAPHICS_PRESETS[override],
      source: 'perf',
    };
  }

  const graphicsParam = normalizeGraphicsPresetKey(search.get('graphics'));
  if (graphicsParam && GRAPHICS_PRESETS[graphicsParam]) {
    return {
      key: graphicsParam,
      preset: GRAPHICS_PRESETS[graphicsParam],
      source: 'graphics',
    };
  }

  return {
    key: 'MID',
    preset: GRAPHICS_PRESETS.MID,
    source: 'default',
  };
}

/**
 * Utility helper for downstream modules that only need the preset object.
 * @param {'LOW'|'MID'|'HIGH'} key
 * @returns {typeof GRAPHICS_PRESETS.HIGH}
 */
export function getGraphicsPresetByKey(key) {
  return GRAPHICS_PRESETS[key] ?? GRAPHICS_PRESETS.MID;
}
