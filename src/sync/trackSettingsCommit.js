/**
 * @file src/sync/trackSettingsCommit.js
 * @description The ONE commit seam for a user's per-track sync-setting edits (tempo, grid marker,
 * meter): apply to the owning voice's in-memory model, then persist voice-scoped. Every UI surface
 * (React controls, the header BPM bridge) converges here — there is deliberately no second path that
 * both applies and persists one of these values.
 */
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { syncCoordinator } from './SyncCoordinator.js';
import { deckFor } from '../voice/Deck.js';
import { normalizeMeterId } from './meter.js';
import { queueTrackSyncSettingsSave } from './trackUserSettingsPersistence.js';

/** The edited voice's engine — a SPECIFIC voice when scoped (a collection tile), else the active
 *  (focused) voice for the single-orbiter case. Exported: the one UI→engine resolution seam. */
export function resolveEngine(voiceId = null) {
  return voiceId != null
    ? (voiceRegistry.get(voiceId)?.audioEngine ?? null)
    : (voiceRegistry.getActive()?.audioEngine ?? null);
}

/** Persist a track's sync settings (tempo + grid marker) via the existing per-user PUT
 *  (`me/users/configurations/track-settings`). This only writes the per-user LAYER; the backend
 *  decides whether the user is the owner (→ promotes to the track's canonical `effectiveSettings`)
 *  or not (→ a personal override). The load-side priority in the shared `clock/track-metadata` resolver then resolves
 *  canonical > per-user > auto-detected — so "only the owner edits permanently" is a backend +
 *  load-priority property, NOT a frontend save gate. Reads the unchanged field from the live model.
 *  @param {string|null} [voiceId] target THIS voice's own track (a specific collection tile) instead
 *   of "whichever voice is active" — needed so editing a non-focused tile persists to ITS track. */
export function saveActiveTrackSyncSettings({ trackBpm = null, gridMarkerTimeSec = null, meter = null } = {}, voiceId = null) {
  const orbiter = resolveEngine(voiceId);
  const track = orbiter?.trackData?.track;
  if (!track?.trackId) return Promise.resolve(null);
  // When scoped to a SPECIFIC voice (voiceId given), an omitted trackBpm falls back to THAT voice's
  // own native tempo — and NEVER to the shared singleton, which holds whichever track last wrote it.
  // The singleton fallback here is how another track's tempo got PERSISTED into this track's saved
  // settings (a meter-only commit on a track with no tempo metadata silently saved a sibling's BPM,
  // poisoning the stored value so the leak survived every in-memory fix). Own unknown → omit.
  const ownTrackBpm = voiceId != null ? orbiter?.getOwnTrackBpm?.() : null;
  return queueTrackSyncSettingsSave({
    trackId: track.trackId,
    trackBpm: trackBpm
      ?? (voiceId != null
        ? ownTrackBpm
        : (syncCoordinator.trackBpm ?? syncCoordinator.detectedTrackBpm))
      ?? null,
    gridMarkerTimeSec:
      gridMarkerTimeSec ??
      orbiter?.getGridMarkerTimeSec?.() ??
      orbiter?.getWrapGridStartTimeSec?.() ??
      0,
    // Persist the per-track meter only when the caller passes it (a meter commit). Tempo/grid
    // saves leave it undefined → not written, mirroring trackBpm's omit-when-absent (see payload builder).
    meter,
  }).catch((error) => {
    console.warn('[TrackSettings] Failed to save track sync settings.', error);
    return null;
  });
}

/** Commit a user BPM edit from the React control: update the track tempo AND persist.
 *  @param {number} bpm
 *  @param {string|null} [voiceId] the editing voice (a collection tile); omit for single-orbiter.
 *
 *  A track-BPM edit IS the editing voice's new NATIVE tempo (its grid reference — the persisted
 *  value), written on that voice's own deck; a deck's follow ratio is always transport / OWN native,
 *  so the shared fan can never retune a sibling's native. The shared singleton is refreshed only by
 *  a SYNCED tile (or single-orbiter) — it serves persist fallback + solo readers; an unsynced
 *  tile's edit stays local to its own deck. */
export function commitTrackBpmFromUi(bpm, voiceId = null) {
  const value = Number(bpm);
  if (!Number.isFinite(value) || value <= 0) return;
  const orbiter = resolveEngine(voiceId);
  orbiter?.setOwnTrackBpm?.(value);
  if (voiceId == null || deckFor(voiceId)?.syncEnabled === true) {
    syncCoordinator.setTrackBpm(value, { source: 'ui' });
  }
  saveActiveTrackSyncSettings({ trackBpm: value }, voiceId);
}

/** Commit a user grid-marker pick from the React control (marker already set on the view): persist
 *  to the EDITING voice's own track — not "whichever voice is focused", the same cross-voice
 *  persistence class fixed for tempo and meter.
 *  @param {number|null} [gridMarkerTimeSec]
 *  @param {string|null} [voiceId] the editing voice (a collection tile); omit for single-orbiter. */
export function commitGridMarkerFromUi(gridMarkerTimeSec = null, voiceId = null) {
  saveActiveTrackSyncSettings({ gridMarkerTimeSec }, voiceId);
}

/** Apply a meter (time signature) value for a SPECIFIC voice (a collection tile), in-memory only —
 *  shared by the live (drag) and commit paths below. Meter is ALWAYS per-voice (a property of the
 *  track, never shared — even between two synced voices), so the edit goes straight to that voice's own
 *  deck (`Deck.setMeter`); there is no shared-meter write path to leak through.
 *  @param {string} meter
 *  @param {string|null} [voiceId] the editing voice; omit for the single-orbiter/no-collection case.
 *  @returns {string} the normalized meter id that was applied. */
function applyTrackMeterFromUi(meter, voiceId = null) {
  const normalized = normalizeMeterId(meter);
  // Scoped to a SPECIFIC voice (voiceId given): target ONLY that voice's deck — never fall back to
  // whichever voice is active, so the live apply targets the same track the persist step does (see
  // saveActiveTrackSyncSettings). Single-orbiter (voiceId null) uses the active voice's deck.
  (voiceId != null ? voiceRegistry.get(voiceId)?.deck : voiceRegistry.getActive()?.deck)?.setMeter(normalized);
  return normalized;
}

/** Live (drag-in-progress) meter update for a specific voice: apply only, no persistence.
 *  @param {string} meter
 *  @param {string|null} [voiceId] */
export function setTrackMeterLiveFromUi(meter, voiceId = null) {
  applyTrackMeterFromUi(meter, voiceId);
}

/** Commit a user meter pick from the React control for a specific voice: apply AND persist
 *  per-track, the same way tempo is saved/loaded.
 *  @param {string} meter
 *  @param {string|null} [voiceId] */
export function commitTrackMeterFromUi(meter, voiceId = null) {
  const normalized = applyTrackMeterFromUi(meter, voiceId);
  saveActiveTrackSyncSettings({ meter: normalized }, voiceId);
}
