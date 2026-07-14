/**
 * @file src/api/queueDataService.js
 * @description Queue mode data source: the signed-in user's playable queue
 * (`GET /me/users/queue`, written by plantasia.space-root on handoff). Returns a
 * `collectionData`-shaped object so `createCollectionApp` can compose the same
 * multi-stage layout from a track list — a queue is NOT a collection (no entity,
 * no title, no permissions path), so nothing here touches the collection loader.
 */
import { fetchJsonFromApi } from './httpClient.js';
import { getEmbeddedAuthToken, requestEmbeddedAuthToken } from './dataManager/loaders.js';
import { ensureFirebaseAuthFromSession } from '../auth/sessionAuth.js';
import { normalizeRosterEntry } from './collectionDataService.js';

// The realm boots stages lazily, but keep the roster bounded like the URL roster is.
const MAX_QUEUE_STAGES = 50;

// Standalone-capable auth (settingsApi pattern): embedded host token first, else the
// Firebase session handshake. collectionDataService's embedded-only resolver would
// leave `queue=me` unauthenticated on orbiter.plantasia.space.
async function resolveAuthToken() {
  const embeddedToken = getEmbeddedAuthToken();
  if (embeddedToken) return embeddedToken;

  requestEmbeddedAuthToken();

  const user = await ensureFirebaseAuthFromSession();
  if (user && typeof user.getIdToken === 'function') {
    return await user.getIdToken();
  }
  return null;
}

/**
 * Build the collectionData-shaped object createCollectionApp expects. Accepts bare
 * track-id strings or { trackId, title?, artist?, imageUrl? } display snapshots
 * (the backend queue carries snapshots so cards render named).
 */
export function buildQueueData(trackEntries, { startTrackId = null } = {}) {
  const seen = new Set();
  const ordered = [];
  for (const raw of trackEntries) {
    const entry = typeof raw === 'string' ? { trackId: raw } : raw;
    const trackId = entry && typeof entry.trackId === 'string' ? entry.trackId : null;
    if (!trackId || seen.has(trackId)) continue;
    seen.add(trackId);
    ordered.push({ trackId, title: entry.title || null, artist: entry.artist || null, imageUrl: entry.imageUrl || null });
  }
  // The starting track leads the roster so the first booted stage is what the user
  // was hearing when they handed off.
  if (startTrackId && seen.has(startTrackId)) {
    const i = ordered.findIndex((e) => e.trackId === startTrackId);
    ordered.unshift(ordered.splice(i, 1)[0]);
  }
  const roster = ordered.slice(0, MAX_QUEUE_STAGES).map((entry, index) => ({
    voiceId: `queue-${index}-${entry.trackId}`,
    trackId: entry.trackId,
    orbiterId: null,
    entangledWorldId: null,
    entityType: 'track',
    title: entry.title,
    subtitle: entry.artist,
    image: entry.imageUrl,
    isOfficial: false,
    hydrated: null,
  }));
  return {
    collectionId: null, // no collection: disables layout persistence, as intended
    roster,
    permissions: { canView: true, canEdit: false },
    // One visible stage by default — you listen one at a time; the count switcher
    // still lets the user open more.
    layout: { subtype: 1, focusedIndex: 0 },
    ownerAvatar: null,
    ownerName: null,
    // Tracks play once and auto-advance (loop off) — queue semantics, not orbiter looping.
    sequential: true,
  };
}

// The context + current track from the last fetch, so a reorder write-back keeps them.
let lastFetchedContext = null;
let lastFetchedCurrentTrackId = null;
let persistTimer = null;

/**
 * Write the queue's new order back (studio drawer reorder in queue mode). Debounced;
 * replaces the stored list wholesale — the flat studio order IS the queue now (up-next
 * was already merged into it at handoff). Fire-and-forget; failures only log.
 */
export function persistQueueOrder(trackIds) {
  if (!Array.isArray(trackIds) || trackIds.length === 0) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const authToken = await resolveAuthToken();
      if (!authToken) return;
      await fetchJsonFromApi('/me/users/queue', {
        method: 'PUT',
        authToken,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: lastFetchedContext,
          trackIds,
          currentTrackId: trackIds.includes(lastFetchedCurrentTrackId)
            ? lastFetchedCurrentTrackId
            : trackIds[0],
          upNextTrackIds: [],
        }),
      });
    } catch (error) {
      console.warn('[queue] failed to persist order', error);
    }
  }, 1500);
}

/**
 * Fetches the user's queue and shapes it for the multi-stage layout.
 * Order: current track first, then up-next, then the rest of the sequence.
 * Throws { code: 'unauthorized' | 'empty' } for the boot branch to message on.
 */
export async function fetchQueueData({ startTrackId = null, signal } = {}) {
  const authToken = await resolveAuthToken();
  const response = await fetchJsonFromApi('/me/users/queue?hydrate=1', {
    method: 'GET',
    signal,
    authToken,
    credentials: 'include',
  });
  if (!response || response.status === 401) {
    const error = new Error('queue requires a signed-in session');
    error.code = 'unauthorized';
    throw error;
  }
  if (!response.ok) throw new Error(`queue fetch failed: ${response.status}`);

  const payload = await response.json();
  const queue = payload && typeof payload.queue === 'object' ? payload.queue : {};
  lastFetchedContext = queue.context ?? null;
  lastFetchedCurrentTrackId = typeof queue.currentTrackId === 'string' ? queue.currentTrackId : null;
  const trackIds = Array.isArray(queue.trackIds) ? queue.trackIds : [];
  const upNext = Array.isArray(queue.upNextTrackIds) ? queue.upNextTrackIds : [];
  const current = typeof queue.currentTrackId === 'string' ? queue.currentTrackId : null;
  // ?hydrate=1 items are collection-item envelopes — parsed by the SAME
  // normalizer collection mode uses, keyed by entityId for ordering below.
  const hydratedById = new Map(
    (Array.isArray(queue.items) ? queue.items : [])
      .map((item) => [item?.entityId, normalizeRosterEntry(item)])
      .filter(([id, entry]) => id && entry)
  );

  // Current + up-next lead; the remaining sequence follows in stored order.
  const start = startTrackId || current;
  const orderedIds = [...(start ? [start] : []), ...upNext, ...trackIds];
  const orderedEntries = orderedIds.map((id) => {
    const hydrated = hydratedById.get(id);
    return hydrated
      ? { trackId: id, title: hydrated.title, artist: hydrated.subtitle, imageUrl: hydrated.image }
      : { trackId: id };
  });
  const data = buildQueueData(orderedEntries, { startTrackId: start });
  // Write-back is ONLY for the real `?queue=me` session — an ad-hoc `?tracks=` list
  // must never overwrite the user's stored queue.
  data.persistQueueOrder = persistQueueOrder;
  if (data.roster.length === 0) {
    const error = new Error('queue is empty');
    error.code = 'empty';
    throw error;
  }
  return data;
}
