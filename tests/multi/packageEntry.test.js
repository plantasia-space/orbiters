// @vitest-environment jsdom
/**
 * The public package entry (`orbiters/multi`, src/multi/index.js) — the one boundary a host app
 * imports to run the shared realm outside this repo's own Vite build.
 *
 * What this pins: the full module graph behind the entry resolves and evaluates on a page the app
 * does not own (no index.html scaffolding), and the public surface exports exist by name. The
 * no-DOM half of import safety is pinned separately in packageEntryNode.test.js.
 */
import { describe, it, expect } from 'vitest';

describe('package entry (multi, jsdom)', () => {
  // Generous timeout: this import transforms the entire app graph, which is slow when the full
  // suite's workers compete for the transform pipeline.
  it('imports the full graph and exposes the public surface', { timeout: 30_000 }, async () => {
    const entry = await import('../../src/multi/index.js');

    expect(typeof entry.createMultiOrbiterApp).toBe('function');
    expect(typeof entry.createViewportCompositor).toBe('function');
    expect(typeof entry.makeOrbiterVoiceSession).toBe('function');
    expect(typeof entry.makeAudioVoiceSession).toBe('function');
    expect(typeof entry.initI18n).toBe('function');
    expect(entry.voiceRegistry).toBeTruthy();
    expect(entry.MAX_CONCURRENT_VOICE_BOOTS).toBeGreaterThan(0);
  });

  it('does not mutate the host document at import time', { timeout: 30_000 }, async () => {
    await import('../../src/multi/index.js');
    // The notifications container is created on first toast, not on import — a host page must
    // not gain elements just by loading the module graph.
    expect(document.getElementById('notification-container')).toBeNull();
  });
});
