import { EFFECT_MANIFEST } from './manifest.js';
import { createToneReverbEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_REVERB_MANIFEST } from './manifest.js';
export { createToneReverbEffect } from './factory.js';

export const toneReverbEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  authoring: {
    deprecated: true,
    legacyLabel: 'Legacy',
  },
  manifest: EFFECT_MANIFEST,
  create: createToneReverbEffect,
};

export default toneReverbEffectDefinition;
