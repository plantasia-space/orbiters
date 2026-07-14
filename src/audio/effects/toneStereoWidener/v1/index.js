import { EFFECT_MANIFEST } from './manifest.js';
import { createToneStereoWidenerEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_STEREO_WIDENER_MANIFEST } from './manifest.js';
export { createToneStereoWidenerEffect } from './factory.js';

export const toneStereoWidenerEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneStereoWidenerEffect,
};

export default toneStereoWidenerEffectDefinition;
