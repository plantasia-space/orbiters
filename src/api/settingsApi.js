/**
 * @file src/api/settingsApi.js
 * @description The signed-in user's settings — general (locale, themeMode), design (theme + fonts).
 * Orbiter Studio uses this for CHROME only. It resolves the inspector shell from
 * `design.theme.id`, matching plantasia.space-root; stale `label`/`variantMap` fields are ignored
 * unless the id no longer exists. The orbiter's own content theme is separate and saved on the
 * orbiter entity. See planning/theme-architecture/PLAN.md.
 */
import { fetchJsonFromApi } from './httpClient.js';
import { getEmbeddedAuthToken, requestEmbeddedAuthToken } from './dataManager/loaders.js';
import { ensureFirebaseAuthFromSession } from '../auth/sessionAuth.js';

async function resolveAuthToken() {
  const embeddedToken = getEmbeddedAuthToken();
  if (embeddedToken) return embeddedToken;

  requestEmbeddedAuthToken();

  const user = await ensureFirebaseAuthFromSession();
  if (user && typeof user.getIdToken === 'function') {
    return await user.getIdToken();
  }
  return null;
}

function normalizeUserSettingsPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload.settings && typeof payload.settings === 'object'
    ? payload.settings
    : payload;
  return candidate && typeof candidate === 'object' ? candidate : null;
}

/**
 * Fetches the signed-in user's settings, or null when unauthenticated / unavailable.
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<object|null>}
 */
export async function fetchUserSettings({ signal } = {}) {
  try {
    const authToken = await resolveAuthToken();
    const response = await fetchJsonFromApi('/me/users/settings', {
      method: 'GET',
      signal,
      authToken,
      credentials: 'include',
    });
    if (!response || !response.ok) return null;
    return normalizeUserSettingsPayload(await response.json());
  } catch {
    return null;
  }
}
