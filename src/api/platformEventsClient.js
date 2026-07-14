/**
 * @file src/api/platformEventsClient.js
 * @description Transport helpers for the public Platform Events collector.
 */

import { resolveApiBase } from './httpClient.js';
import { getFirebaseApp, getFirebaseAuthModule } from '../auth/firebaseClient.js';

const PLATFORM_EVENTS_PATH = '/platform-events';

/**
 * Returns the current Firebase Auth ID token without forcing sign-in.
 * @returns {Promise<string|null>}
 */
async function getCurrentAuthToken() {
  try {
    const app = await getFirebaseApp();
    if (!app) {
      return null;
    }

    const authModule = await getFirebaseAuthModule();
    const auth = authModule.getAuth(app);
    const user = auth.currentUser;
    if (!user || typeof user.getIdToken !== 'function') {
      return null;
    }

    return await user.getIdToken();
  } catch {
    return null;
  }
}

/**
 * Returns the frontend collector endpoint for usage events.
 * Follows the same API base/version resolution used by the rest of Orbiters.
 * @returns {string|null}
 */
export function getPlatformEventsEndpoint() {
  const base = resolveApiBase();
  if (!base) {
    return null;
  }
  return `${base}${PLATFORM_EVENTS_PATH}`;
}

/**
 * Posts a batch of platform-events in a single request.
 * @param {object[]} events
 * @param {{ keepalive?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<Response>}
 */
export async function postPlatformEvents(events, { keepalive = false, signal } = {}) {
  const endpoint = getPlatformEventsEndpoint();
  if (!endpoint) {
    throw new Error('[PlatformEvents] API base URL not configured.');
  }

  const token = await getCurrentAuthToken();
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return fetch(endpoint, {
    method: 'POST',
    credentials: 'omit',
    headers,
    body: JSON.stringify(events),
    keepalive,
    signal,
  });
}
