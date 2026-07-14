/**
 * The wet-only meter taps of the effect visuals ride Tone's INTERNAL node
 * fields (`effectReturn` on mono effects; `_merge`, `_leftDelay`,
 * `_rightDelay` on stereo effects). A Tone upgrade that renames them would
 * not throw — the visuals bridge degrades to level 0 by design — so every
 * effect visual would silently go dark.
 *
 * Real Tone nodes need a WebAudio context, which the test environment lacks,
 * so this pins the contract statically against the INSTALLED Tone build: if
 * these identifiers leave the source, this fails loudly at the version bump
 * instead of silently in production.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const toneRoot = path.dirname(require.resolve('tone/package.json'));

function toneSource(relPath) {
  return readFileSync(path.join(toneRoot, 'build/esm', relPath), 'utf8');
}

describe('Tone internal wet-tap contract (visuals meter seam)', () => {
  it('mono effects still expose the wet-only return node', () => {
    const source = toneSource('effect/Effect.js');
    expect(source).toContain('effectReturn');
  });

  it('stereo effects still merge their wet signal through _merge', () => {
    const source = toneSource('effect/StereoEffect.js');
    expect(source).toContain('_merge');
  });

  it('the ping-pong delay still exposes its per-side echo lines', () => {
    const source = toneSource('effect/PingPongDelay.js');
    expect(source).toContain('_leftDelay');
    expect(source).toContain('_rightDelay');
  });
});
