/**
 * @file normalizers.js
 * @description Normalizes raw API payloads into consistent internal data structures.
 * @version 1.0.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2025-01-11
 */

import { AXIS_ROTATION_CONSTRAINTS, MAX_MODULES } from '../../config/Constants.js';
import { sanitizeMappings } from '../../audio/effects/mappingManager.js';
import {
    resolveEffectDefinitionWithStatus,
    resolveModuleMetadataWithStatus,
} from '../../audio/effects/definitionRegistry.js';
import { resolveStorageAssetURL } from './loaders.js';

const EFFECT_AXES = ['x', 'y', 'z'];

/**
 * Nest the assembled entangled world INTO the track, while keeping it as a sibling.
 * The legacy `Main.js` re-patched this only on the bootstrap path; doing it
 * here at the combined-build means `track.entangledWorld` is present on EVERY path
 * (cache-hit / hydrated / resolution / edit-fallback), so Main.js no longer re-patches.
 * Pure + idempotent (`track.entangledWorld` === the sibling), so it can be applied at
 * each combined producer without double-nesting harm. Additive — readers that fall back
 * to the sibling are unaffected.
 * @param {object} combined - `{ track, orbiter, entangledWorld, request }`
 * @returns {object} the same shape with `track.entangledWorld` populated when both exist
 */
export function nestEntangledWorldIntoTrack(combined) {
    if (!combined?.entangledWorld || !combined?.track) {
        return combined;
    }
    return {
        ...combined,
        track: { ...combined.track, entangledWorld: combined.entangledWorld },
    };
}

function resolveAssetCandidateURL(candidate) {
    if (!candidate || typeof candidate !== 'string') {
        return null;
    }
    return resolveStorageAssetURL(candidate);
}

function normalizeImageVariantSet(imageSet) {
    if (!imageSet || typeof imageSet !== 'object') {
        return null;
    }

    const original = resolveAssetCandidateURL(imageSet.original || imageSet.url || imageSet.src || null);
    const small = resolveAssetCandidateURL(imageSet.small || imageSet.thumbnailUrl || imageSet.thumbnailURL || null);
    const mid = resolveAssetCandidateURL(imageSet.mid || imageSet.medium || null);

    if (!original && !small && !mid) {
        return null;
    }

    return {
        original: original || mid || small || null,
        mid: mid || original || small || null,
        small: small || mid || original || null,
    };
}

function normalizeImageMap(images) {
    if (!images || typeof images !== 'object' || Array.isArray(images)) {
        return null;
    }

    const normalized = Object.entries(images).reduce((acc, [key, value]) => {
        const next = normalizeImageVariantSet(value);
        if (next) {
            acc[key] = next;
        }
        return acc;
    }, {});

    return Object.keys(normalized).length ? normalized : null;
}

function normalizeImageEntries(images) {
    if (Array.isArray(images)) {
        const normalized = images
            .map((image) => {
                if (typeof image === 'string') {
                    const src = resolveAssetCandidateURL(image);
                    return src ? { src, original: src, mid: src, small: src } : null;
                }
                if (!image || typeof image !== 'object') {
                    return null;
                }
                const variantSet = normalizeImageVariantSet(image);
                if (!variantSet) {
                    return null;
                }
                return {
                    ...image,
                    src: variantSet.mid || variantSet.original || variantSet.small,
                    url: variantSet.mid || variantSet.original || variantSet.small,
                    imageUrl: variantSet.mid || variantSet.original || variantSet.small,
                    imageURL: variantSet.mid || variantSet.original || variantSet.small,
                    thumbnailUrl: variantSet.small,
                    thumbnailURL: variantSet.small,
                    original: variantSet.original,
                    mid: variantSet.mid,
                    small: variantSet.small,
                };
            })
            .filter(Boolean);

        return normalized.length ? normalized : null;
    }

    return normalizeImageMap(images);
}

function resolveTrackArtworkFromAssets(assets = {}, metadata = {}) {
    const assetImages = normalizeImageMap(assets?.images);
    const squareCover =
        assetImages?.['square-cover'] ||
        assetImages?.squareCover ||
        assetImages?.cover ||
        null;

    const metadataImage = normalizeImageVariantSet({
        original:
            metadata.artworkURL ||
            metadata.artworkUrl ||
            metadata.coverArtURL ||
            metadata.coverArtUrl ||
            metadata.coverURL ||
            metadata.coverUrl ||
            metadata.posterURL ||
            metadata.posterUrl ||
            metadata.thumbnailURL ||
            metadata.thumbnailUrl ||
            null,
    });

    const artwork = squareCover || metadataImage || null;

    return {
        images: assetImages,
        artworkURL: artwork?.mid || artwork?.original || artwork?.small || null,
    };
}

// ============================================================================
// Track Release Normalization
// ============================================================================

export function normalizeTrackRelease(payload) {
    if (!payload) return null;

    const release = payload.release && typeof payload.release === 'object' ? payload.release : payload;
    const metadata = release?.metadata || payload?.metadata || {};
    const artists = Array.isArray(metadata.artists)
        ? metadata.artists
        : metadata.artist
            ? [metadata.artist]
            : [];

    const defaultOrbiter = metadata.defaultOrbiter || metadata.orbiter || {};
    const defaultWorld =
        metadata.defaultEntangledWorld ||
        metadata.entangledWorld ||
        metadata.world ||
        {};
    const topLevelOrbiter = payload.orbiterId || payload.orbiter || null;
    const topLevelWorld = payload.worldId || payload.world || null;

    const assets = release?.assets || payload?.assets || {};
    const compressedKey = assets.compressedKey ?? null;
    const losslessKey = assets.losslessKey ?? null;
    // BE-presigned URLs for the PRIVATE user-uploads audio. Prefer these for the
    // playback source: prepending the public herbarium base to the raw private key
    // produces an unsigned 403. Keys are retained for cache identity.
    const compressedSignedURL = assets.compressedURL ?? assets.compressedUrl ?? null;
    const losslessSignedURL = assets.losslessURL ?? assets.losslessUrl ?? null;
    const waveformUrl = assets.waveformURL ?? assets.waveformUrl ?? assets.waveformKey ?? null;
    const waveformKey = assets.waveformKey ?? null;
    const packageKey = assets.packageKey ?? assets.packageURL ?? assets.packageUrl ?? null;
    const normalizedReleaseImages = normalizeImageEntries(release?.images || payload?.images || metadata?.images || null);
    const normalizedAssetArtwork = resolveTrackArtworkFromAssets(assets, metadata);
    const images = normalizedAssetArtwork.images || normalizedReleaseImages;
    const durationCandidatesSec = [
        metadata?.audioAnalysis?.duration_sec,
        metadata?.audioAnalysis?.durationSec,
        metadata?.audioNormalization?.durationSec,
        metadata?.audioNormalization?.duration_sec,
        metadata?.durationSec,
        metadata?.duration_sec,
        payload?.durationSec,
        payload?.duration_sec,
        release?.durationSec,
        release?.duration_sec,
        payload?.duration,
        metadata?.duration,
    ];
    let durationSec = null;
    for (const candidate of durationCandidatesSec) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > 0) {
            durationSec = numeric;
            break;
        }
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        const durationMsCandidates = [
            payload?.durationMs,
            payload?.duration_ms,
            metadata?.durationMs,
            metadata?.duration_ms,
            release?.durationMs,
            release?.duration_ms,
        ];
        for (const candidate of durationMsCandidates) {
            const numeric = Number(candidate);
            if (Number.isFinite(numeric) && numeric > 0) {
                durationSec = numeric / 1000;
                break;
            }
        }
    }

    const track = {
        trackId: payload.trackId || release.trackId || metadata.trackId || metadata.id || null,
        version: release.version ?? payload.version ?? null,
        snapshotAt: release.snapshotAt || payload.snapshotAt || null,
        status: release.status || payload.status || null,
        metadata,
        trackName: metadata.trackName || metadata.title || metadata.name || null,
        artists,
        releaseDate: metadata.releaseDate || metadata.publishedAt || null,
        tags: metadata.tags || null,
        additionalTags: metadata.additionalTags || null,
        playsCount: metadata.playsCount ?? metadata.playCount ?? null,
        shares: metadata.shares ?? null,
        likes: metadata.likes ?? metadata.likesCount ?? null,
        defaultOrbiterId:
            metadata.defaultOrbiterId ||
            defaultOrbiter.id ||
            metadata.orbiterId ||
            (typeof topLevelOrbiter === 'string'
                ? topLevelOrbiter
                : topLevelOrbiter?._id || topLevelOrbiter?.id) ||
            null,
        defaultOrbiterVersion:
            metadata.defaultOrbiterVersion ||
            defaultOrbiter.version ||
            topLevelOrbiter?.version ||
            null,
        defaultEntangledWorldId:
            metadata.defaultEntangledWorldId ||
            defaultWorld.id ||
            metadata.entangledWorldId ||
            metadata.worldId ||
            metadata.entangledWorld?.id ||
            metadata.world?.id ||
            (typeof topLevelWorld === 'string'
                ? topLevelWorld
                : topLevelWorld?._id || topLevelWorld?.id) ||
            null,
        defaultEntangledWorldVersion:
            metadata.defaultEntangledWorldVersion ||
            defaultWorld.version ||
            metadata.entangledWorldVersion ||
            metadata.worldVersion ||
            metadata.entangledWorld?.version ||
            metadata.world?.version ||
            topLevelWorld?.version ||
            null,
        colorPalette: metadata.colorPalette || metadata.colors || null,
        owner: payload.owner || metadata.owner || null,
        availableVersions: payload.availableVersions || [],
        isLatest: Boolean(payload.isLatest),
        canEdit: Boolean(payload.canEdit),
        assets,
        images,
        buildNotes: release.buildNotes || null,
        errorMessage: release.errorMessage || null,
        durationSec,
        durationMs: Number.isFinite(durationSec) && durationSec > 0 ? durationSec * 1000 : null,
        audioFileMP3URL: resolveStorageAssetURL(compressedSignedURL ?? compressedKey),
        audioFileWAVURL: resolveStorageAssetURL(losslessSignedURL ?? losslessKey),
        waveformJSONURL: resolveStorageAssetURL(waveformUrl),
        waveformJSONKey: waveformKey,
        audioFileMP3Key: compressedKey,
        audioFileWAVKey: losslessKey,
        packageManifestURL: resolveStorageAssetURL(packageKey),
        packageManifestKey: packageKey,
        artworkURL: normalizedAssetArtwork.artworkURL,
    };

    return track;
}

// ============================================================================
// Orbiter Release Normalization
// ============================================================================

export function normalizeOrbiterRelease(payload) {
    if (!payload) return null;

    const release = payload.release || {};
    const metadata = release.metadata || {};
    const owner = payload.owner || metadata.owner || release.owner || null;
    const permissionsPayload =
        payload.permissionsPayload || metadata.permissionsPayload || release.permissionsPayload || null;

    const parameters = normalizeOrbiterParameters(metadata.parameters || metadata.orbiterParams || {});
    const colorsSource = metadata.orbiterColors || metadata.colors || metadata.design?.colors || {};
    const effects = normalizeOrbiterEffects(
        metadata.effects ||
        metadata.orbiterEffects ||
        release.effects ||
        {}
    );

    const orbiterJSONURL = metadata.orbiterJSONURL
        || release.assets?.orbiterFileURLs?.[0]
        || release.assets?.orbiterFileURL
        || release.assets?.orbiterFile;

    // The linked-entity ids captured at release time — the author's demo session: the reference
    // track this orbiter was released over (its canonical "how it sounds") and optionally the world
    // it was demoed in. New releases store bare ids; legacy payloads may hold hydrated preview
    // objects, so extract defensively. This is what lets an orbiter card boot as a playable
    // session even though an orbiter carries no audio of its own.
    const entitiesPreview =
        metadata.entitiesPreview && typeof metadata.entitiesPreview === 'object'
            ? metadata.entitiesPreview
            : {};
    const referenceTrackId = firstEntityId(
        entitiesPreview.trackId,
        entitiesPreview.track?.trackId,
        entitiesPreview.track?._id
    );
    const referenceEntangledWorldId = firstEntityId(
        entitiesPreview.entangledWorldId,
        entitiesPreview.entangledWorld?.worldId,
        entitiesPreview.entangledWorld?._id
    );

    return {
        orbiterId: payload.orbiterId || metadata.orbiterId || metadata.id || null,
        version: release.version ?? null,
        snapshotAt: release.snapshotAt || null,
        status: release.status || null,
        metadata,
        orbiterName: metadata.orbiterName || metadata.name || null,
        developer: metadata.developer || payload.developer || null,
        availability: metadata.availability ?? metadata.isPublic ?? null,
        owner,
        permissionsPayload,
        orbiterColors: {
            color1: colorsSource.color1 || colorsSource.primary || colorsSource?.[0] || null,
            color2: colorsSource.color2 || colorsSource.secondary || colorsSource?.[1] || null,
            // Color C — the saved selected/active "success" highlight. Carried through on load so
            // the play UI reads it automatically (not just edit mode); null lets the CSS fallback apply.
            color3: colorsSource.color3 || colorsSource.tertiary || colorsSource?.[2] || null,
        },
        orbiterParams: parameters,
        effects,
        orbiterJSONURL,
        referenceTrackId,
        referenceEntangledWorldId,
        assets: release.assets || null,
        buildNotes: release.buildNotes || null,
        errorMessage: release.errorMessage || null,
    };
}

/** The first candidate that is a non-empty id string. Trims; null when none qualifies. */
function firstEntityId(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return null;
}

export function normalizeOrbiterParameters(parameters) {
    let normalized = {};

    if (Array.isArray(parameters)) {
        parameters.forEach((param) => {
            if (!param) return;
            const keyCandidate = param.axis || param.key || param.id || param.name || param.slug;
            if (!keyCandidate) return;
            const key = typeof keyCandidate === 'string' ? keyCandidate.toLowerCase() : keyCandidate;
            normalized[key] = { ...param };
        });
    } else if (typeof parameters === 'object' && parameters !== null) {
        normalized = Object.entries(parameters).reduce((acc, [key, value]) => {
            if (!value || typeof value !== 'object') return acc;
            acc[key] = { ...value };
            return acc;
        }, {});
    }

    const axisKeys = new Set(['x', 'y', 'z']);
    const axisConstraints = AXIS_ROTATION_CONSTRAINTS;
    const clampToAxisRange = (value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return axisConstraints.equilibrium ?? 0;
        }
        return Math.min(axisConstraints.max, Math.max(axisConstraints.min, numeric));
    };

    Object.entries(normalized).forEach(([key, param]) => {
        if (!param || typeof param !== 'object') return;

        const fallbackValue =
            typeof param.initValue === 'number'
                ? param.initValue
                : typeof param.value === 'number'
                    ? param.value
                    : typeof param.defaultValue === 'number'
                        ? param.defaultValue
                        : 0;

        if (typeof param.initValue !== 'number') {
            param.initValue = fallbackValue;
        }
        if (typeof param.value !== 'number') {
            param.value = fallbackValue;
        }
        if (typeof param.defaultValue !== 'number') {
            param.defaultValue = fallbackValue;
        }
        if (typeof param.min !== 'number') {
            param.min = typeof param.lower === 'number' ? param.lower : -1;
        }
        if (typeof param.max !== 'number') {
            param.max = typeof param.upper === 'number' ? param.upper : 1;
        }
        if (typeof param.step !== 'number') {
            param.step = 0.01;
        }

        if (!axisKeys.has(key)) return;

        param.min = axisConstraints.min;
        param.max = axisConstraints.max;
        param.minLimit = axisConstraints.min;
        param.maxLimit = axisConstraints.max;
        param.step = axisConstraints.step;
        param.initValue = clampToAxisRange(param.initValue);
        param.value = clampToAxisRange(param.value);
        param.defaultValue = clampToAxisRange(param.defaultValue);
    });

    axisKeys.forEach((axis) => {
        if (normalized[axis]) {
            return;
        }
        const fallbackValue = clampToAxisRange(axisConstraints.equilibrium ?? 0);
        normalized[axis] = {
            axis,
            label: axis.toUpperCase(),
            description: `Axis ${axis.toUpperCase()} rotation`,
            min: axisConstraints.min,
            max: axisConstraints.max,
            minLimit: axisConstraints.min,
            maxLimit: axisConstraints.max,
            step: axisConstraints.step,
            initValue: fallbackValue,
            value: fallbackValue,
            defaultValue: fallbackValue,
        };
    });

    return normalized;
}

export function normalizeOrbiterEffects(effects = {}) {
    const normalizeModule = (module = {}) => {
        const range = module?.range || {};
        const effectId = module?.effectId ?? null;
        const moduleId = module?.moduleId ?? null;
        const requestedVersion = module?.effectVersion ?? null;
        const effectResolution = resolveEffectDefinitionWithStatus(effectId, requestedVersion, { allowPatch: true });
        const manifestMetadataResult = resolveModuleMetadataWithStatus(
            effectId,
            moduleId ?? null,
            requestedVersion,
            { allowPatch: true },
        );
        const manifestMetadata = manifestMetadataResult.moduleMetadata;
        const incomingMetadata =
            module?.moduleMetadata && typeof module.moduleMetadata === 'object'
                ? {
                      label: module.moduleMetadata.label ?? null,
                      description: module.moduleMetadata.description ?? null,
                  }
                : null;
        const resolvedLabel = manifestMetadata?.label ?? incomingMetadata?.label ?? null;
        const resolvedDescription = manifestMetadata?.description ?? incomingMetadata?.description ?? null;
        const moduleMetadata =
            resolvedLabel || resolvedDescription
                ? {
                      label: resolvedLabel,
                      description: resolvedDescription,
                  }
                : null;
        const dimensionId =
            module?.dimensionId ??
            manifestMetadata?.dimensionId ??
            null;
        const dimensionLabel =
            module?.dimensionLabel ??
            manifestMetadata?.dimensionLabel ??
            null;
        const compat =
            manifestMetadataResult.missingEffect ||
            manifestMetadataResult.missingModuleId ||
            effectResolution.upgradedFromVersion
                ? {
                      missingEffect: Boolean(manifestMetadataResult.missingEffect),
                      missingModuleId: Boolean(manifestMetadataResult.missingModuleId),
                      requestedVersion: requestedVersion ?? null,
                      resolvedVersion: manifestMetadataResult.resolvedVersion ?? effectResolution.resolvedVersion ?? null,
                      upgradedFromVersion: effectResolution.upgradedFromVersion ?? null,
                  }
                : null;
        return {
            effectId,
            effectVersion:
                module?.effectVersion ?? manifestMetadataResult.resolvedVersion ?? effectResolution.resolvedVersion ?? null,
            moduleId,
            moduleMetadata: moduleMetadata ? { ...moduleMetadata } : null,
            inputParamId: module?.inputParamId ?? null,
            range: {
                min: Number.isFinite(range.min) ? Number(range.min) : null,
                max: Number.isFinite(range.max) ? Number(range.max) : null,
                equilibrium: Number.isFinite(range.equilibrium ?? range.init)
                    ? Number(range.equilibrium ?? range.init)
                    : null,
            },
            settings:
                module?.settings && typeof module.settings === 'object' && !Array.isArray(module.settings)
                    ? { ...module.settings }
                    : undefined,
            mappings: sanitizeMappings(module?.mappings),
            dimensionId,
            dimensionLabel,
            compat,
            controlNormalized: (() => {
                const numeric = Number(module?.controlNormalized);
                if (!Number.isFinite(numeric)) return null;
                if (numeric <= 0) return 0;
                if (numeric >= 1) return 1;
                return numeric;
            })(),
        };
    };

    const normalizeRack = (rack = {}) => {
        const modules = Array.isArray(rack?.modules)
            ? rack.modules.slice(0, MAX_MODULES).map((module) => normalizeModule(module))
            : [];

        while (modules.length < MAX_MODULES) {
            modules.push(normalizeModule());
        }

        return {
            dimensionId: rack?.dimensionId ?? null,
            dimensionLabel: rack?.dimensionLabel ?? null,
            modules,
        };
    };

    return EFFECT_AXES.reduce((acc, axis) => {
        acc[axis] = normalizeRack(effects?.[axis]);
        return acc;
    }, {});
}

// ============================================================================
// Entangled World Release Normalization
// ============================================================================

export function normalizeWorldRelease(payload) {
    if (!payload) return null;

    const release = payload.release || {};
    const metadata = release.metadata || {};
    const astronomicalBody = metadata?.step_one?.astronomical_body || metadata?.step_one?.astronomicalBody || null;

    const owner = metadata.owner || payload.owner || payload.entangledWorldPreview?.owner || null;
    const worldArtist = metadata.worldArtist || payload.entangledWorldPreview?.worldArtist || null;
    const worldId = payload.worldId || metadata.worldId || metadata.id || null;
    const version = release.version ?? null;

    // Direct asset URL only. Orbiters renders worlds as the runtime textured sphere and never
    // loads the authored GLB, so this field exists for progress reporting + debugging.
    const modelURL = metadata.modelURL
        || release.assets?.glbURL
        || release.assets?.glbUrls?.[0]
        || release.assets?.glb
        || release.assets?.glbFileURL
        || null;

    return {
        worldId,
        version,
        snapshotAt: release.snapshotAt || null,
        status: release.status || null,
        metadata,
        sciName: metadata.sciName || metadata.scientificName || null,
        artName: metadata.artName || metadata.displayName || null,
        owner,
        worldArtist,
        orbitalPeriod: metadata.orbitalPeriod || metadata.orbitPeriod || null,
        moonAmount: metadata.moonAmount ?? metadata.moons ?? null,
        exoplanetData: metadata.exoplanetData || null,
        frequencySources: {
            minimumCosmicLfo: astronomicalBody?.minimumCosmicLfo ?? astronomicalBody?.minimum_cosmic_lfo ?? null,
            stellarLuminosityLsun: astronomicalBody?.stellarLuminosityLsun ?? astronomicalBody?.stellar_luminosity_lsun ?? null,
            frequencyCpd: astronomicalBody?.frequencyCpd ?? astronomicalBody?.frequency_cpd ?? null,
            mass: astronomicalBody?.mass ?? null
        },
        modelURL,
        images: release.images || metadata.images || null,
        assets: release.assets || null,
        buildNotes: release.buildNotes || null,
        errorMessage: release.errorMessage || null,
    };
}
