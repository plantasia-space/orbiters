/**
 * @file MidiOverlayManager.js
 * @description Handles overlay creation/cleanup for MIDI Learn mode, keeping descriptor data centralized.
 */

export class MidiOverlayManager {
  constructor({ onStartLearn, onOpenContextMenu, isElementMapped } = {}) {
    this.onStartLearn = onStartLearn;
    this.onOpenContextMenu = onOpenContextMenu;
    this.isElementMapped = isElementMapped;

    this.overlayRegistry = new Map();
    this._dropdownItems = new Set();
    this._boundReflow = this._handleReflow.bind(this);
    this._eventsBound = false;
    this._isActive = false;
  }

  activate() {
    this._isActive = true;
    this._removeOverlayDom();
    this._teardownDropdownItems();
    this._collectWidgetOverlays();
    this._instrumentDropdownItems();
    this.refresh();
    this._bindReflow();
  }

  deactivate() {
    if (!this._isActive) {
      return;
    }
    this._isActive = false;
    this._removeOverlayDom();
    this._teardownDropdownItems();
    this._unbindReflow();
  }

  ensureOverlayForElement(element) {
    if (!this._isActive || !element) {
      return;
    }
    this._createOverlayForWidget(element);
    this.refresh();
  }

  refresh() {
    if (!this._isActive || !this.overlayRegistry.size) {
      return;
    }

    const removals = [];
    this.overlayRegistry.forEach((entry, id) => {
      const { overlay, widget } = entry || {};
      if (!overlay || !widget) {
        if (overlay) overlay.remove();
        removals.push(id);
        return;
      }

      if (!document.body.contains(widget)) {
        overlay.remove();
        removals.push(id);
        return;
      }

      const rect = widget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        overlay.style.display = 'none';
        return;
      }

      overlay.style.display = 'block';
      overlay.style.position = 'absolute';
      overlay.style.top = `${rect.top + window.scrollY}px`;
      overlay.style.left = `${rect.left + window.scrollX}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    });

    removals.forEach((id) => this.overlayRegistry.delete(id));
  }

  _collectWidgetOverlays() {
    const widgets = document.querySelectorAll('[data-automatable="true"]');
    widgets.forEach((widget) => this._createOverlayForWidget(widget));
  }

  _createOverlayForWidget(widget) {
    if (!widget || typeof widget.getBoundingClientRect !== 'function') {
      return null;
    }

    const id = widget.id;
    if (!id) {
      console.warn("MidiOverlayManager: Widget missing 'id' attribute:", widget);
      return null;
    }

    const existing = this.overlayRegistry.get(id);
    if (existing?.overlay) {
      existing.overlay.remove();
      this.overlayRegistry.delete(id);
    }

    const rect = widget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const overlay = document.createElement('div');
    overlay.classList.add('widget-overlay');
    overlay.dataset.widgetId = id;
    // Persistence-scope tint: a widget owned by a non-orbiter slice (collection shell
    // actions) carries `data-midi-scope`; mirror it so CSS can color the overlay per scope.
    if (widget.dataset?.midiScope) {
      overlay.dataset.midiScope = widget.dataset.midiScope;
    }
    overlay.style.position = 'absolute';
    overlay.style.pointerEvents = 'auto';
    // Sit above the orbiter's own UI (z <= ~10) but BELOW a host page's shell chrome (nav /
    // header / player bar). A near-1000 z made these overlays cover the Feed's player bar; a
    // modest value keeps the host's z-layering intact while still topping the orbiter controls.
    overlay.style.zIndex = '40';
    overlay.style.background = 'rgba(255, 255, 255, 0.1)';

    overlay.addEventListener('click', (event) => {
      if (!this._isActive) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const mapped = this.isElementMapped?.(widget);
      if (mapped) {
        this.onOpenContextMenu?.(event, widget);
      } else {
        this.onStartLearn?.(widget);
      }
    });

    document.body.appendChild(overlay);
    this.overlayRegistry.set(id, { overlay, widget });
    return overlay;
  }

  _instrumentDropdownItems() {
    const items = document.querySelectorAll('[data-midi-controllable="true"]');
    items.forEach((item) => {
      if (!item || this._dropdownItems.has(item)) {
        return;
      }
      this._dropdownItems.add(item);
      item.classList.add('midi-learn-dropdown');
      if (item.__midiOriginalClick === undefined) {
        item.__midiOriginalClick = item.onclick;
      }
      item.onclick = null;

      const handler = (event) => {
        if (!this._isActive) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const mapped = this.isElementMapped?.(item);
        if (mapped) {
          this.onOpenContextMenu?.(event, item);
        } else {
          this.onStartLearn?.(item);
        }
      };
      item.__midiDropdownHandler = handler;
      item.addEventListener('click', handler);
    });
  }

  _teardownDropdownItems() {
    this._dropdownItems.forEach((item) => {
      if (!item) {
        return;
      }
      item.classList.remove('midi-learn-dropdown');
      if (item.__midiDropdownHandler) {
        item.removeEventListener('click', item.__midiDropdownHandler);
        delete item.__midiDropdownHandler;
      }
      if (item.__midiOriginalClick !== undefined) {
        item.onclick = item.__midiOriginalClick;
        delete item.__midiOriginalClick;
      }
    });
    this._dropdownItems.clear();
  }

  _removeOverlayDom() {
    this.overlayRegistry.forEach(({ overlay }) => overlay?.remove());
    this.overlayRegistry.clear();
  }

  _bindReflow() {
    if (this._eventsBound || typeof window === 'undefined') {
      return;
    }
    window.addEventListener('resize', this._boundReflow);
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

  _handleReflow() {
    this.refresh();
  }
}
