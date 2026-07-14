// @vitest-environment jsdom
/**
 * The buffered reload must ALWAYS settle — never silence. A hung await inside
 * the attempt (a worklet RPC that never answers was observed in the field: the
 * download completes, then nothing — no toast, locks stay, and the wedged
 * single-flight promise silently swallows every retry tap) must surface as a
 * reported failure: resolve false, revert to streaming, free the single-flight
 * slot so a retry is possible.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';
import { StretchPlayerPlayback } from '../../src/audio/playback/stretchPlayer.js';

function fakeStreamingPlayback() {
  return {
    getDecodeStrategy: () => 'stream',
    isPlaying: () => false,
    triggerStop: vi.fn(async () => {}),
    dispose: vi.fn(),
    getLoopRange: () => null,
    isLooping: () => false,
    setSpeedControlLocked: vi.fn(),
    setPerformanceProfile: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('buffered reload watchdog', () => {
  it('a load that never settles resolves false, reverts to streaming, and frees the single flight', async () => {
    vi.useFakeTimers();
    // The swapped-in buffered sink hangs forever inside load().
    vi.spyOn(StretchPlayerPlayback.prototype, 'load').mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const adapter = new AudioEngineAdapter();
    adapter.playback = fakeStreamingPlayback();
    adapter.getCurrentPositionMs = () => 0;
    adapter.seekToMilliseconds = vi.fn(async () => {});

    const pending = adapter.requestBufferedReload();
    expect(adapter.isBufferedReloadPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    const ok = await pending;

    expect(ok).toBe(false); // reported, not silent
    expect(adapter.isBufferedReloadPending()).toBe(false); // retry possible
    expect(adapter._forcePrebuffer).toBe(false); // sticky override cleared
    expect(adapter.playback?.getDecodeStrategy?.()).toBe('stream'); // back on the safe backend
    expect(warn).toHaveBeenCalled();
  });
});
