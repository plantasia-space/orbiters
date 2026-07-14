import { EFFECT_MANIFEST } from './manifest.js';
import { createToneTimeReverseEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_TIME_REVERSE_MANIFEST } from './manifest.js';
export { createToneTimeReverseEffect } from './factory.js';

export const toneTimeReverseEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneTimeReverseEffect,
};

export default toneTimeReverseEffectDefinition;
