import { syncCoordinator } from './SyncCoordinator.js';

const SYNC_CONTROL_EVENT = 'orbiters:sync-control';

let externalSyncControlInitialized = false;
let activeParameterManager = null;
let activeAudioEngine = null;

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(normalized)) return false;
  return null;
}

function parsePositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeMode(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'TEMPO_ONLY' || normalized === 'PHASE_LOCK') {
    return normalized;
  }
  return null;
}

function normalizeSyncControl(input = {}) {
  if (!input || typeof input !== 'object') return null;

  const enabled = parseBoolean(
    input.enabled ??
      input.syncEnabled ??
      input.sync ??
      input.sessionSync,
  );

  const bpm = parsePositiveNumber(
    input.bpm ??
      input.tempo ??
      input.sessionBpm ??
      input.syncBpm,
  );

  const trackBpm = parsePositiveNumber(
    input.trackBpm ??
      input.audioBpm ??
      input.audioTempo,
  );

  const gridStartTimeSec = (() => {
    const numeric = Number(
      input.gridMarkerTimeSec ??
      input.gridStartTimeSec ??
      input.wrapGridStartTimeSec ??
      input.beat1StartSec,
    );
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  })();

  const mode = normalizeMode(input.mode ?? input.syncMode);

  const patch = {};
  if (enabled !== null) patch.enabled = enabled;
  if (bpm !== null) patch.bpm = bpm;
  if (trackBpm !== null) patch.trackBpm = trackBpm;
  if (gridStartTimeSec !== null) patch.gridStartTimeSec = gridStartTimeSec;
  if (mode) patch.mode = mode;

  return Object.keys(patch).length ? patch : null;
}

function readSyncControlFromUrl() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search || '');
  return normalizeSyncControl({
    enabled:
      params.get('syncEnabled') ??
      params.get('sync') ??
      params.get('sessionSync'),
    bpm:
      params.get('syncBpm') ??
      params.get('sessionBpm') ??
      params.get('tempo'),
    trackBpm:
      params.get('trackBpm') ??
      params.get('audioBpm') ??
      params.get('audioTempo'),
    gridStartTimeSec:
      params.get('gridMarkerTimeSec') ??
      params.get('gridStartTimeSec') ??
      params.get('wrapGridStartTimeSec') ??
      params.get('beat1StartSec'),
    mode: params.get('syncMode'),
  });
}

function applyTrackBpm(trackBpm) {
  syncCoordinator.setTrackBpm(trackBpm, { source: 'external-control' });
  try {
    activeParameterManager?.setRawValue?.('sync-track-bpm', trackBpm);
  } catch (_) {}
}

export function applyExternalSyncControl(control, { source = 'external' } = {}) {
  const patch = normalizeSyncControl(control);
  if (!patch) return false;

  if (patch.mode) {
    syncCoordinator.setMode(patch.mode);
  }
  if (patch.trackBpm != null) {
    applyTrackBpm(patch.trackBpm);
  }
  if (patch.gridStartTimeSec != null) {
    activeAudioEngine?.setGridMarkerTimeSec?.(patch.gridStartTimeSec)
      ?? activeAudioEngine?.setWrapGridStartTimeSec?.(patch.gridStartTimeSec);
  }
  if (patch.bpm != null) {
    // System-level write (host/URL control, not a specific voice): no `byVoiceId`, so
    // syncCoordinator.setTempo's per-voice gate never applies to it.
    syncCoordinator.setTempo(patch.bpm, { sourceType: source });
  }
  if (patch.enabled === true) {
    syncCoordinator.enable();
  } else if (patch.enabled === false) {
    syncCoordinator.disable();
  }

  return true;
}

export function initExternalSyncControl({ parameterManager = null, audioEngine = null } = {}) {
  activeParameterManager = parameterManager || activeParameterManager;
  activeAudioEngine = audioEngine || activeAudioEngine;

  const initial = readSyncControlFromUrl();
  if (initial) {
    applyExternalSyncControl(initial, { source: 'url' });
  }

  if (externalSyncControlInitialized || typeof window === 'undefined') {
    return;
  }

  window.addEventListener(SYNC_CONTROL_EVENT, (event) => {
    const control = event?.detail?.control ?? event?.detail ?? null;
    if (!control) return;
    applyExternalSyncControl(control, { source: event?.detail?.source || 'host' });
  });

  externalSyncControlInitialized = true;
}
