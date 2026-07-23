/**
 * @file effects/granular/v1/manifest.js
 * @description Grain parameter modules. Every module is one direct granular
 *              parameter of the single per-voice engine — one engine, one knob
 *              per parameter. Modules combine across the X/Y/Z slots; each
 *              drives its own parameter subset of the same engine, so Position
 *              on X and Spray on Y sculpt one shared grain cloud.
 *
 *              Bipolar control (±180° encoder): the knob spans -100…100 with
 *              equilibrium at 0 (center) = full bypass. Each direction is its
 *              own reach of the parameter via `segments` (negative mappings are
 *              written INVERTED: `min` is the -100 extreme, `max` is the
 *              center). Dry/wet law, same for every module: center = 100% dry /
 *              0% wet, either extreme = 0% dry / 100% wet — the grain cloud
 *              gradually replaces the dry signal as the knob leaves center.
 *              Parameters a module does not map sit at the engine defaults,
 *              which are tuned so any single knob is immediately granular
 *              (small spray, moderate density, short grains).
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
  version: '1.1.0',
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
      'position',
      'Grain Position',
      'Grain position — anchor the grain loop point anywhere in the track while the dry voice plays on.',
      {
        negative: {
          id: 'early',
          label: 'Early',
          description: 'Negative sweep: the loop point moves from the middle back to the very start.',
          parameterMappings: Object.freeze({
            positionAnchor: Object.freeze({ min: 0, max: 0.5 }),
          }),
        },
        positive: {
          id: 'late',
          label: 'Late',
          description: 'Positive sweep: the loop point moves from the middle out to the very end.',
          parameterMappings: Object.freeze({
            positionAnchor: Object.freeze({ min: 0.5, max: 1 }),
          }),
        },
      },
      ['positionAnchor'],
    ),
    module(
      'spray',
      'Grain Spray',
      'Grain spray — how far each grain may land from the read point, from pinpoint focus to wide scatter.',
      {
        negative: {
          id: 'focus',
          label: 'Focus',
          description: 'Negative sweep: spray tightens below the default down to near-pinpoint repetition.',
          parameterMappings: Object.freeze({
            positionSpray: Object.freeze({ min: 0.002, max: 0.04 }),
          }),
        },
        positive: {
          id: 'scatter',
          label: 'Scatter',
          description: 'Positive sweep: grains stray further and further around the read point.',
          parameterMappings: Object.freeze({
            positionSpray: Object.freeze({ min: 0.04, max: 1.2 }),
          }),
        },
      },
      ['positionSpray'],
    ),
    module(
      'grains',
      'Grain Count',
      'Grain count — how many grains sound per second; overlap follows count × size.',
      {
        negative: {
          id: 'sparse',
          label: 'Sparse',
          description: 'Negative sweep: down to a few distinct grains per second.',
          parameterMappings: Object.freeze({
            density: Object.freeze({ min: 2, max: 12 }),
          }),
        },
        positive: {
          id: 'dense',
          label: 'Dense',
          description: 'Positive sweep: up into a thick overlapping cloud.',
          parameterMappings: Object.freeze({
            density: Object.freeze({ min: 12, max: 60 }),
          }),
        },
      },
      ['density'],
    ),
    module(
      'size',
      'Grain Size',
      'Grain size — the length of every grain, from micro clicks to long washes.',
      {
        negative: {
          id: 'micro',
          label: 'Micro',
          description: 'Negative sweep: grains shrink toward tiny clicks.',
          parameterMappings: Object.freeze({
            grainSize: Object.freeze({ min: 0.02, max: 0.12 }),
          }),
        },
        positive: {
          id: 'long',
          label: 'Long',
          description: 'Positive sweep: grains stretch into long overlapping washes.',
          parameterMappings: Object.freeze({
            grainSize: Object.freeze({ min: 0.12, max: 0.5 }),
          }),
        },
      },
      ['grainSize'],
    ),
    module(
      'direction',
      'Grain Direction',
      'Grain direction — from every grain reversed, through forward, to a random shuffle of both.',
      {
        negative: {
          id: 'reverse',
          label: 'Reverse',
          description: 'Negative sweep: more and more grains play their slice backwards, all of them at the extreme.',
          parameterMappings: Object.freeze({
            reverseProbability: Object.freeze({ min: 1, max: 0 }),
          }),
        },
        positive: {
          id: 'shuffle',
          label: 'Shuffle',
          description: 'Positive sweep: a growing random mix of forward and reversed grains.',
          parameterMappings: Object.freeze({
            reverseProbability: Object.freeze({ min: 0, max: 0.5 }),
          }),
        },
      },
      ['reverseProbability'],
    ),
    module(
      'seek',
      'Grain Seek',
      'Grain seek — the read point travels through the track on its own, backwards or rushing ahead.',
      {
        negative: {
          id: 'rewind',
          label: 'Rewind',
          description: 'Negative sweep: the read point slows to a halt, then travels backwards through the track.',
          parameterMappings: Object.freeze({
            seekRate: Object.freeze({ min: -3, max: 0 }),
          }),
        },
        positive: {
          id: 'rush',
          label: 'Rush',
          description: 'Positive sweep: the read point runs ahead, up to three times playback speed.',
          parameterMappings: Object.freeze({
            seekRate: Object.freeze({ min: 0, max: 2 }),
          }),
        },
      },
      ['seekRate'],
    ),
  ]),
});

export default EFFECT_MANIFEST;
