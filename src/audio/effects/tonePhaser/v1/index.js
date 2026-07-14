import { EFFECT_MANIFEST } from './manifest.js';
import { createTonePhaserEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_PHASER_MANIFEST } from './manifest.js';
export { createTonePhaserEffect } from './factory.js';

export const tonePhaserEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createTonePhaserEffect,
};

export default tonePhaserEffectDefinition;
