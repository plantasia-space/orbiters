/**
 * @file visual/visualFeedbackSettings.js
 * @description Whether a module answers in the world at all — one switch per
 *              module, where a module is a (dimension, axis) pair.
 *
 *              This is a VISUAL choice and it lives nowhere near the audio
 *              settings: the rack diffs a module's settings and rebuilds its
 *              effect node when they change, so a flag stored there would tear
 *              the sound down and back up every time the switch moved. It gets
 *              its own channel instead — persisted under the session's own
 *              `visualFeedback` key, read only by the visual bridge, never seen
 *              by the audio graph.
 *
 *              Per voice, because in a multi-orbiter scene each voice loads its
 *              own orbiter and makes its own choice.
 *
 *              The persisted shape is `{ [dimensionId]: { x|y|z: { enabled } } }`
 *              — an OBJECT per axis, not a bare boolean, so the strength of the
 *              answer can join it later (`{ enabled, amount }`) without a
 *              migration. Absent voice, dimension, or axis all read as enabled,
 *              so every orbiter saved before this existed keeps its visuals.
 */

const AXES = ['x', 'y', 'z'];

/** voiceId → descriptor. Only what was actually chosen is stored (absent = on). */
const byVoice = new Map();
const listeners = new Set();

function notify(voiceId) {
  listeners.forEach((listener) => {
    try {
      listener(voiceId);
    } catch {
      // A view that throws on notify must not stop the others (or the bridge).
    }
  });
}

/** Normalize an axis entry, keeping any key we don't own yet (a future amount). */
function normalizeAxisEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return { ...entry, enabled: entry.enabled !== false };
}

function cloneDescriptor(descriptor) {
  const clone = {};
  Object.entries(descriptor).forEach(([dimensionId, axes]) => {
    clone[dimensionId] = {};
    Object.entries(axes).forEach(([axis, entry]) => {
      clone[dimensionId][axis] = { ...entry };
    });
  });
  return clone;
}

/**
 * Does this module answer in the world?
 *
 * @param {string|null} voiceId
 * @param {string|null} dimensionId
 * @param {string|null} axis
 * @returns {boolean}
 */
export function isVisualFeedbackEnabled(voiceId, dimensionId, axis) {
  if (!voiceId || !dimensionId || !axis) return true;
  return byVoice.get(voiceId)?.[dimensionId]?.[axis]?.enabled !== false;
}

/**
 * @param {string|null} voiceId
 * @param {string|null} dimensionId
 * @param {string|null} axis
 * @param {boolean} enabled
 */
export function setVisualFeedbackEnabled(voiceId, dimensionId, axis, enabled) {
  if (!voiceId || !dimensionId || !AXES.includes(axis)) return;
  const next = enabled !== false;
  if (isVisualFeedbackEnabled(voiceId, dimensionId, axis) === next) return;
  const descriptor = byVoice.get(voiceId) ?? {};
  const axes = descriptor[dimensionId] ?? {};
  // Spread the existing entry: whatever else the module carries (an amount, one
  // day) is not this switch's to drop.
  descriptor[dimensionId] = { ...axes, [axis]: { ...(axes[axis] ?? {}), enabled: next } };
  byVoice.set(voiceId, descriptor);
  notify(voiceId);
}

/**
 * Take the voice's choices from a loaded orbiter session. Runs before the visual
 * bridges mount, so a module switched off builds nothing in the first place.
 *
 * @param {string|null} voiceId
 * @param {object|null|undefined} descriptor - The session's `visualFeedback` key.
 */
export function hydrateVisualFeedback(voiceId, descriptor) {
  if (!voiceId) return;
  const next = {};
  if (descriptor && typeof descriptor === 'object') {
    Object.entries(descriptor).forEach(([dimensionId, axes]) => {
      if (!axes || typeof axes !== 'object') return;
      const cleaned = {};
      AXES.forEach((axis) => {
        const entry = normalizeAxisEntry(axes[axis]);
        if (entry) cleaned[axis] = entry;
      });
      if (Object.keys(cleaned).length > 0) next[dimensionId] = cleaned;
    });
  }
  if (Object.keys(next).length > 0) {
    byVoice.set(voiceId, next);
  } else {
    byVoice.delete(voiceId);
  }
  notify(voiceId);
}

/**
 * The voice's choices, ready to ride along in the saved session. Null when the
 * voice has chosen nothing — an absent key means "everything on", so there is
 * nothing to write.
 *
 * @param {string|null} voiceId
 * @returns {object|null}
 */
export function getVisualFeedbackDescriptor(voiceId) {
  const descriptor = voiceId ? byVoice.get(voiceId) : null;
  if (!descriptor || Object.keys(descriptor).length === 0) return null;
  return cloneDescriptor(descriptor);
}

/**
 * Forget a voice's choices. Called when the voice is torn down: a store keyed by
 * voice id must not outlive the voice, or a later voice reusing the id would boot
 * with a stranger's switches.
 *
 * @param {string|null} voiceId
 */
export function clearVisualFeedback(voiceId) {
  if (!voiceId || !byVoice.has(voiceId)) return;
  byVoice.delete(voiceId);
  notify(voiceId);
}

/**
 * @param {(voiceId: string) => void} listener - Fires with the voice that changed.
 * @returns {() => void} Unsubscribe.
 */
export function subscribeVisualFeedback(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
