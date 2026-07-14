/**
 * @file src/audio/audioNodeUtils.js
 * @description Small shared helpers for Tone/Web-Audio nodes. Extracted from AudioEngineAdapter so the
 * multi-orbiter composition owner (`MultiOrbiterAudioHost`) and the per-voice adapter share ONE
 * definition instead of duplicating it (AGENTS: one canonical helper, no copies).
 */

/**
 * Force a node to stereo (2-channel, explicit) so the chain never collapses to mono when an upstream
 * node defaults to a single channel. Tolerant of the different shapes Tone nodes expose (`set`, raw
 * AudioNode channel props); silently ignores nodes that expose none.
 * @param {*} node a Tone node or raw AudioNode (or null — no-op).
 */
export function enforceStereo(node) {
  if (!node) return;
  const stereoConfig = {
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  };
  try {
    if (typeof node.set === 'function') {
      node.set(stereoConfig);
      return;
    }
    if (typeof node.get === 'function') {
      node.set?.(stereoConfig);
      return;
    }
    if ('channelCount' in node) {
      node.channelCount = stereoConfig.channelCount;
    }
    if ('channelCountMode' in node) {
      node.channelCountMode = stereoConfig.channelCountMode;
    }
    if ('channelInterpretation' in node) {
      node.channelInterpretation = stereoConfig.channelInterpretation;
    }
  } catch (_) {
    // Ignore; some nodes may not expose these properties
  }
}
