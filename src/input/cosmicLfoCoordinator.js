/**
 * @file src/input/cosmicLfoCoordinator.js
 * Owns the per-axis CosmicLFO instances and the world→sources priming.
 *
 * The composition root registers the manager onto the active voice; the runtime reads it off the
 * voice registry (PanelManager, AudioEngineAdapter, and the React `cosmic` surface via
 * resolveEngineSingletons) — nothing imports it by name. `primeCosmicLfoUi` pushes a world's
 * frequency sources to the LFOs, de-duped by a stable signature so repeated session/dimension
 * refreshes don't re-apply identical sources. Extracted from Main.js so the cosmic state has a
 * single owner; constructed via a factory the composition root calls at the same boot point,
 * preserving creation timing.
 */

import { CosmicLFO } from './CosmicLFO.js';

/** Instantiate the x/y/z LFOs and a small manager facade over them. */
function initializeCosmicLFOs(parameterManager, eventBus) {
    // Each LFO mirrors its cosmic-changed event onto this voice's eventBus (window for
    // single-orbiter → byte-identical) so the React `cosmic` surface re-reads only its own voice.
    const cosmicLFO_X = new CosmicLFO('x', parameterManager, { eventBus });
    const cosmicLFO_Y = new CosmicLFO('y', parameterManager, { eventBus });
    const cosmicLFO_Z = new CosmicLFO('z', parameterManager, { eventBus });
    // The React Cosmic LFO panel drives enable via the `cosmic` engine surface (cosmic.setEnabled →
    // lfo.start/stop); the legacy `<webaudio-switch>` enable controls are gone, so there's nothing to
    // attach here.
    return {
        x: cosmicLFO_X,
        y: cosmicLFO_Y,
        z: cosmicLFO_Z,
        startAll() {
            cosmicLFO_X.start();
            cosmicLFO_Y.start();
            cosmicLFO_Z.start();
        },
        stopAll() {
            cosmicLFO_X.stop();
            cosmicLFO_Y.stop();
            cosmicLFO_Z.stop();
        },
        disposeAll() {
            cosmicLFO_X.dispose();
            cosmicLFO_Y.dispose();
            cosmicLFO_Z.dispose();
        },
    };
}

/** A stable, order-independent string signature for the frequency-source payload. */
function stableFrequencySignature(value) {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (typeof value === 'number') {
        const finite = Number(value);
        return Number.isFinite(finite) ? finite.toFixed(9) : String(value);
    }
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableFrequencySignature(entry)).join(',')}]`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        const serialized = keys.map((key) => `${JSON.stringify(key)}:${stableFrequencySignature(value[key])}`);
        return `{${serialized.join(',')}}`;
    }
    return String(value);
}

/**
 * Create the cosmic-LFO coordinator: build the manager and return `{ manager, primeCosmicLfoUi }`.
 * Call once, at the same boot point the manager used to be created (timing-sensitive: the CosmicLFO
 * constructors run here). The composition root registers `manager` onto the active voice; runtime
 * readers (PanelManager / AudioEngineAdapter / resolveEngineSingletons) resolve it via the registry.
 */
export function createCosmicLfoCoordinator(parameterManager, eventBus) {
    const manager = initializeCosmicLFOs(parameterManager, eventBus);

    let lastFrequencySignature = null;
    let lastWorldId = undefined;

    /** Apply a world's frequency sources to the LFOs, de-duped by signature unless `force`. */
    function primeCosmicLfoUi(entangledWorld = null, options = {}) {
        const { force = false } = options ?? {};
        const frequencyPayload =
            entangledWorld?.frequencySources || entangledWorld?.exoplanetData || null;
        const nextWorldId =
            entangledWorld?.id ?? entangledWorld?.worldId ?? entangledWorld?._id ?? null;
        const payloadSignature = stableFrequencySignature(frequencyPayload);
        const shouldUpdateSources =
            force || lastWorldId !== nextWorldId || lastFrequencySignature !== payloadSignature;

        if (shouldUpdateSources && frequencyPayload) {
            ['x', 'y', 'z'].forEach((axis) => {
                const lfo = manager[axis];
                if (!lfo || typeof lfo.setFrequencySources !== 'function') {
                    return;
                }
                try {
                    lfo.setFrequencySources(frequencyPayload);
                } catch (error) {
                    console.warn(`[CosmicLFO:${axis}] Failed to apply frequency sources`, error);
                }
            });
            lastWorldId = nextWorldId;
            lastFrequencySignature = payloadSignature;
        } else if (shouldUpdateSources && !frequencyPayload) {
            lastWorldId = nextWorldId;
            lastFrequencySignature = payloadSignature;
        }
        // Legacy `<webaudio-switch>` cosmic trigger buttons are gone; the React Cosmic LFO panel drives
        // the multipliers through the `cosmic` engine surface, so there are no trigger switches to attach.
    }

    return { manager, primeCosmicLfoUi };
}
