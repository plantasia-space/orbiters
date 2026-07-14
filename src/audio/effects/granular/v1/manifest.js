/**
 * @file effects/granular/v1/manifest.js
 * @description Granular texture modules. Every module is a different mapping of
 *              the single rack input onto the shared per-voice granular engine —
 *              one engine, many faces. Modules can be combined across the X/Y/Z
 *              slots; each drives its own parameter subset of the same engine.
 *
 *              Bipolar control (±180° encoder): the knob spans -100…100 with
 *              equilibrium at 0 (center) = full bypass. Each direction is its
 *              own character via `segments` (negative mappings are written
 *              INVERTED: `min` is the -100 extreme, `max` is the center).
 *              Dry/wet law, same for every module: center = 100% dry / 0% wet,
 *              either extreme = 0% dry / 100% wet — the granular texture
 *              gradually replaces the dry signal as the knob leaves center.
 *
 *              The engine reads the voice's decoded buffer, so every module
 *              requires the prebuffer backend.
 */

const CONTROL = Object.freeze({
  mode: 'hybrid',
  audioParam: 'wet',
  provider: 'playbackController',
  smoothing: Object.freeze({
    defaultRamp: 0.05,
    minRamp: 0.01,
    maxRamp: 1,
    curve: 'linear',
  }),
  signalRange: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
});

const VALUE_RANGE = Object.freeze({ min: -100, max: 100, equilibrium: 0, units: '%' });
const INITIAL_RANGE = Object.freeze({ min: -100, max: 100, equilibrium: 0 });

// Center = bypass on both sides of every segment boundary.
const WET_NEG = Object.freeze({ min: 1, max: 0 }); // INVERTED: full wet at -100 → bypass at center
const DRY_NEG = Object.freeze({ min: 0, max: 1 }); // INVERTED: dry gone at -100 → full dry at center
const WET_POS = Object.freeze({ min: 0, max: 1 }); // MIRROR: bypass at center → full wet at +100
const DRY_POS = Object.freeze({ min: 1, max: 0 }); // MIRROR: full dry at center → dry gone at +100

function module(id, label, description, segments, secondaryParameters) {
  return Object.freeze({
    id,
    label,
    description,
    dimension: '*',
    engineRequirement: 'prebuffer-required',
    fixed: Object.freeze({}),
    valueRange: VALUE_RANGE,
    initialRange: INITIAL_RANGE,
    segments: Object.freeze({
      negative: Object.freeze({
        id: `granular.${id}::${segments.negative.id}`,
        label: segments.negative.label,
        description: segments.negative.description,
        parameterMappings: Object.freeze({
          wet: WET_NEG,
          dryLevel: DRY_NEG,
          ...segments.negative.parameterMappings,
        }),
      }),
      positive: Object.freeze({
        id: `granular.${id}::${segments.positive.id}`,
        label: segments.positive.label,
        description: segments.positive.description,
        parameterMappings: Object.freeze({
          wet: WET_POS,
          dryLevel: DRY_POS,
          ...segments.positive.parameterMappings,
        }),
      }),
    }),
    control: Object.freeze({
      ...CONTROL,
      secondaryParameters: Object.freeze(['dryLevel', ...secondaryParameters]),
    }),
  });
}

export const EFFECT_MANIFEST = Object.freeze({
  id: 'granular',
  label: 'Granular',
  version: '1.0.0',
  inputParam: 'inputParam',
  dimensionId: '*',
  dimensionLabel: 'Granular',
  defaults: Object.freeze({}),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Texture',
    units: '%',
    range: Object.freeze({ min: -100, max: 100, equilibrium: 0 }),
  }),
  modules: Object.freeze([
    module(
      'cloud',
      'Cloud',
      'Grain cloud around the playhead — a smooth wash one way, a dense swarm the other.',
      {
        negative: {
          id: 'mist',
          label: 'Mist',
          description: 'Negative sweep: few large soft grains, a slow narrow wash.',
          parameterMappings: Object.freeze({
            density: Object.freeze({ min: 8, max: 4 }),
            grainSize: Object.freeze({ min: 0.35, max: 0.16 }),
            panSpread: Object.freeze({ min: 0.4, max: 0.2 }),
          }),
        },
        positive: {
          id: 'swarm',
          label: 'Swarm',
          description: 'Positive sweep: many small grains spreading across the stereo field.',
          parameterMappings: Object.freeze({
            density: Object.freeze({ min: 4, max: 40 }),
            grainSize: Object.freeze({ min: 0.16, max: 0.08 }),
            panSpread: Object.freeze({ min: 0.2, max: 1 }),
          }),
        },
      },
      ['density', 'grainSize', 'panSpread'],
    ),
    module(
      'shimmer',
      'Shimmer',
      'Grains bend in pitch — down into the depths one way, sparkling up the other.',
      {
        negative: {
          id: 'abyss',
          label: 'Abyss',
          description: 'Negative sweep: grains sink up to an octave down as they thicken.',
          parameterMappings: Object.freeze({
            grainPitch: Object.freeze({ min: 0.5, max: 1 }),
            density: Object.freeze({ min: 20, max: 6 }),
          }),
        },
        positive: {
          id: 'sparkle',
          label: 'Sparkle',
          description: 'Positive sweep: grains climb up to an octave above the source.',
          parameterMappings: Object.freeze({
            grainPitch: Object.freeze({ min: 1, max: 2 }),
            density: Object.freeze({ min: 6, max: 28 }),
          }),
        },
      },
      ['grainPitch', 'density'],
    ),
    module(
      'drift',
      'Drift',
      'Grains wander from the playhead — a soft blur one way, far-flung echoes the other.',
      {
        negative: {
          id: 'blur',
          label: 'Blur',
          description: 'Negative sweep: long overlapping grains smear close around the playhead.',
          parameterMappings: Object.freeze({
            positionSpray: Object.freeze({ min: 0.3, max: 0 }),
            grainSize: Object.freeze({ min: 0.3, max: 0.14 }),
          }),
        },
        positive: {
          id: 'wander',
          label: 'Wander',
          description: 'Positive sweep: grains stray further and further from the playhead.',
          parameterMappings: Object.freeze({
            positionSpray: Object.freeze({ min: 0, max: 1.5 }),
            grainSize: Object.freeze({ min: 0.14, max: 0.1 }),
          }),
        },
      },
      ['positionSpray', 'grainSize'],
    ),
    module(
      'freeze',
      'Freeze',
      'Slow the grain pointer — tape-drag slow motion one way, a frozen hold the other.',
      {
        negative: {
          id: 'drag',
          label: 'Drag',
          description: 'Negative sweep: the pointer trails the music in slow motion.',
          parameterMappings: Object.freeze({
            pointerSpeed: Object.freeze({ min: 0.35, max: 1 }),
            grainSize: Object.freeze({ min: 0.2, max: 0.14 }),
          }),
        },
        positive: {
          id: 'hold',
          label: 'Hold',
          description: 'Positive sweep: the pointer slows to a standstill and holds the moment.',
          parameterMappings: Object.freeze({
            pointerSpeed: Object.freeze({ min: 1, max: 0 }),
            grainSize: Object.freeze({ min: 0.14, max: 0.3 }),
          }),
        },
      },
      ['pointerSpeed', 'grainSize'],
    ),
    module(
      'scatter',
      'Scatter',
      'Grains fly apart — backwards-heavy rewinds one way, stereo confetti the other.',
      {
        negative: {
          id: 'rewind',
          label: 'Rewind',
          description: 'Negative sweep: more and more grains play their slice in reverse.',
          parameterMappings: Object.freeze({
            reverseProbability: Object.freeze({ min: 0.9, max: 0 }),
            panSpread: Object.freeze({ min: 0.5, max: 0.2 }),
            positionSpray: Object.freeze({ min: 0.3, max: 0 }),
          }),
        },
        positive: {
          id: 'confetti',
          label: 'Confetti',
          description: 'Positive sweep: grains scatter wide across the stereo field.',
          parameterMappings: Object.freeze({
            reverseProbability: Object.freeze({ min: 0, max: 0.3 }),
            panSpread: Object.freeze({ min: 0.2, max: 1 }),
            positionSpray: Object.freeze({ min: 0, max: 0.6 }),
          }),
        },
      },
      ['reverseProbability', 'panSpread', 'positionSpray'],
    ),
    module(
      'haze',
      'Haze',
      'A veil of soft grains — heavy slow smoke one way, light airy mist the other.',
      {
        negative: {
          id: 'smoke',
          label: 'Smoke',
          description: 'Negative sweep: very long, soft-swelling grains thicken into smoke.',
          parameterMappings: Object.freeze({
            grainSize: Object.freeze({ min: 0.5, max: 0.16 }),
            envelopeShape: Object.freeze({ min: 0.9, max: 0.55 }),
            density: Object.freeze({ min: 10, max: 6 }),
          }),
        },
        positive: {
          id: 'mist',
          label: 'Mist',
          description: 'Positive sweep: shorter airy grains gather into a bright mist.',
          parameterMappings: Object.freeze({
            grainSize: Object.freeze({ min: 0.16, max: 0.3 }),
            envelopeShape: Object.freeze({ min: 0.55, max: 0.8 }),
            density: Object.freeze({ min: 6, max: 24 }),
          }),
        },
      },
      ['grainSize', 'envelopeShape', 'density'],
    ),
  ]),
});

export default EFFECT_MANIFEST;
