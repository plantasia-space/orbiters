import {
  postPlatformEvents,
} from '../api/platformEventsClient.js';

const SURFACE = 'orbiter';
const FLUSH_INTERVAL_MS = 15000;
const MAX_BATCH_SIZE = 20;
const MIN_PLAY_DURATION_MS = 500;
const GPC_ALLOWED_EVENT_KEYS = new Set(['ORBITER_SESSION_FAILED']);

const COMMON_EVENT_FIELD_KEYS = new Set([
  'mode',
  'eventSessionId',
  'playSegmentId',
  'trackId',
  'orbiterReleaseId',
  'orbiterVersion',
  'worldId',
  'source',
  'hostCategory',
  'cached',
  'durationBucket',
  'playDurationBucket',
  'playDurationSeconds',
  'elapsedBucket',
  'assetCountBucket',
  'errorCode',
  'stage',
  'decodeStrategy',
  'quantized',
  'loopEnabled',
  'reason',
  'completed',
  'played',
  'method',
  'infoType',
]);

const EVENT_PROPERTY_ALLOWLIST = {
  ORBITER_VIEWED: new Set(['trackId', 'eventSessionId', 'mode', 'source', 'orbiterReleaseId']),
  ORBITER_EMBED_VIEWED: new Set(['hostCategory', 'trackId', 'eventSessionId', 'source']),
  ORBITER_SESSION_STARTED: new Set(['eventSessionId', 'trackId', 'mode', 'source', 'cached']),
  ORBITER_SESSION_FAILED: new Set(['source', 'errorCode', 'stage', 'trackId']),
  ORBITER_SESSION_ENDED: new Set(['eventSessionId', 'played', 'durationBucket', 'playDurationBucket']),
  ORBITER_PLAY_STARTED: new Set(['eventSessionId', 'playSegmentId', 'trackId', 'decodeStrategy', 'quantized', 'loopEnabled']),
  ORBITER_PLAY_PAUSED: new Set(['trackId', 'elapsedBucket', 'reason']),
  ORBITER_PLAY_STOPPED: new Set(['trackId', 'elapsedBucket', 'reason']),
  ORBITER_PLAY_COMPLETED: new Set(['trackId', 'durationBucket']),
  ORBITER_PLAYBACK_SUMMARY: new Set(['trackId', 'eventSessionId', 'playSegmentId', 'playDurationBucket', 'playDurationSeconds', 'completed', 'loopEnabled']),
  ORBITER_SHARE_CLICKED: new Set(['trackId', 'method']),
  ORBITER_INFO_PANEL_VIEWED: new Set(['infoType', 'trackId', 'worldId', 'orbiterReleaseId']),
};

const EVENT_REQUIRED_FIELDS = {
  ORBITER_SESSION_FAILED: ['errorCode'],
  ORBITER_SESSION_ENDED: ['durationBucket'],
  ORBITER_PLAY_STARTED: ['trackId', 'eventSessionId', 'playSegmentId'],
  ORBITER_PLAY_PAUSED: ['trackId'],
  ORBITER_PLAY_STOPPED: ['trackId'],
  ORBITER_PLAY_COMPLETED: ['trackId'],
  ORBITER_PLAYBACK_SUMMARY: ['trackId', 'eventSessionId', 'playSegmentId', 'playDurationBucket', 'playDurationSeconds'],
  ORBITER_INFO_PANEL_VIEWED: ['infoType'],
};

const IMMEDIATE_FLUSH_EVENT_KEYS = new Set([
  'ORBITER_SESSION_STARTED',
  'ORBITER_VIEWED',
  'ORBITER_EMBED_VIEWED',
  'ORBITER_SESSION_FAILED',
  'ORBITER_PLAY_STARTED',
  'ORBITER_INFO_PANEL_VIEWED',
]);

function getNowMs() {
  return typeof Date !== 'undefined' ? Date.now() : 0;
}

function sanitizeId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function createObjectIdString() {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function sanitizeBoolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function sanitizeEnum(value, allowed) {
  if (typeof value !== 'string') {
    return undefined;
  }
  return allowed.has(value) ? value : undefined;
}

function toDurationBucket(durationMs) {
  const seconds = Number(durationMs) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return '0-10s';
  if (seconds < 10) return '0-10s';
  if (seconds < 30) return '10-30s';
  if (seconds < 60) return '30-60s';
  if (seconds < 180) return '1-3m';
  if (seconds < 600) return '3-10m';
  return '10m+';
}

function clampPlayDurationSeconds(durationMs) {
  const seconds = Number(durationMs) / 1000;
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(86400, Math.max(0, Math.round(seconds * 10) / 10));
}

function normalizeSource(source) {
  const value = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (!value) return undefined;
  if (value.includes('direct') || value.includes('hydrated-url')) return 'direct_payload';
  if (value.includes('host')) return 'host';
  if (value.includes('url')) return 'url';
  if (value.includes('api')) return 'api';
  if (value.includes('fallback')) return 'fallback';
  return undefined;
}

function normalizeStage(source) {
  const value = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (!value) return undefined;
  if (value.includes('audio') || value.includes('decode')) return 'audio_init';
  if (value.includes('asset')) return 'asset_resolve';
  if (value.includes('playback-session') || value.includes('session')) return 'session_start';
  if (value.includes('fetch') || value.includes('url') || value.includes('api')) return 'config_fetch';
  return 'config_fetch';
}

function normalizeErrorCode(error, status = null) {
  if (Number(status) === 401 || Number(status) === 403) return 'unauthorized';
  if (Number(status) === 404) return 'not_found';
  const message = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  if (message.includes('not found') || message.includes('404')) return 'not_found';
  if (message.includes('unauthorized') || message.includes('forbidden')) return 'unauthorized';
  if (message.includes('asset')) return 'asset_load_failed';
  if (message.includes('audio') || message.includes('decode')) return 'audio_load_failed';
  if (message.includes('orbiter') || message.includes('release')) return 'release_missing';
  if (message.includes('session')) return 'session_resolution_failed';
  return 'unknown';
}

function isEmbeddedFrame() {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
  return true;
  }
}

function collectAllowedEventFields(eventKey, properties = {}) {
  const eventAllowlist = EVENT_PROPERTY_ALLOWLIST[eventKey] || COMMON_EVENT_FIELD_KEYS;
  const sanitized = {};
  Object.entries(properties).forEach(([key, value]) => {
    if (!COMMON_EVENT_FIELD_KEYS.has(key) || !eventAllowlist.has(key) || value == null) {
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        sanitized[key] = trimmed;
      }
      return;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      sanitized[key] = value;
    }
  });
  return sanitized;
}

function hasRequiredEventFields(eventKey, event) {
  const requiredFields = EVENT_REQUIRED_FIELDS[eventKey];
  if (!Array.isArray(requiredFields) || !requiredFields.length) {
    return true;
  }

  return requiredFields.every((field) => {
    const value = event?.properties?.[field];
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }
    return value != null;
  });
}

export class OrbitersUsageEventsClient {
  constructor({ mode = 'play', getEngine = null } = {}) {
    this.mode = mode === 'edit' ? 'edit' : 'play';
    this.getEngine = typeof getEngine === 'function' ? getEngine : () => null;
    this.embedContext = isEmbeddedFrame() ? 'embedded' : 'standalone';
    this.gpcEnabled = Boolean(
      typeof navigator !== 'undefined' && navigator?.globalPrivacyControl === true,
    );

    this.queue = [];
    this.flushTimer = null;
    this.flushTimerDelayMs = null;
    this.flushInFlight = null;
    this.ended = false;
    this.dedupe = new Set();

    this.context = {
      surfaceId: null,
      eventSessionId: createObjectIdString(),
      trackId: null,
      worldId: null,
      orbiterReleaseId: null,
      orbiterVersion: null,
      source: undefined,
      cached: undefined,
      hostCategory: undefined,
    };

    this.session = {
      startedAtMs: null,
      ended: false,
      hasPlayed: false,
      totalPlayMs: 0,
    };
    this.activeSessionKey = null;

    this.playback = {
      state: 'stopped',
      currentPlaySegmentId: null,
      segmentStartedAtMs: null,
      accumulatedPlayingMs: 0,
      hasCompletedCurrentSegment: false,
      loopEnabled: false,
      decodeStrategy: undefined,
      quantized: undefined,
      completed: false,
    };
    this.summarizedPlaySegmentIds = new Set();

    this._boundVisibilityChange = this._handleVisibilityChange.bind(this);
    this._boundPageHide = this._handlePageHide.bind(this);
    this._boundShareClicked = this._handleShareClicked.bind(this);
    this._boundInfoPanelViewed = this._handleInfoPanelViewed.bind(this);
    this._boundLoopToggle = this._handleLoopToggle.bind(this);
  }

  start() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._boundVisibilityChange, { passive: true });
      document.addEventListener('ui:loop-toggle', this._boundLoopToggle);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this._boundPageHide, { passive: true });
      window.addEventListener('orbiters:share-clicked', this._boundShareClicked);
      window.addEventListener('orbiters:info-panel-viewed', this._boundInfoPanelViewed);
    }
  }

  dispose() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._boundVisibilityChange);
      document.removeEventListener('ui:loop-toggle', this._boundLoopToggle);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._boundPageHide);
      window.removeEventListener('orbiters:share-clicked', this._boundShareClicked);
      window.removeEventListener('orbiters:info-panel-viewed', this._boundInfoPanelViewed);
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flushTimerDelayMs = null;
    }
  }

  updateContext(detail = {}) {
    const resolution = detail?.resolution || {};
    const combined = resolution?.combined || {};
    const raw = resolution?.raw || detail?.raw || {};
    const descriptor = detail?.descriptor || {};

    this.context.surfaceId =
      sanitizeId(combined?.orbiter?.orbiterId) ||
      sanitizeId(resolution?.orbiter?.orbiterId) ||
      sanitizeId(resolution?.debug?.resolved?.orbiterId) ||
      this.context.surfaceId;
    this.context.trackId =
      sanitizeId(combined?.track?.trackId) ||
      sanitizeId(resolution?.track?.trackId) ||
      sanitizeId(resolution?.debug?.resolved?.trackId) ||
      this.context.trackId;
    this.context.worldId =
      sanitizeId(combined?.entangledWorld?.worldId) ||
      sanitizeId(resolution?.entangledWorld?.worldId) ||
      sanitizeId(resolution?.debug?.resolved?.entangledWorldId) ||
      this.context.worldId;
    this.context.orbiterReleaseId =
      sanitizeId(raw?.orbiterReleaseId) ||
      sanitizeId(raw?.orbiterRelease?._id) ||
      this.context.orbiterReleaseId;
    this.context.orbiterVersion =
      sanitizeId(combined?.orbiter?.version) ||
      sanitizeId(resolution?.orbiter?.version) ||
      sanitizeId(descriptor?.orbiterVersion) ||
      sanitizeId(raw?.orbiterVersion) ||
      this.context.orbiterVersion;
    this.context.source = normalizeSource(detail?.source) || this.context.source;
    this.context.cached =
      typeof detail?.cached === 'boolean' ? detail.cached : this.context.cached;
    this.context.hostCategory =
      sanitizeEnum(detail?.hostCategory || raw?.hostCategory, new Set([
        'plantasia',
        'creator_site',
        'partner',
        'unknown',
      ])) || this.context.hostCategory;
  }

  handleSessionReady(detail = {}) {
    this.updateContext(detail);
    const nextSessionKey = this.context.surfaceId || this.context.trackId;
    if (this.activeSessionKey !== nextSessionKey) {
      this.activeSessionKey = nextSessionKey;
      this.context.eventSessionId = createObjectIdString();
      this.session.startedAtMs = null;
      this.session.ended = false;
      this.session.hasPlayed = false;
      this.session.totalPlayMs = 0;
      this.summarizedPlaySegmentIds.clear();
      this.playback.currentPlaySegmentId = null;
      this.playback.segmentStartedAtMs = null;
      this.playback.accumulatedPlayingMs = 0;
      this.playback.hasCompletedCurrentSegment = false;
      this.playback.loopEnabled = false;
      this.playback.completed = false;
      this.playback.state = 'stopped';
    }

    if (!this.session.startedAtMs) {
      this.session.startedAtMs = getNowMs();
      this.session.ended = false;
    }

    const sessionDedupeKey = this.context.eventSessionId || this.context.trackId || this.context.surfaceId;
    if (sessionDedupeKey) {
      this.track('ORBITER_SESSION_STARTED', {
        eventSessionId: this.context.eventSessionId,
        trackId: this.context.trackId,
        source: this.context.source,
        cached: sanitizeBoolean(this.context.cached),
      }, {
        dedupeKey: `session-started:${sessionDedupeKey}`,
      });
    }

    const viewKey = this.embedContext === 'embedded' ? 'ORBITER_EMBED_VIEWED' : 'ORBITER_VIEWED';
    if (this.context.surfaceId) {
      this.track(viewKey, {
        eventSessionId: this.context.eventSessionId,
        trackId: this.context.trackId,
        source: this.context.source,
        orbiterReleaseId: this.context.orbiterReleaseId,
        hostCategory: this.context.hostCategory,
        cached: sanitizeBoolean(this.context.cached),
      }, {
        dedupeKey: `${viewKey}:${this.context.surfaceId}`,
      });
    }
  }

  handleSessionFailed(detail = {}) {
    const status = Number(detail?.status ?? detail?.response?.status ?? NaN);
    const properties = {
      source: normalizeSource(detail?.source),
      errorCode: normalizeErrorCode(detail?.error, Number.isFinite(status) ? status : null),
      stage: normalizeStage(detail?.source),
    };
    this.track('ORBITER_SESSION_FAILED', properties, {
      surfaceId: this.context.surfaceId || undefined,
      trackId: this.context.trackId || undefined,
    });
  }

  handlePlaybackStateChange(payload = {}) {
    if (payload?.transient) {
      this._handleTransientPlaybackState(payload);
      return;
    }

    if (!payload?.stable) {
      return;
    }

    const nextState = payload?.state;
    const previousState = this.playback.state;
    if (!nextState || previousState === nextState) {
      return;
    }

    const engine = this.getEngine();
    const trackId = this.context.trackId || sanitizeId(engine?.trackData?.track?.trackId);
    const surfaceId = this.context.surfaceId;
    const durationMs = Number(engine?.getDurationMs?.() ?? 0);
    const loopEnabled = Boolean(engine?.isLooping?.());
    const decodeStrategy = sanitizeEnum(
      engine?.playback?.getDecodeStrategy?.(),
      new Set(['stream', 'prebuffer', 'stretch']),
    );
    const quantized = payload?.source?.includes('quantized') ? true : undefined;

    this.playback.decodeStrategy = decodeStrategy;
    this.playback.quantized = quantized;

    if (nextState === 'playing' && surfaceId && trackId) {
      this._startPlaySegment({
        loopEnabled,
        decodeStrategy,
        quantized,
        trackId,
      });
    }

    if (previousState === 'playing' && nextState === 'paused' && surfaceId && trackId) {
      this._accumulateActivePlayingTime();
      this.track('ORBITER_PLAY_PAUSED', {
        trackId,
        elapsedBucket: toDurationBucket(this._getCurrentPlayDurationMs()),
        reason: 'user',
      });
      this._finalizeActivePlaySegment({ completed: false });
    }

    if (previousState === 'playing' && nextState === 'stopped' && surfaceId && trackId) {
      this._accumulateActivePlayingTime();
      const completed = payload?.source === 'player-stop';

      if (completed && !this.playback.hasCompletedCurrentSegment) {
        this.playback.hasCompletedCurrentSegment = true;
        this.track('ORBITER_PLAY_COMPLETED', {
          trackId,
          durationBucket: toDurationBucket(durationMs),
        });
      } else if (!completed) {
        this.track('ORBITER_PLAY_STOPPED', {
          trackId,
          elapsedBucket: toDurationBucket(this._getCurrentPlayDurationMs()),
          reason: 'user',
        });
      }

      this._finalizeActivePlaySegment({ completed });
    }

    this.playback.state = nextState;
  }

  _startPlaySegment({ loopEnabled, decodeStrategy, quantized, trackId }) {
    if (this.playback.currentPlaySegmentId && this.playback.state === 'playing') {
      if (!this.playback.segmentStartedAtMs) {
        this.playback.segmentStartedAtMs = getNowMs();
      }
      return;
    }

    if (this.playback.currentPlaySegmentId) {
      this._finalizeActivePlaySegment({ completed: false });
    }

    const playSegmentId = createObjectIdString();
    this.playback.currentPlaySegmentId = playSegmentId;
    this.playback.segmentStartedAtMs = getNowMs();
    this.playback.accumulatedPlayingMs = 0;
    this.playback.hasCompletedCurrentSegment = false;
    this.playback.loopEnabled = Boolean(loopEnabled);
    this.playback.completed = false;

    this.track('ORBITER_PLAY_STARTED', {
      eventSessionId: this.context.eventSessionId,
      playSegmentId,
      trackId,
      decodeStrategy,
      quantized,
      loopEnabled: Boolean(loopEnabled),
    });
  }

  _handleTransientPlaybackState(payload = {}) {
    if (!this.playback.currentPlaySegmentId || this.playback.state !== 'playing') {
      return;
    }

    if (payload?.state === 'buffering') {
      this._accumulateActivePlayingTime();
      return;
    }

    if (!this.playback.segmentStartedAtMs) {
      this.playback.segmentStartedAtMs = getNowMs();
    }
  }

  _accumulateActivePlayingTime() {
    if (!this.playback.segmentStartedAtMs) {
      return;
    }
    const durationMs = Math.max(0, getNowMs() - this.playback.segmentStartedAtMs);
    this.playback.accumulatedPlayingMs += durationMs;
    this.playback.segmentStartedAtMs = null;
  }

  _getCurrentPlayDurationMs() {
    let durationMs = Math.max(0, Number(this.playback.accumulatedPlayingMs) || 0);
    if (this.playback.segmentStartedAtMs) {
      durationMs += Math.max(0, getNowMs() - this.playback.segmentStartedAtMs);
    }
    return Math.min(86400000, durationMs);
  }

  flush({ useBeacon = false } = {}) {
    if (!this.queue.length) {
      return Promise.resolve(false);
    }
    if (this.flushInFlight) {
      return this.flushInFlight.then(() => (
        this.queue.length ? this.flush({ useBeacon }) : true
      ));
    }

    const batch = this.queue.splice(0, this.queue.length);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flushTimerDelayMs = null;
    }

    if (useBeacon) {
      return postPlatformEvents(batch, { keepalive: true })
        .then((response) => {
          if (!response.ok) {
            this.queue.unshift(...batch);
            return false;
          }
          return true;
        })
        .catch(() => {
          this.queue.unshift(...batch);
          return false;
        });
    }

    this.flushInFlight = postPlatformEvents(batch)
      .then((response) => {
        if (!response.ok) {
          this.queue.unshift(...batch);
          return false;
        }
        return true;
      })
      .catch(() => {
        this.queue.unshift(...batch);
        return false;
      })
      .finally(() => {
        this.flushInFlight = null;
      });

    return this.flushInFlight;
  }

  _scheduleFlush(delayMs = FLUSH_INTERVAL_MS) {
    const nextDelay = Math.max(0, Number(delayMs) || 0);
    if (this.flushTimer) {
      if (this.flushTimerDelayMs != null && this.flushTimerDelayMs <= nextDelay) {
        return;
      }
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.flushTimerDelayMs = nextDelay;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushTimerDelayMs = null;
      void this.flush();
    }, nextDelay);
  }

  endSession(reason = 'visibility') {
    if (this.session.ended) {
      return;
    }
    if (this.playback.state === 'playing' && this.context.trackId) {
      this.track('ORBITER_PLAY_STOPPED', {
        trackId: this.context.trackId,
        elapsedBucket: toDurationBucket(this._getCurrentPlayDurationMs()),
        reason,
      });
    }
    this._finalizeActivePlaySegment({ completed: false });
    this.session.ended = true;
    const durationMs = this.session.startedAtMs ? getNowMs() - this.session.startedAtMs : 0;
    this.track('ORBITER_SESSION_ENDED', {
      eventSessionId: this.context.eventSessionId,
      durationBucket: toDurationBucket(durationMs),
      played: this.session.hasPlayed,
      playDurationBucket: this.session.totalPlayMs > 0 ? toDurationBucket(this.session.totalPlayMs) : undefined,
      reason,
    });
  }

  track(eventKey, properties = {}, options = {}) {
    if (!eventKey) {
      return;
    }
    if (this.gpcEnabled && !GPC_ALLOWED_EVENT_KEYS.has(eventKey)) {
      return;
    }
    const surfaceId = options.surfaceId ?? this.context.surfaceId;
    if (!surfaceId && eventKey !== 'ORBITER_SESSION_FAILED') {
      return;
    }
    const dedupeKey = options.dedupeKey;
    if (dedupeKey) {
      if (this.dedupe.has(dedupeKey)) {
        return;
      }
      this.dedupe.add(dedupeKey);
    }

    const mergedFields = collectAllowedEventFields(eventKey, {
      mode: this.mode,
      eventSessionId: options.eventSessionId ?? this.context.eventSessionId,
      trackId: options.trackId ?? this.context.trackId,
      orbiterReleaseId: this.context.orbiterReleaseId,
      orbiterVersion: this.context.orbiterVersion,
      worldId: this.context.worldId,
      source: this.context.source,
      hostCategory: this.context.hostCategory,
      ...properties,
    });

    const event = {
      eventKey,
      surface: SURFACE,
      timestamp: new Date().toISOString(),
      embedContext: this.embedContext,
      properties: mergedFields,
    };

    if (surfaceId) {
      event.surfaceId = surfaceId;
    }

    if (!hasRequiredEventFields(eventKey, event)) {
      console.warn('[OrbitersUsageEvents] Skipping invalid event payload.', {
        eventKey,
        event,
      });
      return;
    }

    this.queue.push(event);
    if (options.flushImmediately || IMMEDIATE_FLUSH_EVENT_KEYS.has(eventKey)) {
      this._scheduleFlush(0);
      return;
    }
    if (this.queue.length >= MAX_BATCH_SIZE) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this._scheduleFlush(FLUSH_INTERVAL_MS);
    }
  }

  _finalizeActivePlaySegment({ completed = false } = {}) {
    const playSegmentId = this.playback.currentPlaySegmentId;
    if (!playSegmentId || !this.context.surfaceId || !this.context.trackId) {
      this.playback.currentPlaySegmentId = null;
      this.playback.segmentStartedAtMs = null;
      this.playback.accumulatedPlayingMs = 0;
      return;
    }

    if (this.summarizedPlaySegmentIds.has(playSegmentId)) {
      this.playback.currentPlaySegmentId = null;
      this.playback.segmentStartedAtMs = null;
      this.playback.accumulatedPlayingMs = 0;
      return;
    }

    this._accumulateActivePlayingTime();
    const durationMs = this._getCurrentPlayDurationMs();
    const playDurationSeconds = clampPlayDurationSeconds(durationMs);
    if (durationMs < MIN_PLAY_DURATION_MS) {
      this.playback.currentPlaySegmentId = null;
      this.playback.accumulatedPlayingMs = 0;
      return;
    }

    this.session.hasPlayed = true;
    this.session.totalPlayMs += durationMs;
    this.playback.completed = Boolean(completed);
    this.summarizedPlaySegmentIds.add(playSegmentId);

    this.track('ORBITER_PLAYBACK_SUMMARY', {
      trackId: this.context.trackId,
      eventSessionId: this.context.eventSessionId,
      playSegmentId,
      playDurationBucket: toDurationBucket(durationMs),
      playDurationSeconds,
      completed,
      loopEnabled: this.playback.loopEnabled,
    });

    this.playback.currentPlaySegmentId = null;
    this.playback.segmentStartedAtMs = null;
    this.playback.accumulatedPlayingMs = 0;
  }

  _handleShareClicked(event) {
    const detail = event?.detail || {};
    const method = sanitizeEnum(detail?.method, new Set(['clipboard', 'prompt', 'native']));
    const trackId = sanitizeId(detail?.trackId) || this.context.trackId;
    if (!trackId) {
      return;
    }
    this.track('ORBITER_SHARE_CLICKED', {
      trackId,
      method,
    });
  }

  _handleInfoPanelViewed(event) {
    const detail = event?.detail || {};
    const infoType = sanitizeEnum(detail?.infoType, new Set(['track', 'orbiter', 'world']));
    if (!infoType) {
      return;
    }

    const properties = { infoType };
    if (infoType === 'track') {
      properties.trackId = sanitizeId(detail?.trackId) || this.context.trackId;
    }
    if (infoType === 'world') {
      properties.worldId = sanitizeId(detail?.worldId) || this.context.worldId;
    }
    if (infoType === 'orbiter') {
      properties.orbiterReleaseId = this.context.orbiterReleaseId;
    }

    this.track('ORBITER_INFO_PANEL_VIEWED', properties);
  }

  _handleLoopToggle(event) {
    const enabled = Boolean(event?.detail?.enabled);
    if (enabled || !this.playback.currentPlaySegmentId) {
      this.playback.loopEnabled = enabled || this.playback.loopEnabled;
    }
  }

  _handleVisibilityChange() {
    if (document.visibilityState !== 'hidden') {
      return;
    }
    this.endSession('visibility');
    void this.flush({ useBeacon: true });
  }

  _handlePageHide() {
    this.endSession('visibility');
    void this.flush({ useBeacon: true });
  }
}

export function createOrbitersUsageEventsClient(options = {}) {
  return new OrbitersUsageEventsClient(options);
}
