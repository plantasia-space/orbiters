// @vitest-environment jsdom
/**
 * useLoopControls: the orbiter loop logic (snap grid, in/out at playhead, loop-size in
 * beats, grid origin, engage) reproduced from PeaksView for the kit panel. Drives a fake
 * waveformData surface and asserts the beat math + the engine writes (setLoopSec / setGridMarkerSec).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useLoopControls } from '../../src/ui/react/regions/useLoopControls.ts';

function makeData(overrides = {}) {
  const calls = { setLoopSec: [], setLoopActive: [], setGridMarkerSec: [] };
  let pos = 0;
  const data = {
    getWaveformUrl: () => null,
    getDurationSec: () => 32,
    getPositionSec: () => pos,
    seek: () => {},
    getLoopRangeSec: () => null,
    setLoopSec: (r) => calls.setLoopSec.push(r),
    isLoopActive: () => false,
    setLoopActive: (a) => calls.setLoopActive.push(a),
    hasLoopRange: () => false,
    getTrackBpm: () => 120, // beatSec = 0.5
    getGridMarkerSec: () => 0,
    setGridMarkerSec: (s) => calls.setGridMarkerSec.push(s),
    // The kit panel broadcasts/subscribes loop toggles through the data facade now.
    broadcastLoopToggle: (enabled) => calls.broadcastLoopToggle?.push(enabled),
    subscribeLoopToggle: () => () => {},
    ...overrides,
  };
  calls.broadcastLoopToggle = [];
  return { data, calls, setPos: (p) => { pos = p; } };
}

// visibleSec 64 → visibleBeats = 64/0.5 = 128 (≥64) → snap step = 4 beats = 2s grid.
const VISIBLE = () => 64;
const last = (arr) => arr[arr.length - 1];

let controls;
let root;
function mount(data, onGridCommit) {
  function Probe() {
    controls = useLoopControls(data, { trackKey: 't', getVisibleSec: VISIBLE, onGridCommit });
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(createElement(Probe)));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe('useLoopControls', () => {
  it('selectLoopSize(4) makes a 2s loop at the snapped playhead and engages it', () => {
    const { data, calls, setPos } = makeData();
    mount(data);
    setPos(0);
    act(() => controls.selectLoopSize(4));
    expect(last(calls.setLoopSec)).toEqual({ startSec: 0, endSec: 2 }); // 4 beats × 0.5s
    expect(controls.selectedSizeBeats).toBe(4);
    expect(controls.loopActive).toBe(true);
  });

  it('loopIn + loopOut build an ordered, snapped loop', () => {
    const { data, calls, setPos } = makeData();
    mount(data);
    setPos(2.3);
    act(() => controls.loopIn()); // anchor snaps to 2
    setPos(10.1);
    act(() => controls.loopOut()); // end snaps to 10
    expect(last(calls.setLoopSec)).toEqual({ startSec: 2, endSec: 10 });
  });

  it('snap off → loop uses raw (clamped) positions', () => {
    const { data, calls, setPos } = makeData();
    mount(data);
    act(() => controls.toggleSnap()); // snap off
    setPos(2.3);
    act(() => controls.loopIn());
    setPos(10.1);
    act(() => controls.loopOut());
    expect(last(calls.setLoopSec)).toEqual({ startSec: 2.3, endSec: 10.1 });
  });

  it('no BPM → size presets are disabled (hasBpm false, no write)', () => {
    const { data, calls } = makeData({ getTrackBpm: () => null });
    mount(data);
    expect(controls.hasBpm).toBe(false);
    act(() => controls.selectLoopSize(4));
    expect(calls.setLoopSec).toHaveLength(0);
  });

  it('toggleLoop with no loop creates a full-track loop, engaged', () => {
    const { data, calls } = makeData();
    mount(data);
    act(() => controls.toggleLoop());
    expect(last(calls.setLoopSec)).toEqual({ startSec: 0, endSec: 32 });
    expect(controls.loopActive).toBe(true);
  });

  it('setGridMarker snaps the playhead, writes the grid origin, and persists via onGridCommit', () => {
    const { data, calls, setPos } = makeData();
    let committed = null;
    mount(data, (s) => { committed = s; });
    setPos(3.1); // snaps to 4 (2s grid)
    act(() => controls.setGridMarker());
    expect(last(calls.setGridMarkerSec)).toBe(4);
    expect(committed).toBe(4);
  });

  it('loopIn makes canLoopOut reactive so the Out button re-enables (regression: was a ref)', () => {
    const { data, setPos } = makeData();
    mount(data);
    expect(controls.canLoopOut).toBe(false);
    setPos(2);
    act(() => controls.loopIn());
    expect(controls.canLoopOut).toBe(true);
  });

  it('loopOut before an existing loop start does not relocate/invert it', () => {
    const { data, calls, setPos } = makeData({ getLoopRangeSec: () => ({ startSec: 10, endSec: 20 }) });
    mount(data);
    setPos(2); // before the loop start → no forward range
    act(() => controls.loopOut());
    expect(calls.setLoopSec).toHaveLength(0);
  });

  it('dragging an armed-OFF loop keeps it disengaged (does not force loop on)', () => {
    const { data, calls } = makeData({ getLoopRangeSec: () => ({ startSec: 8, endSec: 16 }), isLoopActive: () => false });
    mount(data);
    expect(controls.loopActive).toBe(false);
    act(() => controls.setLoopRange({ startSec: 9, endSec: 17 }));
    expect(last(calls.setLoopActive)).toBe(false);
    expect(controls.loopActive).toBe(false);
  });

  it('clearLoop clears the engine loop and resets state', () => {
    const { data, calls } = makeData();
    mount(data);
    act(() => controls.selectLoopSize(4));
    act(() => controls.clearLoop());
    expect(last(calls.setLoopSec)).toBeNull();
    expect(controls.loop).toBeNull();
    expect(controls.loopActive).toBe(false);
    expect(controls.selectedSizeBeats).toBeNull();
  });
});
