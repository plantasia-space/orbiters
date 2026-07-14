// @vitest-environment jsdom
/**
 * Conscious-augment slice 2 — SyncCoordinator delegates tempo to the shared PULSE.
 *
 * When a pulse (pulseClock facade over the leaderless BeatTimeline) is passed to init(), it OWNS the
 * tempo: setTempo proposes to it, its onTempoChange drives the per-voice projection + the coordinator's
 * tempo mirror (`get bpm()`). Tempo replicates over the pulse relay (in-tab: the LocalRelay singleton;
 * room: the Connect tee) — there is no conductor publish/heartbeat and (stage 1) no x/y/z param
 * mirror. These tests pin that contract with a fresh (non-singleton) SyncCoordinator + a real in-tab
 * pulse + fake adapter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncCoordinator } from '../../src/sync/SyncCoordinator.js';
import { createLocalPulseClock } from '../../src/sync/pulseClock.js';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';

function makeAdapter() {
  return {
    peerCount: 0,
    isConductor: false,
    connect: vi.fn(() => true),
    destroy: vi.fn(),
    onPeerCount() {},
  };
}

/** A fake DECK adopting the master only while synced — mirroring the real deck's adopt gate (the
 *  gate itself is pinned in tests/voice/deck.test.js); captures what it ADOPTED. */
function makeDeckView(syncEnabled = true) {
  const bpm = [];
  const status = [];
  return {
    syncEnabled,
    bpm,
    status,
    receiveMasterChange(d) { if (this.syncEnabled) bpm.push(d); },
    receiveStatusChange(d) { status.push(d); },
  };
}

let adapter; let sc; let joined;

/** Build an in-tab pulse with a fixed clock so beat math is deterministic. */
function makePulse() {
  return createLocalPulseClock({
    isJoined: () => joined,
    now: () => 2500,
    sessionEpochMs: 0,
  });
}

beforeEach(() => {
  voiceRegistry.clear();
  adapter = makeAdapter();
  sc = new SyncCoordinator();
  joined = true;
});
afterEach(() => voiceRegistry.clear());

describe('SyncCoordinator + pulse — tempo delegation', () => {
  it('setTempo proposes to the pulse and fans the new tempo to every voice', () => {
    const v1 = makeDeckView();
    const v2 = makeDeckView();
    voiceRegistry.register('v1', { id: 'v1', deck: v1 });
    voiceRegistry.register('v2', { id: 'v2', deck: v2 });
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: null, pulse });

    v1.bpm.length = 0; v2.bpm.length = 0; // drop the init seed; focus on the explicit change

    sc.setTempo(140, { sourceType: 'module' });

    expect(pulse.getTempoBpm()).toBe(140);
    expect(v1.bpm.at(-1)).toMatchObject({ bpm: 140, sourceType: 'module' });
    expect(v2.bpm.at(-1)).toMatchObject({ bpm: 140, sourceType: 'module' });
    expect(sc.bpm).toBe(140); // the coordinator's tempo mirror — the one tempo owner
  });

  it('does NOT fan a tempo change to a voice that has its own sync explicitly OFF', () => {
    // The reported bug: editing tempo on a synced orbiter must not retune a sibling orbiter whose own
    // sync toggle is off, even though the realm aggregate is enabled (because another voice IS synced).
    const synced = makeDeckView(true);
    const unsynced = makeDeckView(false);
    voiceRegistry.register('synced', { id: 'synced', deck: synced });
    voiceRegistry.register('unsynced', { id: 'unsynced', deck: unsynced });
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: null, pulse });

    synced.bpm.length = 0; unsynced.bpm.length = 0; // drop the init seed

    sc.setTempo(140);

    expect(synced.bpm.at(-1)).toMatchObject({ bpm: 140 });
    expect(unsynced.bpm).toEqual([]); // never received the broadcast at all
  });

  it('a second voice changing tempo propagates to all voices through the one pulse', () => {
    const v1 = makeDeckView();
    const v2 = makeDeckView();
    voiceRegistry.register('v1', { id: 'v1', deck: v1 });
    voiceRegistry.register('v2', { id: 'v2', deck: v2 });
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: 120, pulse });

    sc.setTempo(150);
    expect(pulse.getTempoBpm()).toBe(150);
    expect(v1.bpm.at(-1)).toMatchObject({ bpm: 150 });
    expect(v2.bpm.at(-1)).toMatchObject({ bpm: 150 });
  });

  it('epsilon-guards a no-op re-propose (no duplicate fan-out)', () => {
    const v1 = makeDeckView();
    voiceRegistry.register('v1', { id: 'v1', deck: v1 });
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: 120, pulse });

    sc.setTempo(140);
    const countAfterFirst = v1.bpm.length;
    sc.setTempo(140); // same tempo → pulse no-ops → no extra fan-out
    expect(v1.bpm.length).toBe(countAfterFirst);
  });

  it('seeds the master from the number (else the 120 default) at init, NOT the track BPM', () => {
    // The master tempo is the "BPM" number (default 120), not a track's native BPM — pressing sync must
    // make a deck conform to the master (120), never push its own native (128) into the master.
    const v1 = makeDeckView();
    voiceRegistry.register('v1', { id: 'v1', deck: v1 });
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: 128, pulse }); // no masterBpm → the 120 default
    // The coordinator fans to EVERY deck; a synced deck adopts the seed immediately.
    expect(v1.bpm.at(-1)).toMatchObject({ bpm: 120 });
    sc.enable();
    expect(pulse.getTempoBpm()).toBe(120); // the 120 master default, NOT the track's 128
  });

  it('an explicit masterBpm seeds the master (the number value at boot)', () => {
    const v1 = makeDeckView();
    voiceRegistry.register('v1', { id: 'v1', deck: v1 });
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: 128, masterBpm: 100, pulse });
    expect(v1.bpm.at(-1)).toMatchObject({ bpm: 100 }); // the number wins over the track and the default
    sc.enable();
    expect(pulse.getTempoBpm()).toBe(100); // the number wins over the track (128) and the 120 default
  });

  it('a LATER voice load (re-init) never re-seeds a running master — the load leak', () => {
    // Deck A plays synced at 140; loading deck B runs sync/init again, passing B's number (95) as
    // masterBpm. That re-seed used to move the running session (the trailing init fan then pushed
    // 95 into A). The master is seeded once; after boot only setTempo/pulse adoption move it.
    const a = makeDeckView(true);
    voiceRegistry.register('a', { id: 'a', deck: a });
    const pulse = makePulse();
    sc.init({ adapter, masterBpm: 120, pulse });
    sc.setTempo(140);
    expect(sc.bpm).toBe(140);
    a.bpm.length = 0;

    sc.init({ adapter, masterBpm: 95, pulse }); // deck B loads mid-session

    expect(sc.bpm).toBe(140); // the running tempo survives
    expect(a.bpm.every((d) => d.bpm === 140)).toBe(true); // A never hears 95
    expect(pulse.getTempoBpm()).toBe(140);
  });

  it('getCurrentBeat comes from the pulse when JOINED (epoch/server-anchored)', () => {
    joined = true;
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: 120, pulse });
    // now=2500, epoch=0, tempo seeded 120 ⇒ beat = 2500*120/60000 = 5.
    expect(sc.getCurrentBeat()).toBe(5);
  });

  it('getCurrentBeat falls back to the legacy timeline when NOT joined (solo byte-identical)', () => {
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: 120, pulse });
    joined = false; // not a shared session (solo) — must NOT use the pulse's far-epoch grid
    // legacy #currentBeat is measured from the init epoch (performance.now) ⇒ ~0 just after init,
    // never the pulse's 2026-epoch beat (~3.1e7). Guards the single-orbiter byte-identical rule.
    expect(sc.getCurrentBeat()).toBeLessThan(1000);
  });

  it('enable() connects the adapter (presence)', () => {
    voiceRegistry.register('v1', { id: 'v1', deck: makeDeckView() });
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: 120, pulse });
    sc.enable();
    expect(adapter.connect).toHaveBeenCalled(); // connects for presence; tempo replicates via the pulse
  });

  it('enable() re-emits the CURRENT tempo so a newly-synced voice adopts it (adopt-on-sync)', () => {
    // Turning sync on for a second orbiter must snap it to the tempo already playing.
    // enable() used to emit only a status change, so the voice was told "synced" but never the tempo.
    const v1 = makeDeckView();
    voiceRegistry.register('v1', { id: 'v1', deck: v1 });
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: 120, pulse });
    sc.setTempo(150);   // the shared tempo is now 150
    v1.bpm.length = 0;  // drop prior emits; assert enable() itself pushes the current tempo
    sc.enable();
    expect(v1.bpm.at(-1)).toMatchObject({ bpm: 150 });
  });

  it('notifyVoiceSyncChanged re-emits the current tempo (per-voice adopt-on-sync)', () => {
    const v1 = makeDeckView();
    voiceRegistry.register('v1', { id: 'v1', deck: v1 });
    const pulse = makePulse();
    sc.init({ adapter, trackBpm: 120, pulse });
    sc.enable(); // this voice is synced — the per-voice bpm-fan gate requires it to receive anything
    sc.setTempo(150);
    v1.bpm.length = 0;
    sc.notifyVoiceSyncChanged();
    expect(v1.bpm.at(-1)).toMatchObject({ bpm: 150 });
  });
});
