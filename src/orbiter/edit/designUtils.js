// Color C — the selected/active highlight ("success"). The long-standing selected green, used as the
// single fallback everywhere a `colorC` / `color3` default is needed (design default, edit-panel +
// orbiter fallbacks, the live `color3` resolve). The CSS layer mirrors it as `--orb-default-color3`
// in orbitersUI.css — keep the two in sync.
export const DEFAULT_COLOR_C = '#33ff41';

export const DEFAULT_DESIGN = Object.freeze({
  colorPrimary: '#ffffff',
  colorSecondary: '#3de5feff',
  // Defaults to the long-standing selected green so existing orbiters look identical until edited.
  colorC: DEFAULT_COLOR_C,
  roundedCorners: 12,
  frameBorderWidth: 2,
  fontFamily: 'Inter, sans-serif',
  fontId: null,
  fontImportUrl: null,
  fontLabel: null,
  themeId: null,
  themeLabel: null,
  themeVariant: null,
  ringColor: '#ffffff',
  ringAmplitudeMultiplier: 1,
  ringRadiusMultiplier: 1,
  ringEnabled: true,
});

export function normalizeColorValue(value, fallback) {
  if (!value) return fallback;
  const str = String(value).trim();

  const hex6 = str.match(/^(?:#|0x)?([a-f0-9]{6})$/i);
  if (hex6) {
    return `#${hex6[1].toLowerCase()}`;
  }

  const hex3 = str.match(/^#?([a-f0-9])([a-f0-9])([a-f0-9])$/i);
  if (hex3) {
    const r = hex3[1].repeat(2);
    const g = hex3[2].repeat(2);
    const b = hex3[3].repeat(2);
    return `#${(r + g + b).toLowerCase()}`;
  }

  const rgb = str.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (rgb) {
    const clamp = (component) => Math.min(255, Math.max(0, Number(component) || 0));
    const r = clamp(rgb[1]).toString(16).padStart(2, '0');
    const g = clamp(rgb[2]).toString(16).padStart(2, '0');
    const b = clamp(rgb[3]).toString(16).padStart(2, '0');
    return `#${(r + g + b).toLowerCase()}`;
  }

  return fallback;
}

export default {
  DEFAULT_DESIGN,
  normalizeColorValue,
};
