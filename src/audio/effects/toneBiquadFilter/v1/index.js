import { EFFECT_MANIFEST } from './manifest.js';
import { createToneBiquadFilterEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_BIQUAD_FILTER_MANIFEST } from './manifest.js';
export { createToneBiquadFilterEffect } from './factory.js';

export const toneBiquadFilterEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneBiquadFilterEffect,
};

export default toneBiquadFilterEffectDefinition;
