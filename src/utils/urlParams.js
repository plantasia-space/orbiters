import { normalizeGraphicsPresetKey } from '../config/performance.js';
import { normalizeAudioPerformanceKey } from '../config/audioPerformance.js';
import { sanitizeId } from '../session/sessionDescriptor.js';

const DEFAULT_GRAPHICS = 'mid';

function ensureParams(params) {
  if (params instanceof URLSearchParams) {
    return params;
  }
  return new URLSearchParams(window.location?.search ?? '');
}

function normalizeBase64(input) {
  const normalized = (input || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const paddingNeeded = normalized.length % 4;
  if (paddingNeeded === 0) return normalized;
  return normalized + '='.repeat(4 - paddingNeeded);
}

function decodeBase64String(encoded) {
  if (!encoded) return null;
  const normalized = normalizeBase64(encoded);
  if (typeof atob === 'function') {
    return atob(normalized);
  }
  // Fallback for non-browser environments
  return Buffer.from(normalized, 'base64').toString('utf8');
}

/**
 * Returns "high" | "low" based on the graphics query parameter.
 * Defaults to "high" when absent or unrecognized.
 */
export function getGraphicsPreferenceFromUrl(params) {
  const search = ensureParams(params);
  const presetKey = normalizeGraphicsPresetKey(search.get('graphics'));
  if (presetKey === 'LOW') return 'low';
  if (presetKey === 'MID') return 'mid';
  if (presetKey === 'HIGH') return 'high';
  return DEFAULT_GRAPHICS;
}

/**
 * Returns "play" | "edit" based on the mode query parameter.
 * Defaults to "play".
 *
 * Edit mode is a SINGLE-orbiter surface (it edits one orbiter), so a URL that boots the
 * multi-stage app (collection / queue / inline roster) is always "play" — asking for both at once
 * used to mount the collection shell and the studio together, leaving a half-collection,
 * half-studio bar. The multi-stage boot is the one owner of that call: no surface guards itself.
 */
export function getWorldInteractionModeFromUrl(params) {
  const search = ensureParams(params);
  if (isMultiStageBootFromUrl(search)) return 'play';
  const value = (search.get('mode') || '').trim().toLowerCase();
  return value === 'edit' ? 'edit' : 'play';
}

/**
 * Which app this URL boots, resolved ONCE from the flags — the composition root dispatches on it and
 * edit mode is suppressed by it, so the two can never disagree:
 *   - `queue`      → the user's queue (`?queue=me`) or an inline `?tracks=` list
 *   - `collection` → `?collection=<id>`
 *   - `multi`      → `?multi=1` with a valid inline roster
 *   - `single`     → the single-orbiter default. A flag with no usable data (`?multi=1` with no
 *                    valid roster, an empty id) falls through to here, exactly as the branches do.
 * The first three all mount the multi-stage app (several orbiters on one page).
 *
 * Memoized on the query string: every voice's UI re-reads the mode on render, and the roster branch
 * costs a base64 decode + JSON parse — the URL doesn't change under a boot, so parse it once.
 */
let bootTargetCache = null;
export function resolveBootTargetFromUrl(params) {
  const search = ensureParams(params);
  const key = search.toString();
  if (bootTargetCache?.key === key) return bootTargetCache.target;

  const queueTracks = getQueueModeFromUrl(search) ? null : getQueueTracksFromUrl(search);
  const roster = getMultiOrbiterModeFromUrl(search) === 'multi' ? getRosterFromUrl(search) : null;
  const target = {
    kind: getQueueModeFromUrl(search) || queueTracks
      ? 'queue'
      : getCollectionIdFromUrl(search)
        ? 'collection'
        : roster
          ? 'multi'
          : 'single',
    queueMode: getQueueModeFromUrl(search),
    queueTracks,
    collectionId: getCollectionIdFromUrl(search),
    roster,
  };
  bootTargetCache = { key, target };
  return target;
}

/** True when this URL boots the multi-stage app (collection / queue / inline roster). */
export function isMultiStageBootFromUrl(params) {
  return resolveBootTargetFromUrl(params).kind !== 'single';
}

export function getSessionInputSourceFromUrl(params) {
  const search = ensureParams(params);
  const value = (search.get('source') || '').trim().toLowerCase();
  if (!value) return 'default';
  if (['host', 'api', 'hybrid'].includes(value)) return value;
  return 'default';
}

/**
 * Returns whether login prompts should be suppressed from URL configuration.
 * Contract:
 * - default is prompt allowed
 * - ?login=hide hides the login prompt
 * - ?login=false hides the login prompt
 * - ?login=true keeps the login prompt enabled
 * - only the `login` query param is supported
 */
export function getLoginPromptHiddenFromUrl(params) {
  const search = ensureParams(params);
  const loginValue = (search.get('login') || '').trim().toLowerCase();

  if (loginValue === 'hide') return true;
  if (loginValue === 'false') return true;
  if (loginValue === 'true') return false;
  return false;
}

/**
 * Returns an optional internal performance override key (LOW|MID|HIGH).
 * Intended for developer usage via ?perf=LOW.
 */
export function getGraphicsPerfOverrideFromUrl(params) {
  const search = ensureParams(params);
  return normalizeGraphicsPresetKey(search.get('perf'));
}

export function getAudioPerformanceFromUrl(params) {
  const search = ensureParams(params);
  return normalizeAudioPerformanceKey(search.get('audio'));
}

export function getFpsOverlayEnabledFromUrl(params) {
  const search = ensureParams(params);
  const value = (search.get('fps') || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Returns true iff ?sharedClock=1|true.
 *
 * Off-by-default flag that opts a session into the shared musical clock
 * (BeatTimeline + ConnectRelay riding the existing Connect socket). This first
 * slice is additive + LOG-ONLY: it does not drive audio/UI, so the default path
 * stays byte-identical. Only meaningful alongside ?room=<name> (the shared clock
 * rides the WebSocketSyncAdapter's Connect socket; there is no socket without a room).
 */
export function getSharedClockEnabledFromUrl(params) {
  const search = ensureParams(params);
  const value = (search.get('sharedClock') || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Returns the launch-quantize grid in beats from ?launchGrid=<n>, or null when absent/invalid.
 * Live-style launch quantization grid the bar-quantized START snaps to: 8=2 bars, 4=1 bar, 2=1/2,
 * 1=1/4, 0.5=1/8 (4/4), 0=none (no snap — launch immediately). Lets a session pin the grid; default
 * (1 bar) applies when absent. Negatives / non-finite are invalid → null (default applies).
 */
export function getLaunchGridFromUrl(params) {
  const search = ensureParams(params);
  const raw = (search.get('launchGrid') || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Returns the audio buffer size hint from ?audioBuffer=low|mid|high.
 * Maps to Web Audio API latencyHint values:
 *   low  → 'interactive' (small buffers, lowest latency, highest CPU)
 *   mid  → 'balanced'
 *   high → 'playback'   (large buffers, highest latency, lowest CPU)
 * Returns null when absent or unrecognized.
 */
export function getAudioBufferHintFromUrl(params) {
  const search = ensureParams(params);
  const value = (search.get('audioBuffer') || '').trim().toLowerCase();
  if (value === 'low') return 'interactive';
  if (value === 'mid') return 'balanced';
  if (value === 'high') return 'playback';
  return null;
}

export function getSessionIdFromUrl(params) {
  const search = ensureParams(params);
  return sanitizeId(search.get('sessionId'));
}

export function getDirectPayloadFromURL(params) {
  const search = ensureParams(params);
  const encoded = (search.get('directPayload') || '').trim();
  if (!encoded) return null;

  let decoded = null;
  try {
    decoded = decodeBase64String(encoded);
  } catch (error) {
    console.warn('[URLParams] Failed to Base64 decode directPayload', error);
    return null;
  }

  if (!decoded) {
    console.warn('[URLParams] directPayload was empty after decoding');
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    console.warn('[URLParams] directPayload is not valid JSON', error);
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    console.warn('[URLParams] directPayload did not decode to an object');
    return null;
  }

  const requiredKeys = ['trackSession', 'orbiterSession', 'entangledWorldSession'];
  const missing = requiredKeys.filter((key) => !parsed[key]);
  if (missing.length) {
    console.warn(
      `[URLParams] directPayload missing required keys: ${missing.join(', ')}`,
    );
    return null;
  }

  return {
    trackSession: parsed.trackSession,
    orbiterSession: parsed.orbiterSession,
    entangledWorldSession: parsed.entangledWorldSession,
  };
}

/**
 * Returns the collection id from `?collection=<id>`, or null when absent/invalid.
 *
 * Collection mode boots the SAME multi-orbiter realm as `?multi=1`, but instead of carrying the roster
 * inline in the URL it carries only the collection id: the app fetches that collection itself with the
 * session token (roster + permissions + saved layout — see the collection-data client) and
 * composes it into the native resizable slot layout (decisions/0004). The host opens this full-screen.
 * A stray/empty value falls through to the single-orbiter path (Main.js), exactly like a
 * `?multi=1` with no roster — a bad flag can never strand the realm with nothing to show.
 */
/**
 * Queue mode: `?queue=me` boots the multi-stage layout from the signed-in
 * user's playable queue (fetched from the backend), NOT from a collection.
 */
export function getQueueModeFromUrl(params) {
  const search = ensureParams(params);
  return search.get('queue') === 'me' ? 'me' : null;
}

/**
 * Dev/guest shortcut for queue mode: `?tracks=<id,id,…>` — an inline track-id list
 * (bounded; ids sanitized). Returns null when absent/empty.
 */
export function getQueueTracksFromUrl(params) {
  const search = ensureParams(params);
  const raw = search.get('tracks');
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((id) => sanitizeId(id.trim()))
    .filter(Boolean)
    .slice(0, 50);
  return ids.length > 0 ? ids : null;
}

/** The track the queue should start on (`?start=<trackId>`), else null. */
export function getQueueStartFromUrl(params) {
  const search = ensureParams(params);
  return sanitizeId(search.get('start'));
}

export function getCollectionIdFromUrl(params) {
  const search = ensureParams(params);
  return sanitizeId(search.get('collection'));
}

/**
 * Returns 'multi' when the URL opts the realm into the multi-orbiter boot, else null.
 *
 * Multi-orbiter mode mounts N orbiter "voices" in ONE iframe/realm sharing one AudioContext +
 * one master limiter (`MultiOrbiterAudioHost`). It is a parallel boot branch — the single-orbiter
 * default path is untouched unless this returns 'multi' AND a valid roster is present
 * (`getRosterFromUrl`). The flag alone, with no roster, intentionally falls back to single-orbiter
 * so a stray `?multi=1` can never strand the realm with zero voices.
 */
export function getMultiOrbiterModeFromUrl(params) {
  const search = ensureParams(params);
  const value = (search.get('multi') || '').trim().toLowerCase();
  return value === '1' || value === 'true' ? 'multi' : null;
}

/**
 * Parse the multi-orbiter roster carried over the URL — the ordered list of voices the
 * realm should boot. The host will carry the same shape over the postMessage bridge; the URL
 * form lets this be driven + verified locally without the host change.
 *
 * Wire format mirrors `directPayload`: `?roster=<base64-url JSON>` where the JSON is either an
 * ordered array of voice descriptors or `{ maxVoices?, voices: [...] }`. Each descriptor:
 *   { voiceId?, trackId, orbiterId?, entangledWorldId?, sessionId?, directPayload? }
 * Only `trackId` is required (a voice with no track cannot build an audio graph). `voiceId` is the
 * stable registry key; when absent it falls back to `orbiterId`, then `trackId` (so two voices on
 * the same track stay distinguishable only if they carry explicit voiceIds — the host always will).
 *
 * `maxVoices` is the realm cap — sourced from the host's backend iframe limit, NOT hardwired here;
 * when present it truncates the roster (a defensive bound, never a product policy baked into the FE).
 *
 * @returns {Array<{voiceId:string, trackId:string, orbiterId:(string|null), entangledWorldId:(string|null), sessionId:(string|null), directPayload:(object|null)}> | null}
 *   the validated, ordered roster, or null when absent/empty/invalid.
 */
export function getRosterFromUrl(params) {
  const search = ensureParams(params);
  const encoded = (search.get('roster') || '').trim();
  if (!encoded) return null;

  let decoded = null;
  try {
    decoded = decodeBase64String(encoded);
  } catch (error) {
    console.warn('[URLParams] Failed to Base64 decode roster', error);
    return null;
  }
  if (!decoded) {
    console.warn('[URLParams] roster was empty after decoding');
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    console.warn('[URLParams] roster is not valid JSON', error);
    return null;
  }

  const rawVoices = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.voices)
      ? parsed.voices
      : null;
  if (!rawVoices) {
    console.warn('[URLParams] roster did not decode to an array of voices');
    return null;
  }

  const maxVoices = Number.isFinite(parsed?.maxVoices) && parsed.maxVoices > 0
    ? Math.floor(parsed.maxVoices)
    : null;

  const voices = [];
  for (let i = 0; i < rawVoices.length; i++) {
    const entry = rawVoices[i];
    if (!entry || typeof entry !== 'object') continue;

    const trackId = sanitizeId(entry.trackId || entry.track_id || null);
    if (!trackId) {
      console.warn(`[URLParams] roster voice ${i} dropped: missing trackId`);
      continue;
    }

    const orbiterId = sanitizeId(entry.orbiterId || entry.orbiter_id || entry.engineId || null);
    const entangledWorldId = sanitizeId(
      entry.entangledWorldId || entry.entangled_world_id || entry.worldId || null,
    );
    const voiceId = sanitizeId(entry.voiceId || entry.voice_id || null) || orbiterId || trackId;
    const sessionId = sanitizeId(entry.sessionId || entry.session_id || null);
    const directPayload =
      entry.directPayload && typeof entry.directPayload === 'object' ? entry.directPayload : null;

    voices.push({ voiceId, trackId, orbiterId, entangledWorldId, sessionId, directPayload });
  }

  if (!voices.length) return null;
  return maxVoices ? voices.slice(0, maxVoices) : voices;
}

export function deriveDescriptorFromHydratedPayload(payload) {
  const trackSession = payload?.trackSession ?? {};
  const orbiterSession = payload?.orbiterSession ?? {};
  const worldSession = payload?.entangledWorldSession ?? {};

  const trackId = sanitizeId(
      trackSession.trackId ||
      trackSession.id ||
      trackSession?.release?.trackId ||
      trackSession?.release?.metadata?.trackId ||
      null,
  );

  return {
    trackId,
    trackVersion: sanitizeId(trackSession?.release?.version || trackSession?.version || null),
    orbiterId: sanitizeId(
      orbiterSession.orbiterId ||
      orbiterSession.id ||
      orbiterSession?.release?.orbiterId ||
      orbiterSession?.release?.metadata?.orbiterId ||
      orbiterSession?.release?.metadata?.id ||
      null,
    ),
    orbiterVersion: sanitizeId(
      orbiterSession?.release?.version || orbiterSession?.version || null,
    ),
    entangledWorldId: sanitizeId(
      worldSession.worldId ||
      worldSession.id ||
      worldSession?.release?.worldId ||
      worldSession?.release?.metadata?.worldId ||
      worldSession?.release?.metadata?.id ||
      null,
    ),
    entangledWorldVersion: sanitizeId(
      worldSession?.release?.version || worldSession?.version || null,
    ),
  };
}
