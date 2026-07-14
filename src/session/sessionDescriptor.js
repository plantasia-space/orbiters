import { Constants, DEFAULT_EDIT_TRACK_ID, DEFAULT_EDIT_WORLD_ID } from '../config/Constants.js';

/**
 * @typedef {Object} SessionDescriptor
 * @property {string|null} trackId
 * @property {string|null} orbiterId
 * @property {string|null} entangledWorldId
 * @property {'fallback'|'hydrated'|'url'|'host'|'unknown'} source
 * @property {HydratedBlobs} hydratedBlobs
 */

/**
 * @typedef {Object} HydratedBlobs
 * @property {object|null} trackSession
 * @property {object|null} orbiterSession
 * @property {object|null} entangledWorldSession
 */

const ID_FIELDS = ['trackId', 'orbiterId', 'entangledWorldId'];

const ALIASES = {
  trackId: ['trackId', 'track_id'],
  orbiterId: ['orbiterId', 'orbiter_id', 'engineId', 'engine_id'],
  entangledWorldId: ['entangledWorldId', 'entangled_world_id', 'worldId', 'world_id'],
};

const NESTED_KEYS = {
  trackId: ['requested', 'resolved', 'intent', 'active', 'descriptor'],
  orbiterId: ['requested', 'resolved', 'intent', 'active', 'descriptor'],
  entangledWorldId: ['requested', 'resolved', 'intent', 'active', 'descriptor'],
};

const SCOPED_KEYS = {
  track: 'trackId',
  trackSession: 'trackId',
  orbiter: 'orbiterId',
  orbiterSession: 'orbiterId',
  entangledWorld: 'entangledWorldId',
  entangledWorldSession: 'entangledWorldId',
  data: null,
  payload: null,
  session: null,
  state: null,
  combined: null,
  requestedSession: null,
  resolvedSession: null,
  loadSession: null,
  sessionUpdate: null,
};

const SOURCE_PRIORITY = ['fallback', 'hydrated', 'url', 'host'];

function shouldDebug() {
  return typeof window !== 'undefined' && Boolean(window.__DEBUG_SESSION_DESCRIPTOR);
}

function debugLog(message, payload) {
  if (shouldDebug()) {
    try { console.debug('[SessionDescriptor]', message, payload); } catch (_) {}
  }
}

function sanitizeId(value) {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length ? trimmed : null;
}

function assignId(target, key, value) {
  const sanitized = sanitizeId(value);
  if (!sanitized) return false;
  if (target[key] === sanitized) return false;
  target[key] = sanitized;
  return true;
}

function applyDirectAliases(source, target) {
  let changed = false;
  ID_FIELDS.forEach((field) => {
    const aliases = ALIASES[field];
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(source, alias)) {
        changed = assignId(target, field, source[alias]) || changed;
      }
    }
  });
  return changed;
}

function collectIdsFromObject(source, target, visited = new Set(), depth = 0, scope = null) {
  if (!source || typeof source !== 'object') return false;
  if (visited.has(source) || depth > 4) return false;
  visited.add(source);

  let changed = false;
  if (scope && Object.prototype.hasOwnProperty.call(source, 'id')) {
    changed = assignId(target, scope, source.id) || changed;
  }

  changed = applyDirectAliases(source, target) || changed;

  Object.keys(source).forEach((key) => {
    const value = source[key];
    if (!value || typeof value !== 'object') return;

    const nextScope = SCOPED_KEYS[key] || scope;
    if (Object.prototype.hasOwnProperty.call(SCOPED_KEYS, key) || Array.isArray(value)) {
      collectIdsFromNested(value, target, visited, depth + 1, nextScope);
    } else if (ID_FIELDS.includes(key)) {
      // already handled by aliases
    } else if ((NESTED_KEYS.trackId || []).includes(key) || (NESTED_KEYS.orbiterId || []).includes(key) || (NESTED_KEYS.entangledWorldId || []).includes(key)) {
      collectIdsFromNested(value, target, visited, depth + 1, scope);
    }
  });

  return changed;
}

function collectIdsFromNested(value, target, visited, depth, scope) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectIdsFromObject(entry, target, visited, depth, scope));
  } else {
    collectIdsFromObject(value, target, visited, depth, scope);
  }
}

function normalizeDescriptorCandidate(candidate) {
  if (!candidate) return null;
  const descriptor = { trackId: null, orbiterId: null, entangledWorldId: null };
  const changed = collectIdsFromObject(candidate, descriptor);
  return changed ? descriptor : null;
}

function detectExplicitNulls(candidate) {
  const flags = {
    trackId: false,
    orbiterId: false,
    entangledWorldId: false,
  };
  if (!candidate || typeof candidate !== 'object') {
    return flags;
  }

  const visit = (node, scope = null, depth = 0, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 4) return;
    seen.add(node);

    ID_FIELDS.forEach((field) => {
      const aliases = ALIASES[field] || [field];
      for (const alias of aliases) {
        if (Object.prototype.hasOwnProperty.call(node, alias) && node[alias] === null) {
          flags[field] = true;
        }
      }
      if (scope === field && Object.prototype.hasOwnProperty.call(node, 'id') && node.id === null) {
        flags[field] = true;
      }
    });

    Object.keys(node).forEach((key) => {
      const value = node[key];
      if (!value || typeof value !== 'object') return;
      const nextScope = SCOPED_KEYS[key] || scope;
      visit(value, nextScope, depth + 1, seen);
    });
  };

  visit(candidate, null, 0, new Set());
  return flags;
}

function normalizeUrlDescriptor(params) {
  if (!params) return null;
  let search = null;
  if (params instanceof URLSearchParams) {
    search = params;
  } else if (typeof params === 'string') {
    search = new URLSearchParams(params);
  } else if (typeof window !== 'undefined' && params === true) {
    search = new URLSearchParams(window.location?.search ?? '');
  } else {
    return null;
  }

  const descriptor = {
    trackId: sanitizeId(search.get('trackId')),
    orbiterId: sanitizeId(search.get('orbiterId') ?? search.get('engineId')),
    entangledWorldId: sanitizeId(search.get('entangledWorldId') ?? search.get('worldId')),
  };

  return descriptor.trackId || descriptor.orbiterId || descriptor.entangledWorldId ? descriptor : null;
}

function normalizeHydratedDescriptor(hydrated) {
  if (!hydrated || typeof hydrated !== 'object') return null;
  const descriptor = { trackId: null, orbiterId: null, entangledWorldId: null };
  const visited = new Set();
  let changed = false;
  const blobs = {
    trackSession: hydrated.trackSession ?? null,
    orbiterSession: hydrated.orbiterSession ?? null,
    entangledWorldSession: hydrated.entangledWorldSession ?? null,
  };

  ['trackSession', 'orbiterSession', 'entangledWorldSession'].forEach((key) => {
    if (hydrated[key]) {
      changed =
        collectIdsFromObject(hydrated[key], descriptor, visited, 0, SCOPED_KEYS[key]) || changed;
    }
  });

  return {
    descriptor: changed ? descriptor : null,
    blobs,
  };
}

function normalizeFallbackDescriptor(fallback) {
  if (!fallback) return null;
  if (typeof fallback === 'string') {
    return { trackId: sanitizeId(fallback), orbiterId: null, entangledWorldId: null };
  }
  return normalizeDescriptorCandidate(fallback);
}

function mergeDescriptor(base, incoming) {
  if (!incoming) return false;
  let changed = false;
  ID_FIELDS.forEach((field) => {
    const value = sanitizeId(incoming[field]);
    if (!value) return;
    if (base[field] !== value) {
      base[field] = value;
      changed = true;
    }
  });
  return changed;
}

function hasHydratedData(blobs = {}) {
  return Boolean(blobs.trackSession || blobs.orbiterSession || blobs.entangledWorldSession);
}

function buildSessionDescriptor({
  urlParams = null,
  host = null,
  hydrated = null,
  fallback = null,
} = {}) {
  const descriptor = { trackId: null, orbiterId: null, entangledWorldId: null };
  let source = 'unknown';
  let hydratedBlobs = {
    trackSession: null,
    orbiterSession: null,
    entangledWorldSession: null,
  };

  const contributions = {
    fallback: normalizeFallbackDescriptor(fallback),
    hydrated: normalizeHydratedDescriptor(hydrated),
    url: normalizeUrlDescriptor(urlParams),
    host: normalizeDescriptorCandidate(host),
  };

  const explicitNulls = {
    trackId: false,
    orbiterId: false,
    entangledWorldId: false,
  };

  const urlCandidate =
    urlParams instanceof URLSearchParams
      ? Object.fromEntries(urlParams.entries())
      : urlParams;

  [
    detectExplicitNulls(fallback),
    detectExplicitNulls(hydrated),
    detectExplicitNulls(urlCandidate),
    detectExplicitNulls(host),
  ].forEach((flags) => {
    explicitNulls.trackId = explicitNulls.trackId || flags.trackId;
    explicitNulls.orbiterId = explicitNulls.orbiterId || flags.orbiterId;
    explicitNulls.entangledWorldId = explicitNulls.entangledWorldId || flags.entangledWorldId;
  });

  debugLog('Input contributions', contributions);

  SOURCE_PRIORITY.forEach((label) => {
    const contribution = contributions[label];
    if (!contribution) return;

    if (label === 'hydrated') {
      const hydratedDescriptor = contribution.descriptor;
      if (contribution.blobs) {
        hydratedBlobs = {
          trackSession: contribution.blobs.trackSession ?? hydratedBlobs.trackSession,
          orbiterSession: contribution.blobs.orbiterSession ?? hydratedBlobs.orbiterSession,
          entangledWorldSession:
            contribution.blobs.entangledWorldSession ?? hydratedBlobs.entangledWorldSession,
        };
      }

      if (hydratedDescriptor) {
        const changed = mergeDescriptor(descriptor, hydratedDescriptor);
        if (changed) {
          source = label;
        }
      } else if (source === 'unknown' && hasHydratedData(hydratedBlobs)) {
        source = label;
      }
      return;
    }

    const changed = mergeDescriptor(descriptor, contribution);
    if (changed) {
      source = label;
    }
  });

  if (explicitNulls.trackId) {
    descriptor.trackId = null;
  }
  if (explicitNulls.orbiterId) {
    descriptor.orbiterId = null;
  }
  if (explicitNulls.entangledWorldId) {
    descriptor.entangledWorldId = null;
  }

  const hydratedDescriptor = contributions.hydrated?.descriptor ?? null;
  const fallbackTrackId =
    sanitizeId(contributions.fallback?.trackId) ?? DEFAULT_EDIT_TRACK_ID;
  const fallbackWorldId = sanitizeId(contributions.fallback?.entangledWorldId) ?? null;
  const fallbackOrbiterId = sanitizeId(contributions.fallback?.orbiterId) ?? null;

  let trackDefaults = {
    orbiterId: null,
    orbiterVersion: null,
    entangledWorldId: null,
    entangledWorldVersion: null,
  };

  const resolvedTrackIdPre = sanitizeId(descriptor.trackId);
  if (resolvedTrackIdPre) {
    try {
      let cachedTrackData = null;
      if (typeof Constants.getTrackRelease === 'function') {
        cachedTrackData = Constants.getTrackRelease(resolvedTrackIdPre) ?? null;
      }
      const keyedCandidate = Constants.getConfigByTrackId(resolvedTrackIdPre);
      if (!cachedTrackData && keyedCandidate) {
        const candidate = keyedCandidate;
        const candidateId =
          candidate?.combined?.track?.trackId ??
          candidate?.track?.trackId ??
          candidate?.trackId ??
          null;
        if (candidateId && sanitizeId(candidateId) === resolvedTrackIdPre) {
          cachedTrackData = candidate;
        }
      }

      const trackPayload =
        cachedTrackData?.combined?.track ??
        cachedTrackData?.track ??
        cachedTrackData ?? null;

      if (trackPayload) {
        const metadata = trackPayload.metadata ?? {};
        const defaultOrbiterConfig =
          metadata.defaultOrbiter ||
          metadata.orbiter ||
          trackPayload.defaultOrbiter ||
          {};
        const defaultWorldConfig =
          metadata.defaultEntangledWorld ||
          metadata.entangledWorld ||
          metadata.world ||
          trackPayload.defaultEntangledWorld ||
          {};

        trackDefaults = {
          orbiterId:
            sanitizeId(trackPayload.defaultOrbiterId) ??
            sanitizeId(defaultOrbiterConfig?.id) ??
            sanitizeId(defaultOrbiterConfig?.orbiterId) ??
            null,
          orbiterVersion:
            sanitizeId(trackPayload.defaultOrbiterVersion) ??
            sanitizeId(defaultOrbiterConfig?.version) ??
            null,
          entangledWorldId:
            sanitizeId(trackPayload.defaultEntangledWorldId) ??
            sanitizeId(defaultWorldConfig?.id) ??
            sanitizeId(defaultWorldConfig?.worldId) ??
            null,
          entangledWorldVersion:
            sanitizeId(trackPayload.defaultEntangledWorldVersion) ??
            sanitizeId(defaultWorldConfig?.version) ??
            sanitizeId(defaultWorldConfig?.worldVersion) ??
            null,
        };
      }
    } catch {
      // Cache miss or invalid track; swallow and rely on resolver.
    }
  }

  const hydratedTrackId = sanitizeId(hydratedDescriptor?.trackId);
  const resolvedTrackId = sanitizeId(descriptor.trackId);
  if (!resolvedTrackId) {
    const nextTrackId = explicitNulls.trackId ? fallbackTrackId : hydratedTrackId;
    descriptor.trackId = nextTrackId ?? fallbackTrackId;
    if (source === 'unknown') {
      source = nextTrackId ? 'hydrated' : 'fallback';
    }
  }

  const trackIdForWorld = sanitizeId(descriptor.trackId);
  const hydratedWorldId = sanitizeId(hydratedDescriptor?.entangledWorldId);
  if (!sanitizeId(descriptor.entangledWorldId)) {
    if (hydratedWorldId) {
      descriptor.entangledWorldId = hydratedWorldId;
    } else if (!explicitNulls.entangledWorldId && trackDefaults.entangledWorldId) {
      descriptor.entangledWorldId = trackDefaults.entangledWorldId;
    } else if (fallbackWorldId && (explicitNulls.entangledWorldId || !trackIdForWorld || trackIdForWorld === DEFAULT_EDIT_TRACK_ID)) {
      descriptor.entangledWorldId = fallbackWorldId;
    }
  }

  const hydratedOrbiterId = sanitizeId(hydratedDescriptor?.orbiterId);
  if (!sanitizeId(descriptor.orbiterId)) {
    const hostOrbiterId = sanitizeId(contributions.host?.orbiterId);
    if (hydratedOrbiterId) {
      descriptor.orbiterId = hydratedOrbiterId;
    } else if (hostOrbiterId) {
      descriptor.orbiterId = hostOrbiterId;
    } else if (!explicitNulls.orbiterId && trackDefaults.orbiterId) {
      descriptor.orbiterId = trackDefaults.orbiterId;
    } else if (fallbackOrbiterId && (explicitNulls.orbiterId || !trackIdForWorld || trackIdForWorld === DEFAULT_EDIT_TRACK_ID)) {
      descriptor.orbiterId = fallbackOrbiterId;
    }
  }

  debugLog('Built descriptor', { descriptor, source, hydratedBlobs });

  return {
    ...descriptor,
    source,
    hydratedBlobs,
  };
}

function sessionDescriptorSignature(descriptor = {}) {
  return JSON.stringify({
    trackId: sanitizeId(descriptor.trackId) ?? null,
    orbiterId: sanitizeId(descriptor.orbiterId) ?? null,
    entangledWorldId: sanitizeId(descriptor.entangledWorldId) ?? null,
  });
}

function isSessionDescriptorEmpty(descriptor = {}) {
  return !sanitizeId(descriptor.trackId) && !sanitizeId(descriptor.orbiterId) && !sanitizeId(descriptor.entangledWorldId);
}

export {
  buildSessionDescriptor,
  isSessionDescriptorEmpty,
  sanitizeId,
  sessionDescriptorSignature,
};
