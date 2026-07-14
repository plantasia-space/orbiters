/**
 * @file src/input/midi/scopeKey.js
 * @description Scope keys for persisted MIDI bindings: `<scope>:<entityId>` strings
 * (`orbiter:<id>`, `collection:<id>`). One key names one persistence slice — the
 * orbiter-owned tier keeps its exact semantics under `orbiter:` keys, and scopes whose
 * actions belong to no orbiter (the collection studio shell) get first-class slices
 * instead of per-feature escape hatches.
 */

/** Backend scopes a binding may persist under (mirrors mycelium's MIDI_SCOPE_META). */
export const MIDI_SCOPES = new Set(['track', 'orbiter', 'world', 'collection']);

/**
 * @param {string|null|undefined} scope
 * @param {string|null|undefined} entityId
 * @returns {string|null} `<scope>:<entityId>`, or null when either part is missing/unknown.
 */
export function makeScopeKey(scope, entityId) {
  if (!scope || !entityId || !MIDI_SCOPES.has(scope)) {
    return null;
  }
  return `${scope}:${entityId}`;
}

/** @param {string|null|undefined} orbiterId @returns {string|null} */
export function orbiterScopeKey(orbiterId) {
  return makeScopeKey('orbiter', orbiterId);
}

/**
 * @param {string|null|undefined} key
 * @returns {{ scope: string, entityId: string }|null}
 */
export function parseScopeKey(key) {
  if (typeof key !== 'string') {
    return null;
  }
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) {
    return null;
  }
  const scope = key.slice(0, separator);
  if (!MIDI_SCOPES.has(scope)) {
    return null;
  }
  return { scope, entityId: key.slice(separator + 1) };
}
