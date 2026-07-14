/**
 * @file src/auth/sessionAuth.js
 * @description Bridges host session cookies with Firebase Auth so embedded Orbiters clients
 * can reuse the same identity and surface login prompts when tokens expire.
 */
import { getFirebaseApp, getFirebaseAuthModule, getLoadedFirebaseApp } from './firebaseClient.js';
import { ensureLoginPrompt, getLoginHref } from '../ui/loginPrompt.js';

let authSyncPromise = null;
let externalAuthToken = null;
let externalAuthTokenExpiry = null;
// Bumped on every token mutation. A deferred sign-out captures the epoch and bails if a
// newer set/clear has since run — so a clear immediately followed by a fresh token can
// never have its sign-out land on (and tear down) the new session.
let authEpoch = 0;
const QUIET_REMOTE_ERRORS =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SILENT_REMOTE_ERRORS !== 'false') ??
  true;

function logRemoteError(type, ...args) {
  if (QUIET_REMOTE_ERRORS) {
    return;
  }
  const logger = type === 'error' ? console.error : console.warn;
  logger?.(...args);
}

const IS_IFRAME = typeof window !== 'undefined' && window.self !== window.top;

/**
 * Resolves the API base (including version suffix) from global/window configuration.
 * @returns {string|null}
 */
function getApiBase() {
  if (typeof window === 'undefined') return null;

  const rawBase =
    window.API_BASE ||
    (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE);

    if (!rawBase || typeof rawBase !== 'string') {
      logRemoteError('warn', '[Auth] API base URL unavailable; cannot request custom token.');
      return null;
    }

  const rawVersion =
    window.API_VERSION ||
    (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_VERSION);

  const base = rawBase.replace(/\/$/, '');
  if (!rawVersion) return base;

  const version = String(rawVersion).replace(/^\/|\/$/g, '');
  return base.endsWith(`/${version}`) ? base : `${base}/${version}`;
}

/**
 * Posts to the host `/auth/custom-token` endpoint to retrieve a Firebase custom token.
 * Handles auth errors by surfacing the login prompt.
 * @param {string} apiBase
 * @returns {Promise<string|null>}
 */
async function requestCustomToken(apiBase) {
  try {
    const response = await fetch(`${apiBase}/auth/custom-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'include',
    });

    if (response.status === 401 || response.status === 403) {
      logRemoteError('warn', '[Auth] Session cookie not accepted when requesting custom token.');
      ensureLoginPrompt({ href: getLoginHref(), text: 'Login' });
      return null;
    }

    if (!response.ok) {
      logRemoteError('error', '[Auth] Failed to retrieve custom token:', response.status, response.statusText);
      return null;
    }

    const payload = await response.json().catch(() => null);
    const token = payload?.customToken || payload?.token || null;
    if (!token) {
    logRemoteError('warn', '[Auth] Custom token endpoint returned unexpected payload.', payload);
      return null;
    }
    return token;
  } catch (error) {
    logRemoteError('error', '[Auth] Error requesting custom token:', error);
    return null;
  }
}

/**
 * Ensures Firebase Auth is initialised using either a host-provided token or the
 * session cookie → custom token flow. Returns the signed-in user or null.
 * @returns {Promise<import('firebase/auth').User|null>}
 */
export async function ensureFirebaseAuthFromSession() {
  if (authSyncPromise) {
    return authSyncPromise;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  authSyncPromise = (async () => {
    const app = await getFirebaseApp();
    if (!app) return null;

    const authModule = await getFirebaseAuthModule();
    const auth = authModule.getAuth(app);

    if (auth.currentUser) {
      return auth.currentUser;
    }

    const now = Date.now();
    if (externalAuthToken && (!externalAuthTokenExpiry || externalAuthTokenExpiry > now)) {
      try {
        await authModule.signInWithCustomToken(auth, externalAuthToken);
        return auth.currentUser;
      } catch (error) {
        logRemoteError('error', '[Auth] Failed to use external custom token:', error);
        externalAuthToken = null;
        externalAuthTokenExpiry = null;
      }
    } else if (externalAuthTokenExpiry && externalAuthTokenExpiry <= now) {
      externalAuthToken = null;
      externalAuthTokenExpiry = null;
    }

    if (IS_IFRAME) {
      // Embedded clients rely on host-provided tokens; silently noop until provided.
      return null;
    }

    const apiBase = getApiBase();
    if (!apiBase) return null;

    const customToken = await requestCustomToken(apiBase);
    if (!customToken) {
      return null;
    }

      try {
        await authModule.signInWithCustomToken(auth, customToken);
        return auth.currentUser;
      } catch (error) {
        logRemoteError('error', '[Auth] Failed to sign in with custom token:', error);
        return null;
      }
  })();

  try {
    return await authSyncPromise;
  } finally {
    authSyncPromise = null;
  }
}

/**
 * Clears the cached auth sync promise so the next call re-runs the token handshake.
 */
export function clearAuthSyncState() {
  authSyncPromise = null;
}

/**
 * Accepts an externally-provided Firebase custom token (e.g., iframe host) and
 * attempts to sign in immediately. Passing null clears the token state.
 * @param {string|null} token
 * @param {{ expiresAt?: number|null }} [options]
 */
/**
 * Best-effort Firebase sign-out. Only acts on an app that is already initialized —
 * clearing a token must never be the thing that boots the Firebase SDK. Bails if a newer
 * token mutation has run since it was scheduled (`epoch` no longer current), so a stale
 * clear cannot sign out a freshly-provided session.
 */
async function signOutFirebaseSession(epoch) {
  const app = getLoadedFirebaseApp();
  if (!app || epoch !== authEpoch) return;
  try {
    const authModule = await getFirebaseAuthModule();
    if (epoch !== authEpoch) return;
    const auth = authModule.getAuth(app);
    if (auth.currentUser) {
      await authModule.signOut(auth);
    }
  } catch (error) {
    logRemoteError('warn', '[Auth] Failed to sign out Firebase session:', error);
  }
}

export function setExternalAuthToken(token, { expiresAt = null } = {}) {
  const epoch = ++authEpoch;
  if (!token || typeof token !== 'string' || !token.trim()) {
    const hadToken = Boolean(externalAuthToken);
    externalAuthToken = null;
    externalAuthTokenExpiry = null;
    clearAuthSyncState();
    // The host clearing its token means the user logged out there. End the Firebase
    // session too — otherwise the previous identity keeps minting valid ID tokens
    // (a real problem on shared browsers).
    if (hadToken) {
      void signOutFirebaseSession(epoch);
    }
    return;
  }

  externalAuthToken = token.trim();
  externalAuthTokenExpiry = Number.isFinite(expiresAt) ? expiresAt : null;
  clearAuthSyncState();
  void ensureFirebaseAuthFromSession();
}
