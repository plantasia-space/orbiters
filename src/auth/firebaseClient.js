/**
 * @file src/auth/firebaseClient.js
 * @description Lazy-loads Firebase app/auth modules from the CDN and exposes helpers to
 * reuse a single instance across the Orbiters runtime.
 */
const FIREBASE_VERSION = '11.9.1';

let firebaseAppInstance = null;
let appInitPromise = null;
let authModulePromise = null;

/**
 * Reads config values from Vite env or window globals (whichever is available).
 * @param {string} key
 * @returns {string|null}
 */
function readEnv(key) {
  const fromImportMeta = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env[key] : undefined;
  const fromWindow = typeof window !== 'undefined' ? window[key] : undefined;
  return fromImportMeta || fromWindow || null;
}

/**
 * Builds the minimal Firebase config needed for initialiseApp. Returns null if
 * required keys are missing so callers can short-circuit.
 * @returns {{ apiKey: string, authDomain: string, projectId: string }|null}
 */
function getFirebaseConfig() {
  const apiKey = readEnv('VITE_PUBLIC_FIREBASE_API_KEY');
  const authDomain = readEnv('VITE_PUBLIC_FIREBASE_AUTH_DOMAIN');
  const projectId = readEnv('VITE_PUBLIC_FIREBASE_PROJECT_ID');

  if (!apiKey || !authDomain || !projectId) {
    console.warn('[Auth] Firebase config incomplete; skipping client init.', {
      hasApiKey: Boolean(apiKey),
      hasAuthDomain: Boolean(authDomain),
      hasProjectId: Boolean(projectId),
    });
    return null;
  }

  return {
    apiKey,
    authDomain,
    projectId,
  };
}

/**
 * Resolves (and caches) the singleton Firebase app instance, loading the SDK dynamically.
 * @returns {Promise<import('firebase/app').FirebaseApp|null>}
 */
export async function getFirebaseApp() {
  if (firebaseAppInstance) return firebaseAppInstance;
  if (appInitPromise) return appInitPromise;

  const config = getFirebaseConfig();
  if (!config) {
    return null;
  }

  appInitPromise = (async () => {
    const { initializeApp, getApps } = await import(
      /* @vite-ignore */ /* webpackIgnore: true */ `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`
    );
    const apps = getApps();
    firebaseAppInstance = apps && apps.length ? apps[0] : initializeApp(config);
    return firebaseAppInstance;
  })();

  try {
    return await appInitPromise;
  } finally {
    appInitPromise = null;
  }
}

/**
 * Returns the already-initialized Firebase app, or null — never triggers SDK loading.
 * Lets callers act on an existing auth session (e.g. sign-out) without booting Firebase.
 * @returns {import('firebase/app').FirebaseApp|null}
 */
export function getLoadedFirebaseApp() {
  return firebaseAppInstance;
}

/**
 * Loads the Firebase auth module from the CDN and caches the promise.
 * @returns {Promise<typeof import('firebase/auth')>}
 */
export async function getFirebaseAuthModule() {
  if (authModulePromise) {
    return authModulePromise;
  }

  authModulePromise = import(
    /* @vite-ignore */ /* webpackIgnore: true */ `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`
  );
  try {
    return await authModulePromise;
  } finally {
    authModulePromise = null;
  }
}
