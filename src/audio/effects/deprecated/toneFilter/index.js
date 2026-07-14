import { EFFECT_MANIFEST } from './manifest.js';
import { createToneFilterEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_FILTER_MANIFEST } from './manifest.js';
export { createToneFilterEffect } from './factory.js';

export const toneFilterEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneFilterEffect,
};

export default toneFilterEffectDefinition;
