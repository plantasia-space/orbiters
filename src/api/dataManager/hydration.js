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
        mergedDescriptor.trackVersion = mergedDescriptor.trackVersion || hydratedTrack.version || null;
        cache.setTrackRelease(
            hydratedTrack.trackId,
            trackSession,
            { version: hydratedTrack.version ?? trackSession?.release?.version ?? null }
        );
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
