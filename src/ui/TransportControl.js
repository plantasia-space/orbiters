/**
 * @file TransportControl.js
 * @description Simple, centralized transport control - works with ButtonGroup dropdown mechanism
 */

import { fetchHerbariumSymbol, parseHerbariumSvg, resolveHerbariumSymbol } from '../utils/cdnAssets.js';

const TRANSPORT_STATE_CHANGE_EVENT = 'orbiters:transport-state-change';
const TRANSPORT_ICON_PATHS = Object.freeze({
  play: resolveHerbariumSymbol('play_circle.svg'),
  pause: resolveHerbariumSymbol('pause_circle.svg'),
});

/**
 * Central transport controller - all play/pause/stop actions go through here
 */
class TransportControl {
  /**
   * De-singletonization: one TransportControl PER VOICE, not a module singleton.
   * @param {object} [opts]
   * @param {EventTarget|Window} [opts.eventBus] where transport-state-change is dispatched (per-voice
   *   EventTarget for a multi tile; defaults to `window` → single-orbiter byte-identical).
   * @param {Document|HTMLElement} [opts.root] DOM scope for this voice's legacy transport chrome.
   */
  constructor({ eventBus, root } = {}) {
    this.currentState = 'stopped';
    this.orbiter = null;
    this.button = null;
    this.iconContainer = null;
    this.menuItems = {};
    this.playbackStateUnsubscribe = null;
    this._actionInFlight = null;
    this.eventBus = eventBus ?? (typeof window !== 'undefined' ? window : null);
    this.root = root ?? (typeof document !== 'undefined' ? document : null);
  }

  /**
   * Initialize with orbiter and button references
   */
  init(orbiter) {
    if (typeof this.playbackStateUnsubscribe === 'function') {
      this.playbackStateUnsubscribe();
      this.playbackStateUnsubscribe = null;
    }

    this.orbiter = orbiter;
    // This control now fronts a (re)built engine — init runs on every engine construction, including
    // an in-place session swap on a live voice. A fresh engine always boots stopped, so the state
    // resets with it; and an action still awaiting the PREVIOUS engine can never settle (that engine
    // was disposed mid-action), so keeping it would wedge every future play/pause/stop.
    this.currentState = 'stopped';
    this._actionInFlight = null;
    // Legacy transport chrome scoped to THIS voice's root (these ids are global-legacy DOM the React
    // UI replaced; in multi the elements live nowhere in a tile's root, so these resolve null — fine).
    this.button = this.root?.querySelector('#transportMenuButton') ?? null;
    this.iconContainer = this.button?.querySelector('.button-icon');

    // Get menu item references
    this.menuItems = {
      playToggle: this.root?.querySelector('#play-toggle-item') ?? null,
      stop: this.root?.querySelector('#stop-item') ?? null,
    };

    // Set initial state to stopped
    this.updateUI('stopped');

    if (this.orbiter && typeof this.orbiter.addPlaybackStateListener === 'function') {
      this.playbackStateUnsubscribe = this.orbiter.addPlaybackStateListener((payload = {}) => {
        if (payload?.transient) {
          return;
        }
        const nextState = payload?.state;
        if (nextState === 'playing' || nextState === 'paused' || nextState === 'stopped') {
          this.currentState = nextState;
          this.updateUI(nextState);
        }
      });
    }
  }

  /**
   * Update UI to reflect current state
   * @param {string} currentState - 'playing', 'paused', or 'stopped'
   */
  updateUI(currentState) {
    const buttonAction = currentState === 'playing' ? 'pause' : 'play';
    const buttonLabel = buttonAction === 'pause' ? 'Pause' : 'Play';
    const iconPath = TRANSPORT_ICON_PATHS[buttonAction];

    if (iconPath && this.iconContainer) {
      fetchHerbariumSymbol(iconPath)
        .then(({ content, url }) => {
          const svgElement = parseHerbariumSvg(content, url);
          svgElement.setAttribute('fill', 'currentColor');
          svgElement.setAttribute('role', 'img');
          svgElement.classList.add('icon-svg');
          this.iconContainer.innerHTML = '';
          this.iconContainer.appendChild(svgElement);
        })
        .catch((error) => {
          console.warn('[Transport] Failed to load icon:', error);
        });
    }

    const playToggleItem = this.menuItems.playToggle;
    if (playToggleItem) {
      playToggleItem.classList.toggle('active', currentState !== 'stopped');
      playToggleItem.setAttribute('data-value', buttonLabel);
      playToggleItem.setAttribute('data-label', buttonLabel);
      playToggleItem.setAttribute('data-icon', iconPath);

      const label = playToggleItem.querySelector('[data-transport-toggle-label]');
      if (label) {
        label.textContent = buttonLabel;
      }
      // The dropdown menu-item icon is owned by ButtonGroup.setMenuItemIcon, which
      // re-renders the inline <svg> on transport-state-change. (After init the item
      // has no <img> to update.) The main transport button icon is handled below.
    }

    if (this.menuItems.stop) {
      this.menuItems.stop.classList.toggle('active', currentState === 'stopped');
    }

    // Update aria-label
    if (this.button) {
      this.button.setAttribute('aria-label', buttonLabel);
      this.button.setAttribute('data-playback-state', currentState);
    }

    // Per-voice: the React `transport` facade for THIS voice subscribes to this same eventBus, so a
    // play/pause in one tile only updates that tile (window for single-orbiter → byte-identical).
    if (this.eventBus?.dispatchEvent) {
      this.eventBus.dispatchEvent(
        new CustomEvent(TRANSPORT_STATE_CHANGE_EVENT, {
          detail: {
            state: currentState,
            activeAction: currentState === 'stopped' ? 'stop' : 'play-toggle',
            buttonAction,
          },
        }),
      );
    }
  }

  /**
   * Play - updates UI to show playing state, then triggers engine
   */
  async play() {
    if (!this.orbiter) return;
    if (this._actionInFlight) return this._actionInFlight;

    this._actionInFlight = (async () => {
      // Update UI first
      this.currentState = 'playing';
      this.updateUI('playing');

      // Then tell engine
      try {
        await this.orbiter.play();
      } catch (error) {
        console.error('[Transport] Play failed:', error);
        // Revert on error
        this.currentState = 'stopped';
        this.updateUI('stopped');
      }
    })();

    try {
      await this._actionInFlight;
    } finally {
      this._actionInFlight = null;
    }
  }

  /**
   * Pause - updates UI to show paused state, then triggers engine
   */
  async pause() {
    if (!this.orbiter) return;
    if (this._actionInFlight) return this._actionInFlight;

    this._actionInFlight = (async () => {
      // Update UI first
      this.currentState = 'paused';
      this.updateUI('paused');

      // Then tell engine
      try {
        await this.orbiter.pause();
      } catch (error) {
        console.error('[Transport] Pause failed:', error);
      }
    })();

    try {
      await this._actionInFlight;
    } finally {
      this._actionInFlight = null;
    }
  }

  /**
   * Stop - updates UI to show stopped state, then triggers engine
   */
  async stop() {
    const capture = typeof window !== 'undefined' ? window.captureControl : null;
    if (this._actionInFlight) return this._actionInFlight;

    this._actionInFlight = (async () => {
      // Update UI first
      this.currentState = 'stopped';
      this.updateUI('stopped');
      capture?.stop?.();

      // Then tell engine
      try {
        await this.orbiter?.stop?.();
      } catch (error) {
        console.error('[Transport] Stop failed:', error);
      }
    })();

    try {
      await this._actionInFlight;
    } finally {
      this._actionInFlight = null;
    }
  }

  /**
   * Toggle play/pause
   */
  async toggle() {
    if (this.currentState === 'playing') {
      await this.pause();
    } else {
      await this.play();
    }
  }

  /**
   * Get current state
   */
  getState() {
    return this.currentState;
  }

  /**
   * Check if playing
   */
  isPlaying() {
    return this.currentState === 'playing';
  }
}

// De-singletonization: no module singleton — each voice constructs its own TransportControl
// in `orbitersApp` and registers it on the voice. Readers resolve it via `voiceRegistry`.
export { TransportControl };
