import { EFFECT_MANIFEST } from './manifest.js';
import { createToneJCReverbEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_JC_REVERB_MANIFEST } from './manifest.js';
export { createToneJCReverbEffect } from './factory.js';

export const toneJCReverbEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneJCReverbEffect,
};

export default toneJCReverbEffectDefinition;
