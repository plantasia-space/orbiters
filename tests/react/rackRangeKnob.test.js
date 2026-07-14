// @vitest-environment jsdom
/**
 * The min / equilibrium / max knobs on each axis of the Orbiter Studio rack.
 *
 * Two defects they had, both reproduced here:
 *  1. They snapped to a grid of a HUNDREDTH of the domain — a step of 2 on the usual -100..100 module,
 *     so odd values were unreachable and every pointer move jumped a visible notch.
 *  2. They are CONTROLLED (the library Knob/ValueParam draw the value they are handed and keep none of
 *     their own), while the panel deliberately does not re-render mid-gesture — so they sat frozen for
 *     the whole drag and jumped once on release. The knob must follow the finger from its own draft.
 */
import React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { RackFolder } from '../../src/orbiter/edit/react/RackFolder';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The design library's controls are the real thing elsewhere; here we stand them in with probes that
// expose what they were HANDED (value/step) and let a test drive their live/commit callbacks. That is
// exactly the seam the bug lived in: what the panel feeds them during a gesture.
const knobs = [];
const boxes = [];
vi.mock('plantasia.space-design/react/arrow', () => ({
  Knob: (props) => { knobs.push(props); return null; },
  ValueParam: (props) => { boxes.push(props); return null; },
}));
// The X/Y/Z rail is a Tabs; capture its onValueChange so a test can switch axis the way a tap does.
let switchAxis = () => {};
vi.mock('plantasia.space-design/react', () => ({
  Tabs: ({ onValueChange, children }) => { switchAxis = onValueChange; return children; },
  TabsList: ({ children }) => children,
  TabsTrigger: ({ children }) => children,
  Switch: () => null,
  Button: ({ children }) => children,
  EntitySearchCombobox: () => null,
  Skeleton: () => null,
}));
vi.mock('../../src/ui/studioChromeTheme.js', () => ({
  applyStudioChromeTheme: () => Promise.resolve(),
  clearStudioChromeTheme: () => {},
}));

/** An axis slot. Defaults to the most common module domain: -100..100 (pitch shift, granular, …). */
function axisSlot({
  axis = 'x', moduleKey = 'tonePitchShift::pitch', min = -100, max = 100, units = '%',
  range = { min: -60, max: 60, equilibrium: 0 },
  defaults = { min, max, equilibrium: 0 }, // the module's DESIGNED values (the reset targets)
} = {}) {
  return {
    axis,
    visualFeedback: null,
    slot: {
      moduleKey,
      domain: { min, max },
      units,
      defaults,
      range,
    },
  };
}

let root;
let container;

function renderRack(axes, onRangeChange, dimensionId = 'dim-1') {
  act(() => {
    root.render(React.createElement(RackFolder, {
      axes,
      dimensionId,
      moduleOptions: [
        { value: 'tonePitchShift::pitch', label: 'Pitch' },
        { value: 'toneFilter::freq', label: 'Filter' },
      ],
      onModuleChange: () => {},
      onRangeChange,
      onVisualFeedbackChange: () => {},
      engineLock: null,
    }));
  });
}

/** Mount the rack. `axes` defaults to a single X axis on the -100..100 module. */
function mountRack(onRangeChange = () => {}, axes = [axisSlot()]) {
  knobs.length = 0;
  boxes.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  renderRack(axes, onRangeChange);
  return (nextAxes, dimensionId) => renderRack(nextAxes, onRangeChange, dimensionId);
}

afterEach(() => {
  if (root) act(() => root.unmount());
  root = null;
  document.body.innerHTML = '';
});

/** The knob for a given range key, by its aria-label ("Min X" / "Equil X" / "Max X"). */
const knobFor = (label) => knobs.filter((k) => k['aria-label'] === label).at(-1);
const boxFor = (label) => boxes.filter((b) => b.label === label).at(-1);

describe('rack range knobs', () => {
  it('has no snap grid — every value in the domain is reachable', () => {
    mountRack();
    // The old (max-min)/100 gave a step of 2 on -100..100: odd values were unreachable and typing 45
    // landed on 46. Zero is the library's "continuous" — knob and box both skip snapping entirely.
    expect(knobFor('Min X').step).toBe(0);
    expect(boxFor('Min X').step).toBe(0);
  });

  it('leaves a designed value exact on an awkward domain (20..20000 Hz)', () => {
    // A merely FINER range-relative grid would still misalign: (20000-20)/1000 = 19.98, which snaps the
    // designed 800 Hz to 799.22. No grid, no misalignment.
    mountRack(() => {}, [axisSlot({
      moduleKey: 'toneFilter::freq', min: 20, max: 20000, units: 'Hz',
      range: { min: 200, max: 8000, equilibrium: 800 },
    })]);

    expect(knobFor('Equil X').step).toBe(0);
    expect(knobFor('Equil X').value).toBe(800);
    expect(boxFor('Equil X').precision).toBe(0);          // a tenth of a Hz is noise
    expect(boxFor('Equil X').format(800)).toBe('800 Hz');
  });

  it('shows a readout matched to the domain width', () => {
    mountRack();
    const box = boxFor('Min X');
    expect(box.precision).toBe(1); // -100..100 -> one decimal
    expect(box.format(-59.4)).toBe('-59.4 %');
  });

  it('follows the finger during a drag, even though the panel does not re-render', () => {
    // The panel commits to the bridge but deliberately skips the re-render while shouldBroadcast is
    // false — so nothing feeds a new `value` prop back. The knob must still move.
    const onRangeChange = vi.fn();
    mountRack(onRangeChange);
    expect(knobFor('Min X').value).toBe(-60);

    act(() => knobFor('Min X').onValueChange(-59.4)); // a live pointer move

    // Both halves track the gesture off the shared draft — the needle AND the number box.
    expect(knobFor('Min X').value).toBe(-59.4);
    expect(boxFor('Min X').value).toBe(-59.4);
    // …and the value still went to the bridge as a live (non-broadcast) change.
    expect(onRangeChange).toHaveBeenCalledWith('x', 0, 'min', -59.4, { shouldBroadcast: false });
  });

  it('keeps the drag position on release, and broadcasts the commit', () => {
    const onRangeChange = vi.fn();
    mountRack(onRangeChange);

    act(() => knobFor('Min X').onValueChange(-59.4));
    act(() => knobFor('Min X').onValueCommit(-59.4)); // pointer up

    expect(knobFor('Min X').value).toBe(-59.4); // no jump back to the pre-drag value
    expect(onRangeChange).toHaveBeenLastCalledWith('x', 0, 'min', -59.4, { shouldBroadcast: true });
  });

  it('drives the knob from the value box too (they share one draft)', () => {
    mountRack();
    act(() => boxFor('Max X').onValueChange(72.5)); // typed / keypad entry

    expect(knobFor('Max X').value).toBe(72.5);
    expect(boxFor('Max X').value).toBe(72.5);
  });

  it('does not carry an uncommitted draft from one axis to another', () => {
    // The nastiest shape: an in-flight drag on X, then a tap to Y whose min happens to hold the SAME
    // number. The re-seed can only notice a different value, so without a per-slot identity the knob
    // would keep showing X's uncommitted draft for Y — and write it into Y on the next touch.
    const onRangeChange = vi.fn();
    mountRack(onRangeChange, [
      axisSlot({ axis: 'x', range: { min: -60, max: 60, equilibrium: 0 } }),
      axisSlot({ axis: 'y', range: { min: -60, max: 60, equilibrium: 0 } }), // same numbers as X
    ]);

    act(() => knobFor('Min X').onValueChange(-59.4)); // dragging X's min, not committed
    expect(knobFor('Min X').value).toBe(-59.4);

    act(() => switchAxis('y')); // tap the Y tab

    expect(knobFor('Min Y').value).toBe(-60); // Y's OWN value, not X's draft
    expect(boxFor('Min Y').value).toBe(-60);
  });

  it('does not carry a draft across a module change on the same axis', () => {
    const onRangeChange = vi.fn();
    const rerender = mountRack(onRangeChange, [axisSlot()]);

    act(() => knobFor('Min X').onValueChange(-59.4));
    expect(knobFor('Min X').value).toBe(-59.4);

    // The axis now holds a different module — same axis, same range key, different slot entirely.
    act(() => rerender([axisSlot({
      moduleKey: 'toneFilter::freq', min: 20, max: 20000, units: 'Hz',
      range: { min: 200, max: 8000, equilibrium: 800 },
    })]));

    expect(knobFor('Min X').value).toBe(200); // the new module's value, not the old draft
  });

  it('does not carry a draft across a DIMENSION switch (same axis, same module, same value)', () => {
    // The dimension tabs (I / II / III) swap the racks under the same elements. Same axis, same module,
    // same number on the other dimension → neither the value nor a slot-only key would notice.
    const rerender = mountRack(() => {}, [axisSlot()]);

    act(() => knobFor('Min X').onValueChange(-59.4)); // uncommitted on dimension I
    expect(knobFor('Min X').value).toBe(-59.4);

    act(() => rerender([axisSlot()], 'dim-2')); // tap dimension II — identical rack, different dimension

    expect(knobFor('Min X').value).toBe(-60); // dimension II's own value, not I's draft
  });

  it('stores exactly what it shows (no hidden sub-display drift)', () => {
    // The controls are continuous, so a drag can land on -59.4372 while the box reads -59.4. The value
    // that reaches the bridge is the one on screen.
    const onRangeChange = vi.fn();
    mountRack(onRangeChange);

    act(() => knobFor('Min X').onValueChange(-59.4372));

    expect(onRangeChange).toHaveBeenCalledWith('x', 0, 'min', -59.4, { shouldBroadcast: false });
    expect(knobFor('Min X').value).toBe(-59.4);
    expect(boxFor('Min X').format(knobFor('Min X').value)).toBe('-59.4 %');
  });

  it('offers the DESIGNED reset to both halves, not just the knob', () => {
    // Double-clicking the value box reset to the domain floor when it was not given the designed value —
    // a 20..20000 Hz equilibrium designed at 800 would have landed on 20.
    mountRack(() => {}, [axisSlot({
      moduleKey: 'toneFilter::freq', min: 20, max: 20000, units: 'Hz',
      range: { min: 200, max: 8000, equilibrium: 800 },
      defaults: { min: 20, max: 20000, equilibrium: 800 }, // designed equilibrium: 800 Hz
    })]);

    expect(knobFor('Equil X').defaultValue).toBe(800); // the module's designed equilibrium…
    expect(boxFor('Equil X').defaultValue).toBe(800);  // …and the box resets to it too, not to 20
  });

  it('each range key moves independently', () => {
    mountRack();
    act(() => knobFor('Min X').onValueChange(-59.4));

    expect(knobFor('Min X').value).toBe(-59.4);
    expect(knobFor('Equil X').value).toBe(0);  // untouched
    expect(knobFor('Max X').value).toBe(60);   // untouched
  });
});
