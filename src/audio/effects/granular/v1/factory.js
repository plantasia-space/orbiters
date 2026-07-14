/**
 * @file effects/granular/v1/factory.js
 * @description Control modules over the shared per-voice granular engine. The
 *              engine lives at the source seam (it consumes the decoded buffer
 *              and mixes into the voice's source bus), so the rack slot hosts
 *              only control — the effect node is a passthrough gain and audio
 *              does not run through it.
 *
 *              Engine lifecycle: the first granular module on a voice creates
 *              the engine, further modules (other slots) attach to the same
 *              instance, and the last one released disposes it. Each module
 *              writes only its own mapped parameter subset; the engine resolves
 *              wet as the max across modules so one module at bypass can never
 *              mute another.
 */

import { EFFECT_MANIFEST } from './manifest.js';
import { GranularEngine, GRANULAR_ENGINE_ID } from '../../../granular/GranularEngine.js';

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * Maps a bipolar module value (its valueRange domain, equilibrium at center)
 * onto engine parameters through the module's segments. Negative-segment
 * mappings are written INVERTED (`min` = the -100 extreme, `max` = center);
 * positive-segment mappings run center → +100. Exported so the dev harness
 * and tests drive the exact mapping the rack modules use.
 * @param {object} moduleSpec - A module entry from the effect manifest.
 * @param {number} value - Rack value inside moduleSpec.valueRange.
 * @returns {Record<string, number>} engine params for the attachment.
 */
export function mapModuleValueToEngineParams(moduleSpec, value) {
  const range = moduleSpec.valueRange;
  const numeric = clamp(Number(value), range.min, range.max);
  const normalized = (numeric - range.min) / (range.max - range.min || 1);
  const isNegativeSegment = normalized < 0.5;
  const segment = isNegativeSegment ? moduleSpec.segments.negative : moduleSpec.segments.positive;
  const localNorm = isNegativeSegment ? normalized * 2 : (normalized - 0.5) * 2;
  const params = {};
  for (const [param, mapping] of Object.entries(segment.parameterMappings)) {
    params[param] = mapping.min + (mapping.max - mapping.min) * localNorm;
  }
  return params;
}

function createGranularModule({ moduleSpec, ensureAttachment }) {
  const range = moduleSpec.valueRange;
  let isActive = false;
  let lastInput = null;

  const writeParams = (value, { replace = false } = {}) => {
    const attachment = ensureAttachment();
    if (!attachment) return false;
    attachment.setParams(mapModuleValueToEngineParams(moduleSpec, value), { replace });
    return true;
  };

  return {
    id: moduleSpec.id,
    label: moduleSpec.label,
    description: moduleSpec.description,
    inputParam: EFFECT_MANIFEST.inputParam,
    toneProperty: 'wet',
    tonePropertyDescription: moduleSpec.description,
    valueRange: range,
    applyValue(value) {
      if (!isActive) return;
      const numeric = clamp(Number(value), range.min, range.max);
      if (numeric === lastInput) return;
      // Cheap by design: rack input can arrive at sensor rate. This stores the
      // mapped targets on the engine; audio-rate smoothing (wet) and the
      // scheduler quantum (density/size/...) do the actual pacing.
      if (writeParams(numeric)) {
        lastInput = numeric;
      }
    },
    setIsActive(active) {
      const next = active === true;
      if (next === isActive) return;
      isActive = next;
      if (isActive) {
        // Take over the slot's attachment: clear whatever parameter subset the
        // previously active module left behind, then assert our own.
        if (lastInput !== null) {
          writeParams(lastInput, { replace: true });
        } else {
          ensureAttachment()?.setParams({}, { replace: true });
        }
      } else {
        lastInput = null;
      }
    },
  };
}

export function createGranularEffect({ Tone, settings } = {}) {
  if (!Tone?.Gain) {
    throw new Error('[GranularEffect] Tone.Gain constructor is required.');
  }

  const playbackController = settings?.playbackController ?? null;
  const node = new Tone.Gain(1);

  let engineLease = null;
  let attachment = null;

  // Lazily bind to the voice on first use: by the time a module receives its
  // first value, the adapter's chain (source bus) exists. A voice without the
  // needed surface (e.g. no playback controller injected) stays inert. The
  // adapter's source-engine host owns all graph construction — this factory
  // only names the family and builds the engine from the host's surface.
  const ensureAttachment = () => {
    if (attachment) return attachment;
    if (!playbackController) return null;
    engineLease = playbackController.acquireSourceEngine?.(
      GRANULAR_ENGINE_ID,
      (io) => new GranularEngine(io),
    ) ?? null;
    if (!engineLease) return null;
    attachment = engineLease.engine.attach();
    return attachment;
  };

  const modules = EFFECT_MANIFEST.modules.map((moduleSpec) =>
    createGranularModule({ moduleSpec, ensureAttachment }),
  );
  let activeModuleId = modules[0]?.id ?? null;
  modules.forEach((module) => module.setIsActive(module.id === activeModuleId));

  return {
    id: EFFECT_MANIFEST.id,
    label: EFFECT_MANIFEST.label,
    version: EFFECT_MANIFEST.version,
    inputParam: EFFECT_MANIFEST.inputParam,
    node,
    modules,
    configureModule(moduleId) {
      if (moduleId === activeModuleId) return;
      activeModuleId = moduleId;
      modules.forEach((module) => module.setIsActive(module.id === moduleId));
    },
    dispose() {
      modules.forEach((module) => module.setIsActive(false));
      attachment?.detach();
      attachment = null;
      engineLease?.release();
      engineLease = null;
      modules.splice(0, modules.length);
      if (typeof node.dispose === 'function') {
        node.dispose();
      }
    },
    manifest: EFFECT_MANIFEST,
  };
}

export default createGranularEffect;
