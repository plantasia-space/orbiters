// @vitest-environment jsdom
/**
 * MIDI-learn right-click context menu z-index ownership.
 *
 * Regression guard: opening the menu must NOT stamp an inline z-index. The layer is owned by the
 * `#midi-context-menu.show` CSS rule (a modest value that sits below a host page's shell chrome).
 * An inline z-index would win over that rule and re-raise the menu above the host chrome in the
 * de-iframed Feed embed — the exact stacking regression this guards against.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MidiContextMenu } from '../../src/input/midi/contextMenu.js';

describe('MidiContextMenu open() z-index', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="midi-context-menu">
        <div id="midi-context-learn"></div>
        <div id="midi-context-delete"></div>
        <div id="midi-context-close"></div>
      </div>
      <div id="target-widget" data-automatable="true"></div>
    `;
  });

  it('does not set an inline z-index on the menu when opened (CSS owns the layer)', () => {
    const menu = new MidiContextMenu({ onLearn() {}, onDelete() {}, onCancel() {} });
    const target = document.getElementById('target-widget');
    const event = { preventDefault() {}, stopPropagation() {} };

    menu.open(event, target);

    const el = document.getElementById('midi-context-menu');
    expect(el.classList.contains('show')).toBe(true);
    expect(el.style.zIndex).toBe(''); // no inline override — the .show CSS rule wins
  });
});
