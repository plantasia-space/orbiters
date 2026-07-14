// @vitest-environment jsdom
/**
 * The full lock→unlock round trip for engine-feature locks: a long streamed
 * track with an engine-requiring module (granular) locks that module's
 * parameter dimension; a SUCCESSFUL buffered reload ("Unlock speed" / "Load
 * full track") must clear the engine-feature block and unlock the dimension —
 * the whole point of loading the buffer is that the controls come back.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';
import { PlayerPlayback } from '../../src/audio/playback/player.js';

const LONG_TRACK = { durationMs: 20 * 60 * 1000 };
const GRANULAR_CONFIG = {
  effects: {
    z: { dimensionId: 'dim-1', modules: [{ effectId: 'granular', moduleId: 'cloud', dimensionId: 'dim-1' }] },
  },
};

function makeUserManager() {
  const locked = new Set();
  return {
    locked,
    lockParameterDimension: vi.fn((axis, dimensionId) => locked.add(`${axis}::${dimensionId}`)),
    unlockParameterDimension: vi.fn((axis, dimensionId) => locked.delete(`${axis}::${dimensionId}`)),
  };
}

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
  vi.restoreAllMocks();
});

describe('buffered reload — engine-feature locks', () => {
  it('a successful load clears the engine block and unlocks the module dimension', async () => {
    const userManager = makeUserManager();
    const adapter = new AudioEngineAdapter({
      trackData: { track: LONG_TRACK },
      engineConfig: GRANULAR_CONFIG,
      userManager,
    });
    adapter.playback = fakeStreamingPlayback();
    adapter.getCurrentPositionMs = () => 0;
    adapter.seekToMilliseconds = vi.fn(async () => {});

    // The long streamed track + granular module locks the module's dimension.
    expect(adapter.getPlaybackStrategyInfo().engineFeaturesBlocked).toBe(true);
    expect(userManager.locked.has('z::dim-1')).toBe(true);

    vi.spyOn(PlayerPlayback.prototype, 'load').mockResolvedValue(undefined);
    const ok = await adapter.requestBufferedReload();

    expect(ok).toBe(true);
    // The buffer is live: the block must clear and the dimension must unlock.
    expect(adapter.getPlaybackStrategyInfo().engineFeaturesBlocked).toBe(false);
    expect(userManager.locked.has('z::dim-1')).toBe(false);
  });

  it('the unlock swap rebinds hosted source engines to the NEW backend, before its load', async () => {
    const adapter = new AudioEngineAdapter({
      trackData: { track: LONG_TRACK },
      engineConfig: GRANULAR_CONFIG,
      userManager: makeUserManager(),
    });
    adapter.playback = fakeStreamingPlayback();
    adapter.getCurrentPositionMs = () => 0;
    adapter.seekToMilliseconds = vi.fn(async () => {});

    // A granular engine acquired while the voice streamed renders natively;
    // the swap must hand it the new sink's surface or it stays silent for
    // every module — including ones added after the unlock. Record WHEN the
    // rebind fires and WHICH backend is live at that moment: it must see the
    // buffered sink already in place (so engines bind to the new surface),
    // and run before the buffer upload so params are installed by the time
    // audio can flow. Engine↔surface semantics are pinned at the host and
    // engine seams (sourceEngineHost.test.js, granularEngine.test.js).
    const order = [];
    vi.spyOn(adapter._sourceEngines, 'rebind').mockImplementation(() => {
      order.push({ event: 'rebind', strategy: adapter.playback?.getDecodeStrategy?.() ?? null });
    });
    vi.spyOn(PlayerPlayback.prototype, 'load').mockImplementation(async () => {
      order.push({ event: 'load' });
    });

    const ok = await adapter.requestBufferedReload();

    expect(ok).toBe(true);
    const rebindIndex = order.findIndex((entry) => entry.event === 'rebind');
    const loadIndex = order.findIndex((entry) => entry.event === 'load');
    expect(rebindIndex).toBeGreaterThanOrEqual(0);
    expect(loadIndex).toBeGreaterThan(rebindIndex);
    expect(order[rebindIndex].strategy).not.toBe('stream');
  });
});
