export const NAV_BREAKPOINT = 1268;
export const MOBILE_LANDSCAPE_MIN_WIDTH = 1120;

/**
 * Height threshold (px) below which the playback toolbar collapses its
 * controls into a disclosure drawer, keeping the waveform large.
 * Adjust this single value to tune when the compact layout activates.
 */
export const PLAYBACK_TOOLBAR_COLLAPSE_HEIGHT = 600;

export const NavViewportState = Object.freeze({
  DESKTOP: 'desktop',
  MOBILE_LANDSCAPE: 'mobileLandscape',
  MOBILE_PORTRAIT: 'mobilePortrait',
});

export function computeNavViewportState(width, height) {
  const viewportWidth = Number(width) || 0;
  const viewportHeight = Number(height) || 0;

  if (viewportWidth >= NAV_BREAKPOINT) {
    return NavViewportState.DESKTOP;
  }

  const isLandscape = viewportWidth > viewportHeight;
  if (isLandscape && viewportWidth >= MOBILE_LANDSCAPE_MIN_WIDTH) {
    return NavViewportState.MOBILE_LANDSCAPE;
  }

  return NavViewportState.MOBILE_PORTRAIT;
}

export function isMobileState(state) {
  return state === NavViewportState.MOBILE_LANDSCAPE || state === NavViewportState.MOBILE_PORTRAIT;
}
