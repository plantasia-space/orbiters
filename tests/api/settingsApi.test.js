import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchJsonFromApi } from '../../src/api/httpClient.js';
import { getEmbeddedAuthToken, requestEmbeddedAuthToken } from '../../src/api/dataManager/loaders.js';
import { ensureFirebaseAuthFromSession } from '../../src/auth/sessionAuth.js';
import { fetchUserSettings } from '../../src/api/settingsApi.js';

vi.mock('../../src/api/httpClient.js', () => ({
  fetchJsonFromApi: vi.fn(),
}));

vi.mock('../../src/api/dataManager/loaders.js', () => ({
  getEmbeddedAuthToken: vi.fn(),
  requestEmbeddedAuthToken: vi.fn(),
}));

vi.mock('../../src/auth/sessionAuth.js', () => ({
  ensureFirebaseAuthFromSession: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchUserSettings', () => {
  it('still calls /me/users/settings when no token is available so cookies can authenticate', async () => {
    getEmbeddedAuthToken.mockReturnValue(null);
    ensureFirebaseAuthFromSession.mockResolvedValue(null);
    fetchJsonFromApi.mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn(),
    });

    const result = await fetchUserSettings();

    expect(result).toBeNull();
    expect(requestEmbeddedAuthToken).toHaveBeenCalledTimes(1);
    expect(fetchJsonFromApi).toHaveBeenCalledWith('/me/users/settings', {
      method: 'GET',
      signal: undefined,
      authToken: null,
      credentials: 'include',
    });
  });

  it('unwraps the API response and uses the embedded auth token when present', async () => {
    const settings = { general: { themeMode: 'dark' } };
    getEmbeddedAuthToken.mockReturnValue('Bearer embedded-token');
    fetchJsonFromApi.mockResolvedValue({
      ok: true,
      json: vi.fn(() => Promise.resolve({ settings })),
    });

    await expect(fetchUserSettings()).resolves.toBe(settings);

    expect(ensureFirebaseAuthFromSession).not.toHaveBeenCalled();
    expect(fetchJsonFromApi).toHaveBeenCalledWith('/me/users/settings', {
      method: 'GET',
      signal: undefined,
      authToken: 'Bearer embedded-token',
      credentials: 'include',
    });
  });

  it('uses a Firebase id token from the session path when there is no embedded token', async () => {
    const getIdToken = vi.fn(() => Promise.resolve('firebase-id-token'));
    getEmbeddedAuthToken.mockReturnValue(null);
    ensureFirebaseAuthFromSession.mockResolvedValue({ getIdToken });
    fetchJsonFromApi.mockResolvedValue({
      ok: true,
      json: vi.fn(() => Promise.resolve({ version: 1 })),
    });

    await fetchUserSettings();

    expect(fetchJsonFromApi).toHaveBeenCalledWith('/me/users/settings', {
      method: 'GET',
      signal: undefined,
      authToken: 'firebase-id-token',
      credentials: 'include',
    });
  });

  it('also accepts a raw settings object for compatibility with older clients/mocks', async () => {
    const settings = { version: 1, general: { themeMode: 'light' } };
    getEmbeddedAuthToken.mockReturnValue('Bearer embedded-token');
    fetchJsonFromApi.mockResolvedValue({
      ok: true,
      json: vi.fn(() => Promise.resolve(settings)),
    });

    await expect(fetchUserSettings()).resolves.toBe(settings);
  });
});
