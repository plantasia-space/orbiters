import { EFFECT_MANIFEST } from './manifest.js';
import { createTonePannerEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_PANNER_MANIFEST } from './manifest.js';
export { createTonePannerEffect } from './factory.js';

export const tonePannerEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createTonePannerEffect,
};

export default tonePannerEffectDefinition;
