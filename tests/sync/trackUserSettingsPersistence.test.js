// @vitest-environment jsdom
/**
 * trackUserSettingsPersistence per-voice behavior.
 *
 * The save path no longer reads the removed Constants.TRACK_ID/TRACK_DATA single-current globals:
 * the caller passes the active voice's trackId explicitly, and the post-save cache refresh resolves
 * the combined config from the keyed snapshot cache via Constants.getConfigByTrackId. These tests pin
 * that contract (with the network service mocked).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/api/trackUserSettingsService.js', () => ({
  saveTrackUserSettings: vi.fn(async (trackId, payload) => ({ trackId, payload, ok: true })),
}));

import { saveTrackUserSettings } from '../../src/api/trackUserSettingsService.js';
import { queueTrackSyncSettingsSave } from '../../src/sync/trackUserSettingsPersistence.js';
import { Constants } from '../../src/config/Constants.js';

// NOTE: the module keeps module-level debounce state incl. a `lastSavedFingerprint` dedup. Each test
// below uses a DISTINCT { trackId, payload } so no test's save is deduped by a prior test's fingerprint.
beforeEach(() => {
  saveTrackUserSettings.mockClear();
  Constants.clearAllCaches();
});

describe('queueTrackSyncSettingsSave — no single-current global fallback', () => {
  it('resolves null and does NOT save when no trackId is passed (the TRACK_ID fallback is gone)', async () => {
    const result = await queueTrackSyncSettingsSave({ trackBpm: 121, immediate: true });
    expect(result).toBeNull();
    expect(saveTrackUserSettings).not.toHaveBeenCalled();
  });

  it('saves under the trackId the caller passes', async () => {
    await queueTrackSyncSettingsSave({ trackId: 'track-save', trackBpm: 128, immediate: true });
    expect(saveTrackUserSettings).toHaveBeenCalledTimes(1);
    const [trackId, payload] = saveTrackUserSettings.mock.calls[0];
    expect(trackId).toBe('track-save');
    expect(payload.sync.trackBpm).toBe(128);
  });
});

describe('post-save cache refresh — resolves the combined via getConfigByTrackId', () => {
  it('mutates the keyed snapshot for the saved track (no Constants.TRACK_DATA read)', async () => {
    // Seed the keyed snapshot cache the way DataManager would, under a non-default config key.
    const combined = {
      track: { trackId: 'track-cache' },
      orbiter: { orbiterId: 'orb-1' },
      entangledWorld: { worldId: 'world-1' },
      trackUserSettings: { sync: { trackBpm: 90 } },
    };
    Constants.setTrackData('track-cache', combined); // keyed under 'track-cache|orb-1|world-1'

    await queueTrackSyncSettingsSave({ trackId: 'track-cache', trackBpm: 140, immediate: true });

    // The cached combined's sync settings were refreshed in place (found via the trackId prefix scan).
    const cached = Constants.getConfigByTrackId('track-cache');
    expect(cached.trackUserSettings.sync.trackBpm).toBe(140);
    expect(cached.trackUserSettings.trackId).toBe('track-cache');
  });

  it('leaves the cache untouched when no snapshot exists for the track', async () => {
    await queueTrackSyncSettingsSave({ trackId: 'ghost-track', trackBpm: 100, immediate: true });
    expect(saveTrackUserSettings).toHaveBeenCalledTimes(1); // the save still happens
    expect(Constants.getConfigByTrackId('ghost-track')).toBeNull(); // nothing cached to refresh
  });
});

describe('meter rides the same per-track sync payload as tempo', () => {
  it('writes a valid meter into sync.meter', async () => {
    await queueTrackSyncSettingsSave({ trackId: 'track-meter-1', meter: '3/4', immediate: true });
    const [trackId, payload] = saveTrackUserSettings.mock.calls[0];
    expect(trackId).toBe('track-meter-1');
    expect(payload.sync.meter).toBe('3/4');
  });

  it('saves meter ALONGSIDE tempo in one payload', async () => {
    await queueTrackSyncSettingsSave({ trackId: 'track-meter-2', trackBpm: 132, meter: '6/8', immediate: true });
    const [, payload] = saveTrackUserSettings.mock.calls[0];
    expect(payload.sync.trackBpm).toBe(132);
    expect(payload.sync.meter).toBe('6/8');
  });

  it('writes arbitrary valid meters', async () => {
    await queueTrackSyncSettingsSave({ trackId: 'track-meter-3', trackBpm: 120, meter: '7/16', immediate: true });
    const [, payload] = saveTrackUserSettings.mock.calls[0];
    expect(payload.sync.meter).toBe('7/16');
    expect(payload.sync.trackBpm).toBe(120);
  });

  it('omits an invalid meter (never clobbers with junk)', async () => {
    await queueTrackSyncSettingsSave({ trackId: 'track-meter-4', trackBpm: 120, meter: '7/15', immediate: true });
    const [, payload] = saveTrackUserSettings.mock.calls[0];
    expect(payload.sync.meter).toBeUndefined();
    expect(payload.sync.trackBpm).toBe(120);
  });
});
