/**
 * @file placeholders.js
 * @description Manages UI placeholder configuration and population for different views.
 * @version 1.1.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2025-02-04
 */

import { formatParameterDisplayValue } from '../../core/ParameterManager.js';
import { Constants } from '../../config/Constants.js';
import { getActiveDimensionId } from '../../utils/monitorUtils.js';
import { getT } from '../../i18n/index.js';
import { byId } from '../../voice/voiceDom.js';

const MISSING_VALUE = '—';
const AXIS_KEYS = ['x', 'y', 'z'];

const DATE_FORMATTER =
    typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit' })
        : null;

const NUMBER_FORMATTER = (maximumFractionDigits = 2) =>
    typeof Intl !== 'undefined' && Intl.NumberFormat
        ? new Intl.NumberFormat('en-US', { maximumFractionDigits })
        : null;

function normalizeText(value) {
    if (value === null || value === undefined) return MISSING_VALUE;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : MISSING_VALUE;
    }
    const trimmed = String(value).trim();
    return trimmed.length ? trimmed : MISSING_VALUE;
}

function formatDate(value) {
    if (!value) return MISSING_VALUE;
    try {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return MISSING_VALUE;
        }
        return DATE_FORMATTER ? DATE_FORMATTER.format(date) : date.toISOString().slice(0, 10);
    } catch (_) {
        return MISSING_VALUE;
    }
}

function formatNumber(value, maximumFractionDigits = 2) {
    if (value === null || value === undefined) return MISSING_VALUE;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return MISSING_VALUE;
    }
    const formatter = NUMBER_FORMATTER(maximumFractionDigits);
    return formatter ? formatter.format(numeric) : String(numeric);
}

function pickDisplayName(entity) {
    if (!entity || typeof entity !== 'object') return null;
    return (
        entity.displayName ||
        entity.ownerDisplayName ||
        entity.username ||
        entity.name ||
        entity.ownerUsername ||
        null
    );
}

function formatArtists(track) {
    const sources = Array.isArray(track?.artists)
        ? track.artists
        : Array.isArray(track?.metadata?.artists)
            ? track.metadata.artists
            : [];
    const names = sources
        .map((artist) => pickDisplayName(artist))
        .filter((name) => typeof name === 'string' && name.trim().length);
    return names.length ? names.join(', ') : MISSING_VALUE;
}

function formatRights(licenseDetails) {
    if (!licenseDetails || typeof licenseDetails !== 'object') return MISSING_VALUE;
    const tokens = [];
    if (licenseDetails.ccAttribution) tokens.push('BY');
    if (licenseDetails.ccNoncommercial) tokens.push('NC');
    if (licenseDetails.ccNoDerivativeWorks) tokens.push('ND');
    if (licenseDetails.ccShareAlike) tokens.push('SA');
    if (!tokens.length) return MISSING_VALUE;
    return `CC ${tokens.join('-')}`;
}

function getHydrationSnapshot(track, cache = Constants) {
    if (!track?.trackId) return null;
    try {
        const preferredVersion = track.version ?? null;
        let release = cache.getTrackRelease(track.trackId, { version: preferredVersion });
        if (!release && preferredVersion != null) {
            release = cache.getTrackRelease(track.trackId, { version: null });
        }
        return release?.hydration || null;
    } catch (_) {
        return null;
    }
}

function createPlaceholderMap(entries = []) {
    return entries.reduce((acc, entry, index) => {
        const base = index * 2 + 1;
        acc[`placeholder_${base}`] = entry.label ?? '';
        acc[`placeholder_${base + 1}`] = normalizeText(entry.value);
        return acc;
    }, {});
}

function resolveActiveDimension(orbiter) {
    const session = orbiter?.metadata?.orbiterSession;
    if (!session) return null;
    const stacks = session.stacks || {};
    const selection = session.selection || {};
    const stackIds = Object.keys(stacks);
    if (!stackIds.length) return null;

    const activeStackId =
        (selection.activeStackId && stacks[selection.activeStackId] && selection.activeStackId) ||
        stackIds[0];
    const stack = stacks[activeStackId];
    if (!stack) return null;

    const dimensions = stack.dimensions || {};
    const dimensionIds = Object.keys(dimensions);
    if (!dimensionIds.length) return null;

    const runtimeDimensionId =
        typeof getActiveDimensionId === 'function' ? getActiveDimensionId() : null;
    const preferredIds = [runtimeDimensionId, selection.activeDimensionId, dimensionIds[0]];
    const activeDimensionId =
        preferredIds.find((id) => typeof id === 'string' && dimensions[id]) || dimensionIds[0];
    const dimension = dimensions[activeDimensionId];
    if (!dimension) return null;

    return { dimension, stackId: activeStackId, dimensionId: activeDimensionId };
}

function describeAxisModule(module) {
    if (!module || typeof module !== 'object') {
        return { label: null, description: null };
    }
    return {
        label: module.moduleMetadata?.label || module.moduleId || module.effectId || null,
        description: module.moduleMetadata?.description || null,
    };
}

function extractAxisInfo(orbiter) {
    const resolved = resolveActiveDimension(orbiter);
    if (!resolved) {
        return {
            axes: {
                x: { label: null, description: null },
                y: { label: null, description: null },
                z: { label: null, description: null },
            },
            dimensionLabel: null,
            dimensionId: null,
        };
    }

    const axes = AXIS_KEYS.reduce((acc, axisKey) => {
        const modules = resolved.dimension?.axes?.[axisKey]?.modules;
        acc[axisKey] = describeAxisModule(Array.isArray(modules) ? modules[0] : null);
        return acc;
    }, {});

    return {
        axes,
        dimensionLabel: resolved.dimension?.dimensionLabel || resolved.dimension?.dimensionId || null,
        dimensionId: resolved.dimensionId || null,
    };
}

function composeMonitorLabel(axisKey, slot, axisMeta, fallback) {
    if (slot === 'A') {
        return axisMeta?.label ? axisMeta.label : fallback;
    }
    return axisMeta?.description || fallback;
}

function buildMonitorPlaceholders() {
    return {
        placeholder_1: '[xA]',
        placeholder_2: '0',
        placeholder_3: '[xB]',
        placeholder_4: '0',
        placeholder_5: '[yA]',
        placeholder_6: '0',
        placeholder_7: '[yB]',
        placeholder_8: '0',
        placeholder_9: '[zA]',
        placeholder_10: '0',
        placeholder_11: '[zB]',
        placeholder_12: '0',
    };
}

function describeAxisValue(axisMeta) {
    if (!axisMeta) return MISSING_VALUE;
    return normalizeText(axisMeta.description || axisMeta.label);
}

function getAstronomicalBody(entangledWorld) {
    return (
        entangledWorld?.metadata?.step_one?.astronomical_body ||
        entangledWorld?.metadata?.step_one?.astronomicalBody ||
        null
    );
}

function getMoonsCount(entangledWorld) {
    return (
        entangledWorld?.metadata?.step_two?.entangled_world_preview?.moons?.count ??
        entangledWorld?.metadata?.step_two?.entangledWorldPreview?.moons?.count ??
        null
    );
}

function buildTrackTags(track) {
    const owner =
        (typeof track?.owner === 'string' && track.owner) ||
        pickDisplayName(track?.owner) ||
        pickDisplayName(track?.metadata?.owner) ||
        null;
    const trackTitle =
        track?.trackName ||
        track?.metadata?.trackName ||
        track?.metadata?.title ||
        track?.metadata?.name ||
        null;

    const t = getT();
    return [
        { label: t('infoRows.track'), value: trackTitle || MISSING_VALUE },
        { label: t('infoRows.artists'), value: formatArtists(track) },
        { label: t('infoRows.by'), value: owner || MISSING_VALUE },
        { label: t('infoRows.rights'), value: formatRights(track?.metadata?.licenseDetails) },
        { label: t('infoRows.releaseDate'), value: formatDate(track?.snapshotAt) },
    ];
}

function resolveWorldNames(entangledWorld, worldPreview) {
    const roots =
        entangledWorld?.metadata?.step_one?.worldbuilding_roots ||
        entangledWorld?.metadata?.step_one?.worldbuildingRoots ||
        entangledWorld?.metadata?.worldbuilding_roots ||
        entangledWorld?.metadata?.worldbuildingRoots ||
        {};
    const previewNames = entangledWorld?.metadata?.worldPreview || {};

    const artisticCandidates = [
        worldPreview?.artName,
        entangledWorld?.artName,
        entangledWorld?.metadata?.artName,
        roots?.artisticName,
        previewNames?.artName,
    ];
    const scientificCandidates = [
        worldPreview?.sciName,
        entangledWorld?.sciName,
        entangledWorld?.metadata?.sciName,
        entangledWorld?.metadata?.scientificName,
        entangledWorld?.metadata?.step_one?.astronomical_body?.astronomicalBody,
        entangledWorld?.metadata?.step_one?.astronomicalBody?.astronomicalBody,
        entangledWorld?.metadata?.worldPreview?.sciName,
    ];

    const pick = (list) => list.find((value) => typeof value === 'string' && value.trim().length) || null;

    return {
        artisticName: pick(artisticCandidates),
        scientificName: pick(scientificCandidates),
    };
}

function buildWorldTags(entangledWorld, worldPreview) {
    const astro = getAstronomicalBody(entangledWorld) || {};
    const frequencySources = entangledWorld?.frequencySources || {};
    const cpd = astro.frequencyCpd ?? astro.frequency_cpd ?? frequencySources.frequencyCpd ?? null;
    const lum =
        astro.stellarLuminosityLsun ??
        astro.stellar_luminosity_lsun ??
        frequencySources.stellarLuminosityLsun ??
        null;
    const mass = astro.mass ?? frequencySources.mass ?? null;
    const moons = getMoonsCount(entangledWorld);
    const worldNames = resolveWorldNames(entangledWorld, worldPreview);

    const t = getT();
    return [
        { label: t('infoRows.world'), value: worldNames.artisticName || MISSING_VALUE },
        { label: t('infoRows.exoplanet'), value: worldNames.scientificName || MISSING_VALUE },
        { label: t('infoRows.cpd'), value: formatNumber(cpd, 3) },
        { label: t('infoRows.stellarL'), value: formatNumber(lum, 3) },
        { label: t('infoRows.massMj'), value: formatNumber(mass, 2) },
        { label: t('infoRows.moons'), value: formatNumber(moons, 0) },
    ];
}

function buildOrbiterTags(orbiter, orbiterPreview, axisInfo) {
    const ownerName =
        pickDisplayName(orbiter?.owner) ||
        orbiterPreview?.ownerDisplayName ||
        pickDisplayName(orbiter?.metadata?.owner) ||
        pickDisplayName(orbiter?.developer) ||
        pickDisplayName(orbiterPreview) ||
        orbiter?.metadata?.ownerDisplayName ||
        orbiter?.metadata?.ownerUsername ||
        null;

    const orbiterName =
        orbiterPreview?.orbiterName ||
        orbiter?.orbiterName ||
        orbiter?.metadata?.orbiterName ||
        orbiter?.metadata?.name ||
        null;

    const t = getT();
    return [
        { label: t('infoRows.orbiter'), value: orbiterName || MISSING_VALUE },
        { label: t('infoRows.by'), value: ownerName || MISSING_VALUE },
    ];
}

// ============================================================================
// Placeholder Configuration Builder
// ============================================================================

export function buildPlaceholderConfig(track, orbiter, entangledWorld, { cache = Constants } = {}) {
    const hydration = getHydrationSnapshot(track, cache);
    const worldPreview = entangledWorld ? null : hydration?.worldPreview?.[0] || null;
    const orbiterPreview = orbiter ? null : hydration?.orbiterPreview?.[0] || null;
    const axisInfo = extractAxisInfo(orbiter);

    return {
        monitorInfo: buildMonitorPlaceholders(),
        trackInfo: createPlaceholderMap(buildTrackTags(track)),
        entangledWorldInfo: createPlaceholderMap(buildWorldTags(entangledWorld, worldPreview)),
        orbiterInfo: createPlaceholderMap(buildOrbiterTags(orbiter, orbiterPreview, axisInfo)),
    };
}

/**
 * The clean `{label, value}` row form of the track / entangled-world / orbiter metadata — the same
 * tag builders {@link buildPlaceholderConfig} feeds into the legacy placeholder grid, but returned
 * as rows so the React Info panel renders them directly (no `placeholder_N` round-trip). Keyed by
 * the React info-menu value. The Monitor view is intentionally NOT here — it reads live audio values
 * from the engine ({@link AudioEngineAdapter#getMonitorSnapshot}), not static metadata.
 * @returns {{ track: Array<{label:string,value:string}>, 'entangled-world': Array<{label:string,value:string}>, orbiter: Array<{label:string,value:string}> }}
 */
export function buildInfoTags(track, orbiter, entangledWorld, { cache = Constants } = {}) {
    const hydration = getHydrationSnapshot(track, cache);
    const worldPreview = entangledWorld ? null : hydration?.worldPreview?.[0] || null;
    const orbiterPreview = orbiter ? null : hydration?.orbiterPreview?.[0] || null;
    const axisInfo = extractAxisInfo(orbiter);

    return {
        track: buildTrackTags(track),
        'entangled-world': buildWorldTags(entangledWorld, worldPreview),
        orbiter: buildOrbiterTags(orbiter, orbiterPreview, axisInfo),
    };
}

// ============================================================================
// Placeholder Population
// ============================================================================

export function populatePlaceholders(target, config) {
    if (!config || Object.keys(config).length === 0) {
        return;
    }

    if (!target || !config[target]) {
        clearPlaceholders();
        return;
    }

    const targetConfig = config[target];
    const usedPlaceholderIds = new Set(Object.keys(targetConfig));

    for (let i = 1; i <= 14; i++) {
        const placeholderId = `placeholder_${i}`;
        const element = byId(placeholderId);
        if (!element) continue;

        if (!usedPlaceholderIds.has(placeholderId)) {
            element.style.display = 'none';
            element.textContent = '';
        } else {
            element.textContent = '';
        }
    }

    Object.entries(targetConfig).forEach(([placeholderId, value]) => {
        const element = byId(placeholderId);
        if (!element) return;

        const content = typeof value === 'function' ? value() : value;

        if (target === 'monitorInfo') {
            element.style.display = '';
            const current = (element.textContent || '').trim();
            if (!current && content && content !== '0') {
                element.textContent = content;
            }
        } else {
            const shouldHide = content == null || (typeof content === 'string' && content.trim() === '');
            if (shouldHide) {
                element.style.display = 'none';
                element.textContent = '';
            } else {
                element.style.display = '';
                element.textContent = typeof content === 'string' ? content : String(content);
            }
        }
    });

    if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent('orbiters:info-grid-updated'));
    }
}

export function clearPlaceholders() {
    for (let i = 1; i <= 14; i++) {
        const element = byId(`placeholder_${i}`);
        if (element) {
            element.textContent = '';
            element.style.display = 'none';
        }
    }
}

// ============================================================================
// Parameter Value Formatting
// ============================================================================

export function getParamValueFormatted(name, parameterManager, lastParamValues = {}) {
    if (name in lastParamValues) {
        const cached = lastParamValues[name];
        return typeof cached === 'number' ? formatParameterDisplayValue(cached) : String(cached);
    }

    if (!parameterManager) return '-';

    let val;
    if (typeof parameterManager.getParameterValue === 'function') {
        val = parameterManager.getParameterValue(name);
    } else if (typeof parameterManager.getParameter === 'function') {
        val = parameterManager.getParameter(name)?.value;
    }

    if (val != null) {
        return typeof val === 'number' ? formatParameterDisplayValue(val) : String(val);
    }

    return '-';
}
