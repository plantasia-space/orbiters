/**
 * @file src/input/midi/MidiMappingRegistry.js
 * @description In-memory registry for MIDI ↔ UI parameter bindings, providing lookup helpers
 * for learn, playback, and feedback flows.
 */
import {
  DEFAULT_DIMENSION_ID,
  DEFAULT_STACK_ID,
  buildLayeredKey,
  parseLayeredKey,
  resolveComponentMetadataForElement,
} from './componentMetadata.js';
import { UI_COMPONENT_SCOPES } from '../../core/stackUtils.js';

export class MidiMappingRegistry {
  constructor() {
    this.widgetRegistry = new Map();
    this.widgetDescriptors = new Map();
    this.widgetParameterLookup = new Map();
    this.midiParamMappings = new Map();
    this.midiWidgetMappings = new Map();
    this.layeredWidgetMappings = new Map();
    // Persisted bindings are no longer a single flat map owned here — they
    // live PER SLICE in `ScopedMidiMap` (keyed by scopeKey). Hydration/removal below take
    // the relevant slice's bindings map as an argument so this registry stays a pure
    // mechanism (one slice's bindings can never cross-hydrate another's).
    this.parameterMappings = new Map();
  }

  registerWidget(id, element) {
    if (!id || !element) {
      return null;
    }
    this.widgetRegistry.set(id, element);
    return this.resolveWidgetMetadata(id, element);
  }

  /**
   * React seam: register from an explicit, typed descriptor instead of
   * parsing it back out of DOM `data-midi-*` attributes. The React control passes
   * a scoped-binding RECORD; we seed `widgetDescriptors` directly so the existing
   * key-build / inbound / feedback machinery works unchanged. The element is still
   * stored (learn overlays need a positioned DOM node + stable id).
   *
   * @param {string} id
   * @param {HTMLElement} element
   * @param {object} descriptor - normalized descriptor (componentKey, scope,
   *   supportsLayers, componentType, axis, min, max, …) matching the shape
   *   {@link resolveWidgetMetadata} would otherwise produce from the DOM.
   */
  registerScopedBinding(id, element, descriptor) {
    if (!id || !element || !descriptor) {
      return null;
    }
    this.widgetRegistry.set(id, element);
    // A momentary action (kick) is a `trigger` binding — no sustained value to
    // echo, so feedback must skip it. Carry the tag on the descriptor so it rides onto every
    // parameter-mapping record built from this binding (derived from componentType as a net).
    const kind = descriptor.kind || (descriptor.componentType === 'kick' ? 'trigger' : undefined);
    // `pinned`: this descriptor is the source of truth and must NEVER be re-resolved
    // from the DOM. Learn stamps `data-midi-param-id` on the element, which would
    // otherwise trip the hint-invalidation below and rebuild a descriptor without
    // the typed min/max — collapsing inbound value scaling. (MIDI bug.)
    this.widgetDescriptors.set(id, {
      widgetId: id,
      legacyKeys: [],
      persistenceScope: descriptor.persistenceScope || null,
      ...descriptor,
      kind,
      pinned: true,
    });
    this.widgetParameterLookup.delete(id); // recompute the scoped key against the new descriptor
    return this.widgetDescriptors.get(id);
  }

  unregisterWidget(id) {
    this.widgetRegistry.delete(id);
    this.widgetDescriptors.delete(id);
    this.widgetParameterLookup.delete(id);
    this.midiWidgetMappings.delete(id);
    this.layeredWidgetMappings.delete(id);
  }

  forEachWidget(callback) {
    this.widgetRegistry.forEach((element, widgetId) => {
      callback?.(widgetId, element);
    });
  }

  getWidget(id) {
    return this.widgetRegistry.get(id) || null;
  }

  resolveWidgetMetadata(widgetId, widget = null) {
    if (this.widgetDescriptors.has(widgetId)) {
      const cached = this.widgetDescriptors.get(widgetId);
      // Typed-record descriptors (React seam) are authoritative — return as-is and
      // never re-derive from the DOM (which would drop the typed min/max).
      if (cached?.pinned) {
        return cached;
      }
      const elementRef = widget || this.widgetRegistry.get(widgetId);
      if (elementRef && cached) {
        const hint =
          elementRef.dataset?.midiComponentId ||
          elementRef.dataset?.midiBaseParamId ||
          elementRef.dataset?.midiParamId ||
          elementRef.getAttribute?.('data-midi-param-id');
        if (hint && cached.componentId && cached.componentId !== hint && cached.componentKey !== hint) {
          this.widgetDescriptors.delete(widgetId);
          this.widgetParameterLookup.delete(widgetId);
        } else {
          return cached;
        }
      } else {
        return cached;
      }
    }
    const element = widget || this.widgetRegistry.get(widgetId);
    if (!element) {
      return null;
    }
    const dataset = element.dataset || {};
    const baseParamId =
      dataset.midiBaseParamId ||
      dataset.midiParamId ||
      this.resolveBaseParameterId(element, widgetId) ||
      null;
    const componentMeta = resolveComponentMetadataForElement(element, baseParamId);
    const componentId = componentMeta?.id || dataset.midiComponentId || null;
    const scope = componentMeta?.scope || dataset.midiComponentScope || null;
    const descriptor = {
      widgetId,
      baseParamId,
      componentId,
      scope,
      supportsLayers: scope === UI_COMPONENT_SCOPES.DIMENSION,
      componentKey: componentMeta?.id || componentMeta?.rootParam || baseParamId || widgetId,
      componentType: componentMeta?.key || null,
      defaultValue:
        componentMeta && typeof componentMeta.defaultValue !== 'undefined'
          ? componentMeta.defaultValue
          : null,
      axis: componentMeta?.axis || null,
      legacyKeys: [
        ...new Set(
          [
            baseParamId,
            componentMeta?.rootParam,
            dataset.midiParamId,
            element?.getAttribute?.('data-midi-param-id'),
            dataset.midiRootParam,
            element?.getAttribute?.('root-param'),
            dataset.midiLegacyParamId,
          ]
            .filter(Boolean)
            .filter((value) => value !== (componentMeta?.id || baseParamId)),
        ),
      ],
    };
    this.widgetDescriptors.set(widgetId, descriptor);
    this.widgetParameterLookup.delete(widgetId);
    return descriptor;
  }

  resolveBaseParameterId(element, fallbackId) {
    if (!element) {
      return fallbackId;
    }
    if (element.dataset?.midiBaseParamId) {
      return element.dataset.midiBaseParamId;
    }
    if (element.dataset?.midiParamId) {
      return element.dataset.midiParamId;
    }
    const rootParam = element.getAttribute?.('root-param');
    if (rootParam) {
      return rootParam;
    }
    return fallbackId;
  }

  getParameterIdForWidget(widgetId, widget, contextResolver) {
    if (this.widgetParameterLookup.has(widgetId)) {
      return this.widgetParameterLookup.get(widgetId);
    }
    const target = widget || this.widgetRegistry.get(widgetId);
    if (!target) {
      return widgetId;
    }

    const metadata = this.resolveWidgetMetadata(widgetId, target);
    if (!metadata) {
      return widgetId;
    }

    const scopedKey = this.buildScopedMidiKey(metadata, contextResolver?.());
    if (!scopedKey) {
      return widgetId;
    }

    this.widgetParameterLookup.set(widgetId, scopedKey);
    if (typeof target.setAttribute === 'function') {
      target.setAttribute('data-midi-param-id', scopedKey);
    }
    return scopedKey;
  }

  buildScopedMidiKey(metadata, context = null) {
    if (!metadata) {
      return null;
    }
    if (!metadata.supportsLayers) {
      return metadata.baseParamId || metadata.componentKey || metadata.widgetId;
    }
    const stackId = context?.stackId || DEFAULT_STACK_ID;
    const dimensionId = context?.dimensionId || DEFAULT_DIMENSION_ID;
    const componentKey = metadata.componentKey || metadata.baseParamId || metadata.widgetId;
    return buildLayeredKey(componentKey, stackId, dimensionId);
  }

  /**
   * Build a widget's live layered mappings from ITS ORBITER'S persisted bindings.
   * @param {string} widgetId
   * @param {object} metadata resolved widget descriptor (carries componentKey + legacyKeys)
   * @param {object} context current { stackId, dimensionId }
   * @param {Map<string, {channel:number, cc:number}>|null} persistedBindings the orbiter's
   *   bindings slice from `ScopedMidiMap.bindingsFor(scopeKey)` — the candidate set for this
   *   widget. Null/absent means this orbiter has no persisted MIDI yet (widget hydrates empty).
   */
  hydrateLayeredWidget(widgetId, metadata, context, persistedBindings = null) {
    if (!metadata?.supportsLayers) {
      return null;
    }
    const layeredMap = this._ensureLayeredMap(widgetId, { clear: true });
    const componentKey = metadata.componentKey;
    const legacyKeys = metadata.legacyKeys || [];
    const conversions = [];

    persistedBindings?.forEach((binding, key) => {
      if (!binding) {
        return;
      }
      const parsed = parseLayeredKey(key);
      let effectiveKey = null;
      if (parsed && parsed.componentKey === componentKey) {
        effectiveKey = key;
      } else if (
        !parsed &&
        (key === componentKey || legacyKeys.includes(key))
      ) {
        const migratedKey = buildLayeredKey(
          componentKey,
          context?.stackId || DEFAULT_STACK_ID,
          context?.dimensionId || DEFAULT_DIMENSION_ID,
        );
        conversions.push({ oldKey: key, newKey: migratedKey, binding });
        effectiveKey = migratedKey;
      }

      if (!effectiveKey) {
        return;
      }

      const normalizedChannel = Number(binding.channel);
      const normalizedCc = Number(binding.cc);
      if (!Number.isFinite(normalizedChannel) || !Number.isFinite(normalizedCc)) {
        return;
      }
      layeredMap.set(effectiveKey, { channel: normalizedChannel, cc: normalizedCc });
    });

    conversions.forEach(({ oldKey, newKey, binding }) => {
      persistedBindings?.delete(oldKey);
      persistedBindings?.set(newKey, binding);
    });

    const scopedKey = this.buildScopedMidiKey(metadata, context);
    const binding = scopedKey ? layeredMap.get(scopedKey) : null;
    if (binding) {
      this.midiWidgetMappings.set(widgetId, { ...binding, scopedKey });
      const parameterId = metadata.axis || metadata.baseParamId || metadata.componentKey || metadata.widgetId;
      this._linkParameterMapping(parameterId, {
        scopedKey,
        channel: binding.channel,
        cc: binding.cc,
        stackId: context?.stackId || DEFAULT_STACK_ID,
        dimensionId: context?.dimensionId || DEFAULT_DIMENSION_ID,
        kind: metadata.kind,
      });
    } else {
      this.midiWidgetMappings.delete(widgetId);
    }
    return { binding, scopedKey, context };
  }

  setLayeredBinding(widgetId, metadata, context, { channel, cc }) {
    if (!metadata?.supportsLayers) {
      return null;
    }
    const scopedKey = this.buildScopedMidiKey(metadata, context);
    if (!scopedKey) {
      return null;
    }
    const normalizedChannel = Number(channel);
    const normalizedCc = Number(cc);
    if (!Number.isFinite(normalizedChannel) || !Number.isFinite(normalizedCc)) {
      return null;
    }
    const layeredMap = this._ensureLayeredMap(widgetId);
    const binding = { channel: normalizedChannel, cc: normalizedCc };
    layeredMap.set(scopedKey, binding);
    this.midiWidgetMappings.set(widgetId, { ...binding, scopedKey });
    const parameterId = metadata.axis || metadata.baseParamId || metadata.componentKey || metadata.widgetId;
    this._linkParameterMapping(parameterId, {
      scopedKey,
      channel: normalizedChannel,
      cc: normalizedCc,
      stackId: context?.stackId || DEFAULT_STACK_ID,
      dimensionId: context?.dimensionId || DEFAULT_DIMENSION_ID,
      kind: metadata.kind,
    });
    return { scopedKey, binding };
  }

  syncLayeredWidgetBinding(widgetId, metadata, context) {
    if (!metadata?.supportsLayers) {
      return { binding: null, scopedKey: null };
    }
    const scopedKey = this.buildScopedMidiKey(metadata, context);
    const layeredMap = this.layeredWidgetMappings.get(widgetId);
    if (!layeredMap || !layeredMap.size) {
      this.midiWidgetMappings.delete(widgetId);
      return { binding: null, scopedKey };
    }
    const binding = scopedKey ? layeredMap.get(scopedKey) : null;
    if (binding) {
      const existing = this.midiWidgetMappings.get(widgetId);
      if (!existing || existing.channel !== binding.channel || existing.cc !== binding.cc) {
        this.midiWidgetMappings.set(widgetId, { ...binding, scopedKey });
      }
      const parameterId = metadata.axis || metadata.baseParamId || metadata.componentKey || metadata.widgetId;
      this._linkParameterMapping(parameterId, {
        scopedKey,
        channel: binding.channel,
        cc: binding.cc,
        stackId: context?.stackId || DEFAULT_STACK_ID,
        dimensionId: context?.dimensionId || DEFAULT_DIMENSION_ID,
        kind: metadata.kind,
      });
      return { binding, scopedKey };
    }
    this.midiWidgetMappings.delete(widgetId);
    return { binding: null, scopedKey };
  }

  removeLayeredBindings(widgetId, metadata, removalContext, { removeAll = false } = {}) {
    const layeredMap = this.layeredWidgetMappings.get(widgetId);
    if (!layeredMap || !layeredMap.size || !metadata?.supportsLayers) {
      return { removedKeys: [], cleared: false, remaining: 0 };
    }
    const keysToRemove = [];
    if (removeAll) {
      layeredMap.forEach((_value, key) => keysToRemove.push(key));
    } else {
      const scopedKey = this.buildScopedMidiKey(metadata, removalContext);
      if (scopedKey && layeredMap.has(scopedKey)) {
        keysToRemove.push(scopedKey);
      } else {
        layeredMap.forEach((_value, key) => keysToRemove.push(key));
      }
    }
    const parameterId = metadata.axis || metadata.baseParamId || metadata.componentKey || metadata.widgetId;
    keysToRemove.forEach((key) => {
      layeredMap.delete(key);
      // The persisted binding lives in the slice's `ScopedMidiMap` entry now;
      // the caller deletes it there (which emits the per-orbiter unmap so siblings re-hydrate).
      this._unlinkParameterMapping(parameterId, key);
    });

    if (!layeredMap.size) {
      this.layeredWidgetMappings.delete(widgetId);
      this.midiWidgetMappings.delete(widgetId);
      return { removedKeys: keysToRemove, cleared: true, remaining: 0 };
    }

    const scopedKey = this.buildScopedMidiKey(metadata, removalContext);
    if (scopedKey) {
      const binding = layeredMap.get(scopedKey);
      if (binding) {
        this.midiWidgetMappings.set(widgetId, { ...binding, scopedKey });
        this._linkParameterMapping(parameterId, {
          scopedKey,
          channel: binding.channel,
          cc: binding.cc,
          stackId: removalContext?.stackId || DEFAULT_STACK_ID,
          dimensionId: removalContext?.dimensionId || DEFAULT_DIMENSION_ID,
          kind: metadata.kind,
        });
      } else {
        this.midiWidgetMappings.delete(widgetId);
      }
    }

    return { removedKeys: keysToRemove, cleared: false, remaining: layeredMap.size };
  }

  getLayeredMatches(channel, ccNumber) {
    const matches = [];
    this.layeredWidgetMappings.forEach((layerMap, widgetId) => {
      if (!layerMap || !layerMap.size) return;
      layerMap.forEach((binding, scopedKey) => {
        if (binding.channel === channel && binding.cc === ccNumber) {
          matches.push({ widgetId, scopedKey, binding });
        }
      });
    });
    return matches;
  }

  getMappingsForParameter(parameterId) {
    const scopedMap = this.parameterMappings.get(parameterId);
    if (!scopedMap) {
      return [];
    }
    return Array.from(scopedMap.values()).map((entry) => ({ ...entry }));
  }

  linkParameterMapping(parameterId, record) {
    this._linkParameterMapping(parameterId, record);
  }

  unlinkParameterMapping(parameterId, scopedKey) {
    this._unlinkParameterMapping(parameterId, scopedKey);
  }

  _ensureLayeredMap(widgetId, { clear = false } = {}) {
    let map = this.layeredWidgetMappings.get(widgetId);
    if (!map) {
      map = new Map();
      this.layeredWidgetMappings.set(widgetId, map);
    } else if (clear) {
      map.clear();
    }
    return map;
  }

  _linkParameterMapping(parameterId, record) {
    if (!parameterId || !record || !record.scopedKey) {
      return;
    }
    let scopedMap = this.parameterMappings.get(parameterId);
    if (!scopedMap) {
      scopedMap = new Map();
      this.parameterMappings.set(parameterId, scopedMap);
    }
    scopedMap.set(record.scopedKey, {
      parameterId,
      scopedKey: record.scopedKey,
      channel: record.channel,
      cc: record.cc,
      stackId: record.stackId ?? null,
      dimensionId: record.dimensionId ?? null,
      // 'Trigger' (kick) mappings carry no value — the feedback bridge skips them.
      kind: record.kind ?? null,
    });
  }

  _unlinkParameterMapping(parameterId, scopedKey) {
    if (!parameterId || !scopedKey) {
      return;
    }
    const scopedMap = this.parameterMappings.get(parameterId);
    if (!scopedMap) {
      return;
    }
    scopedMap.delete(scopedKey);
    if (!scopedMap.size) {
      this.parameterMappings.delete(parameterId);
    }
  }

  clearLayeredMap(widgetId) {
    if (this.layeredWidgetMappings.has(widgetId)) {
      this.layeredWidgetMappings.delete(widgetId);
      return true;
    }
    return false;
  }

  getParameterMappingCount() {
    return this.parameterMappings?.size ?? 0;
  }

  hasParameterMappings() {
    return this.getParameterMappingCount() > 0;
  }
}
