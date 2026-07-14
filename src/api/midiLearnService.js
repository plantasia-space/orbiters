/**
 * @file src/api/midiLearnService.js
 * @description REST helpers for fetching and persisting user MIDI learn mappings.
 */
import { fetchJsonFromApi } from './httpClient.js';
import { getEmbeddedAuthToken, requestEmbeddedAuthToken } from './dataManager/loaders.js';
import { ensureLoginPrompt, getLoginHref } from '../ui/loginPrompt.js';

const ENDPOINT = '/me/users/configurations/midi-learn';

/**
 * Pulls the embedded auth token if available (requests a refresh as needed).
 * @returns {string|undefined}
 */
function resolveAuthToken() {
  const token = getEmbeddedAuthToken();
  if (!token) {
    requestEmbeddedAuthToken();
  }
  return token || undefined;
}

/**
 * Normalises API responses and surfaces auth errors with actionable messaging.
 * @param {Response} response
 * @param {string} authErrorMessage
 * @returns {Promise<object>}
 */
async function handleResponse(response, authErrorMessage) {
  if (response.status === 204) {
    return {};
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      requestEmbeddedAuthToken();
      ensureLoginPrompt({ href: getLoginHref(), text: 'Log in' });
      throw new Error(authErrorMessage);
    }

    let message = `${authErrorMessage} (status ${response.status})`;
    try {
      const data = await response.json();
      if (data?.message) {
        message = data.message;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function handleLoadResponse(response) {
  if (response.status === 204) {
    return {};
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      requestEmbeddedAuthToken();
      return {};
    }

    let message = `Failed to load MIDI mappings (status ${response.status})`;
    try {
      const data = await response.json();
      if (data?.message) {
        message = data.message;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  try {
    return await response.json();
  } catch {
    return {};
  }
}

/**
 * Loads MIDI learn mappings for the authenticated user.
 *
 * Pass an orbiterId string to scope the response to a single orbiter's bindings — the
 * hot path used on every orbiter open, which returns no names. Pass `{ scope, entityId }` to
 * scope to any other slice (e.g. a collection's shell bindings). Call with no argument to get
 * the full tree plus the `orbiterNames`/`collectionNames` maps (used only by the
 * load-saved-mappings dialog).
 *
 * @param {string|{scope: string, entityId: string}} [scopeRef] - scope the request to one slice.
 * @returns {Promise<object>} `{ midiLearn, orbiterNames?, collectionNames? }`
 */
export async function fetchMidiMappings(scopeRef) {
  // Resolve the embedded Bearer token when present (and request one if missing), but do NOT
  // bail out when it is absent: in production the orbiter iframe is usually authenticated by the
  // session cookie alone (fetchJsonFromApi sends `credentials: 'include'`), exactly like the PUT
  // save path. Short-circuiting here meant the GET was never issued, so saved mappings never loaded.
  const authToken = resolveAuthToken();

  let url = ENDPOINT;
  if (typeof scopeRef === 'string' && scopeRef) {
    url = `${ENDPOINT}?orbiterId=${encodeURIComponent(scopeRef)}`;
  } else if (scopeRef?.scope && scopeRef?.entityId) {
    url = `${ENDPOINT}?scope=${encodeURIComponent(scopeRef.scope)}&entityId=${encodeURIComponent(scopeRef.entityId)}`;
  }

  const response = await fetchJsonFromApi(url, {
    method: 'GET',
    authToken,
  });

  return handleLoadResponse(response);
}

/**
 * Persists a MIDI mapping for the provided scope/entity/parameter pairing.
 * @param {{ scope: string, entityId: string, parameterId: string, binding: object }} payload
 * @returns {Promise<object>}
 */
export async function saveMidiMapping({ scope, entityId, parameterId, binding }) {
  if (!scope || !entityId || !parameterId || !binding) {
    throw new Error('saveMidiMapping requires scope, entityId, parameterId, and binding.');
  }

  const response = await fetchJsonFromApi(ENDPOINT, {
    method: 'PUT',
    authToken: resolveAuthToken(),
    body: { scope, entityId, parameterId, binding },
  });

  return handleResponse(response, 'Authentication required to save MIDI mappings');
}

/**
 * Removes a MIDI mapping for the provided scope/entity/parameter pairing on the server.
 * @param {{ scope: string, entityId: string, parameterId: string }} payload
 * @returns {Promise<object>}
 */
export async function clearMidiMappingRemote({ scope, entityId, parameterId }) {
  if (!scope || !entityId || !parameterId) {
    throw new Error('clearMidiMappingRemote requires scope, entityId, and parameterId.');
  }

  const response = await fetchJsonFromApi(ENDPOINT, {
    method: 'PUT',
    authToken: resolveAuthToken(),
    body: { scope, entityId, parameterId, binding: null },
  });

  return handleResponse(response, 'Authentication required to update MIDI mappings');
}

/**
 * Replace one slice's MIDI mappings with another slice's of the SAME scope (the
 * load-saved-mappings dialog: orbiter → orbiter parameter bindings, collection → collection
 * shell bindings). Copy-first-then-clear so a mid-flight failure never leaves the target
 * empty: every source binding is written before any leftover target binding is cleared. Runs
 * sequentially because legacy-scope PUTs are read-modify-writes of the same user-settings
 * document — parallel writes could clobber each other. (Collection-scope writes are atomic
 * per parameter server-side, but the sequential shape keeps one code path and a determinate
 * progress bar.)
 *
 * @param {object} args
 * @param {string} args.scope - the slice scope ('orbiter' | 'collection').
 * @param {Record<string, object>} args.sourceBindings - parameterId → binding, from the source slice.
 * @param {string} args.targetEntityId - the entity being overwritten (the current one).
 * @param {string[]} [args.targetParamIds] - parameterIds the target currently has, to clear leftovers.
 * @param {(done: number, total: number) => void} [args.onProgress] - called after each step (and once
 *   up front with done=0) so the UI can show a determinate loading bar across the sequential writes.
 */
export async function replaceScopedMappings({ scope, sourceBindings, targetEntityId, targetParamIds = [], onProgress }) {
  if (!scope || !targetEntityId) {
    throw new Error('replaceScopedMappings requires a scope and a targetEntityId.');
  }
  const source = sourceBindings && typeof sourceBindings === 'object' ? sourceBindings : {};
  const srcParamIds = Object.keys(source);

  // Leftovers = target params the source won't overwrite (cleared after the copy phase).
  const srcSet = new Set(srcParamIds);
  const leftovers = targetParamIds.filter((parameterId) => !srcSet.has(parameterId));

  const total = srcParamIds.length + leftovers.length;
  let done = 0;
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  report(0, total);
  const step = () => report((done += 1), total);

  // Copy phase — write every source binding into the target first.
  for (const parameterId of srcParamIds) {
    await saveMidiMapping({ scope, entityId: targetEntityId, parameterId, binding: source[parameterId] });
    step();
  }

  // Clear phase — remove only the target's leftovers that the source didn't overwrite.
  for (const parameterId of leftovers) {
    await clearMidiMappingRemote({ scope, entityId: targetEntityId, parameterId });
    step();
  }
}
