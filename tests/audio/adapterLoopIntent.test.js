// @vitest-environment node
/**
 * Loop-intent flag (`__desiredLoopMode`) must follow the enable/disable intent from EVERY path, so a
 * disabled loop is respected on play. The bug: editing loop markers while loop is OFF passes
 * `setLoopRange(..., { active: false })`, which left `__desiredLoopMode` stuck `true` from a prior
 * enable — so `_ensureDefaultLoopRange()` re-engaged the loop on the next play instead of playing
 * straight through from the playhead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';

function makeAdapter() {
  const adapter = Object.create(AudioEngineAdapter.prototype);
  adapter.playback = {
    _range: null,
    _looping: false,
    getLoopRange() { return this._range; },
    isLooping() { return this._looping; },
    hasLoopRange() { return this._range != null; },
    setLoopRange(startMs, endMs, { active } = {}) {
      this._range = { start: startMs, end: endMs };
      this._looping = Boolean(active);
    },
    setLoopEnabled(active) { this._looping = Boolean(active); },
    getDurationMs() { return 10000; },
  };
  adapter.transport = { isLooping: false, setLoopRange: vi.fn(), clearLoop: vi.fn() };
  adapter._deferredLoopRange = null;
  return adapter;
}

describe('AudioEngineAdapter — loop-intent flag tracks disable (refinement #3)', () => {
  let adapter;
  beforeEach(() => { adapter = makeAdapter(); });

  it('setLoopRange({ active: false }) clears __desiredLoopMode even if it was stuck true', () => {
    adapter.__desiredLoopMode = true; // stale from a prior enable
    adapter.setLoopRange(1000, 3000, { active: false });
    expect(adapter.__desiredLoopMode).toBe(false);
  });

  it('setLoopRange({ active: true }) sets __desiredLoopMode true', () => {
    adapter.__desiredLoopMode = false;
    adapter.setLoopRange(1000, 3000, { active: true });
    expect(adapter.__desiredLoopMode).toBe(true);
  });

  it('a disabled loop is NOT re-engaged on play (_ensureDefaultLoopRange no-ops)', () => {
    // Markers exist, but loop was disabled → the next play must not re-enable it.
    adapter.setLoopRange(1000, 3000, { active: false });
    const reengaged = adapter._ensureDefaultLoopRange();
    expect(reengaged).toBe(false);
    expect(adapter.playback.isLooping()).toBe(false);
  });

  it('an enabled loop with markers IS honored on play', () => {
    adapter.setLoopRange(1000, 3000, { active: true });
    adapter.playback._looping = false; // pre-play the player hasn't engaged the loop yet
    const reengaged = adapter._ensureDefaultLoopRange();
    expect(reengaged).toBe(true);
    expect(adapter.playback.isLooping()).toBe(true);
  });
});
