/**
 * @file visual/colorTintLayer.js
 * @description The colour group's visual: the EQ's three bands are the three colours of the
 *              world's moons. The two spectra ascend together — red is the lowest note light
 *              can play and blue the highest — so the lows are the moons' warmth, the mids
 *              their green, and the highs their brightness, their air. Boost the lows and
 *              the moons warm; cut them and the warmth drains out. Each band is its own
 *              channel and they mix as colour mixes: lows and highs up together and the
 *              moons turn magenta.
 *
 *              The moons take the colour, not the world. The world's own colour is its
 *              identity — the thing the listener came for — and an effect is not entitled to
 *              it. The moons are the world's ANSWER: they already blink to a delay and stir
 *              to a chorus, so the EQ speaks where the rest of the rack speaks, and the
 *              planet stays the colour it was built.
 *
 *              Owns no scene object: it tints moons the world already draws, so nothing is
 *              added to draw.
 *
 *              At a band's equilibrium that colour is exactly the scene's own, and with all
 *              three at rest the moons are handed back untouched and left alone — a flat EQ
 *              leaves the world exactly as it was, and pays nothing per frame.
 *
 *              Takes its knobs resolved (`effectVisualPolicy`), never reads a preset.
 */

/**
 * @param {object} options
 * @param {object} options.canvas - The moons-tint canvas adapter (`worldCanvasAdapters`).
 * @param {number} [options.channelSpan] - How far a channel travels at a full cut or boost,
 *        as a share of the moons' own colour.
 * @returns {{ update(nowSec: number, dtSec: number, state: object): void, dispose(): void }}
 */
export function createColorTintLayer({ canvas, channelSpan = 0.5 } = {}) {
  // Whether the moons are currently tinted by us. At rest they are the scene's own again and
  // we write nothing at all.
  let tinted = false;
  // Handed to the canvas each frame, mutated in place — the render path allocates nothing.
  const gain = { r: 1, g: 1, b: 1 };

  function clampSigned(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
  }

  /**
   * One band's drive as a factor on its channel — a colour CAST, not a channel push.
   *
   * A boosted band lifts its own channel and eases the other two down together. That is
   * the only way light can actually add a colour: a world of gold reflects almost no blue,
   * so multiplying blue alone up leaves it gold (merely paler), and the boost would answer
   * far more weakly than the cut. Weighing the channel against the other two makes both
   * ends of the sweep answer alike, which is the whole rule.
   *
   * The consequence, and it is the musical truth: three bands boosted equally weigh the
   * same against each other as three at rest, so the moons take no colour. An EQ that
   * lifts everything has changed the level, not the tone.
   *
   * @param {number} own - This band's drive.
   * @param {number} otherA - Another band's drive.
   * @param {number} otherB - The third band's drive.
   */
  function channelGain(own, otherA, otherB) {
    const weighed = own - (otherA + otherB) / 2;
    return Math.max(0, 1 + weighed * channelSpan);
  }

  return {
    /**
     * @param {number} nowSec
     * @param {number} dtSec
     * @param {{ low: number, mid: number, high: number }} state - Signed −1..1 per band:
     *        how far it is cut or boosted from flat.
     */
    update(nowSec, dtSec, state) {
      canvas.sync(nowSec);
      if (!canvas.exists()) return;

      const low = clampSigned(state.low);
      const mid = clampSigned(state.mid);
      const high = clampSigned(state.high);

      // A flat EQ is not a colour of zero — it is no colour AT ALL: the moons go back
      // to exactly what the scene built them, and then nothing is written until a band moves.
      if (low === 0 && mid === 0 && high === 0) {
        if (!tinted) return;
        canvas.reset();
        tinted = false;
        return;
      }

      // Colour IS frequency, so the two spectra are laid end to end and ascend together:
      // red is the lowest note light can play and blue the highest, exactly as the bands
      // run from the bottom of hearing to the top. It is also what the ear already calls
      // them — the lows are the warmth and the highs are the brightness, the air.
      const r = channelGain(low, mid, high);
      const g = channelGain(mid, low, high);
      const b = channelGain(high, mid, low);
      // A held knob writes nothing: the moons only move when the weight does.
      if (tinted && r === gain.r && g === gain.g && b === gain.b) return;
      gain.r = r;
      gain.g = g;
      gain.b = b;
      canvas.drive(gain);
      tinted = true;
    },
    dispose() {
      if (!tinted) return;
      canvas.reset();
      tinted = false;
    },
  };
}

export default createColorTintLayer;
