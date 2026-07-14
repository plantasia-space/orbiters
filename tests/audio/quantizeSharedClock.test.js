// @vitest-environment jsdom
/**
 * Driving slice — AudioEngineAdapter sources the bar-quantized START from the shared clock.
 *
 * Pure-method tests (no full engine construction): the quantize decision/math read
 * `this._sharedClockBeat()` (→ the injected shared-clock source), the SyncCoordinator singleton,
 * and THIS voice's own meter (WrapGridState) — all stubbed here. Proves:
 *   - _computeBarDelayMs picks the SHARED-CLOCK beat when a joined snapshot is present, and the
 *     SyncCoordinator epoch when it isn't (distinct beats ⇒ distinct delays prove the source).
 *   - the bar LENGTH follows THIS voice's OWN meter over that shared beat clock (the shared clock is
 *     meter-agnostic — its `quantum` is not the bar source); a 6/8 voice snaps to a 6/8 bar.
 *   - _shouldQuantizeStart self-enables on a joined shared clock; flag-off path queries nothing new.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Controllable SyncCoordinator singleton (the fallback source).
vi.mock('../../src/sync/SyncCoordinator.js', () => {
  const syncCoordinator = {
    isEnabled: false,
    bpm: 0,
    peerCount: 0,
    _beat: 0,
    getCurrentBeat() { return this._beat; },
  };
  return { syncCoordinator };
});

import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';
import { syncCoordinator } from '../../src/sync/SyncCoordinator.js';
import { setLaunchGridBars, getLaunchGridQuarterBeats, DEFAULT_LAUNCH_GRID_BARS } from '../../src/sync/launchGrid.js';
import { setQuantizeStartForced } from '../../src/sync/debugSync.js';

// Bare instance: these methods don't touch constructor state. The adapter reads the shared clock,
// its own sync status, and its own meter through its DECK — a local stub drives that seam directly.
// THIS voice's own meter — the sole source of the bar LENGTH. Mutable so a test can set a non-4/4
// meter and prove the bar follows it, not the shared clock's quantum.
const ownMeter = { value: '4/4' };
let sharedClockState = null;
function makeDeckStub({ enabled, following = enabled, syncEnabled = enabled } = {}) {
  return {
    getStatusDetail: () => ({ enabled }),
    getSharedClockState: () => sharedClockState,
    // Launch quantize follows warp: the shared bar-delay applies only to a deck that is itself
    // synced AND following (warp on). Collection shape keeps the gate self-contained in tests.
    following,
    isCollection: true,
    syncEnabled,
    get meter() { return ownMeter.value; },
    // The adapter reads the deck's launch grid; route through the module so the tests' existing
    // setLaunchGridBars knobs keep working.
    get launchGridQuarterBeats() { return getLaunchGridQuarterBeats(ownMeter.value); },
  };
}
const adapter = Object.create(AudioEngineAdapter.prototype);
// This voice is synced (the precondition these tests assume) — _sharedClockBeat() also gates on the
// voice's OWN sync-enabled status (a voice with sync off must not quantize off a sibling's session).
adapter.deck = makeDeckStub({ enabled: true });

function stubSharedClock(state) {
  sharedClockState = state;
}

beforeEach(() => {
  Object.assign(syncCoordinator, { isEnabled: false, bpm: 0, peerCount: 0, _beat: 0 });
  ownMeter.value = '4/4';
  sharedClockState = null;
});
afterEach(() => {
  sharedClockState = null;
  setQuantizeStartForced(false);
  // Quantize math tests run with an EXPLICIT 1-bar grid (the default is now 'none' — quantized
  // launching is opt-in); the launch-grid-specific cases below set their own values.
  setLaunchGridBars(1);
});

describe('_snapStartPositionToOwnGrid — unsynced launch snap', () => {
  function makeSnapAdapter({ enabled = false, snapTo = 2000, currentMs = 2300 } = {}) {
    const a = Object.create(AudioEngineAdapter.prototype);
    const calls = { setPosition: [], snap: [] };
    a.deck = {
      getStatusDetail: () => ({ enabled }),
      get meter() { return ownMeter.value; },
      get launchGridQuarterBeats() { return getLaunchGridQuarterBeats(ownMeter.value); },
      snapToOwnGridMs: (pos, opts) => { calls.snap.push({ pos, opts }); return snapTo; },
    };
    a.getDurationMs = () => 100_000;
    a.playback = {
      getCurrentPositionMs: () => currentMs,
      getDurationMs: () => 100_000,
      getLoopRange: () => null,
      setPosition: (ms) => { calls.setPosition.push(ms); return Promise.resolve(); },
    };
    a.mediaSession = { syncPositionState: () => {} };
    return { a, calls };
  }

  it('an unsynced deck start seeks to the deck own-grid boundary', async () => {
    const { a, calls } = makeSnapAdapter({ enabled: false, snapTo: 2000, currentMs: 2300 });
    await a._snapStartPositionToOwnGrid();
    expect(calls.setPosition).toEqual([2000]);
  });

  it('a SYNCED deck is left to the shared-beat alignment (no own-grid snap)', async () => {
    const { a, calls } = makeSnapAdapter({ enabled: true });
    await a._snapStartPositionToOwnGrid();
    expect(calls.snap).toHaveLength(0);
    expect(calls.setPosition).toHaveLength(0);
  });

  it('nothing to snap to (deck returns null) → the start position is untouched', async () => {
    const { a, calls } = makeSnapAdapter({ enabled: false, snapTo: null });
    await a._snapStartPositionToOwnGrid();
    expect(calls.setPosition).toHaveLength(0);
  });

  it('already on the boundary → no redundant seek', async () => {
    const { a, calls } = makeSnapAdapter({ enabled: false, snapTo: 2300, currentMs: 2300 });
    await a._snapStartPositionToOwnGrid();
    expect(calls.setPosition).toHaveLength(0);
  });
});

describe('_sharedClockBeat', () => {
  it('returns null with no shared clock, null when not joined, the snapshot when joined', () => {
    expect(adapter._sharedClockBeat()).toBeNull();

    stubSharedClock(null);
    expect(adapter._sharedClockBeat()).toBeNull();

    stubSharedClock({ joined: false, beatNow: 1 });
    expect(adapter._sharedClockBeat()).toBeNull();

    const joined = { joined: true, beatNow: 2, phaseNow: 2, tempoBpm: 120, quantum: 4 };
    stubSharedClock(joined);
    expect(adapter._sharedClockBeat()).toBe(joined);
  });

  it('returns null when THIS voice has its own sync OFF, even though the realm-wide clock is joined', () => {
    // A voice with sync explicitly off must not quantize its own play/seek off of siblings' shared
    // session just because the aggregate/realm clock happens to be joined (≥2 OTHER voices synced).
    const soloVoiceAdapter = Object.create(AudioEngineAdapter.prototype);
    soloVoiceAdapter.deck = makeDeckStub({ enabled: false }); // this voice's OWN sync is off

    const joined = { joined: true, beatNow: 2, phaseNow: 2, tempoBpm: 120, quantum: 4 };
    stubSharedClock(joined); // the realm clock IS joined (other voices are synced)

    expect(soloVoiceAdapter._sharedClockBeat()).toBeNull();
    expect(soloVoiceAdapter._shouldQuantizeStart()).toBe(false);
  });
});

describe('_computeBarDelayMs — source selection', () => {
  it('uses the SHARED-CLOCK beat when a joined snapshot is present', () => {
    // shared: 120bpm, beat 2.0, 4/bar → next bar = 4 → (4-2)*0.5s = 1000ms
    stubSharedClock({ joined: true, beatNow: 2, phaseNow: 2, tempoBpm: 120, quantum: 4 });
    // sync would say something different (1500ms) — must be ignored.
    Object.assign(syncCoordinator, { bpm: 120, _beat: 1 });
    expect(adapter._computeBarDelayMs()).toBeCloseTo(1000, 6);
  });

  it('falls back to the SyncCoordinator epoch when no shared clock is joined', () => {
    Object.assign(syncCoordinator, { bpm: 120, _beat: 1 }); // next bar 4 → (4-1)*0.5s = 1500ms
    expect(adapter._computeBarDelayMs()).toBeCloseTo(1500, 6);
  });

  it('fallback path honours the selectable launch grid in bars (not hardcoded 1 bar)', () => {
    // grid = 1/2 bar in 4/4 = 2 beats: 120bpm, beat 1 → next boundary 2 → (2-1)*0.5s = 500ms
    setLaunchGridBars(0.5);
    Object.assign(syncCoordinator, { bpm: 120, _beat: 1 });
    expect(adapter._computeBarDelayMs()).toBeCloseTo(500, 6);
  });

  it('derives the bar length from THIS voice\'s OWN meter (fallback path)', () => {
    // 6/8 bar = 3 quarter beats. One bar at beat 1 → next boundary 3 → 1000ms at 120bpm.
    setLaunchGridBars(1);
    ownMeter.value = '6/8';
    Object.assign(syncCoordinator, { bpm: 120, _beat: 1 });
    expect(adapter._computeBarDelayMs()).toBeCloseTo(1000, 6);
  });

  it('bar length follows THIS voice\'s OWN meter over the shared beat clock — NOT the shared quantum', () => {
    // The shared clock is meter-agnostic: even though it reports quantum 8, this 6/8 voice snaps to a
    // 6/8 bar (3 quarter beats) over the shared beatNow. beat 2 → next boundary 3 → (3-2)*0.5s = 500ms.
    setLaunchGridBars(1);
    ownMeter.value = '6/8';
    stubSharedClock({ joined: true, beatNow: 2, phaseNow: 2, tempoBpm: 120, quantum: 8 });
    expect(adapter._computeBarDelayMs()).toBeCloseTo(500, 6);
  });

  it('a launch grid of none (0 bars) fires immediately, regardless of the shared clock', () => {
    setLaunchGridBars(0); // none — no snap
    stubSharedClock({ joined: true, beatNow: 2, phaseNow: 0, tempoBpm: 120, quantum: 4 });
    expect(adapter._computeBarDelayMs()).toBe(0);
  });

  it('rolls to the next bar when the next boundary is within the slack window', () => {
    // beat 3.99 at 120bpm: delay to beat 4 ≈ 5ms < 40ms slack → +1 bar (2000ms) → ≈2005ms
    stubSharedClock({ joined: true, beatNow: 3.99, phaseNow: 3.99, tempoBpm: 120, quantum: 4 });
    expect(adapter._computeBarDelayMs()).toBeCloseTo(2005, 1);
  });
});

describe('count-in', () => {
  // The count-in helpers are pure too — they read the same shared-clock/sync sources and write
  // `this._countInState` + dispatch `orbiters:quantize-countin`. Bare instance: seed the field.
  let countInAdapter;
  let events;
  let onEvent;
  beforeEach(() => {
    countInAdapter = Object.create(AudioEngineAdapter.prototype);
    countInAdapter._countInState = { active: false };
    // The count-in mirror now goes to the adapter's `_eventBus` (the constructor defaults
    // it to `window`); seed it here since the bare instance bypasses the constructor.
    countInAdapter._eventBus = window;
    countInAdapter.deck = makeDeckStub({ enabled: true }); // this voice is synced (see the note above)
    events = [];
    onEvent = (e) => events.push(e.detail);
    window.addEventListener('orbiters:quantize-countin', onEvent);
  });
  afterEach(() => {
    window.removeEventListener('orbiters:quantize-countin', onEvent);
  });

  it('_emitCountIn publishes an armed snapshot (target fire time + shared-clock tempo)', () => {
    stubSharedClock({ joined: true, beatNow: 2, phaseNow: 2, tempoBpm: 120, quantum: 4 });
    const before = performance.now();
    countInAdapter._emitCountIn(1000);
    const state = countInAdapter.getCountInState();
    expect(state.active).toBe(true);
    expect(state.bpm).toBe(120);
    expect(state.targetTime).toBeGreaterThanOrEqual(before + 1000);
    // mirrored on the window event
    expect(events.at(-1)).toMatchObject({ active: true, bpm: 120 });
  });

  it('falls back to the SyncCoordinator tempo when no shared clock is joined', () => {
    Object.assign(syncCoordinator, { bpm: 90 });
    countInAdapter._emitCountIn(500);
    const state = countInAdapter.getCountInState();
    expect(state.active).toBe(true);
    expect(state.bpm).toBe(90);
  });

  it('_emitCountIn is a no-op without a valid tempo (no false "armed" cue)', () => {
    // no shared clock, sync bpm 0 → cannot compute → stays inactive, emits nothing
    countInAdapter._emitCountIn(1000);
    expect(countInAdapter.getCountInState().active).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('_clearCountIn flips active off and mirrors the cleared state', () => {
    stubSharedClock({ joined: true, beatNow: 0, phaseNow: 0, tempoBpm: 120, quantum: 4 });
    countInAdapter._emitCountIn(1000);
    expect(countInAdapter.getCountInState().active).toBe(true);
    countInAdapter._clearCountIn();
    expect(countInAdapter.getCountInState().active).toBe(false);
    expect(events.at(-1)).toMatchObject({ active: false });
    // clearing again is a no-op (already inactive) — no extra event
    const count = events.length;
    countInAdapter._clearCountIn();
    expect(events).toHaveLength(count);
  });
});

describe('quantized SEEK (Piece 6)', () => {
  function makeSeekAdapter({ playing = true } = {}) {
    const a = Object.create(AudioEngineAdapter.prototype);
    a._countInState = { active: false };
    a._eventBus = window;
    a.deck = makeDeckStub({ enabled: true }); // this voice is synced (see the note above)
    a._pendingQuantizedSeek = null;
    const seeks = [];
    a.playback = { isPlaying: () => playing, getLoopRange: () => null, isLooping: () => false, setPosition: () => {} };
    a.transport = { seek: (ms) => { seeks.push(ms); } };
    a.mediaSession = { syncPositionState: () => {} };
    return { a, seeks };
  }

  it('_shouldQuantizeSeek: only when the joined shared clock is live AND playing', () => {
    const { a } = makeSeekAdapter({ playing: true });
    expect(a._shouldQuantizeSeek()).toBe(false); // no shared clock
    stubSharedClock({ joined: true, beatNow: 2, phaseNow: 2, tempoBpm: 120, quantum: 4 });
    expect(a._shouldQuantizeSeek()).toBe(true);
    const { a: paused } = makeSeekAdapter({ playing: false });
    expect(paused._shouldQuantizeSeek()).toBe(false); // joined but not playing → no phase to preserve
  });

  it('solo (no shared clock): seek is immediate, byte-identical', async () => {
    const { a, seeks } = makeSeekAdapter({ playing: true });
    await a.seekToMilliseconds(5000);
    expect(seeks).toEqual([5000]);
    expect(a._pendingQuantizedSeek).toBeNull();
  });

  it('joined + playing: the seek is DEFERRED to the next bar, then applied in phase', async () => {
    vi.useFakeTimers();
    try {
      stubSharedClock({ joined: true, beatNow: 2, phaseNow: 2, tempoBpm: 120, quantum: 4 }); // next bar in 1000ms
      const { a, seeks } = makeSeekAdapter({ playing: true });
      await a.seekToMilliseconds(7000);
      expect(seeks).toEqual([]); // not yet — armed for the bar
      expect(a._pendingQuantizedSeek).not.toBeNull();
      const cue = a.getCountInState();
      expect(cue.active).toBe(true); // count-in armed (UI shows the wait)
      expect(cue.seekTargetSec).toBeCloseTo(7, 6); // carries the target position so the waveform blinks there
      await vi.advanceTimersByTimeAsync(1000); // the bar arrives
      expect(seeks).toEqual([7000]); // applied in phase
      expect(a._pendingQuantizedSeek).toBeNull();
      expect(a.getCountInState().active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a superseding seek replaces the pending one (only the latest fires)', async () => {
    vi.useFakeTimers();
    try {
      stubSharedClock({ joined: true, beatNow: 2, phaseNow: 2, tempoBpm: 120, quantum: 4 });
      const { a, seeks } = makeSeekAdapter({ playing: true });
      await a.seekToMilliseconds(1000);
      await a.seekToMilliseconds(2000); // supersedes the first
      await vi.advanceTimersByTimeAsync(1000);
      expect(seeks).toEqual([2000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('UNSYNCED + warp + grid: the seek defers to the deck OWN next bar and lands snapped', async () => {
    vi.useFakeTimers();
    try {
      const { a, seeks } = makeSeekAdapter({ playing: true });
      // An unsynced deck with a running own clock: beat 2 of a 4-beat bar at 120 → next bar in 1000ms.
      a.deck = {
        getStatusDetail: () => ({ enabled: false }),
        get meter() { return ownMeter.value; },
        get launchGridQuarterBeats() { return getLaunchGridQuarterBeats(ownMeter.value); },
        clock: () => ({ beatNow: 2, secondsPerBeat: 0.5 }),
        snapToOwnGridMs: (ms) => Math.round(ms / 2000) * 2000, // 2s own bars
      };
      await a.seekToMilliseconds(7000);
      expect(seeks).toEqual([]); // armed for the deck's own bar
      const cue = a.getCountInState();
      expect(cue.active).toBe(true);
      expect(cue.bpm).toBeCloseTo(120, 6); // counts at the tempo actually playing
      expect(cue.seekTargetSec).toBeCloseTo(8, 6); // the SNAPPED landing spot (nearest own bar)
      await vi.advanceTimersByTimeAsync(1000);
      expect(seeks).toEqual([8000]); // fires ON a boundary, lands ON a boundary
    } finally {
      vi.useRealTimers();
    }
  });

  it('UNSYNCED with launch grid NONE: seek stays immediate', async () => {
    setLaunchGridBars(0);
    const { a, seeks } = makeSeekAdapter({ playing: true });
    a.deck = {
      getStatusDetail: () => ({ enabled: false }),
      get meter() { return ownMeter.value; },
      get launchGridQuarterBeats() { return 0; }, // grid 'none'
      clock: () => ({ beatNow: 2, secondsPerBeat: 0.5 }),
      snapToOwnGridMs: () => null,
    };
    await a.seekToMilliseconds(5000);
    expect(seeks).toEqual([5000]);
  });

  it('UNSYNCED but not following (warp off → no clock): seek stays immediate', async () => {
    const { a, seeks } = makeSeekAdapter({ playing: true });
    a.deck = {
      getStatusDetail: () => ({ enabled: false }),
      get meter() { return ownMeter.value; },
      get launchGridQuarterBeats() { return getLaunchGridQuarterBeats(ownMeter.value); },
      clock: () => null,
      snapToOwnGridMs: () => null,
    };
    await a.seekToMilliseconds(5000);
    expect(seeks).toEqual([5000]);
  });

  it('pause cancels a pending quantized seek (it never fires)', async () => {
    vi.useFakeTimers();
    try {
      stubSharedClock({ joined: true, beatNow: 2, phaseNow: 2, tempoBpm: 120, quantum: 4 });
      const { a, seeks } = makeSeekAdapter({ playing: true });
      await a.seekToMilliseconds(3000);
      expect(a._pendingQuantizedSeek).not.toBeNull();
      a.transport.pause = () => {}; a.transport.isRunning = false;
      a.playback.pause = () => {}; a._updatePlaybackState = () => {};
      await a.pause();
      expect(a._pendingQuantizedSeek).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      expect(seeks).toEqual([]); // never fired
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('_shouldQuantizeStart', () => {
  it('returns true when a joined shared clock is present (self-enables, no extra flag/sync needed)', () => {
    stubSharedClock({ joined: true, beatNow: 0, phaseNow: 0, tempoBpm: 120, quantum: 4 });
    expect(adapter._shouldQuantizeStart()).toBe(true);
  });

  it('warp off → immediate start, even synced with a joined shared clock (quantize follows warp)', () => {
    stubSharedClock({ joined: true, beatNow: 0, phaseNow: 0, tempoBpm: 120, quantum: 4 });
    const deck = adapter.deck;
    adapter.deck = makeDeckStub({ enabled: true, following: false });
    expect(adapter._shouldQuantizeStart()).toBe(false);
    adapter.deck = deck;
  });

  it('an UNSYNCED deck never takes the shared bar-delay (its launches ride its own grid)', () => {
    stubSharedClock({ joined: true, beatNow: 0, phaseNow: 0, tempoBpm: 120, quantum: 4 });
    const deck = adapter.deck;
    adapter.deck = makeDeckStub({ enabled: false, following: true, syncEnabled: false });
    expect(adapter._shouldQuantizeStart()).toBe(false);
    adapter.deck = deck;
  });

  it('flag-off, no shared clock → false (and queries nothing new)', () => {
    expect(adapter._shouldQuantizeStart()).toBe(false);
  });

  it('legacy path still works: quantize-start forced + enabled sync + bpm + a peer', () => {
    setQuantizeStartForced(true);
    Object.assign(syncCoordinator, { isEnabled: true, bpm: 120, peerCount: 1 });
    expect(adapter._shouldQuantizeStart()).toBe(true);

    // missing a peer → false
    syncCoordinator.peerCount = 0;
    expect(adapter._shouldQuantizeStart()).toBe(false);
  });
});
