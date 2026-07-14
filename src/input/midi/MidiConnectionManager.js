/**
 * @file src/input/midi/MidiConnectionManager.js
 * @description Wraps the Web MIDI API to track available inputs/outputs, normalizes events,
 * and exposes subscribe/disconnect helpers for the higher-level MIDI controller layer.
 */
const MIDI_MESSAGE_TYPES = {
  0x80: 'noteOff',
  0x90: 'noteOn',
  0xA0: 'aftertouch',
  0xB0: 'cc',
  0xC0: 'programChange',
  0xD0: 'channelPressure',
  0xE0: 'pitchBend',
};

function getTimestamp(event) {
  if (event && typeof event.timeStamp === 'number') {
    return event.timeStamp;
  }
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export class MidiConnectionManager {
  constructor() {
    this.midiAccess = null;
    this._inputHandlers = new Map();
    this._messageHandlers = new Set();
    this._stateHandlers = new Set();
    this._connectedInputs = [];
    this._connectedOutputs = [];
    this._handleStateChange = this._handleStateChange.bind(this);
  }

  /**
   * Ensure Web MIDI access is available and wire up listeners.
   * @returns {Promise<MIDIAccess>}
   */
  async ensureAccess() {
    if (this.midiAccess) {
      return this.midiAccess;
    }

    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      throw new Error('Web MIDI API not supported');
    }

    this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    this.midiAccess.onstatechange = this._handleStateChange;
    this._syncPorts();
    this._bindInputs();
    return this.midiAccess;
  }

  /**
   * Register a MIDI message handler.
   * @param {(payload: MidiMessagePayload) => void} handler
   * @returns {() => void} unsubscribe
   */
  onMessage(handler) {
    if (typeof handler !== 'function') {
      return () => {};
    }
    this._messageHandlers.add(handler);
    return () => {
      this._messageHandlers.delete(handler);
    };
  }

  /**
   * Register for state change notifications.
   * @param {(payload: MidiPortStatePayload) => void} handler
   * @returns {() => void} unsubscribe
   */
  onStateChange(handler) {
    if (typeof handler !== 'function') {
      return () => {};
    }
    this._stateHandlers.add(handler);
    return () => {
      this._stateHandlers.delete(handler);
    };
  }

  getConnectedInputs() {
    return [...this._connectedInputs];
  }

  getConnectedOutputs() {
    return [...this._connectedOutputs];
  }

  sendControlChange({ outputId = null, channel = 0, cc, value }) {
    if (!this.midiAccess) {
      console.warn('[MidiConnectionManager] Cannot send CC: MIDI access not available.');
      return false;
    }
    const normalizedChannel = Math.min(15, Math.max(0, Number(channel) || 0));
    const normalizedCc = Math.min(127, Math.max(0, Number(cc)));
    const normalizedValue = Math.min(127, Math.max(0, Number(value)));
    const statusByte = 0xB0 | normalizedChannel;
    const payload = new Uint8Array([statusByte, normalizedCc, normalizedValue]);

    const outputs = Array.from(this.midiAccess.outputs.values());
    const targets = outputId
      ? outputs.filter((out) => out?.id === outputId)
      : outputs;

    let sent = false;
    targets.forEach((output) => {
      try {
        output?.send?.(payload);
        sent = true;
      } catch (error) {
        console.warn('[MidiConnectionManager] Failed to send CC message:', error);
      }
    });
    return sent;
  }

  dispose() {
    this._messageHandlers.clear();
    this._stateHandlers.clear();
    if (this.midiAccess) {
      this.midiAccess.onstatechange = null;
    }
    this._inputHandlers.forEach((handler, input) => {
      if (input && input.onmidimessage === handler) {
        input.onmidimessage = null;
      }
    });
    this._inputHandlers.clear();
    this.midiAccess = null;
  }

  _handleStateChange(event) {
    this._syncPorts();
    this._bindInputs();
    const payload = this._buildStatePayload(event);
    this._stateHandlers.forEach((handler) => {
      try {
        handler(payload, event);
      } catch (error) {
        console.warn('[MidiConnectionManager] State handler failed:', error);
      }
    });
  }

  _bindInputs() {
    if (!this.midiAccess) {
      return;
    }
    const seen = new Set();
    for (const input of this.midiAccess.inputs.values()) {
      if (!input) {
        continue;
      }
      seen.add(input.id);
      if (this._inputHandlers.has(input)) {
        continue;
      }
      const handler = (event) => this._emitMessage(input, event);
      input.onmidimessage = handler;
      this._inputHandlers.set(input, handler);
    }

    // Clean up detached inputs
    this._inputHandlers.forEach((handler, input) => {
      if (!seen.has(input.id)) {
        if (input.onmidimessage === handler) {
          input.onmidimessage = null;
        }
        this._inputHandlers.delete(input);
      }
    });
  }

  _syncPorts() {
    if (!this.midiAccess) {
      this._connectedInputs = [];
      this._connectedOutputs = [];
      return;
    }
    this._connectedInputs = this._collectPortInfo(this.midiAccess.inputs);
    this._connectedOutputs = this._collectPortInfo(this.midiAccess.outputs);
  }

  _collectPortInfo(collection) {
    const result = [];
    if (!collection || typeof collection.values !== 'function') {
      return result;
    }
    for (const port of collection.values()) {
      if (!port) continue;
      result.push({
        id: port.id,
        name: port.name || null,
        manufacturer: port.manufacturer || null,
        state: port.state || null,
        connection: port.connection || null,
        type: port.type || null,
      });
    }
    return result;
  }

  _emitMessage(input, event) {
    const payload = this._normalizeMessage(input, event);
    this._messageHandlers.forEach((handler) => {
      try {
        handler(payload);
      } catch (error) {
        console.warn('[MidiConnectionManager] Message handler failed:', error);
      }
    });
  }

  _normalizeMessage(input, event) {
    const data = Array.isArray(event?.data) ? event.data : Array.from(event?.data ?? []);
    const [status = 0, data1 = 0, data2 = 0] = data;
    const channel = status & 0x0f;
    const typeByte = status & 0xf0;
    const type = MIDI_MESSAGE_TYPES[typeByte] || 'unknown';

    return {
      rawEvent: event,
      sourceId: input?.id || event?.target?.id || null,
      channel,
      type,
      data: {
        status,
        data1,
        data2,
        bytes: data,
      },
      input: {
        id: input?.id || null,
        name: input?.name || event?.target?.name || null,
        manufacturer: input?.manufacturer || event?.target?.manufacturer || null,
      },
      timestamp: getTimestamp(event),
    };
  }

  _buildStatePayload(event) {
    const port = event?.port;
    if (!port) {
      return {
        id: null,
        type: null,
        state: null,
        connection: null,
        name: null,
        manufacturer: null,
        rawEvent: event,
      };
    }
    return {
      id: port.id,
      type: port.type,
      state: port.state,
      connection: port.connection,
      name: port.name || null,
      manufacturer: port.manufacturer || null,
      rawEvent: event,
    };
  }
}

/**
 * @typedef {Object} MidiMessagePayload
 * @property {string|null} sourceId
 * @property {number} channel
 * @property {string} type
 * @property {{status:number,data1:number,data2:number,bytes:number[]}} data
 * @property {{id:string|null,name:string|null,manufacturer:string|null}} input
 * @property {MIDIMessageEvent} rawEvent
 * @property {number} timestamp
 */

/**
 * @typedef {Object} MidiPortStatePayload
 * @property {string|null} id
 * @property {'input'|'output'|null} type
 * @property {string|null} state
 * @property {string|null} connection
 * @property {string|null} name
 * @property {string|null} manufacturer
 * @property {MIDIConnectionEvent} rawEvent
 */
