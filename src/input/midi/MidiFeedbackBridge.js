/**
 * @file src/input/midi/MidiFeedbackBridge.js
 * @description Sends parameter changes back to MIDI devices (LED rings, motorized faders) with throttling.
 */
import { MIDI_FEEDBACK_THROTTLE_MS } from '../../config/Constants.js';
import { valueToMidiNorm } from './midiScale.js';

export class MidiFeedbackBridge {
  constructor({
    parameterManager,
    mappingRegistry,
    connectionManager,
    shouldEmit = () => Boolean(window.__ENABLE_MIDI_FEEDBACK),
  }) {
    this.parameterManager = parameterManager;
    this.mappingRegistry = mappingRegistry;
    this.connectionManager = connectionManager;
    this.shouldEmit = shouldEmit;
    this._subscriptions = new Map();
    this._lastSentAt = new Map();
    this._lastMidiValue = new Map();
    this._suppressedParameters = new Map();
  }

  activate() {
    if (!this.parameterManager || !this.parameterManager.parameters) {
      return;
    }
    if (!this.parameterManager?.parameters) {
      return;
    }
    this.parameterManager.parameters.forEach((_param, name) => {
      this._subscribeToParameter(name);
    });
  }

  deactivate() {
    if (this._registerHook && typeof this.parameterManager?.offParameterRegistered === 'function') {
      this.parameterManager.offParameterRegistered(this._registerHook);
    }
    this._subscriptions.forEach((unsubscribe) => unsubscribe?.());
    this._subscriptions.clear();
  }

  _subscribeToParameter(name) {
    if (!name || this._subscriptions.has(name) || typeof this.parameterManager?.subscribe !== 'function') {
      return;
    }
    const controller = {
      onParameterChanged: (_name, value) => {
        this._handleParameterUpdate(name, value);
      },
    };
    this.parameterManager.subscribe(controller, name, Infinity, null);
    const unsubscribe = () => {
      this.parameterManager.unsubscribe(controller, name);
    };
    if (typeof unsubscribe === 'function') {
      this._subscriptions.set(name, unsubscribe);
    }
  }

  _handleParameterUpdate(parameterId, value) {
    if (!this.shouldEmit?.()) {
      return;
    }
    const now = Date.now();
    const suppressedUntil = this._suppressedParameters.get(parameterId);
    if (suppressedUntil) {
      if (suppressedUntil > now) {
        return;
      }
      this._suppressedParameters.delete(parameterId);
    }
    const mappings = this.mappingRegistry.getMappingsForParameter?.(parameterId);
    if (!mappings || !mappings.length) {
      if (window.__ENABLE_MIDI_FEEDBACK && window.__DEBUG_MIDI) {
        console.debug('[MidiFeedbackBridge] No mappings for parameter', parameterId);
      }
      return;
    }
    mappings.forEach((mapping) => {
      // A 'trigger' (kick) binding is a momentary ACTION with no sustained value —
      // there is nothing to echo back to a motorized fader / LED ring, so never emit feedback
      // for it (and skip the throttle/normalize work). Value bindings (kind null) fall through.
      if (mapping.kind === 'trigger') {
        return;
      }
      const throttleKey = mapping.scopedKey;
      const lastSent = this._lastSentAt.get(throttleKey);
      if (lastSent && now - lastSent < MIDI_FEEDBACK_THROTTLE_MS) {
        return;
      }
      const midiValue = this._normalizeToMidi(value, mapping);
      if (Number.isFinite(midiValue)) {
        if (this._lastMidiValue.get(throttleKey) === midiValue) {
          return;
        }
        if (window.__DEBUG_MIDI) {
          console.debug('[MidiFeedbackBridge] sending CC', {
            parameterId,
            mapping,
            midiValue,
          });
        }
        this.connectionManager.sendControlChange({
          outputId: mapping.outputId || null,
          channel: mapping.channel,
          cc: mapping.cc,
          value: midiValue,
        });
        this._lastMidiValue.set(throttleKey, midiValue);
        this._lastSentAt.set(throttleKey, now);
      } else if (window.__DEBUG_MIDI) {
        console.debug('[MidiFeedbackBridge] Unable to normalize value', {
          parameterId,
          value,
          mapping,
        });
      }
    });
  }

  _normalizeToMidi(value, mapping) {
    if (mapping.behavior === 'toggle') {
      return value ? 127 : 0;
    }
    const raw = Number(value);
    if (!Number.isFinite(raw)) {
      return null;
    }
    const param = this.parameterManager?.parameters?.get(mapping.parameterId || mapping.scopedKey);
    if (param) {
      let min = param.min ?? 0;
      let max = param.max ?? 1;
      if (param.isMultidimensional) {
        const dimensionId =
          mapping.dimensionId ||
          this.parameterManager?.getActiveDimension?.() ||
          param.activeDimensionId;
        const dimensionState = dimensionId ? param.dimensions?.get(dimensionId) : null;
        if (dimensionState) {
          min = dimensionState.min ?? min;
          max = dimensionState.max ?? max;
        }
      }
      if (Number.isFinite(min) && Number.isFinite(max) && max !== min) {
        // Honour the param's scale (log for the cosmic freq knob) so motorized/feedback
        // controllers track the knob POSITION, symmetric with the inbound mapping.
        const normalized = valueToMidiNorm(raw, min, max, param.scale);
        if (normalized == null) {
          return null;
        }
        return Math.round(normalized * 127);
      }
    }
    return Math.round(Math.min(1, Math.max(0, raw)) * 127);
  }

  suppressParameter(parameterId, durationMs = MIDI_FEEDBACK_THROTTLE_MS) {
    if (!parameterId) {
      return;
    }
    this._suppressedParameters.set(parameterId, Date.now() + durationMs);
  }
}
