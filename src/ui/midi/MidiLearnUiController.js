import { resolveHerbariumSymbol, fetchHerbariumSymbol, parseHerbariumSvg } from '../../utils/cdnAssets.js';

export class MidiLearnUiController {
  constructor({
    overlayManager,
    onEnter,
    onExit,
    onStartLearn,
    exitButtonId = 'exit-midi-learn',
    moreButtonId = 'moreMenuButton',
  } = {}) {
    this.overlayManager = overlayManager;
    this._onEnter = onEnter;
    this._onExit = onExit;
    this._onStartLearn = onStartLearn;
    this.exitButtonId = exitButtonId;
    this.moreButtonId = moreButtonId;

    this._isActive = false;
    this._highlightedWidgets = new Set();
    this._highlightedParams = new Set();
    this._handleEsc = this._handleEsc.bind(this);
    this._handleExit = this._handleExit.bind(this);
  }

  get isActive() {
    return this._isActive;
  }

  enable() {
    if (this._isActive) {
      return false;
    }
    this._isActive = true;
    // The body class must land BEFORE overlays are collected: learn-only affordances (the
    // collection shell's slot chips) are display:none outside `.midi-learn-mode`, and the
    // overlay manager skips zero-size widgets at collection time — activating first left
    // them permanently overlay-less (visible but inert).
    document.body.classList.add('midi-learn-mode');
    this.overlayManager?.activate();
    this._toggleMoreMenuButton(true);
    this._bindExitButton();
    document.addEventListener('keydown', this._handleEsc);
    this._onEnter?.();
    return true;
  }

  disable() {
    if (!this._isActive) {
      return false;
    }
    this._isActive = false;
    this.overlayManager?.deactivate();
    this._toggleMoreMenuButton(false);
    document.body.classList.remove('midi-learn-mode');
    this._unbindExitButton();
    document.removeEventListener('keydown', this._handleEsc);
    this._clearHighlights();
    this._onExit?.();
    return true;
  }

  startLearnForElement(element) {
    if (!element) {
      return;
    }
    const id = element.id || element.getAttribute?.('data-value');
    if (!id) {
      console.warn('[MidiLearnUiController] Element missing id/data-value.');
      return;
    }
    if (
      !element.hasAttribute?.('data-automatable') &&
      !element.hasAttribute?.('data-midi-controllable')
    ) {
      console.warn('[MidiLearnUiController] Unknown element type for MIDI Learn:', element);
      return;
    }
    this.highlightWidget(id);
    this._onStartLearn?.(element, id);
  }

  highlightWidget(widgetId) {
    if (!widgetId) {
      return;
    }
    const element = document.getElementById(widgetId);
    if (element) {
      element.classList.add('midi-learn-highlight');
      this._highlightedWidgets.add(widgetId);
    }
  }

  unhighlightWidget(widgetId) {
    if (!widgetId) {
      return;
    }
    const element = document.getElementById(widgetId);
    if (element) {
      element.classList.remove('midi-learn-highlight');
    }
    this._highlightedWidgets.delete(widgetId);
  }

  highlightParameter(paramId) {
    if (!paramId) {
      return;
    }
    const element = document.querySelector(`[data-group="${paramId}"]`);
    if (element) {
      element.classList.add('midi-learn-highlight');
      this._highlightedParams.add(paramId);
    }
  }

  unhighlightParameter(paramId) {
    if (!paramId) {
      return;
    }
    const element = document.querySelector(`[data-group="${paramId}"]`);
    if (element) {
      element.classList.remove('midi-learn-highlight');
    }
    this._highlightedParams.delete(paramId);
  }

  ensureOverlayForElement(element) {
    if (!this._isActive) {
      return;
    }
    this.overlayManager?.ensureOverlayForElement(element);
  }

  refreshOverlays() {
    if (!this._isActive) {
      return;
    }
    this.overlayManager?.refresh();
  }

  _handleEsc(event) {
    if (event.key === 'Escape') {
      this.disable();
    }
  }

  _handleExit(event) {
    event?.preventDefault();
    this.disable();
  }

  _bindExitButton() {
    if (!this.exitButtonId) {
      return;
    }
    const exitButton = document.getElementById(this.exitButtonId);
    exitButton?.addEventListener('click', this._handleExit);
  }

  _unbindExitButton() {
    if (!this.exitButtonId) {
      return;
    }
    const exitButton = document.getElementById(this.exitButtonId);
    exitButton?.removeEventListener('click', this._handleExit);
  }

  _toggleMoreMenuButton(isActive) {
    if (!this.moreButtonId) {
      return;
    }
    const moreButton = document.getElementById(this.moreButtonId);
    if (!moreButton) {
      return;
    }
    const buttonIcon = moreButton.querySelector('.button-icon');
    const newIconSrc = resolveHerbariumSymbol(isActive ? 'close-dinamic.svg' : 'more.svg');
    const newLabel = isActive ? 'Exit MIDI Learn Mode' : 'More options';
    moreButton.setAttribute('aria-label', newLabel);

    if (isActive) {
      moreButton.classList.add('close-mode');
      moreButton.dataset.originalUiCoreToggle = moreButton.getAttribute('data-ui-core-toggle') || '';
      moreButton.removeAttribute('data-ui-core-toggle');
      moreButton.addEventListener('click', this._handleExit, { once: false });
      const dropdownInstance = window.uiCore?.Dropdown?.getInstance?.(moreButton);
      dropdownInstance?.hide();
    } else {
      moreButton.classList.remove('close-mode');
      const previousToggleValue = moreButton.dataset.originalUiCoreToggle || 'dropdown';
      moreButton.setAttribute('data-ui-core-toggle', previousToggleValue);
      delete moreButton.dataset.originalUiCoreToggle;
      moreButton.removeEventListener('click', this._handleExit);
    }

    this._fetchAndSetSVG(newIconSrc, buttonIcon);
  }

  _fetchAndSetSVG(src, element) {
    if (!element || !src) {
      return;
    }
    fetchHerbariumSymbol(src)
      .then(({ content, url }) => {
        const svgElement = parseHerbariumSvg(content, url);
        svgElement.setAttribute('fill', 'currentColor');
        svgElement.setAttribute('role', 'img');
        svgElement.classList.add('icon-svg');
        element.innerHTML = '';
        element.appendChild(svgElement);
      })
      .catch((error) =>
        console.error(`Error loading SVG from ${resolveHerbariumSymbol(src)}:`, error),
      );
  }

  _clearHighlights() {
    this._highlightedWidgets.forEach((widgetId) => this.unhighlightWidget(widgetId));
    this._highlightedParams.forEach((paramId) => this.unhighlightParameter(paramId));
    this._highlightedWidgets.clear();
    this._highlightedParams.clear();
    document.querySelectorAll('.midi-learn-highlight').forEach((element) =>
      element.classList.remove('midi-learn-highlight'),
    );
  }
}
