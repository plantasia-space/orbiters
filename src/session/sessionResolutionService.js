import { sessionDescriptorSignature, sanitizeId } from './sessionDescriptor.js';
import { resolveSessionEntities } from './entityResolver.js';
import { hydrateTrackDurationFromWaveform } from './trackDurationHydration.js';

function hasResolvedDuration(track = null) {
  const durationSec = Number(
    track?.durationSec ??
    track?.metadata?.durationSec ??
    track?.metadata?.audioAnalysis?.duration_sec,
  );
  return Number.isFinite(durationSec) && durationSec > 0;
}

function hasWaveformFallback(track = null) {
  return Boolean(track?.waveformJSONURL || track?.waveformURL || track?.waveformJsonUrl);
}

/**
 * Lightweight cache + orchestration layer around entity resolution.
 * Ensures descriptor signatures are deduped and optional hooks run on fresh resolutions.
 */
export class SessionResolutionService {
  /**
   * @param {Object} [options]
   * @param {(result: import('./entityResolver.js').SessionResolutionResult) => (void|Promise<void>)} [options.onResolved]
   */
  constructor({ onResolved } = {}) {
    this.cache = new Map();
    this.lastSignature = null;
    this.lastResult = null;
    this.onResolved = typeof onResolved === 'function' ? onResolved : null;
  }

  normalizeDescriptor(descriptor = {}) {
    return {
      trackId: sanitizeId(descriptor.trackId),
      trackVersion: sanitizeId(descriptor.trackVersion),
      orbiterId: sanitizeId(descriptor.orbiterId),
      orbiterVersion: sanitizeId(descriptor.orbiterVersion),
      entangledWorldId: sanitizeId(descriptor.entangledWorldId),
      entangledWorldVersion: sanitizeId(descriptor.entangledWorldVersion),
    };
  }

  hasSignature(signature) {
    return this.cache.has(signature);
  }

  async resolve({ descriptor = {}, hydratedBlobs = {}, source = 'unknown' } = {}) {
    const normalizedDescriptor = this.normalizeDescriptor(descriptor);
    const signature = sessionDescriptorSignature(normalizedDescriptor);

    if (this.cache.has(signature)) {
      return this.cache.get(signature);
    }

    const result = await resolveSessionEntities({
      descriptor: normalizedDescriptor,
      hydratedBlobs,
      source,
    });

    if (result?.ok && result?.track) {
      result.track = await hydrateTrackDurationFromWaveform(result.track, { timeoutMs: 1500 });
    }

    if (this.onResolved && result?.ok) {
      await this.onResolved(result);
    }

    // Only cache successful resolutions that don't rely on fallback entities.
    // If the resolution used fallbacks (e.g. 403 on private orbiter before auth token arrived),
    // we must not cache it — a subsequent call after auth should re-resolve with real data.
    const hasFallbackEntities = result?.debug?.fallbacks?.length > 0;
    const allowCacheWithoutHydratedDuration = result?.ok &&
      result?.track &&
      !hasResolvedDuration(result.track) &&
      hasWaveformFallback(result.track);
    if (result?.ok && !hasFallbackEntities && !allowCacheWithoutHydratedDuration) {
      this.cache.set(signature, result);
    }
    this.lastSignature = signature;
    this.lastResult = result;

    return result;
  }

  clearCache() {
    this.cache.clear();
    this.lastSignature = null;
    this.lastResult = null;
  }

  getLastResult() {
    return this.lastResult;
  }
}

export default SessionResolutionService;
