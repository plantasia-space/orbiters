export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.phaser',
  label: 'Phaser',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::II',
  dimensionLabel: 'EW::II',
  // Defaults passed to Tone.Phaser constructor
  defaults: Object.freeze({
    frequency: 0.5,
    baseFrequency: 500,
    octaves: 3,
    Q: 2,
    wet: 0.5,
  }),
  // Primary user control for the module
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Orbit',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'slow',
      label: 'Orbit Slow',
      description: 'Deep, slow cosmic swirl.',
      dimension: 'EW::II',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -40, max: 40, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'phaser.slow::deep',
          label: 'Deep',
          description: 'Negative sweep: inverted from deep phasing down to equilibrium.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 4, max: 1 }), // INVERTED: fast to equilibrium
            baseFrequency: Object.freeze({ min: 2000, max: 500 }), // INVERTED: high to equilibrium
            octaves: Object.freeze({ min: 4, max: 2 }), // INVERTED: wide to equilibrium
            Q: Object.freeze({ min: 8, max: 2 }), // INVERTED: sharp to equilibrium
            wet: Object.freeze({ min: 1.0, max: 0.0 }), // INVERTED: full wet to dry
          }),
        }),
        positive: Object.freeze({
          id: 'phaser.slow::subtle',
          label: 'Subtle',
          description: 'Positive sweep: from equilibrium to subtle phase.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 1, max: 0.1 }), // MIRROR: equilibrium to slow
            baseFrequency: Object.freeze({ min: 500, max: 100 }), // MIRROR: equilibrium to low
            octaves: Object.freeze({ min: 2, max: 1 }), // MIRROR: equilibrium to narrow
            Q: Object.freeze({ min: 2, max: 0.5 }), // MIRROR: equilibrium to soft
            wet: Object.freeze({ min: 0.0, max: 1.0 }), // MIRROR: dry to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0.1, max: 4, transform: 'linear' }),
        secondaryParameters: Object.freeze(['baseFrequency', 'octaves', 'Q', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'fast',
      label: 'Orbit Fast',
      description: 'Nervous resonant phaser, almost vocal.',
      dimension: 'EW::II',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -60, max: 60, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'phaser.fast::rapid',
          label: 'Rapid',
          description: 'Negative sweep: inverted from rapid phasing down to equilibrium.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 16, max: 4 }), // INVERTED: very fast to equilibrium
            baseFrequency: Object.freeze({ min: 3000, max: 1000 }), // INVERTED: very high to equilibrium
            octaves: Object.freeze({ min: 5, max: 3 }), // INVERTED: very wide to equilibrium
            Q: Object.freeze({ min: 12, max: 4 }), // INVERTED: very sharp to equilibrium
            wet: Object.freeze({ min: 1.0, max: 0.0 }), // INVERTED: full wet to dry
          }),
        }),
        positive: Object.freeze({
          id: 'phaser.fast::moderate',
          label: 'Moderate',
          description: 'Positive sweep: from equilibrium to moderate phase.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 4, max: 2 }), // MIRROR: equilibrium to moderate
            baseFrequency: Object.freeze({ min: 1000, max: 200 }), // MIRROR: equilibrium to low
            octaves: Object.freeze({ min: 3, max: 2 }), // MIRROR: equilibrium to moderate
            Q: Object.freeze({ min: 4, max: 1 }), // MIRROR: equilibrium to soft
            wet: Object.freeze({ min: 0.0, max: 1.0 }), // MIRROR: dry to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 2, max: 16, transform: 'linear' }),
        secondaryParameters: Object.freeze(['baseFrequency', 'octaves', 'Q', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'wide',
      label: 'Orbit Wide',
      description: 'Big octave span, dramatic motion.',
      dimension: 'EW::II',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -70, max: 70, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'phaser.wide::dramatic',
          label: 'Dramatic',
          description: 'Negative sweep: inverted from dramatic sweep down to equilibrium.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 8, max: 2 }), // INVERTED: fast to equilibrium
            baseFrequency: Object.freeze({ min: 2500, max: 800 }), // INVERTED: high to equilibrium
            octaves: Object.freeze({ min: 6, max: 4 }), // INVERTED: very wide to equilibrium
            Q: Object.freeze({ min: 10, max: 3 }), // INVERTED: sharp to equilibrium
            wet: Object.freeze({ min: 1.0, max: 0.0 }), // INVERTED: full wet to dry
          }),
        }),
        positive: Object.freeze({
          id: 'phaser.wide::narrow',
          label: 'Narrow',
          description: 'Positive sweep: from equilibrium to narrow sweep.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 2, max: 0.5 }), // MIRROR: equilibrium to slow
            baseFrequency: Object.freeze({ min: 800, max: 150 }), // MIRROR: equilibrium to low
            octaves: Object.freeze({ min: 4, max: 3 }), // MIRROR: equilibrium to narrow
            Q: Object.freeze({ min: 3, max: 0.8 }), // MIRROR: equilibrium to soft
            wet: Object.freeze({ min: 0.0, max: 1.0 }), // MIRROR: dry to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'octaves',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 3, max: 6, transform: 'linear' }),
        secondaryParameters: Object.freeze(['frequency', 'baseFrequency', 'Q', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'edge',
      label: 'Orbit Edge',
      description: 'Higher Q, sharper notch sweep, more "laser" feeling.',
      dimension: 'EW::II',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -80, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'phaser.edge::laser',
          label: 'Laser',
          description: 'Negative sweep: inverted from laser-sharp down to equilibrium.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 10, max: 3 }), // INVERTED: very fast to equilibrium
            baseFrequency: Object.freeze({ min: 4000, max: 1500 }), // INVERTED: very high to equilibrium
            octaves: Object.freeze({ min: 6, max: 4 }), // INVERTED: very wide to equilibrium
            Q: Object.freeze({ min: 20, max: 8 }), // INVERTED: very sharp to equilibrium
            wet: Object.freeze({ min: 1.0, max: 0.0 }), // INVERTED: full wet to dry
          }),
        }),
        positive: Object.freeze({
          id: 'phaser.edge::gentle',
          label: 'Gentle',
          description: 'Positive sweep: from equilibrium to gentle phase.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 3, max: 0.8 }), // MIRROR: equilibrium to slow
            baseFrequency: Object.freeze({ min: 1500, max: 300 }), // MIRROR: equilibrium to low
            octaves: Object.freeze({ min: 4, max: 2 }), // MIRROR: equilibrium to narrow
            Q: Object.freeze({ min: 8, max: 4 }), // MIRROR: equilibrium to moderate
            wet: Object.freeze({ min: 0.0, max: 1.0 }), // MIRROR: dry to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'Q',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 4, max: 20, transform: 'linear' }),
        secondaryParameters: Object.freeze(['frequency', 'baseFrequency', 'octaves', 'wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
