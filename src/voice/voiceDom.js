/**
 * @file src/voice/voiceDom.js
 * @description Resolve voice-scoped DOM within the active voice's root subtree.
 *
 * Single-orbiter registers its voice with `rootEl = document`, so `byId('waveform')` is exactly
 * `document.getElementById('waveform')` — byte-identical to today. Multi-orbiter (A3) gives each voice
 * its own root element, so the same fixed ids (`placeholder_N`, `waveform`, `loop-*`, `canvas3D`)
 * stay stable WITHIN a subtree and uniqueness comes from the root, not from renaming the ids.
 */
import { voiceRegistry } from './VoiceRegistry.js';

/** The active voice's DOM root, or `document` when no voice/root is set (single-orbiter default). */
export function activeRoot() {
  const root = voiceRegistry.getActive()?.rootEl;
  if (root) return root;
  return typeof document !== 'undefined' ? document : null;
}

/**
 * `getElementById` scoped to a voice root. When the root is the `document` (single-orbiter) it calls
 * `getElementById` directly; when it is an element subtree (multi-orbiter) it falls back to a scoped
 * `querySelector('#id')` so the lookup stays inside that voice's subtree.
 * @param {string} id
 * @param {Document|Element|null} [root] defaults to the active voice's root.
 * @returns {Element|null}
 */
export function byId(id, root = activeRoot()) {
  if (!root || !id) return null;
  if (typeof root.getElementById === 'function') return root.getElementById(id);
  return root.querySelector(`#${CSS.escape(id)}`);
}

/**
 * `querySelectorAll` scoped to a voice root (an Array, not a live NodeList). Defaults to the active
 * voice's root; `document` for single-orbiter.
 * @param {string} selector
 * @param {Document|Element|null} [root]
 * @returns {Element[]}
 */
export function queryAllWithin(selector, root = activeRoot()) {
  if (!root || !selector) return [];
  return Array.from(root.querySelectorAll(selector));
}
