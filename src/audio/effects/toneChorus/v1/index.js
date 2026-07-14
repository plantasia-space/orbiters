import { EFFECT_MANIFEST } from './manifest.js';
import { createToneChorusEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_CHORUS_MANIFEST } from './manifest.js';
export { createToneChorusEffect } from './factory.js';

export const toneChorusEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneChorusEffect,
};

export default toneChorusEffectDefinition;
