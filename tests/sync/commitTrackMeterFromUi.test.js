// @vitest-environment jsdom
/**
 * The write-path routing for the reported bug: meter is ALWAYS per-voice (a property of the track,
 * never shared — even between two synced voices). Editing meter for a specific voice applies LOCALLY
 * via that voice's own `WrapGridState.setOwnMeter` and persists to THAT voice's own track, regardless
 * of sync state — there is no shared-meter write path, so it can never leak to a sibling. See
 * `trackSettingsCommit.js`'s `applyTrackMeterFromUi`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/sync/trackUserSettingsPersistence.js', () => ({
  queueTrackSyncSettingsSave: vi.fn(() => Promise.resolve(null)),
}));

import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';
import { syncCoordinator } from '../../src/sync/SyncCoordinator.js';
import { commitTrackMeterFromUi, setTrackMeterLiveFromUi } from '../../src/sync/trackSettingsCommit.js';
import { queueTrackSyncSettingsSave } from '../../src/sync/trackUserSettingsPersistence.js';

// The meter edit routes to `voiceRegistry.get(id)?.deck?.setMeter` (the deck is the meter owner) —
// stub the deck on the record rather than going through the real Deck.setSyncEnabled, which also
// drives the REAL SyncCoordinator's enable() as a production side effect this test isn't exercising.
function makeVoice(id, { meter = '4/4', trackId = `track-${id}`, syncEnabled = false, ownTrackBpm = null } = {}) {
  const setOwnMeter = vi.fn();
  const audioEngine = {
    trackData: { track: { trackId } },
    getOwnTrackBpm: () => ownTrackBpm,
  };
  voiceRegistry.register(id, { id, audioEngine, deck: { syncEnabled, setMeter: setOwnMeter, meter } });
  return { setOwnMeter, audioEngine };
}

beforeEach(() => {
  voiceRegistry.clear();
  vi.mocked(queueTrackSyncSettingsSave).mockClear();
});

describe('commitTrackMeterFromUi / setTrackMeterLiveFromUi — per-voice routing', () => {
  it('there is no shared-meter write path on the coordinator to leak through', () => {
    expect(syncCoordinator.setMeter).toBeUndefined();
    expect(syncCoordinator.meter).toBeUndefined();
  });

  it('an UNSYNCED voice applies the edit locally on its own WrapGridState', () => {
    const { setOwnMeter } = makeVoice('b', { meter: '4/4', syncEnabled: false });

    commitTrackMeterFromUi('6/8', 'b');

    expect(setOwnMeter).toHaveBeenCalledWith('6/8');
  });

  it('a SYNCED voice ALSO applies the edit locally — meter is always per-voice, never shared', () => {
    // The binding product decision: two synced voices hold independent meters. A synced voice's edit
    // goes to its OWN WrapGridState, exactly like an unsynced one — it must not fan to any sibling.
    const other = makeVoice('a', { meter: '4/4', syncEnabled: true });
    const edited = makeVoice('b', { meter: '4/4', syncEnabled: true });

    commitTrackMeterFromUi('3/4', 'b');

    expect(edited.setOwnMeter).toHaveBeenCalledWith('3/4');
    expect(other.setOwnMeter).not.toHaveBeenCalled();
  });

  it('persists to the EDITING voice\'s own track, not whichever voice is "active"', () => {
    makeVoice('active-voice', { trackId: 'track-active' });
    const editedVoice = makeVoice('edited-voice', { trackId: 'track-edited', syncEnabled: false });
    voiceRegistry.setActive?.('active-voice');

    commitTrackMeterFromUi('5/4', 'edited-voice');

    expect(editedVoice.setOwnMeter).toHaveBeenCalledWith('5/4');
    expect(queueTrackSyncSettingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 'track-edited', meter: '5/4' }),
    );
  });

  it('setTrackMeterLiveFromUi applies the same routing but never persists', () => {
    const { setOwnMeter } = makeVoice('b', { meter: '4/4', syncEnabled: false });

    setTrackMeterLiveFromUi('6/8', 'b');

    expect(setOwnMeter).toHaveBeenCalledWith('6/8');
    expect(queueTrackSyncSettingsSave).not.toHaveBeenCalled();
  });

  it('a meter-only commit for an unsynced voice does NOT overwrite its saved tempo with the shared coordinator\'s (caught in review)', () => {
    // The shared coordinator's trackBpm belongs to whatever OTHER (synced) voice last set it — e.g.
    // voice A synced at 120bpm — while THIS voice's own native tempo is 98bpm. Editing only its meter
    // must persist 98, never silently overwrite the saved row with 120.
    syncCoordinator.setTrackBpm(120, { source: 'test-contaminating-voice' });
    makeVoice('b', { meter: '4/4', trackId: 'track-b', syncEnabled: false, ownTrackBpm: 98 });

    commitTrackMeterFromUi('6/8', 'b');

    expect(queueTrackSyncSettingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 'track-b', meter: '6/8', trackBpm: 98 }),
    );
  });
});
