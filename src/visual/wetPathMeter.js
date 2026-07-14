/**
 * @file visual/wetPathMeter.js
 * @description Wet-path level meter for event-shaped effect visuals — the
 *              per-effect analogue of the per-voice master meter the
 *              oscilloscope ring reads. Peak-held RMS so short echo taps stay
 *              visible for a frame or two instead of falling between analyser
 *              reads. Rendered by both the production bridge and the dev
 *              harness (one implementation, per the visual design standard).
 *
 *              Meter failures must never break the audio graph: construction
 *              returns null when the tap can't be wired, and `read()` never
 *              throws.
 */

/** Frame-to-frame decay of the held peak (~0.88 ≈ readable for 2–3 frames at 60fps). */
const PEAK_HOLD_DECAY = 0.88;

/**
 * @param {BaseAudioContext} context - The audio context that owns `sourceNode`.
 * @param {object} sourceNode - Node carrying the wet signal (native or Tone —
 *        anything with a `connect` accepting a native AnalyserNode).
 * @returns {{ read(): number, dispose(): void }|null} Null when the tap can't
 *          be created — callers treat a missing meter as level 0.
 */
export function createWetPathMeter(context, sourceNode) {
  if (!context || typeof context.createAnalyser !== 'function' || !sourceNode) return null;

  let analyser;
  try {
    analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0;
    sourceNode.connect(analyser);
  } catch (_) {
    return null;
  }

  const samples = new Float32Array(analyser.fftSize);
  let held = 0;

  return {
    /** Peak-held RMS of the last analyser window (0..~1). */
    read() {
      try {
        analyser.getFloatTimeDomainData(samples);
      } catch (_) {
        return 0;
      }
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      held = Math.max(rms, held * PEAK_HOLD_DECAY);
      return held;
    },
    dispose() {
      try {
        sourceNode.disconnect(analyser);
      } catch (_) {}
    },
  };
}

export default createWetPathMeter;
