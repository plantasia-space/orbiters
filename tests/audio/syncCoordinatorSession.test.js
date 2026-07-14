// @vitest-environment jsdom
/**
 * SyncCoordinator session contract — tempo delegation to the pulse, per-voice status fan-out, and the
 * room presence signals (B2/B4). Stage 1 removed the x/y/z param mirror (it copied the
 * tempo-knob VALUE onto peers), so the coordinator no longer touches ParameterManager or the adapter's
 * param channel — tempo replicates only through the pulse; the knob is independent per user.
 *
 * These tests construct a FRESH `SyncCoordinator` (not the singleton export) with a fake adapter to
 * PIN the contract for one voice. Tempo is owned entirely by the coordinator (`get bpm()`) — the
 * transport is no longer in the tempo path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncCoordinator } from '../../src/sync/SyncCoordinator.js';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';

/** A fake adapter capturing the SyncCoordinator → presence surface (post-stage-1: presence only). */
function makeAdapter() {
  return {
    peerCount: 0,
    isConductor: false,
    connect: vi.fn(() => true),
    destroy: vi.fn(),
    onPeerCount() {},
  };
}

// The conductor no longer dispatches window CustomEvents — it fans the same `detail`
// payload to session-level subscribers (`onBpmChange`/`onStatusChange`). These helpers capture that.
function onBpm(coord) {
  const calls = [];
  const stop = coord.onBpmChange((detail) => calls.push(detail));
  return { calls, stop };
}

function onStatus(coord) {
  const calls = [];
  const stop = coord.onStatusChange((detail) => calls.push(detail));
  return { calls, stop };
}

let adapter; let sc;
beforeEach(() => {
  adapter = makeAdapter();
  sc = new SyncCoordinator(); // a fresh, non-singleton voice
});

describe('setTempo — guards against being called before init', () => {
  it('no-ops (does not throw) when the coordinator is not yet wired', () => {
    // An effect rack's initial-value apply can call setTempo BEFORE initSync runs (the per-voice
    // trackBpm is seeded early on the SyncView). Before init, setTempo must no-op, not throw.
    const fresh = new SyncCoordinator();
    expect(() => fresh.setTempo(140, { sourceType: 'module' })).not.toThrow();
    expect(fresh.isInitialized).toBe(false);
  });
});

// Tempo flows through the PULSE: setTempo delegates to it, and its onTempoChange drives the per-voice
// fan-out + the #timeline mirror (`get bpm()`). (The real pulse is covered in pulseDelegation.test.js;
// here a fake pulse pins the coordinator's delegation contract.)
function makeFakePulse() {
  let tempo = 120;
  let cb = null;
  return {
    state: null,
    getState() { return this.state; },
    getTempoBpm: () => tempo,
    getCurrentBeat() { return this.state ? this.state.beatNow : 0; },
    setTempo: (bpm, opts) => { tempo = bpm; if (cb) cb({ tempoBpm: bpm, sourceType: opts?.sourceType ?? 'manual' }); },
    onTempoChange: (fn) => { cb = fn; return () => { cb = null; }; },
    setEnabled: () => {},
    dispose: () => {},
  };
}

describe('setTempo — delegates to the pulse, which drives fan-out + the tempo mirror', () => {
  it('a tempo proposal flows pulse → bpm event + sc.bpm mirror', () => {
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse });
    const bpmEv = onBpm(sc);

    sc.setTempo(140, { sourceType: 'module' });

    expect(sc.bpm).toBe(140); // mirrored from the pulse via #onPulseTempo — the one tempo owner
    expect(bpmEv.calls.at(-1)).toMatchObject({ bpm: 140, sourceType: 'module' });
    bpmEv.stop();
  });

  it('a remote pulse adoption flips sourceType=remote and updates the tempo mirror', () => {
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse });
    pulse.setTempo(128, { sourceType: 'remote' }); // the pulse adopted a peer's tempo (leaderless)
    expect(sc.bpm).toBe(128);
    expect(sc.tempoSourceType).toBe('remote');
  });

  it('getCurrentBeat reads the pulse when joined', () => {
    const pulse = makeFakePulse();
    pulse.state = { joined: true, beatNow: 7, phaseNow: 3, tempoBpm: 120, quantum: 4 };
    sc.init({ adapter, pulse });
    expect(sc.getCurrentBeat()).toBe(7);
  });
});

// The master tempo had three writers, each carrying its own copy of "may this player move
// the master?" — this is the single gate that replaces all three. `byVoiceId` tags a voice-scoped
// write; its absence tags a system write (pulse adoption, external host control), which is never
// voice-gated.
describe('setTempo — the one gate for "may this write move the master?" (byVoiceId)', () => {
  beforeEach(() => voiceRegistry.clear());
  afterEach(() => voiceRegistry.clear());

  it('MULTI: an unsynced voice write is rejected — the pulse never sees it', () => {
    voiceRegistry.register('v1', { id: 'v1', deck: { syncEnabled: false, receiveMasterChange: () => {}, receiveStatusChange: () => {} } });
    voiceRegistry.register('v2', { id: 'v2', deck: { syncEnabled: true, receiveMasterChange: () => {}, receiveStatusChange: () => {} } });
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse });
    const spy = vi.spyOn(pulse, 'setTempo');

    const accepted = sc.setTempo(140, { sourceType: 'manual', byVoiceId: 'v1' });

    expect(accepted).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('MULTI: a synced voice write is accepted and flows to the pulse', () => {
    voiceRegistry.register('v1', { id: 'v1', deck: { syncEnabled: true, receiveMasterChange: () => {}, receiveStatusChange: () => {} } });
    voiceRegistry.register('v2', { id: 'v2', deck: { syncEnabled: false, receiveMasterChange: () => {}, receiveStatusChange: () => {} } });
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse });
    const spy = vi.spyOn(pulse, 'setTempo');

    const accepted = sc.setTempo(140, { sourceType: 'manual', byVoiceId: 'v1' });

    expect(accepted).toBe(true);
    expect(spy).toHaveBeenCalledWith(140, { sourceType: 'manual' });
  });

  it('a system write (no byVoiceId) is accepted regardless of any voice\'s sync state', () => {
    voiceRegistry.register('v1', { id: 'v1', deck: { syncEnabled: false, receiveMasterChange: () => {}, receiveStatusChange: () => {} } });
    voiceRegistry.register('v2', { id: 'v2', deck: { syncEnabled: false, receiveMasterChange: () => {}, receiveStatusChange: () => {} } });
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse });
    const spy = vi.spyOn(pulse, 'setTempo');

    const accepted = sc.setTempo(140, { sourceType: 'url' });

    expect(accepted).toBe(true);
    expect(spy).toHaveBeenCalledWith(140, { sourceType: 'url' });
  });

  it('SINGLE voice (no per-voice gating): a voice-tagged write is accepted even with syncEnabled unset', () => {
    voiceRegistry.register('v1', { id: 'v1' }); // no deck flag — single-orbiter shape
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse });
    const spy = vi.spyOn(pulse, 'setTempo');

    const accepted = sc.setTempo(140, { sourceType: 'manual', byVoiceId: 'v1' });

    expect(accepted).toBe(true);
    expect(spy).toHaveBeenCalledWith(140, { sourceType: 'manual' });
  });
});

describe('status changes for the one voice (session subscription)', () => {
  it('enable() emits a status-change with enabled=true', () => {
    sc.init({ adapter });
    const st = onStatus(sc);
    sc.enable();
    expect(st.calls.at(-1)).toMatchObject({ enabled: true });
    st.stop();
  });
});

// B2: the SYNC badge's "others present" must be LIVE + room-scoped. Only a room (Connect)
// adapter qualifies; the in-tab BroadcastChannelAdapter counts every same-origin tab (no room concept)
// so its peers must NOT feed the badge — in-tab partners are counted via voiceSyncEnable instead.
describe('B2 — sessionPeerCount is room-scoped', () => {
  it('in-tab (isRoom default false): 0 even when the adapter reports peers', () => {
    adapter.peerCount = 3; // e.g. unrelated same-origin tabs on the BroadcastChannel
    sc.init({ adapter });
    expect(sc.sessionPeerCount).toBe(0);
  });

  it('room (isRoom true): reflects the live, server-scoped adapter peer count and decrements on leave', () => {
    adapter.peerCount = 2;
    sc.init({ adapter, isRoom: true });
    expect(sc.sessionPeerCount).toBe(2);
    adapter.peerCount = 1; // a peer left → decrements live
    expect(sc.sessionPeerCount).toBe(1);
  });
});

// The SYNC badge sums OTHER tabs' synced VOICES (a multi-orbiter tab is one connection but N voices),
// so it reads sessionRemoteVoiceCount, which wraps the room adapter's remoteSyncedVoiceCount.
describe('sessionRemoteVoiceCount is room-scoped', () => {
  it('in-tab (isRoom default false): 0 even when the adapter reports remote voices', () => {
    adapter.remoteSyncedVoiceCount = 3;
    sc.init({ adapter });
    expect(sc.sessionRemoteVoiceCount).toBe(0);
  });

  it('room (isRoom true): reflects the live summed remote voice count', () => {
    adapter.remoteSyncedVoiceCount = 4; // e.g. a 3-voice tab + a 1-voice tab
    sc.init({ adapter, isRoom: true });
    expect(sc.sessionRemoteVoiceCount).toBe(4);
    adapter.remoteSyncedVoiceCount = 1; // voices toggled off / a tab left
    expect(sc.sessionRemoteVoiceCount).toBe(1);
  });

  it('notifyVoiceSyncChanged re-announces this tab’s voice count (room pulse)', () => {
    const pulse = makeFakePulse();
    pulse.announceVoiceCount = vi.fn();
    sc.init({ adapter, pulse, isRoom: true });
    sc.notifyVoiceSyncChanged();
    expect(pulse.announceVoiceCount).toHaveBeenCalled();
  });
});

// B4: toggling sync off then on must re-join the room, not leave a dead session. disable()
// leaves RE-CONNECTABLY (disconnect, not destroy — peers see sync:peer-left and decrement); enable()
// reconnects and re-arms the room pulse so the fresh sync:joined re-runs the join.
describe('B4 — sync toggle off→on re-joins a room', () => {
  it('disable() disconnects (not destroy) and enable() reconnects + re-arms the pulse', () => {
    const roomAdapter = { ...makeAdapter(), peerCount: 0, connect: vi.fn(() => true), disconnect: vi.fn(), destroy: vi.fn() };
    const pulse = makeFakePulse();
    pulse.setEnabled = vi.fn();
    pulse.rejoin = vi.fn();
    sc.init({ adapter: roomAdapter, pulse, isRoom: true });

    sc.enable();
    expect(roomAdapter.connect).toHaveBeenCalledTimes(1);
    expect(pulse.setEnabled).toHaveBeenLastCalledWith(true);

    sc.disable();
    expect(roomAdapter.disconnect).toHaveBeenCalledTimes(1);
    expect(roomAdapter.destroy).not.toHaveBeenCalled(); // re-connectable, not a permanent teardown
    expect(pulse.setEnabled).toHaveBeenLastCalledWith(false);

    sc.enable();
    expect(roomAdapter.connect).toHaveBeenCalledTimes(2); // reconnect
    expect(pulse.rejoin).toHaveBeenCalledTimes(2); // enable() re-arms idempotently (once per enable)
    expect(pulse.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it('in-tab adapter without disconnect() falls back to destroy() on disable', () => {
    sc.init({ adapter }); // makeAdapter() has no disconnect
    sc.enable();
    sc.disable();
    expect(adapter.destroy).toHaveBeenCalledTimes(1);
  });
});

// (2026-06-30): the old swallow-guard is REMOVED. A deliberate tempo change must propagate
// IMMEDIATELY (it was being swallowed for up to 4s in a 2+ user room → tempo "didn't update"). Joiner
// adoption moved to the pulse: a room joiner relinquishes its timeline claim on join (pulseClock
// relinquishClaim, wired in sharedClock) so it adopts the room tempo instead of imposing its boot value.
describe('room tempo — deliberate changes propagate immediately (no swallow-guard)', () => {
  function makeRoomAdapter() {
    return { ...makeAdapter(), connect: vi.fn(() => true), disconnect: vi.fn() };
  }

  it('room: a local setTempo flows to the pulse the moment it is enabled (no delay/swallow)', () => {
    const pulse = makeFakePulse();
    sc.init({ adapter: makeRoomAdapter(), pulse, isRoom: true, seedPulse: false });
    sc.enable();
    const spy = vi.spyOn(pulse, 'setTempo');
    sc.setTempo(150, { sourceType: 'module' });
    expect(spy).toHaveBeenCalledWith(150, { sourceType: 'module' }); // propagates at once, even with a peer present
  });

  it('room: a remote adoption applies, and a later local change still flows', () => {
    const pulse = makeFakePulse();
    sc.init({ adapter: makeRoomAdapter(), pulse, isRoom: true, seedPulse: false });
    sc.enable();
    pulse.setTempo(128, { sourceType: 'remote' }); // a peer's tempo arrives → #onPulseTempo
    expect(sc.bpm).toBe(128);
    const spy = vi.spyOn(pulse, 'setTempo');
    sc.setTempo(132, { sourceType: 'module' });
    expect(spy).toHaveBeenCalledWith(132, { sourceType: 'module' });
  });

  it('in-tab: a local setTempo flows immediately too', () => {
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse });
    sc.enable();
    const spy = vi.spyOn(pulse, 'setTempo');
    sc.setTempo(145, { sourceType: 'module' });
    expect(spy).toHaveBeenCalledWith(145, { sourceType: 'module' });
  });
});

// The coordinator fans EVERY master/status change to EVERY deck — the adopt gate lives in the deck
// (pinned in tests/voice/deck.test.js: a synced deck adopts, an unsynced collection deck ignores,
// and each deck merges its OWN enable/warp flags into what it retains and re-emits).
describe('deck fan-out — the coordinator delivers to every deck, ungated', () => {
  /** A fake deck capturing the feeds it receives. */
  function makeDeck(syncEnabled = false) {
    const status = [];
    const bpm = [];
    return {
      syncEnabled,
      status,
      bpm,
      receiveStatusChange: (d) => status.push(d),
      receiveMasterChange: (d) => bpm.push(d),
    };
  }

  beforeEach(() => voiceRegistry.clear());
  afterEach(() => voiceRegistry.clear());

  it('a status change reaches EVERY deck, synced or not (the merge is the deck business)', () => {
    const d1 = makeDeck(true);
    const d2 = makeDeck(false);
    voiceRegistry.register('v1', { id: 'v1', deck: d1 });
    voiceRegistry.register('v2', { id: 'v2', deck: d2 });
    sc.init({ adapter });
    sc.enable(); // aggregate on (a sibling wants sync) → fan-out runs

    expect(d1.status.at(-1)).toMatchObject({ enabled: true });
    expect(d2.status.at(-1)).toMatchObject({ enabled: true }); // raw aggregate; the deck merges its own OFF
  });

  it('a master bpm change reaches EVERY deck (the unsynced deck drops it itself)', () => {
    const d1 = makeDeck(true);
    const d2 = makeDeck(false);
    voiceRegistry.register('v1', { id: 'v1', deck: d1 });
    voiceRegistry.register('v2', { id: 'v2', deck: d2 });
    sc.init({ adapter });

    expect(d1.bpm.length).toBeGreaterThan(0); // the init fan
    expect(d2.bpm.length).toBe(d1.bpm.length);
  });

  it('notifyVoiceSyncChanged re-fans status + bpm without changing the aggregate', () => {
    const d1 = makeDeck(true);
    const d2 = makeDeck(true);
    voiceRegistry.register('v1', { id: 'v1', deck: d1 });
    voiceRegistry.register('v2', { id: 'v2', deck: d2 });
    sc.init({ adapter });
    sc.enable();
    sc.setTempo(128); // ESTABLISH the session tempo — adopt-on-sync only fans an established master
    const statusBefore = d2.status.length;
    const bpmBefore = d2.bpm.length;
    // The user turns v2 OFF; the aggregate stays ON (v1 still on) so enable/disable emit nothing —
    // notifyVoiceSyncChanged must still re-deliver so v2's deck can re-emit its new OFF state.
    d2.syncEnabled = false;
    sc.notifyVoiceSyncChanged();

    expect(d2.status.length).toBeGreaterThan(statusBefore);
    expect(d2.bpm.length).toBeGreaterThan(bpmBefore); // the adopt-on-sync re-push rides along
    expect(sc.isEnabled).toBe(true);
  });

  it('an accepted setTempo reconciles the mirror even when the pulse skips (equal tempo / no pulse)', () => {
    // Mirror seeded 129 at boot; the establish write proposes 120. With no pulse (or a pulse already
    // at 120, whose epsilon guard swallows the re-propose) #onPulseTempo never runs — the mirror must
    // still land on 120 or the next adopt-on-sync fans the stale seed.
    const d1 = makeDeck(true);
    voiceRegistry.register('v1', { id: 'v1', deck: d1 });
    sc.init({ adapter, masterBpm: 129 });
    expect(sc.bpm).toBe(129);
    sc.setTempo(120);
    expect(sc.bpm).toBe(120); // mirror reconciled without a pulse round-trip
  });

  it('adopt-on-sync never fans a NEVER-ESTABLISHED master (boot seed is a placeholder)', () => {
    // The repro: track native 129 seeds the boot master, user edits the unsynced deck to
    // 120, presses SYNC as the FIRST enabler — the deck must keep 120, not snap back to the seed.
    const d1 = makeDeck(true);
    voiceRegistry.register('v1', { id: 'v1', deck: d1 });
    sc.init({ adapter, masterBpm: 129 });
    const bpmBefore = d1.bpm.length;
    sc.enable();
    sc.notifyVoiceSyncChanged();
    expect(d1.bpm.length).toBe(bpmBefore); // no fan — nothing was ever established

    sc.setTempo(120); // the first enabler's establish write
    sc.enable(); // idempotent (already enabled) — but a later sync-on...
    sc.notifyVoiceSyncChanged(); // ...re-pushes the now-established tempo
    expect(d1.bpm.length).toBeGreaterThan(bpmBefore);
  });

  it('notifyVoiceWrapChanged re-fans status so a warp toggle re-applies the rate path', () => {
    const d1 = makeDeck(true);
    voiceRegistry.register('v1', { id: 'v1', deck: d1 });
    sc.init({ adapter });
    const before = d1.status.length;
    sc.notifyVoiceWrapChanged();
    expect(d1.status.length).toBe(before + 1);
  });
});

// `seedTrackTempo`: a solo deck's transport IS this master, so "the transport adopts the
// track's native BPM" (SDS, tempo lifecycle) means seeding it here. It is a LOAD, never a choice.
describe('seedTrackTempo — a track load seeds the master without establishing it', () => {
  beforeEach(() => voiceRegistry.clear());
  afterEach(() => voiceRegistry.clear());

  it('seeds the master mirror', () => {
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse, masterBpm: 120 });

    sc.seedTrackTempo(90);

    expect(sc.bpm).toBe(90);
    expect(sc.tempoSourceType).toBe('track');
  });

  it('does NOT mark the session established — adopt-on-sync must not fan a track seed', () => {
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse, masterBpm: 120 });
    sc.seedTrackTempo(90);
    const received = [];
    voiceRegistry.register('d1', {
      id: 'd1',
      deck: { receiveMasterChange: (d) => received.push(d), receiveStatusChange() {} },
    });

    sc.enable();

    // enable() fans adopt-on-sync ONLY for an established tempo; a load is a placeholder, so the
    // first deck to enable sync still establishes its OWN tempo (Deck.setSyncEnabled's branch).
    expect(received.filter((d) => d.source === 'enable').length).toBe(0);
  });

  it('never moves a tempo somebody deliberately chose (a BPM typed while loading is respected)', () => {
    const pulse = makeFakePulse();
    sc.init({ adapter, pulse, masterBpm: 120 });
    sc.setTempo(99, { sourceType: 'manual' }); // the user typed it while the track loaded

    sc.seedTrackTempo(90);

    expect(sc.bpm).toBe(99);
  });

  it('survives a LATER init() — the deck is seeded before initSync runs', () => {
    // The ordering that made a single orbiter stick at 120: the adapter seeds the deck from trackData
    // while it is built, and `initSync` (and so `init()`) only runs once the audio engine is ready.
    const fresh = new SyncCoordinator();
    fresh.seedTrackTempo(90); // pre-init, no pulse yet
    expect(fresh.bpm).toBe(90);

    fresh.init({ adapter: makeAdapter(), pulse: makeFakePulse(), masterBpm: 120 });

    expect(fresh.bpm).toBe(90); // NOT clobbered back to the boot default
    expect(fresh.isInitialized).toBe(true);
  });

  it('a boot default still wins when no track seeded a tempo', () => {
    const fresh = new SyncCoordinator();
    fresh.init({ adapter: makeAdapter(), pulse: makeFakePulse(), masterBpm: 128 });
    expect(fresh.bpm).toBe(128);
  });
});
