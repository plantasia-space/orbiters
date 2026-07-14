/**
 * @file src/api/httpClient.js
 * @description Thin helpers for resolving the API base/version and issuing authenticated fetch calls.
 */
// index.html assigns `window.API_BASE = "%VITE_API_BASE%"` for Vite to substitute at build time;
// with no env configured the literal `%…%` placeholder survives, and it must read as "unconfigured",
// not as a real base URL.
function readConfigValue(value) {
  if (!value) return null;
  const str = String(value);
  return /^%.*%$/.test(str) ? null : str;
}

/**
 * Resolves the base URL for API calls by checking global/window configuration.
 * @returns {string|null}
 */
export function resolveApiBase() {
  if (typeof window === 'undefined') return null;

  const rawBase =
    readConfigValue(window.API_BASE) ||
    (typeof import.meta !== 'undefined' && import.meta.env && readConfigValue(import.meta.env.VITE_API_BASE));

  if (!rawBase) {
    console.warn('[HTTP] API base URL missing.');
    return null;
  }

  const rawVersion =
    readConfigValue(window.API_VERSION) ||
    (typeof import.meta !== 'undefined' && import.meta.env && readConfigValue(import.meta.env.VITE_API_VERSION));

  const base = String(rawBase).replace(/\/$/, '');
  if (!rawVersion) return base;

  const version = String(rawVersion).replace(/^\/|\/$/g, '');
  // Avoid double-appending if already present
  return base.endsWith(`/${version}`) ? base : `${base}/${version}`;
}

/**
 * Builds a `Headers` instance ensuring the Authorization header is attached when needed.
 * @param {HeadersInit} headers
 * @param {string|null} authToken
 * @returns {Headers}
 */
export function buildAuthHeaders(headers = {}, authToken = null) {
  const merged = new Headers(headers);
  if (authToken && !merged.has('Authorization')) {
    const tokenValue = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;
    merged.set('Authorization', tokenValue);
  }
  return merged;
}

/**
 * Issues a fetch request relative to the resolved API base (or absolute URL) and applies
 * JSON defaults plus auth headers.
 * @param {string} path
 * @param {object} options
 * @returns {Promise<Response>}
 */
export async function fetchJsonFromApi(path, options = {}) {
  const {
    method = 'GET',
    headers = {},
    authToken = null,
    body,
    signal,
    credentials = 'include',
  } = options;

  const base = resolveApiBase();
  if (!base) {
    throw new Error('API base URL not configured');
  }

  const isAbsolute = /^https?:\/\//i.test(path);
  const url = isAbsolute ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;

  const mergedHeaders = buildAuthHeaders(headers, authToken);
  if (!mergedHeaders.has('Accept')) {
    mergedHeaders.set('Accept', 'application/json');
  }

  const fetchOptions = {
    method,
    headers: mergedHeaders,
    credentials,
    signal,
  };

  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || (body instanceof FormData)) {
      fetchOptions.body = body;
    } else {
      fetchOptions.body = JSON.stringify(body);
      if (!mergedHeaders.has('Content-Type')) {
        mergedHeaders.set('Content-Type', 'application/json');
      }
    }
  }

  return fetch(url, fetchOptions);
}
