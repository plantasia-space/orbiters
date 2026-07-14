import { EFFECT_MANIFEST } from './manifest.js';
import { createTonePitchShiftEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_PITCH_SHIFT_MANIFEST } from './manifest.js';
export { createTonePitchShiftEffect } from './factory.js';

export const tonePitchShiftEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  // Superseded for new authoring by the stretch engine's Pure Pitch modules
  // (artifact-free, tempo locked). Stays registered so saved orbiters load.
  authoring: {
    deprecated: true,
    legacyLabel: 'Legacy',
  },
  manifest: EFFECT_MANIFEST,
  create: createTonePitchShiftEffect,
};

export default tonePitchShiftEffectDefinition;
