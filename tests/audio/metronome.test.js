// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted (above the vi.mock factories that read them): the master tempo + the fakes the mocks expose.
const { BPM, activeTransport, ctx, activeMeter, sharedClock } = vi.hoisted(() => ({
  BPM: 600,
  // The focused voice's own transport — the solo metronome reads its POSITION (getCurrentTimeMs) and
  // gates on isRunning; tempo comes from syncCoordinator.bpm (the one tempo owner), not the transport.
  activeTransport: {
    isRunning: true,
    positionSec: 0,
    getCurrentTimeMs() { return this.positionSec * 1000; },
  },
  ctx: {
    currentTime: 0,
    createOscillator: vi.fn(),
    createGain: vi.fn(),
    destination: {},
  },
  // The metronome accents by the FOCUSED voice's OWN meter (WrapGridState), not a shared singleton.
  activeMeter: { value: '4/4' },
  // Decision 005 (no window globals as seams): the realm-wide shared-clock state, injected via the
  // mocked `sync/init.js` below instead of `window.__orbitersSharedClock`.
  sharedClock: { state: null },
}));

const SECONDS_PER_BEAT = 60 / BPM;

// Tone is only needed for the raw AudioContext (the click's output); the clock no longer reads it.
vi.mock('tone', () => ({
  getContext: () => ({ rawContext: ctx }),
  context: { rawContext: ctx },
}));

vi.mock('../../src/sync/SyncCoordinator.js', () => ({
  // The master tempo owner: `bpm` is what the solo metronome clicks at (was Tone.Transport.bpm.value).
  syncCoordinator: { isEnabled: false, bpm: BPM },
}));

vi.mock('../../src/sync/init.js', () => ({
  getSharedClockState: () => sharedClock.state,
}));

// The FOCUSED voice's own meter (its deck) + transport drive the metronome (both per-voice).
vi.mock('../../src/voice/VoiceRegistry.js', () => ({
  voiceRegistry: {
    getActive: () => ({
      deck: { get meter() { return activeMeter.value; } },
      audioEngine: {
        transport: activeTransport,
      },
    }),
  },
}));

vi.mock('../../src/config/metronome.js', () => ({
  isMetronomeEnabled: () => false,
  METRONOME_CHANGED_EVENT: 'orbiters:metronome-changed',
}));

vi.mock('../../src/config/audioOffset.js', () => ({
  getManualAudioOffsetMs: vi.fn(() => 0),
}));

vi.mock('../../src/export/capture.js', () => ({
  captureControl: { getState: () => 'idle' },
  CAPTURE_STATE_CHANGE_EVENT: 'orbiters:capture-state-change',
}));

import { Metronome } from '../../src/audio/metronome.js';
import { syncCoordinator } from '../../src/sync/SyncCoordinator.js';
import { getManualAudioOffsetMs } from '../../src/config/audioOffset.js';

function pumpAt(metronome, beatNow) {
  activeTransport.positionSec = beatNow * SECONDS_PER_BEAT;
  ctx.currentTime = activeTransport.positionSec;
  metronome._pump();
}

describe('Metronome denominator subdivision', () => {
  beforeEach(() => {
    activeTransport.isRunning = true;
    activeTransport.positionSec = 0;
    ctx.currentTime = 0;
    activeMeter.value = '4/4';
  });

  it('3/4 clicks three quarter notes per bar and accents the first click', () => {
    activeMeter.value = '3/4';
    const m = new Metronome();
    const accents = [];
    m._click = (_ctx, _time, accent) => accents.push(accent ? 'A' : '.');

    [-0.2, 0.8, 1.8, 2.8].forEach((beat) => pumpAt(m, beat));

    expect(accents.join('')).toBe('A..A');
  });

  it('6/8 clicks six eighth notes per bar and accents the first click', () => {
    activeMeter.value = '6/8';
    const m = new Metronome();
    const accents = [];
    m._click = (_ctx, _time, accent) => accents.push(accent ? 'A' : '.');

    [-0.2, 0.3, 0.8, 1.3, 1.8, 2.3, 2.8].forEach((beat) => pumpAt(m, beat));

    expect(accents.join('')).toBe('A.....A.');
  });
});

describe('Metronome beat source', () => {
  beforeEach(() => {
    activeTransport.isRunning = true;
    activeTransport.positionSec = 0;
    ctx.currentTime = 0;
    activeMeter.value = '4/4';
    sharedClock.state = null;
  });

  afterEach(() => {
    sharedClock.state = null;
  });

  it('follows the shared clock beat (not the local transport) when a session is live', () => {
    activeMeter.value = '4/4';
    // The shared grid sits at 3.9 → its next whole beat (4.0) is a bar downbeat, so the first click
    // armed must be an accent. The LOCAL transport is deliberately at a mid-bar phase (next beat 1 →
    // NOT a downbeat); if the metronome read the transport instead, the first click would be a '.'.
    activeTransport.positionSec = 0.9 * SECONDS_PER_BEAT;
    ctx.currentTime = 0;
    sharedClock.state = { joined: true, beatNow: 3.9, phaseNow: 0, tempoBpm: 600, quantum: 4 };
    const m = new Metronome();
    const accents = [];
    m._click = (_ctx, _time, accent) => accents.push(accent ? 'A' : '.');

    m._pump();

    expect(accents[0]).toBe('A'); // shared downbeat; would be '.' if it read the local transport
  });

  it('ignores the shared clock when it is not joined (solo → local transport)', () => {
    activeMeter.value = '3/4';
    sharedClock.state = null;
    const m = new Metronome();
    const accents = [];
    m._click = (_ctx, _time, accent) => accents.push(accent ? 'A' : '.');

    [-0.2, 0.8, 1.8, 2.8].forEach((beat) => pumpAt(m, beat));

    expect(accents.join('')).toBe('A..A'); // identical to the solo 3/4 subdivision — clock is ignored
  });
});

describe('Metronome seek recovery', () => {
  beforeEach(() => {
    activeTransport.isRunning = true;
    activeTransport.positionSec = 0;
    ctx.currentTime = 0;
    activeMeter.value = '4/4';
    sharedClock.state = null;
  });

  it('recomputes the armed-ahead cache when beatNow jumps without matching audio-clock time (a seek)', () => {
    const m = new Metronome();
    const accents = [];
    m._click = (_ctx, _time, accent) => accents.push(accent ? 'A' : '.');

    pumpAt(m, 0);
    const beforeSeekNextBeat = m._nextBeat; // armed ahead of beat 0, e.g. beat 2

    // A backward seek: beatNow drops far behind, but only ~one pump tick (25ms) of real audio-clock
    // time elapses — the signature of a seek (position jumps, wall clock just keeps ticking), unlike
    // continuous playback where the two stay in lockstep.
    activeTransport.positionSec = -20 * SECONDS_PER_BEAT;
    ctx.currentTime += 0.025;
    m._pump();

    // Without the fix, `_nextBeat` would still be `beforeSeekNextBeat` — miles ahead of the new
    // beatNow(-20) — so nothing would sound again until real playback time climbed all the way back
    // up to it (the reported "metronome just stops" bug). With the fix it's recomputed right after
    // the new position.
    expect(m._nextBeat).not.toBe(beforeSeekNextBeat);
    expect(Math.abs(m._nextBeat - -20)).toBeLessThan(3);
  });

  it('does not reset on ordinary continuous playback (beatNow and audio time move together)', () => {
    const m = new Metronome();
    m._click = () => {};
    pumpAt(m, 0);
    const afterFirst = m._nextBeat; // 2: armed through beat 0 and beat 1 in the first tick

    // One more tick, a plausible ~25ms later — NOT a seek: both the transport position and the audio
    // clock advance by the same real amount, so the discontinuity check must NOT fire. If it
    // (incorrectly) did, `_nextBeat` would be thrown away and recomputed from the new beatNow (0.25),
    // landing on 1 — a DIFFERENT, smaller value than the correct outcome of leaving the already-armed
    // cache alone (it stays 2; the new beatTime for beat 2 isn't inside the look-ahead window yet, so
    // no further arming happens this tick either). Asserting the exact value (not just >=) is what
    // actually distinguishes "no reset" from "reset-then-recompute" here.
    activeTransport.positionSec += 0.025;
    ctx.currentTime = activeTransport.positionSec;
    m._pump();
    expect(m._nextBeat).toBe(afterFirst);
  });
});

describe('Metronome manual audio offset', () => {
  beforeEach(() => {
    activeTransport.isRunning = true;
    activeTransport.positionSec = 0;
    ctx.currentTime = 0;
    activeMeter.value = '4/4';
    syncCoordinator.isEnabled = false;
    sharedClock.state = null;
    getManualAudioOffsetMs.mockReturnValue(0);
  });

  afterEach(() => {
    syncCoordinator.isEnabled = false;
    getManualAudioOffsetMs.mockReturnValue(0);
  });

  it('leads the click by the manual offset while a shared session is enabled', () => {
    syncCoordinator.isEnabled = true;
    getManualAudioOffsetMs.mockReturnValue(50); // ms
    const m = new Metronome();
    const times = [];
    m._click = (_ctx, time) => times.push(time);

    pumpAt(m, 0);

    // Natural (unshifted) schedule for the first click (beat 1 at 0.1s) minus the 50ms lead.
    expect(times[0]).toBeCloseTo(0.1 - 0.05, 5);
  });

  it('does not lead the click when sync is disabled — nothing else to sync against, solo', () => {
    syncCoordinator.isEnabled = false;
    getManualAudioOffsetMs.mockReturnValue(50);
    const m = new Metronome();
    const times = [];
    m._click = (_ctx, time) => times.push(time);

    pumpAt(m, 0);

    expect(times[0]).toBeCloseTo(0.1, 5);
  });

  it('lags the click for a negative offset (device fires early, not late)', () => {
    syncCoordinator.isEnabled = true;
    // Small enough that the lagged time still falls inside the 0.12s look-ahead window in one tick
    // (a bigger lag just needs another pump tick to enter the window — see the max-offset test below).
    getManualAudioOffsetMs.mockReturnValue(-15);
    const m = new Metronome();
    const times = [];
    m._click = (_ctx, time) => times.push(time);

    pumpAt(m, 0);

    expect(times[0]).toBeCloseTo(0.1 + 0.015, 5);
  });

  it('still arms without throwing at the max ±500ms offset (the guard loop terminates)', () => {
    syncCoordinator.isEnabled = true;
    getManualAudioOffsetMs.mockReturnValue(500); // MAX_ABS_OFFSET_MS
    const m = new Metronome();
    const times = [];
    m._click = (_ctx, time) => times.push(time);

    expect(() => pumpAt(m, 0)).not.toThrow();

    // The 500ms lead pushes the first few beats' corrected time below the arm threshold (still "in
    // the past" relative to `nowAudio`) — the existing `beatTime > nowAudio + 0.001` guard already
    // skips those without ever scheduling a negative `start(time)`, so the loop simply advances past
    // them (bounded by the 128-iteration guard, no spin) until it reaches the first beat whose
    // corrected time actually falls in the look-ahead window — beat 6 at this tempo/offset, whose
    // corrected time lands back around the ordinary ~0.1s mark.
    expect(times.length).toBeGreaterThan(0);
    expect(times[0]).toBeCloseTo(0.1, 5);
  });
});
