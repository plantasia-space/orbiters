// @vitest-environment jsdom
/**
 * The manual audio offset is applied as a PLAYHEAD LEAD, not a fire-delay.
 *
 * The offset leads the aligned source read-head so this device's audio comes out earlier
 * (output-latency compensation). It lives in the one owner of the beat→playhead mapping
 * (`Deck.computeAlignedSourcePositionMs`), so it survives the re-alignment at quantized-start
 * fire time and every periodic re-align — the reason a fire-delay shift would have been a no-op.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// _alignWrapPlaybackPosition reads the real syncCoordinator singleton for the enabled gate.
vi.mock('../../src/sync/SyncCoordinator.js', () => {
  const syncCoordinator = { isEnabled: true, getCurrentBeat: () => 0 };
  return { syncCoordinator };
});

import { Deck } from '../../src/voice/Deck.js';
import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';
import { syncCoordinator } from '../../src/sync/SyncCoordinator.js';
import {
  setManualAudioOffsetMs,
  __resetAudioOffsetCacheForTests,
} from '../../src/config/audioOffset.js';

// A deck with a known beat→source mapping. beat 5 at native 120bpm, grid start 0:
//   sourceTimeSec = 0 + (5-1) * (60/120) = 2.0s → 2000ms
// baseRate 2 = the deck's transport at 240 over native 120 (followRatio 2).
function makeGrid({ baseRate = 1 } = {}) {
  const deck = new Deck({
    voiceId: null,
    collection: true,
    trackData: { track: { metadata: { trackBpm: 120 } } },
  });
  if (baseRate !== 1) deck.setTempo(120 * baseRate);
  deck.getCurrentSyncBeat = () => 5;
  return deck;
}

afterEach(() => {
  setManualAudioOffsetMs(0, { persist: false });
  __resetAudioOffsetCacheForTests();
});

describe('Deck.computeAlignedSourcePositionMs — outputLeadMs (playhead lead)', () => {
  it('offset 0 (default) leaves the aligned position untouched', () => {
    expect(makeGrid().computeAlignedSourcePositionMs({ durationMs: 100_000 })).toBeCloseTo(2000, 6);
    expect(makeGrid().computeAlignedSourcePositionMs({ durationMs: 100_000, outputLeadMs: 0 })).toBeCloseTo(2000, 6);
  });

  it('a positive lead advances the read-head (plays ahead → earlier acoustically)', () => {
    // +150 ms of WALL lead at rate 1 → +150 ms of source → 2150
    expect(makeGrid().computeAlignedSourcePositionMs({ durationMs: 100_000, outputLeadMs: 150 })).toBeCloseTo(2150, 6);
  });

  it('a negative lead retards the read-head (plays behind → later acoustically)', () => {
    expect(makeGrid().computeAlignedSourcePositionMs({ durationMs: 100_000, outputLeadMs: -100 })).toBeCloseTo(1900, 6);
  });

  it('scales wall-ms → source by the sync playback rate (baseRate)', () => {
    // rate 2: 150 ms of wall time is 300 ms of source → 2300
    expect(makeGrid({ baseRate: 2 }).computeAlignedSourcePositionMs({ durationMs: 100_000, outputLeadMs: 150 })).toBeCloseTo(2300, 6);
  });

  it('wraps the led position within the loop range', () => {
    // loop [0,2000): base 2000 wraps to 0; +150 lead → 150
    const led = makeGrid().computeAlignedSourcePositionMs({
      durationMs: 100_000,
      loopRange: { start: 0, end: 2000 },
      outputLeadMs: 150,
    });
    expect(led).toBeCloseTo(150, 6);
  });
});

describe('Deck.leadSourcePositionMs (shared by start + seek)', () => {
  it('is a pure no-op for a zero lead — returns the raw ms unchanged (not even re-wrapped)', () => {
    const w = makeGrid();
    expect(w.leadSourcePositionMs(123456, { durationMs: 1000, outputLeadMs: 0 })).toBe(123456);
  });

  it('advances by outputLeadMs × rate and wraps within the track', () => {
    expect(makeGrid().leadSourcePositionMs(1000, { durationMs: 100_000, outputLeadMs: 150 })).toBeCloseTo(1150, 6);
    expect(makeGrid({ baseRate: 2 }).leadSourcePositionMs(1000, { durationMs: 100_000, outputLeadMs: 150 })).toBeCloseTo(1300, 6);
  });
});

describe('_alignWrapPlaybackPosition threads the manual offset', () => {
  function makeAdapter() {
    const a = Object.create(AudioEngineAdapter.prototype);
    const calls = { compute: [], setPosition: [] };
    a.deck = {
      computeAlignedSourcePositionMs: (opts) => {
        calls.compute.push(opts);
        // echo a deterministic position that reflects the lead so we can assert setPosition too
        return 2000 + (Number(opts.outputLeadMs) || 0);
      },
    };
    a.getDurationMs = () => 100_000;
    a.playback = {
      getDurationMs: () => 100_000,
      getLoopRange: () => null,
      getCurrentPositionMs: () => 0,
      setPosition: (ms) => { calls.setPosition.push(ms); return Promise.resolve(); },
    };
    a.mediaSession = { syncPositionState: () => {} };
    return { a, calls };
  }

  beforeEach(() => {
    syncCoordinator.isEnabled = true;
  });

  it('passes the current offset as outputLeadMs and seeks to the led position', async () => {
    setManualAudioOffsetMs(150, { persist: false });
    const { a, calls } = makeAdapter();
    await a._alignWrapPlaybackPosition({ force: true });
    expect(calls.compute.at(-1)).toMatchObject({ outputLeadMs: 150 });
    expect(calls.setPosition.at(-1)).toBe(2150);
  });

  it('offset 0 → outputLeadMs 0 (unchanged alignment)', async () => {
    setManualAudioOffsetMs(0, { persist: false });
    const { a, calls } = makeAdapter();
    await a._alignWrapPlaybackPosition({ force: true });
    expect(calls.compute.at(-1)).toMatchObject({ outputLeadMs: 0 });
    expect(calls.setPosition.at(-1)).toBe(2000);
  });

  it('does nothing when sync is disabled (offset is inaudible solo)', async () => {
    syncCoordinator.isEnabled = false;
    setManualAudioOffsetMs(150, { persist: false });
    const { a, calls } = makeAdapter();
    await a._alignWrapPlaybackPosition({ force: true });
    expect(calls.compute).toHaveLength(0);
    expect(calls.setPosition).toHaveLength(0);
  });
});

describe('_seekNow carries the manual offset (keeps output-latency compensation across seeks)', () => {
  function makeSeekAdapter({ baseRate = 1 } = {}) {
    const a = Object.create(AudioEngineAdapter.prototype);
    a.deck = makeGrid({ baseRate });
    a.getDurationMs = () => 100_000;
    const seeks = [];
    const positions = [];
    a.transport = { seek: (ms) => { seeks.push(ms); return Promise.resolve(); }, clearLoop: () => {} };
    a.playback = {
      getLoopRange: () => null,
      isLooping: () => false,
      getDurationMs: () => 100_000,
      setPosition: (ms) => { positions.push(ms); return Promise.resolve(); },
      clearLoop: () => {},
    };
    a.mediaSession = { syncPositionState: () => {} };
    return { a, seeks, positions };
  }

  beforeEach(() => { syncCoordinator.isEnabled = true; });

  it('a seek during synced playback lands at target + lead (keeps compensation)', async () => {
    setManualAudioOffsetMs(150, { persist: false });
    const { a, seeks, positions } = makeSeekAdapter();
    await a._seekNow(5000);
    expect(seeks.at(-1)).toBeCloseTo(5150, 6);
    expect(positions.at(-1)).toBeCloseTo(5150, 6);
  });

  it('offset 0 → byte-identical raw seek', async () => {
    setManualAudioOffsetMs(0, { persist: false });
    const { a, seeks, positions } = makeSeekAdapter();
    await a._seekNow(5000);
    expect(seeks.at(-1)).toBe(5000);
    expect(positions.at(-1)).toBe(5000);
  });

  it('sync disabled → raw seek (offset inaudible solo)', async () => {
    syncCoordinator.isEnabled = false;
    setManualAudioOffsetMs(150, { persist: false });
    const { a, seeks, positions } = makeSeekAdapter();
    await a._seekNow(5000);
    expect(seeks.at(-1)).toBe(5000);
    expect(positions.at(-1)).toBe(5000);
  });
});
