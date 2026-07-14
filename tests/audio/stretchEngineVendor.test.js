/**
 * Guards the vendored time-stretch engine module against drifting from the
 * installed signalsmith-stretch package. The engine ships as a string module
 * (see scripts/vendor-stretch-engine.mjs) so it loads identically under any
 * bundler; if the dependency is bumped without regenerating, the app would
 * silently keep running the old engine.
 *
 * The vendored copy is NOT verbatim upstream: a maintained reverse-on-read
 * overlay (patchStretchSource) is applied during generation, so the guard
 * compares against the PATCHED installed source. This also verifies the patch
 * anchors still exist in the installed source — patchStretchSource throws if
 * they don't, failing the test the moment a dependency bump moves them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import vendoredSource, { signalsmithStretchVersion } from '../../src/audio/playback/vendor/signalsmithStretchEngine.js';
import { patchStretchSource } from '../../scripts/vendor-stretch-engine.mjs';

// Resolved by path, not require(): the package's exports map only exposes its
// entry point, and the symlinked worktree node_modules is a plain fs read.
const packageDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'node_modules', 'signalsmith-stretch',
);

describe('vendored signalsmith-stretch engine', () => {
  it('matches the installed package source with the reverse-read overlay applied', () => {
    const installedSource = readFileSync(join(packageDir, 'SignalsmithStretch.mjs'), 'utf8');
    expect(vendoredSource).toBe(patchStretchSource(installedSource));
  });

  it('the overlay actually changes the source (guards a silent no-op patch)', () => {
    const installedSource = readFileSync(join(packageDir, 'SignalsmithStretch.mjs'), 'utf8');
    expect(patchStretchSource(installedSource)).not.toBe(installedSource);
    expect(vendoredSource).toContain('if (reversedRead) buffers.forEach(buffer => buffer.reverse());');
    expect(vendoredSource).toContain('Math.abs(currentMapSegment.rate)');
  });

  it('records the installed package version', () => {
    const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    expect(signalsmithStretchVersion).toBe(version);
  });
});
