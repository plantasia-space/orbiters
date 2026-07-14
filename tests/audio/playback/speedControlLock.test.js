import { describe, it, expect, beforeEach } from 'vitest';

import { StreamingPlayer } from '../../../src/audio/playback/streamingPlayer.js';

// The mobile speed lock must be one reliable gate at the playback-engine sink, so no
// tempo-change path — knob, transport warp (`_syncWrapPlaybackRate`), or the effect automation
// bridge (which routes through the synthetic rate param) — can change audio speed while locked.
describe('StreamingPlayer speed control lock', () => {
  let player;

  beforeEach(() => {
    player = new StreamingPlayer({ trackData: null });
    // Stub the media element so rate writes are observable without real audio.
    player.audio = { playbackRate: 1 };
  });

  it('applies rate writes when unlocked', () => {
    player.setPlaybackRate(1.25, { immediate: true });
    expect(player.getPlaybackRate()).toBeCloseTo(1.25);
    expect(player.audio.playbackRate).toBeCloseTo(1.25);
  });

  it('blocks direct rate writes (knob / transport warp path) once locked', () => {
    player.setSpeedControlLocked(true);
    player.setPlaybackRate(1.5, { immediate: true });
    expect(player.getPlaybackRate()).toBe(1);
    expect(player.audio.playbackRate).toBe(1);
  });

  it('blocks the effect automation bridge path (synthetic rate param) once locked', () => {
    player.setSpeedControlLocked(true);
    const rateParam = player.getPlaybackRateParam();
    // The tempoPitch automation bridge writes the target through this param.
    rateParam.rampTo(1.8);
    rateParam.setValueAtTime(2.0);
    expect(player.getPlaybackRate()).toBe(1);
    expect(player.audio.playbackRate).toBe(1);
  });

  it('pins any already-applied rate back to native when the lock engages', () => {
    player.setPlaybackRate(1.4, { immediate: true });
    expect(player.audio.playbackRate).toBeCloseTo(1.4);
    player.setSpeedControlLocked(true);
    expect(player.getPlaybackRate()).toBe(1);
    expect(player.audio.playbackRate).toBe(1);
  });

  it('restores rate control when unlocked again (desktop / lock lifted)', () => {
    player.setSpeedControlLocked(true);
    player.setPlaybackRate(1.5, { immediate: true });
    expect(player.getPlaybackRate()).toBe(1);

    player.setSpeedControlLocked(false);
    player.setPlaybackRate(1.5, { immediate: true });
    expect(player.getPlaybackRate()).toBeCloseTo(1.5);
    expect(player.audio.playbackRate).toBeCloseTo(1.5);
  });
});
