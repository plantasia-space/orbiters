/**
 * @file src/ui/react/regions/peaksCache.ts
 * Dedupe the kit waveform peaks fetch by url. The audiowaveform JSON for a url is immutable
 * (content-addressed DO asset), so the SAME url never needs two GETs — but React's StrictMode dev
 * double-invoke of the effect (mount → cleanup → mount) otherwise fires two, and two same-orbiter
 * tiles would each fetch. One in-flight promise per url collapses all of that to a single GET; a
 * rejected fetch is evicted so a later mount can retry. Keyed by url, so distinct tracks still fetch
 * once each (one GET per voice).
 */
import { peaksFromWaveformData } from 'plantasia.space-design/react/timeline/peaks';

const peaksByUrl = new Map<string, Promise<number[] | null>>();

/** Fetch + normalize the peaks for `url`, deduped: concurrent/repeat callers share one fetch. */
export function fetchPeaks(url: string): Promise<number[] | null> {
  const cached = peaksByUrl.get(url);
  if (cached) return cached;
  const pending = fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`waveform ${r.status}`))))
    .then((json) => {
      const data = Array.isArray(json?.data) ? json.data : null;
      if (!data) return null;
      const bits = json?.bits ?? json?.bit_depth ?? 8;
      return peaksFromWaveformData({ data, bits });
    })
    .catch((err) => {
      peaksByUrl.delete(url); // don't cache a failure — let a later mount retry
      throw err;
    });
  peaksByUrl.set(url, pending);
  return pending;
}
