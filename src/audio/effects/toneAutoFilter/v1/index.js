import { EFFECT_MANIFEST } from './manifest.js';
import { createToneAutoFilterEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_AUTO_FILTER_MANIFEST } from './manifest.js';
export { createToneAutoFilterEffect } from './factory.js';

export const toneAutoFilterEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneAutoFilterEffect,
};

export default toneAutoFilterEffectDefinition;
