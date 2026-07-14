import { EFFECT_MANIFEST } from './manifest.js';
import { createToneChebyshevEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_CHEBYSHEV_MANIFEST } from './manifest.js';
export { createToneChebyshevEffect } from './factory.js';

export const toneChebyshevEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createToneChebyshevEffect,
};

export default toneChebyshevEffectDefinition;
