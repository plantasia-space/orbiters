import {
  getLocalSensorChannelName,
  getLocalSensorInstanceId,
  getLocalSensorSessionKey,
} from './localSensorIdentity.js';

export class LocalSensorBridge {
  #instanceId;
  #sessionKey;
  #channelName;
  #channel = null;
  #connected = false;
  #frameSubscriptions = new Map();
  #controlSubscriptions = new Map();

  constructor({
    instanceId = getLocalSensorInstanceId(),
    sessionKey = getLocalSensorSessionKey(),
  } = {}) {
    this.#instanceId = instanceId;
    this.#sessionKey = sessionKey;
    this.#channelName = getLocalSensorChannelName(sessionKey);
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
    return true;
  }

  destroy() {
    this.#frameSubscriptions.clear();
    this.#controlSubscriptions.clear();
    this.#channel?.close();
    this.#channel = null;
    this.#connected = false;
  }

  publishFrame(sourceId, payload) {
    if (!sourceId || !payload || typeof payload !== 'object') return false;
    return this.#broadcast({
      type: 'sensor:frame',
      sourceId,
      instanceId: this.#instanceId,
      ts: Date.now(),
      payload: {
        alpha: typeof payload.alpha === 'number' ? payload.alpha : 0,
        beta: typeof payload.beta === 'number' ? payload.beta : 0,
        gamma: typeof payload.gamma === 'number' ? payload.gamma : 0,
      },
    });
  }

  subscribe(sourceId, callback) {
    if (!sourceId || typeof callback !== 'function') {
      return () => {};
    }

    let callbacks = this.#frameSubscriptions.get(sourceId);
    if (!callbacks) {
      callbacks = new Set();
      this.#frameSubscriptions.set(sourceId, callbacks);
    }
    callbacks.add(callback);

    this.#broadcast({
      type: 'sensor:subscribe',
      sourceId,
      instanceId: this.#instanceId,
    });

    return () => this.unsubscribe(sourceId, callback);
  }

  unsubscribe(sourceId, callback) {
    if (!sourceId) return;
    const callbacks = this.#frameSubscriptions.get(sourceId);
    if (!callbacks) return;

    if (typeof callback === 'function') {
      callbacks.delete(callback);
    } else {
      callbacks.clear();
    }

    if (callbacks.size === 0) {
      this.#frameSubscriptions.delete(sourceId);
      this.#broadcast({
        type: 'sensor:unsubscribe',
        sourceId,
        instanceId: this.#instanceId,
      });
    }
  }

  publishControl(sourceId, message) {
    if (!sourceId || !message || typeof message !== 'object') return false;
    return this.#broadcast({
      type: 'sensor:control',
      sourceId,
      instanceId: this.#instanceId,
      ts: Date.now(),
      message,
    });
  }

  subscribeControls(sourceId, callback) {
    if (!sourceId || typeof callback !== 'function') {
      return () => {};
    }

    let callbacks = this.#controlSubscriptions.get(sourceId);
    if (!callbacks) {
      callbacks = new Set();
      this.#controlSubscriptions.set(sourceId, callbacks);
    }
    callbacks.add(callback);

    return () => this.unsubscribeControls(sourceId, callback);
  }

  unsubscribeControls(sourceId, callback) {
    if (!sourceId) return;
    const callbacks = this.#controlSubscriptions.get(sourceId);
    if (!callbacks) return;

    if (typeof callback === 'function') {
      callbacks.delete(callback);
    } else {
      callbacks.clear();
    }

    if (callbacks.size === 0) {
      this.#controlSubscriptions.delete(sourceId);
    }
  }

  #broadcast(message) {
    try {
      this.#channel?.postMessage(message);
      return true;
    } catch (_) {
      return false;
    }
  }

  #onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (!message.sourceId || message.instanceId === this.#instanceId) return;

    if (message.type === 'sensor:frame') {
      const callbacks = this.#frameSubscriptions.get(message.sourceId);
      if (!callbacks || callbacks.size === 0) return;

      callbacks.forEach((callback) => {
        try {
          callback(message.payload, {
            sourceId: message.sourceId,
            ownerInstanceId: message.instanceId,
            timestamp: Number(message.ts) || Date.now(),
          });
        } catch (_) {
          // Ignore subscriber failures.
        }
      });
      return;
    }

    if (message.type === 'sensor:control') {
      const callbacks = this.#controlSubscriptions.get(message.sourceId);
      if (!callbacks || callbacks.size === 0) return;

      callbacks.forEach((callback) => {
        try {
          callback(message.message, {
            sourceId: message.sourceId,
            ownerInstanceId: message.instanceId,
            timestamp: Number(message.ts) || Date.now(),
          });
        } catch (_) {
          // Ignore subscriber failures.
        }
      });
    }
  }
}
