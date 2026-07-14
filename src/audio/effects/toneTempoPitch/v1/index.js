import { EFFECT_MANIFEST } from './manifest.js';
import { createToneTempoPitchEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_TEMPO_PITCH_MANIFEST } from './manifest.js';
export { createToneTempoPitchEffect } from './factory.js';

export const toneTempoPitchEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneTempoPitchEffect,
};

export default toneTempoPitchEffectDefinition;
