/**
 * @file src/api/orbiterEngines.js
 * @description Utility functions for discovering Orbiters engine configuration bundles.
 */
import { fetchJsonFromApi, resolveApiBase } from './httpClient.js';

/**
 * Builds the fully-qualified URL for the engines config endpoint when an API base exists.
 * @returns {string|null}
 */
export function getOrbitersEnginesConfigUrl() {
  const base = resolveApiBase();
  if (!base) return null;
  return `${base}/orbiters/engines-config-files`;
}

/**
 * Fetches the engines configuration JSON from the API (with fallback to relative fetch).
 * @param {RequestInit & { authToken?: string }} options
 * @returns {Promise<object>}
 */
export async function fetchOrbitersEngines(options = {}) {
  const base = resolveApiBase();

  if (base) {
    const response = await fetchJsonFromApi('/orbiters/engines-config-files', options);
    if (!response.ok) {
      throw new Error(`[OrbitersEngines] Request failed with status ${response.status}`);
    }
    return response.json();
  }

  const resp = await fetch('/orbiters/engines-config-files', {
    method: options.method || 'GET',
    headers: options.headers,
    signal: options.signal,
    credentials: options.credentials || 'include'
  });

  if (!resp.ok) {
    throw new Error(`[OrbitersEngines] Relative request failed with status ${resp.status}`);
  }

  return resp.json();
}
