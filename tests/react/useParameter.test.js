// @vitest-environment jsdom
/**
 * useParameter against the REAL ParameterManager, through the INJECTED EngineContext.
 *
 * Phase 0 (strategy §3): the hook no longer imports Main.js or reads
 * window.MIDIControllerInstance — it reads `params`+`midi` from `EngineContext`.
 * The test therefore builds the boundary the same way the app does: a fresh
 * ParameterManager + a fake MIDI controller wrapped in `createEngineContext`, and
 * provides it via `<EngineProvider>`. This both exercises genuine PM logic and
 * proves the boundary is real + testable (the point of the refactor).
 *
 * Focus: the per-dimension write invariant + the gesture freeze the Codex review
 * flagged (commit-after-dimension-switch must land in the CAPTURED dimension), plus
 * the STABLE LOGICAL MIDI id contract (§6 — id derives from componentId, no remount
 * churn).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';
import { EngineProvider } from '../../src/react/engine/EngineContext.tsx';
import { useParameter } from '../../src/react/parameters/useParameter';

const DIMS = ['EW::I', 'EW::II', 'EW::III'];

let pm; // fresh ParameterManager per test
let engine; // the injected EngineContext value
let midiCalls; // captured MIDI register/unregister for the MIDI suite

let api; // latest hook return, refreshed every render
function Probe({ rootParam, midi }) {
  api = useParameter(rootParam, { priority: 2, midi });
  // Render the control's DOM root (with midiProps) so getElementById finds it.
  return createElement('div', api.midiProps ?? null);
}

let root;
function mount(rootParam, midi) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(EngineProvider, { value: engine }, createElement(Probe, { rootParam, midi })),
    ),
  );
}

afterEach(() => {
  if (root) act(() => root.unmount());
  root = undefined;
});

function freshAxis(name) {
  pm.addMultidimensionalParameter(name, DIMS, 0, -180, 180, {
    isBidirectional: true,
    step: 0.01,
    scope: 'DIMENSION',
  });
  pm.setActiveDimension(DIMS[0]);
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  api = undefined;
  pm = new ParameterManager();
  midiCalls = { reg: [], unreg: [] };
  engine = createEngineContext({
    parameterManager: pm,
    midiController: {
      registerMidiLearnTarget: (b) => midiCalls.reg.push(b),
      unregisterMidiLearnTarget: (id) => midiCalls.unreg.push(id),
    },
  });
});

describe('useParameter — intents & per-dimension writes', () => {
  it('seeds the display from the active dimension on subscribe', () => {
    freshAxis('x');
    pm.setDimensionValue('x', 'EW::I', 12, null, 0, { updateIntent: 'commit' });
    mount('x');
    expect(api.value).toBeCloseTo(12, 5);
  });

  it('writes live during a gesture and a final commit on release', () => {
    freshAxis('y');
    mount('y');
    act(() => api.onLive(30));
    expect(pm.getDimensionValue('y', 'EW::I')).toBeCloseTo(30, 5);
    act(() => api.onCommit(45));
    expect(pm.getDimensionValue('y', 'EW::I')).toBeCloseTo(45, 5);
  });

  it('commit lands in the CAPTURED dimension after a mid-gesture dimension switch (Codex footgun)', () => {
    freshAxis('z');
    mount('z');
    // gesture starts on EW::I
    act(() => api.gestureProps.onPointerDownCapture());
    act(() => api.onLive(60));
    expect(pm.getDimensionValue('z', 'EW::I')).toBeCloseTo(60, 5);
    // user switches the active dimension mid-drag
    act(() => pm.setActiveDimension('EW::II'));
    // display stays frozen on the gesture value (does NOT jump to EW::II's value)
    expect(api.value).toBeCloseTo(60, 5);
    // release commits to the captured dimension (EW::I), not the now-active EW::II
    act(() => api.onCommit(75));
    expect(pm.getDimensionValue('z', 'EW::I')).toBeCloseTo(75, 5);
    expect(pm.getDimensionValue('z', 'EW::II')).toBeCloseTo(0, 5);
    // and the display resyncs to the now-active dimension (EW::II = 0), not the
    // captured dimension's just-committed 75 (Codex blocker #1).
    expect(api.value).toBeCloseTo(0, 5);
  });

  it('freezes the display against external writes while a gesture is active', () => {
    freshAxis('fx');
    mount('fx');
    act(() => api.gestureProps.onPointerDownCapture());
    act(() => api.onLive(20));
    // external (MIDI/LFO-style) write to the active dimension during the gesture
    act(() => pm.setDimensionValue('fx', 'EW::I', -100, 'ext', 1, { updateIntent: 'commit' }));
    expect(api.value).toBeCloseTo(20, 5); // frozen, not -100
  });

  it('commit fires even when the value is unchanged (notifyIfUnchanged parity)', () => {
    freshAxis('uc');
    mount('uc');
    act(() => api.onCommit(0)); // equals the equilibrium default
    const seen = [];
    const logger = { onParameterChanged: (_n, v, _d, m) => seen.push(m?.reason) };
    pm.subscribe(logger, 'uc', 50, null);
    seen.length = 0;
    act(() => api.onCommit(0)); // still unchanged
    expect(seen).toContain('unchanged-commit');
    pm.unsubscribe(logger, 'uc');
  });
});

describe('useParameter — lock mirrors the active dimension', () => {
  it('reflects a per-dimension lock only when that dimension is active', () => {
    freshAxis('lk');
    mount('lk');
    expect(api.locked).toBe(false);
    act(() => pm.lockParameterDimension('lk', 'EW::II'));
    expect(api.locked).toBe(false); // EW::I active, EW::II locked
    act(() => pm.setActiveDimension('EW::II'));
    expect(api.locked).toBe(true);
    act(() => pm.setActiveDimension('EW::I'));
    expect(api.locked).toBe(false);
  });

  it('reflects an all-parameter lock regardless of dimension', () => {
    freshAxis('la');
    mount('la');
    act(() => pm.lockParameter('la'));
    expect(api.locked).toBe(true);
    act(() => pm.unlockParameter('la'));
    expect(api.locked).toBe(false);
  });

  it('discovers a lock that existed on an inactive dimension BEFORE mount (Codex #3)', () => {
    freshAxis('pl');
    pm.lockParameterDimension('pl', 'EW::II'); // lock a non-active dimension before mounting
    mount('pl'); // active = EW::I
    expect(api.locked).toBe(false);
    act(() => pm.setActiveDimension('EW::II'));
    expect(api.locked).toBe(true); // querying PM directly surfaces the pre-existing lock
  });
});

describe('useParameter — gesture listener hygiene (Codex #2)', () => {
  it('removes every gesture listener when a gesture ends (no leak / no stale enders)', () => {
    freshAxis('gl');
    mount('gl');
    const gestureEvents = new Set(['pointerup', 'pointercancel', 'blur']);
    const added = [];
    const removed = [];
    const origAdd = window.addEventListener;
    const origRemove = window.removeEventListener;
    window.addEventListener = (type, fn, ...rest) => { if (gestureEvents.has(type)) added.push(type); return origAdd.call(window, type, fn, ...rest); };
    window.removeEventListener = (type, fn, ...rest) => { if (gestureEvents.has(type)) removed.push(type); return origRemove.call(window, type, fn, ...rest); };
    try {
      act(() => api.gestureProps.onPointerDownCapture()); // adds 3
      act(() => api.onLive(10));
      act(() => api.onCommit(10)); // finishGesture removes all 3
      expect(added.sort()).toEqual(['blur', 'pointercancel', 'pointerup']);
      expect(removed.sort()).toEqual(['blur', 'pointercancel', 'pointerup']);
    } finally {
      window.addEventListener = origAdd;
      window.removeEventListener = origRemove;
    }
  });
});

describe('useParameter — scoped MIDI registration through the injected boundary', () => {
  it('exposes no midiProps and registers nothing when midi is absent', () => {
    freshAxis('m0');
    mount('m0');
    expect(api.midiProps).toBeUndefined();
    expect(midiCalls.reg).toHaveLength(0);
  });

  it('registers a typed scoped-binding record over the mount lifecycle, keyed by a STABLE logical id', () => {
    freshAxis('mx');
    // simulate what the wrapper supplies: componentType + range, plus componentId
    mount('mx', { componentId: 'mx.knob', componentType: 'knob', min: -180, max: 180 });

    // Stable logical id (§6): derived from componentId, no remount-churning suffix.
    const id = api.midiProps.id;
    expect(id).toBe('pm-mx.knob');
    expect(api.midiProps).toEqual({ id, 'data-automatable': 'true' });

    // the scoped metadata travels as a typed record, not DOM attributes
    expect(midiCalls.reg).toHaveLength(1);
    expect(midiCalls.reg[0]).toMatchObject({
      id,
      componentId: 'mx.knob',
      componentType: 'knob',
      axis: 'mx',
      min: -180,
      max: 180,
    });
    expect(midiCalls.reg[0].element).toBe(document.getElementById(id));

    act(() => root.unmount());
    root = undefined;
    expect(midiCalls.unreg).toEqual([id]); // deterministic cleanup (the WAC path's missing piece)
  });

  it('a control gets the same id across remounts (overlays keyed by id survive remount, §6)', () => {
    freshAxis('rm');
    mount('rm', { componentId: 'rm.knob' });
    const first = api.midiProps.id;
    act(() => root.unmount());
    mount('rm', { componentId: 'rm.knob' });
    const second = api.midiProps.id;
    expect(second).toBe(first);
    expect(first).toBe('pm-rm.knob');
  });

  // In the multi-orbiter realm every tile renders the same controls (same componentId →
  // same `pm-<componentId>`); without a per-voice prefix `document.getElementById` resolves only the
  // FIRST tile and the learn overlays + target registration collide. The engine context's voiceId
  // scopes the DOM id. Single-orbiter (voiceId null, the suite default above) stays bare → byte-identical.
  it('prefixes the MIDI target id with the engine voiceId, leaving componentId (mapping key) intact', () => {
    freshAxis('vx'); // same shared ParameterManager as the suite
    const midiV2 = { reg: [], unreg: [] };
    const engineV2 = createEngineContext({
      parameterManager: pm,
      voiceId: 'v2',
      midiController: {
        registerMidiLearnTarget: (b) => midiV2.reg.push(b),
        unregisterMidiLearnTarget: (id) => midiV2.unreg.push(id),
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const localRoot = createRoot(container);
    act(() =>
      localRoot.render(
        createElement(EngineProvider, { value: engineV2 },
          createElement(Probe, { rootParam: 'vx', midi: { componentId: 'vx.knob' } })),
      ),
    );

    expect(api.midiProps.id).toBe('v2-pm-vx.knob'); // voice-scoped DOM id
    expect(midiV2.reg).toHaveLength(1);
    expect(midiV2.reg[0].id).toBe('v2-pm-vx.knob'); // registered under the scoped id
    expect(midiV2.reg[0].element).toBe(document.getElementById('v2-pm-vx.knob')); // resolves to THIS tile
    expect(midiV2.reg[0].componentId).toBe('vx.knob'); // logical key unchanged → persisted mappings carry over
    expect(midiV2.reg[0].voiceId).toBe('v2'); // binding carries its voice → inbound MIDI routes to v2's PM

    act(() => localRoot.unmount());
    expect(midiV2.unreg).toEqual(['v2-pm-vx.knob']);
  });
});
