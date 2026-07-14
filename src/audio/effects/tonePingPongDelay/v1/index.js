import { EFFECT_MANIFEST } from './manifest.js';
import { createTonePingPongDelayEffect } from './factory.js';

export { EFFECT_MANIFEST as TONE_PING_PONG_DELAY_MANIFEST } from './manifest.js';
export { createTonePingPongDelayEffect } from './factory.js';

export const tonePingPongDelayEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  manifest: EFFECT_MANIFEST,
  create: createTonePingPongDelayEffect,
};

export default tonePingPongDelayEffectDefinition;
