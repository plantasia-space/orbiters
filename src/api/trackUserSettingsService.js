/**
 * @file src/api/trackUserSettingsService.js
 * @description REST helpers for private per-user track settings.
 */
import { fetchJsonFromApi } from './httpClient.js';
import { getEmbeddedAuthToken, requestEmbeddedAuthToken } from './dataManager/loaders.js';
import { ensureLoginPrompt, getLoginHref } from '../ui/loginPrompt.js';

const BASE_ENDPOINT = '/me/users/configurations/track-settings';
const MISSING_TRACK_SETTINGS_PREFIX = 'orbiters:missing-track-user-settings:';

function resolveAuthToken() {
  const token = getEmbeddedAuthToken();
  if (!token) {
    requestEmbeddedAuthToken();
  }
  return token || undefined;
}

function getMissingSettingsStorageKey(trackId) {
  return `${MISSING_TRACK_SETTINGS_PREFIX}${trackId}`;
}

function isKnownMissingTrackSettings(trackId) {
  if (!trackId || typeof window === 'undefined' || !window.sessionStorage) {
    return false;
  }

  try {
    return window.sessionStorage.getItem(getMissingSettingsStorageKey(trackId)) === '1';
  } catch {
    return false;
  }
}

function markMissingTrackSettings(trackId) {
  if (!trackId || typeof window === 'undefined' || !window.sessionStorage) {
    return;
  }

  try {
    window.sessionStorage.setItem(getMissingSettingsStorageKey(trackId), '1');
  } catch {
    // Ignore storage write failures.
  }
}

function clearMissingTrackSettings(trackId) {
  if (!trackId || typeof window === 'undefined' || !window.sessionStorage) {
    return;
  }

  try {
    window.sessionStorage.removeItem(getMissingSettingsStorageKey(trackId));
  } catch {
    // Ignore storage write failures.
  }
}

/**
 * Normalizes backend track-settings responses into the frontend-owned shape.
 *
 * Backend storage currently lives inside a broader mixed user settings schema,
 * and the per-track payload may arrive wrapped like:
 *
 * ```json
 * {
 *   "trackSettings": {
 *     "trackId": "...",
 *     "settings": {
 *       "sync": { ... }
 *     }
 *   }
 * }
 * ```
 *
 * On the frontend we intentionally own a flatter runtime contract:
 *
 * ```js
 * {
 *   trackId,
 *   sync,
 *   ui,
 *   playback,
 *   custom
 * }
 * ```
 *
 * This normalization boundary is important:
 *
 * - the frontend runtime, hydration, and persistence code depend on this shape
 * - backend schema/storage details must not leak through the app
 * - changing the response shape here without an explicit migration will create
 *   backward-compatibility risks for saved track settings hydration
 *
 * If the backend schema evolves, update this function deliberately and keep the
 * normalized frontend contract stable unless there is a coordinated migration.
 *
 * @param {object|null} payload
 * @param {string|null} [trackId]
 * @returns {object|null}
 */
function normalizeTrackSettingsPayload(payload, trackId = null) {
  const directCandidate =
    payload?.trackUserSettings
    ?? payload?.trackSettings
    ?? payload?.settings
    // The GET track-settings response wraps the sync/ui/playback blocks in ownerSettings /
    // effectiveSettings envelopes; unwrap them here too (they were only taught to the nestedSettings
    // list below) so the flat contract doesn't leak envelope keys and the nested trackId is honored.
    ?? payload?.ownerSettings
    ?? payload?.effectiveSettings
    ?? payload?.data?.trackUserSettings
    ?? payload?.data?.trackSettings
    ?? payload?.data?.settings
    ?? payload?.data?.ownerSettings
    ?? payload?.data?.effectiveSettings
    ?? payload?.data
    ?? payload;

  if (!directCandidate || typeof directCandidate !== 'object' || Array.isArray(directCandidate)) {
    return null;
  }

  const resolvedTrackId =
    typeof directCandidate.trackId === 'string' && directCandidate.trackId.trim().length
      ? directCandidate.trackId.trim()
      : trackId;

  const nestedSettings = [
    directCandidate.settings,
    directCandidate.trackUserSettings?.settings,
    directCandidate.trackSettings?.settings,
    directCandidate.ownerSettings?.settings,
    directCandidate.effectiveSettings?.settings,
  ].find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)) ?? null;

  const normalizedSections = nestedSettings || directCandidate;

  return {
    ...directCandidate,
    ...normalizedSections,
    trackId: resolvedTrackId || null,
  };
}

async function handleResponse(
  response,
  authErrorMessage,
  {
    trackId = null,
    promptOnAuthError = true,
    returnNullOnAuthError = false,
    returnNullOnNotFound = false,
  } = {},
) {
  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    if (response.status === 404 && returnNullOnNotFound) {
      markMissingTrackSettings(trackId);
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      requestEmbeddedAuthToken();
      if (promptOnAuthError) {
        ensureLoginPrompt({ href: getLoginHref(), text: 'Log in' });
      }
      if (returnNullOnAuthError) {
        return null;
      }
      throw new Error(authErrorMessage);
    }

    let message = `${authErrorMessage} (status ${response.status})`;
    try {
      const data = await response.json();
      if (data?.message) {
        message = data.message;
      }
    } catch {
      // Ignore JSON parsing errors for non-JSON responses.
    }
    throw new Error(message);
  }

  try {
    const data = await response.json();
    const normalized = normalizeTrackSettingsPayload(data, trackId);
    if (normalized) {
      clearMissingTrackSettings(trackId);
    }
    return normalized;
  } catch {
    return null;
  }
}

function buildTrackEndpoint(trackId) {
  if (!trackId || typeof trackId !== 'string') {
    throw new Error('trackId is required for track user settings requests.');
  }
  return `${BASE_ENDPOINT}/${encodeURIComponent(trackId)}`;
}

/**
 * Loads private per-user settings for one track.
 *
 * Anonymous users return `null` without surfacing a login prompt.
 *
 * @param {string} trackId
 * @param {{ promptOnAuthError?: boolean, returnNullOnAuthError?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function fetchTrackUserSettings(
  trackId,
  { promptOnAuthError = false, returnNullOnAuthError = true } = {},
) {
  if (isKnownMissingTrackSettings(trackId)) {
    return null;
  }

  const authToken = resolveAuthToken();
  if (!authToken) {
    return null;
  }

  const response = await fetchJsonFromApi(buildTrackEndpoint(trackId), {
    method: 'GET',
    authToken,
  });

  return handleResponse(response, 'Authentication required to load track settings', {
    trackId,
    promptOnAuthError,
    returnNullOnAuthError,
    returnNullOnNotFound: true,
  });
}

/**
 * Persists private per-user settings for one track.
 *
 * @param {string} trackId
 * @param {object} payload
 * @param {{ promptOnAuthError?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function saveTrackUserSettings(trackId, payload, { promptOnAuthError = true } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('saveTrackUserSettings requires a payload object.');
  }

  const response = await fetchJsonFromApi(buildTrackEndpoint(trackId), {
    method: 'PUT',
    authToken: resolveAuthToken(),
    body: payload,
  });

  const saved = await handleResponse(response, 'Authentication required to save track settings', {
    trackId,
    promptOnAuthError,
  });

  clearMissingTrackSettings(trackId);
  return saved;
}

/**
 * Removes the saved per-user settings entry for one track.
 *
 * @param {string} trackId
 * @param {{ promptOnAuthError?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function deleteTrackUserSettings(trackId, { promptOnAuthError = true } = {}) {
  const response = await fetchJsonFromApi(buildTrackEndpoint(trackId), {
    method: 'DELETE',
    authToken: resolveAuthToken(),
  });

  const deleted = await handleResponse(response, 'Authentication required to delete track settings', {
    trackId,
    promptOnAuthError,
    returnNullOnNotFound: true,
  });

  markMissingTrackSettings(trackId);
  return deleted;
}
