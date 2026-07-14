/**
 * The no-DOM half of the package entry's import safety (see packageEntry.test.js for the jsdom
 * half): a host bundler or server pass may evaluate the module graph before any window/document
 * exists, so importing `src/multi/index.js` must not touch the DOM at module top level. This runs
 * in the node environment (vitest default) — an unguarded import-time `document.*`/`window.*`
 * access anywhere in the entry graph fails here with a ReferenceError.
 */
import { describe, it, expect } from 'vitest';

describe('package entry (multi, node — no DOM)', () => {
  // Resolved via the PACKAGE NAME (Node self-reference), not a relative path, so this also pins
  // the package.json `exports` map a host actually goes through. Generous timeout: this import
  // transforms the entire app graph, which is slow when the full suite's workers compete for the
  // transform pipeline.
  it('imports orbiters/multi without a window or document', { timeout: 30_000 }, async () => {
    const entry = await import('orbiters/multi');
    expect(typeof entry.createMultiOrbiterApp).toBe('function');
  });
});
