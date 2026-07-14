// @vitest-environment jsdom
/**
 * Multi-orbiter waveform efficiency: the kit peaks JSON must be fetched ONCE per url, not
 * twice (React StrictMode dev double-invoke / two same-orbiter tiles previously fired two GETs for
 * the same immutable content-addressed asset). `fetchPeaks` collapses concurrent + repeat calls for
 * one url to a single fetch, and evicts a FAILED fetch so a later mount can retry.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPeaks } from '../../src/ui/react/regions/peaksCache.ts';

const okWaveform = () => ({
  ok: true,
  json: () => Promise.resolve({ data: [0, 32, -32, 64, -64, 100, -100, 0], bits: 8 }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchPeaks — dedupe peaks JSON per url', () => {
  it('issues ONE fetch for concurrent calls to the same url; both resolve to identical peaks', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okWaveform());
    const url = 'https://assets.example/peaks/concurrent-A.json';

    const [a, b] = await Promise.all([fetchPeaks(url), fetchPeaks(url)]);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // was 2 — now one GET per url
    expect(Array.isArray(a)).toBe(true);
    expect(a).toEqual(b); // same resolved peaks for both callers
  });

  it('reuses the cached promise for a repeat call (still one fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okWaveform());
    const url = 'https://assets.example/peaks/repeat-B.json';

    await fetchPeaks(url);
    await fetchPeaks(url);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('evicts a FAILED fetch so a later call retries instead of caching the failure', async () => {
    const url = 'https://assets.example/peaks/retry-C.json';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okWaveform());

    await expect(fetchPeaks(url)).rejects.toThrow('network down');
    const peaks = await fetchPeaks(url); // retry after eviction

    expect(fetchSpy).toHaveBeenCalledTimes(2); // the failure did NOT poison the cache
    expect(Array.isArray(peaks)).toBe(true);
  });

  it('rejects a non-ok response and evicts it (retryable)', async () => {
    const url = 'https://assets.example/peaks/status-D.json';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce(okWaveform());

    await expect(fetchPeaks(url)).rejects.toThrow(/503/);
    await fetchPeaks(url); // retry succeeds

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
