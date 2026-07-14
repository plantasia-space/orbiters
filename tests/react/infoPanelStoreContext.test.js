// @vitest-environment jsdom
/**
 * The Info panel (Engine Monitor) starts CLOSED on mobile (screen space is scarce; the user
 * opens it on demand from the header menu) and OPEN on desktop. The default is decided from the viewport
 * SYNCHRONOUSLY at mount in `InfoPanelStoreProvider` (jsdom/CSR has no SSR pass), so it is tested through
 * the provider with a stubbed `window.matchMedia`, not the pure factory.
 */
import React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import {
  InfoPanelStoreProvider,
  useInfoPanelStore,
} from '../../src/ui/react/regions/InfoPanelStoreContext';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Stub matchMedia so every query reports `matches === isMobile` (the provider reads it synchronously). */
function stubMatchMedia(isMobile) {
  window.matchMedia = (query) => ({
    matches: isMobile,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

afterEach(() => {
  delete window.matchMedia;
  document.body.innerHTML = '';
});

/** Mount the provider and capture the initial Info mode a consumer sees. */
function mountAndReadMode() {
  let captured;
  function Probe() {
    captured = useInfoPanelStore().getMode();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(InfoPanelStoreProvider, null, React.createElement(Probe)),
    );
  });
  act(() => root.unmount());
  return captured;
}

describe('InfoPanelStoreProvider default', () => {
  it('starts with the Engine Monitor OPEN on desktop', () => {
    stubMatchMedia(false);
    expect(mountAndReadMode()).toBe('monitor');
  });

  it('starts with the panel CLOSED on mobile', () => {
    stubMatchMedia(true);
    expect(mountAndReadMode()).toBeNull();
  });
});
