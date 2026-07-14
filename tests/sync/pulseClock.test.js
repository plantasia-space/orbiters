import { describe, it, expect, vi } from 'vitest';
import {
  LocalRelay,
  createPulseClock,
  createLocalPulseClock,
  readPulseState,
  TEMPO_EPSILON,
  DEFAULT_SESSION_EPOCH_MS,
} from '../../src/sync/pulseClock.js';

/** A pulse wired to a LocalRelay with a controllable clock + epoch, for deterministic beat math. */
function makePulse({ now = 2500, epoch = 0, joined = true, getQuantum } = {}) {
  const state = { now, joined };
  const relay = new LocalRelay({ now: () => state.now, sessionEpochMs: epoch });
  const pulse = createPulseClock({
    relay,
    audioClock: { nowSec: () => state.now / 1000 },
    isJoined: () => state.joined,
    getQuantum,
    id: 'test-peer',
  });
  return { pulse, relay, state };
}

describe('pulseClock — LocalRelay (no-network RelaySeam)', () => {
  it('exposes the RelaySeam shape with a fixed epoch and zero network legs', () => {
    const relay = new LocalRelay({ now: () => 1234, sessionEpochMs: 999 });
    expect(relay.sessionEpochMs).toBe(999);
    expect(relay.upMs).toBe(0);
    expect(relay.downMs).toBe(0);
    expect(relay.serverNowMs()).toBe(1234);
  });

  it('defaults the epoch to the shared fixed constant', () => {
    const relay = new LocalRelay();
    expect(relay.sessionEpochMs).toBe(DEFAULT_SESSION_EPOCH_MS);
  });

  it('register stores the node and send is a harmless no-op', () => {
    const relay = new LocalRelay();
    const node = { id: 'n', online: true, localWallMs: () => 0, receive: vi.fn() };
    expect(() => relay.register(node)).not.toThrow();
    expect(relay._node).toBe(node);
    expect(() => relay.send('n', { kind: 'beat:hello', id: 'n' })).not.toThrow();
    expect(node.receive).not.toHaveBeenCalled(); // no fan-out: one in-tab singleton
  });
});

describe('pulseClock — createPulseClock facade', () => {
  it('requires an isJoined predicate', () => {
    expect(() => createPulseClock({ relay: new LocalRelay() })).toThrow(/isJoined/);
  });

  it('getState returns null until the session is joined', () => {
    const { pulse, state } = makePulse({ joined: false });
    expect(pulse.getState()).toBeNull();
    state.joined = true;
    expect(pulse.getState()).not.toBeNull();
  });

  it('getState reports the in-tab beat grid from epoch + wall clock + tempo', () => {
    // beatNow = (now - epoch) * tempo / 60000 = 2500 * 120 / 60000 = 5 beats; phase = 5 mod 4 = 1.
    // Explicit 1-bar quantum: the module default is now 'none' (quantized launching is opt-in).
    const { pulse } = makePulse({ now: 2500, epoch: 0, getQuantum: () => 4 });
    const s = pulse.getState();
    expect(s).toEqual({ joined: true, beatNow: 5, phaseNow: 1, tempoBpm: 120, quantum: 4 });
  });

  it('getState honors a live quantum source', () => {
    const { pulse } = makePulse({ now: 2500, epoch: 0, getQuantum: () => 8 });
    const s = pulse.getState();
    expect(s.quantum).toBe(8);
    expect(s.phaseNow).toBe(5); // 5 mod 8
  });

  it('getCurrentBeat reflects the engine beat', () => {
    const { pulse } = makePulse({ now: 2500, epoch: 0 });
    expect(pulse.getCurrentBeat()).toBe(5);
  });

  it('setTempo updates the reported tempo and keeps the beat continuous', () => {
    const { pulse } = makePulse({ now: 2500, epoch: 0 });
    pulse.setTempo(140, { sourceType: 'module' });
    expect(pulse.getTempoBpm()).toBe(140);
    // anchor re-based at the change moment ⇒ beat value unchanged at that instant.
    expect(pulse.getCurrentBeat()).toBe(5);
  });

  it('setTempo ignores invalid values', () => {
    const { pulse } = makePulse();
    pulse.setTempo(0);
    pulse.setTempo(-10);
    pulse.setTempo(NaN);
    expect(pulse.getTempoBpm()).toBe(120);
  });
});

describe('pulseClock — onTempoChange (deduped fan-out + sourceType)', () => {
  it('fires once per real tempo change, carrying the local sourceType', () => {
    const { pulse } = makePulse();
    const seen = [];
    pulse.onTempoChange((e) => seen.push(e));
    pulse.setTempo(140, { sourceType: 'module' });
    expect(seen).toEqual([{ tempoBpm: 140, sourceType: 'module' }]);
  });

  it('epsilon-guards re-proposing the current tempo (no feedback loop)', () => {
    const { pulse } = makePulse();
    const seen = [];
    pulse.onTempoChange((e) => seen.push(e));
    pulse.setTempo(140);
    pulse.setTempo(140); // same tempo — must not re-propose or re-fire
    pulse.setTempo(140 + TEMPO_EPSILON / 2); // within epsilon — same
    expect(seen).toHaveLength(1);
  });

  it('does NOT fire for non-tempo engine onChange (peer hello)', () => {
    const { pulse } = makePulse();
    const seen = [];
    pulse.onTempoChange((e) => seen.push(e));
    // A hello changes peer state + fires onChange, but tempo is unchanged ⇒ no fan-out.
    pulse.beat.receive({ kind: 'beat:hello', id: 'peer-x' });
    expect(pulse.beat.peers.has('peer-x')).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('surfaces a remote peer tempo adoption as sourceType "remote"', () => {
    const { pulse, relay } = makePulse();
    const seen = [];
    pulse.onTempoChange((e) => seen.push(e));
    // A newer remote timeline (last-writer-wins) is adopted by the engine ⇒ onChange ⇒ 'remote'.
    pulse.beat.receive({
      kind: 'beat:timeline',
      id: 'peer-x',
      timeline: { tempoBpm: 95, anchorBeat: 0, anchorSessionMs: relay.sessionEpochMs },
      ts: { time: 1e12, id: 'peer-x' },
    });
    expect(seen).toEqual([{ tempoBpm: 95, sourceType: 'remote' }]);
  });

  it('unsubscribe stops delivery', () => {
    const { pulse } = makePulse();
    const seen = [];
    const off = pulse.onTempoChange((e) => seen.push(e));
    pulse.setTempo(140);
    off();
    pulse.setTempo(150);
    expect(seen).toHaveLength(1);
  });

  it('dispose clears subscribers and the engine callback', () => {
    const { pulse } = makePulse();
    const seen = [];
    pulse.onTempoChange((e) => seen.push(e));
    pulse.dispose();
    expect(pulse.beat.onChange).toBeNull();
    pulse.setTempo(160); // engine still mutates, but no fan-out after dispose
    expect(seen).toHaveLength(0);
  });
});

describe('pulseClock — relinquishClaim (adopt-on-join)', () => {
  it('resets the timeline stamp so a peer timeline that was previously too old IS adopted', () => {
    const { pulse } = makePulse({ now: 2500 });
    pulse.setTempo(140); // a real local claim — stamps _ts.time ≈ 2500 (the session clock)
    expect(pulse.beat.tempoBpm).toBe(140);

    // A peer's (older) timeline arrives — last-writer-wins REJECTS it (our 2500 stamp is newer).
    const peerMsg = (ts) => ({
      kind: 'beat:timeline',
      timeline: { tempoBpm: 99, anchorBeat: 0, anchorSessionMs: 0 },
      ts: { time: ts, id: 'peer' },
      id: 'peer',
    });
    pulse.beat.receive(peerMsg(5));
    expect(pulse.beat.tempoBpm).toBe(140); // not adopted — our claim is newer

    // Relinquishing resets BOTH the stamp AND the local timeline to the engine default, so our boot
    // value (140) can't survive — and the same peer timeline is now adopted (newerTs prefers a real ts).
    pulse.relinquishClaim();
    expect(pulse.beat.tempoBpm).toBe(120); // local timeline reset — no stale boot claim
    pulse.beat.receive(peerMsg(5));
    expect(pulse.beat.tempoBpm).toBe(99); // adopted — the joiner takes the room tempo
  });

  it('forces the first post-join adoption to EMIT even when the room tempo equals our stale value', () => {
    // The joiner's boot setTempo advances the facade dedupe baseline (lastTempo) while the
    // display mirror is still gated off (sync not enabled yet). On join the room tempo can equal that
    // hidden value, so without resetting the baseline the adoption would dedupe-skip and the on-screen
    // BPM would never update. relinquishClaim must invalidate the baseline so the adoption fires.
    const { pulse } = makePulse({ now: 2500 });
    pulse.setTempo(140); // boot claim — advances lastTempo to 140
    const seen = [];
    pulse.onTempoChange((e) => seen.push(e));
    pulse.relinquishClaim();
    // The room replies with the SAME tempo (140) we already hold — a real peer ts beats our -1 sentinel.
    pulse.beat.receive({
      kind: 'beat:timeline',
      timeline: { tempoBpm: 140, anchorBeat: 0, anchorSessionMs: 0 },
      ts: { time: 5, id: 'peer' },
      id: 'peer',
    });
    expect(seen.at(-1)).toMatchObject({ tempoBpm: 140, sourceType: 'remote' }); // emitted despite equal value
  });

  it('a -1 tie cannot preserve our boot tempo (both sides at the no-claim sentinel)', () => {
    const { pulse } = makePulse({ now: 2500 });
    pulse.setTempo(140); // our boot claim
    pulse.relinquishClaim(); // joining a room where the host never set a tempo (host _ts.time is -1 too)
    // A peer (the host) replies with the DEFAULT tempo at the -1 sentinel — a tie by time.
    pulse.beat.receive({
      kind: 'beat:timeline',
      timeline: { tempoBpm: 120, anchorBeat: 0, anchorSessionMs: 0 },
      ts: { time: -1, id: 'aaa-host' }, // id tiebreak could go either way; either way we must NOT keep 140
      id: 'aaa-host',
    });
    expect(pulse.beat.tempoBpm).toBe(120); // never the divergent boot 140
  });
});

describe('pulseClock — createLocalPulseClock', () => {
  it('builds an in-tab pulse over a LocalRelay with a deterministic grid', () => {
    let joined = false;
    const pulse = createLocalPulseClock({
      audioClock: { nowSec: () => 2.5 },
      isJoined: () => joined,
      now: () => 2500,
      sessionEpochMs: 0,
      // Explicit 1-bar quantum: the module default is now 'none' (quantized launching is opt-in).
      getQuantum: () => 4,
    });
    expect(pulse.relay).toBeInstanceOf(LocalRelay);
    expect(pulse.getState()).toBeNull(); // solo: not joined
    joined = true;
    expect(pulse.getState()).toEqual({ joined: true, beatNow: 5, phaseNow: 1, tempoBpm: 120, quantum: 4 });
  });
});

describe('pulseClock — readPulseState (pure)', () => {
  it('returns null when not joined; preserves 0 = none; falls back to the default grid for garbage', () => {
    const fakeBeat = { beatNow: () => 9, tempoBpm: 120 };
    expect(readPulseState(fakeBeat, false, 4)).toBeNull();
    // 0 = none (no snap): quantum stays 0 and phase is 0 (no grid to be within).
    expect(readPulseState(fakeBeat, true, 0)).toEqual({ joined: true, beatNow: 9, phaseNow: 0, tempoBpm: 120, quantum: 0 });
    // Non-finite / negative garbage ⇒ DEFAULT (4).
    const bad = readPulseState(fakeBeat, true, Number.NaN);
    expect(bad).toEqual({ joined: true, beatNow: 9, phaseNow: 1, tempoBpm: 120, quantum: 4 });
  });
});
