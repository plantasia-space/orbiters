import {
  getLocalSensorChannelName,
  getLocalSensorInstanceId,
  getLocalSensorSessionKey,
} from './localSensorIdentity.js';

const DEFAULT_HEARTBEAT_STALE_MS = 3000;

function nowMs() {
  return Date.now();
}

export class LocalSensorRegistry {
  #instanceId;
  #sessionKey;
  #channelName;
  #channel = null;
  #sources = new Map();
  #sourcesChangedCallbacks = new Set();
  #staleMs;
  #sweepIntervalId = null;
  #connected = false;

  constructor({
    instanceId = getLocalSensorInstanceId(),
    sessionKey = getLocalSensorSessionKey(),
    staleMs = DEFAULT_HEARTBEAT_STALE_MS,
  } = {}) {
    this.#instanceId = instanceId;
    this.#sessionKey = sessionKey;
    this.#channelName = getLocalSensorChannelName(sessionKey);
    this.#staleMs = staleMs;
  }

  get instanceId() {
    return this.#instanceId;
  }

  get sessionKey() {
    return this.#sessionKey;
  }

  get isSupported() {
    return typeof BroadcastChannel !== 'undefined';
  }

  connect() {
    if (this.#connected) return this.isSupported;
    if (!this.isSupported) return false;

    this.#channel = new BroadcastChannel(this.#channelName);
    this.#channel.onmessage = (event) => this.#onMessage(event?.data);
    this.#connected = true;

    this.#broadcast({
      type: 'sensor:hello',
      instanceId: this.#instanceId,
      joinedAt: nowMs(),
    });

    this.#sweepIntervalId = setInterval(() => this.#removeStaleSources(), Math.max(500, Math.floor(this.#staleMs / 2)));
    return true;
  }

  destroy() {
    if (!this.#connected) return;

    clearInterval(this.#sweepIntervalId);
    this.#sweepIntervalId = null;

    this.#broadcast({
      type: 'sensor:bye',
      instanceId: this.#instanceId,
    });

    this.#channel?.close();
    this.#channel = null;
    this.#sources.clear();
    this.#connected = false;
  }

  getAvailableSources() {
    this.#removeStaleSources();
    return Array.from(this.#sources.values())
      .filter((source) => source.status === 'connected')
      .sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0));
  }

  onSourcesChanged(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }
    this.#sourcesChangedCallbacks.add(callback);
    callback(this.getAvailableSources());
    return () => {
      this.#sourcesChangedCallbacks.delete(callback);
    };
  }

  publishOwnerConnected(sourceMeta = {}) {
    const payload = {
      type: 'sensor:owner-state',
      instanceId: this.#instanceId,
      sourceId: sourceMeta.sourceId,
      status: 'connected',
      connectedAt: sourceMeta.connectedAt ?? nowMs(),
      label: sourceMeta.label ?? 'Mobile sensor',
      pairingInfo: sourceMeta.pairingInfo ?? null,
    };
    this.#upsertSource(payload);
    this.#broadcast(payload);
  }

  publishOwnerDisconnected(sourceId) {
    if (!sourceId) return;
    const existing = this.#sources.get(sourceId);
    const payload = {
      type: 'sensor:owner-state',
      instanceId: this.#instanceId,
      sourceId,
      status: 'disconnected',
      connectedAt: existing?.connectedAt ?? null,
      label: existing?.label ?? 'Mobile sensor',
      pairingInfo: existing?.pairingInfo ?? null,
    };
    this.#sources.delete(sourceId);
    this.#emitSourcesChanged();
    this.#broadcast(payload);
  }

  publishHeartbeat(sourceId) {
    if (!sourceId) return;
    const ts = nowMs();
    const existing = this.#sources.get(sourceId);
    if (existing) {
      existing.lastHeartbeatAt = ts;
      this.#sources.set(sourceId, existing);
    }
    this.#broadcast({
      type: 'sensor:heartbeat',
      instanceId: this.#instanceId,
      sourceId,
      ts,
    });
  }

  #broadcast(message) {
    try {
      this.#channel?.postMessage(message);
    } catch (_) {
      // Ignore channel write failures.
    }
  }

  #onMessage(message) {
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'sensor:hello':
        if (message.instanceId !== this.#instanceId) {
          this.#broadcast({
            type: 'sensor:present',
            instanceId: this.#instanceId,
            joinedAt: nowMs(),
          });
          this.#rebroadcastOwnedSources();
        }
        break;
      case 'sensor:present':
        break;
      case 'sensor:owner-state':
        this.#handleOwnerState(message);
        break;
      case 'sensor:heartbeat':
        this.#handleHeartbeat(message);
        break;
      case 'sensor:bye':
        this.#handleBye(message);
        break;
      default:
        break;
    }
  }

  #handleOwnerState(message) {
    if (!message.sourceId) return;

    if (message.status === 'connected') {
      this.#upsertSource(message);
      return;
    }

    if (message.status === 'disconnected') {
      const deleted = this.#sources.delete(message.sourceId);
      if (deleted) this.#emitSourcesChanged();
    }
  }

  #handleHeartbeat(message) {
    if (!message.sourceId) return;
    const existing = this.#sources.get(message.sourceId);
    if (!existing) return;
    existing.lastHeartbeatAt = Number(message.ts) || nowMs();
    this.#sources.set(message.sourceId, existing);
  }

  #handleBye(message) {
    if (!message.instanceId) return;
    let changed = false;
    this.#sources.forEach((source, sourceId) => {
      if (source.ownerInstanceId === message.instanceId) {
        this.#sources.delete(sourceId);
        changed = true;
      }
    });
    if (changed) this.#emitSourcesChanged();
  }

  #upsertSource(message) {
    const sourceId = message.sourceId;
    const next = {
      sourceId,
      ownerInstanceId: message.instanceId,
      status: message.status ?? 'connected',
      connectedAt: Number(message.connectedAt) || nowMs(),
      lastHeartbeatAt: nowMs(),
      label: typeof message.label === 'string' && message.label ? message.label : 'Mobile sensor',
      pairingInfo: typeof message.pairingInfo === 'string' && message.pairingInfo ? message.pairingInfo : null,
    };

    const previous = this.#sources.get(sourceId);
    this.#sources.set(sourceId, {
      ...previous,
      ...next,
    });
    this.#emitSourcesChanged();
  }

  #removeStaleSources() {
    const cutoff = nowMs() - this.#staleMs;
    let changed = false;
    this.#sources.forEach((source, sourceId) => {
      if ((source.lastHeartbeatAt || 0) < cutoff) {
        this.#sources.delete(sourceId);
        changed = true;
      }
    });
    if (changed) this.#emitSourcesChanged();
  }

  #rebroadcastOwnedSources() {
    this.#sources.forEach((source) => {
      if (!source || source.ownerInstanceId !== this.#instanceId || source.status !== 'connected') {
        return;
      }
      this.#broadcast({
        type: 'sensor:owner-state',
        instanceId: this.#instanceId,
        sourceId: source.sourceId,
        status: 'connected',
        connectedAt: source.connectedAt ?? nowMs(),
        label: source.label ?? 'Mobile sensor',
        pairingInfo: source.pairingInfo ?? null,
      });
      this.#broadcast({
        type: 'sensor:heartbeat',
        instanceId: this.#instanceId,
        sourceId: source.sourceId,
        ts: source.lastHeartbeatAt ?? nowMs(),
      });
    });
  }

  #emitSourcesChanged() {
    const snapshot = this.getAvailableSources();
    this.#sourcesChangedCallbacks.forEach((callback) => {
      try {
        callback(snapshot);
      } catch (_) {
        // Ignore callback failures.
      }
    });
  }
}
