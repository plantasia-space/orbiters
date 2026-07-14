// @vitest-environment jsdom
// (urlParams.js transitively imports Constants.js, which reads `navigator` at module load.)
import { describe, it, expect } from 'vitest';
import { getSharedClockEnabledFromUrl } from '../../src/utils/urlParams.js';

const params = (q) => new URLSearchParams(q);

describe('getSharedClockEnabledFromUrl', () => {
  it('is true for ?sharedClock=1 and ?sharedClock=true (any case/whitespace)', () => {
    expect(getSharedClockEnabledFromUrl(params('sharedClock=1'))).toBe(true);
    expect(getSharedClockEnabledFromUrl(params('sharedClock=true'))).toBe(true);
    expect(getSharedClockEnabledFromUrl(params('sharedClock=TRUE'))).toBe(true);
    expect(getSharedClockEnabledFromUrl(params('sharedClock=%201%20'))).toBe(true);
  });

  it('is false when absent or any other value (default path untouched)', () => {
    expect(getSharedClockEnabledFromUrl(params(''))).toBe(false);
    expect(getSharedClockEnabledFromUrl(params('room=studio'))).toBe(false);
    expect(getSharedClockEnabledFromUrl(params('sharedClock=0'))).toBe(false);
    expect(getSharedClockEnabledFromUrl(params('sharedClock=on'))).toBe(false);
    expect(getSharedClockEnabledFromUrl(params('sharedClock='))).toBe(false);
  });
});
