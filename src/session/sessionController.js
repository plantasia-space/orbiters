import {
    buildSessionDescriptor,
    isSessionDescriptorEmpty,
    sessionDescriptorSignature,
} from './sessionDescriptor.js';
import SessionResolutionService from './sessionResolutionService.js';
import SessionStateService from './sessionStateService.js';

const SESSION_IGNORE_SOURCES = new Set([
    'session-loading',
    'session-resolution',
    'session-set',
    'session-error',
    'data-manager',
    'url-overrides'
]);

/**
 * Normalizes requested session fields into overrides for DataManager.
 * Sentinel values like 'edit' or 'fallback' are filtered out where appropriate.
 * @param {Object} descriptor - Requested descriptor from the session snapshot.
 * @returns {Object} Clean overrides suitable for applyConfigOverrides.
 */
function normalizeOverridesFromRequested(descriptor = {}) {
    const overrides = {};
    const assignIfValid = (key, value) => {
        if (value == null || value === '') return;
        if ((key === 'trackVersion' || key === 'entangledWorldVersion') && value === 'edit') return;
        if ((key === 'orbiterVersion' || key === 'version') && value === 'fallback') return;
        overrides[key] = value;
    };

    if (descriptor.trackId != null) assignIfValid('trackId', descriptor.trackId);
    assignIfValid('trackVersion', descriptor.trackVersion);
    assignIfValid('orbiterId', descriptor.orbiterId);
    assignIfValid('orbiterVersion', descriptor.orbiterVersion);
    assignIfValid('entangledWorldId', descriptor.entangledWorldId);
    assignIfValid('entangledWorldVersion', descriptor.entangledWorldVersion);
    return overrides;
}

/**
 * Creates a session manager responsible for reacting to iframe bridge updates.
 * @param {Object} dependencies
 * @param {import('../api/dataManager/index.js').DataManager} dependencies.dataManager
 * @param {Function} dependencies.updateOrbiterSession
 * @returns {Object} public API for interacting with the session bridge.
 */
function createSessionManager({ dataManager, updateOrbiterSession, eventBus = null }) {
    // The session event target. Single-orbiter defaults to `window` (byte-identical);
    // a multi-orbiter voice passes its own EventTarget so session signals stay within the voice.
    const eventTarget = eventBus ?? (typeof window !== 'undefined' ? window : null);
    const state = {
        lastSignature: null,
        pendingPromise: null,
    };
    const resolutionService = new SessionResolutionService({
        onResolved: (resolution) => dataManager.applyResolvedSession(resolution),
    });
    const stateService = new SessionStateService({
        resolutionService,
        updateOrbiterSession,
        eventTarget,
    });

    async function processSessionRequest(sessionDetail, eventSource = 'host') {
        const descriptorArgs = { host: sessionDetail };
        if (sessionDetail?.hydratedBlobs) {
            descriptorArgs.hydrated = sessionDetail.hydratedBlobs;
        }
        if (sessionDetail?.fallbackDescriptor) {
            descriptorArgs.fallback = sessionDetail.fallbackDescriptor;
        }

        const {
            trackId,
            orbiterId,
            entangledWorldId,
            source: descriptorSource,
            hydratedBlobs,
        } = buildSessionDescriptor(descriptorArgs);
        const requested = sessionDetail?.requested || {};
        const resolved = sessionDetail?.resolved || {};
        const requestSource = sessionDetail?.source || descriptorSource || eventSource;
        const descriptor = {
            trackId,
            orbiterId,
            entangledWorldId,
            trackVersion: requested.trackVersion ?? resolved.trackVersion ?? null,
            orbiterVersion: requested.orbiterVersion ?? resolved.orbiterVersion ?? null,
            entangledWorldVersion: requested.entangledWorldVersion ?? resolved.entangledWorldVersion ?? null,
        };

        if (isSessionDescriptorEmpty(descriptor)) {
            return;
        }

        if (!trackId) {
            // TODO: Support direct orbiter/world resolution when trackId is absent.
            return;
        }

        

        const normalizedDescriptor = stateService.normalizeDescriptor(descriptor);
        const signature = sessionDescriptorSignature(normalizedDescriptor);
        if (state.lastSignature === signature && stateService.hasSignature(signature)) {
            return;
        }

        if (state.pendingPromise) {
            try {
                await state.pendingPromise;
            } catch {
                // ignore previous failure
            }
        }

        const hasHydratedData = Boolean(
            hydratedBlobs?.trackSession ||
            hydratedBlobs?.orbiterSession ||
            hydratedBlobs?.entangledWorldSession
        );

        state.pendingPromise = stateService.loadSession({
            descriptor: normalizedDescriptor,
            hydratedBlobs: hasHydratedData ? hydratedBlobs : {},
            source: requestSource,
        });

        try {
            const resolution = await state.pendingPromise;
            if (resolution?.ok) {
                state.lastSignature = signature;
            } else {
                state.lastSignature = null;
            }
        } catch (error) {
            console.error('[Orbiters Session] Failed to load requested configuration:', error);
            state.lastSignature = null;
        } finally {
            state.pendingPromise = null;
        }
    }

    function handleBridgeSessionUpdate(event) {
        const detail = event.detail || {};
        const session = detail.session || {};
        const source = detail.source;
        if (!session || SESSION_IGNORE_SOURCES.has(source)) {
            return;
        }
        void processSessionRequest(session, source);
    }

    function installSessionListeners() {
        if (!eventTarget) return;
        eventTarget.addEventListener('orbiters:session-load', (event) => {
            const detail = event.detail || {};
            if (detail.session) {
                void processSessionRequest(detail.session, detail.payload?.source ?? 'host-load');
            }
        });
    }

    function setInitialSignature(descriptor, sessionId = null) {
        if (!descriptor) return;
        const normalizedDescriptor = stateService.normalizeDescriptor(
            buildSessionDescriptor({ host: descriptor }),
        );
        state.lastSignature = sessionDescriptorSignature(normalizedDescriptor, sessionId ?? null);
    }

    function resetSignature() {
        state.lastSignature = null;
        stateService.clearCache();
    }

    function captureSignature(descriptor, sessionId = null) {
        if (!descriptor) return;
        const normalizedDescriptor = stateService.normalizeDescriptor(descriptor);
        state.lastSignature = sessionDescriptorSignature(normalizedDescriptor, sessionId ?? null);
    }

    return {
        installSessionListeners,
        processSessionRequest,
        handleBridgeSessionUpdate,
        setInitialSignature,
        captureSignature,
        resetSignature,
        getLastSignature: () => state.lastSignature,
        getLastResolution: () => stateService.getLastResolution(),
    };
}

export { createSessionManager, normalizeOverridesFromRequested, sessionDescriptorSignature };
