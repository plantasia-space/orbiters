// @vitest-environment jsdom
/**
 * "Unlock speed" — the user override that forces a streaming track into the buffered/RAM backend.
 * Pins the contract: success only after the REAL download/decode resolves (never at swap time),
 * single-flight (repeat taps join the in-flight attempt), and full revert to streaming on failure
 * with the sticky override cleared. The strategy owner (#resolveDecodeStrategy) stays the only
 * lock writer — these tests observe it through the public speed-control state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';
import { PlayerPlayback } from '../../src/audio/playback/player.js';
import { StreamingPlayer } from '../../src/audio/playback/streamingPlayer.js';

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

describe('AudioEngineAdapter.requestBufferedReload — the Unlock speed override', () => {
  let adapter;

  beforeEach(() => {
    adapter = new AudioEngineAdapter();
    adapter.playback = fakeStreamingPlayback();
    adapter.getCurrentPositionMs = () => 1234;
    adapter.seekToMilliseconds = vi.fn(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succeeds only after the real buffered load resolves, then sticks to prebuffer', async () => {
    const load = vi.spyOn(PlayerPlayback.prototype, 'load').mockResolvedValue(undefined);

    const ok = await adapter.requestBufferedReload();

    expect(ok).toBe(true);
    expect(load).toHaveBeenCalled(); // the download/decode IS the success criterion
    expect(adapter.playback).toBeInstanceOf(PlayerPlayback);
    expect(adapter._forcePrebuffer).toBe(true); // sticky: later re-resolves keep prebuffer
    expect(adapter.getSpeedControlState().disabled).toBe(false);
    expect(adapter.seekToMilliseconds).toHaveBeenCalledWith(1234); // position survives the reload
    expect(adapter.isBufferedReloadPending()).toBe(false);
  });

  it('reverts to streaming and clears the override when the buffered load fails', async () => {
    vi.spyOn(PlayerPlayback.prototype, 'load').mockRejectedValue(new Error('decode failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ok = await adapter.requestBufferedReload();

    expect(ok).toBe(false);
    expect(adapter._forcePrebuffer).toBe(false); // no sticky override after a failure
    expect(adapter.playback).toBeInstanceOf(StreamingPlayer); // back on the safe backend
    expect(adapter.isBufferedReloadPending()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('is single-flight: a second call while in flight joins the first attempt', async () => {
    let release;
    const load = vi.spyOn(PlayerPlayback.prototype, 'load')
      .mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const first = adapter.requestBufferedReload();
    const second = adapter.requestBufferedReload();
    expect(adapter.isBufferedReloadPending()).toBe(true);

    // Let the swap reach the load stage, then release it.
    await vi.waitFor(() => { expect(load).toHaveBeenCalled(); });
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(load).toHaveBeenCalledTimes(1); // one reload, not two interleaved swaps
  });

  it('keeps the speed lock ENGAGED until the real load resolves (never unlocks at swap time)', async () => {
    adapter._speedControlDisabled = true; // the mobile-stream lock is on
    let release;
    vi.spyOn(PlayerPlayback.prototype, 'load')
      .mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const pending = adapter.requestBufferedReload();
    await vi.waitFor(() => { expect(release).toBeTypeOf('function'); });
    // Backend already swapped, download still running — the lock must still be on.
    expect(adapter.getSpeedControlState().disabled).toBe(true);

    release();
    await pending;
    expect(adapter.getSpeedControlState().disabled).toBe(false); // only now
  });

  it('stops playback FIRST when the track is playing (a live engine cannot be swapped)', async () => {
    adapter.playback = { ...fakeStreamingPlayback(), isPlaying: () => true };
    const calls = [];
    adapter.stop = vi.fn(async () => { calls.push('stop'); });
    vi.spyOn(PlayerPlayback.prototype, 'load').mockImplementation(async () => { calls.push('load'); });

    const ok = await adapter.requestBufferedReload();

    expect(ok).toBe(true);
    expect(calls[0]).toBe('stop'); // stop precedes the swap + download
    expect(calls).toContain('load');
  });

  it('a play() during the reload joins it instead of racing a second load', async () => {
    let release;
    const load = vi.spyOn(PlayerPlayback.prototype, 'load')
      .mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const reload = adapter.requestBufferedReload();
    await vi.waitFor(() => { expect(load).toHaveBeenCalled(); });

    // play() must wait for the reload's promise, not start its own load on the half-ready backend.
    let playResumed = false;
    adapter._cancelPendingQuantizedStart = () => { playResumed = true; throw new Error('stop-test-here'); };
    const play = adapter.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(playResumed).toBe(false); // still parked on the reload

    release();
    await reload;
    await play;
    expect(playResumed).toBe(true); // proceeded only after the reload settled
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when already buffered and unlocked', async () => {
    adapter.playback = { ...fakeStreamingPlayback(), getDecodeStrategy: () => 'prebuffer' };
    const ok = await adapter.requestBufferedReload();
    expect(ok).toBe(true);
    expect(adapter.playback.getDecodeStrategy()).toBe('prebuffer'); // untouched, no swap
  });
});
