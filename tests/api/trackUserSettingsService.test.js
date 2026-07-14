// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api/httpClient.js', () => ({
  fetchJsonFromApi: vi.fn(),
}));

vi.mock('../../src/api/dataManager/loaders.js', () => ({
  getEmbeddedAuthToken: vi.fn(() => 'Bearer test-token'),
  requestEmbeddedAuthToken: vi.fn(),
}));

vi.mock('../../src/ui/loginPrompt.js', () => ({
  ensureLoginPrompt: vi.fn(),
  getLoginHref: vi.fn(() => '/login'),
}));

import { fetchJsonFromApi } from '../../src/api/httpClient.js';
import { fetchTrackUserSettings } from '../../src/api/trackUserSettingsService.js';

beforeEach(() => {
  fetchJsonFromApi.mockReset();
});

describe('fetchTrackUserSettings', () => {
  it('flattens ownerSettings.settings into the runtime sync shape', async () => {
    fetchJsonFromApi.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        success: true,
        ownerSettings: {
          trackId: 'track-meter',
          settings: {
            sync: {
              meter: '6/8',
              trackBpm: 130,
            },
          },
        },
      }),
    });

    const result = await fetchTrackUserSettings('track-meter');

    expect(result).toMatchObject({
      trackId: 'track-meter',
      sync: {
        meter: '6/8',
        trackBpm: 130,
      },
    });
  });
});
