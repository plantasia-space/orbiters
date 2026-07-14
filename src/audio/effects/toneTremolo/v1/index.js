import { EFFECT_MANIFEST } from './manifest.js';
import { createToneTremoloEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_TREMOLO_MANIFEST } from './manifest.js';
export { createToneTremoloEffect } from './factory.js';

export const toneTremoloEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneTremoloEffect,
};

export default toneTremoloEffectDefinition;
