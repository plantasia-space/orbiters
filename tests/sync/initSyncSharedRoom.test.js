// @vitest-environment jsdom
/**
 * initSync builds the room socket + shared-clock pulse + coordinator wiring ONCE per multi-orbiter
 * tab (a tab is one Connect peer), reused by every sibling voice — so all voices' badges read the one
 * adapter that actually joined the room. Single-orbiter / in-tab stay per-call (byte-identical).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the heavy collaborators so the test exercises ONLY the build-once guard.
vi.mock('../../src/sync/adapters/WebSocketSyncAdapter.js', () => ({
  WebSocketSyncAdapter: vi.fn(function (url, room) { this.url = url; this.room = room; }),
}));
vi.mock('../../src/sync/adapters/BroadcastChannelAdapter.js', () => ({
  BroadcastChannelAdapter: vi.fn(function () {}),
}));
vi.mock('../../src/sync/sharedClock.js', () => ({
  initSharedClockPulse: vi.fn(() => ({ getState: () => null, dispose: vi.fn() })),
}));
vi.mock('../../src/sync/pulseClock.js', () => ({
  createLocalPulseClock: vi.fn(() => ({ getState: () => null, dispose: vi.fn() })),
}));
vi.mock('entangled-worlds-orbiters-shared/clock/track-metadata', () => ({
  resolveTrackBpmFromTrackData: () => 120,
}));

const audioEngine = { transport: { getBpm: () => 120, Tone: null } };

async function load(search) {
  vi.resetModules();
  window.history.replaceState({}, '', `/${search}`);
  const { WebSocketSyncAdapter } = await import('../../src/sync/adapters/WebSocketSyncAdapter.js');
  const { initSharedClockPulse } = await import('../../src/sync/sharedClock.js');
  const { syncCoordinator } = await import('../../src/sync/SyncCoordinator.js');
  vi.spyOn(syncCoordinator, 'init').mockImplementation(() => {});
  const { initSync } = await import('../../src/sync/init.js');
  return { initSync, WebSocketSyncAdapter, initSharedClockPulse, syncCoordinator };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('initSync — one room socket per multi-orbiter tab', () => {
  it('multi + room: N voices share ONE adapter + pulse, but each re-inits the coordinator', async () => {
    const { initSync, WebSocketSyncAdapter, initSharedClockPulse, syncCoordinator } = await load('?room=orb&multi=1');
    initSync(audioEngine, {}, null); // voice 1 — builds
    initSync(audioEngine, {}, null); // voice 2 (sibling) — reuses
    initSync(audioEngine, {}, null); // voice 3 — reuses
    // ONE socket + ONE pulse for the whole tab...
    expect(WebSocketSyncAdapter).toHaveBeenCalledTimes(1);
    expect(initSharedClockPulse).toHaveBeenCalledTimes(1);
    // ...but the coordinator is wired per voice (last-writer trackBpm), always to the SAME adapter.
    expect(syncCoordinator.init).toHaveBeenCalledTimes(3);
    const adapters = syncCoordinator.init.mock.calls.map((c) => c[0].adapter);
    expect(adapters[0]).toBe(adapters[1]);
    expect(adapters[1]).toBe(adapters[2]);
  });

  it('single-orbiter room (no multi): each initSync builds a fresh adapter (byte-identical path)', async () => {
    const { initSync, WebSocketSyncAdapter, syncCoordinator } = await load('?room=orb');
    initSync(audioEngine, {}, null);
    initSync(audioEngine, {}, null);
    expect(WebSocketSyncAdapter).toHaveBeenCalledTimes(2);
    expect(syncCoordinator.init).toHaveBeenCalledTimes(2);
    const adapters = syncCoordinator.init.mock.calls.map((c) => c[0].adapter);
    expect(adapters[0]).not.toBe(adapters[1]); // a new adapter each call
  });

  it('a room change rebuilds even in multi mode', async () => {
    const { initSync, WebSocketSyncAdapter } = await load('?room=orb&multi=1');
    initSync(audioEngine, {}, null); // builds for "orb"
    window.history.replaceState({}, '', '/?room=other&multi=1');
    initSync(audioEngine, {}, null); // room changed → rebuild
    expect(WebSocketSyncAdapter).toHaveBeenCalledTimes(2);
    expect(WebSocketSyncAdapter.mock.calls[0][1]).toBe('orb');
    expect(WebSocketSyncAdapter.mock.calls[1][1]).toBe('other');
  });
});
