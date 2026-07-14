import { normalizeTrackRelease, normalizeOrbiterRelease, normalizeWorldRelease } from '../api/dataManager/normalizers.js';
import { applyOrbiterSessionHydration } from '../api/dataManager/assembler.js';
import { fetchPlaybackSessionById } from '../api/playbackSessionClient.js';
import { sanitizeId, sessionDescriptorSignature } from './sessionDescriptor.js';
import { Constants } from '../config/Constants.js';
import { hydrateTrackDurationFromWaveform } from './trackDurationHydration.js';

function pickDescriptorField(preferred, fallback) {
    const primary = sanitizeId(preferred);
    if (primary) return primary;
    return sanitizeId(fallback) ?? null;
}

function buildResolutionFromSnapshot(snapshot = {}, mergeBase = null) {
    const trackRelease =
        snapshot.trackRelease ??
        snapshot.trackSession ??
        (snapshot.release && snapshot.trackId ? snapshot : null) ??
        mergeBase?.trackRelease ??
        mergeBase?.trackSession ??
        null;
    const orbiterRelease =
        snapshot.orbiterRelease ??
        snapshot.orbiterSession ??
        mergeBase?.orbiterRelease ??
        mergeBase?.orbiterSession ??
        null;
    const entangledWorldRelease =
        snapshot.entangledWorldRelease ??
        snapshot.entangledWorldSession ??
        mergeBase?.entangledWorldRelease ??
        mergeBase?.entangledWorldSession ??
        null;

    const track = trackRelease
        ? normalizeTrackRelease(trackRelease)
        : mergeBase?.track
          ? mergeBase.track
          : null;
    if (!track || !track.trackId) {
        throw new Error('Playback session is missing a valid track release.');
    }
    const orbiter = orbiterRelease
        ? normalizeOrbiterRelease(orbiterRelease)
        : mergeBase?.orbiter
          ? mergeBase.orbiter
          : null;
    if (orbiter && !orbiter.orbiterId) {
        // guard against malformed merge base
        // In Edit Mode, we might have a partial orbiter without an ID yet.
        // If we are in a strict playback context (sessionId present), this is an error.
        // But if we are just hydrating a snapshot, we might want to allow it.
        // For now, we'll log a warning instead of throwing, to allow partial hydration.
        console.warn('[PlaybackSessionLoader] Orbiter release is missing an ID. Proceeding with partial data.');
    }
    if (orbiter && orbiter.metadata && !orbiter.metadata.orbiterSession && orbiterRelease) {
        const sessionPayload = orbiterRelease?.metadata?.orbiterSession ?? null;
        if (sessionPayload) {
            applyOrbiterSessionHydration(orbiter, sessionPayload);
        }
    } else if (orbiter) {
        const sessionPayload = orbiter.metadata?.orbiterSession ?? null;
        if (sessionPayload) {
            applyOrbiterSessionHydration(orbiter, sessionPayload);
        }
    }
    const entangledWorld = entangledWorldRelease
        ? normalizeWorldRelease(entangledWorldRelease)
        : mergeBase?.entangledWorld
          ? mergeBase.entangledWorld
          : null;

    const descriptor = {
        trackId: pickDescriptorField(track.trackId, snapshot.trackId),
        trackVersion: pickDescriptorField(track.version, trackRelease?.release?.version),
        orbiterId: pickDescriptorField(orbiter?.orbiterId, snapshot.orbiterId),
        orbiterVersion: pickDescriptorField(
            orbiter?.version,
            orbiterRelease?.release?.version ?? null,
        ),
        entangledWorldId: pickDescriptorField(
            entangledWorld?.worldId,
            snapshot.entangledWorldId ?? snapshot.worldId ?? null,
        ),
        entangledWorldVersion: pickDescriptorField(
            entangledWorld?.version,
            entangledWorldRelease?.release?.version ?? null,
        ),
    };

    const changed = Array.isArray(snapshot.changed) ? snapshot.changed.slice() : [];
    const raw = {
        ...(mergeBase || {}),
        ...snapshot,
    };

    return {
        descriptor,
        resolution: {
            ok: true,
            track,
            orbiter,
            entangledWorld,
            request: { ...descriptor },
            debug: {
                source: 'playback-session',
                strategy: 'playback-release',
            },
            raw,
        },
        warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.slice() : [],
        status: snapshot.status ?? null,
        changed,
        raw,
    };
}

function emit(eventTarget, name, detail) {
    if (!eventTarget || typeof eventTarget.dispatchEvent !== 'function') {
        return;
    }
    try {
        eventTarget.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (error) {
        console.warn(`[PlaybackLoader] Failed to dispatch ${name}`, error);
    }
}

export function createPlaybackSessionLoader({
    dataManager,
    sessionManager,
    eventTarget = typeof window !== 'undefined' ? window : null,
} = {}) {
    if (!dataManager) {
        throw new Error('createPlaybackSessionLoader requires a dataManager instance.');
    }

    const captureSignature = (descriptor, sessionId = null) => {
        if (!descriptor) return;
        if (sessionManager?.captureSignature) {
            sessionManager.captureSignature(descriptor, sessionId);
            return;
        }
        const signature = sessionDescriptorSignature(descriptor, sessionId ?? null);
        sessionManager?.setLastSignature?.(signature);
    };

    const applyResolution = ({
        descriptor,
        resolution,
        sessionId,
        source,
        warnings,
        status,
        changed,
        rawSnapshot,
    }) => {
        const combined = dataManager.applyResolvedSession(resolution);
        // Identity lives per-voice on dataManager.activeConfigRequest (set inside
        // applyResolvedSession) — no Constants.TRACK_ID global write.
        if (typeof Constants.setSessionId === 'function') {
            Constants.setSessionId(sessionId ?? null);
        } else {
            Constants.SESSION_ID = sessionId ?? null;
        }
        captureSignature(descriptor, sessionId ?? null);
        const resolutionWithRaw = {
            ...resolution,
            raw: rawSnapshot ?? resolution.raw ?? null,
        };
        emit(eventTarget, 'orbiters:session-ready', {
            descriptor,
            source,
            sessionId,
            cached: false,
            status,
            warnings,
            resolution: {
                ...resolutionWithRaw,
                combined,
            },
            changed: Array.isArray(changed) ? changed.slice() : [],
        });
        return combined;
    };

    const handleError = ({ descriptor, source, sessionId, error }) => {
        emit(eventTarget, 'orbiters:session-error', {
            descriptor: descriptor || null,
            source,
            sessionId,
            error,
            cached: false,
        });
    };

    async function loadFromSnapshot(
        snapshot,
        { source = 'playback-session', sessionId = null, changed = null, rawBase = null } = {},
    ) {
        if (!snapshot) {
            handleError({ source, sessionId, error: new Error('Playback snapshot is empty.') });
            return { ok: false, error: new Error('Playback snapshot is empty.') };
        }

        emit(eventTarget, 'orbiters:session-loading', {
            descriptor: null,
            source,
            sessionId,
            cached: false,
        });

        try {
            const {
                descriptor,
                resolution,
                warnings,
                status,
                changed: snapshotChanged,
                raw,
            } = buildResolutionFromSnapshot(snapshot, rawBase);
            resolution.track = await hydrateTrackDurationFromWaveform(resolution.track);
            const combined = applyResolution({
                descriptor,
                resolution,
                sessionId: sessionId ?? sanitizeId(snapshot.sessionId) ?? null,
                source,
                warnings,
                status,
                changed: changed ?? snapshotChanged,
                rawSnapshot: raw,
            });
            return { ok: true, descriptor, resolution, combined };
        } catch (error) {
            handleError({ source, sessionId, error });
            return { ok: false, error };
        }
    }

    async function loadBySessionId(
        sessionId,
        { source = 'playback-session:url', signal, changed = null, rawBase = null, hydratedBlobs = null } = {},
    ) {
        const sanitizedSessionId = sanitizeId(sessionId);
        if (!sanitizedSessionId) {
            const error = new Error('sessionId is required to load playback session.');
            handleError({ source, sessionId: sanitizedSessionId, error });
            return { ok: false, error };
        }

        emit(eventTarget, 'orbiters:session-loading', {
            descriptor: null,
            source,
            sessionId: sanitizedSessionId,
            cached: false,
        });

        try {
            const fetchResult = await fetchPlaybackSessionById(sanitizedSessionId, { signal });
            if (!fetchResult?.ok || !fetchResult.session) {
                const error =
                    fetchResult?.error ||
                    new Error(`Failed to load playback session ${sanitizedSessionId}`);
                handleError({ source, sessionId: sanitizedSessionId, error });
                return { ok: false, error };
            }

            const snapshot = fetchResult.session;
            const effectiveSnapshot = hydratedBlobs ? { ...snapshot, ...hydratedBlobs } : snapshot;

            const { descriptor, resolution, warnings, status, changed: snapshotChanged, raw } =
                buildResolutionFromSnapshot(effectiveSnapshot, rawBase);
            resolution.track = await hydrateTrackDurationFromWaveform(resolution.track);
            const combined = applyResolution({
                descriptor,
                resolution,
                sessionId: sanitizedSessionId,
                source,
                warnings: warnings.length ? warnings : snapshot.warnings ?? [],
                status: snapshot.status ?? status ?? null,
                changed: changed ?? snapshotChanged,
                rawSnapshot: raw,
            });
            return { ok: true, descriptor, resolution, combined, snapshot };
        } catch (error) {
            handleError({ source, sessionId: sanitizedSessionId, error });
            return { ok: false, error };
        }
    }

    return {
        loadBySessionId,
        loadFromSnapshot,
    };
}
