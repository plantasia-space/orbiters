/**
 * @file effects/index.js
 * @description Public exports for available Tone.js based rack effects.
 */

import toneTempoPitchEffectDefinition, {
  createToneTempoPitchEffect,
  TONE_TEMPO_PITCH_MANIFEST,
} from './toneTempoPitch/latest.js';
import toneEQ3EffectDefinition, {
  createToneEQ3Effect,
  TONE_EQ3_MANIFEST,
} from './toneEQ3/latest.js';

import toneBiquadFilterEffectDefinition, {
  createToneBiquadFilterEffect,
  TONE_BIQUAD_FILTER_MANIFEST,
} from './toneBiquadFilter/latest.js';
import toneAutoFilterEffectDefinition, {
  createToneAutoFilterEffect,
  TONE_AUTO_FILTER_MANIFEST,
} from './toneAutoFilter/latest.js';
import tonePannerEffectDefinition, {
  createTonePannerEffect,
  TONE_PANNER_MANIFEST,
} from './tonePanner/latest.js';
import tonePingPongDelayEffectDefinition, {
  createTonePingPongDelayEffect,
  TONE_PING_PONG_DELAY_MANIFEST,
} from './tonePingPongDelay/latest.js';
import toneReverbEffectDefinition, {
  createToneReverbEffect,
  TONE_REVERB_MANIFEST,
} from './toneReverb/latest.js';
import tonePitchShiftEffectDefinition, {
  createTonePitchShiftEffect,
  TONE_PITCH_SHIFT_MANIFEST,
} from './tonePitchShift/latest.js';
import toneAutoPannerEffectDefinition, {
  createToneAutoPannerEffect,
  TONE_AUTO_PANNER_MANIFEST,
} from './toneAutoPanner/latest.js';
import toneAutoWahEffectDefinition, {
  createToneAutoWahEffect,
  TONE_AUTO_WAH_MANIFEST,
} from './toneAutoWah/latest.js';
import toneBitCrusherEffectDefinition, {
  createToneBitCrusherEffect,
  TONE_BITCRUSHER_MANIFEST,
} from './toneBitCrusher/latest.js';
import toneChebyshevEffectDefinition, {
  createToneChebyshevEffect,
  TONE_CHEBYSHEV_MANIFEST,
} from './toneChebyshev/latest.js';
import toneChorusEffectDefinition, {
  createToneChorusEffect,
  TONE_CHORUS_MANIFEST,
} from './toneChorus/latest.js';
import toneFeedbackDelayEffectDefinition, {
  createToneFeedbackDelayEffect,
  TONE_FEEDBACK_DELAY_MANIFEST,
} from './toneFeedbackDelay/latest.js';
import toneFrequencyShifterEffectDefinition, {
  createToneFrequencyShifterEffect,
  TONE_FREQUENCY_SHIFTER_MANIFEST,
} from './toneFrequencyShifter/latest.js';
import toneJCReverbEffectDefinition, {
  createToneJCReverbEffect,
  TONE_JC_REVERB_MANIFEST,
} from './toneJCReverb/latest.js';
import toneDistortionEffectDefinition, {
  createToneDistortionEffect,
  TONE_DISTORTION_MANIFEST,
} from './toneDistortion/latest.js';
import tonePhaserEffectDefinition, {
  createTonePhaserEffect,
  TONE_PHASER_MANIFEST,
} from './tonePhaser/latest.js';
import toneStereoWidenerEffectDefinition, {
  createToneStereoWidenerEffect,
  TONE_STEREO_WIDENER_MANIFEST,
} from './toneStereoWidener/latest.js';
import toneVibratoEffectDefinition, {
  createToneVibratoEffect,
  TONE_VIBRATO_MANIFEST,
} from './toneVibrato/latest.js';
import toneTremoloEffectDefinition, {
  createToneTremoloEffect,
  TONE_TREMOLO_MANIFEST,
} from './toneTremolo/latest.js';
import granularEffectDefinition, {
  createGranularEffect,
  GRANULAR_MANIFEST,
} from './granular/latest.js';

/**
 * @typedef {object} RackEffectDefinition
 * @property {string} id
 * @property {string} label
 * @property {string} version
 * @property {object} manifest
 * @property {Function} create
 */

/**
 * @typedef {object} DimensionEffectSummary
 * @property {string} id
 * @property {string} label
 * @property {string} version
 * @property {object} manifest
 */

/**
 * @typedef {object} DimensionCatalogEntry
 * @property {string} id
 * @property {string} label
 * @property {Array<DimensionEffectSummary>} effects
 */

/**
 * Back-compat effect ids that should resolve to newer manifest identifiers.
 * Allows older sessions to load even after a rename.
 */
const EFFECT_ID_ALIASES = Object.freeze({
  'tone.biquad': 'tone.biquadFilter',
  'tone.timeReverse': 'tone.tempoPitch',
});

/**
 * Engine requirement constants for effect modules.
 * - STREAM_SAFE: Module can run with streaming playback backend
 * - PREBUFFER_REQUIRED: Module requires prebuffer backend (e.g., for true reverse playback)
 * - STRETCH_REQUIRED: Module requires the time-stretch playback engine, which
 *   itself implies the prebuffer backend (the engine consumes the decoded buffer)
 */
export const ENGINE_REQUIREMENT = Object.freeze({
  STREAM_SAFE: 'stream-safe',
  PREBUFFER_REQUIRED: 'prebuffer-required',
  STRETCH_REQUIRED: 'stretch-required',
});

function normalizeEngineRequirement(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === ENGINE_REQUIREMENT.STRETCH_REQUIRED) {
    return ENGINE_REQUIREMENT.STRETCH_REQUIRED;
  }
  if (normalized === ENGINE_REQUIREMENT.PREBUFFER_REQUIRED) {
    return ENGINE_REQUIREMENT.PREBUFFER_REQUIRED;
  }
  return ENGINE_REQUIREMENT.STREAM_SAFE;
}


export {
  createToneTempoPitchEffect,
  TONE_TEMPO_PITCH_MANIFEST,
  toneEQ3EffectDefinition,
  createToneEQ3Effect,
  TONE_EQ3_MANIFEST,
  toneBiquadFilterEffectDefinition,
  createToneBiquadFilterEffect,
  TONE_BIQUAD_FILTER_MANIFEST,
  toneAutoFilterEffectDefinition,
  createToneAutoFilterEffect,
  TONE_AUTO_FILTER_MANIFEST,
  tonePannerEffectDefinition,
  createTonePannerEffect,
  TONE_PANNER_MANIFEST,
  tonePingPongDelayEffectDefinition,
  createTonePingPongDelayEffect,
  TONE_PING_PONG_DELAY_MANIFEST,
  toneReverbEffectDefinition,
  createToneReverbEffect,
  TONE_REVERB_MANIFEST,
  toneAutoPannerEffectDefinition,
  createToneAutoPannerEffect,
  TONE_AUTO_PANNER_MANIFEST,
  toneAutoWahEffectDefinition,
  createToneAutoWahEffect,
  TONE_AUTO_WAH_MANIFEST,
  toneBitCrusherEffectDefinition,
  createToneBitCrusherEffect,
  TONE_BITCRUSHER_MANIFEST,
  toneChebyshevEffectDefinition,
  createToneChebyshevEffect,
  TONE_CHEBYSHEV_MANIFEST,
  toneChorusEffectDefinition,
  createToneChorusEffect,
  TONE_CHORUS_MANIFEST,
  toneDistortionEffectDefinition,
  createToneDistortionEffect,
  TONE_DISTORTION_MANIFEST,
  toneFeedbackDelayEffectDefinition,
  createToneFeedbackDelayEffect,
  TONE_FEEDBACK_DELAY_MANIFEST,
  toneFrequencyShifterEffectDefinition,
  createToneFrequencyShifterEffect,
  TONE_FREQUENCY_SHIFTER_MANIFEST,
  toneJCReverbEffectDefinition,
  createToneJCReverbEffect,
  TONE_JC_REVERB_MANIFEST,
  tonePhaserEffectDefinition,
  createTonePhaserEffect,
  TONE_PHASER_MANIFEST,
  toneTempoPitchEffectDefinition,
  tonePitchShiftEffectDefinition,
  createTonePitchShiftEffect,
  TONE_PITCH_SHIFT_MANIFEST,
  toneStereoWidenerEffectDefinition,
  createToneStereoWidenerEffect,
  TONE_STEREO_WIDENER_MANIFEST,
  toneVibratoEffectDefinition,
  createToneVibratoEffect,
  TONE_VIBRATO_MANIFEST,
  toneTremoloEffectDefinition,
  createToneTremoloEffect,
  TONE_TREMOLO_MANIFEST,
  granularEffectDefinition,
  createGranularEffect,
  GRANULAR_MANIFEST,
};

/**
 * Ordered list of effect definitions that the rack can instantiate.
 * Each entry is the object exported from `effects/<effectId>/index.js`.
 * @type {Array<RackEffectDefinition>}
 */
export const AVAILABLE_EFFECT_DEFINITIONS = [
  toneTempoPitchEffectDefinition,
  toneEQ3EffectDefinition,
  toneBiquadFilterEffectDefinition,
  toneAutoFilterEffectDefinition,
  tonePannerEffectDefinition,
  tonePingPongDelayEffectDefinition,
  toneReverbEffectDefinition,
  toneAutoPannerEffectDefinition,
  toneAutoWahEffectDefinition,
  toneBitCrusherEffectDefinition,
  toneChebyshevEffectDefinition,
  toneChorusEffectDefinition,
  toneDistortionEffectDefinition,
  toneFeedbackDelayEffectDefinition,
  toneFrequencyShifterEffectDefinition,
  toneJCReverbEffectDefinition,
  tonePhaserEffectDefinition,
  toneStereoWidenerEffectDefinition,
  toneVibratoEffectDefinition,
  toneTremoloEffectDefinition,
  tonePitchShiftEffectDefinition,
  granularEffectDefinition,

];

function isDefinitionDeprecatedForAuthoring(definition) {
  return Boolean(definition?.authoring?.deprecated);
}

export function isEffectDeprecatedForAuthoring(effectIdOrDefinition) {
  if (!effectIdOrDefinition) return false;
  if (typeof effectIdOrDefinition === 'string') {
    return isDefinitionDeprecatedForAuthoring(getEffectDefinition(effectIdOrDefinition));
  }
  return isDefinitionDeprecatedForAuthoring(effectIdOrDefinition);
}

export function resolveModuleEngineRequirement(effectId, moduleId = null) {
  const definition = getEffectDefinition(effectId);
  const manifest = definition?.manifest || null;
  if (!manifest) {
    return ENGINE_REQUIREMENT.STREAM_SAFE;
  }

  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  if (moduleId) {
    const moduleManifest = modules.find((item) => item?.id === moduleId) || null;
    if (moduleManifest) {
      return normalizeEngineRequirement(
        moduleManifest.engineRequirement ?? manifest.engineRequirement,
      );
    }
  }

  return normalizeEngineRequirement(manifest.engineRequirement);
}

export function resolveEngineRequirementForEffectsConfig(effectsConfig = {}) {
  const axes = ['x', 'y', 'z'];
  let strongest = ENGINE_REQUIREMENT.STREAM_SAFE;
  for (const axis of axes) {
    const axisConfig = effectsConfig?.[axis];
    const modules = Array.isArray(axisConfig?.modules) ? axisConfig.modules : [];
    for (const moduleConfig of modules) {
      const effectId = moduleConfig?.effectId ?? null;
      if (!effectId) continue;
      const moduleId = moduleConfig?.moduleId ?? null;
      const requirement = resolveModuleEngineRequirement(effectId, moduleId);
      if (requirement === ENGINE_REQUIREMENT.STRETCH_REQUIRED) {
        return ENGINE_REQUIREMENT.STRETCH_REQUIRED;
      }
      if (requirement === ENGINE_REQUIREMENT.PREBUFFER_REQUIRED) {
        strongest = ENGINE_REQUIREMENT.PREBUFFER_REQUIRED;
      }
    }
  }
  return strongest;
}

/**
 * Retrieve an effect definition by its identifier (or alias) so the rack can instantiate it.
 * @param {string} effectId
 * @returns {{ id: string, manifest: object, create: Function }|null}
 */
export function getEffectDefinition(effectId) {
  const resolvedId = EFFECT_ID_ALIASES[effectId] || effectId;
  return AVAILABLE_EFFECT_DEFINITIONS.find((effect) => effect.id === resolvedId) || null;
}

/**
 * Formats the effect metadata stored under each dimension catalog entry.
 * @param {RackEffectDefinition} definition
 * @returns {DimensionEffectSummary}
 */
function buildDimensionEntry(definition) {
  const manifest = definition.manifest || {};
  return {
    id: definition.id,
    label: definition.label,
    version: definition.version,
    manifest,
  };
}

/**
 * Builds a stable `Map` keyed by dimension id. Each entry contains the dimension label
 * plus the list of effect definitions that advertise support for that dimension.
 * Wildcard (`*`) dimensions are expanded to all known ids so selectors can remain deterministic.
 * @returns {Map<string, DimensionCatalogEntry>}
 */
export function getDimensionCatalogMap({ includeDeprecated = true } = {}) {
  const effectDefinitions = includeDeprecated
    ? AVAILABLE_EFFECT_DEFINITIONS
    : AVAILABLE_EFFECT_DEFINITIONS.filter((definition) => !isDefinitionDeprecatedForAuthoring(definition));
  const catalog = new Map();
  // Gather known dimension ids first (excluding wildcards)
  const knownIds = new Set();
  effectDefinitions.forEach((definition) => {
    const manifest = definition.manifest || {};
    const ids = manifest.dimensionId;
    if (Array.isArray(ids)) {
      ids.forEach((id) => { if (id && id !== '*') knownIds.add(id); });
    } else if (typeof ids === 'string' && ids && ids !== '*') {
      knownIds.add(ids);
    } else if (!ids) {
      knownIds.add('default');
    }
  });

  const wildcards = [];

  const pushToCatalog = (id, label, definition) => {
    const entry = catalog.get(id);
    if (entry) {
      entry.effects.push(buildDimensionEntry(definition));
      return;
    }
    catalog.set(id, {
      id,
      label: label || id,
      effects: [buildDimensionEntry(definition)],
    });
  };

  effectDefinitions.forEach((definition) => {
    const manifest = definition.manifest || {};
    const ids = manifest.dimensionId;
    const labelsMap = manifest.dimensionLabels || null; // optional: { [id]: label }
    const fallbackLabel = manifest.dimensionLabel || null;

    const resolveLabel = (id) => (labelsMap && labelsMap[id]) || fallbackLabel || id;

    if (ids === '*' || (Array.isArray(ids) && ids.includes('*'))) {
      wildcards.push(definition);
      return;
    }

    const idList = Array.isArray(ids) ? ids : [ids || 'default'];
    idList.forEach((id) => pushToCatalog(id, resolveLabel(id), definition));
  });

  // Expand wildcard definitions to all known dimension ids
  if (wildcards.length) {
    knownIds.forEach((id) => {
      wildcards.forEach((definition) => {
        const manifest = definition.manifest || {};
        const labelsMap = manifest.dimensionLabels || null;
        const fallbackLabel = manifest.dimensionLabel || null;
        const label = (labelsMap && labelsMap[id]) || fallbackLabel || id;
        pushToCatalog(id, label, definition);
      });
    });
  }

  const sortedEntries = [...catalog.entries()].sort(([, a], [, b]) =>
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
  );
  return new Map(sortedEntries);
}

/**
 * Convenience helper that returns the catalog map as an array, already sorted by label.
 * @returns {Array<DimensionCatalogEntry>}
 */
export function getAvailableDimensions({ includeDeprecated = true } = {}) {
  return Array.from(getDimensionCatalogMap({ includeDeprecated }).values());
}
