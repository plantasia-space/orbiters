import { EFFECT_MANIFEST } from './manifest.js';
import { createToneVibratoEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_VIBRATO_MANIFEST } from './manifest.js';
export { createToneVibratoEffect } from './factory.js';

export const toneVibratoEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneVibratoEffect,
};

export default toneVibratoEffectDefinition;
