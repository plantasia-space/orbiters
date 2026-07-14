/**
 * @file src/sync/trackUserSettingsPersistence.js
 * @description Debounced persistence for private per-user sync/grid-marker settings.
 */
import { Constants } from '../config/Constants.js';
import { saveTrackUserSettings } from '../api/trackUserSettingsService.js';
import { isValidMeterId } from './meter.js';

const SAVE_DELAY_MS = 280;

// One debounce queue PER trackId, so a fast track switch (edit A's BPM → switch to B →
// edit B within the debounce window) can't clobber A's pending save, and each track dedups against
// its own last save. Single-orbiter (one track at a time) behaves exactly as the prior single queue.
const queues = new Map(); // trackId -> { timer, payload, resolvers, inFlightSave, lastSavedFingerprint }

function getQueue(trackId) {
  let queue = queues.get(trackId);
  if (!queue) {
    queue = {
      timer: null,
      payload: null,
      resolvers: [],
      inFlightSave: Promise.resolve(),
      lastSavedFingerprint: null,
    };
    queues.set(trackId, queue);
  }
  return queue;
}

function toPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function toNonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function buildGridMarkerRecord(sourceTimeSec) {
  const normalizedSourceTimeSec = toNonNegativeNumber(sourceTimeSec);
  if (normalizedSourceTimeSec === null) {
    return null;
  }

  return {
    id: 'primary',
    beat: 1,
    kind: 'downbeat',
    label: 'Grid marker',
    sourceTimeSec: normalizedSourceTimeSec,
  };
}

function buildSyncPayload({ trackBpm = null, gridMarkerTimeSec = null, meter = null } = {}) {
  const normalizedTrackBpm = toPositiveNumber(trackBpm);
  const gridMarker = buildGridMarkerRecord(gridMarkerTimeSec);
  const sync = {};

  if (normalizedTrackBpm !== null) {
    sync.trackBpm = normalizedTrackBpm;
  }
  if (gridMarker) {
    sync.gridMarkers = [gridMarker];
  }
  // The per-track meter (time signature), saved alongside tempo. Only written when a valid
  // meter id is supplied — mirrors trackBpm's "omit when absent" so a partial save never clobbers it.
  if (isValidMeterId(meter)) {
    sync.meter = meter;
  }

  return Object.keys(sync).length ? { sync } : null;
}

function getCurrentTrackId(trackId = null) {
  // The caller passes the active voice's trackId explicitly (no Constants.TRACK_ID global).
  if (typeof trackId === 'string' && trackId.trim().length) {
    return trackId.trim();
  }
  return null;
}

function updateCurrentConfigCache(trackId, payload) {
  // Resolve the combined config from the keyed snapshot cache by trackId (no single-current pointer).
  const currentConfig = Constants?.getConfigByTrackId?.(trackId);
  if (!currentConfig || currentConfig?.track?.trackId !== trackId || !payload?.sync) {
    return;
  }

  const nextSync = {
    ...(currentConfig.trackUserSettings?.sync || {}),
    ...payload.sync,
  };
  if (Array.isArray(payload.sync.gridMarkers) && payload.sync.gridMarkers.length) {
    nextSync.gridMarkers = payload.sync.gridMarkers.slice();
  }

  currentConfig.trackUserSettings = {
    ...(currentConfig.trackUserSettings || {}),
    trackId,
    sync: nextSync,
  };
}

async function flushPendingSave(trackId) {
  const queue = queues.get(trackId);
  if (!queue) return null;

  const payload = queue.payload;
  const resolvers = queue.resolvers.slice();
  queue.payload = null;
  queue.resolvers = [];

  if (!payload) {
    resolvers.forEach(({ resolve }) => resolve(null));
    return null;
  }

  const fingerprint = JSON.stringify({ trackId, payload });
  if (fingerprint === queue.lastSavedFingerprint) {
    resolvers.forEach(({ resolve }) => resolve(null));
    return null;
  }

  try {
    const saved = await saveTrackUserSettings(trackId, payload, { promptOnAuthError: true });
    queue.lastSavedFingerprint = fingerprint;
    updateCurrentConfigCache(trackId, payload);
    resolvers.forEach(({ resolve }) => resolve(saved));
    return saved;
  } catch (error) {
    resolvers.forEach(({ reject }) => reject(error));
    throw error;
  }
}

/**
 * Queues a save for the current track's sync/grid-marker settings.
 *
 * The payload is intentionally limited to the current sync subset so this
 * path can ship now without coupling to MIDI migration.
 *
 * @param {{
 *   trackId?: string | null,
 *   trackBpm?: number | null,
 *   gridMarkerTimeSec?: number | null,
 *   immediate?: boolean
 * }} [options]
 * @returns {Promise<object|null>}
 */
export function queueTrackSyncSettingsSave({
  trackId = null,
  trackBpm = null,
  gridMarkerTimeSec = null,
  meter = null,
  immediate = false,
} = {}) {
  const resolvedTrackId = getCurrentTrackId(trackId);
  const payload = buildSyncPayload({ trackBpm, gridMarkerTimeSec, meter });

  if (!resolvedTrackId || !payload) {
    return Promise.resolve(null);
  }

  const queue = getQueue(resolvedTrackId);
  queue.payload = payload;

  if (queue.timer) {
    clearTimeout(queue.timer);
    queue.timer = null;
  }

  const runSave = () => {
    queue.inFlightSave = queue.inFlightSave
      .catch(() => null)
      .then(() => flushPendingSave(resolvedTrackId));
    return queue.inFlightSave;
  };

  if (immediate) {
    return runSave();
  }

  return new Promise((resolve, reject) => {
    queue.resolvers.push({ resolve, reject });
    queue.timer = globalThis.setTimeout(() => {
      queue.timer = null;
      runSave().catch(() => null);
    }, SAVE_DELAY_MS);
  });
}
