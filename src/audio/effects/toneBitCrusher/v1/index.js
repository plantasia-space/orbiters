import { EFFECT_MANIFEST } from './manifest.js';
import { createToneBitCrusherEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_BITCRUSHER_MANIFEST } from './manifest.js';
export { createToneBitCrusherEffect } from './factory.js';

export const toneBitCrusherEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneBitCrusherEffect,
};

export default toneBitCrusherEffectDefinition;
