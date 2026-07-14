import { byId } from '../../voice/voiceDom.js';

const INDICATOR_OFFSET_PER_LAYER = 6;
const INDICATOR_BASE_OFFSET_X = 50;
const INDICATOR_BASE_OFFSET_DROPDOWN_Y = -20;
const INDICATOR_BASE_OFFSET_DROPUP_Y = 24;
const INDICATOR_BASE_OFFSET_WIDGET_Y = 16;
const INDICATOR_MENU_ITEM_SPACING_Y = 40;

export class MidiIndicatorManager {
  constructor({ isMidiPanelActive } = {}) {
    this._registry = new Map();
    this._isMidiPanelActive = typeof isMidiPanelActive === 'function' ? isMidiPanelActive : () => false;
    this._shouldShow = false;
    // The CH/CC badges are position:fixed (viewport-relative), so they only stay glued to their
    // widgets if we recompute on scroll/resize — the same reflow the overlay boxes already do.
    // Without it, in a scrolling host (the embedded Feed) the badges freeze at the top of the
    // screen while the orbiter scrolls away. Bound only while the badges are shown.
    this._boundReflow = () => this.refreshPositions();
    this._eventsBound = false;
  }

  hasIndicator(id) {
    return this._registry.has(id);
  }

  getIndicatorElement(id) {
    return this._registry.get(id) || null;
  }

  markAsMapped(elementId, midiMeta = {}) {
    const element = this._resolveElement(elementId);
    if (!element) {
      console.warn('[MidiIndicatorManager] Unable to resolve element:', elementId);
      return null;
    }
    element.classList.remove('midi-learn-highlight');
    element.classList.add('midi-mapped');

    this.removeIndicator(elementId, { suppressClassRemoval: true });

    const indicator = document.createElement('div');
    indicator.className = 'midi-indicator';
    indicator.dataset.elementId = elementId;
    // Persistence-scope tint (see MidiOverlayManager): the CH/CC badge follows its widget's
    // scope color so collection-owned mappings read apart from orbiter-owned ones.
    if (element.dataset?.midiScope) {
      indicator.dataset.midiScope = element.dataset.midiScope;
    }
    this._applyIndicatorDataset(indicator, midiMeta);
    indicator.textContent = this._formatIndicatorText(midiMeta);
    document.body.appendChild(indicator);
    this._registry.set(elementId, indicator);
    this._applyVisibility(elementId, element, indicator);
    return indicator;
  }

  updateIndicator(elementId, midiMeta = {}) {
    const indicator = this._registry.get(elementId);
    if (!indicator) {
      return;
    }
    const merged = {
      midiCC: midiMeta.midiCC ?? this._parseNumber(indicator.dataset.midiCc),
      midiChannel: midiMeta.midiChannel ?? this._parseNumber(indicator.dataset.midiChannel),
      type: midiMeta.type ?? indicator.dataset.midiType ?? 'cc',
      dimensionLabel: midiMeta.dimensionLabel ?? indicator.dataset.dimensionLabel ?? null,
      stackId: midiMeta.stackId ?? indicator.dataset.stackId ?? null,
      dimensionId: midiMeta.dimensionId ?? indicator.dataset.dimensionId ?? null,
      layerIndex:
        typeof midiMeta.layerIndex === 'number'
          ? midiMeta.layerIndex
          : this._parseNumber(indicator.dataset.layerIndex) || 0,
    };
    this._applyIndicatorDataset(indicator, merged);
    indicator.textContent = this._formatIndicatorText(merged);
    this._applyVisibility(elementId, null, indicator);
  }

  updateIndicatorForElement(element) {
    if (!element) {
      return;
    }
    const id = element.id || element.getAttribute('data-value');
    if (!id) {
      return;
    }
    this._applyVisibility(id, element);
  }

  setVisibility(shouldShow) {
    this._shouldShow = Boolean(shouldShow);
    if (this._shouldShow) {
      this._bindReflow();
    } else {
      this._unbindReflow();
    }
    this.refreshPositions();
  }

  refreshPositions() {
    this._registry.forEach((_indicator, id) => {
      this._applyVisibility(id);
    });
  }

  _bindReflow() {
    if (this._eventsBound || typeof window === 'undefined') {
      return;
    }
    window.addEventListener('resize', this._boundReflow);
    // Capture phase so a scroll inside a nested host container (the Feed) is caught too.
    window.addEventListener('scroll', this._boundReflow, true);
    this._eventsBound = true;
  }

  _unbindReflow() {
    if (!this._eventsBound || typeof window === 'undefined') {
      return;
    }
    window.removeEventListener('resize', this._boundReflow);
    window.removeEventListener('scroll', this._boundReflow, true);
    this._eventsBound = false;
  }

  removeIndicator(elementId, { suppressClassRemoval = false } = {}) {
    const indicator = this._registry.get(elementId);
    if (indicator) {
      indicator.remove();
    }
    this._registry.delete(elementId);
    if (!suppressClassRemoval) {
      const element = this._resolveElement(elementId);
      if (element) {
        element.classList.remove('midi-mapped');
      }
    }
  }

  clear() {
    this._registry.forEach((indicator) => indicator?.remove());
    this._registry.clear();
    this._unbindReflow();
  }

  _applyIndicatorDataset(indicator, meta) {
    if (!indicator || !meta) {
      return;
    }
    const {
      stackId = null,
      dimensionId = null,
      layerIndex = 0,
      dimensionLabel = null,
      midiCC = null,
      midiChannel = null,
      type = 'cc',
    } = meta;

    indicator.dataset.stackId = stackId || '';
    indicator.dataset.dimensionId = dimensionId || '';
    indicator.dataset.layerIndex = String(layerIndex);
    indicator.dataset.dimensionLabel = dimensionLabel || '';
    if (midiCC != null) {
      indicator.dataset.midiCc = String(midiCC);
    }
    if (midiChannel != null) {
      indicator.dataset.midiChannel = String(midiChannel);
    }
    indicator.dataset.midiType = type || 'cc';
  }

  _applyVisibility(elementId, elementOverride = null, indicatorOverride = null) {
    const indicator = indicatorOverride || this._registry.get(elementId);
    if (!indicator) {
      return;
    }
    if (!this._shouldShow) {
      indicator.style.display = 'none';
      return;
    }
    const element = elementOverride || this._resolveElement(elementId);
    if (!element) {
      indicator.style.display = 'none';
      return;
    }
    const positioned = this._positionIndicator(element, indicator);
    indicator.style.display = positioned ? 'block' : 'none';
  }

  _formatIndicatorText({ midiCC, midiChannel, type = 'cc', dimensionLabel = null } = {}) {
    const normalizedChannel = Number.isFinite(midiChannel) ? midiChannel + 1 : 1;
    const normalizedCC = midiCC ?? '—';
    const base = `CH ${normalizedChannel} / ${String(type).toUpperCase()} ${normalizedCC}`;
    return dimensionLabel ? `${base} | ${dimensionLabel}` : base;
  }

  _positionIndicator(element, indicator) {
    if (!indicator || !element) {
      if (indicator) {
        indicator.style.display = 'none';
      }
      return false;
    }

    let rect = element.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      indicator.style.display = 'none';
      return false;
    }

    const dropdownToggle = element.closest?.('[data-midi-dropdown-toggle="true"]') || null;
    const dropdownMenu = element.closest?.('.dropdown-menu, [role="menu"]') || null;
    const dropupRoot = element.closest?.('.dropup, [data-dropup="true"]') || null;
    const containerRoot =
      element.closest?.('[data-midi-indicator-container="true"]') ||
      dropdownMenu?.parentElement ||
      dropupRoot?.closest?.('.button-group-container') ||
      null;

    const hasDropdownContext = Boolean(dropdownMenu || dropdownToggle || dropupRoot);
    const menuOpen =
      hasDropdownContext &&
      (dropdownMenu?.classList?.contains?.('show') ||
        dropdownToggle?.classList?.contains?.('show') ||
        dropdownToggle?.getAttribute?.('aria-expanded') === 'true');

    if (hasDropdownContext && !menuOpen) {
      indicator.style.display = 'none';
      return false;
    }

    const positionTarget = dropdownToggle || containerRoot || element;
    rect = positionTarget?.getBoundingClientRect?.() ?? rect;
    if (!rect || (!rect.width && !rect.height)) {
      indicator.style.display = 'none';
      return false;
    }

    // In a scrolling host the widget can scroll out of the viewport. A position:fixed badge
    // would otherwise clamp to the top edge (see topPosition below) and pin there; hide it
    // instead so a badge only ever shows glued to an on-screen widget.
    const viewportH = window.innerHeight || document.documentElement?.clientHeight || 0;
    const viewportW = window.innerWidth || document.documentElement?.clientWidth || 0;
    if (rect.bottom <= 0 || rect.top >= viewportH || rect.right <= 0 || rect.left >= viewportW) {
      indicator.style.display = 'none';
      return false;
    }

    const layerIndex = this._parseNumber(indicator.dataset?.layerIndex) || 0;
    const stackOffset = layerIndex * INDICATOR_OFFSET_PER_LAYER;

    let indicatorHeight = indicator.offsetHeight;
    if (!indicatorHeight) {
      const indicatorRect = indicator.getBoundingClientRect();
      indicatorHeight = indicatorRect.height || 18;
    }

    const chainCandidates = [
      indicator,
      positionTarget,
      element !== positionTarget ? element : null,
      dropdownMenu,
      dropdownToggle,
      dropupRoot,
      containerRoot,
    ];
    const offsetChain = [];
    chainCandidates.forEach((candidate) => {
      if (candidate && !offsetChain.includes(candidate)) {
        offsetChain.push(candidate);
      }
    });

    const horizontalAdjustment = this._resolveOffsetFromChain(offsetChain, [
      'midiIndicatorOffsetX',
      'midiIndicatorOffset',
    ]);
    const verticalAdjustment = this._resolveOffsetFromChain(
      offsetChain,
      dropupRoot
        ? ['midiIndicatorOffsetDropupY', 'midiIndicatorOffsetY', 'midiIndicatorOffset']
        : hasDropdownContext
          ? ['midiIndicatorOffsetDropdownY', 'midiIndicatorOffsetY', 'midiIndicatorOffset']
          : ['midiIndicatorOffsetWidgetY', 'midiIndicatorOffsetY', 'midiIndicatorOffset'],
    );

    const menuOrderRaw = hasDropdownContext
      ? this._parseNumber(element.dataset?.midiIndicatorOrder)
      : -1;
    const orderOffset =
      Number.isFinite(menuOrderRaw) && menuOrderRaw >= 0
        ? menuOrderRaw * INDICATOR_MENU_ITEM_SPACING_Y
        : 0;

    const horizontalOffset = INDICATOR_BASE_OFFSET_X + horizontalAdjustment;

    let topPosition;
    if (dropupRoot) {
      const dropupBase = INDICATOR_BASE_OFFSET_DROPUP_Y + stackOffset + verticalAdjustment;
      topPosition = rect.top - indicatorHeight - (dropupBase + orderOffset);
    } else if (hasDropdownContext) {
      const dropdownBase = INDICATOR_BASE_OFFSET_DROPDOWN_Y + stackOffset + verticalAdjustment;
      topPosition = rect.bottom - dropdownBase + orderOffset;
    } else {
      const widgetBase = INDICATOR_BASE_OFFSET_WIDGET_Y + stackOffset + verticalAdjustment;
      topPosition = rect.bottom - widgetBase;
    }

    indicator.style.position = 'fixed';
    indicator.style.left = `${rect.right - horizontalOffset}px`;
    indicator.style.top = `${Math.max(0, topPosition)}px`;
    indicator.style.transform = 'none';
    // Just above the overlay boxes (40), still below a host page's shell chrome — see the note
    // in MidiOverlayManager. A near-1000 z made the badges cover the Feed's player bar.
    indicator.style.zIndex = '42';
    return true;
  }

  _resolveOffsetFromChain(chain, keys) {
    if (!Array.isArray(chain) || !Array.isArray(keys) || !keys.length) {
      return 0;
    }
    for (const element of chain) {
      if (!element) continue;
      const dataset = element.dataset || {};
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(dataset, key)) {
          const parsed = Number.parseFloat(dataset[key]);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }
      if (typeof element.getAttribute === 'function') {
        for (const key of keys) {
          const attrName = this._toDataAttrName(key);
          const raw = element.getAttribute(attrName);
          if (raw == null || raw === '') {
            continue;
          }
          const parsed = Number.parseFloat(raw);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }
    }
    return 0;
  }

  _toDataAttrName(datasetKey) {
    const kebab = datasetKey.replace(/([A-Z])/g, '-$1').toLowerCase();
    return `data-${kebab}`;
  }

  _resolveElement(elementId) {
    if (!elementId || typeof document === 'undefined') {
      return null;
    }
    return (
      byId(elementId) ||
      document.querySelector(`[data-value="${elementId}"]`) ||
      document.querySelector(`[data-group="${elementId}"]`)
    );
  }

  _parseNumber(value) {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
