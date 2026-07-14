import { EFFECT_MANIFEST } from './manifest.js';
import { createToneEQ3Effect } from './factory.js';

export { EFFECT_MANIFEST as TONE_EQ3_MANIFEST } from './manifest.js';
export { createToneEQ3Effect } from './factory.js';

export const toneEQ3EffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneEQ3Effect,
};

export default toneEQ3EffectDefinition;
