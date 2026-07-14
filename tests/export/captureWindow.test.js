// @vitest-environment jsdom
//
// The capture RECORD button must open the capture window on the CORRECT app URL.
// Two contexts, one helper (`openCaptureWindow`):
//   - Standalone orbiter app (single-orbiter OR the collection studio): reuse the current page URL, so
//     the trackId / collection + graphics/audio/source params are preserved and the capture window is
//     the same orbiter.
//   - Embedded in a host page (the feed's shared realm): the current page is the host site, so reusing
//     it would reopen the whole feed. Instead build the standalone single-orbiter URL for the recording
//     voice's track, off `window.ORBITER_APP_URL`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openCaptureWindow } from '../../src/export/captureWindow.js';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';

describe('openCaptureWindow — capture launch URLs', () => {
  let opened;

  beforeEach(() => {
    voiceRegistry.clear();
    delete window.ORBITER_APP_URL;
    window.history.replaceState({}, '', '/');
    opened = [];
    vi.spyOn(window, 'open').mockImplementation((url) => {
      opened.push(url);
      return { closed: false };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.ORBITER_APP_URL;
    voiceRegistry.clear();
  });

  it('standalone app: reuses the current page URL and appends the capture aspect', () => {
    openCaptureWindow('9:16');
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]);
    expect(url.origin).toBe(window.location.origin);
    expect(url.searchParams.get('capture')).toBe('9:16');
  });

  it('standalone collection: preserves ?collection + graphics/audio/source and adds capture', () => {
    window.history.replaceState({}, '', '/?graphics=low&collection=abc123&lang=en&audio=low&source=host');
    openCaptureWindow('4:5');
    const url = new URL(opened[0]);
    expect(url.searchParams.get('collection')).toBe('abc123');
    expect(url.searchParams.get('graphics')).toBe('low');
    expect(url.searchParams.get('audio')).toBe('low');
    expect(url.searchParams.get('source')).toBe('host');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('capture')).toBe('4:5');
  });

  it('embedded host (feed realm): targets the standalone orbiter app for the voice track, not the host page', () => {
    window.ORBITER_APP_URL = 'https://local.plantasia.space:5173/?lang=en';
    voiceRegistry.register('feed::0', { id: 'feed::0', getTrackId: () => 'track-xyz' });
    voiceRegistry.setActive('feed::0');

    openCaptureWindow('9:16', { voiceId: 'feed::0' });

    const url = new URL(opened[0]);
    // The orbiter app origin, NOT the host page (which is jsdom's localhost origin here).
    expect(url.origin).toBe('https://local.plantasia.space:5173');
    expect(url.origin).not.toBe(window.location.origin);
    expect(url.searchParams.get('trackId')).toBe('track-xyz');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('capture')).toBe('9:16');
  });

  it('embedded host: prefers the voice that opened the dialog over the focused voice', () => {
    window.ORBITER_APP_URL = 'https://local.plantasia.space:5173/';
    voiceRegistry.register('feed::0', { id: 'feed::0', getTrackId: () => 'focused-track' });
    voiceRegistry.register('feed::1', { id: 'feed::1', getTrackId: () => 'recording-track' });
    voiceRegistry.setActive('feed::0'); // focus is voice 0…

    openCaptureWindow('1:1', { voiceId: 'feed::1' }); // …but voice 1 pressed RECORD

    const url = new URL(opened[0]);
    expect(url.searchParams.get('trackId')).toBe('recording-track');
  });

  it('embedded host with no resolvable track: refuses rather than opening the host page', () => {
    window.ORBITER_APP_URL = 'https://local.plantasia.space:5173/';
    const result = openCaptureWindow('1:1', { voiceId: 'missing' });
    expect(result).toBeNull();
    expect(opened).toHaveLength(0);
  });
});
