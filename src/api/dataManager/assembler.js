/**
 * @file assembler.js
 * @description Orchestrates fetching and combining track, orbiter, and world data into unified configurations.
 * @version 1.0.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2025-01-11
 */

import { Constants } from '../../config/Constants.js';
import { createDefaultOrbiterFallback, DEFAULT_ORBITER_FALLBACK } from '../../defaults/orbiterFallback.js';
import { createDefaultEntangledWorldFallback, DEFAULT_ENTANGLED_WORLD_FALLBACK } from '../../defaults/entangledWorldFallback.js';
import notifications from '../../core/AppNotifications.js';
import { getT } from '../../i18n/index.js';
import {
    fetchTrackRelease,
    fetchOrbiterRelease,
    fetchEntangledWorldRelease
} from './loaders.js';
import {
    normalizeTrackRelease,
    normalizeOrbiterRelease,
    normalizeWorldRelease,
    normalizeOrbiterEffects,
    nestEntangledWorldIntoTrack
} from './normalizers.js';
import {
    createDefaultStacks,
    ensureDimensionOnStack,
    ensureAxisLength,
    cloneModuleState,
    cloneStacksState
} from '../../core/stackUtils.js';
import { effectsFromStacks } from '../../session/editModeHelpers.js';

const EFFECT_AXES = ['x', 'y', 'z'];
const DEFAULT_STACK_ID = 'deck-i';
const DEFAULT_DIMENSION_ID = 'EW::I';
const DEFAULT_TRACK_HYDRATE_LEVEL = '2';

function normalizeComparable(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    return null;
}

function pickFirstNonEmpty(values = []) {
    for (const value of values) {
        const normalized = normalizeComparable(value);
        if (normalized) {
            return normalized;
        }
    }
    return null;
}

function idsMatch(expected, candidate) {
    const normalizedExpected = normalizeComparable(expected);
    const normalizedCandidate = normalizeComparable(candidate);
    if (!normalizedExpected || !normalizedCandidate) {
        return false;
    }
    return normalizedExpected === normalizedCandidate;
}

function shouldDebugEngineStacks() {
    try {
        return Boolean(typeof window !== 'undefined' && window.__DEBUG_ENGINE_STACKS);
    } catch {
        return false;
    }
}

function isUnavailablePlaceholder(value) {
    return Boolean(value && typeof value === 'object' && value.unavailable === true);
}

function pickHydratedRelease(...candidates) {
    for (const candidate of candidates) {
        if (candidate && !isUnavailablePlaceholder(candidate)) {
            return candidate;
        }
    }
    return null;
}

function notifyUnavailableEntity(preview, entityType) {
    if (!preview?.unavailable) {
        return false;
    }
    const reason = normalizeComparable(preview?.reason) || 'invalid';
    // When fallbackEligible is explicitly false, BE is telling FE not to substitute
    // a fallback. Render the generic "unavailable" copy instead of "fallback in use".
    const reasonKey = preview?.fallbackEligible === false ? 'forbidden' : reason;
    const t = getT();
    const key = `entity.unavailable.${entityType}.${reasonKey}`;
    const fallbackKey = `entity.unavailable.${entityType}.invalid`;
    const message = t(key);
    const safeMessage = message && message !== key ? message : t(fallbackKey);
    notifications.showToast(safeMessage, 'warning');
    return true;
}

// ============================================================================
// Notification & Fallback Seams
// ============================================================================

// Default notifier: owns the module-singleton once-guards + the real toast/i18n
// side-effects, reproducing today's exact behavior. The assembler routes every
// toast through this object so the side-effect surface can be injected/observed
// without changing WHEN or WHETHER a toast fires.
function createDefaultNotifier() {
    let orbiterFallbackNotified = false;
    let orbiterUnavailableNotified = false;
    let worldUnavailableNotified = false;

    return {
        // Fired once per world-preview unavailable (guarded by worldUnavailableNotified).
        notifyWorldPreviewUnavailable(preview) {
            if (worldUnavailableNotified) {
                return;
            }
            if (notifyUnavailableEntity(preview, 'entangled-world')) {
                worldUnavailableNotified = true;
            }
        },
        // Fired once per orbiter-preview unavailable (guarded by orbiterUnavailableNotified).
        notifyOrbiterPreviewUnavailable(preview) {
            if (orbiterUnavailableNotified) {
                return;
            }
            if (notifyUnavailableEntity(preview, 'orbiter')) {
                orbiterUnavailableNotified = true;
            }
        },
        // Orbiter fetch failed → either an unavailable toast (when BE supplied an
        // unavailable block) or the generic orbiter-fallback toast. Mirrors the
        // pre-refactor branch exactly, including the two distinct once-guards.
        notifyOrbiterFallback({ unavailableInfo = null, isNotFound = false } = {}) {
            if (unavailableInfo) {
                if (!orbiterUnavailableNotified) {
                    const fired = notifyUnavailableEntity(
                        { unavailable: true, ...unavailableInfo },
                        'orbiter'
                    );
                    if (fired) {
                        orbiterUnavailableNotified = true;
                    }
                }
            } else if (!orbiterFallbackNotified) {
                const t = getT();
                notifications.showToast(t('notifications.orbiterFallback'), isNotFound ? 'info' : 'warning');
                orbiterFallbackNotified = true;
            }
        },
        // Orbiter resolved cleanly (hydration match or successful fetch) → re-arm
        // the generic fallback guard, matching the pre-refactor `orbiterFallbackNotified = false`.
        clearOrbiterFallback() {
            orbiterFallbackNotified = false;
        },
        // World fetch threw with an unavailable block → fire once.
        notifyWorldUnavailable(unavailableInfo) {
            if (unavailableInfo && !worldUnavailableNotified) {
                const fired = notifyUnavailableEntity(
                    { unavailable: true, ...unavailableInfo },
                    'entangled-world'
                );
                if (fired) {
                    worldUnavailableNotified = true;
                }
            }
        },
        // Public reset for the orbiter-fallback guard only (matches the exported
        // resetOrbiterFallbackNotification — the other guards stayed module-level lets).
        reset() {
            orbiterFallbackNotified = false;
        },
    };
}

const defaultNotifier = createDefaultNotifier();

// Default fallback strategy: the real fallback factories. Injectable so a test
// can supply stubs without re-importing the defaults.
const defaultFallbackStrategy = {
    createOrbiterFallback: createDefaultOrbiterFallback,
    createWorldFallback: createDefaultEntangledWorldFallback,
    // No-world-id path: normalize the local default world fallback (or null).
    createDefaultWorld() {
        return DEFAULT_ENTANGLED_WORLD_FALLBACK
            ? normalizeWorldRelease(DEFAULT_ENTANGLED_WORLD_FALLBACK)
            : null;
    },
};

function summarizeStacks(stacks = {}) {
    return Object.entries(stacks || {}).map(([stackId, stack]) => {
        const dimensions = stack?.dimensions || {};
        return {
            stackId,
            dimensionCount: Object.keys(dimensions).length,
            dimensions: Object.entries(dimensions).map(([dimensionId, dimension]) => {
                const axes = EFFECT_AXES.map((axis) => {
                    const modules = Array.isArray(dimension?.axes?.[axis]?.modules)
                        ? dimension.axes[axis].modules
                        : [];
                    const populated = modules.filter((module) => module?.effectId);
                    return {
                        axis,
                        totalSlots: modules.length,
                        populatedCount: populated.length,
                        moduleIds: populated.map((module) => ({
                            effectId: module.effectId,
                            moduleId: module.moduleId ?? null,
                        })),
                    };
                });
                return { dimensionId, axes };
            }),
        };
    });
}

function debugStacksSnapshot(label, stacks, context = {}) {
    if (!shouldDebugEngineStacks()) {
        return;
    }
    try {
        const summary = summarizeStacks(stacks);
        console.groupCollapsed(`[EngineStacks] ${label}`);
        console.log('Context:', context);
        const flatSummary = summary.flatMap((stack) =>
            stack.dimensions.map((dimension) => ({
                stackId: stack.stackId,
                dimensionId: dimension.dimensionId,
                axes: dimension.axes
                    .map(
                        (axis) =>
                            `${axis.axis}: ${axis.populatedCount}/${axis.totalSlots}`,
                    )
                    .join(' | '),
            })),
        );
        if (flatSummary.length) {
            console.table(flatSummary);
        } else {
            console.log('No dimensions found.');
        }
        console.log('Full stacks snapshot:', stacks);
        console.groupEnd();
    } catch (error) {
        console.warn('[EngineStacks] Failed to log stacks snapshot', error);
    }
}

function buildHydratedOrbiterPayload({ orbiterId, release }) {
    if (!orbiterId || !release || typeof release !== 'object') {
        return null;
    }
    const metadata = release.metadata || {};
    return {
        success: true,
        orbiterId,
        release: {
            ...release,
            metadata: {
                ...metadata,
                orbiterId: metadata.orbiterId || metadata.id || orbiterId,
                id: metadata.id || orbiterId,
            },
        },
        availableVersions: [],
        isLatest: true,
    };
}

function buildHydratedWorldPayload({ worldId, release }) {
    if (!worldId || !release || typeof release !== 'object') {
        return null;
    }
    const metadata = release.metadata || {};
    const permissions = metadata.permissions || {};
    return {
        success: true,
        worldId,
        release: {
            ...release,
            metadata: {
                ...metadata,
                permissions: {
                    ...permissions,
                    entityId: permissions.entityId || worldId,
                },
                worldId: metadata.worldId || metadata.id || worldId,
                id: metadata.id || worldId,
            },
        },
        availableVersions: [],
        isLatest: true,
    };
}

export function applyOrbiterSessionHydration(orbiter, sessionPayload) {
    if (!orbiter || !sessionPayload || typeof sessionPayload !== 'object') {
        return false;
    }
    const stacksSource =
        sessionPayload.stacks && typeof sessionPayload.stacks === 'object'
            ? sessionPayload.stacks
            : null;
    let stacksApplied = false;
    let clonedStacks = null;
    if (stacksSource) {
        clonedStacks = cloneStacksState(stacksSource);
        orbiter.stacks = clonedStacks;
        orbiter.effects = effectsFromStacks(clonedStacks, { includeAllDimensions: true });
        stacksApplied = true;
        debugStacksSnapshot('applyOrbiterSessionHydration :: reused hydrated stacks', clonedStacks, {
            source: 'orbiterSession',
        });
    }

    if (sessionPayload.selection && typeof sessionPayload.selection === 'object') {
        orbiter.selection = { ...sessionPayload.selection };
        orbiter.stackSelection = { ...sessionPayload.selection };
    }

    if (sessionPayload.engine && typeof sessionPayload.engine === 'object') {
        orbiter.engine = {
            ...(orbiter.engine || {}),
            ...sessionPayload.engine,
        };
    }

    orbiter.sessionState = {
        ...sessionPayload,
        stacks: stacksSource ? cloneStacksState(stacksSource) : sessionPayload.stacks ?? null,
    };

    return stacksApplied;
}

function isToneEngineOrbiter(orbiter) {
    if (!orbiter || typeof orbiter !== 'object') {
        return false;
    }
    if (orbiter.sessionState) {
        return true;
    }
    if (orbiter.metadata && orbiter.metadata.orbiterSession) {
        return true;
    }
    if (orbiter.engine && typeof orbiter.engine === 'object') {
        const type = String(orbiter.engine.type || orbiter.engine.engineType || '').toLowerCase();
        if (type.includes('tone')) {
            return true;
        }
    }
    return Boolean(orbiter.stacks && Object.keys(orbiter.stacks).length);
}

// ============================================================================
// Effects to Stacks Conversion
// ============================================================================

export function effectsToStacks(
    effects = {},
    { stackId = DEFAULT_STACK_ID, dimensionId = DEFAULT_DIMENSION_ID } = {}
) {
    const stacks = createDefaultStacks();
    const stack = stacks[stackId] || stacks[DEFAULT_STACK_ID];
    if (!stack) return stacks;

    const ensureDimension = (targetDimensionId, label = null) => {
        const resolvedId = targetDimensionId || dimensionId;
        const resolvedLabel = label || resolvedId || dimensionId;
        return ensureDimensionOnStack(stack, resolvedId, {
            dimensionLabel: resolvedLabel,
            createIfMissing: true,
        });
    };

    EFFECT_AXES.forEach((axis) => {
        const axisConfig = effects?.[axis];
        const modules = Array.isArray(axisConfig?.modules) ? axisConfig.modules : [];
        const modulesByDimension = modules.reduce((acc, module) => {
            const targetId = module?.dimensionId || dimensionId;
            if (!acc.has(targetId)) {
                acc.set(targetId, []);
            }
            acc.get(targetId).push(module);
            return acc;
        }, new Map());

        if (modulesByDimension.size === 0) {
            const defaultDimension = ensureDimension(dimensionId);
            const axisState = defaultDimension.axes[axis];
            ensureAxisLength(axisState);
            axisState.modules.forEach((_, index) => {
                axisState.modules[index] = cloneModuleState({}, { includeDimensionMetadata: false });
            });
            return;
        }

        modulesByDimension.forEach((dimensionModules, targetDimensionId) => {
            const labelCandidate =
                dimensionModules.find((module) => module?.dimensionLabel)?.dimensionLabel || null;
            const dimensionState = ensureDimension(targetDimensionId, labelCandidate);
            const axisState = dimensionState.axes[axis];
            ensureAxisLength(axisState);
            axisState.modules.forEach((_, index) => {
                const incoming = dimensionModules[index];
                axisState.modules[index] = incoming
                    ? cloneModuleState(incoming, { includeDimensionMetadata: false })
                    : cloneModuleState({}, { includeDimensionMetadata: false });
            });
        });
    });

    debugStacksSnapshot('effectsToStacks :: derived stacks from effects payload', stacks, {
        stackId,
        defaultDimensionId: dimensionId,
        source: 'effectsToStacks',
    });

    return stacks;
}

// ============================================================================
// Orbiter Fallback Application
// ============================================================================

function applyOrbiterFallback(orbiter, orbiterId, version) {
    console.warn('[DataManager] Orbiter release missing core parameters. Applying legacy fallback defaults.');
    const fallbackMeta = DEFAULT_ORBITER_FALLBACK.release.metadata;
    const fallbackParams = fallbackMeta.parameters;

    if (!orbiter.orbiterParams || Object.keys(orbiter.orbiterParams).length === 0) {
        orbiter.orbiterParams = { ...fallbackParams };
    }

    if (!orbiter.orbiterJSONURL) {
        orbiter.orbiterJSONURL = fallbackMeta.orbiterJSONURL;
    }

    if (!orbiter.orbiterColors) {
        orbiter.orbiterColors = { ...fallbackMeta.orbiterColors };
    }

    if (!orbiter.effects) {
        orbiter.effects = normalizeOrbiterEffects(fallbackMeta.effects || {});
    }
}

// ============================================================================
// Configuration Assembly
// ============================================================================

export async function assembleConfig(
    request,
    { cache = Constants, fallbacks = defaultFallbackStrategy, notify = defaultNotifier } = {}
) {
    if (!request?.trackId) {
        throw new Error('trackId is required to assemble configuration data.');
    }

    // Check if we can skip deep hydration if we already have the entities in cache
    let hydrateLevel = DEFAULT_TRACK_HYDRATE_LEVEL;
    if (request.orbiterId && request.entangledWorldId) {
        const hasOrbiter = Boolean(cache.getOrbiterRelease(request.orbiterId, { version: request.orbiterVersion }));
        const hasWorld = Boolean(cache.getWorldRelease(request.entangledWorldId, { version: request.entangledWorldVersion }));
        if (hasOrbiter && hasWorld) {
            hydrateLevel = null;
        }
    }

    // Fetch and normalize track
    const trackPayload = await fetchTrackRelease(request.trackId, {
        version: request.trackVersion,
        hydrate: hydrateLevel,
        cache,
    });
    if (!trackPayload) {
        console.warn('[DataManager] assembleConfig: no track payload for', request.trackId);
        return null;
    }
    
    
    const track = normalizeTrackRelease(trackPayload);

    // Resolve entity IDs
    let resolvedOrbiterId = request.orbiterId || track.defaultOrbiterId;
    let resolvedWorldId = request.entangledWorldId || track.defaultEntangledWorldId;
    let resolvedOrbiterVersion = request.orbiterVersion || track.defaultOrbiterVersion || null;
    let resolvedWorldVersion = request.entangledWorldVersion || track.defaultEntangledWorldVersion || null;

    const hydrationPayload = trackPayload?.hydration || null;
    // Track release hydration may now substitute an unavailable placeholder for the
    // linked release per the orbiter/world unavailable-dependency contract. Treat
    // placeholders as absent so the standard fallback path runs.
    const hydratedOrbiterReleaseData = pickHydratedRelease(
        hydrationPayload?.orbiterRelease,
        hydrationPayload?.orbiterFallbackRelease
    );
    const hydratedWorldReleaseData = pickHydratedRelease(
        hydrationPayload?.worldRelease,
        hydrationPayload?.worldFallbackRelease
    );

    const hydratedOrbiterId = pickFirstNonEmpty([
        hydrationPayload?.orbiterId,
        hydrationPayload?.orbiterFallbackId,
        hydrationPayload?.orbiter?.orbiterId,
        hydrationPayload?.orbiter?._id,
        hydratedOrbiterReleaseData?.metadata?.orbiterId,
        hydratedOrbiterReleaseData?.metadata?.id,
    ]);

    const hydratedWorldId = pickFirstNonEmpty([
        hydrationPayload?.worldId,
        hydrationPayload?.worldFallbackId,
        hydrationPayload?.world?.worldId,
        hydrationPayload?.world?._id,
        hydratedWorldReleaseData?.metadata?.permissions?.entityId,
        hydratedWorldReleaseData?.metadata?.worldId,
        hydratedWorldReleaseData?.metadata?.id,
    ]);

    const hydratedOrbiterPayload = buildHydratedOrbiterPayload({
        orbiterId: hydratedOrbiterId || resolvedOrbiterId || track.defaultOrbiterId || null,
        release: hydratedOrbiterReleaseData,
    });
    const hydratedWorldPayload = buildHydratedWorldPayload({
        worldId: hydratedWorldId || resolvedWorldId || track.defaultEntangledWorldId || null,
        release: hydratedWorldReleaseData,
    });

    const hydratedOrbiterVersion = pickFirstNonEmpty([
        hydrationPayload?.orbiterVersion,
        hydratedOrbiterPayload?.release?.version,
    ]);
    const hydratedWorldVersion = pickFirstNonEmpty([
        hydrationPayload?.worldVersion,
        hydratedWorldPayload?.release?.version,
    ]);

    const worldPreview = hydrationPayload?.worldPreview?.[0] || null;
    const orbiterPreview = hydrationPayload?.orbiterPreview?.[0] || null;
    notify.notifyWorldPreviewUnavailable(worldPreview);
    notify.notifyOrbiterPreviewUnavailable(orbiterPreview);

    const hydratedWorldResolvedId = hydratedWorldPayload?.worldId || hydratedWorldId;
    if (resolvedWorldId && !resolvedWorldVersion && hydratedWorldVersion && idsMatch(resolvedWorldId, hydratedWorldResolvedId)) {
        resolvedWorldVersion = hydratedWorldVersion;
    }

    if (!resolvedWorldId) {
        const metadataWorld =
            track.metadata?.defaultEntangledWorld ||
            track.metadata?.entangledWorld ||
            track.metadata?.world ||
            null;
        if (metadataWorld && typeof metadataWorld === 'object') {
            resolvedWorldId =
                metadataWorld.id ||
                metadataWorld.worldId ||
                metadataWorld._id ||
                resolvedWorldId;
            resolvedWorldVersion =
                metadataWorld.version ??
                metadataWorld.worldVersion ??
                metadataWorld.entangledWorldVersion ??
                resolvedWorldVersion;
        }
        if (!resolvedWorldId && hydratedWorldResolvedId) {
            resolvedWorldId = hydratedWorldResolvedId;
            resolvedWorldVersion = resolvedWorldVersion || hydratedWorldVersion;
        }
    }

    if (!resolvedOrbiterId) {
        const hydratedOrbiterResolvedId = hydratedOrbiterPayload?.orbiterId || hydratedOrbiterId;
        if (hydratedOrbiterResolvedId) {
            resolvedOrbiterId = hydratedOrbiterResolvedId;
            resolvedOrbiterVersion = resolvedOrbiterVersion || hydratedOrbiterVersion;
        }
    }

    const hydratedOrbiterResolvedId = hydratedOrbiterPayload?.orbiterId || hydratedOrbiterId;
    if (resolvedOrbiterId && !resolvedOrbiterVersion && hydratedOrbiterVersion && idsMatch(resolvedOrbiterId, hydratedOrbiterResolvedId)) {
        resolvedOrbiterVersion = hydratedOrbiterVersion;
    }

    if (!resolvedOrbiterId) {
        console.warn('[DataManager] assembleConfig: no orbiterId resolved from track. Using local fallback.');
        resolvedOrbiterId = DEFAULT_ORBITER_FALLBACK?.orbiterId || 'orbiter-fallback';
        resolvedOrbiterVersion = DEFAULT_ORBITER_FALLBACK?.release?.version || 'fallback';
    }

    // Fetch and normalize orbiter (with fallback handling)
    const requestedOrbiterVersion = pickFirstNonEmpty([request?.orbiterVersion]);
    const hydratedOrbiterMatches =
        resolvedOrbiterId &&
        hydratedOrbiterPayload &&
        idsMatch(resolvedOrbiterId, hydratedOrbiterPayload.orbiterId) &&
        (!requestedOrbiterVersion ||
            (hydratedOrbiterVersion && idsMatch(requestedOrbiterVersion, hydratedOrbiterVersion)));

    let orbiterPayload = null;
    if (hydratedOrbiterMatches) {
        const versionForCache = hydratedOrbiterVersion || resolvedOrbiterVersion || null;
        orbiterPayload = cache.setOrbiterRelease(resolvedOrbiterId, hydratedOrbiterPayload, {
            version: versionForCache,
        });
        resolvedOrbiterVersion = resolvedOrbiterVersion || versionForCache;
        notify.clearOrbiterFallback();
    } else {
        orbiterPayload = await fetchOrbiterRelease(resolvedOrbiterId, { version: resolvedOrbiterVersion, cache });

        // Handle fetch errors or null return (e.g. 403 triggers auth request in iframe)
        if (orbiterPayload?.error || !orbiterPayload) {
            const error = orbiterPayload?.error || null;
            const isNotFound = orbiterPayload?.isNotFound || false;
            const unavailableInfo = orbiterPayload?.unavailable || null;
            const logFn = isNotFound ? (()=>{}) : console.warn;
            if (error) {
                logFn('[DataManager] Falling back to default orbiter payload:', error);
            }

            const fallback = fallbacks.createOrbiterFallback({
                orbiterId: resolvedOrbiterId,
                version: resolvedOrbiterVersion || 'fallback',
            });

            notify.notifyOrbiterFallback({ unavailableInfo, isNotFound });

            orbiterPayload = cache.setOrbiterRelease(resolvedOrbiterId, fallback, {
                version: fallback.release.version
            });
        } else {
            notify.clearOrbiterFallback();
        }
    }
    
    if (!orbiterPayload) {
        console.warn('[DataManager] assembleConfig: no orbiter payload for', resolvedOrbiterId);
        return null;
    }
    
    
    const orbiter = normalizeOrbiterRelease(orbiterPayload);

    const sessionPayload = orbiter.metadata?.orbiterSession ?? null;
    const hasSessionStacks = applyOrbiterSessionHydration(orbiter, sessionPayload);

    const needsLegacyFallback =
        !isToneEngineOrbiter(orbiter) &&
        (!orbiter?.orbiterParams || Object.keys(orbiter.orbiterParams).length === 0 || !orbiter?.orbiterJSONURL);

    if (needsLegacyFallback) {
        applyOrbiterFallback(orbiter, resolvedOrbiterId, resolvedOrbiterVersion);
    }

    if (!hasSessionStacks) {
        orbiter.stacks = effectsToStacks(orbiter.effects);
        debugStacksSnapshot('assembleConfig :: generated stacks from normalized effects', orbiter.stacks, {
            orbiterId: orbiter?.orbiterId || resolvedOrbiterId,
            source: 'effectsToStacks-fallback',
        });
    }

    // Fetch and normalize entangled world (optional)
    let entangledWorld = null;
    const requestedWorldVersion = pickFirstNonEmpty([request?.entangledWorldVersion]);
    const hydratedWorldMatches =
        resolvedWorldId &&
        hydratedWorldPayload &&
        idsMatch(resolvedWorldId, hydratedWorldPayload.worldId) &&
        (!requestedWorldVersion ||
            (hydratedWorldVersion && idsMatch(requestedWorldVersion, hydratedWorldVersion)));

    if (resolvedWorldId) {
        let worldPayload = null;
        if (hydratedWorldMatches) {
            const versionForCache = hydratedWorldVersion || resolvedWorldVersion || null;
            worldPayload = cache.setWorldRelease(resolvedWorldId, hydratedWorldPayload, {
                version: versionForCache,
            });
            resolvedWorldVersion = resolvedWorldVersion || versionForCache;
        } else {
            try {
                worldPayload = await fetchEntangledWorldRelease(resolvedWorldId, { version: resolvedWorldVersion, cache });
            } catch (error) {
                console.warn('[DataManager] Falling back to default entangled world payload:', error);
                const unavailableInfo = error?.unavailable || null;
                notify.notifyWorldUnavailable(unavailableInfo);
                const fallback = fallbacks.createWorldFallback({
                    worldId: resolvedWorldId,
                    version: resolvedWorldVersion || 'fallback',
                });
                worldPayload = cache.setWorldRelease(resolvedWorldId, fallback, {
                    version: fallback.release.version,
                });
            }
        }

        if (!worldPayload) {
            console.warn('[DataManager] assembleConfig: no world payload for', resolvedWorldId);
            return null;
        }

        entangledWorld = normalizeWorldRelease(worldPayload);
    } else {
        const fallback = fallbacks.createDefaultWorld();
        if (fallback) {
            entangledWorld = fallback;
        }
    }

    // Combine all data
    const combined = {
        track,
        orbiter,
        entangledWorld,
        request: {
            trackId: track.trackId,
            trackVersion: track.version,
            orbiterId: orbiter?.orbiterId || resolvedOrbiterId,
            orbiterVersion: orbiter?.version || resolvedOrbiterVersion,
            entangledWorldId: entangledWorld?.worldId || resolvedWorldId,
            entangledWorldVersion: entangledWorld?.version || resolvedWorldVersion,
        },
    };

    // Nest the world into the track here so EVERY assembleConfig consumer
    // (facade, resolution, hydrated) gets `track.entangledWorld` — Main.js no longer re-patches.
    return nestEntangledWorldIntoTrack(combined);
}

export function resetOrbiterFallbackNotification() {
    defaultNotifier.reset();
}
