/**
 * @file visual/effectVisualPolicy.js
 * @description The one enablement resolver for effect visuals (see
 *              `visual_design_standard.md`, "Enablement — two layers, one
 *              resolver"). Maps the active graphics preset to per-group visual
 *              settings — mount gates and quality tunables — so no layer ever
 *              reads the preset directly: hosts resolve once per profile
 *              change and hand each layer its settings.
 *
 *              Two inputs, resolved in order:
 *              1. User preference (off/on overall or per group) gates mounting
 *                 before quality is considered. No preference surface exists
 *                 yet, so the default is "everything on" — a future settings
 *                 UI only ever touches this input, never the layers.
 *              2. The graphics preset (low/mid/high) drives each enabled
 *                 group's quality knobs.
 */

/**
 * Quality tunables per graphics preset key. Groups missing from a preset row
 * fall back to the MID values, so a new group only needs entries where it
 * actually varies.
 *
 * texture   — the granular accretion disk (tier 1): `echoCopies` bounds the
 *             visual echo particles per audio grain.
 * echoes    — delays on the moons (tier 0 + wet meters): `summonedMoonCount`
 *             sizes the ghost-moon stand-in for worlds without moons.
 * spaceAir  — reverbs smear the room around the world (post pass + wet meter):
 *             `blurTaps` is samples per pixel in the smeared ring — the one knob
 *             that costs fill, so a weak device takes fewer and still reads. The
 *             planet itself is never sampled more than once.
 * wobble    — the LFO modulators on the moons' surfaces (tier 0, no meter):
 *             the noise LIGHTS the moons, it never reshapes them, so there is no
 *             geometry to size. `bumpScale` is how hard the light reacts to the
 *             noise's slope, and `noiseTextureSize` sizes the ONE shared field —
 *             a weak phone gets a smaller field and a gentler surface.
 * position  — the panner and the stereo widener on the camera's LENS (tier 0, no
 *             meter): nothing is drawn, so there is no cost to scale. The knobs
 *             are AMPLITUDE — how far the lens opens (`fovWideDeg`), closes
 *             (`fovNarrowDeg`) and slides (`shiftFrac`, in frame widths). A small
 *             screen held close to the face takes a big lens swing badly, so the
 *             low preset answers more gently.
 * color     — the EQ's three bands on the colour of the world's MOONS (tier 0, no
 *             meter): nothing is drawn, so there is no cost to scale.
 *             `channelSpan` is AMPLITUDE — how far one channel travels at a full
 *             cut or boost.
 * (the filters proper have no visual at all — a filter changes the sound and
 * leaves the world alone. The EQ is the exception: it does not carve the sound
 * away, it weighs the bands against each other, and that weighing is a colour.)
 */
const QUALITY_BY_PRESET = {
  LOW: {
    texture: { echoCopies: 2 },
    echoes: { summonedMoonCount: 2 },
    spaceAir: { blurTaps: 6 },
    wobble: { bumpScale: 0.6, noiseTextureSize: 128 },
    grit: { pixelSize: 8, levels: 4, ditherScale: 2 },
    position: { fovNarrowDeg: 10, fovWideDeg: 14, shiftFrac: 0.08 },
    color: { channelSpan: 0.8 },
  },
  MID: {
    texture: { echoCopies: 4 },
    echoes: { summonedMoonCount: 4 },
    spaceAir: { blurTaps: 10 },
    wobble: { bumpScale: 1, noiseTextureSize: 256 },
    grit: { pixelSize: 6, levels: 5, ditherScale: 2 },
    position: { fovNarrowDeg: 14, fovWideDeg: 20, shiftFrac: 0.12 },
    color: { channelSpan: 1 },
  },
  HIGH: {
    texture: { echoCopies: 5 },
    echoes: { summonedMoonCount: 4 },
    spaceAir: { blurTaps: 14 },
    wobble: { bumpScale: 1.2, noiseTextureSize: 512 },
    grit: { pixelSize: 5, levels: 6, ditherScale: 2 },
    position: { fovNarrowDeg: 14, fovWideDeg: 20, shiftFrac: 0.12 },
    color: { channelSpan: 1 },
  },
};

/** Every group the vocabulary defines; extend as groups reach production. */
export const EFFECT_VISUAL_GROUPS = Object.freeze(
  Object.keys(QUALITY_BY_PRESET.MID),
);

/**
 * Which group an effect answers in — the ONE classification. The bridge reads it
 * to know what to bind; the Studio panel reads it to know whether the module has
 * a visual to offer a switch for at all. An effect that is absent has no visual:
 * the filters deliberately have none, and the rest are not built yet. A group
 * reaches production by being added here.
 */
const GROUP_BY_EFFECT_ID = new Map([
  ['tone.feedbackdelay', 'echoes'],
  ['tone.pingpongdelay', 'echoes'],
  ['tone.reverb', 'spaceAir'],
  ['tone.jcreverb', 'spaceAir'],
  // The LFO modulators — they light the moons' surfaces at the rate of their own
  // oscillator (reconstructed; see `wobbleMoonsLayer.js`).
  ['tone.chorus', 'wobble'],
  ['tone.phaser', 'wobble'],
  ['tone.tremolo', 'wobble'],
  ['tone.vibrato', 'wobble'],
  // The dirt — they crush the PICTURE, not a surface: the whole frame pixelates and
  // breaks into an ordered dither as the sound dirties (see `gritDitherLayer.js`).
  ['tone.distortion', 'grit'],
  ['tone.bitcrusher', 'grit'],
  ['tone.chebyshev', 'grit'],
  // Where the sound sits in the stereo field — they answer in the camera's LENS: the
  // widener opens and closes the field of view, the panner slides it sideways (see
  // `positionLensLayer.js`).
  ['tone.panner', 'position'],
  ['tone.stereowidener', 'position'],
  // The EQ's three bands are the three colours of the world's moons. The two spectra ascend
  // together: the lows are red — the warmth — the mids green, and the highs blue, the
  // brightness. The moons answer and the world keeps its own colour (see `colorTintLayer.js`).
  ['tone.eq3', 'color'],
]);

/**
 * @param {string|null|undefined} effectId
 * @returns {string|null} The group this effect answers in, or null when it has no
 *          visual — nothing to bind, and no switch to show for it.
 */
export function effectVisualGroupOf(effectId) {
  return GROUP_BY_EFFECT_ID.get(effectId) ?? null;
}

/**
 * @typedef {object} EffectVisualPreference
 * @property {boolean} [enabled] - Master gate; false disables every group.
 * @property {Object<string, boolean>} [groups] - Per-group gates; a group
 *           absent from the map stays enabled.
 */

/** The stand-in preference until a real user setting exists: everything on. */
export const EFFECT_VISUAL_PREFERENCE_ALL_ON = Object.freeze({ enabled: true });

/**
 * Resolve the per-group settings for one voice's effect visuals.
 *
 * @param {{ key?: string }|string|null|undefined} graphicsProfile - The active
 *        graphics preset (object with `key`, or the key itself). Unknown or
 *        missing presets resolve as MID.
 * @param {EffectVisualPreference|null|undefined} [preference] - The user
 *        preference input; omit for the "everything on" stub.
 * @returns {Object<string, { enabled: boolean }>} One settings object per
 *          group; `enabled` gates mounting, the remaining fields are the
 *          group's quality knobs at this preset.
 */
export function resolveEffectVisualSettings(graphicsProfile, preference = EFFECT_VISUAL_PREFERENCE_ALL_ON) {
  const presetKey = typeof graphicsProfile === 'string' ? graphicsProfile : graphicsProfile?.key;
  const quality = QUALITY_BY_PRESET[presetKey] ?? QUALITY_BY_PRESET.MID;
  const masterEnabled = preference?.enabled !== false;

  const settings = {};
  for (const group of EFFECT_VISUAL_GROUPS) {
    const groupEnabled = masterEnabled && preference?.groups?.[group] !== false;
    settings[group] = {
      enabled: groupEnabled,
      ...(quality[group] ?? QUALITY_BY_PRESET.MID[group]),
    };
  }
  return settings;
}

export default resolveEffectVisualSettings;
