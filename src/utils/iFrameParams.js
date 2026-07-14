import { DEFAULT_EDIT_TRACK_ID } from '../config/Constants.js';
import { setExternalAuthToken } from '../auth/sessionAuth.js';
import { syncCoordinator } from '../sync/SyncCoordinator.js';

const MESSAGE_TYPES = {
  HELLO: 'HELLO',
  PREVIEW_STATE: 'PREVIEW_STATE',
  HOST_OUTPUT: 'HOST_OUTPUT',
  ORBITER_PLAYBACK_TIME: 'ORBITER_PLAYBACK_TIME',
  CHILD_OUTPUT: 'CHILD_OUTPUT',
  ERROR: 'ERROR',
  PING: 'PING',
  PONG: 'PONG',
};

const PROTOCOL_VERSION = '1.0';

const ERROR_CODES = {
  INVALID_STATE: 'INVALID_STATE',
  UNAUTHORIZED_ORIGIN: 'UNAUTHORIZED_ORIGIN',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
};

const DESCRIPTOR_KEYS = [
  'trackId',
  'trackVersion',
  'orbiterId',
  'orbiterVersion',
  'entangledWorldId',
  'entangledWorldVersion',
];

const DESCRIPTOR_ALIASES = {
  trackId: ['trackId'],
  trackVersion: ['trackVersion'],
  orbiterId: ['orbiterId', 'engineId'],
  orbiterVersion: ['orbiterVersion', 'engineVersion'],
  entangledWorldId: ['entangledWorldId', 'worldId'],
  entangledWorldVersion: ['entangledWorldVersion', 'worldVersion'],
};

const HAS_WINDOW = typeof window !== 'undefined';

const config = {
  debounceMs: 150,
  hostCommandTimeoutMs: 2500,
};

const HOST_SOURCE_HINT = (() => {
  if (!HAS_WINDOW) return 'default';
  try {
    const params = new URLSearchParams(window.location.search || '');
    const value = (params.get('source') || '').trim().toLowerCase();
    if (value === 'host' || value === 'api' || value === 'hybrid') {
      return value;
    }
    return value || 'default';
  } catch {
    return 'default';
  }
})();
const SHOULD_EXPECT_HOST_COMMAND = HOST_SOURCE_HINT === 'host';

let authorizedOrigin = null;
let outboundQueue = [];
let handshakeWatchdogTimer = null;
let debounceTimer = null;
let requestIdCounter = 0;
let hostCommandRequestId = null;
let pendingOrbiterSession = null;
let lastHostOrbiterSession = null;
let suppressEditEcho = false;
let urlOverridesApplied = false;
let hostCommandTimer = null;
let hostCommandObserved = false;
let playbackBridge = null;

let sessionState = createInitialSession();

function createInitialDescriptor() {
  return {
    trackId: DEFAULT_EDIT_TRACK_ID,
    trackVersion: null,
    orbiterId: null,
    orbiterVersion: null,
    entangledWorldId: null,
    entangledWorldVersion: null,
  };
}

function createInitialSession() {
  const descriptor = createInitialDescriptor();
  return {
    requested: descriptor,
    resolved: { ...descriptor },
    source: 'fallback',
    status: 'idle',
    errors: [],
    updatedAt: Date.now(),
  };
}

function dispatchBridgeEvent(name, detail) {
  if (!HAS_WINDOW || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent(`orbiters:${name}`, { detail }));
  } catch (error) {
    console.warn('[Orbiters Bridge] Failed to dispatch event', name, error);
  }
}

function sanitizeId(value) {
  if (value == null) return null;
  const str = typeof value === 'string' ? value.trim() : String(value).trim();
  return str.length ? str : null;
}

function cloneSession(session) {
  if (!session || typeof session !== 'object') return createInitialSession();
  const errors = Array.isArray(session.errors)
    ? session.errors.map((err) => ({ ...err }))
    : [];
  return {
    requested: { ...session.requested },
    resolved: { ...session.resolved },
    source: session.source ?? 'unknown',
    status: session.status ?? 'unknown',
    errors,
    updatedAt: session.updatedAt ?? Date.now(),
  };
}

function descriptorsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return DESCRIPTOR_KEYS.every((key) => (a[key] ?? null) === (b[key] ?? null));
}

function sessionsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    descriptorsEqual(a.requested, b.requested) &&
    descriptorsEqual(a.resolved, b.resolved) &&
    (a.status ?? null) === (b.status ?? null) &&
    (a.source ?? null) === (b.source ?? null) &&
    JSON.stringify(a.errors ?? []) === JSON.stringify(b.errors ?? [])
  );
}

function sanitizeDescriptor(input = {}) {
  const result = {};
  DESCRIPTOR_KEYS.forEach((key) => {
    const aliases = DESCRIPTOR_ALIASES[key] || [key];
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(input, alias)) {
        const value = sanitizeId(input[alias]);
        if (value !== undefined) {
          result[key] = value;
          return;
        }
      }
    }
  });
  return result;
}

function mergeDescriptor(base = {}, patch = {}) {
  const merged = { ...base };
  DESCRIPTOR_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      merged[key] = patch[key];
    }
  });
  if (!merged.trackId) {
    merged.trackId = DEFAULT_EDIT_TRACK_ID;
  }
  return merged;
}

function normalizeErrors(errors) {
  if (!errors) return [];
  if (!Array.isArray(errors)) return [typeof errors === 'object' ? { ...errors } : { message: String(errors) }];
  return errors.map((err) => (err && typeof err === 'object' ? { ...err } : { message: String(err) }));
}

function mergeSessionPatches(target, patch) {
  if (!patch || typeof patch !== 'object') return target;
  const next = { ...target };
  if (patch.requested) {
    next.requested = mergeDescriptor(next.requested || {}, sanitizeDescriptor(patch.requested));
  }
  if (patch.resolved) {
    next.resolved = mergeDescriptor(next.resolved || {}, sanitizeDescriptor(patch.resolved));
  }
  if (patch.status !== undefined) {
    next.status = patch.status;
  }
  if (patch.source !== undefined) {
    next.source = patch.source;
  }
  if (patch.errors !== undefined) {
    next.errors = normalizeErrors(patch.errors);
  }
  return next;
}

function buildPatchFromInput(input) {
  if (!input || typeof input !== 'object') return null;

  let patch = null;

  const descriptor = sanitizeDescriptor(input);
  if (Object.keys(descriptor).length) {
    patch = mergeSessionPatches(patch || {}, { requested: descriptor });
  }

  if (input.requested && typeof input.requested === 'object') {
    patch = mergeSessionPatches(patch || {}, { requested: input.requested });
  }
  if (input.resolved && typeof input.resolved === 'object') {
    patch = mergeSessionPatches(patch || {}, { resolved: input.resolved });
  }
  if (input.status !== undefined) {
    patch = mergeSessionPatches(patch || {}, { status: input.status });
  }
  if (input.source !== undefined) {
    patch = mergeSessionPatches(patch || {}, { source: input.source });
  }
  if (input.errors !== undefined) {
    patch = mergeSessionPatches(patch || {}, { errors: input.errors });
  }

  return patch;
}

function aggregateSessionPatch(inputs) {
  return inputs.reduce((acc, input) => {
    const built = buildPatchFromInput(input);
    if (!built) return acc;
    return mergeSessionPatches(acc || {}, built);
  }, null);
}

function mapSessionStatus(status) {
  switch (status) {
    case 'resolved':
    case 'ready':
      return 'session-ready';
    case 'error':
      return 'session-error';
    case 'loading':
    case 'pending':
      return 'session-loading';
    case 'idle':
    case 'unknown':
    default:
      return status ? `session-${String(status)}` : null;
  }
}

function buildSessionEnvelope(session) {
  return {
    intent: { ...session.requested },
    resolved: { ...session.resolved },
    status: session.status ?? null,
    source: session.source ?? null,
    errors: normalizeErrors(session.errors),
    updatedAt: session.updatedAt ?? Date.now(),
  };
}

function notifyHostSessionChange(previous, next, { source, resolution = null, requestId = null } = {}) {
  if (!authorizedOrigin || !next) return;
  if (sessionsEqual(previous, next) && !resolution) return;

  const statusLabel = mapSessionStatus(next.status);
  const payload = {
    status: statusLabel || 'session-update',
    session: buildSessionEnvelope(next),
    meta: { source: source ?? next.source ?? null },
  };

  if (resolution && typeof resolution === 'object') {
    payload.resolution = resolution;
  }

  const effectiveRequestId = requestId || hostCommandRequestId || undefined;
  const message = createMessage(MESSAGE_TYPES.CHILD_OUTPUT, payload, effectiveRequestId);
  sendToHost(message);

  if (statusLabel === 'session-ready' || statusLabel === 'session-error') {
    hostCommandRequestId = null;
  }
}

function buildPreviewState() {
  const session = sessionState;
  const descriptor = session.resolved || session.requested;
  return {
    mode: 'orbiters-edit',
    trackId: descriptor.trackId ?? null,
    trackVersion: descriptor.trackVersion ?? null,
    orbiterId: descriptor.orbiterId ?? null,
    orbiterVersion: descriptor.orbiterVersion ?? null,
    entangledWorldId: descriptor.entangledWorldId ?? null,
    entangledWorldVersion: descriptor.entangledWorldVersion ?? null,
    session: {
      status: session.status ?? null,
      source: session.source ?? null,
      requested: { ...session.requested },
      resolved: { ...session.resolved },
    },
    sync: readSyncSnapshot(),
  };
}

function readSyncSnapshot() {
  // Skip until the coordinator is wired (same gate the old `window.__orbitersSync` presence check gave).
  if (!syncCoordinator.isInitialized) return null;
  const sync = syncCoordinator;
  return {
    enabled: sync.isEnabled === true,
    mode: typeof sync.mode === 'string' ? sync.mode : 'TEMPO_ONLY',
    bpm: Number.isFinite(Number(sync.bpm)) ? Number(sync.bpm) : null,
    trackBpm: Number.isFinite(Number(sync.trackBpm)) ? Number(sync.trackBpm) : null,
    detectedTrackBpm: Number.isFinite(Number(sync.detectedTrackBpm)) ? Number(sync.detectedTrackBpm) : null,
    peerCount: Math.max(0, Number(sync.peerCount) || 0),
    isConductor: sync.isConductor === true,
    tempoSourceType: typeof sync.tempoSourceType === 'string' ? sync.tempoSourceType : 'manual',
  };
}

function schedulePreview() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const snapshot = buildPreviewState();
    const message = createMessage(MESSAGE_TYPES.PREVIEW_STATE, {
      state: snapshot,
      timestamp: Date.now(),
    });
    sendToHost(message);
    dispatchBridgeEvent('state-sent', { type: MESSAGE_TYPES.PREVIEW_STATE, snapshot });
  }, config.debounceMs);
}

function applySessionPatch(patch = {}, { source = 'local', emitPreview = true, notifyHost = true, resolution = null, requestId = null } = {}) {
  if (!patch || typeof patch !== 'object') {
    return { session: cloneSession(sessionState), changed: false };
  }

  const previous = sessionState;
  const next = cloneSession(previous);

  if (patch.requested) {
    next.requested = mergeDescriptor(next.requested, sanitizeDescriptor(patch.requested));
  } else {
    next.requested = mergeDescriptor(next.requested, {});
  }
  if (patch.resolved) {
    next.resolved = mergeDescriptor(next.resolved, sanitizeDescriptor(patch.resolved));
  } else {
    next.resolved = mergeDescriptor(next.resolved, {});
  }
  // Ensure resolved at least mirrors requested values when missing.
  next.resolved = mergeDescriptor(next.resolved, next.requested);

  if (patch.status !== undefined) {
    next.status = patch.status;
  }
  if (patch.source !== undefined) {
    next.source = patch.source;
  } else {
    next.source = source;
  }
  if (patch.errors !== undefined) {
    next.errors = normalizeErrors(patch.errors);
  }
  next.updatedAt = Date.now();

  const changed = !sessionsEqual(previous, next);
  if (!changed) {
    return { session: cloneSession(sessionState), changed: false };
  }

  sessionState = next;

  dispatchBridgeEvent('state-updated', { session: cloneSession(sessionState), source: sessionState.source });

  if (notifyHost) {
    notifyHostSessionChange(previous, sessionState, { source: sessionState.source, resolution, requestId });
  }

  if (emitPreview) {
    schedulePreview();
  }

  return { session: cloneSession(sessionState), changed: true };
}

function deepClone(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // fall through
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function createMessage(type, payload = {}, requestId = null) {
  return {
    type,
    version: PROTOCOL_VERSION,
    requestId: requestId || generateRequestId(),
    payload,
  };
}

function generateRequestId() {
  if (HAS_WINDOW && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `req_${++requestIdCounter}_${Date.now()}`;
}

function sendToHost(message) {
  if (!HAS_WINDOW) return;
  if (!window.parent || window.parent === window) {
    console.warn('[Orbiters Bridge] No parent window; outbound message dropped.', message.type);
    return;
  }
  if (!authorizedOrigin) {
    outboundQueue.push(message);
    return;
  }
  try {
    window.parent.postMessage(message, authorizedOrigin);
    dispatchBridgeEvent('outbound', { type: message.type, message });
  } catch (error) {
    console.error('[Orbiters Bridge] postMessage failed', error);
  }
}

function flushOutboundQueue() {
  if (!authorizedOrigin || !outboundQueue.length) return;
  const queued = outboundQueue;
  outboundQueue = [];
  queued.forEach(sendToHost);
}

function sendErrorToHost(code, message, details = null, requestId = null) {
  const errorMessage = createMessage(
    MESSAGE_TYPES.ERROR,
    { code, message, details },
    requestId
  );
  sendToHost(errorMessage);
}

function normalizePlaybackTimeSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  return Math.max(0, seconds);
}

function getBridgeTrackId(commandData = {}) {
  return sanitizeId(commandData?.trackId) ||
    sanitizeId(sessionState?.resolved?.trackId) ||
    sanitizeId(sessionState?.requested?.trackId) ||
    null;
}

function sendPlaybackTimeToHost({ requestId = null, trackId = null, currentTime = 0, isPlaying = false } = {}) {
  const seconds = normalizePlaybackTimeSeconds(currentTime) ?? 0;
  const message = createMessage(
    MESSAGE_TYPES.ORBITER_PLAYBACK_TIME,
    {
      trackId: sanitizeId(trackId) || getBridgeTrackId(),
      currentTime: seconds,
      isPlaying: Boolean(isPlaying),
    },
    requestId
  );
  sendToHost(message);
}

function setOrbiterPlaybackBridge(bridge = null) {
  playbackBridge = bridge && typeof bridge === 'object' ? bridge : null;
}

async function handlePlaybackHostCommand(command, commandData = {}, requestId = null) {
  if (command !== 'get-playback-time' && command !== 'seek-playback') {
    return false;
  }

  if (!playbackBridge) {
    sendErrorToHost(
      ERROR_CODES.INVALID_STATE,
      'Playback bridge is not ready',
      { command },
      requestId
    );
    return true;
  }

  const trackId = getBridgeTrackId(commandData);

  if (command === 'get-playback-time') {
    const currentTime = await Promise.resolve(playbackBridge.getCurrentTime?.({ trackId, requestId }));
    const isPlaying = await Promise.resolve(playbackBridge.isPlaying?.({ trackId, requestId }));
    sendPlaybackTimeToHost({ requestId, trackId, currentTime, isPlaying });
    dispatchBridgeEvent('playback-time-request', { requestId, trackId, currentTime, isPlaying: Boolean(isPlaying) });
    return true;
  }

  const targetTime = normalizePlaybackTimeSeconds(commandData?.time);
  if (targetTime == null) {
    sendErrorToHost(
      ERROR_CODES.INVALID_STATE,
      'Invalid playback seek time',
      { command, time: commandData?.time },
      requestId
    );
    return true;
  }

  await Promise.resolve(playbackBridge.seek?.({ trackId, time: targetTime, requestId }));
  dispatchBridgeEvent('playback-seek', { requestId, trackId, time: targetTime });
  return true;
}

function extractHostCommand(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return { command: null, data: null, remainder: {} };
  }

  const result = { command: null, data: null, remainder: { ...payload } };

  if (typeof payload.command === 'string') {
    result.command = payload.command.trim().toLowerCase();
    if (payload.data && typeof payload.data === 'object') {
      result.data = payload.data;
    }
    delete result.remainder.command;
    if (result.data) delete result.remainder.data;
  }

  if (!result.command && payload.loadSession && typeof payload.loadSession === 'object') {
    result.command = 'load-session';
    result.data = payload.loadSession;
    delete result.remainder.loadSession;
  }

  if (!result.command) {
    return result;
  }

  return result;
}

function extractSessionPatchFromPayload(payload, commandData) {
  const pieces = [
    payload,
    commandData,
    payload?.session,
    payload?.sessionUpdate,
    commandData?.session,
    commandData?.sessionUpdate,
    payload?.requestedSession ? { requested: payload.requestedSession } : null,
    payload?.resolvedSession ? { resolved: payload.resolvedSession } : null,
    commandData?.requestedSession ? { requested: commandData.requestedSession } : null,
    commandData?.resolvedSession ? { resolved: commandData.resolvedSession } : null,
  ];

  return aggregateSessionPatch(pieces.filter(Boolean));
}

function extractHydratedBlobs(commandData = {}, payload = {}) {
  const trackSession =
    commandData?.trackSession ??
    commandData?.trackRelease ??
    payload?.trackSession ??
    payload?.trackRelease ??
    null;
  const orbiterSession =
    commandData?.orbiterSession ??
    commandData?.orbiterRelease ??
    payload?.orbiterSession ??
    payload?.orbiterRelease ??
    null;
  const entangledWorldSession =
    commandData?.entangledWorldSession ??
    commandData?.entangledWorldRelease ??
    payload?.entangledWorldSession ??
    payload?.entangledWorldRelease ??
    null;

  const hydratedBlobs = {
    trackSession: trackSession ?? null,
    orbiterSession: orbiterSession ?? null,
    entangledWorldSession: entangledWorldSession ?? null,
  };

  const hasHydration =
    Boolean(hydratedBlobs.trackSession) ||
    Boolean(hydratedBlobs.orbiterSession) ||
    Boolean(hydratedBlobs.entangledWorldSession);

  return hasHydration ? hydratedBlobs : null;
}

function extractSyncControlFromPayload(payload = {}, commandData = null) {
  const candidates = [
    payload?.sync,
    payload?.syncState,
    payload?.tempo,
    payload?.playback,
    commandData?.sync,
    commandData?.syncState,
    commandData?.tempo,
    commandData?.playback,
    payload,
    commandData,
  ];

  const patch = {};
  let matched = false;

  candidates.forEach((candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    const assign = (targetKey, ...sourceKeys) => {
      for (const sourceKey of sourceKeys) {
        if (Object.prototype.hasOwnProperty.call(candidate, sourceKey)) {
          patch[targetKey] = candidate[sourceKey];
          matched = true;
          return;
        }
      }
    };

    assign('enabled', 'enabled', 'syncEnabled', 'sync', 'sessionSync');
    assign('bpm', 'bpm', 'tempo', 'sessionBpm', 'syncBpm');
    assign('trackBpm', 'trackBpm', 'audioBpm', 'audioTempo');
    assign('mode', 'mode', 'syncMode');
  });

  return matched ? patch : null;
}

function handleHostOutput(message) {
  hostCommandObserved = true;
  if (hostCommandTimer) {
    clearTimeout(hostCommandTimer);
    hostCommandTimer = null;
  }
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
  const { command, data: commandData, remainder } = extractHostCommand(payload);

  const inboundOrbiterSession =
    (commandData && typeof commandData === 'object' && commandData.orbiterSession) ||
    payload?.orbiterSession ||
    null;

  if (inboundOrbiterSession && typeof inboundOrbiterSession === 'object') {
    const cloned = deepClone(inboundOrbiterSession);
    pendingOrbiterSession = cloned;
    if (cloned) {
      lastHostOrbiterSession = deepClone(cloned);
      suppressEditEcho = true;
    }
  }

  let changed = false;

  const hydratedBlobs = extractHydratedBlobs(commandData, payload);
  const syncControl = extractSyncControlFromPayload(payload, commandData);

  if (command === 'load-session') {
    hostCommandRequestId = message.requestId || hostCommandRequestId;
    const sessionPatch = extractSessionPatchFromPayload(payload, commandData);
    const resolution = commandData?.resolution || payload?.resolution || null;
    const source = sessionPatch?.source || commandData?.source || payload?.source || 'host-load';
    const status = sessionPatch?.status ?? commandData?.status ?? 'loading';

    const combinedPatch = mergeSessionPatches(sessionPatch || {}, { status, source });
    const { changed: patchChanged, session } = applySessionPatch(combinedPatch, {
      source,
      emitPreview: false,
      notifyHost: true,
      resolution,
      requestId: message.requestId || null,
    });
    changed = patchChanged;

    const sessionDetail = hydratedBlobs ? { ...session, hydratedBlobs } : session;
    dispatchBridgeEvent('session-load', {
      payload: commandData || payload,
      requestId: message.requestId,
      session: sessionDetail,
      changed,
      hydratedBlobs,
    });
  } else if (command === 'update-session') {
    hostCommandRequestId = message.requestId || hostCommandRequestId;
    const sessionPatch = extractSessionPatchFromPayload(payload, commandData);
    const source = sessionPatch?.source || commandData?.source || payload?.source || 'host-update';

    const changedHints = Array.isArray(commandData?.changed)
      ? commandData.changed
      : Array.isArray(payload?.changed)
        ? payload.changed
        : [];

    const combinedPatch = mergeSessionPatches(sessionPatch || {}, { source });
    const { changed: patchChanged, session } = applySessionPatch(combinedPatch, {
      source,
      emitPreview: false,
      notifyHost: true,
      requestId: message.requestId || null,
    });
    changed = patchChanged;

    const sessionDetail = hydratedBlobs ? { ...session, hydratedBlobs } : session;
    dispatchBridgeEvent('session-update', {
      payload: commandData || payload,
      requestId: message.requestId,
      session: sessionDetail,
      changed: changedHints.length > 0 ? changedHints : (changed ? ['session'] : []),
      hydratedBlobs,
    });
  } else if (command === 'ping') {
    const pongMessage = createMessage(MESSAGE_TYPES.PONG, {
      timestamp: Date.now(),
      originalTimestamp: commandData?.timestamp,
    }, message.requestId);
    sendToHost(pongMessage);
  } else if (command === 'get-playback-time' || command === 'seek-playback') {
    void handlePlaybackHostCommand(command, commandData || {}, message.requestId || null)
      .catch((error) => {
        sendErrorToHost(
          ERROR_CODES.PROCESSING_ERROR,
          'Failed to process playback command',
          { command, message: error?.message || String(error) },
          message.requestId || null
        );
      });
  } else if (command === 'provide-auth' || command === 'auth-token') {
    const rawToken =
      (commandData && typeof commandData === 'object' && (commandData.customToken || commandData.token)) ||
      payload?.customToken ||
      payload?.token ||
      null;
    const expiresAt = Number(commandData?.expiresAt ?? payload?.expiresAt);
    if (rawToken && typeof rawToken === 'string' && rawToken.trim()) {
      setExternalAuthToken(rawToken, {
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      });
      dispatchBridgeEvent('auth-token', {
        requestId: message.requestId,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      });
    }
  }

  if (remainder && Object.keys(remainder).length) {
    const remainderPatch = extractSessionPatchFromPayload(remainder, null);
    if (remainderPatch) {
      const { changed: remainderChanged } = applySessionPatch(remainderPatch, {
        source: remainderPatch.source || 'host-update',
        emitPreview: false,
        notifyHost: true,
        requestId: message.requestId || null,
      });
      changed = changed || remainderChanged;
    }
  }

  if (syncControl) {
    dispatchBridgeEvent('sync-control', {
      control: syncControl,
      payload,
      requestId: message.requestId,
      source: commandData?.source || payload?.source || 'host-output',
    });
  }

  dispatchBridgeEvent('host-output', {
    payload,
    requestId: message.requestId,
    session: cloneSession(sessionState),
    changed,
    hydratedBlobs,
  });
}

function handleHostMessage(event) {
  const data = event.data;
  if (!data || typeof data !== 'object' || !data.type) return;

  // Only the window embedding us is a legitimate host. Without this, any window that
  // speaks first (popup, injected script, same-window post) becomes the trusted origin
  // for the whole session — including the auth-token path.
  if (window.parent === window || event.source !== window.parent) return;

  if (data.type === MESSAGE_TYPES.HELLO) {
    if (!authorizedOrigin) {
      authorizedOrigin = event.origin;
      dispatchBridgeEvent('handshake-complete', { origin: authorizedOrigin });
      const snapshot = {
        state: buildPreviewState(),
        timestamp: Date.now(),
      };
      const reply = createMessage(MESSAGE_TYPES.HELLO, snapshot, data.requestId);
      sendToHost(reply);
      flushOutboundQueue();
      scheduleHostFallbackCheck();
    }
    return;
  }

  if (!authorizedOrigin && data.type === MESSAGE_TYPES.HOST_OUTPUT) {
    authorizedOrigin = event.origin;
    dispatchBridgeEvent('handshake-complete', { origin: authorizedOrigin, implicit: true });
    flushOutboundQueue();
    scheduleHostFallbackCheck();
  }

  if (event.origin !== authorizedOrigin) {
    sendErrorToHost(ERROR_CODES.UNAUTHORIZED_ORIGIN, 'Origin not authorized', { originTried: event.origin }, data.requestId);
    return;
  }

  const [hostMajor] = String(data.version || PROTOCOL_VERSION).split('.');
  const [ourMajor] = PROTOCOL_VERSION.split('.');
  if (hostMajor !== ourMajor) {
    sendErrorToHost(
      ERROR_CODES.UNSUPPORTED_VERSION,
      `Unsupported protocol version: ${data.version}`,
      { expected: PROTOCOL_VERSION },
      data.requestId
    );
    return;
  }

  try {
    switch (data.type) {
      case MESSAGE_TYPES.HOST_OUTPUT:
        handleHostOutput(data);
        break;
      case MESSAGE_TYPES.PING: {
        const pongMessage = createMessage(MESSAGE_TYPES.PONG, { timestamp: Date.now() }, data.requestId);
        sendToHost(pongMessage);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    sendErrorToHost(
      ERROR_CODES.PROCESSING_ERROR,
      'Failed to process host message',
      { message: error.message, stack: error.stack },
      data.requestId
    );
  }
}

function applyInitialUrlOverrides() {
  if (!HAS_WINDOW || urlOverridesApplied) return;
  const patch = getInitialStateFromURL();
  urlOverridesApplied = true;
  if (!patch) return;
  applySessionPatch(patch, { source: patch.source || 'url', emitPreview: false, notifyHost: false });
}

function initIFrameBridge(options = {}) {
  if (!HAS_WINDOW) return () => {};

  config.debounceMs = Number.isFinite(options.debounceMs) ? Number(options.debounceMs) : config.debounceMs;
  if (Number.isFinite(options.hostCommandTimeoutMs) && options.hostCommandTimeoutMs >= 0) {
    config.hostCommandTimeoutMs = options.hostCommandTimeoutMs;
  }

  applyInitialUrlOverrides();

  const onMessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type) {
      handleHostMessage(event);
    }
  };

  const onSyncBridgeEvent = () => {
    schedulePreview();
  };

  window.addEventListener('message', onMessage);
  // Subscribe to the conductor's session surface instead of the (now-removed) window
  // sync CustomEvents; both bpm + status changes still re-schedule the embed preview.
  const syncBridgeUnsubs = [
    syncCoordinator.onBpmChange(onSyncBridgeEvent),
    syncCoordinator.onStatusChange(onSyncBridgeEvent),
  ];

  if (Number.isFinite(options.handshakeWarnMs) && options.handshakeWarnMs > 0) {
    handshakeWatchdogTimer = setTimeout(() => {
      if (!authorizedOrigin) {
        dispatchBridgeEvent('handshake-pending', { queued: outboundQueue.length });
      }
    }, options.handshakeWarnMs);
  }

  dispatchBridgeEvent('bridge-ready', { session: cloneSession(sessionState) });
  scheduleHostFallbackCheck();

  return () => {
    window.removeEventListener('message', onMessage);
    syncBridgeUnsubs.forEach((unsub) => unsub?.());
    if (handshakeWatchdogTimer) {
      clearTimeout(handshakeWatchdogTimer);
      handshakeWatchdogTimer = null;
    }
    if (hostCommandTimer) {
      clearTimeout(hostCommandTimer);
      hostCommandTimer = null;
    }
  };
}

function getInitialStateFromURL() {
  if (!HAS_WINDOW) return null;
  const params = new URLSearchParams(window.location.search || '');
  const descriptor = {};

  Object.entries(DESCRIPTOR_ALIASES).forEach(([key, aliases]) => {
    for (const alias of aliases) {
      if (params.has(alias)) {
        descriptor[key] = sanitizeId(params.get(alias));
        break;
      }
    }
  });

  if (!Object.keys(descriptor).length) {
    return null;
  }

  return {
    requested: descriptor,
    source: 'url',
    status: 'loading',
  };
}

function getOrbiterSession() {
  return cloneSession(sessionState);
}

function setOrbiterSession(descriptor = {}, { resolved, source = 'session-set', status, errors, emitPreview = true, notifyHost = true, requestId = null } = {}) {
  const patch = {
    requested: descriptor,
    resolved,
    status,
    errors,
    source,
  };
  const { session } = applySessionPatch(patch, { source, emitPreview, notifyHost, requestId });
  return session;
}

function updateOrbiterSession(partial = {}, { source = 'session-update', status, errors, emitPreview = false, notifyHost = true, requestId = null } = {}) {
  const patch = {
    ...partial,
    status: status !== undefined ? status : partial.status,
    errors: errors !== undefined ? errors : partial.errors,
    source,
  };
  const { session } = applySessionPatch(patch, { source, emitPreview, notifyHost, requestId });
  return session;
}

function resolveOrbiterSession(resolution = {}, { source = 'session-resolution', status = 'resolved', errors, resolutionPayload = null, emitPreview = true, notifyHost = true, requestId = null } = {}) {
  const patch = {
    resolved: resolution,
    status,
    errors,
    source,
  };
  const { session } = applySessionPatch(patch, {
    source,
    emitPreview,
    notifyHost,
    resolution: resolutionPayload ?? resolution,
    requestId,
  });
  return session;
}

function consumePendingOrbiterSession() {
  const clone = deepClone(pendingOrbiterSession);
  pendingOrbiterSession = null;
  if (clone) {
    suppressEditEcho = true;
    lastHostOrbiterSession = deepClone(clone);
  }
  return clone;
}

function shouldEmitEditUpdate(payload) {
  if (!suppressEditEcho) return true;
  suppressEditEcho = false;
  if (!payload || !lastHostOrbiterSession) return true;
  try {
    const incoming = JSON.stringify(payload);
    const last = JSON.stringify(lastHostOrbiterSession);
    return incoming !== last;
  } catch {
    return true;
  } finally {
    lastHostOrbiterSession = null;
  }
}

function scheduleHostFallbackCheck() {
  if (!SHOULD_EXPECT_HOST_COMMAND || hostCommandObserved) return;
  if (hostCommandTimer) return;
  if (config.hostCommandTimeoutMs <= 0) return;
  hostCommandTimer = setTimeout(() => {
    hostCommandTimer = null;
    if (hostCommandObserved) return;
    hostCommandObserved = true;
    const descriptor = {
      trackId: sessionState?.requested?.trackId || DEFAULT_EDIT_TRACK_ID,
      orbiterId: sessionState?.requested?.orbiterId ?? null,
      entangledWorldId: sessionState?.requested?.entangledWorldId ?? null,
    };
    const session = setOrbiterSession(descriptor, {
      source: 'host-timeout',
      notifyHost: false,
      emitPreview: true,
    });
    dispatchBridgeEvent('host-timeout', { session: cloneSession(session), descriptor });
  }, config.hostCommandTimeoutMs);
}

/**
 * The host origin established by the bridge handshake, or null before (or without) one.
 * Senders of sensitive payloads must target this origin — never `'*'`.
 */
export function getAuthorizedHostOrigin() {
  return authorizedOrigin || null;
}

export {
  initIFrameBridge,
  getInitialStateFromURL,
  getOrbiterSession,
  setOrbiterSession,
  updateOrbiterSession,
  resolveOrbiterSession,
  consumePendingOrbiterSession,
  shouldEmitEditUpdate,
  setOrbiterPlaybackBridge,
  sendPlaybackTimeToHost,
  sendErrorToHost,
  MESSAGE_TYPES,
  ERROR_CODES,
};

if (HAS_WINDOW && !window.__ORBITERS_IFRAME_BRIDGE_INITED && !window.EW_NO_AUTO_BRIDGE) {
  window.__ORBITERS_IFRAME_BRIDGE_INITED = true;
  try {
    initIFrameBridge();
  } catch (error) {
    console.error('[Orbiters Bridge] auto init failed', error);
  }
}
