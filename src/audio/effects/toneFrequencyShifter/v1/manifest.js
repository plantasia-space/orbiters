export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.frequencyshifter',
  label: 'Frequency Shifter',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::I',
  dimensionLabel: 'EW::I',
  // Defaults passed to Tone.FrequencyShifter constructor
  defaults: Object.freeze({
    frequency: 0,
    wet: 0.5,
  }),
  // Primary user control for the module
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Quantum',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'shift',
      label: 'Quantum Shift',
      description: 'Bidirectional frequency shift with mirror equilibrium.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -60, max: 60, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'frequencyshifter.shift::up',
          label: 'Up',
          description: 'Negative sweep: inverted from high upshift down to equilibrium.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 2000, max: 0 }), // INVERTED: high up to center (equilibrium)
            wet: Object.freeze({ min: 1., max: 0.0 }), // INVERTED: full wet to half (equilibrium)
          }),
        }),
        positive: Object.freeze({
          id: 'frequencyshifter.shift::down',
          label: 'Down',
          description: 'Positive sweep: from equilibrium to downshift.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 0, max: -2000 }), // MIRROR: center to down
            wet: Object.freeze({ min: 0.0, max: 1. }), // MIRROR: half to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -2000, max: 2000, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'up',
      label: 'Quantum Up',
      description: 'Shifts everything upward; alien brightness.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'frequencyshifter.up::bright',
          label: 'Bright',
          description: 'Negative sweep: inverted from high upshift down to equilibrium.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 2000, max: 0 }), // INVERTED: high up to center (equilibrium)
            wet: Object.freeze({ min: 1., max: 0.0 }), // INVERTED: full wet to half (equilibrium)
          }),
        }),
        positive: Object.freeze({
          id: 'frequencyshifter.up::neutral',
          label: 'Neutral',
          description: 'Positive sweep: from equilibrium to slight downshift.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 0, max: -500 }), // MIRROR: center to slight down
            wet: Object.freeze({ min: 0.0, max: 1. }), // MIRROR: half to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -500, max: 2000, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'down',
      label: 'Quantum Down',
      description: 'Shifts everything downward; metallic, dark ring-mod tone.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -60, max: 60, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'frequencyshifter.down::slight',
          label: 'Slight',
          description: 'Negative sweep: inverted from slight upshift down to equilibrium.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 500, max: 0 }), // INVERTED: slight up to center (equilibrium)
            wet: Object.freeze({ min: 1., max: 0.0 }), // INVERTED: full wet to half (equilibrium)
          }),
        }),
        positive: Object.freeze({
          id: 'frequencyshifter.down::deep',
          label: 'Deep',
          description: 'Positive sweep: from equilibrium to deep downshift.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 0, max: -2000 }), // MIRROR: center to deep down
            wet: Object.freeze({ min: 0.0, max: 1. }), // MIRROR: half to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -2000, max: 500, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'subtle',
      label: 'Quantum Subtle',
      description: 'Subtle frequency shift for stereo weirdness.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -40, max: 40, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'frequencyshifter.subtle::upward',
          label: 'Upward',
          description: 'Negative sweep: inverted from subtle upshift down to equilibrium.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 500, max: 0 }), // INVERTED: subtle up to center (equilibrium)
            wet: Object.freeze({ min: 1., max: 0.0 }), // INVERTED: full wet to half (equilibrium)
          }),
        }),
        positive: Object.freeze({
          id: 'frequencyshifter.subtle::downward',
          label: 'Downward',
          description: 'Positive sweep: from equilibrium to subtle downshift.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 0, max: -500 }), // MIRROR: center to subtle down
            wet: Object.freeze({ min: 0.0, max: 1. }), // MIRROR: half to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -500, max: 500, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'melt',
      label: 'Quantum Melt',
      description: 'Extreme shift; harmonic structure collapses, broken-radio feeling.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -80, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'frequencyshifter.melt::extreme-up',
          label: 'Extreme Up',
          description: 'Negative sweep: inverted from extreme upshift down to equilibrium.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 2000, max: 0 }), // INVERTED: extreme up to center (equilibrium)
            wet: Object.freeze({ min: 1., max: 0.0 }), // INVERTED: full wet to half (equilibrium)
          }),
        }),
        positive: Object.freeze({
          id: 'frequencyshifter.melt::extreme-down',
          label: 'Extreme Down',
          description: 'Positive sweep: from equilibrium to extreme downshift.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 0, max: -2000 }), // MIRROR: center to extreme down
            wet: Object.freeze({ min: 0.0, max: 1. }), // MIRROR: half to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -2000, max: 2000, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
