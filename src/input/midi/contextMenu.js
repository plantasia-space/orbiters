/**
 * @file src/input/midi/contextMenu.js
 * @description Context menu helpers used by MIDI Learn to prompt for binding actions.
 */
import notifications from '../../core/AppNotifications.js';
import { computeContextMenuPosition } from './contextMenuPosition.js';

export class MidiContextMenu {
  constructor({ onLearn, onDelete, onCancel }) {
    this.onLearn = onLearn;
    this.onDelete = onDelete;
    this.onCancel = onCancel;

    this.currentWidget = null;
    this.currentParam = null;

    this._handleOutsideClick = this._handleOutsideClick.bind(this);
    this._handleEsc = this._handleEsc.bind(this);
    this._handleLearn = this._handleLearn.bind(this);
    this._handleDelete = this._handleDelete.bind(this);
    this._handleClose = this._handleClose.bind(this);
  }

  attach() {
    const contextMenuLearn = document.getElementById('midi-context-learn');
    const contextMenuDelete = document.getElementById('midi-context-delete');
    const contextMenuClose = document.getElementById('midi-context-close');
    const passiveOptions = { passive: true };

    contextMenuLearn?.addEventListener('click', this._handleLearn);
    contextMenuLearn?.addEventListener('touchstart', this._handleLearn, passiveOptions);

    contextMenuDelete?.addEventListener('click', this._handleDelete);
    contextMenuDelete?.addEventListener('touchstart', this._handleDelete, passiveOptions);

    contextMenuClose?.addEventListener('click', this._handleClose);
    contextMenuClose?.addEventListener('touchstart', this._handleClose, passiveOptions);

    document.addEventListener('click', this._handleOutsideClick);
    document.addEventListener('keydown', this._handleEsc);
  }

  detach() {
    const contextMenuLearn = document.getElementById('midi-context-learn');
    const contextMenuDelete = document.getElementById('midi-context-delete');
    const contextMenuClose = document.getElementById('midi-context-close');

    contextMenuLearn?.removeEventListener('click', this._handleLearn);
    contextMenuLearn?.removeEventListener('touchstart', this._handleLearn);

    contextMenuDelete?.removeEventListener('click', this._handleDelete);
    contextMenuDelete?.removeEventListener('touchstart', this._handleDelete);

    contextMenuClose?.removeEventListener('click', this._handleClose);
    contextMenuClose?.removeEventListener('touchstart', this._handleClose);

    document.removeEventListener('click', this._handleOutsideClick);
    document.removeEventListener('keydown', this._handleEsc);
  }

  open(event, element) {
    event.preventDefault();
    event.stopPropagation();

    const contextMenu = document.getElementById('midi-context-menu');
    if (!contextMenu) {
      console.error('[MidiContextMenu] Context menu not found.');
      return;
    }

    const elementId = element?.id || element?.getAttribute?.('data-value');
    if (!elementId) {
      console.warn('[MidiContextMenu] Element missing id/data-value.');
      return;
    }

    // Lay the menu out (but invisible) so we can measure its real size, then place it so it never
    // runs off screen. We toggle `visibility`, not `display`, for the measure so the close /
    // outside-click guards that key on `display === 'block'` are unaffected.
    contextMenu.style.visibility = 'hidden';
    contextMenu.style.display = 'block';
    contextMenu.classList.add('show');
    // z-index is owned by the `#midi-context-menu.show` CSS rule (a modest layer that sits below a
    // host page's shell chrome). No inline override here — an inline z would win over that rule and
    // re-raise the menu above the host chrome in the embed.
    const { top, left } = computeContextMenuPosition(
      element.getBoundingClientRect(),
      contextMenu.getBoundingClientRect(),
      { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
    );
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
    contextMenu.style.visibility = '';

    const overlay = Array.from(document.querySelectorAll('.widget-overlay')).find(
      (ov) => ov.dataset.widgetId === element.id,
    );
    if (overlay) {
      overlay.style.pointerEvents = 'none';
    }

    this.currentWidget = element;
    this.currentParam = elementId;
  }

  close() {
    const contextMenu = document.getElementById('midi-context-menu');
    if (contextMenu) {
      contextMenu.classList.remove('show');
      contextMenu.style.display = 'none';
    }

    if (this.currentWidget) {
      const overlay = Array.from(document.querySelectorAll('.widget-overlay')).find(
        (ov) => ov.dataset.widgetId === this.currentWidget.id,
      );
      if (overlay) {
        overlay.style.pointerEvents = 'auto';
      }
    }

    this.currentWidget = null;
    this.currentParam = null;
  }

  _handleLearn(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.currentWidget && !this.currentParam) {
      notifications.showToast('Select a widget or parameter first.', 'warning');
      return;
    }
    this.onLearn?.({ widget: this.currentWidget, param: this.currentParam });
    this.close();
  }

  _handleDelete(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.currentWidget && !this.currentParam) {
      notifications.showToast('Select a widget or parameter first.', 'warning');
      return;
    }
    this.onDelete?.({ widget: this.currentWidget, param: this.currentParam });
    this.close();
  }

  _handleClose(event) {
    event.preventDefault();
    event.stopPropagation();
    this.onCancel?.();
    this.close();
  }

  _handleOutsideClick(event) {
    const contextMenu = document.getElementById('midi-context-menu');
    if (contextMenu && contextMenu.style.display === 'block' && !contextMenu.contains(event.target)) {
      this.onCancel?.();
      this.close();
    }
  }

  _handleEsc(event) {
    if (event.key === 'Escape') {
      this.onCancel?.();
      this.close();
    }
  }
}
