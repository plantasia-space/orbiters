/**
 * @file src/input/midi/autofocusSettings.js
 * @description MIDI autofocus toggle persistence. Per-device localStorage, default ON.
 *
 * The flag is read on the hot MIDI path (`_applyLayeredMidiValue` runs on every CC/note write),
 * so the value is cached in-memory at module load and the getter never touches localStorage.
 * The toggle button calls `setAutofocusEnabled()`, which updates the cache and persists.
 */

const STORAGE_KEY = 'orbiters:midi-autofocus';

function readStored() {
  if (typeof window === 'undefined' || !window.localStorage) return true; // default ON
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

let enabled = readStored();

/** Whether MIDI autofocus is enabled. O(1), reads the in-memory cache (no storage hit). */
export function isAutofocusEnabled() {
  return enabled;
}

/** Enable/disable MIDI autofocus; updates the cache and persists to localStorage. */
export function setAutofocusEnabled(value) {
  enabled = Boolean(value);
  if (typeof window === 'undefined' || !window.localStorage) return enabled;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // noop — persistence is best-effort
  }
  return enabled;
}
