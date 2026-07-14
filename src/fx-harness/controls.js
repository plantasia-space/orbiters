/**
 * @file fx-harness/controls.js
 * @description Tiny shared DOM builders for the harness tabs — one canonical
 *              slider row / toggle / hint so every tab reads the same.
 */

/**
 * @param {HTMLElement} container
 * @param {Array<{key: string, label: string, min: number, max: number, step: number, unit: string}>} rows
 * @param {object} params - Mutated in place as sliders move.
 * @param {() => void} onChange - Called after every param write.
 */
export function addSliderRows(container, rows, params, onChange) {
  rows.forEach((spec) => {
    const row = document.createElement('div');
    row.className = 'module';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = spec.label;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(spec.min);
    slider.max = String(spec.max);
    slider.step = String(spec.step);
    slider.value = String(params[spec.key]);
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = `${params[spec.key]}${spec.unit}`;
    slider.addEventListener('input', () => {
      params[spec.key] = Number(slider.value);
      value.textContent = `${slider.value}${spec.unit}`;
      onChange();
    });
    const initial = params[spec.key];
    slider.addEventListener('dblclick', () => {
      slider.value = String(initial);
      params[spec.key] = initial;
      value.textContent = `${initial}${spec.unit}`;
      onChange();
    });
    row.append(name, slider, value);
    container.appendChild(row);
  });
}

/**
 * @param {HTMLElement} container
 * @param {string} label
 * @param {boolean} initial
 * @param {(checked: boolean) => void} onChange
 */
export function addToggle(container, label, initial, onChange) {
  const row = document.createElement('div');
  row.className = 'row';
  const wrap = document.createElement('label');
  wrap.className = 'toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = initial;
  checkbox.addEventListener('change', () => onChange(checkbox.checked));
  wrap.append(checkbox, document.createTextNode(label));
  row.appendChild(wrap);
  container.appendChild(row);
}

/**
 * @param {HTMLElement} container
 * @param {string} text
 */
export function addHint(container, text) {
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = text;
  container.appendChild(hint);
}
