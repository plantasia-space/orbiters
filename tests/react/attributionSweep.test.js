// @vitest-environment jsdom
/**
 * The automatic attribution sweep for video capture. `armAttributionSweep` wires the
 * capture-state event to a timed Info-panel sequence (Track → Entangled World → Orbiter → engine
 * Monitor). These tests drive the pure controller with fake timers and a mocked Info surface, so
 * the sequencing, the per-second re-fire guard, missing-data skips, and early-stop abort are all
 * covered without a browser or a real screen-capture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { armAttributionSweep } from '../../src/ui/react/regions/AttributionSweep.tsx';
import { CAPTURE_STATES, CAPTURE_STATE_CHANGE_EVENT } from '../../src/export/capture.js';

const fire = (state) =>
  window.dispatchEvent(new CustomEvent(CAPTURE_STATE_CHANGE_EVENT, { detail: { state } }));

const FULL_TAGS = {
  track: [{ label: 'Track', value: 'andante dub' }],
  'entangled-world': [{ label: 'World', value: 'Kepler' }],
  orbiter: [{ label: 'Orbiter', value: 'X' }],
  monitor: [],
};

function arm({ tags = FULL_TAGS, initialState = CAPTURE_STATES.idle } = {}) {
  const setMode = vi.fn();
  const getTags = vi.fn((mode) => tags[mode] ?? []);
  const cleanup = armAttributionSweep({
    getTags,
    setMode,
    getCaptureState: () => initialState,
  });
  const modes = () => setMode.mock.calls.map((c) => c[0]);
  return { setMode, getTags, cleanup, modes };
}

describe('armAttributionSweep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sweeps track → world → orbiter, then returns to the engine monitor (~3s each)', async () => {
    const { setMode, modes, cleanup } = arm();

    fire(CAPTURE_STATES.recording);
    expect(setMode).toHaveBeenNthCalledWith(1, 'track');

    await vi.advanceTimersByTimeAsync(3000);
    expect(setMode).toHaveBeenNthCalledWith(2, 'entangled-world');

    await vi.advanceTimersByTimeAsync(3000);
    expect(setMode).toHaveBeenNthCalledWith(3, 'orbiter');

    await vi.advanceTimersByTimeAsync(3000);
    expect(modes()).toEqual(['track', 'entangled-world', 'orbiter', 'monitor']);
    cleanup();
  });

  it('does not restart on the per-second recording re-fire', async () => {
    const { setMode, modes, cleanup } = arm();

    fire(CAPTURE_STATES.recording); // starts the sweep → 'track'
    fire(CAPTURE_STATES.recording); // ticker re-fire — must be ignored
    fire(CAPTURE_STATES.recording);
    expect(setMode).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9000);
    // Exactly one sweep ran — no duplicate steps from the re-fires.
    expect(modes()).toEqual(['track', 'entangled-world', 'orbiter', 'monitor']);
    cleanup();
  });

  it('skips a credit with no data (graceful missing attribution)', async () => {
    const { modes, cleanup } = arm({
      tags: { ...FULL_TAGS, 'entangled-world': [] },
    });

    fire(CAPTURE_STATES.recording);
    await vi.advanceTimersByTimeAsync(3000); // 'track' shown 3s, empty world skipped → 'orbiter'
    await vi.advanceTimersByTimeAsync(3000); // 'orbiter' shown 3s → 'monitor'
    expect(modes()).toEqual(['track', 'orbiter', 'monitor']);
    cleanup();
  });

  it('aborts an in-flight sweep and returns to the monitor when recording stops early', async () => {
    const { modes, cleanup } = arm();

    fire(CAPTURE_STATES.recording); // 'track'
    await vi.advanceTimersByTimeAsync(3000); // 'entangled-world'
    fire(CAPTURE_STATES.saving); // user stops before the sweep completes
    await vi.advanceTimersByTimeAsync(0); // flush the woken awaiter
    expect(modes()).toEqual(['track', 'entangled-world', 'monitor']);

    // No further panel changes after the abort.
    await vi.advanceTimersByTimeAsync(9000);
    expect(modes()).toEqual(['track', 'entangled-world', 'monitor']);
    cleanup();
  });

  it('treats a throwing credits provider as missing data (recording is never broken)', async () => {
    const setMode = vi.fn();
    const cleanup = armAttributionSweep({
      getTags: (mode) => {
        if (mode === 'entangled-world') throw new Error('provider blew up');
        return FULL_TAGS[mode] ?? [];
      },
      setMode,
      getCaptureState: () => CAPTURE_STATES.idle,
    });

    fire(CAPTURE_STATES.recording);
    await vi.advanceTimersByTimeAsync(9000);
    // The throwing step is skipped, the sweep completes, and the UI returns to the monitor.
    expect(setMode.mock.calls.map((c) => c[0])).toEqual(['track', 'orbiter', 'monitor']);
    cleanup();
  });

  it('does not fire when armed while already recording (no late false start)', async () => {
    const { setMode, cleanup } = arm({ initialState: CAPTURE_STATES.recording });

    // A subsequent recording re-fire is just a ticker tick from the in-progress recording.
    fire(CAPTURE_STATES.recording);
    await vi.advanceTimersByTimeAsync(9000);
    expect(setMode).not.toHaveBeenCalled();
    cleanup();
  });

  it('detaches its listener on cleanup', async () => {
    const { setMode, cleanup } = arm();
    cleanup();
    fire(CAPTURE_STATES.recording);
    await vi.advanceTimersByTimeAsync(9000);
    expect(setMode).not.toHaveBeenCalled();
  });
});
