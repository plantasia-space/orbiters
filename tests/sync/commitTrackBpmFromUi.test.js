// @vitest-environment jsdom
/**
 * Regression for the tempo leak (an unsynced voice's BPM knob retuning a synced sibling): the track-BPM
 * write path must be scoped per-voice. A collection tile's commit routes on THAT voice's own sync — a
 * synced voice adopts the shared master (writes the shared coordinator, which fans the master→track
 * ratio to every synced voice), while an UNSYNCED voice keeps its own native tempo local
 * (`setOwnTrackBpm`) and never touches the shared coordinator. Single-orbiter (no voiceId) is unchanged.
 *
 * The bug this reproduces: `commitTrackBpmFromUi` used to take no voiceId and always wrote
 * `syncCoordinator.setTrackBpm`, so editing an UNSYNCED voice B's BPM changed the shared #trackBpm and
 * a synced voice A adopted the new ratio (confirmed live: B→A, A.baseRate 1 → 1.333).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/sync/trackUserSettingsPersistence.js', () => ({
  queueTrackSyncSettingsSave: vi.fn(() => Promise.resolve(null)),
}));

import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';
import { syncCoordinator } from '../../src/sync/SyncCoordinator.js';
import { commitTrackBpmFromUi } from '../../src/sync/trackSettingsCommit.js';
import { queueTrackSyncSettingsSave } from '../../src/sync/trackUserSettingsPersistence.js';

// The sync gate reads `voiceRegistry.get(id)?.deck?.syncEnabled` — stub the deck flag on the record
// rather than going through the real Deck.setSyncEnabled, which also drives the REAL coordinator
// enable() as a production side effect this unit test isn't exercising.
function makeVoice(id, { trackId = `track-${id}`, syncEnabled = false, ownTrackBpm = null } = {}) {
  const setOwnTrackBpm = vi.fn();
  const audioEngine = {
    trackData: { track: { trackId } },
    setOwnTrackBpm,
    getOwnTrackBpm: () => ownTrackBpm,
  };
  voiceRegistry.register(id, { id, audioEngine, deck: { syncEnabled } });
  return { setOwnTrackBpm, audioEngine };
}

beforeEach(() => {
  voiceRegistry.clear();
  vi.restoreAllMocks(); // reset the setTrackBpm spy's call history between tests
  vi.spyOn(syncCoordinator, 'setTrackBpm').mockImplementation(() => {});
  vi.mocked(queueTrackSyncSettingsSave).mockClear();
});

describe('commitTrackBpmFromUi — per-voice routing (tempo leak regression)', () => {
  it('an UNSYNCED tile keeps its tempo local and never writes the shared coordinator (the B→A leak)', () => {
    // A is synced; B is not. Editing B must NOT reach syncCoordinator.setTrackBpm — that is what fanned
    // the new master→track ratio to A.
    makeVoice('a', { syncEnabled: true });
    const b = makeVoice('b', { trackId: 'track-b', syncEnabled: false });

    commitTrackBpmFromUi(90, 'b');

    expect(syncCoordinator.setTrackBpm).not.toHaveBeenCalled();
    expect(b.setOwnTrackBpm).toHaveBeenCalledWith(90);
    expect(queueTrackSyncSettingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 'track-b', trackBpm: 90 }),
    );
  });

  it('a SYNCED tile updates its OWN native tempo AND refreshes the shared singleton', () => {
    // A track-BPM edit IS the editing voice's new native — the per-voice owner is written on every
    // path, so the follow ratio (master / OWN native) tracks the edit; the coordinator refresh only
    // re-fans master recomputes and keeps the persist-fallback singleton current.
    const a = makeVoice('a', { trackId: 'track-a', syncEnabled: true });

    commitTrackBpmFromUi(140, 'a');

    expect(syncCoordinator.setTrackBpm).toHaveBeenCalledWith(140, expect.objectContaining({ source: 'ui' }));
    expect(a.setOwnTrackBpm).toHaveBeenCalledWith(140);
    expect(queueTrackSyncSettingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 'track-a', trackBpm: 140 }),
    );
  });

  it('single-orbiter, sync OFF: writes the coordinator AND updates its own grid (the fan is gated off)', () => {
    // The coordinator's per-voice bpm fan is gated on enablement, so a sync-off solo orbiter is not
    // reached by setTrackBpm alone — commitTrackBpmFromUi must also drive its grid via setOwnTrackBpm,
    // else the bar/beat lines stay stale. The save path persists the ACTIVE voice's track.
    const solo = makeVoice('solo', { trackId: 'track-solo' });
    voiceRegistry.setActive?.('solo');
    syncCoordinator.disable?.();

    commitTrackBpmFromUi(128);

    expect(syncCoordinator.setTrackBpm).toHaveBeenCalledWith(128, expect.objectContaining({ source: 'ui' }));
    expect(solo.setOwnTrackBpm).toHaveBeenCalledWith(128);
    expect(queueTrackSyncSettingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 'track-solo', trackBpm: 128 }),
    );
  });

  it('single-orbiter, sync ON: writes its own native AND the coordinator', () => {
    // The edit is the voice's new native tempo on every path; the coordinator write keeps the
    // shared singleton + fan behavior identical for the solo case.
    const solo = makeVoice('solo', { trackId: 'track-solo' });
    voiceRegistry.setActive?.('solo');
    vi.spyOn(syncCoordinator, 'isEnabled', 'get').mockReturnValue(true);

    commitTrackBpmFromUi(128);

    expect(syncCoordinator.setTrackBpm).toHaveBeenCalledWith(128, expect.objectContaining({ source: 'ui' }));
    expect(solo.setOwnTrackBpm).toHaveBeenCalledWith(128);
  });

  it('ignores a non-positive / non-finite BPM on every path', () => {
    makeVoice('b', { syncEnabled: false });

    commitTrackBpmFromUi(0, 'b');
    commitTrackBpmFromUi(Number.NaN, 'b');
    commitTrackBpmFromUi(-5);

    expect(syncCoordinator.setTrackBpm).not.toHaveBeenCalled();
    expect(queueTrackSyncSettingsSave).not.toHaveBeenCalled();
  });
});
