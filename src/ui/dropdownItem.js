const WIDE_ICON_RATIO_THRESHOLD = 1.45;

function measureAspectRatio(svgElement) {
  const viewBox = svgElement.getAttribute('viewBox') || '';
  const parts = viewBox.trim().split(/\s+/).map(Number);
  const widthAttr = Number(svgElement.getAttribute('width'));
  const heightAttr = Number(svgElement.getAttribute('height'));
  const width = Number.isFinite(parts[2]) ? parts[2] : widthAttr;
  const height = Number.isFinite(parts[3]) ? parts[3] : heightAttr;

  if (!(width > 0) || !(height > 0)) {
    return 1;
  }

  return width / height;
}

export function ensureDropdownItemStructure(item, { label = null } = {}) {
  if (!item) {
    return { iconSlot: null, labelSpan: null };
  }

  let iconSlot = item.querySelector('.menu-icon-slot');
  let labelSpan = item.querySelector('.menu-item-label');
  let shortcutHint = item.querySelector(':scope > .shortcut-hint');
  const resolvedLabel = (label ?? item.dataset.label ?? item.textContent ?? '').trim();

  if (!iconSlot || !labelSpan) {
    const legacyIcon = item.querySelector(':scope > img.menu-item-icon, :scope > svg.menu-icon-svg');
    const legacyShortcut = shortcutHint?.cloneNode(true) || null;

    item.textContent = '';

    iconSlot = document.createElement('span');
    iconSlot.className = 'menu-icon-slot';

    labelSpan = document.createElement('span');
    labelSpan.className = 'menu-item-label';

    item.appendChild(iconSlot);
    item.appendChild(labelSpan);
    if (legacyShortcut) {
      item.appendChild(legacyShortcut);
      shortcutHint = legacyShortcut;
    } else {
      shortcutHint = null;
    }

    if (legacyIcon) {
      iconSlot.appendChild(legacyIcon);
    }
  }

  if (resolvedLabel) {
    labelSpan.textContent = resolvedLabel;
    item.dataset.label = resolvedLabel;
  }

  if (shortcutHint && shortcutHint.parentElement !== item) {
    item.appendChild(shortcutHint);
  }

  return { iconSlot, labelSpan };
}

export function prepareDropdownIconSvg(svgElement, className = 'menu-icon-svg') {
  if (!svgElement) {
    return svgElement;
  }

  const aspectRatio = measureAspectRatio(svgElement);

  svgElement.setAttribute('role', 'img');
  svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svgElement.classList.add(className);
  svgElement.classList.remove('menu-icon-svg--wide', 'menu-icon-svg--square');
  svgElement.classList.add(aspectRatio >= WIDE_ICON_RATIO_THRESHOLD ? 'menu-icon-svg--wide' : 'menu-icon-svg--square');

  return svgElement;
}
