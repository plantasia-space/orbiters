/**
 * @file src/input/midi/MidiMappingPersistence.js
 * @description Bridges the local mapping store with the remote MIDI Learn REST API.
 */
import {
  fetchMidiMappings,
  saveMidiMapping,
  clearMidiMappingRemote,
} from '../../api/midiLearnService.js';
import { makeScopeKey, parseScopeKey } from './scopeKey.js';

export class MidiMappingPersistence {
  constructor({ scopedMidiMap, resolveScope, resolveParameterId, resolveDeviceInfo }) {
    // Persisted bindings live PER SLICE in `ScopedMidiMap` (keyed by scopeKey), not in one
    // flat registry map. Save/clear write into the relevant slice — the scope/entityId pair
    // is the binding's own persistence identity, resolved at learn time.
    this.scopedMidiMap = scopedMidiMap;
    this.resolveScope = resolveScope;
    this.resolveParameterId = resolveParameterId;
    this.resolveDeviceInfo = resolveDeviceInfo;
  }

  /**
   * Load the persisted MIDI mappings for the present slices into `ScopedMidiMap`.
   * Orbiter slices keep their hot-path shape: ONE orbiter present → the request is scoped to
   * it (the backend returns just `orbiters[orbiterId]`); several → one full-tree pull split
   * per orbiter. Collection slices are always scoped single fetches (the studio shows one
   * collection). Every slice load is EPOCH-GUARDED: the epoch is snapshotted before its
   * request starts, and a response that raced a local learn/unmap is discarded — the local
   * write wins (its own save delivers it to the server).
   * @param {string[]} scopeKeys the slices currently live (see scopeKey.js).
   */
  async loadMany(scopeKeys) {
    const parsed = (scopeKeys || [])
      .map((key) => ({ key, ...(parseScopeKey(key) || {}) }))
      .filter((entry) => entry.scope && entry.entityId);
    if (!parsed.length) {
      return;
    }

    const orbiterEntries = parsed.filter((entry) => entry.scope === 'orbiter');
    const otherEntries = parsed.filter((entry) => entry.scope !== 'orbiter');
    const epochs = new Map(parsed.map((entry) => [entry.key, this.scopedMidiMap.epoch(entry.key)]));

    const loads = [];

    if (orbiterEntries.length) {
      loads.push(
        fetchMidiMappings(orbiterEntries.length === 1 ? orbiterEntries[0].entityId : undefined)
          .then((data) => {
            const orbiters = data?.midiLearn?.orbiters || {};
            orbiterEntries.forEach(({ key, entityId }) => {
              this.scopedMidiMap.loadSlice(key, orbiters[entityId], epochs.get(key));
            });
          }),
      );
    }

    // Non-orbiter slices (collection today): one scoped fetch per slice — there is exactly
    // one live collection per studio, so this stays a single request in practice.
    otherEntries.forEach(({ key, scope, entityId }) => {
      loads.push(
        fetchMidiMappings({ scope, entityId }).then((data) => {
          const tree = data?.midiLearn?.[`${scope}s`] || {};
          this.scopedMidiMap.loadSlice(key, tree[entityId], epochs.get(key));
        }),
      );
    });

    // Slices load independently: one failing slice (e.g. a backend that doesn't know the
    // collection scope yet) must never block the OTHERS from hydrating — the failed slice
    // just stays not-loaded and is retried on the next load. Only a total failure rethrows,
    // preserving the caller's single-fetch error handling (auth prompt vs. log).
    const results = await Promise.allSettled(loads);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      if (failures.length === results.length) {
        throw failures[0].reason;
      }
      failures.forEach((result) => {
        console.warn('[MidiMappingPersistence] a mapping slice failed to load:', result.reason?.message || result.reason);
      });
    }
  }

  async saveBinding({ element, identifier, context, midiPayload }) {
    const scopeInfo = this.resolveScope(element, identifier);
    if (!scopeInfo?.scope || !scopeInfo.entityId) {
      throw new Error('Unable to resolve scope for MIDI mapping.');
    }
    const parameterId = this.resolveParameterId(element, identifier);
    if (!parameterId) {
      throw new Error('Unable to resolve parameter id for MIDI mapping.');
    }
    const deviceInfo = this.resolveDeviceInfo(midiPayload.event);
    await saveMidiMapping({
      scope: scopeInfo.scope,
      entityId: scopeInfo.entityId,
      parameterId,
      binding: {
        deviceId: deviceInfo.deviceId,
        channel: midiPayload.channel + 1,
        cc: midiPayload.cc,
      },
    });
    // Post-save reconciliation only — the gesture-time write in MIDIController already put
    // this binding in the store (and advanced the epoch) BEFORE the network round-trip.
    this.scopedMidiMap.setBinding(makeScopeKey(scopeInfo.scope, scopeInfo.entityId), parameterId, {
      channel: midiPayload.channel,
      cc: midiPayload.cc,
    });
  }

  async clearBinding({ identifier, parameterKey, element }) {
    const scopeInfo = this.resolveScope(element, identifier);
    if (!scopeInfo?.scope || !scopeInfo.entityId) {
      throw new Error('Unable to resolve scope for MIDI mapping removal.');
    }
    const parameterId = parameterKey || this.resolveParameterId(element, identifier);
    if (!parameterId) {
      throw new Error('Unable to resolve parameter id for MIDI mapping removal.');
    }

    await clearMidiMappingRemote({
      scope: scopeInfo.scope,
      entityId: scopeInfo.entityId,
      parameterId,
    });
    this.scopedMidiMap.deleteBinding(makeScopeKey(scopeInfo.scope, scopeInfo.entityId), parameterId);
  }
}
