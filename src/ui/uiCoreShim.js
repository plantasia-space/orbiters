// The design library's tooltip surface class — the SAME classes root's tooltips render with, so a
// tooltip reads identically across the platform. `.orbiters-tooltip` (ui-utilities.css) keeps only
// the mechanics this floating node needs (fixed positioning, stacking, max-width); the LOOK is the
// library's. The compiled utilities ship in the lib's styles.css, which every UI surface loads.
import { tooltipContentClass } from 'plantasia.space-design/react';

const dropdownInstances = new WeakMap();
const collapseInstances = new WeakMap();
const modalInstances = new WeakMap();
const tooltipInstances = new WeakMap();

function dispatchUiCoreEvent(element, type, detail = {}, legacyType = null) {
  if (!element) return true;
  const event = new CustomEvent(type, {
    bubbles: true,
    cancelable: true,
    detail,
  });
  const accepted = element.dispatchEvent(event);
  if (legacyType && legacyType !== type) {
    const legacyEvent = new CustomEvent(legacyType, {
      bubbles: true,
      cancelable: true,
      detail,
    });
    element.dispatchEvent(legacyEvent);
  }
  return accepted;
}

function getUiCoreToggleValue(element) {
  if (!element) return null;
  return element.getAttribute('data-ui-core-toggle') || element.getAttribute('data-bs-toggle');
}

function resolveDropdownMenu(toggle) {
  if (!toggle) return null;
  const explicitId = toggle.getAttribute('aria-controls');
  if (explicitId) {
    const byId = document.getElementById(explicitId);
    if (byId) return byId;
  }
  const dropdownRoot = toggle.closest('.dropdown, .dropup, .dropup-center, .dropup-start, .dropup-end');
  if (dropdownRoot) {
    const nested = dropdownRoot.querySelector('.dropdown-menu');
    if (nested) return nested;
  }
  let sibling = toggle.nextElementSibling;
  while (sibling) {
    if (sibling.classList?.contains('dropdown-menu')) {
      return sibling;
    }
    sibling = sibling.nextElementSibling;
  }
  return toggle.parentElement?.querySelector?.('.dropdown-menu') || null;
}

class Dropdown {
  static activeInstance = null;
  static globalHandlersBound = false;

  static getInstance(element) {
    return dropdownInstances.get(element) || null;
  }

  static getOrCreateInstance(element, config = {}) {
    return Dropdown.getInstance(element) || new Dropdown(element, config);
  }

  static bindGlobalHandlers() {
    if (Dropdown.globalHandlersBound || typeof document === 'undefined') {
      return;
    }
    Dropdown.globalHandlersBound = true;

    document.addEventListener('pointerdown', (event) => {
      const instance = Dropdown.activeInstance;
      if (!instance) return;
      const target = event.target;
      if (instance.toggleElement.contains(target) || instance.menuElement?.contains(target)) {
        return;
      }
      instance.hide();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        Dropdown.activeInstance?.hide();
      }
    }, true);
  }

  constructor(toggleElement, config = {}) {
    if (!toggleElement) {
      throw new Error('Dropdown requires a toggle element.');
    }
    const existing = Dropdown.getInstance(toggleElement);
    if (existing) {
      return existing;
    }

    this.toggleElement = toggleElement;
    this.menuElement = resolveDropdownMenu(toggleElement);
    this.rootElement =
      toggleElement.closest('.dropdown, .dropup, .dropup-center, .dropup-start, .dropup-end')
      || toggleElement.parentElement;
    this.config = config;
    this._boundClick = this._handleToggleClick.bind(this);
    this._boundKeydown = this._handleToggleKeydown.bind(this);
    this._boundMenuClick = this._handleMenuClick.bind(this);

    this.toggleElement.addEventListener('click', this._boundClick);
    this.toggleElement.addEventListener('keydown', this._boundKeydown);
    this.menuElement?.addEventListener('click', this._boundMenuClick);

    dropdownInstances.set(toggleElement, this);
    Dropdown.bindGlobalHandlers();
  }

  _handleToggleClick(event) {
    if (event.defaultPrevented) {
      return;
    }
    if (getUiCoreToggleValue(this.toggleElement) !== 'dropdown') {
      return;
    }
    event.preventDefault();
    this.toggle();
  }

  _handleToggleKeydown(event) {
    if (getUiCoreToggleValue(this.toggleElement) !== 'dropdown') {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.toggle();
    } else if (event.key === 'Escape') {
      this.hide();
    }
  }

  _handleMenuClick(event) {
    const item = event.target?.closest?.('.dropdown-item');
    if (!item || !this.menuElement?.contains(item)) {
      return;
    }
    requestAnimationFrame(() => {
      this.hide();
    });
  }

  show() {
    if (getUiCoreToggleValue(this.toggleElement) !== 'dropdown') {
      return;
    }
    if (!this.menuElement || this.menuElement.classList.contains('show')) {
      return;
    }
    if (
      !dispatchUiCoreEvent(
        this.toggleElement,
        'show.ui-core.dropdown',
        { relatedTarget: this.menuElement },
        'show.bs.dropdown',
      )
    ) {
      return;
    }
    if (Dropdown.activeInstance && Dropdown.activeInstance !== this) {
      Dropdown.activeInstance.hide();
    }
    this.menuElement.classList.add('show');
    this.toggleElement.classList.add('show');
    this.rootElement?.classList?.add?.('show');
    this.toggleElement.setAttribute('aria-expanded', 'true');
    Dropdown.activeInstance = this;
    dispatchUiCoreEvent(
      this.toggleElement,
      'shown.ui-core.dropdown',
      { relatedTarget: this.menuElement },
      'shown.bs.dropdown',
    );
  }

  hide() {
    if (!this.menuElement || !this.menuElement.classList.contains('show')) {
      return;
    }
    if (
      !dispatchUiCoreEvent(
        this.toggleElement,
        'hide.ui-core.dropdown',
        { relatedTarget: this.menuElement },
        'hide.bs.dropdown',
      )
    ) {
      return;
    }
    this.menuElement.classList.remove('show');
    this.toggleElement.classList.remove('show');
    this.rootElement?.classList?.remove?.('show');
    this.toggleElement.setAttribute('aria-expanded', 'false');
    if (Dropdown.activeInstance === this) {
      Dropdown.activeInstance = null;
    }
    dispatchUiCoreEvent(
      this.toggleElement,
      'hidden.ui-core.dropdown',
      { relatedTarget: this.menuElement },
      'hidden.bs.dropdown',
    );
  }

  toggle() {
    if (this.menuElement?.classList.contains('show')) {
      this.hide();
      return;
    }
    this.show();
  }

  dispose() {
    this.hide();
    this.toggleElement.removeEventListener('click', this._boundClick);
    this.toggleElement.removeEventListener('keydown', this._boundKeydown);
    this.menuElement?.removeEventListener('click', this._boundMenuClick);
    dropdownInstances.delete(this.toggleElement);
  }
}

class Collapse {
  static getInstance(element) {
    return collapseInstances.get(element) || null;
  }

  static getOrCreateInstance(element, config = {}) {
    return Collapse.getInstance(element) || new Collapse(element, config);
  }

  constructor(element, config = {}) {
    if (!element) {
      throw new Error('Collapse requires an element.');
    }
    const existing = Collapse.getInstance(element);
    if (existing) {
      return existing;
    }
    this.element = element;
    this.config = config;
    collapseInstances.set(element, this);
  }

  show() {
    if (this.element.classList.contains('show')) return;
    if (!dispatchUiCoreEvent(this.element, 'show.ui-core.collapse', {}, 'show.bs.collapse')) return;
    this.element.classList.add('show');
    this.element.setAttribute('aria-hidden', 'false');
    dispatchUiCoreEvent(this.element, 'shown.ui-core.collapse', {}, 'shown.bs.collapse');
  }

  hide() {
    if (!this.element.classList.contains('show')) return;
    if (!dispatchUiCoreEvent(this.element, 'hide.ui-core.collapse', {}, 'hide.bs.collapse')) return;
    this.element.classList.remove('show');
    this.element.setAttribute('aria-hidden', 'true');
    dispatchUiCoreEvent(this.element, 'hidden.ui-core.collapse', {}, 'hidden.bs.collapse');
  }

  toggle() {
    if (this.element.classList.contains('show')) {
      this.hide();
    } else {
      this.show();
    }
  }

  dispose() {
    collapseInstances.delete(this.element);
  }
}

function createBackdrop() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop fade show';
  return backdrop;
}

class Modal {
  static activeInstance = null;

  static getInstance(element) {
    return modalInstances.get(element) || null;
  }

  static getOrCreateInstance(element, config = {}) {
    return Modal.getInstance(element) || new Modal(element, config);
  }

  constructor(element, config = {}) {
    if (!element) {
      throw new Error('Modal requires an element.');
    }
    const existing = Modal.getInstance(element);
    if (existing) {
      return existing;
    }
    this.element = element;
    this.config = {
      backdrop: true,
      keyboard: true,
      ...config,
    };
    this.backdrop = null;
    this.isShown = false;
    this.previousActiveElement = null;
    this._boundKeydown = this._handleKeydown.bind(this);
    this._boundClick = this._handleClick.bind(this);
    this.element.addEventListener('click', this._boundClick);
    modalInstances.set(element, this);
  }

  _handleKeydown(event) {
    if (event.key === 'Escape' && this.config.keyboard !== false) {
      event.preventDefault();
      this.hide();
    }
  }

  _handleClick(event) {
    const dismiss = event.target?.closest?.('[data-ui-core-dismiss="modal"], [data-bs-dismiss="modal"]');
    if (dismiss && this.element.contains(dismiss)) {
      event.preventDefault();
      this.hide();
      return;
    }

    if (this.config.backdrop && event.target === this.element) {
      this.hide();
    }
  }

  show() {
    if (this.isShown) return;
    if (!dispatchUiCoreEvent(this.element, 'show.ui-core.modal', {}, 'show.bs.modal')) return;

    if (Modal.activeInstance && Modal.activeInstance !== this) {
      Modal.activeInstance.hide();
    }

    this.previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.isShown = true;
    this.element.style.display = 'grid';
    this.element.removeAttribute('aria-hidden');
    this.element.classList.add('show', 'active');
    document.body.classList.add('modal-open');
    document.body.style.overflow = 'hidden';

    if (this.config.backdrop) {
      this.backdrop = createBackdrop();
      this.backdrop.addEventListener('click', () => {
        this.hide();
      });
      document.body.appendChild(this.backdrop);
    }

    document.addEventListener('keydown', this._boundKeydown, true);
    Modal.activeInstance = this;
    dispatchUiCoreEvent(this.element, 'shown.ui-core.modal', {}, 'shown.bs.modal');
  }

  hide() {
    if (!this.isShown) return;
    if (!dispatchUiCoreEvent(this.element, 'hide.ui-core.modal', {}, 'hide.bs.modal')) return;

    this.isShown = false;
    this.element.classList.remove('show', 'active');
    this.element.setAttribute('aria-hidden', 'true');
    this.element.style.display = 'none';
    this.backdrop?.remove();
    this.backdrop = null;
    document.removeEventListener('keydown', this._boundKeydown, true);

    if (Modal.activeInstance === this) {
      Modal.activeInstance = null;
    }
    if (!Modal.activeInstance) {
      document.body.classList.remove('modal-open');
      document.body.style.overflow = '';
    }

    if (this.previousActiveElement && typeof this.previousActiveElement.focus === 'function') {
      this.previousActiveElement.focus();
    }

    dispatchUiCoreEvent(this.element, 'hidden.ui-core.modal', {}, 'hidden.bs.modal');
  }

  dispose() {
    this.hide();
    this.element.removeEventListener('click', this._boundClick);
    modalInstances.delete(this.element);
  }
}

function resolveTooltipPlacement(element, tooltip, placement) {
  const rect = element.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const margin = 10;
  const autoPlacement = placement === 'auto'
    ? (rect.top >= tooltipRect.height + margin ? 'top' : 'bottom')
    : placement;

  let top = 0;
  let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);

  if (autoPlacement === 'bottom') {
    top = rect.bottom + margin;
  } else {
    top = rect.top - tooltipRect.height - margin;
  }

  left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - tooltipRect.height - margin));

  tooltip.dataset.placement = autoPlacement;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

class Tooltip {
  static getInstance(element) {
    return tooltipInstances.get(element) || null;
  }

  constructor(element, config = {}) {
    if (!element) {
      throw new Error('Tooltip requires an element.');
    }
    const existing = Tooltip.getInstance(element);
    if (existing) {
      return existing;
    }
    this.element = element;
    this.config = config;
    this.tooltipNode = null;
    tooltipInstances.set(element, this);
  }

  show() {
    const title = typeof this.config.title === 'function' ? this.config.title() : this.config.title;
    if (!title) return;
    if (!this.tooltipNode) {
      const node = document.createElement('div');
      // `dark` on the node itself so the lib tokens resolve the dark tooltip regardless of where
      // on <body> it lands (the studio scopes `dark` to its own root, not the document).
      node.className = `orbiters-tooltip dark ${tooltipContentClass}`;
      node.textContent = title;
      document.body.appendChild(node);
      this.tooltipNode = node;
    } else {
      this.tooltipNode.textContent = title;
      this.tooltipNode.hidden = false;
    }
    resolveTooltipPlacement(this.element, this.tooltipNode, this.config.placement || 'auto');
  }

  hide() {
    if (this.tooltipNode) {
      this.tooltipNode.hidden = true;
    }
  }

  dispose() {
    if (this.tooltipNode) {
      this.tooltipNode.remove();
      this.tooltipNode = null;
    }
    tooltipInstances.delete(this.element);
  }
}

const uiCoreNamespace = {
  Dropdown,
  Collapse,
  Modal,
  Tooltip,
};

if (typeof window !== 'undefined') {
  window.uiCore = uiCoreNamespace;
}

if (typeof globalThis !== 'undefined') {
  globalThis.uiCore = uiCoreNamespace;
}

export default uiCoreNamespace;
