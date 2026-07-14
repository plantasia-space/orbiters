import { MONITOR_MODULE_SLOTS } from '../config/Constants.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { byId } from '../voice/voiceDom.js';

/**
 * Utilities for managing the Engine Monitor display
 */

// The Engine Monitor's "is it visible" + "last active dimension" flags live on the
// ACTIVE VOICE (`voiceRegistry.getActive()`), not on module-level `let`s that all voices would share.
// Single-orbiter = one always-active voice, so this is byte-identical. With no active voice (SSR/tests)
// we fall back to the prior defaults: visible defaults true, last-active-dimension defaults null.
const MONITOR_AXES = ['x', 'y', 'z'];
const MONITOR_SLOT_OFFSETS = Object.freeze([
  { label: 0, value: 1 }, // Slot A
  { label: 2, value: 3 }, // Slot B
]);
const MONITOR_AXIS_STRIDE = MONITOR_SLOT_OFFSETS.length * 2; // 4 placeholders per axis
const ACTIVE_MONITOR_SLOT_COUNT = MONITOR_MODULE_SLOTS.count;
const ACTIVE_MONITOR_LETTERS = MONITOR_MODULE_SLOTS.letters;

function getPlaceholderIds(axisIndex, slotIndex) {
  const offsets = MONITOR_SLOT_OFFSETS[slotIndex];
  if (!offsets) return null;
  const basePlaceholder = (axisIndex * MONITOR_AXIS_STRIDE) + 1;
  return {
    labelId: `placeholder_${basePlaceholder + offsets.label}`,
    valueId: `placeholder_${basePlaceholder + offsets.value}`,
  };
}

function hidePlaceholderTargets(labelId, valueId) {
  if (typeof document === 'undefined') return;
  const label = byId(labelId);
  const value = byId(valueId);
  if (label) {
    label.textContent = '';
    label.style.display = 'none';
  }
  if (value) {
    value.textContent = '';
    value.style.display = 'none';
  }
}

/**
 * Set whether the Engine Monitor is visible.
 * Call this when switching between display modes (Track Info, World Info, Engine Monitor, etc.)
 * @param {boolean} visible - True if Engine Monitor is visible, false otherwise
 */
export function setMonitorVisible(visible) {
  const voice = voiceRegistry.getActive();
  if (voice) voice.monitorVisible = Boolean(visible);
}

/**
 * Check if the Engine Monitor is currently visible.
 * @returns {boolean} True if Engine Monitor is visible
 */
export function isMonitorCurrentlyVisible() {
  // Default visible (the app boots with the Engine Monitor shown); also the no-active-voice fallback.
  return voiceRegistry.getActive()?.monitorVisible !== false;
}

/**
 * Resolve currently active dimensionId from the running engine or mode controller.
 * @returns {string|null}
 */
export function getActiveDimensionId() {
  try {
    const voice = voiceRegistry.getActive();
    // Preferred: ask the active voice's audio engine
    const engine = voice?.audioEngine;
    if (engine && typeof engine.getActiveDimensionId === 'function') {
      const id = engine.getActiveDimensionId();
      if (typeof id === 'string' && id.length) return id;
    }
    // Fallback: the active voice's world mode controller (if it exposes a getter)
    const wm = voice?.worldMode;
    if (wm && typeof wm.getActiveDimensionId === 'function') {
      const id = wm.getActiveDimensionId();
      if (typeof id === 'string' && id.length) return id;
    }
  } catch (_) {}
  return null;
}

/**
 * Check if a given dimension is the active (visible) one for the Engine Monitor.
 * Also clears the monitor display once if the active dimension changed.
 * @param {string} dimensionId
 * @returns {boolean}
 */
export function isMonitorDimensionActive(dimensionId) {
  const active = getActiveDimensionId();
  const voice = voiceRegistry.getActive();
  const lastActiveDimensionId = voice ? (voice.lastActiveDimensionId ?? null) : null;

  // Clear once when active dimension changes and monitor is visible
  if (active !== lastActiveDimensionId) {
    if (voice) voice.lastActiveDimensionId = active;
    try {
      if (isMonitorCurrentlyVisible()) {
        clearMonitorDisplay();
      }
    } catch (_) {}
  }

  if (!dimensionId) return false;
  return active ? String(active) === String(dimensionId) : false;
}

/**
 * Clears all monitor placeholders, resetting them to default values.
 * Call this when switching dimensions to prevent old dimension data from persisting.
 * Only clears if the Engine Monitor is currently visible.
 * 
 * Placeholder layout (2-column grid: label | value):
 * X-axis: label_A=1, value_A=2, label_B=3, value_B=4
 * Y-axis: label_A=5, value_A=6, label_B=7, value_B=8
 * Z-axis: label_A=9, value_A=10, label_B=11, value_B=12
 */
export function clearMonitorDisplay() {
  // Only clear if monitor is visible
  if (!isMonitorCurrentlyVisible()) return;
  
  if (typeof document === 'undefined') return;
  
  MONITOR_AXES.forEach((axis, axisIndex) => {
    MONITOR_SLOT_OFFSETS.forEach((_, slotIndex) => {
      const ids = getPlaceholderIds(axisIndex, slotIndex);
      if (!ids) return;
      if (slotIndex >= ACTIVE_MONITOR_SLOT_COUNT) {
        hidePlaceholderTargets(ids.labelId, ids.valueId);
        return;
      }

      const moduleLetter = ACTIVE_MONITOR_LETTERS[slotIndex] || String.fromCharCode(65 + slotIndex);
      const label = byId(ids.labelId);
      const value = byId(ids.valueId);

      if (label) {
        label.textContent = `[${axis}${moduleLetter}]`;
        label.style.display = '';
      }
      if (value) {
        value.textContent = '0';
        value.style.display = '';
      }
    });
  });
}
