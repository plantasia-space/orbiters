/**
 * @file src/orbiter/emitOrbiterParameters.js
 * The edit-mode parameter emitter: turns an orbiter-session payload into (a) applied
 * design/colors, (b) an audio-engine effects-config update, and (c) a postMessage to the
 * parent (iframe edit host). No-op outside edit mode.
 *
 * Created as a factory so the composition root can inject the two live dependencies as
 * getters (`getModeController`, `getAudioEngine`) — both are constructed around the same
 * boot point, so getters sidestep ordering instead of relying on function hoisting.
 */

import { applyDesignSettings } from '../ui/designManager.js';
import { applyColorsFromTrackData } from '../ui/Interaction.js';
import { DEFAULT_COLOR_C } from './edit/designUtils.js';
import { getAuthorizedHostOrigin, shouldEmitEditUpdate } from '../utils/iFrameParams.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';

const EFFECT_AXES = ['x', 'y', 'z'];
const DEFAULT_DIMENSION_ORDER = ['EW::I', 'EW::II', 'EW::III'];

/** Normalize a session payload into the per-axis { dimensionId, modules } shape the engine wants. */
function normalizeEffectConfigForEngine(payload) {
    const baseline = EFFECT_AXES.reduce((acc, axis) => {
        acc[axis] = { dimensionId: null, dimensionLabel: null, modules: [] };
        return acc;
    }, {});

    if (!payload || typeof payload !== 'object') {
        return baseline;
    }

    const merged = { ...baseline };
    const dimensionOrder = [];
    const pushDimensionOrder = (dimensionId) => {
        if (!dimensionId) return;
        if (!dimensionOrder.includes(dimensionId)) {
            dimensionOrder.push(dimensionId);
        }
    };

    const meta = {
        activeDimensionId: payload.selection?.activeDimensionId ?? null,
        dimensionOrder,
    };

    const pushModule = (axis, module, dimensionId = null, dimensionLabel = null, normalized = null) => {
        if (!module || !module.effectId) return;
        const clone = { ...module };
        if (dimensionId) clone.dimensionId = dimensionId;
        if (dimensionLabel) clone.dimensionLabel = dimensionLabel;
        if (normalized !== null) {
            clone.controlNormalized = normalized;
        }
        merged[axis].modules.push(clone);
    };

    if (payload.stacks && typeof payload.stacks === 'object') {
        const selection = payload.selection || {};
        const stackId = selection.activeStackId && payload.stacks[selection.activeStackId]
            ? selection.activeStackId
            : Object.keys(payload.stacks)[0];
        const stack = stackId ? payload.stacks[stackId] : null;

        // Process ALL dimensions present on the active stack
        if (stack && stack.dimensions && typeof stack.dimensions === 'object') {
            Object.entries(stack.dimensions).forEach(([dimensionId, dimensionState]) => {
                if (!dimensionState || typeof dimensionState !== 'object') return;
                const dimensionLabel = dimensionState.dimensionLabel ?? dimensionId;
                pushDimensionOrder(dimensionId);

                EFFECT_AXES.forEach((axis) => {
                    const axisState = dimensionState.axes?.[axis];
                    if (!axisState || typeof axisState !== 'object') return;
                    const modules = Array.isArray(axisState.modules) ? axisState.modules : [];
                    modules.forEach((module) => {
                        const moduleNormalized = Number.isFinite(module?.controlNormalized)
                            ? Math.min(1, Math.max(0, Number(module.controlNormalized)))
                            : null;
                        pushModule(axis, module, dimensionId, dimensionLabel, moduleNormalized);
                    });
                });
            });
        }
    } else if (payload.effects && typeof payload.effects === 'object') {
        EFFECT_AXES.forEach((axis) => {
            const axisEntry = payload.effects[axis];
            if (!axisEntry || typeof axisEntry !== 'object') return;
            const modules = Array.isArray(axisEntry.modules) ? axisEntry.modules : [];
            modules.forEach((module) => {
                const moduleDimensionId = module?.dimensionId ?? axisEntry.dimensionId ?? null;
                pushDimensionOrder(moduleDimensionId);
                pushModule(
                    axis,
                    module,
                    moduleDimensionId,
                    module?.dimensionLabel ?? axisEntry.dimensionLabel ?? null,
                    module?.controlNormalized ?? null,
                );
            });
        });
    } else if (Array.isArray(payload.effects)) {
        payload.effects.forEach((dimensionEntry) => {
            if (!dimensionEntry || typeof dimensionEntry !== 'object') return;
            const dimensionId = dimensionEntry.dimensionId ?? null;
            const dimensionLabel = dimensionEntry.dimensionLabel ?? null;
            pushDimensionOrder(dimensionId);
            const axesList = Array.isArray(dimensionEntry.axes) ? dimensionEntry.axes : [];
            axesList.forEach((axisEntry) => {
                if (!axisEntry || typeof axisEntry !== 'object') return;
                const axisName = axisEntry.axis;
                if (!EFFECT_AXES.includes(axisName)) return;
                const modules = Array.isArray(axisEntry.modules) ? axisEntry.modules : [];
                modules.forEach((module) => {
                    pushModule(axisName, module, dimensionId, dimensionLabel, module?.controlNormalized ?? null);
                });
            });
        });
    }

    if (!dimensionOrder.length) {
        DEFAULT_DIMENSION_ORDER.forEach((dimensionId) => pushDimensionOrder(dimensionId));
    }

    merged.__meta = meta;
    return merged;
}

/**
 * Build the edit-mode parameter emitter.
 * @param {object} deps
 * @param {() => (object|null)} deps.getModeController resolve the live OrbiterModeController.
 * @param {() => (object|null|undefined)} deps.getAudioEngine resolve the live AudioEngineAdapter.
 * @returns {(payload: object) => void} the emitter to pass as `emitParameterUpdate`.
 */
export function createOrbiterParameterEmitter({ getModeController, getAudioEngine, themeRoot = null }) {
    return function emitOrbiterParameters(payload) {
        const activeController =
            getModeController?.() || voiceRegistry.getActive()?.worldMode || null;

        if (!activeController || activeController.activeModeKey !== 'edit') {
            return;
        }

        let activeDesign = null;
        if (payload && payload.stacks && typeof payload.stacks === 'object') {
            const selection = payload.selection || {};
            const availableStacks = Object.keys(payload.stacks);
            const activeStackId =
                selection.activeStackId && payload.stacks[selection.activeStackId]
                    ? selection.activeStackId
                    : availableStacks[0];
            const activeStack = activeStackId ? payload.stacks[activeStackId] : null;
            if (activeStack && activeStack.dimensions) {
                const availableDimensions = Object.keys(activeStack.dimensions);
                const activeDimensionId =
                    selection.activeDimensionId && activeStack.dimensions[selection.activeDimensionId]
                        ? selection.activeDimensionId
                        : availableDimensions[0];
                const activeDimension =
                    activeDimensionId && activeStack.dimensions[activeDimensionId]
                        ? activeStack.dimensions[activeDimensionId]
                        : null;
                if (activeDimension && activeDimension.design && typeof activeDimension.design === 'object') {
                    activeDesign = { ...activeDimension.design };
                }
            }
        }

        if (!activeDesign && activeController?.activeMode?.design && typeof activeController.activeMode.design === 'object') {
            activeDesign = { ...activeController.activeMode.design };
        }

        if (activeDesign) {
            applyDesignSettings(activeDesign, themeRoot);
            const knobData = {
                orbiter: {
                    orbiterColors: {
                        color1: activeDesign.colorPrimary || '#ffffff',
                        color2: activeDesign.colorSecondary || '#151515',
                        color3: activeDesign.colorC || DEFAULT_COLOR_C,
                    },
                },
            };
            applyColorsFromTrackData(knobData, themeRoot);
        }

        const audioEngine = getAudioEngine?.();
        if (payload && audioEngine && typeof audioEngine.updateEffectsConfig === 'function') {
            const normalizedEffects = normalizeEffectConfigForEngine(payload);
            audioEngine.updateEffectsConfig(normalizedEffects);
        }

        // Edit snapshots carry the full private session — they only ever go to the host
        // that completed the bridge handshake, never to an arbitrary embedding parent.
        const hostOrigin = getAuthorizedHostOrigin();
        if (payload && hostOrigin && window.parent && window.parent !== window) {
            let sessionSnapshot;
            try {
                sessionSnapshot = JSON.parse(JSON.stringify(payload));
            } catch (cloneError) {
                console.warn('[OrbiterModeController] Failed to clone orbiter session payload, sending live reference.', cloneError);
                sessionSnapshot = payload;
            }

            if (!shouldEmitEditUpdate(sessionSnapshot)) {
                return;
            }

            window.parent.postMessage({
                type: 'orbiters-edit-update',
                // Tag the emitting voice's own trackId (from its audio engine's combined
                // config), not a Constants global — so multi-voice edit-updates address the right track.
                trackId: audioEngine?.trackData?.track?.trackId ?? null,
                payload: {
                    orbiterSession: sessionSnapshot,
                },
            }, hostOrigin);
        } else if (payload && window.__DEBUG_LOG_EMIT) {
            // Throttled, opt-in debug logging to reduce overhead during knob moves.
            const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
                ? performance.now() : Date.now();
            const last = window.__LAST_EMIT_LOG_TS || 0;
            if (now - last >= 500) { // log at most twice per second
                console.debug('[OrbiterModeController] emitOrbiterParameters', payload);
                window.__LAST_EMIT_LOG_TS = now;
            }
        }
    };
}
