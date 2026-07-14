// @vitest-environment jsdom
/**
 * externalControl.js's first test file (previously zero coverage). This is the host/URL
 * control surface (`?syncBpm=`, the `orbiters:sync-control` CustomEvent): its bpm write is a
 * deliberate SYSTEM-level write, not a voice-scoped one, so it must never carry `byVoiceId` and must
 * never be blocked by any voice's own sync-enable state — that is what "explicit" means in
 * syncCoordinator.setTempo's single gate (see SyncCoordinator.js).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { syncCoordinator } from '../../src/sync/SyncCoordinator.js';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';
import {
  applyExternalSyncControl,
  initExternalSyncControl,
} from '../../src/sync/externalControl.js';

beforeEach(() => {
  voiceRegistry.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  voiceRegistry.clear();
});

describe('applyExternalSyncControl — bpm is a system write (never voice-gated)', () => {
  it('calls syncCoordinator.setTempo with no byVoiceId', () => {
    const spy = vi.spyOn(syncCoordinator, 'setTempo').mockReturnValue(true);
    applyExternalSyncControl({ bpm: 128 }, { source: 'host' });
    expect(spy).toHaveBeenCalledWith(128, { sourceType: 'host' });
  });

  it('is accepted even when every registered voice is unsynced (MULTI, real gate)', () => {
    voiceRegistry.register('v1', { id: 'v1', syncEnabled: false });
    voiceRegistry.register('v2', { id: 'v2', syncEnabled: false });
    const spy = vi.spyOn(syncCoordinator, 'setTempo');

    applyExternalSyncControl({ bpm: 128 }, { source: 'host' });

    // The real setTempo gate only rejects a call carrying byVoiceId; a system write has none, so it
    // ran to completion (returned true) regardless of both voices being unsynced.
    expect(spy).toHaveReturnedWith(true);
  });

  it('ignores a non-positive or missing bpm (no call at all)', () => {
    const spy = vi.spyOn(syncCoordinator, 'setTempo');
    applyExternalSyncControl({ bpm: -5 }, { source: 'host' });
    applyExternalSyncControl({}, { source: 'host' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('applyExternalSyncControl — other control fields', () => {
  it('enabled true/false calls enable()/disable()', () => {
    const enableSpy = vi.spyOn(syncCoordinator, 'enable').mockImplementation(() => {});
    const disableSpy = vi.spyOn(syncCoordinator, 'disable').mockImplementation(() => {});
    applyExternalSyncControl({ enabled: true });
    expect(enableSpy).toHaveBeenCalledTimes(1);
    applyExternalSyncControl({ enabled: false });
    expect(disableSpy).toHaveBeenCalledTimes(1);
  });

  it('mode normalizes to TEMPO_ONLY/PHASE_LOCK and forwards to setMode', () => {
    const modeSpy = vi.spyOn(syncCoordinator, 'setMode').mockImplementation(() => {});
    applyExternalSyncControl({ mode: 'phase_lock' });
    expect(modeSpy).toHaveBeenCalledWith('PHASE_LOCK');
  });

  it('an unrecognized control patch (no known fields) is a no-op returning false', () => {
    const setTempoSpy = vi.spyOn(syncCoordinator, 'setTempo');
    const result = applyExternalSyncControl({ nonsense: 'x' });
    expect(result).toBe(false);
    expect(setTempoSpy).not.toHaveBeenCalled();
  });
});

describe('initExternalSyncControl — URL bootstrap', () => {
  it('reads ?syncBpm= from the URL and applies it once as a system write', () => {
    const spy = vi.spyOn(syncCoordinator, 'setTempo').mockReturnValue(true);
    window.history.pushState({}, '', '/?syncBpm=133');

    initExternalSyncControl({});

    expect(spy).toHaveBeenCalledWith(133, { sourceType: 'url' });
  });
});
