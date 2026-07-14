import { EFFECT_MANIFEST } from './manifest.js';
import { createToneFrequencyShifterEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_FREQUENCY_SHIFTER_MANIFEST } from './manifest.js';
export { createToneFrequencyShifterEffect } from './factory.js';

export const toneFrequencyShifterEffectDefinition = {
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
  create: createToneFrequencyShifterEffect,
};

export default toneFrequencyShifterEffectDefinition;
