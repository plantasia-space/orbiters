// @vitest-environment jsdom
/**
 * Numeric-keyboard interpolation is LOCKED to the axis+dimension captured
 * when it started, and the 9 (3 axis × 3 dim) targets are independent.
 *
 * The bug being fixed: the vanilla keyboard resolved the dimension dynamically every
 * frame (`param.activeDimensionId`), so switching dimension mid-ramp redirected the
 * interpolation to the now-active dimension. The React `interpolateTo` captures the
 * dimension at submit and writes through `setDimensionValue(rootParam, capturedDim,…)`.
 *
 * rAF + performance.now are driven manually so each frame is deterministic.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';
import { EngineProvider } from '../../src/react/engine/EngineContext.tsx';
import { useParameter } from '../../src/react/parameters/useParameter';

const DIMS = ['EW::I', 'EW::II', 'EW::III'];

let pm;
let engine;
let api;
let root;
let now;
let rafId;
let rafCbs; // id -> callback (stable ids so cancelAnimationFrame works across ticks)

function Probe({ rootParam }) {
  api = useParameter(rootParam, { priority: 2 });
  return createElement('div', null);
}

function mount(rootParam) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(createElement(EngineProvider, { value: engine }, createElement(Probe, { rootParam }))),
  );
}

function freshAxis(name, start = 0) {
  pm.addMultidimensionalParameter(name, DIMS, start, -180, 180, {
    isBidirectional: true,
    step: 0.01,
    scope: 'DIMENSION',
  });
  pm.setActiveDimension(DIMS[0]);
}

// Advance the manual clock by `ms` and run every rAF callback scheduled SO FAR. Each
// callback may schedule the next frame; those are collected for the following tick.
function tick(ms) {
  now += ms;
  const due = [...rafCbs.values()];
  rafCbs = new Map();
  act(() => due.forEach((cb) => cb(now)));
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  api = undefined;
  now = 0;
  rafId = 0;
  rafCbs = new Map();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb) => {
    const id = ++rafId;
    rafCbs.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id) => {
    rafCbs.delete(id);
  });
  pm = new ParameterManager();
  engine = createEngineContext({
    parameterManager: pm,
    midiController: { registerMidiLearnTarget: () => {}, unregisterMidiLearnTarget: () => {} },
  });
});

afterEach(() => {
  if (root) act(() => root.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parameter equilibrium (systemic reset value, not hardcoded)', () => {
  it('stores the registration default as the equilibrium and exposes it (single + multidim)', () => {
    pm.addParameter('bpm', 120, 20, 300, true); // single-dim, registered at 120
    pm.addMultidimensionalParameter('ax', DIMS, 0, -180, 180, { isBidirectional: true }); // multidim, eq 0
    expect(pm.getParameter('bpm').defaultValue).toBeCloseTo(120, 5);
    expect(pm.getParameter('ax').defaultValue).toBeCloseTo(0, 5);
  });

  it('keeps the equilibrium stable when the live value changes', () => {
    pm.addParameter('bpm', 120, 20, 300, true);
    pm.setRawValue('bpm', 200); // user moves it
    expect(pm.getParameter('bpm').defaultValue).toBeCloseTo(120, 5); // equilibrium unchanged
  });

  it('never overwrites the equilibrium on re-registration or single→multi upgrade (Codex)', () => {
    pm.addParameter('p', 120, 20, 300, true); // first registration → equilibrium 120
    pm.addParameter('p', 200, 20, 300, true); // re-register with a different value (e.g. track load)
    expect(pm.getParameter('p').defaultValue).toBeCloseTo(120, 5); // still 120
    // upgrading the same param to multidimensional must also preserve the first equilibrium
    pm.addMultidimensionalParameter('p', DIMS, 50, 20, 300, { isBidirectional: true });
    expect(pm.getParameter('p').defaultValue).toBeCloseTo(120, 5);
  });

  it('captureBinding surfaces the equilibrium so the keypad resets to it dynamically', () => {
    freshAxis('eq', 0); // registered with defaultValue 0
    mount('eq');
    expect(api.captureBinding().equilibrium).toBeCloseTo(0, 5);
  });
});

describe('interpolateTo — dimension lock (acceptance)', () => {
  it('keeps ramping the dimension active at submit, even after a mid-ramp dimension switch', () => {
    freshAxis('x', 0);
    mount('x'); // active EW::I
    act(() => api.interpolateTo(100, 1000)); // ramp 0→100 over 1s, captured = EW::I
    tick(250);
    expect(pm.getDimensionValue('x', 'EW::I')).toBeCloseTo(25, 1);
    // user switches active dimension mid-ramp — the classic bug trigger
    act(() => pm.setActiveDimension('EW::II'));
    tick(250); // now 500
    expect(pm.getDimensionValue('x', 'EW::I')).toBeCloseTo(50, 1); // ramp still on EW::I
    expect(pm.getDimensionValue('x', 'EW::II')).toBeCloseTo(0, 5); // EW::II untouched
    tick(500); // now 1000 → complete
    expect(pm.getDimensionValue('x', 'EW::I')).toBeCloseTo(100, 5);
    expect(pm.getDimensionValue('x', 'EW::II')).toBeCloseTo(0, 5);
  });

  it('runs independent concurrent ramps on two dimensions of the same axis (no leak)', () => {
    freshAxis('y', 0);
    mount('y');
    act(() => api.interpolateTo(60, 1000)); // ramp on EW::I
    act(() => pm.setActiveDimension('EW::II'));
    act(() => api.interpolateTo(-60, 1000)); // ramp on EW::II
    tick(500);
    expect(pm.getDimensionValue('y', 'EW::I')).toBeCloseTo(30, 1);
    expect(pm.getDimensionValue('y', 'EW::II')).toBeCloseTo(-30, 1);
    tick(500);
    expect(pm.getDimensionValue('y', 'EW::I')).toBeCloseTo(60, 5);
    expect(pm.getDimensionValue('y', 'EW::II')).toBeCloseTo(-60, 5);
    expect(pm.getDimensionValue('y', 'EW::III')).toBeCloseTo(0, 5); // third dimension never touched
  });

  it('a re-submit on the same dimension replaces (cancels) the in-flight ramp', () => {
    freshAxis('z', 0);
    mount('z');
    act(() => api.interpolateTo(100, 1000));
    tick(250); // 25
    act(() => api.interpolateTo(50, 0)); // immediate commit, must cancel the old ramp
    expect(pm.getDimensionValue('z', 'EW::I')).toBeCloseTo(50, 5);
    tick(1000); // the cancelled ramp would have continued toward 100
    expect(pm.getDimensionValue('z', 'EW::I')).toBeCloseTo(50, 5);
  });

  it('duration <= 0 applies immediately as a commit', () => {
    freshAxis('i0', 0);
    mount('i0');
    act(() => api.interpolateTo(42, 0));
    expect(pm.getDimensionValue('i0', 'EW::I')).toBeCloseTo(42, 5);
  });

  it('a direct drag on the same dimension takes over from its in-flight ramp', () => {
    freshAxis('g', 0);
    mount('g');
    act(() => api.interpolateTo(100, 1000));
    tick(250); // 25
    act(() => api.gestureProps.onPointerDownCapture()); // takeover cancels the ramp on EW::I
    act(() => api.onLive(70));
    tick(1000); // ramp must NOT resume and overwrite the drag value
    expect(pm.getDimensionValue('g', 'EW::I')).toBeCloseTo(70, 5);
  });

  it('binds to the axis×dim captured at OPEN, not the dimension active at submit (remote-switch safety)', () => {
    freshAxis('cb', 0);
    // Seed at LOW precedence (high priority number) so the ramp's writes (priority 2)
    // aren't blocked by PM's same-instant contention guard (it uses real Date.now()).
    pm.setDimensionValue('cb', 'EW::I', 10, 'seed', 100, { updateIntent: 'commit' });
    pm.setDimensionValue('cb', 'EW::II', 150, 'seed', 100, { updateIntent: 'commit' });
    pm.setActiveDimension('EW::I');
    mount('cb');
    // The wrapper snapshots the binding at keyboard-open (active = EW::I, value 10).
    // It also surfaces the parameter's equilibrium (registered defaultValue = 0 here).
    const binding = api.captureBinding();
    expect(binding).toEqual({ dim: 'EW::I', value: 10, equilibrium: 0, step: 0.01 });
    // A peer flips the active dimension while the modal is open.
    act(() => pm.setActiveDimension('EW::II'));
    // Submit with the captured binding → ramp targets EW::I from 10, NOT EW::II from 200.
    act(() => api.interpolateTo(20, 1000, binding));
    tick(500);
    expect(pm.getDimensionValue('cb', 'EW::I')).toBeCloseTo(15, 1);
    expect(pm.getDimensionValue('cb', 'EW::II')).toBeCloseTo(150, 5); // untouched
    tick(500);
    expect(pm.getDimensionValue('cb', 'EW::I')).toBeCloseTo(20, 5);
    expect(pm.getDimensionValue('cb', 'EW::II')).toBeCloseTo(150, 5);
  });

  it('cancels in-flight ramps on unmount (no post-unmount writes)', () => {
    freshAxis('u', 0);
    mount('u');
    act(() => api.interpolateTo(100, 1000));
    tick(250);
    const before = pm.getDimensionValue('u', 'EW::I');
    act(() => root.unmount());
    root = undefined;
    tick(1000);
    expect(pm.getDimensionValue('u', 'EW::I')).toBeCloseTo(before, 5);
  });
});
