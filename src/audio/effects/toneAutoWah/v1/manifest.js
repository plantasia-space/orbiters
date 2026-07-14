export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.autowah',
  label: 'Auto Wah',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::II',
  dimensionLabel: 'EW::II',
  // Defaults passed to Tone.AutoWah constructor
  defaults: Object.freeze({
    baseFrequency: 120,
    octaves: 3,
    sensitivity: -20,
    wet: 0.5,
    Q: 6,
  }),
  // Primary user control for the module
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Nectar Wah',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'soft',
      label: 'Nectar Wah Soft',
      description: 'Smooth, mellow wah with gentle response.',
      dimension: 'EW::II',
      fixed: Object.freeze({ Q: 6 }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -40, max: 40, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'autowah.soft::dry',
          label: 'Dry',
          description: 'Negative sweep: inverted wah, starting high and sweeping down to equilibrium.',
          parameterMappings: Object.freeze({
            sensitivity: Object.freeze({ min: -40, max: -20 }), // INVERTED: 0 down to -20 (equilibrium)
            baseFrequency: Object.freeze({ min: 800, max: 200 }), // INVERTED: high down to mid (equilibrium)
            octaves: Object.freeze({ min: 6, max: 3 }), // INVERTED: wide down to mid (equilibrium)
            wet: Object.freeze({ min: 1, max: 0.0 }), // INVERTED: full wet down to half (equilibrium)
          }),
        }),
        positive: Object.freeze({
          id: 'autowah.soft::bloom',
          label: 'Bloom',
          description: 'Positive sweep: from equilibrium expanding outward.',
          parameterMappings: Object.freeze({
            sensitivity: Object.freeze({ min: -20, max: -40 }), // MIRROR: starts at -20 (equilibrium), goes to -40
            baseFrequency: Object.freeze({ min: 200, max: 40 }), // MIRROR: starts at 200 (equilibrium), goes lower
            octaves: Object.freeze({ min: 3, max: 1 }), // MIRROR: starts at 3 (equilibrium), narrows
            wet: Object.freeze({ min: 0.0, max: 1. }), // MIRROR: starts at 0.5 (equilibrium), goes dry
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'sensitivity',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -40, max: 0, transform: 'linear' }),
        secondaryParameters: Object.freeze(['baseFrequency', 'octaves', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'wide',
      label: 'Nectar Wah Wide',
      description: 'Wide octave sweep with aggressive response.',
      dimension: 'EW::II',
      fixed: Object.freeze({ Q: 6 }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'autowah.wide::tight',
          label: 'Tight',
          description: 'Negative sweep: inverted, starting aggressive and moving to equilibrium.',
          parameterMappings: Object.freeze({
            sensitivity: Object.freeze({ min: -40, max: -30 }), // INVERTED: 0 down to -20 (equilibrium)
            baseFrequency: Object.freeze({ min: 800, max: 100 }), // INVERTED: high down to mid (equilibrium)
            octaves: Object.freeze({ min: 3, max: 1 }), // INVERTED: wide down to mid (equilibrium)
            wet: Object.freeze({ min: 1., max: 0. }), // INVERTED: full wet down to equilibrium
          }),
        }),
        positive: Object.freeze({
          id: 'autowah.wide::open',
          label: 'Open',
          description: 'Positive sweep: from equilibrium to wide octave sweep.',
          parameterMappings: Object.freeze({
            sensitivity: Object.freeze({ min: -30, max: -40 }), // MIRROR: starts at -20 (equilibrium), goes deeper
            baseFrequency: Object.freeze({ min: 100, max: 1600 }), // MIRROR: starts at 300 (equilibrium), goes lower
            octaves: Object.freeze({ min: 3, max: 1 }), // MIRROR: starts at 3 (equilibrium), narrows
            wet: Object.freeze({ min: 0, max: 1. }), // MIRROR: starts at 0.4 (equilibrium), goes dry
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'sensitivity',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -40, max: 0, transform: 'linear' }),
        secondaryParameters: Object.freeze(['baseFrequency', 'octaves', 'wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;