import { EFFECT_MANIFEST } from './manifest.js';
import { createGranularEffect } from './factory.js';

export { EFFECT_MANIFEST as GRANULAR_MANIFEST } from './manifest.js';
export { createGranularEffect } from './factory.js';

export const granularEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createGranularEffect,
};

export default granularEffectDefinition;
