export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.chebyshev',
  label: 'Chebyshev Shaper',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::III',
  dimensionLabel: 'EW::III',
  // Defaults passed to Tone.Chebyshev constructor
  defaults: Object.freeze({
    order: 10,
    wet: 0.5,
    oversample: 'none',
  }),
  // Primary user control for the module
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Mountain Edge',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'soft',
      label: 'Mountain Edge Soft',
      description: 'Softer shaping; rounded harmonic edges.',
      dimension: 'EW::III',
      fixed: Object.freeze({ oversample: 'none' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -40, max: 40, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'chebyshev.soft::bright',
          label: 'Bright',
          description: 'Negative sweep: inverted from high order/wet down to equilibrium.',
          parameterMappings: Object.freeze({
            order: Object.freeze({ min: 50, max: 10 }), // INVERTED: high to mid (equilibrium)
            wet: Object.freeze({ min: 1, max: 0.0 }), // INVERTED: full wet to equilibrium
          }),
        }),
        positive: Object.freeze({
          id: 'chebyshev.soft::clean',
          label: 'Clean',
          description: 'Positive sweep: from equilibrium to dry/low order.',
          parameterMappings: Object.freeze({
            order: Object.freeze({ min: 10, max: 1 }), // MIRROR: mid to low
            wet: Object.freeze({ min: 0., max: 1 }), // MIRROR: equilibrium to dry
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'order',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.4,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 1, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'ridge',
      label: 'Mountain Edge Ridge',
      description: 'Stronger articulation; more pronounced overtones.',
      dimension: 'EW::III',
      fixed: Object.freeze({ oversample: 'none' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'chebyshev.ridge::strong',
          label: 'Strong',
          description: 'Negative sweep: inverted from strong order/wet down to equilibrium.',
          parameterMappings: Object.freeze({
            order: Object.freeze({ min: 75, max: 20 }), // INVERTED: strong to mid (equilibrium)
            wet: Object.freeze({ min: 1, max: 0.0 }), // INVERTED: full wet to equilibrium
          }),
        }),
        positive: Object.freeze({
          id: 'chebyshev.ridge::gentle',
          label: 'Gentle',
          description: 'Positive sweep: from equilibrium to gentle shaping.',
          parameterMappings: Object.freeze({
            order: Object.freeze({ min: 20, max: 3 }), // MIRROR: mid to low
            wet: Object.freeze({ min: 0.0, max: 1 }), // MIRROR: equilibrium to dry
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'order',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.4,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 1, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'peak',
      label: 'Mountain Edge Peak',
      description: 'Aggressive shaping; bright, cutting harmonics.',
      dimension: 'EW::III',
      fixed: Object.freeze({ oversample: 'none' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -60, max: 60, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'chebyshev.peak::extreme',
          label: 'Extreme',
          description: 'Negative sweep: inverted from extreme order/wet down to equilibrium.',
          parameterMappings: Object.freeze({
            order: Object.freeze({ min: 100, max: 30 }), // INVERTED: extreme to mid (equilibrium)
            wet: Object.freeze({ min: 1, max: 0.0 }), // INVERTED: full wet to equilibrium
          }),
        }),
        positive: Object.freeze({
          id: 'chebyshev.peak::subtle',
          label: 'Subtle',
          description: 'Positive sweep: from equilibrium to subtle shaping.',
          parameterMappings: Object.freeze({
            order: Object.freeze({ min: 30, max: 5 }), // MIRROR: mid to low
            wet: Object.freeze({ min: 0., max: 1 }), // MIRROR: equilibrium to dry
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'order',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.4,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 1, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'fracture',
      label: 'Mountain Edge Fracture',
      description: 'Extreme polynomial order; fractured, distorted edges.',
      dimension: 'EW::III',
      fixed: Object.freeze({ oversample: 'none' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -80, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'chebyshev.fracture::chaos',
          label: 'Chaos',
          description: 'Negative sweep: inverted from maximum order/wet down to equilibrium.',
          parameterMappings: Object.freeze({
            order: Object.freeze({ min: 100, max: 40 }), // INVERTED: max to mid (equilibrium)
            wet: Object.freeze({ min: 1, max: 0.0 }), // INVERTED: full wet to equilibrium
          }),
        }),
        positive: Object.freeze({
          id: 'chebyshev.fracture::tame',
          label: 'Tame',
          description: 'Positive sweep: from equilibrium to tame shaping.',
          parameterMappings: Object.freeze({
            order: Object.freeze({ min: 40, max: 10 }), // MIRROR: mid to moderate
            wet: Object.freeze({ min: 0., max: 1 }), // MIRROR: equilibrium to dry
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'order',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.4,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 1, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
