// @vitest-environment jsdom
/**
 * The `sync` EngineContext surface — a narrow facade over the singleton SyncCoordinator. The header
 * SyncStack reaches enable/disable + state through this surface. `peerCount()` counts others
 * in the session (NOT counting self); B2 repoints it at `sessionPeerCount` — the LIVE,
 * room-scoped present-peer count (0 for in-tab, whose partners are counted via inTabSyncedCount) — so
 * cross-room / cross-tab peers never inflate the SYNC badge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

function makeSyncCoordinator(overrides = {}) {
  return {
    isEnabled: false,
    sessionPeerCount: 0,
    enable: vi.fn(),
    disable: vi.fn(),
    ...overrides,
  };
}

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('sync surface — peerCount (room-scoped, B2)', () => {
  it('reads the SyncCoordinator room-scoped sessionPeerCount', () => {
    const sc = makeSyncCoordinator({ sessionPeerCount: 2 });
    const { sync } = createEngineContext({ parameterManager: pm, syncCoordinator: sc });
    expect(sync.peerCount()).toBe(2);
  });

  it('clamps missing / negative / NaN peer counts to 0', () => {
    for (const bad of [undefined, null, -1, Number.NaN]) {
      const sc = makeSyncCoordinator({ sessionPeerCount: bad });
      const { sync } = createEngineContext({ parameterManager: pm, syncCoordinator: sc });
      expect(sync.peerCount()).toBe(0);
    }
  });

  it('defaults to 0 when no SyncCoordinator is wired', () => {
    const { sync } = createEngineContext({ parameterManager: pm });
    expect(sync.available).toBe(false);
    expect(sync.peerCount()).toBe(0);
  });
});

describe('sync surface — inTabSyncedCount', () => {
  it('MULTI: reads the in-tab synced-voice count from syncEnableState', () => {
    const sc = makeSyncCoordinator();
    const syncEnableState = { isEnabled: () => true, setEnabled: vi.fn(), syncedCount: () => 2 };
    const { sync } = createEngineContext({ parameterManager: pm, syncCoordinator: sc, syncEnableState });
    expect(sync.inTabSyncedCount()).toBe(2); // two synced orbiters in this tab → badge shows 2
  });

  it('SINGLE-orbiter (no syncEnableState): counts self via the coordinator enable', () => {
    const onCtx = createEngineContext({ parameterManager: pm, syncCoordinator: makeSyncCoordinator({ isEnabled: true }) });
    expect(onCtx.sync.inTabSyncedCount()).toBe(1);
    const offCtx = createEngineContext({ parameterManager: pm, syncCoordinator: makeSyncCoordinator({ isEnabled: false }) });
    expect(offCtx.sync.inTabSyncedCount()).toBe(0);
  });
});
