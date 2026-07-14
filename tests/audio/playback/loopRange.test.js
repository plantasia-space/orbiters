import { describe, it, expect } from 'vitest';

import { normalizeLoopRange } from '../../../src/audio/playback/loopRange.js';

describe('normalizeLoopRange', () => {
  it('keeps a pending full-track loop when real duration is not known yet', () => {
    expect(normalizeLoopRange(0, 120000)).toEqual({ start: 0, end: 120000 });
  });

  it('clamps full-track loop end to the real media duration once known', () => {
    expect(normalizeLoopRange(0, 120000, { durationMs: 119432 })).toEqual({
      start: 0,
      end: 119432,
    });
  });

  it('can keep Tone loopEnd inside the decoded buffer with an epsilon', () => {
    expect(
      normalizeLoopRange(0, 120000, { durationMs: 119432, endEpsilonMs: 0.001 }),
    ).toEqual({ start: 0, end: 119431.999 });
  });

  it('preserves explicit shorter loop selections inside duration', () => {
    expect(normalizeLoopRange(1000, 5000, { durationMs: 120000 })).toEqual({
      start: 1000,
      end: 5000,
    });
  });

  it('rejects invalid bounds instead of creating an inert loop', () => {
    expect(normalizeLoopRange(Number.NaN, 5000, { durationMs: 120000 })).toBeNull();
    expect(normalizeLoopRange(0, Infinity, { durationMs: 120000 })).toBeNull();
  });

  it('enforces a minimum positive loop length', () => {
    expect(normalizeLoopRange(2000, 2000, { durationMs: 120000 })).toEqual({
      start: 2000,
      end: 2010,
    });
  });
});
