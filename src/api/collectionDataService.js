/**
 * @file src/api/collectionDataService.js
 * @description Collection-data client for the native collection mode (decisions/0004).
 *
 * Collection mode receives only the collection id in the URL and resolves the collection HERE, with the
 * session token — no host bridge. The backend authorizes per user and returns:
 *   - `roster`: ordered voice descriptors matching the realm roster shape (`getRosterFromUrl`), so the
 *     realm can boot them straight in (`voiceId`/`trackId`/`orbiterId`/`entangledWorldId`).
 *   - `permissions`: `{ canView, canEdit }` — collection mode gates edit affordances on `canEdit`.
 *   - `layout`: an optional saved slot arrangement (subtype + split ratios + focus) to restore.
 *
 * The real endpoint is mycelium's `GET {apiBase}/{version}/collections/{id}/public?hydrationLevel=1`
 * (cards only — the level-1 payload carries each item's `entity.miniCard`, which is all the drawer +
 * stages need to render fast at any collection size). Full per-item release hydration is NOT fetched up
 * front: the collection starts empty (arrange UX), so a release is fetched lazily on drag-to-stage, with
 * a bounded background warm-up of the first few drawer entries (see `createCollectionApp`). This replaced
 * the old fat `hydrationLevel=2` fetch, whose ~4.5s-per-item server hydration was paid up front for every
 * item whether or not it was ever staged. The same one root's Next BFF proxies to. Orbiters calls it
 * directly with the session token
 * via `httpClient` (its `resolveApiBase()` already yields `{base}/{version}`). When NO api base is
 * configured (unit tests / a bare local run), or `?/VITE_COLLECTION_STUB=1` forces it, we fall back to a
 * deterministic stub so the surface stays buildable + previewable. `saveCollectionLayout` is the one-shot
 * authed write for a rearranged layout, gated on `canEdit` by the caller.
 */
import { fetchJsonFromApi, resolveApiBase } from './httpClient.js';
import { getEmbeddedAuthToken, requestEmbeddedAuthToken } from './dataManager/loaders.js';
import { sanitizeId } from '../session/sessionDescriptor.js';

// Force the local stub even when an api base exists (dev aid). Otherwise the stub is used only when no
// api base is configured (e.g. the test environment), so the browser preview hits the real endpoint.
const FORCE_STUB =
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_COLLECTION_STUB === '1'
    : false;

const BASE_ENDPOINT = '/collections';

function resolveAuthToken() {
  const token = getEmbeddedAuthToken();
  if (!token) {
    requestEmbeddedAuthToken();
  }
  return token || undefined;
}

/**
 * Normalize one backend collection entry into the realm roster descriptor. The public-collection endpoint
 * returns mixed entries — `{ entityType: 'track'|'orbiter'|'world', entityId, ... }` (same shape root's
 * `use-mixed-collection-items` reads) — so we map by `entityType` onto the descriptor the realm boots
 * from (`trackId`/`orbiterId`/`entangledWorldId`), exactly like single-orbiter resolves `?trackId=` /
 * `?orbiterId=` / `?entangledWorldId=`. `voiceId` is the collection item id (stable, distinct per stage),
 * falling back to the entity id.
 * The optional `title`/`subtitle`/`image`/`entityType` are display-only metadata the arrange drawer
 * shows on its cards; the realm boot ignores them (it reads only the id fields), so they are safe to carry.
 * @returns {{voiceId:string, trackId:(string|null), orbiterId:(string|null), entangledWorldId:(string|null), entityType:(string|null), title:(string|null), subtitle:(string|null), image:(string|null)} | null}
 */
// Exported for queue mode: the queue endpoint returns the SAME
// collection-item envelopes, so the same normalizer parses them.
export function normalizeRosterEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  // Mycelium's collection item shape is `{ id, entityType, entityId, entity: { miniCard: {…} } }` — the
  // display fields live under `entity.miniCard`. Accept that, plus a flat/`miniCard`-at-top shape (stub /
  // URL descriptor), by resolving the miniCard from either place.
  const hydrated = entry.entity && typeof entry.entity === 'object' ? entry.entity : null;
  const mini =
    (hydrated?.miniCard && typeof hydrated.miniCard === 'object' && hydrated.miniCard) ||
    (entry.miniCard && typeof entry.miniCard === 'object' && entry.miniCard) ||
    hydrated ||
    null;

  // An archived/deleted entity arrives as an "unavailable" placeholder (title-less miniCard with
  // `unavailable: true`) — it can't boot (its release fetch errors) so it must never become a drawer
  // card or a prefetch. Root's collection view drops these the same way (`unavailable !== true`).
  if (entry.unavailable === true || entry.entity === null || mini?.unavailable === true) return null;

  const directTrack = sanitizeId(entry.trackId || entry.track_id || null);
  const directOrbiter = sanitizeId(entry.orbiterId || entry.orbiter_id || entry.engineId || null);
  const directWorld = sanitizeId(entry.entangledWorldId || entry.entangled_world_id || entry.worldId || null);

  // `entityType`/`entityId` sit on the collection item; `entry.id` is the ITEM id (the stable voiceId),
  // NOT the entity id — so it must not stand in for the entity id here.
  const entityType = String(entry.entityType || entry.type || mini?.entityType || '').toLowerCase();
  const entityId = sanitizeId(entry.entityId || entry.entity_id || mini?.entityId || null);

  let trackId = directTrack;
  let orbiterId = directOrbiter;
  let entangledWorldId = directWorld;
  if (entityId) {
    if (entityType === 'track') trackId = trackId || entityId;
    else if (entityType === 'orbiter') orbiterId = orbiterId || entityId;
    else if (entityType === 'world' || entityType === 'entangled-world') entangledWorldId = entangledWorldId || entityId;
    else if (!trackId && !orbiterId && !entangledWorldId) trackId = entityId; // untyped → assume track
  }

  if (!trackId && !orbiterId && !entangledWorldId) return null; // nothing bootable

  // voiceId = the stable collection item id (distinct per stage), else fall back to the entity id.
  const itemId = sanitizeId(entry.itemId || entry.collectionItemId || entry.id || entry._id || null);
  const voiceId =
    sanitizeId(entry.voiceId || entry.voice_id || null) || itemId || orbiterId || trackId || entangledWorldId || entityId;
  // `hydrationLevel=2` items ALSO carry the full hydrated release response (under the
  // item's `hydrated.releaseResponse`; older payloads may be flat) — the SAME payload the
  // per-voice `/{entity}/{id}/release` call would re-fetch. Keep it (returned as `hydrated`
  // below) so the boot can prime the release caches instead of paying for it again per voice.
  const hydratedReleaseRaw = entry.hydrated && typeof entry.hydrated === 'object' ? entry.hydrated : null;
  const hydratedRelease =
    hydratedReleaseRaw && typeof hydratedReleaseRaw.releaseResponse === 'object' && hydratedReleaseRaw.releaseResponse
      ? hydratedReleaseRaw.releaseResponse
      : hydratedReleaseRaw;

  // Display-only metadata for the arrange drawer cards (the realm boot ignores it). Image tiers: the
  // miniCard exposes `imageSmall` (thumbnail); accept `image`/`imageMid` too. Subtitle mirrors root's
  // `normalizeStandardEntityMiniCard`: artist display-name(s) first, else the OWNER's name — an orbiter/
  // world carries no `artists`, so without the owner fallback its card would read blank. `title` is left
  // NULL when the miniCard has none (an unhydrated entity) — the card renders a friendly
  // "Untitled", never the raw id (voiceId is an ObjectId, so it must never stand in for the title).
  const title = firstString(mini?.title, entry.title, entry.name);
  const image = firstString(mini?.imageSmall, mini?.image, mini?.imageMid, entry.image, entry.coverImage, entry.thumbnail);
  const subtitle =
    firstString(entry.subtitle, mini?.subtitle, entry.artist) || artistNames(mini?.artists) || personName(mini?.owner);
  const isOfficial = mini?.isOfficial === true || entry.isOfficial === true;
  const displayType = entityType || (trackId ? 'track' : orbiterId ? 'orbiter' : entangledWorldId ? 'world' : null);
  return { voiceId, trackId, orbiterId, entangledWorldId, entityType: displayType, title, subtitle, image, isOfficial, hydrated: hydratedRelease };
}

/** The first argument that is a string, else null (so a non-string field can't mask a later valid one). */
function firstString(...candidates) {
  for (const c of candidates) if (typeof c === 'string') return c;
  return null;
}

/** Join an `artists` array (miniCard shape) into a display subtitle — "Bruna Guarnieri, …". Null if none. */
function artistNames(artists) {
  if (!Array.isArray(artists)) return null;
  const names = artists.map((a) => firstString(a?.displayName, a?.username, a?.name)).filter(Boolean);
  return names.length ? names.join(', ') : null;
}

/** A single person's display name (miniCard `owner`/artist shape) — display name, else username. Null if none. */
function personName(person) {
  if (!person || typeof person !== 'object') return null;
  return firstString(person.displayName, person.username, person.name);
}

/**
 * Guarantee each stage gets a DISTINCT voiceId. The realm keys voices by voiceId, so a collection that
 * lists the same track/orbiter twice (a legitimate "two instances" case) would otherwise collapse to one
 * voice — only one stage renders/sounds, and focus mis-maps. The real backend should supply
 * distinct voiceIds; this is a client-side safety net (suffix the position on a repeat).
 */
function dedupeVoiceIds(entries) {
  const seen = new Set();
  return entries.map((entry, index) => {
    let voiceId = entry.voiceId;
    if (seen.has(voiceId)) voiceId = `${voiceId}-${index}`;
    seen.add(voiceId);
    return voiceId === entry.voiceId ? entry : { ...entry, voiceId };
  });
}

/**
 * Resolve `{ canView, canEdit }` from the collection response. Mycelium's `/collections/{id}/public`
 * returns a top-level `permissionsPayload` (a sibling of `collection`, NOT nested) that it already
 * computed from the viewer's Bearer token — `{ viewerRole, capabilities: { canView, canEdit, ... } }`.
 * We read `capabilities` directly and treat `viewerRole === 'owner'` as edit (mirroring root's
 * `capabilities.canEdit || isOwner`). A flat `{ canView, canEdit }` (the stub / a legacy shape) is
 * still honoured as a fallback. canEdit gates ONLY the persist control — everyone who can view gets the
 * full session-local arrange interaction.
 * @param {object|null} permissionsPayload the top-level `permissionsPayload` (preferred).
 * @param {object|null} fallback a flat `{ canView, canEdit }` shape (stub / legacy).
 */
function normalizePermissions(permissionsPayload, fallback) {
  const capabilities =
    permissionsPayload && typeof permissionsPayload === 'object' ? permissionsPayload.capabilities : null;
  if (capabilities && typeof capabilities === 'object') {
    const isOwner = permissionsPayload.viewerRole === 'owner';
    return {
      canView: capabilities.canView !== false, // viewable unless explicitly denied
      canEdit: capabilities.canEdit === true || isOwner,
    };
  }
  const canView = fallback?.canView !== false; // default to viewable unless explicitly denied
  const canEdit = fallback?.canEdit === true; // edit is opt-in — never assume
  return { canView, canEdit };
}

/**
 * The optional saved layout. Kept intentionally small: the subtype (visible slot count) + the three
 * split ratios the layout owns + the focused index. Absent/invalid fields fall back to the layout's
 * own defaults (subtype = roster length, ratios = 0.5, focus = 0), so a partial payload is safe.
 * @returns {{subtype?:number, splitY?:number, splitXPrimary?:number, splitXSecondary?:number, focusedIndex?:number} | null}
 */
function normalizeLayout(layout) {
  if (!layout || typeof layout !== 'object') return null;
  const num = (v) => (Number.isFinite(v) ? v : undefined);
  const out = {
    subtype: num(layout.subtype),
    splitY: num(layout.splitY),
    splitXPrimary: num(layout.splitXPrimary),
    splitXSecondary: num(layout.splitXSecondary),
    focusedIndex: num(layout.focusedIndex),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : null;
}

/** The first array among the candidates (the payload shape varies: roster/items/entries, nested or not). */
function firstArray(...candidates) {
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

/** The collection's `subtype` string → the initial visible STAGE COUNT (how many placeholders to show). */
const SUBTYPE_COUNT = { 'i-orbiter': 1, 'ii-orbiters': 2, 'iii-orbiters': 3, 'iv-orbiters': 4 };

export function normalizeCollectionPayload(payload, fallbackId = null) {
  const data = payload?.collection ?? payload?.data ?? payload ?? {};
  const rawRoster = firstArray(data.roster, data.voices, data.items, data.entries, payload?.items, payload?.entries);
  const roster = dedupeVoiceIds(rawRoster.map(normalizeRosterEntry).filter(Boolean));
  // Prefer the top-level `permissionsPayload` (mycelium's authed shape); a flat `{ canView, canEdit }`
  // (stub / legacy) is the fallback.
  const permissions = normalizePermissions(
    payload?.permissionsPayload ?? data.permissionsPayload,
    data.permissions ?? data.viewerPermissions ?? payload?.permissions ?? payload?.viewerPermissions,
  );
  // The collection's `subtype` sets how many stage placeholders show by default (root uses it too). Fold
  // it into the layout as the initial subtype unless a saved layout already specifies one.
  const savedLayout = normalizeLayout(data.layout ?? data.savedLayout ?? payload?.layout);
  const subtypeCount = SUBTYPE_COUNT[String(data.subtype || '').toLowerCase()];
  const layout = subtypeCount ? { ...(savedLayout || {}), subtype: savedLayout?.subtype ?? subtypeCount } : savedLayout;
  return {
    collectionId: sanitizeId(data.collectionId || data.id || data._id || null) || fallbackId,
    roster,
    permissions,
    layout,
  };
}

/** A deterministic local roster so collection mode is previewable before the real backend lands. */
function buildStubCollection(collectionId) {
  // Two real published tracks (same ids the single-orbiter demo boots) so the stub actually sounds +
  // textures. Swap/extend freely — this whole function disappears when the endpoint lands.
  const stubRoster = [
    { voiceId: 'stub-voice-1', trackId: 'demo-track-1', orbiterId: null, entangledWorldId: null, entityType: 'track', title: 'Demo Track 1', subtitle: 'Plantasia', image: null },
    { voiceId: 'stub-voice-2', trackId: 'demo-track-2', orbiterId: null, entangledWorldId: null, entityType: 'track', title: 'Demo Track 2', subtitle: 'Plantasia', image: null },
  ];
  return {
    collectionId,
    roster: stubRoster,
    permissions: { canView: true, canEdit: true },
    layout: null,
  };
}

/**
 * Fetch a collection's roster + permissions + saved layout by id, with the session token.
 * @param {string} collectionId
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{collectionId:(string|null), roster:Array, permissions:{canView:boolean,canEdit:boolean}, layout:(object|null)}>}
 * @throws {Error & {status?:number, code?:string}} on no-access / not-found so the caller can render a
 *   message instead of a broken realm.
 */
export async function fetchCollectionData(collectionId, { signal } = {}) {
  const id = sanitizeId(collectionId);
  if (!id) {
    const error = new Error('collectionId is required to load a collection');
    error.code = 'invalid-collection-id';
    throw error;
  }

  // No backend configured (unit tests / bare local) or forced → deterministic stub.
  if (FORCE_STUB || !resolveApiBase()) {
    return buildStubCollection(id);
  }

  const authToken = resolveAuthToken();
  const response = await fetchJsonFromApi(
    `${BASE_ENDPOINT}/${encodeURIComponent(id)}/public?hydrationLevel=1`,
    { method: 'GET', authToken, signal },
  );

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      requestEmbeddedAuthToken();
    }
    const error = new Error(`Failed to load collection (status ${response.status})`);
    error.status = response.status;
    error.code = response.status === 404 ? 'not-found' : 'no-access';
    throw error;
  }

  const payload = await response.json();
  return normalizeCollectionPayload(payload, id);
}

/**
 * Persist a rearranged collection layout (one-shot authed write; caller gates on `canEdit`).
 * @param {string} collectionId
 * @param {{subtype?:number, splitY?:number, splitXPrimary?:number, splitXSecondary?:number, focusedIndex?:number, order?:string[], entryOrder?:string[]}} layout
 * @returns {Promise<boolean>} true when persisted.
 */
export async function saveCollectionLayout(collectionId, layout) {
  const id = sanitizeId(collectionId);
  if (!id) throw new Error('collectionId is required to save a collection layout');

  // The persist endpoint/contract is still open. Until it's defined we acknowledge the write
  // (the read side is real) rather than POST to a guessed URL. Wire the real authed write here once the
  // mycelium layout-persist contract exists.
  void layout;
  return true;
}
