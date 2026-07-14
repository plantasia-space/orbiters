// @vitest-environment jsdom
//
// Example of testing DOM-touching code. The `@vitest-environment jsdom`
// comment above gives this file a real `document`/`window` — something the
// old `node --test` runner could not provide. Pure-logic tests omit it and
// run in the faster default `node` environment (see loopRange.test.js).
import { describe, it, expect } from 'vitest';

import {
  ensureDropdownItemStructure,
  prepareDropdownIconSvg,
} from '../../../src/ui/dropdownItem.js';

function makeItem(html = '') {
  const item = document.createElement('div');
  item.innerHTML = html;
  return item;
}

describe('ensureDropdownItemStructure', () => {
  it('builds icon + label slots and records the label on the dataset', () => {
    const item = makeItem();
    const { iconSlot, labelSpan } = ensureDropdownItemStructure(item, { label: 'Reverb' });

    expect(iconSlot?.className).toBe('menu-icon-slot');
    expect(labelSpan?.className).toBe('menu-item-label');
    expect(labelSpan?.textContent).toBe('Reverb');
    expect(item.dataset.label).toBe('Reverb');
    // Slots are actually attached to the item, in order.
    expect(item.querySelector('.menu-icon-slot')).toBe(iconSlot);
    expect(item.querySelector('.menu-item-label')).toBe(labelSpan);
  });

  it('reuses existing structure instead of rebuilding it', () => {
    const item = makeItem(
      '<span class="menu-icon-slot"></span><span class="menu-item-label">Old</span>',
    );
    const originalSlot = item.querySelector('.menu-icon-slot');

    const { iconSlot, labelSpan } = ensureDropdownItemStructure(item, { label: 'New' });

    expect(iconSlot).toBe(originalSlot); // same node, not recreated
    expect(labelSpan.textContent).toBe('New');
  });

  it('returns null slots for a nullish item', () => {
    expect(ensureDropdownItemStructure(null)).toEqual({ iconSlot: null, labelSpan: null });
  });
});

describe('prepareDropdownIconSvg', () => {
  it('tags a wide viewBox as the wide variant', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 200 100'); // ratio 2.0 -> wide
    prepareDropdownIconSvg(svg);

    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.classList.contains('menu-icon-svg')).toBe(true);
    expect(svg.classList.contains('menu-icon-svg--wide')).toBe(true);
    expect(svg.classList.contains('menu-icon-svg--square')).toBe(false);
  });

  it('tags a square viewBox as the square variant', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); // ratio 1.0 -> square
    prepareDropdownIconSvg(svg);

    expect(svg.classList.contains('menu-icon-svg--square')).toBe(true);
    expect(svg.classList.contains('menu-icon-svg--wide')).toBe(false);
  });
});
