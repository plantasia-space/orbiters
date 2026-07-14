// @vitest-environment jsdom
/**
 * Per-player metronome streams — each player owns an independent click: its own on/off flag, its own
 * meter (accent pattern), its own clock. Two playing players with metronomes on click AT THE SAME
 * TIME, each to its own grid; a synced player clicks on the shared clock while an unsynced player
 * clicks on its OWN playback position and native tempo (the clock it opted out of is irrelevant).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { ctx, voices, registryState, sharedClock } = vi.hoisted(() => ({
  ctx: {
    currentTime: 0,
    createOscillator: vi.fn(),
    createGain: vi.fn(),
    destination: {},
  },
  // Two players: A synced (shared clock), B unsynced (own position + own native tempo).
  voices: new Map(),
  registryState: { size: 2 },
  // Decision 005 (no window globals as seams): the realm-wide shared-clock state, injected via the
  // mocked `sync/init.js` below instead of `window.__orbitersSharedClock`.
  sharedClock: { state: null },
}));

vi.mock('tone', () => ({
  getTransport: () => ({ state: 'started', bpm: { value: 120 }, seconds: 0 }),
  Transport: { state: 'started', bpm: { value: 120 }, seconds: 0 },
  getContext: () => ({ rawContext: ctx }),
  context: { rawContext: ctx },
}));

vi.mock('../../src/sync/SyncCoordinator.js', () => ({
  syncCoordinator: {
    isEnabled: true,
    isRoom: false,
    bpm: undefined,
    trackBpm: undefined,
    detectedTrackBpm: undefined,
    enable: () => {},
    disable: () => {},
    notifyVoiceSyncChanged: () => {},
    notifyVoiceWrapChanged: () => {},
    setTempo: () => true,
  },
}));

vi.mock('../../src/sync/init.js', () => ({
  getSharedClockState: () => sharedClock.state,
}));

vi.mock('../../src/voice/VoiceRegistry.js', () => ({
  voiceRegistry: {
    get: (id) => voices.get(id),
    getActive: () => null,
    all: () => [...voices.values()],
    get size() { return registryState.size; },
  },
}));

vi.mock('../../src/config/audioOffset.js', () => ({
  getManualAudioOffsetMs: vi.fn(() => 0),
}));

vi.mock('../../src/export/capture.js', () => ({
  captureControl: { getState: () => 'idle' },
  CAPTURE_STATE_CHANGE_EVENT: 'orbiters:capture-state-change',
}));

import { ensureVoiceMetronome, disposeVoiceMetronome } from '../../src/audio/metronome.js';
import { Deck } from '../../src/voice/Deck.js';

function makeVoice({ syncEnabled, meter, trackBpm, positionMs, gridSec = 0, playing = true }) {
  // A REAL Deck per player — the metronome consumes deck.meter + deck.clock() (the one clock seam).
  const deck = new Deck({
    voiceId: null,
    collection: true,
    trackData: { track: { metadata: { trackBpm, meter } } },
  });
  deck.setGridMarkerTimeSec(gridSec);
  deck.setPositionSource(() => ({ playing, positionMs: positionMs.value }));
  deck.setSharedClockSource(() => sharedClock.state);
  if (syncEnabled) deck.setSyncEnabled(true);
  return { deck, audioEngine: { isPlaying: () => playing } };
}

describe('per-player metronome streams', () => {
  const posA = { value: 0 };
  const posB = { value: 0 };

  beforeEach(() => {
    ctx.currentTime = 0;
    registryState.size = 2;
    voices.clear();
    sharedClock.state = null;
    voices.set('a', makeVoice({ syncEnabled: true, meter: '4/4', trackBpm: 100, positionMs: posA }));
    voices.set('b', makeVoice({ syncEnabled: false, meter: '3/4', trackBpm: 60, positionMs: posB }));
  });

  afterEach(() => {
    disposeVoiceMetronome('a');
    disposeVoiceMetronome('b');
    sharedClock.state = null;
  });

  it('both players click at the same time, each with its OWN accent pattern', () => {
    // Shared clock live for the synced player A.
    sharedClock.state = { joined: true, beatNow: -0.2, tempoBpm: 60, quantum: 4 };
    const a = ensureVoiceMetronome('a');
    const b = ensureVoiceMetronome('b');
    const clicksA = [];
    const clicksB = [];
    a._click = (_c, _t, accent) => clicksA.push(accent ? 'A' : '.');
    b._click = (_c, _t, accent) => clicksB.push(accent ? 'A' : '.');

    // Drive both pumps over the same wall-clock ticks: 60 bpm everywhere → 1 beat per second.
    // Sample 50 ms before each beat boundary so the upcoming beat falls inside the pump's 120 ms
    // look-ahead. B is unsynced: its beat comes from its own position (1000 ms/beat at trackBpm 60).
    for (let sec = 0; sec <= 3; sec += 1) {
      ctx.currentTime = sec + 0.95;
      sharedClock.state = { joined: true, beatNow: sec + 0.95, tempoBpm: 60, quantum: 4 };
      posB.value = (sec + 0.95) * 1000;
      a._pump();
      b._pump();
    }

    expect(clicksA.length).toBeGreaterThan(0);
    expect(clicksB.length).toBeGreaterThan(0);
    // The same four ticks arm beats 1..4 for both. A accents every 4 beats (4/4), B every 3 (3/4) —
    // independent patterns from identical wall-clock ticks = both clicking at once, each to its grid.
    expect(clicksA.join('')).toBe('...A');
    expect(clicksB.join('')).toBe('..A.');
  });

  it('an unsynced player ignores the shared clock even when a session is live', () => {
    // Shared grid parked just before ITS downbeat — if B read this clock, its first click would
    // be an accent. B's OWN position sits mid-bar (beat 1 of 3/4 → NOT a downbeat).
    sharedClock.state = { joined: true, beatNow: 2.9, tempoBpm: 60, quantum: 4 };
    const b = ensureVoiceMetronome('b');
    const clicksB = [];
    b._click = (_c, _t, accent) => clicksB.push(accent ? 'A' : '.');

    posB.value = 900; // own beat 0.9 → next own beat is 1 (mid-bar '.')
    ctx.currentTime = 0.9;
    b._pump();

    expect(clicksB[0]).toBe('.');
  });

  it('a paused player is silent while the other keeps clicking', () => {
    voices.set('a', makeVoice({ syncEnabled: false, meter: '4/4', trackBpm: 60, positionMs: posA, playing: false }));
    const a = ensureVoiceMetronome('a');
    const b = ensureVoiceMetronome('b');
    const clicksA = [];
    const clicksB = [];
    a._click = (_c, _t, accent) => clicksA.push(accent);
    b._click = (_c, _t, accent) => clicksB.push(accent);

    posA.value = 900;
    posB.value = 900;
    ctx.currentTime = 0.9;
    a._pump();
    b._pump();

    expect(clicksA).toHaveLength(0); // paused → silent
    expect(clicksB.length).toBeGreaterThan(0);
  });

  it('a removed player’s stream self-disposes instead of pumping forever', async () => {
    const b = ensureVoiceMetronome('b');
    b.setEnabled(true);
    voices.delete('b'); // tile removed
    b._pump();
    await new Promise((r) => queueMicrotask(r)); // the dispose is queued as a microtask
    expect(b._pumpId).toBeNull(); // stream disabled + disposed
    // A fresh ensure builds a NEW stream rather than resurrecting the disposed one.
    voices.set('b', makeVoice({ syncEnabled: false, meter: '3/4', trackBpm: 60, positionMs: posB }));
    expect(ensureVoiceMetronome('b')).not.toBe(b);
  });
});
