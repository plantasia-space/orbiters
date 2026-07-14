// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('ensureSilentAudioUnlock', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
  });

  it('creates the silent audio element on demand for embedded hosts', async () => {
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    const originalCreateElement = document.createElement.bind(document);

    vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === 'audio') {
        element.play = play;
        element.pause = pause;
      }
      return element;
    });

    const { ensureSilentAudioUnlock, hasUnlockedAudio } = await import(
      '../../src/audio/SilentAudioUnlock.js'
    );

    await expect(ensureSilentAudioUnlock()).resolves.toBe(true);

    const audioElement = document.querySelector('[data-silent-audio-unlock]');
    expect(audioElement).toBeTruthy();
    expect(audioElement?.getAttribute('playsinline')).toBe('true');
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(hasUnlockedAudio()).toBe(true);
  });
});
