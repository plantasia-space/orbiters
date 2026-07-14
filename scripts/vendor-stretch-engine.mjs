/**
 * Regenerates src/audio/playback/vendor/signalsmithStretchEngine.js from the
 * installed signalsmith-stretch package.
 *
 * The engine module is shipped as a STRING (imported lazily, turned into a
 * Blob URL and dynamic-imported at runtime) because:
 * - the engine assembles its AudioWorklet processor by stringifying its own
 *   functions, so no bundler transform may touch the executable source — a
 *   string literal passes through every minifier verbatim;
 * - resource-query imports (`?url`) are Vite-only, and this file is also
 *   bundled by Next/webpack when the host app consumes orbiters source.
 *
 * MAINTAINED OVERLAY — the vendored copy is NOT byte-for-byte upstream. We
 * apply `patchStretchSource()` below to teach the worklet to read its ONE
 * stored buffer BACKWARDS on a negative segment rate (through-zero reverse
 * playback with no second buffer). The patch is a small, fail-closed string
 * transform; the drift test (tests/audio/stretchEngineVendor.test.js) pins the
 * vendored copy against `patchStretchSource(installedSource)`, so a dependency
 * bump that moves the patch anchors fails the test loudly instead of silently
 * shipping an unpatched (reverse-broken) engine.
 *
 * Run after bumping the signalsmith-stretch dependency:
 *   node scripts/vendor-stretch-engine.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Overlay that adds reverse-on-read to the stringified AudioWorklet processor.
 *
 * The engine plays stored audio by refilling, EVERY block, a temporary input
 * window `[playhead-bufferLength, playhead)` from `this.audioBuffers` and
 * handing it to the WASM stretcher ("constantly seeking"). Playhead position is
 * owned entirely by the JS (via which samples it copies into the window), not
 * by the WASM. So reverse playback needs no negative rate inside the DSP: walk
 * the playhead backwards (a negative segment rate does this natively through
 * the existing time-map interpolation) and REVERSE the temporary window in
 * place before the stretcher sees it. The phase vocoder still runs forward-time
 * over time-reversed material — true reverse, pitch preserved. Only the
 * temporary WASM-input views are flipped; the stored buffers are never copied.
 *
 * Two edits inside the stored-audio playback branch of `process()`:
 *  A. Loop-wrap becomes direction-aware: a reverse read wraps at loopStart, not
 *     loopEnd. (The read-ahead latency line is deliberately left UNTOUCHED — it
 *     centres the read window on the playhead regardless of direction, verified
 *     empirically against the real WASM; flipping its sign mistimes and smears
 *     reverse output.)
 *  B. The filled window is reversed when the rate is negative, and `_seek` is
 *     always given the POSITIVE rate magnitude (the WASM never sees a negative
 *     rate — direction is expressed purely by the reversed samples + playhead).
 *
 * Throws if an anchor is missing so a silent no-op patch can never ship.
 */
export function patchStretchSource(source) {
  const edits = [
    {
      name: 'bidirectional loop-wrap',
      find:
        '\t\t\t\tlet loopLength = currentMapSegment.loopEnd - currentMapSegment.loopStart;\n' +
        '\t\t\t\tif (loopLength > 0 && inputTime >= currentMapSegment.loopEnd) {\n' +
        '\t\t\t\t\tcurrentMapSegment.input -= loopLength;\n' +
        '\t\t\t\t\tinputTime -= loopLength;\n' +
        '\t\t\t\t}',
      replace:
        '\t\t\t\tlet loopLength = currentMapSegment.loopEnd - currentMapSegment.loopStart;\n' +
        '\t\t\t\t// [Plantasia overlay — bidirectional read] A negative segment rate\n' +
        '\t\t\t\t// means reverse playback: the read pointer walks backwards through the\n' +
        '\t\t\t\t// ONE stored buffer, so the loop wraps at loopStart (not loopEnd). The\n' +
        '\t\t\t\t// window itself is reversed just before the stretcher (see below); the\n' +
        '\t\t\t\t// read-ahead latency line below is left as-is (it centres the window on\n' +
        '\t\t\t\t// the playhead in either direction — flipping its sign smears reverse).\n' +
        '\t\t\t\tlet reversedRead = currentMapSegment.rate < 0;\n' +
        '\t\t\t\tif (loopLength > 0) {\n' +
        '\t\t\t\t\tif (!reversedRead && inputTime >= currentMapSegment.loopEnd) {\n' +
        '\t\t\t\t\t\tcurrentMapSegment.input -= loopLength;\n' +
        '\t\t\t\t\t\tinputTime -= loopLength;\n' +
        '\t\t\t\t\t} else if (reversedRead && inputTime <= currentMapSegment.loopStart) {\n' +
        '\t\t\t\t\t\tcurrentMapSegment.input += loopLength;\n' +
        '\t\t\t\t\t\tinputTime += loopLength;\n' +
        '\t\t\t\t\t}\n' +
        '\t\t\t\t}',
    },
    {
      name: 'reverse window + positive-magnitude seek',
      find:
        '\t\t\t\t// constantly seeking, so we don\'t have to worry about the input buffers needing to be a rate-dependent size\n' +
        '\t\t\t\twasmModule._seek(this.bufferLength, currentMapSegment.rate);',
      replace:
        '\t\t\t\t// [Plantasia overlay — reverse read] For reverse playback the forward\n' +
        '\t\t\t\t// window we just filled is flipped in place, so the phase vocoder runs\n' +
        '\t\t\t\t// forward-time over time-reversed material (true reverse, pitch kept).\n' +
        '\t\t\t\t// Only the temporary WASM-input views are reversed — the stored audio\n' +
        '\t\t\t\t// buffers are never copied or flipped (one buffer, zero extra RAM).\n' +
        '\t\t\t\tif (reversedRead) buffers.forEach(buffer => buffer.reverse());\n' +
        '\n' +
        '\t\t\t\t// constantly seeking, so we don\'t have to worry about the input buffers needing to be a rate-dependent size\n' +
        '\t\t\t\twasmModule._seek(this.bufferLength, Math.abs(currentMapSegment.rate));',
    },
  ];

  let patched = source;
  for (const edit of edits) {
    if (!patched.includes(edit.find)) {
      throw new Error(
        `[vendor-stretch-engine] reverse-read overlay anchor not found: "${edit.name}". ` +
          'The signalsmith-stretch source changed — re-derive the patch against the new ' +
          'process() branch before regenerating.',
      );
    }
    patched = patched.replace(edit.find, edit.replace);
  }
  return patched;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const packageDir = join(repoRoot, 'node_modules', 'signalsmith-stretch');
  const source = readFileSync(join(packageDir, 'SignalsmithStretch.mjs'), 'utf8');
  const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const patched = patchStretchSource(source);

  const outPath = join(repoRoot, 'src', 'audio', 'playback', 'vendor', 'signalsmithStretchEngine.js');
  const banner = `/**
 * GENERATED FILE — do not edit. Regenerate with:
 *   node scripts/vendor-stretch-engine.mjs
 *
 * Source of signalsmith-stretch@${version} (MIT, Signalsmith Audio) as a
 * string, so the time-stretch engine loads identically under any bundler: the
 * runtime turns it into a Blob URL and dynamic-imports it, keeping the
 * worklet's stringified-source assembly untransformed.
 *
 * NOT verbatim upstream — a maintained reverse-on-read overlay is applied by
 * scripts/vendor-stretch-engine.mjs (patchStretchSource). See that script for
 * why; the drift test compares against the PATCHED source.
 */
`;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${banner}export const signalsmithStretchVersion = ${JSON.stringify(version)};\n\nexport default ${JSON.stringify(patched)};\n`,
  );
  console.log(`Vendored signalsmith-stretch@${version} (+reverse-read overlay) → ${outPath}`);
}
