export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.distortion',
  label: 'Distortion',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::III',
  dimensionLabel: 'EW::III',
  // Defaults passed to Tone.Distortion constructor
  defaults: Object.freeze({
    distortion: 0.4,
    wet: 0.5,
    oversample: 'none',
  }),
  // Primary user control for the module
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Magma Drive',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'warm',
      label: 'Magma Drive Warm',
      description: 'Light drive; adds body while keeping clarity.',
      dimension: 'EW::III',
      fixed: Object.freeze({ oversample: 'none' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'distortion.warm::full',
          label: 'Full',
          description: 'Negative sweep: inverted from high distortion/wet down to equilibrium.',
          parameterMappings: Object.freeze({
            distortion: Object.freeze({ min: 0.35, max: 0.15 }), // INVERTED: high to equilibrium
            wet: Object.freeze({ min: 1.0, max: 0.0 }), // INVERTED: full wet to dry
          }),
        }),
        positive: Object.freeze({
          id: 'distortion.warm::subtle',
          label: 'Subtle',
          description: 'Positive sweep: from equilibrium to clean/subtle.',
          parameterMappings: Object.freeze({
            distortion: Object.freeze({ min: 0.15, max: 0.05 }), // MIRROR: equilibrium to low
            wet: Object.freeze({ min: 0.0, max: 1.0 }), // MIRROR: dry to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'distortion',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.1,
          minRamp: 0.01,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0.05, max: 0.35, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'burn',
      label: 'Magma Drive Burn',
      description: 'Mid drive; classic synth/guitar crunch with musical edge.',
      dimension: 'EW::III',
      fixed: Object.freeze({ oversample: 'none' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -60, max: 60, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'distortion.burn::heavy',
          label: 'Heavy',
          description: 'Negative sweep: inverted from heavy distortion down to equilibrium.',
          parameterMappings: Object.freeze({
            distortion: Object.freeze({ min: 0.6, max: 0.35 }), // INVERTED: heavy to equilibrium
            wet: Object.freeze({ min: 1.0, max: 0.0 }), // INVERTED: full wet to dry
          }),
        }),
        positive: Object.freeze({
          id: 'distortion.burn::mild',
          label: 'Mild',
          description: 'Positive sweep: from equilibrium to mild crunch.',
          parameterMappings: Object.freeze({
            distortion: Object.freeze({ min: 0.35, max: 0.2 }), // MIRROR: equilibrium to mild
            wet: Object.freeze({ min: 0.0, max: 1.0 }), // MIRROR: dry to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'distortion',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.1,
          minRamp: 0.01,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0.2, max: 0.6, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'melt',
      label: 'Magma Drive Melt',
      description: 'Heavy drive; compressed, saturated, sticky molten tone.',
      dimension: 'EW::III',
      fixed: Object.freeze({ oversample: 'none' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -70, max: 70, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'distortion.melt::extreme',
          label: 'Extreme',
          description: 'Negative sweep: inverted from extreme saturation down to equilibrium.',
          parameterMappings: Object.freeze({
            distortion: Object.freeze({ min: 0.85, max: 0.55 }), // INVERTED: extreme to equilibrium
            wet: Object.freeze({ min: 1.0, max: 0.0 }), // INVERTED: full wet to dry
          }),
        }),
        positive: Object.freeze({
          id: 'distortion.melt::moderate',
          label: 'Moderate',
          description: 'Positive sweep: from equilibrium to moderate drive.',
          parameterMappings: Object.freeze({
            distortion: Object.freeze({ min: 0.55, max: 0.45 }), // MIRROR: equilibrium to moderate
            wet: Object.freeze({ min: 0.0, max: 1.0 }), // MIRROR: dry to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'distortion',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.1,
          minRamp: 0.01,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0.45, max: 0.85, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'rupture',
      label: 'Magma Drive Rupture',
      description: 'Extreme drive; torn-speaker brutality and noisy texture.',
      dimension: 'EW::III',
      fixed: Object.freeze({ oversample: 'none' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -80, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'distortion.rupture::max',
          label: 'Max',
          description: 'Negative sweep: inverted from maximum destruction down to equilibrium.',
          parameterMappings: Object.freeze({
            distortion: Object.freeze({ min: 1.0, max: 0.75 }), // INVERTED: max to equilibrium
            wet: Object.freeze({ min: 1.0, max: 0.0 }), // INVERTED: full wet to dry
          }),
        }),
        positive: Object.freeze({
          id: 'distortion.rupture::controlled',
          label: 'Controlled',
          description: 'Positive sweep: from equilibrium to controlled heavy.',
          parameterMappings: Object.freeze({
            distortion: Object.freeze({ min: 0.75, max: 0.7 }), // MIRROR: equilibrium to heavy
            wet: Object.freeze({ min: 0.0, max: 1.0 }), // MIRROR: dry to full wet
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'distortion',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.1,
          minRamp: 0.01,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0.7, max: 1.0, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
