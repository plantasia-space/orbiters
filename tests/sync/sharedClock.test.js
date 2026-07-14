import { describe, it, expect, vi, afterEach } from 'vitest';
import { initSharedClockPulse } from '../../src/sync/sharedClock.js';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';
import { setLaunchGridBars, DEFAULT_LAUNCH_GRID_BARS } from '../../src/sync/launchGrid.js';

/**
 * A fake WS adapter exposing only the tee (onRawMessage / sendRaw). It fans an emitted message
 * to ALL subscribers (like the real Set-backed tee) so BOTH ConnectRelay and the join-watcher receive
 * sync:joined — ConnectRelay subscribes first (in its constructor) so it seeds sessionEpochMs first.
 */
function fakeAdapter() {
  const handlers = new Set();
  return {
    emit: (m) => handlers.forEach((h) => h(m)),
    handlerCount: () => handlers.size,
    onRawMessage: (cb) => { handlers.add(cb); return () => handlers.delete(cb); },
    sendRaw: vi.fn(),
  };
}

const logsMatching = (spy, needle) =>
  spy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes(needle));

describe('initSharedClockPulse (room pulse over the Connect tee)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    voiceRegistry.clear();
  });

  it('starts INERT, then on enable+sync:joined announces and does NOT re-anchor the epoch', () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter = fakeAdapter();

    const pulse = initSharedClockPulse(adapter, { sessionId: 's1', audioEngine: null });

    expect(adapter.handlerCount()).toBe(2); // ConnectRelay + the join-watcher both on the tee
    expect(pulse.getState()).toBeNull(); // inert: starts disabled (until SyncCoordinator.enable)

    // A non-ping send = participation (announce/timeline over beat:*). A bare RTT sync:ping is benign.
    const participated = () => adapter.sendRaw.mock.calls.filter((c) => c[0]?.type !== 'sync:ping');

    // Inert pulse does NOT participate (announce) even when the server confirms a join (it may RTT-ping).
    adapter.emit({ type: 'sync:joined', sessionEpochMs: 5000, serverNowMs: Date.now() });
    expect(participated()).toHaveLength(0); // disabled ⇒ no presence/timeline broadcast

    // The user enables sync (SyncCoordinator.enable → pulse.setEnabled(true)) ⇒ now it announces.
    pulse.setEnabled(true);
    expect(participated().length).toBeGreaterThan(0); // beat:hello announced

    // KEY behavioural change: we DROPPED the forceBeatAtTime(0, sessionEpoch) re-anchor. The timeline
    // stays at the construction-default anchor (0), so a joining client never broadcasts an anchor that
    // would clobber a peer's tempo. Cross-machine alignment comes from the server offset, not the epoch.
    expect(pulse.beat.timeline.anchorSessionMs).toBe(0);
    expect(logsMatching(info, 'room pulse joined session')).toHaveLength(1);

    // enabled + joined but NO peers AND <2 synced voices ⇒ getState still null (a solo single orbiter
    // in a room never quantizes).
    expect(pulse.getState()).toBeNull();

    pulse.dispose();
    expect(adapter.handlerCount()).toBe(0); // tears down BOTH the watcher and ConnectRelay's subscription
  });

  it('a multi-orbiter tab (≥2 synced voices, NO network peer) DOES join — its voices quantize together', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter = fakeAdapter();
    const pulse = initSharedClockPulse(adapter, { sessionId: 's1', audioEngine: null });

    // Two synced sibling voices in THIS tab. A multi-orbiter tab shares ONE socket, so the siblings are
    // NOT network peers (beat.peers stays empty) — but they must still launch together on the grid.
    voiceRegistry.register('v1', { id: 'v1', deck: { syncEnabled: true } });
    voiceRegistry.register('v2', { id: 'v2', deck: { syncEnabled: true } });

    pulse.setEnabled(true);
    adapter.emit({ type: 'sync:joined', sessionEpochMs: 5000, serverNowMs: Date.now() });

    // No network peers, but ≥2 synced in-tab voices ⇒ joined ⇒ getState non-null (quantizes on the grid).
    setLaunchGridBars(1); // the default is now 'none' — pick a grid so the quantum is observable
    const s = pulse.getState();
    expect(s).not.toBeNull();
    expect(s.joined).toBe(true);
    expect(s.quantum).toBe(4); // 1 bar of 4/4
    setLaunchGridBars(DEFAULT_LAUNCH_GRID_BARS);

    // One voice opts out ⇒ back under the ≥2 threshold ⇒ solo again ⇒ getState null.
    voiceRegistry.get('v2').deck.syncEnabled = false;
    expect(pulse.getState()).toBeNull();

    pulse.dispose();
  });

  it('announces its OWN synced-voice count as 1 for a single orbiter (aggregate enable, no per-voice flag)', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter = fakeAdapter();
    const pulse = initSharedClockPulse(adapter, { sessionId: 's1', audioEngine: null });

    // Single orbiter: sync on via the coordinator aggregate — NO voice carries a per-voice syncEnabled
    // flag, so syncEnabledVoiceCount() is 0. The announce must still report this tab's 1 voice.
    pulse.setEnabled(true);
    adapter.emit({ type: 'sync:joined', sessionEpochMs: 5000, serverNowMs: Date.now() });

    const vc = adapter.sendRaw.mock.calls
      .map((c) => c[0])
      .find((m) => m?.msg?.kind === 'orbiters:voice-count');
    expect(vc?.msg?.count).toBe(1); // not 0
    pulse.dispose();
  });

  it('drives tempo through the facade (setTempo / getTempoBpm / onTempoChange)', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter = fakeAdapter();
    const pulse = initSharedClockPulse(adapter, { sessionId: 's1', audioEngine: null });

    const seen = [];
    pulse.onTempoChange((e) => seen.push(e));
    pulse.setTempo(140, { sourceType: 'module' });

    expect(pulse.getTempoBpm()).toBe(140);
    expect(seen).toEqual([{ tempoBpm: 140, sourceType: 'module' }]);
    pulse.dispose();
  });

  it('a REPEAT sync:joined (socket auto-reconnect) RE-RUNS the join — hello re-announced', () => {
    // The old contract ignored a second sync:joined. That left a reconnected client mute in the
    // fresh session: no beat:hello, so no peer replied its timeline, and a tempo the room changed
    // while the socket was down was only adopted on its NEXT change ("synced but didn't adopt").
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter = fakeAdapter();
    const pulse = initSharedClockPulse(adapter, { sessionId: 's1', audioEngine: null });
    pulse.setEnabled(true); // participate

    adapter.emit({ type: 'sync:joined', sessionEpochMs: 5000, serverNowMs: Date.now() });
    const hellosAfterFirst = adapter.sendRaw.mock.calls.filter((c) => c[0]?.msg?.kind === 'beat:hello').length;
    expect(hellosAfterFirst).toBeGreaterThan(0); // first join announced
    adapter.emit({ type: 'sync:joined', sessionEpochMs: 5000, serverNowMs: Date.now() });
    const hellosAfterSecond = adapter.sendRaw.mock.calls.filter((c) => c[0]?.msg?.kind === 'beat:hello').length;
    expect(hellosAfterSecond).toBeGreaterThan(hellosAfterFirst); // re-join re-announces presence

    pulse.dispose();
  });
});
