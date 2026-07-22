/**
 * @file hydration.js
 * @description Handles hydrated session loading, cache priming, and descriptor merging.
 * @version 1.0.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2025-01-11
 */

import { Constants } from '../../config/Constants.js';
import { normalizeTrackRelease, normalizeOrbiterRelease, normalizeWorldRelease } from './normalizers.js';
import { assembleConfig } from './assembler.js';

// ============================================================================
// Hydrated Session Loading
// ============================================================================

/**
 * Loads configuration from pre-hydrated session data, priming caches and merging descriptors.
 * @param {Object} options - Hydration options
 * @param {Object} options.trackSession - Pre-hydrated track payload
 * @param {Object} options.orbiterSession - Pre-hydrated orbiter payload
 * @param {Object} options.entangledWorldSession - Pre-hydrated world payload
 * @param {Object} options.descriptor - Additional configuration descriptor
 * @returns {Promise<Object>} Combined configuration data
 */
export async function loadFromHydratedSession({
    trackSession = null,
    orbiterSession = null,
    entangledWorldSession = null,
    descriptor = {},
    cache = Constants,
} = {}) {
    const mergedDescriptor = {
        trackId: descriptor.trackId ?? null,
        trackVersion: descriptor.trackVersion ?? null,
        orbiterId: descriptor.orbiterId ?? null,
        orbiterVersion: descriptor.orbiterVersion ?? null,
        entangledWorldId: descriptor.entangledWorldId ?? null,
        entangledWorldVersion: descriptor.entangledWorldVersion ?? null,
    };

    // Hydrate and cache track
    const hydratedTrack = trackSession ? normalizeTrackRelease(trackSession) : null;
    if (hydratedTrack?.trackId) {
        mergedDescriptor.trackId = mergedDescriptor.trackId || hydratedTrack.trackId;
        // The blob's version is deliberately NOT copied onto the descriptor.
        //
        // A hydrated payload is a cached copy handed over by the host, and the host persists
        // it on the entity it belongs to. Its version therefore ages: retention prunes
        // releases, so a blob saved months ago names a version that no longer exists, and
        // inheriting it turned every later load into a request for a dead pin. An unpinned
        // request means live, which is the standing rule anyway — latest is always the
        // default. Only a caller that explicitly asked for a version gets one.
        const hydratedVersion = hydratedTrack.version ?? trackSession?.release?.version ?? null;
        cache.setTrackRelease(hydratedTrack.trackId, trackSession, { version: hydratedVersion });
        // Also prime the live key. The host fetches this blob unversioned, so it IS the live
        // release; without this the unpinned lookup below would miss and re-fetch what we were
        // just handed, throwing away the whole point of hydrating.
        if (hydratedVersion != null) {
            cache.setTrackRelease(hydratedTrack.trackId, trackSession, { version: null });
        }
    }

    // Hydrate and cache orbiter
    const hydratedOrbiter = orbiterSession ? normalizeOrbiterRelease(orbiterSession) : null;
    if (hydratedOrbiter?.orbiterId) {
        mergedDescriptor.orbiterId = mergedDescriptor.orbiterId || hydratedOrbiter.orbiterId;
        mergedDescriptor.orbiterVersion = mergedDescriptor.orbiterVersion || hydratedOrbiter.version || null;
        cache.setOrbiterRelease(
            hydratedOrbiter.orbiterId,
            orbiterSession,
            { version: hydratedOrbiter.version ?? orbiterSession?.release?.version ?? null }
        );
    }

    // Hydrate and cache world
    const hydratedWorld = entangledWorldSession ? normalizeWorldRelease(entangledWorldSession) : null;
    if (hydratedWorld?.worldId) {
        mergedDescriptor.entangledWorldId =
            mergedDescriptor.entangledWorldId || hydratedWorld.worldId;
        mergedDescriptor.entangledWorldVersion =
            mergedDescriptor.entangledWorldVersion || hydratedWorld.version || null;
        cache.setWorldRelease(
            hydratedWorld.worldId,
            entangledWorldSession,
            { version: hydratedWorld.version ?? entangledWorldSession?.release?.version ?? null }
        );
    }

    if (!mergedDescriptor.trackId) {
        throw new Error('trackId is required to load a hydrated session');
    }

    // Use assembler to complete any missing data
    return assembleConfig(mergedDescriptor, { cache });
}
