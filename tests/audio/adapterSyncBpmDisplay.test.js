// @vitest-environment node
/**
 * The header "BPM" number IS `deck.tempo` — the deck's continuous transport tempo. The adapter only
 * mirrors it (one display source) and routes edits into `deck.setTempo` (whose synced/unsynced
 * routing is pinned in tests/voice/deck.test.js). The old master-mirror-on-every-tile made the
 * (correctly gated) audio path LOOK like the tempo leak on every unsynced tile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';

function makeAdapter({ tempo = 95 } = {}) {
  const adapter = Object.create(AudioEngineAdapter.prototype);
  adapter.deck = { tempo };
  adapter.userManager = { setRawValue: vi.fn() };
  return adapter;
}

describe('AudioEngineAdapter — the BPM readout mirrors the deck transport tempo', () => {
  it('writes deck.tempo, tagged as the display mirror so the edit bridge skips the echo', () => {
    const adapter = makeAdapter({ tempo: 95 });
    adapter._refreshSyncBpmReadout();
    expect(adapter.userManager.setRawValue).toHaveBeenCalledWith('sync-bpm', 95, expect.any(Object));
  });

  it('an unknown deck tempo leaves the readout untouched (never writes a lie)', () => {
    const adapter = makeAdapter({ tempo: null });
    adapter._refreshSyncBpmReadout();
    expect(adapter.userManager.setRawValue).not.toHaveBeenCalled();
  });

  it('a manager without setRawValue is tolerated (view-less/test paths)', () => {
    const adapter = makeAdapter({ tempo: 95 });
    adapter.userManager = {};
    expect(() => adapter._refreshSyncBpmReadout()).not.toThrow();
  });
});
