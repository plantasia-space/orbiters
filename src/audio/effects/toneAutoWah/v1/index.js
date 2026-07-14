import { EFFECT_MANIFEST } from './manifest.js';
import { createToneAutoWahEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_AUTO_WAH_MANIFEST } from './manifest.js';
export { createToneAutoWahEffect } from './factory.js';

export const toneAutoWahEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneAutoWahEffect,
};

export default toneAutoWahEffectDefinition;
