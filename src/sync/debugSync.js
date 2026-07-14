/**
 * @file src/sync/debugSync.js
 * @description Dev-only debug seam for the quantize/tempo audio path (decision 005: no window
 * globals as seams). Replaces `window.__orbitersDebugSync` (verbose quantize/tempo console logging)
 * and `window.__orbitersQuantizeStart` (force the legacy quantize-start path without needing ≥2
 * synced voices in the room). A plain module, not a window property — reachable from devtools via
 * `import('/src/sync/debugSync.js').then(m => m.setDebugSyncLogging(true))`. Nothing in production
 * ever calls the setters.
 */
let loggingEnabled = false;
let quantizeStartForced = false;

export function isDebugSyncLoggingEnabled() {
  return loggingEnabled;
}

export function setDebugSyncLogging(on) {
  loggingEnabled = on === true;
}

export function isQuantizeStartForced() {
  return quantizeStartForced;
}

export function setQuantizeStartForced(on) {
  quantizeStartForced = on === true;
}
