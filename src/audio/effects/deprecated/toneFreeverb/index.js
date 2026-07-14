import { EFFECT_MANIFEST } from './manifest.js';
import { createToneFreeverbEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_FREEVERB_MANIFEST } from './manifest.js';
export { createToneFreeverbEffect } from './factory.js';

export const toneFreeverbEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneFreeverbEffect,
};

export default toneFreeverbEffectDefinition;
