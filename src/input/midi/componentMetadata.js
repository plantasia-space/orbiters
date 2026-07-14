/**
 * @file src/input/midi/componentMetadata.js
 * @description Utilities for describing UI components (by root param, DOM id, etc.) so MIDI learn can target them.
 */
import { listUiComponents, UI_COMPONENT_SCOPES } from '../../core/stackUtils.js';

export const LAYERED_KEY_PREFIX = 'layered:';
export const DEFAULT_STACK_ID = 'deck-i';
export const DEFAULT_DIMENSION_ID = 'default';

const midiComponentLookup = (() => {
  const byRoot = new Map();
  const byUiId = new Map();
  const byId = new Map();
  const components = listUiComponents();

  components.forEach((component) => {
    if (!component || typeof component !== 'object') {
      return;
    }
    if (component.id) {
      byId.set(component.id, component);
    }
    if (component.rootParam) {
      byRoot.set(component.rootParam, component);
    }
    if (Array.isArray(component.uiIds)) {
      component.uiIds.forEach((uiId) => {
        if (uiId) {
          byUiId.set(uiId, component);
        }
      });
    }
  });

  return Object.freeze({
    byRoot,
    byUiId,
    byId,
  });
})();

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

export function lookupComponentMetadataByKey(key) {
  if (!key) return null;
  const normalized = safeDecode(String(key).trim());
  if (!normalized) {
    return null;
  }
  if (midiComponentLookup.byRoot.has(normalized)) {
    return midiComponentLookup.byRoot.get(normalized);
  }
  if (midiComponentLookup.byUiId.has(normalized)) {
    return midiComponentLookup.byUiId.get(normalized);
  }
  if (midiComponentLookup.byId.has(normalized)) {
    return midiComponentLookup.byId.get(normalized);
  }
  return null;
}

export function resolveComponentMetadataForElement(element, fallbackKey = null) {
  const candidates = [];
  if (fallbackKey) {
    candidates.push(fallbackKey);
  }
  const dataset = element?.dataset || {};
  if (dataset.midiComponentId) {
    candidates.push(dataset.midiComponentId);
  }
  if (dataset.midiBaseParamId) {
    candidates.push(dataset.midiBaseParamId);
  }
  if (dataset.midiParamId) {
    candidates.push(dataset.midiParamId);
  }
  const rootParam = element?.getAttribute?.('root-param');
  if (rootParam) {
    candidates.push(rootParam);
  }
  const elementId = element?.id || element?.getAttribute?.('data-value');
  if (elementId) {
    candidates.push(elementId);
  }

  for (const raw of candidates) {
    if (!raw) continue;
    const firstPass = lookupComponentMetadataByKey(raw);
    if (firstPass) {
      return firstPass;
    }
    const trimmed = String(raw).trim();
    if (!trimmed) continue;

    if (trimmed.startsWith(LAYERED_KEY_PREFIX)) {
      const payload = trimmed.slice(LAYERED_KEY_PREFIX.length);
      const [componentKey] = payload.split('|');
      const layered = lookupComponentMetadataByKey(componentKey);
      if (layered) {
        return layered;
      }
    }

    const pipeIndex = trimmed.indexOf('|');
    if (pipeIndex > 0) {
      const segment = trimmed.slice(0, pipeIndex);
      const segmented = lookupComponentMetadataByKey(segment);
      if (segmented) {
        return segmented;
      }
    }
  }

  return null;
}

export function encodeScopedPart(value, fallback) {
  const payload = value ?? fallback ?? '';
  return encodeURIComponent(String(payload));
}

export function buildLayeredKey(componentKey, stackId, dimensionId) {
  const componentPart = encodeScopedPart(componentKey, 'component');
  const stackPart = encodeScopedPart(stackId, DEFAULT_STACK_ID);
  const dimensionPart = encodeScopedPart(dimensionId, DEFAULT_DIMENSION_ID);
  return `${LAYERED_KEY_PREFIX}${componentPart}|${stackPart}|${dimensionPart}`;
}

export function parseLayeredKey(key) {
  if (typeof key !== 'string' || !key.startsWith(LAYERED_KEY_PREFIX)) {
    return null;
  }
  const payload = key.slice(LAYERED_KEY_PREFIX.length);
  const segments = payload.split('|');
  if (segments.length !== 3) {
    return null;
  }
  return {
    componentKey: safeDecode(segments[0]),
    stackId: safeDecode(segments[1]),
    dimensionId: safeDecode(segments[2]),
  };
}

export function getComponentScope(element) {
  const metadata = resolveComponentMetadataForElement(element);
  return metadata?.scope ?? UI_COMPONENT_SCOPES.UNIQUE;
}
