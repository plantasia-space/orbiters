/**
 * @file src/config/metronome.js
 * @description The metronome ON/OFF preference — PER-PLAYER (per voice), per-SESSION (NOT per-track;
 * the meter is the per-track part). Each player in a collection owns its own independent flag, so one,
 * the other, or both metronomes can run at the same time. Deliberately NOT persisted anywhere (no
 * localStorage, no URL param): the metronome is something you flip on/off within a session, always
 * starting OFF on a fresh load. A plain in-memory map with a setter that dispatches a change event,
 * so the per-voice click streams and the React toggles stay in step.
 *
 * Single-orbiter (no collection) has no voiceId and uses the `null` slot — one flag, byte-identical
 * to the old device-wide behavior.
 */

/** Event dispatched on `window` when a metronome toggle changes. Detail: `{ enabled, voiceId }`. */
export const METRONOME_CHANGED_EVENT = 'orbiters:metronome-changed';

/** voiceId (or '' for the single-orbiter/null slot) → enabled. Session-only, default off. */
const flags = new Map();

const slot = (voiceId) => voiceId ?? '';

/** Whether the metronome is enabled for this player (this session only).
 *  @param {string|null} [voiceId] the player's voice; omit for single-orbiter. */
export function isMetronomeEnabled(voiceId = null) {
  return flags.get(slot(voiceId)) === true;
}

/**
 * Enable/disable the metronome for ONE player this session. Notifies listeners via
 * `METRONOME_CHANGED_EVENT` (detail carries the voiceId so only that player's stream reacts).
 * @param {boolean} on
 * @param {string|null} [voiceId] the player's voice; omit for single-orbiter.
 * @returns {boolean} the stored value
 */
export function setMetronomeEnabled(on, voiceId = null) {
  const enabled = !!on;
  flags.set(slot(voiceId), enabled);
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(METRONOME_CHANGED_EVENT, { detail: { enabled, voiceId } }));
    }
  } catch {
    // ignore
  }
  return enabled;
}

/** Test-only: reset every flag to the default (off) state. */
export function __resetMetronomeCacheForTests() {
  flags.clear();
}
