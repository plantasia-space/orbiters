import { getT } from '../i18n/index.js';

const ROLE_CONFIG = Object.freeze({
  button: {
    translationKey: 'tooltips.controls.buttons',
    placement: 'top',
    fallbackPlacements: ['bottom', 'auto'],
  },
  knob: {
    translationKey: 'tooltips.controls.knobs',
    placement: 'bottom',
    fallbackPlacements: ['top', 'auto'],
  },
});

const tooltipRegistry = new Map();
let tooltipsEnabled = false;
// Tooltips/helpers now work on touch too. Desktop reveals them on hover; mobile reveals
// them on tap (a brief, non-blocking helper, since coarse pointers have no hover). This flag only
// picks WHICH interaction model a control uses — it no longer disables the feature on touch.
const IS_COARSE_POINTER = (() => {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const hasTouchEvents = 'ontouchstart' in window
      || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
    const coarsePointer = typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
    return Boolean(hasTouchEvents || coarsePointer);
  } catch (_) {
    return false;
  }
})();
/** How long a tapped helper lingers on touch before auto-hiding (ms). */
const TOUCH_HINT_LINGER_MS = 1600;

function getUiCoreNamespace() {
  if (typeof window !== 'undefined' && window.uiCore?.Tooltip) {
    return window.uiCore;
  }
  if (typeof globalThis !== 'undefined' && globalThis.uiCore?.Tooltip) {
    return globalThis.uiCore;
  }
  return null;
}

function ensureRegistryEntry(element, role) {
  if (!element || !role) {
    return null;
  }
  const existing = tooltipRegistry.get(element);
  if (existing) {
    existing.role = role;
    return existing;
  }
  const entry = {
    role,
    instance: null,
    messageKey: null,
    placement: null,
    listeners: [],
    suspendUntilLeave: false,
    hideTimer: null,
  };
  tooltipRegistry.set(element, entry);
  return entry;
}

function resolveTooltipTitle(element, entry) {
  const t = getT();
  const explicitKey = entry?.messageKey || element?.getAttribute?.('data-tooltip-key');
  if (explicitKey) {
    const explicit = t(explicitKey, { defaultValue: '' });
    if (explicit) {
      return explicit;
    }
  }
  const role = entry?.role;
  if (role && typeof ROLE_CONFIG[role]?.getMessage === 'function') {
    const computed = ROLE_CONFIG[role].getMessage(t, element);
    if (computed) {
      return computed;
    }
  }
  // Element-specific fallback — show the control's own aria-label/title (e.g. "Play",
  // "Sensors", "x rotation") when no explicit i18n key is set. This lets React controls registered
  // generically (no messageKey) still "tell you what it is" on hover, rather than the generic role
  // copy. Legacy controls pass a messageKey (resolved above), so they are unaffected.
  const ariaLabel = element?.getAttribute?.('aria-label') || element?.getAttribute?.('title');
  if (ariaLabel) {
    return ariaLabel;
  }
  const fallbackKey = role ? ROLE_CONFIG[role]?.translationKey : null;
  if (fallbackKey) {
    const fallback = t(fallbackKey, { defaultValue: '' });
    if (fallback) {
      return fallback;
    }
  }
  return '';
}

function resolveTooltipPlacement(element, entry) {
  if (!entry) {
    return 'auto';
  }
  const role = entry.role;
  return entry.placement
    || element?.getAttribute?.('data-tooltip-placement')
    || ROLE_CONFIG[role]?.placement
    || 'auto';
}

function detachEntryListeners(element, entry) {
  if (!entry || !Array.isArray(entry.listeners)) {
    return;
  }
  if (entry.hideTimer) {
    clearTimeout(entry.hideTimer);
    entry.hideTimer = null;
  }
  entry.listeners.forEach(({ type, handler, options }) => {
    element?.removeEventListener?.(type, handler, options);
  });
  entry.listeners = [];
}

function disposeTooltip(entry, element = null) {
  if (entry?.instance) {
    entry.instance.hide?.();
    entry.instance.dispose?.();
    entry.instance = null;
  }
  if (element) {
    detachEntryListeners(element, entry);
  }
}

function rebuildTooltipInstance(element, entry) {
  if (!element || !entry || !ROLE_CONFIG[entry.role]) {
    return null;
  }
  const uiCoreNamespace = getUiCoreNamespace();
  if (!uiCoreNamespace?.Tooltip) {
    disposeTooltip(entry, element);
    return null;
  }
  const TooltipClass = uiCoreNamespace.Tooltip;
  const title = resolveTooltipTitle(element, entry);
  if (!title) {
    disposeTooltip(entry, element);
    return null;
  }
  // Retire the previous instance FIRST: the Tooltip class is a per-element singleton whose
  // constructor returns the existing instance and ignores new config — without this, a rebuild
  // silently keeps the OLD title (stale after a language switch or a state-dependent aria-label
  // change). Instance only — the element's hover/tap listeners stay attached.
  disposeTooltip(entry);
  const placement = resolveTooltipPlacement(element, entry);
  const config = ROLE_CONFIG[entry.role] || {};
  const tooltipInstance = new TooltipClass(element, {
    title,
    placement,
    trigger: 'manual',
    fallbackPlacements: config.fallbackPlacements ?? ['auto'],
    container: 'body',
    boundary: 'viewport',
  });
  entry.instance = tooltipInstance;
  return tooltipInstance;
}

function ensureTooltipInstance(element, entry) {
  if (!entry.instance) {
    return rebuildTooltipInstance(element, entry);
  }
  return entry.instance;
}

function hideEntryTooltip(entry) {
  entry.instance?.hide?.();
}

function showEntryTooltip(element, entry) {
  if (!tooltipsEnabled || entry?.suspendUntilLeave) {
    return;
  }
  const instance = ensureTooltipInstance(element, entry);
  instance?.show?.();
}

function attachEntryListeners(element, entry) {
  if (!element || !entry) {
    return;
  }
  detachEntryListeners(element, entry);
  const listenerDefs = [];
  const addListener = (type, handler, options) => {
    element.addEventListener(type, handler, options);
    listenerDefs.push({ type, handler, options });
  };

  const handlePointerEnter = () => {
    showEntryTooltip(element, entry);
  };
  const handlePointerLeave = () => {
    entry.suspendUntilLeave = false;
    hideEntryTooltip(entry);
  };
  const handleFocusIn = () => {
    showEntryTooltip(element, entry);
  };
  const handleFocusOut = () => {
    entry.suspendUntilLeave = false;
    hideEntryTooltip(entry);
  };
  const handlePress = () => {
    entry.suspendUntilLeave = true;
    hideEntryTooltip(entry);
  };
  const handleKeydown = (event) => {
    if (!event) return;
    const key = event.key;
    if (key === 'Enter' || key === ' ') {
      entry.suspendUntilLeave = true;
      hideEntryTooltip(entry);
    }
  };

  if (IS_COARSE_POINTER) {
    // Mobile: no hover, so TAP reveals the helper. It's pointer-events:none and lingers
    // briefly before auto-hiding, so it never blocks the control — the same tap still actuates it.
    const handleTouchPress = () => {
      if (entry.hideTimer) {
        clearTimeout(entry.hideTimer);
        entry.hideTimer = null;
      }
      entry.suspendUntilLeave = false;
      showEntryTooltip(element, entry);
    };
    const handleTouchRelease = () => {
      if (entry.hideTimer) {
        clearTimeout(entry.hideTimer);
      }
      entry.hideTimer = setTimeout(() => {
        entry.hideTimer = null;
        hideEntryTooltip(entry);
      }, TOUCH_HINT_LINGER_MS);
    };
    addListener('pointerdown', handleTouchPress, true);
    addListener('pointerup', handleTouchRelease, true);
    addListener('pointercancel', handleTouchRelease, true);
  } else {
    // Desktop: hover/focus shows; pressing the control drops the tooltip so it never sits over it.
    addListener('pointerenter', handlePointerEnter, false);
    addListener('pointerleave', handlePointerLeave, false);
    addListener('focusin', handleFocusIn, false);
    addListener('focusout', handleFocusOut, false);
    addListener('pointerdown', handlePress, true);
    addListener('click', handlePress, true);
    addListener('keydown', handleKeydown, true);
  }

  entry.listeners = listenerDefs;
}

function syncTooltipInstance(element, entry) {
  if (!entry) {
    return;
  }
  if (tooltipsEnabled) {
    rebuildTooltipInstance(element, entry);
    attachEntryListeners(element, entry);
  } else {
    entry.suspendUntilLeave = false;
    hideEntryTooltip(entry);
    disposeTooltip(entry, element);
  }
}

export function attachControlTooltip(element, role = 'button', options = {}) {
  if (!element || !ROLE_CONFIG[role]) {
    return null;
  }
  const entry = ensureRegistryEntry(element, role);
  entry.role = role;

  const providedKey = options.messageKey ?? null;
  const attrKey = element.getAttribute('data-tooltip-key');
  const resolvedKey = providedKey || attrKey || entry.messageKey || null;
  entry.messageKey = resolvedKey;
  if (resolvedKey) {
    element.setAttribute('data-tooltip-key', resolvedKey);
  }

  const providedPlacement = options.placement ?? null;
  const attrPlacement = element.getAttribute('data-tooltip-placement');
  const resolvedPlacement = providedPlacement || attrPlacement || entry.placement || null;
  entry.placement = resolvedPlacement;
  if (resolvedPlacement) {
    element.setAttribute('data-tooltip-placement', resolvedPlacement);
  }

  element.setAttribute('data-tooltip-role', role);
  syncTooltipInstance(element, entry);
  return entry;
}

export function activateMarkedControlTooltips(root = null) {
  if (typeof document === 'undefined') {
    return;
  }
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  const candidates = scope === document
    ? document.querySelectorAll('[data-tooltip-role]')
    : scope.querySelectorAll('[data-tooltip-role]');

  candidates.forEach((element) => {
    const role = element.getAttribute('data-tooltip-role');
    if (!role || !ROLE_CONFIG[role]) {
      return;
    }
    attachControlTooltip(element, role);
  });
}

export function refreshControlTooltips() {
  if (!tooltipsEnabled) {
    return;
  }
  tooltipRegistry.forEach((entry, element) => {
    if (!element || !element.isConnected) {
      disposeTooltip(entry, element);
      tooltipRegistry.delete(element);
      return;
    }
    rebuildTooltipInstance(element, entry);
  });
}

export function setControlTooltipsEnabled(enabled) {
  const next = Boolean(enabled);
  if (tooltipsEnabled === next) {
    return tooltipsEnabled;
  }
  tooltipsEnabled = next;
  tooltipRegistry.forEach((entry, element) => {
    if (!element || !element.isConnected) {
      disposeTooltip(entry, element);
      tooltipRegistry.delete(element);
      return;
    }
    syncTooltipInstance(element, entry);
  });
  // Mirror the (previously private) flag to a DOM signal so the React more-menu toggle can
  // READ it synchronously (class) and SUBSCRIBE to changes (event) — keeping its on/off check in sync
  // however the flag flips (menu click, the `t` keyboard shortcut, or programmatic).
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('orbiters-tooltips-on', tooltipsEnabled);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('orbiters:tooltips-changed', { detail: { enabled: tooltipsEnabled } }));
  }
  return tooltipsEnabled;
}

/** Read the current tooltips-enabled flag (for the React more-menu toggle's checked state). */
export function isControlTooltipsEnabled() {
  return tooltipsEnabled;
}

export function toggleControlTooltips() {
  return setControlTooltipsEnabled(!tooltipsEnabled);
}

function shouldIgnoreToggleKey(event) {
  if (!event) return true;
  if (event.defaultPrevented) return true;
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  if (event.repeat) return true;
  const target = event.target;
  if (!target) return false;
  const tagName = target.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable) {
    return true;
  }
  if (typeof target.closest === 'function') {
    const editor = target.closest('[contenteditable="true"]');
    if (editor) {
      return true;
    }
  }
  return false;
}

function handleTooltipToggleKeystroke(event) {
  if (!event || typeof event.key !== 'string') {
    return;
  }
  if (event.key.toLowerCase() !== 't') {
    return;
  }
  if (shouldIgnoreToggleKey(event)) {
    return;
  }
  toggleControlTooltips();
  event.preventDefault();
}

if (typeof window !== 'undefined') {
  window.addEventListener('languageChanged', () => {
    refreshControlTooltips();
  });
  window.addEventListener('keydown', handleTooltipToggleKeystroke, true);
}
