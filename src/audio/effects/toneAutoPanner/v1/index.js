import { EFFECT_MANIFEST } from './manifest.js';
import { createToneAutoPannerEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_AUTO_PANNER_MANIFEST } from './manifest.js';
export { createToneAutoPannerEffect } from './factory.js';

export const toneAutoPannerEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneAutoPannerEffect,
};

export default toneAutoPannerEffectDefinition;
