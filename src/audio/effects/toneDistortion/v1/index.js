import { EFFECT_MANIFEST } from './manifest.js';
import { createToneDistortionEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_DISTORTION_MANIFEST } from './manifest.js';
export { createToneDistortionEffect } from './factory.js';

export const toneDistortionEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneDistortionEffect,
};

export default toneDistortionEffectDefinition;
