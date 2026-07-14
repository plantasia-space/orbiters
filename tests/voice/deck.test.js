// @vitest-environment jsdom
/**
 * The Deck — the one per-player owner of sync/warp/tempo/meter/grid/clock.
 *
 * Pins the tempo model (Bruna's continuous-transport rule): the header number is ONE continuous
 * transport tempo — master-driven while synced, the deck's own while unsynced; un-syncing HOLDS the
 * last session tempo (no revert, no audible jump); the first enabler ESTABLISHES the master from its
 * tempo (captured BEFORE the adopt fan can overwrite it); a later enabler ADOPTS the running master.
 * Warp is independent of sync for collection decks (unsynced+warp = varispeed to the deck's own
 * tempo); solo keeps the historical follow rule (only while the session is enabled).
 *
 * Also carries the characterization the folded modules held: per-voice native tempo (own trackData
 * wins over the fanned singleton), per-voice meter (never adopted from a status fan), notification
 * fan-out + unsubscribe + listener isolation, live clock source, dispose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { registry, coordinator } = vi.hoisted(() => {
  const voices = new Map();
  return {
    registry: {
      voices,
      activeId: null,
      get: (id) => voices.get(id),
      getActive: () => voices.get(registry.activeId),
      all: () => [...voices.values()],
      get size() { return voices.size; },
    },
    coordinator: {
      bpm: 120,
      trackBpm: null,
      detectedTrackBpm: null,
      isRoom: false,
      isEnabled: false,
      enable: vi.fn(),
      disable: vi.fn(),
      notifyVoiceSyncChanged: vi.fn(),
      notifyVoiceWrapChanged: vi.fn(),
      setTempo: vi.fn(() => true),
      seedTrackTempo: vi.fn(),
    },
  };
});

vi.mock('../../src/voice/VoiceRegistry.js', () => ({ voiceRegistry: registry }));
vi.mock('../../src/sync/SyncCoordinator.js', () => ({ syncCoordinator: coordinator }));

import { Deck, deckFor, syncEnabledDeckCount } from '../../src/voice/Deck.js';

function makeTrackData({ trackBpm, meter } = {}) {
  return { track: { metadata: { trackBpm, meter } } };
}

function addDeck(id, opts = {}) {
  const deck = new Deck({ voiceId: id, collection: true, ...opts });
  registry.voices.set(id, { id, deck });
  return deck;
}

beforeEach(() => {
  registry.voices.clear();
  registry.activeId = null;
  coordinator.bpm = 120;
  coordinator.trackBpm = null;
  coordinator.detectedTrackBpm = null;
  coordinator.isRoom = false;
  coordinator.isEnabled = false;
  coordinator.enable.mockReset();
  coordinator.disable.mockReset();
  coordinator.setTempo.mockClear();
  coordinator.notifyVoiceSyncChanged.mockClear();
  coordinator.notifyVoiceWrapChanged.mockClear();
  coordinator.seedTrackTempo.mockClear();
});

describe('Deck — continuous transport tempo', () => {
  it('a collection deck seeds its tempo from its OWN track (ratio 1 at load)', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 90 }) });
    expect(deck.tempo).toBe(90);
    expect(deck.nativeTempo).toBe(90);
    expect(deck.followRatio).toBe(1);
  });

  it('an unsynced collection edit moves only this deck (never the coordinator)', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 90 }) });
    deck.setTempo(95);
    expect(deck.tempo).toBe(95);
    expect(coordinator.setTempo).not.toHaveBeenCalled();
    expect(deck.followRatio).toBeCloseTo(95 / 90, 10);
  });

  it('a synced deck edit proposes the master through the coordinator single gate', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 90 }) });
    deck.setSyncEnabled(true);
    coordinator.setTempo.mockClear();
    deck.setTempo(140);
    expect(coordinator.setTempo).toHaveBeenCalledWith(140, { sourceType: 'manual', byVoiceId: 'A' });
  });

  it('a synced deck adopts the master fan; an unsynced sibling ignores it', () => {
    const a = addDeck('A', { trackData: makeTrackData({ trackBpm: 90 }) });
    const b = addDeck('B', { trackData: makeTrackData({ trackBpm: 120 }) });
    a.setSyncEnabled(true);
    a.receiveMasterChange({ bpm: 140 });
    b.receiveMasterChange({ bpm: 140 });
    expect(a.tempo).toBe(140);
    expect(b.tempo).toBe(120); // its own — the fan never leaks into an unsynced deck
  });

  it('sync-off HOLDS the last session tempo — no revert, no jump (Bruna rule two)', () => {
    const deck = addDeck('B', { trackData: makeTrackData({ trackBpm: 120 }) });
    deck.setSyncEnabled(true);
    deck.receiveMasterChange({ bpm: 140 });
    expect(deck.tempo).toBe(140);
    const ratioWhileSynced = deck.followRatio;
    deck.setSyncEnabled(false);
    expect(deck.tempo).toBe(140); // stays — 140 is the new reference, never back to 120
    expect(deck.followRatio).toBe(ratioWhileSynced); // zero audible jump at the seam
  });

  it('the FIRST enabler establishes the master from its tempo, captured BEFORE the adopt fan', () => {
    const deck = addDeck('D', { trackData: makeTrackData({ trackBpm: 70 }) });
    addDeck('A', { trackData: makeTrackData({ trackBpm: 120 }) });
    // The real enable() fans the OLD master synchronously and the deck (synced by then) adopts it —
    // simulate that clobber inside the mock. The establish write must still carry the deck's 70.
    coordinator.enable.mockImplementationOnce(() => {
      deck.receiveMasterChange({ bpm: 120 });
    });
    deck.setTempo(70);
    deck.setSyncEnabled(true);
    expect(coordinator.setTempo).toHaveBeenCalledWith(70, { sourceType: 'manual', byVoiceId: 'D' });
  });

  it('a LATER enabler does NOT reseed the master (it adopts via the fan instead)', () => {
    const a = addDeck('A', { trackData: makeTrackData({ trackBpm: 120 }) });
    const d = addDeck('D', { trackData: makeTrackData({ trackBpm: 70 }) });
    a.setSyncEnabled(true);
    coordinator.setTempo.mockClear();
    d.setSyncEnabled(true);
    expect(coordinator.setTempo).not.toHaveBeenCalled();
  });

  it('a room never seeds — it adopts a peer tempo on join', () => {
    coordinator.isRoom = true;
    const deck = addDeck('D', { trackData: makeTrackData({ trackBpm: 70 }) });
    deck.setSyncEnabled(true);
    expect(coordinator.setTempo).not.toHaveBeenCalled();
  });
});

describe('Deck — warp and the follow rule', () => {
  it('collection: warp alone decides following; unsynced+warp = varispeed to OWN tempo', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 90 }) });
    expect(deck.following).toBe(true); // warp default on
    deck.setTempo(99);
    expect(deck.followRatio).toBeCloseTo(1.1, 10);
    deck.setWarp(false);
    expect(deck.following).toBe(false);
    expect(deck.followRatio).toBe(1); // no grid — natural rate
  });

  it('solo keeps the historical rule: follows only while the sync session is enabled', () => {
    const deck = new Deck({ voiceId: 'S', collection: false, trackData: makeTrackData({ trackBpm: 90 }) });
    registry.voices.set('S', { id: 'S', deck });
    expect(deck.tempo).toBe(120); // solo mirrors the master, not its native
    expect(deck.following).toBe(false); // session off → natural rate, byte-identical
    coordinator.isEnabled = true;
    expect(deck.following).toBe(true);
    expect(deck.followRatio).toBeCloseTo(120 / 90, 10);
  });

  it('setWarp re-fans status so the rate owners re-apply', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 90 }) });
    deck.setWarp(false);
    expect(coordinator.notifyVoiceWrapChanged).toHaveBeenCalled();
  });

  it('fresh session, two-phase load: the transport adopts the track tempo, never sticks at 120', () => {
    // The regression: decks are constructed BEFORE trackData exists, so the ctor seeds
    // the master default (120) as a placeholder. The real tempo arriving must replace it.
    const deck = addDeck('A'); // registration: no trackData yet
    expect(deck.tempo).toBe(120); // placeholder from the master default
    deck.seedFromTrackData(makeTrackData({ trackBpm: 90 }));
    expect(deck.tempo).toBe(90); // the track's own tempo, not the placeholder
    expect(deck.followRatio).toBe(1);
  });

  it('a tempo the user typed before the track finished loading is NOT overwritten by the seed', () => {
    const deck = addDeck('A');
    deck.setTempo(99); // deliberate edit while loading
    deck.seedFromTrackData(makeTrackData({ trackBpm: 90 }));
    expect(deck.tempo).toBe(99);
    expect(deck.nativeTempo).toBe(90);
  });

  it('collection: the shared singleton never masks a tempo-less track (no borrowed native)', () => {
    coordinator.trackBpm = 75; // a sibling's value sits in the singleton
    const deck = addDeck('A'); // own track has no tempo
    expect(deck.tempoMissing).toBe(true);
    expect(deck.warp).toBe(false); // locked, not silently stretching to a sibling's grid
  });

  it('no tempo → warp starts OFF and is locked until a tempo is set (never a silent ratio-1)', () => {
    const deck = addDeck('A'); // no trackData, no singleton fallback → tempoMissing
    expect(deck.tempoMissing).toBe(true);
    expect(deck.warp).toBe(false);
    deck.setWarp(true); // refused — nothing to stretch to
    expect(deck.warp).toBe(false);
    expect(deck.following).toBe(false);

    deck.setNativeTempo(90); // the user sets the track tempo → lock lifts, warp back to default (on)
    expect(deck.tempoMissing).toBe(false);
    expect(deck.warp).toBe(true);
    expect(coordinator.notifyVoiceWrapChanged).toHaveBeenCalled();
  });

  it('a late trackData seed with a BPM also lifts the no-tempo lock', () => {
    const deck = addDeck('A');
    expect(deck.warp).toBe(false);
    deck.seedFromTrackData(makeTrackData({ trackBpm: 100 }));
    expect(deck.tempoMissing).toBe(false);
    expect(deck.warp).toBe(true);
  });

  it('the speed lock still wins when a tempo arrives', () => {
    const deck = addDeck('A');
    deck.setSpeedLocked(true);
    deck.setNativeTempo(90); // tempo lock lifts, but the speed lock keeps warp off
    expect(deck.warp).toBe(false);
  });

  it('speed lock forces warp off, blocks re-enable, and releases on unlock', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 90 }) });
    expect(deck.warp).toBe(true);
    expect(deck.speedLocked).toBe(false);

    deck.setSpeedLocked(true);
    expect(deck.speedLocked).toBe(true);
    expect(deck.warp).toBe(false);        // forced off — its stretch is a no-op under the lock
    expect(deck.following).toBe(false);
    expect(deck.followRatio).toBe(1);     // metronome/grid stay on native, matching the pinned audio

    deck.setWarp(true);                   // user/MIDI re-enable attempt is refused while locked
    expect(deck.warp).toBe(false);

    deck.setSpeedLocked(false);           // lock released → control usable again (stays off until asked)
    expect(deck.speedLocked).toBe(false);
    expect(deck.warp).toBe(false);
    deck.setWarp(true);
    expect(deck.warp).toBe(true);
  });
});

describe('Deck — per-voice native tempo (the singleton-contamination class)', () => {
  it('native seeds from its OWN trackData, not the shared singleton', () => {
    coordinator.trackBpm = 75; // another track's value in the singleton
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 100 }) });
    expect(deck.nativeTempo).toBe(100);
  });

  it('a master fan recomputes the ratio from the deck OWN native, ignoring the fanned singleton', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 100 }) });
    deck.setSyncEnabled(true);
    deck.receiveMasterChange({ bpm: 120, trackBpm: 75, baseRate: 1.6 });
    expect(deck.tempo).toBe(120);
    expect(deck.nativeTempo).toBe(100); // own native survives the fan
    expect(deck.followRatio).toBeCloseTo(1.2, 10); // master / OWN native, never the fanned 1.6
  });

  it('setNativeTempo: an unsynced deck still riding its native follows it 1:1 (ratio stays 1)', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 100 }) });
    deck.setNativeTempo(80);
    expect(deck.nativeTempo).toBe(80);
    expect(deck.tempo).toBe(80);
    expect(deck.followRatio).toBe(1);
  });

  it('setNativeTempo: a detached tempo (user-edited number) is not dragged along', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 100 }) });
    deck.setTempo(110); // user detached the transport from native
    deck.setNativeTempo(80);
    expect(deck.tempo).toBe(110);
    expect(deck.followRatio).toBeCloseTo(110 / 80, 10);
  });

  it('ignores same/invalid native values without re-emitting', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 100 }) });
    let emits = 0;
    deck.onChange(() => { emits += 1; });
    deck.setNativeTempo(100);
    deck.setNativeTempo(0);
    deck.setNativeTempo(Number.NaN);
    deck.setNativeTempo(-4);
    expect(emits).toBe(0);
    expect(deck.nativeTempo).toBe(100);
  });
});

describe('Deck — per-voice meter', () => {
  it('seeds its OWN meter from its own trackData; defaults to 4/4', () => {
    expect(addDeck('A', { trackData: makeTrackData({ meter: '3/4' }) }).meter).toBe('3/4');
    expect(addDeck('B', { trackData: makeTrackData({}) }).meter).toBe('4/4');
  });

  it('setMeter applies locally and emits; same value is a silent no-op', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ meter: '4/4' }) });
    const seen = [];
    deck.onChange((snapshot, reason) => seen.push({ meter: snapshot.meter, reason }));
    deck.setMeter('6/8');
    expect(deck.meter).toBe('6/8');
    expect(seen.at(-1)).toMatchObject({ meter: '6/8', reason: 'meter' });
    const emits = seen.length;
    deck.setMeter('6/8');
    expect(seen.length).toBe(emits);
  });

  it('a status fan NEVER touches this deck meter, synced or not', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ meter: '3/4' }) });
    deck.receiveStatusChange({ enabled: true, meter: '6/8' });
    expect(deck.meter).toBe('3/4');
    deck.setSyncEnabled(true);
    deck.receiveStatusChange({ enabled: true, meter: '5/4' });
    expect(deck.meter).toBe('3/4');
  });

  it('an unchanged status re-fan does not re-emit (no event churn)', () => {
    const deck = addDeck('A');
    deck.receiveStatusChange({ enabled: false, peerCount: 0 });
    let emits = 0;
    deck.onChange(() => { emits += 1; });
    deck.receiveStatusChange({ enabled: false, peerCount: 3 }); // peers moved, deck flags did not
    expect(emits).toBe(0);
  });
});

describe('Deck — clock seam', () => {
  it('synced with a live shared session: the shared clock wins', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 100 }) });
    deck.setSyncEnabled(true);
    deck.setSharedClockSource(() => ({ joined: true, beatNow: 16, tempoBpm: 120 }));
    expect(deck.clock()).toEqual({ beatNow: 16, secondsPerBeat: 0.5 });
  });

  it('unsynced: beats from OWN position over OWN grid marker at the tempo it actually plays', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 120 }) });
    deck.setGridMarkerTimeSec(2);
    deck.setPositionSource(() => ({ playing: true, positionMs: 4000 }));
    // 2s past the grid at native 120 → beat 4; warp riding native → wall tempo = native.
    expect(deck.clock()).toEqual({ beatNow: 4, secondsPerBeat: 0.5 });
  });

  it('unsynced with the transport detached: beat position stays on the source grid, wall tempo follows', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 120 }) });
    deck.setPositionSource(() => ({ playing: true, positionMs: 2000 }));
    deck.setTempo(60); // half speed varispeed
    const clock = deck.clock();
    expect(clock.beatNow).toBe(4); // source beats are rate-invariant
    expect(clock.secondsPerBeat).toBe(1); // wall tempo = 60
  });

  it('a paused or engine-less deck has no clock; a synced deck with no live session falls back to its own', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 120 }) });
    expect(deck.clock()).toBeNull(); // no position source
    deck.setPositionSource(() => ({ playing: false, positionMs: 1000 }));
    expect(deck.clock()).toBeNull(); // paused
    deck.setSyncEnabled(true);
    deck.setSharedClockSource(() => null); // session not joined
    deck.setPositionSource(() => ({ playing: true, positionMs: 1000 }));
    expect(deck.clock()).toEqual({ beatNow: 2, secondsPerBeat: 0.5 });
  });

  it('reads the shared clock live and null-safe (source errors never throw)', () => {
    const deck = addDeck('A');
    expect(deck.getSharedClockState()).toBeNull();
    let beat = 4;
    deck.setSharedClockSource(() => ({ joined: true, beatNow: beat, quantum: 4 }));
    expect(deck.getSharedClockState().beatNow).toBe(4);
    beat = 8;
    expect(deck.getSharedClockState().beatNow).toBe(8); // live, never cached
    deck.setSharedClockSource(() => { throw new Error('clock down'); });
    expect(deck.getSharedClockState()).toBeNull();
  });
});

describe('Deck — per-deck launch grid', () => {
  it('each deck owns its launch grid — changing A never moves B', () => {
    const a = addDeck('A');
    const b = addDeck('B');
    a.setLaunchGridBars(4);
    expect(a.launchGridBars).toBe(4);
    expect(b.launchGridBars).toBe(0); // the boot default — untouched by A's edit
  });

  it('derives quarter-note beats over the deck OWN meter; 0 = none', () => {
    const a = addDeck('A', { trackData: makeTrackData({ meter: '3/4' }) });
    expect(a.launchGridQuarterBeats).toBe(0); // default none
    a.setLaunchGridBars(1);
    expect(a.launchGridQuarterBeats).toBe(3); // 1 bar of 3/4
    a.setLaunchGridBars(2);
    expect(a.launchGridQuarterBeats).toBe(6);
  });

  it('emits launch-grid on change; same/invalid values are silent no-ops', () => {
    const a = addDeck('A');
    const reasons = [];
    a.onChange((_s, reason) => reasons.push(reason));
    a.setLaunchGridBars(1);
    a.setLaunchGridBars(1);
    a.setLaunchGridBars(-2);
    a.setLaunchGridBars(Number.NaN);
    expect(reasons).toEqual(['launch-grid']);
  });
});

describe('Deck — snapToOwnGridMs (unsynced launch snap)', () => {
  // Native 120 → a quarter beat is 0.5s; a 4-quarter-beat launch grid = 2s bars, anchored on the marker.
  function gridDeck({ gridSec = 0 } = {}) {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 120 }) });
    if (gridSec) deck.setGridMarkerTimeSec(gridSec);
    return deck;
  }

  it('snaps to the NEAREST launch-grid boundary of the deck own grid', () => {
    const deck = gridDeck();
    expect(deck.snapToOwnGridMs(2300, { launchGridQuarterBeats: 4, durationMs: 100000 })).toBe(2000);
    expect(deck.snapToOwnGridMs(3200, { launchGridQuarterBeats: 4, durationMs: 100000 })).toBe(4000);
  });

  it('bars are anchored on the grid marker, not on 0', () => {
    const deck = gridDeck({ gridSec: 0.5 });
    expect(deck.snapToOwnGridMs(2400, { launchGridQuarterBeats: 4, durationMs: 100000 })).toBe(2500);
  });

  it('a nearest boundary before the track start moves to the first one at/after 0', () => {
    const deck = gridDeck({ gridSec: 1.5 }); // boundaries at ..., -0.5, 1.5, 3.5
    expect(deck.snapToOwnGridMs(200, { launchGridQuarterBeats: 4, durationMs: 100000 })).toBe(1500);
  });

  it('returns null with no grid, no native tempo, or warp off (nothing to snap to)', () => {
    const deck = gridDeck();
    expect(deck.snapToOwnGridMs(2300, { launchGridQuarterBeats: 0, durationMs: 100000 })).toBeNull();
    deck.setWarp(false);
    expect(deck.snapToOwnGridMs(2300, { launchGridQuarterBeats: 4, durationMs: 100000 })).toBeNull();
    const bare = addDeck('N'); // no trackData → no native tempo
    expect(bare.snapToOwnGridMs(2300, { launchGridQuarterBeats: 4, durationMs: 100000 })).toBeNull();
  });
});

describe('Deck — notification + lifecycle', () => {
  it('fans a change to all subscribers; unsubscribe stops delivery; throwing listeners are isolated', () => {
    const deck = addDeck('A', { trackData: makeTrackData({ trackBpm: 90 }) });
    const a = vi.fn();
    const bad = vi.fn(() => { throw new Error('boom'); });
    const b = vi.fn();
    const offA = deck.onChange(a);
    deck.onChange(bad);
    deck.onChange(b);
    expect(() => deck.setTempo(95)).not.toThrow();
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    offA();
    deck.setTempo(96);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('deckFor resolves a specific voice, falling back to the active voice for null (solo)', () => {
    const a = addDeck('A');
    const b = addDeck('B');
    registry.activeId = 'B';
    expect(deckFor('A')).toBe(a);
    expect(deckFor(null)).toBe(b);
  });

  it('syncEnabledDeckCount counts only decks that opted in', () => {
    const a = addDeck('A');
    addDeck('B');
    expect(syncEnabledDeckCount()).toBe(0);
    a.setSyncEnabled(true);
    expect(syncEnabledDeckCount()).toBe(1);
  });

  it('dispose releases sync membership and goes inert', () => {
    const a = addDeck('A');
    a.setSyncEnabled(true);
    coordinator.disable.mockClear();
    const fn = vi.fn();
    a.onChange(fn);
    a.dispose();
    expect(a.syncEnabled).toBe(false);
    expect(coordinator.disable).toHaveBeenCalled(); // last synced deck released the session
    a.receiveMasterChange({ bpm: 140 });
    expect(fn).not.toHaveBeenCalled();
  });
});

// "Load: the transport adopts the track's native BPM" (SDS) is ONE rule for both deck kinds.
// It used to be hard-gated to `this.#collection`, so a single orbiter never picked up its track's tempo
// while a collection deck did. The two kinds differ only in WHERE their transport tempo lives.
describe('Deck — a track load seeds the transport, solo and collection alike', () => {
  it('SOLO: seeds the session master from the track (its transport IS the master)', () => {
    const deck = new Deck({ voiceId: 'S', collection: false }); // registration: no trackData yet
    registry.voices.set('S', { id: 'S', deck });

    deck.seedFromTrackData(makeTrackData({ trackBpm: 90 }));

    expect(coordinator.seedTrackTempo).toHaveBeenCalledWith(90);
  });

  it('SOLO: does NOT seed while synced (the session owns the tempo then)', () => {
    coordinator.isEnabled = true; // solo is "synced" when the aggregate is on
    const deck = new Deck({ voiceId: 'S', collection: false });
    registry.voices.set('S', { id: 'S', deck });

    deck.seedFromTrackData(makeTrackData({ trackBpm: 90 }));

    expect(coordinator.seedTrackTempo).not.toHaveBeenCalled();
  });

  it('COLLECTION: adopts the track tempo into its OWN transport, never the master', () => {
    const deck = addDeck('A'); // no trackData yet → placeholder
    deck.seedFromTrackData(makeTrackData({ trackBpm: 90 }));
    expect(deck.tempo).toBe(90);
    expect(coordinator.seedTrackTempo).not.toHaveBeenCalled();
  });
});
