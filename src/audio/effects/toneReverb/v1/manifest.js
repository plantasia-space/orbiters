export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.reverb',
  label: 'Reverb',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::III',
  dimensionLabel: 'EW::III',
  defaults: Object.freeze({
    decay: 1.5,
    preDelay: 0.01,
    wet: 0.5,
  }),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Dry/Wet',
    units: '%',
    range: Object.freeze({ min: 0, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'small',
      label: 'Nebula Small',
      description: 'Compact nebula chamber with a dry-biased negative sweep and lush bloom on the positive side.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: 50, max: 100, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'small::dry-focus',
          label: 'Dry Focus',
          description: '0 → 0.5 normalized: effectively bypass, tight reflections only.',
          parameterMappings: Object.freeze({
            wet: { min: 0, max: 0.25 },
            decay: { min: 0.2, max: 0.45 },
            preDelay: { min: 0, max: 0.004 },
          }),
          control: Object.freeze({
            audioParam: 'wet',
            signalRange: Object.freeze({ min: 0, max: 0.5, transform: 'linear' }),
            secondaryParameters: Object.freeze(['decay', 'preDelay']),
          }),
        }),
        positive: Object.freeze({
          id: 'small::space-bloom',
          label: 'Space Bloom',
          description: '0.5 → 1 normalized: open up the chamber with longer tails and pre-delay.',
          parameterMappings: Object.freeze({
            wet: { min: 0.25, max: 1 },
            decay: { min: 0.45, max: 0.8 },
            preDelay: { min: 0.004, max: 0.01 },
          }),
          control: Object.freeze({
            audioParam: 'wet',
            signalRange: Object.freeze({ min: 0.5, max: 1, transform: 'linear' }),
            secondaryParameters: Object.freeze(['decay', 'preDelay']),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'wet',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 1,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
        secondaryParameters: Object.freeze(['decay', 'preDelay']),
      }),
    }),
    Object.freeze({
      id: 'mid',
      label: 'Nebula Mid',
      description: 'Medium nebula with clear separation between dry sculpting and lush wash.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: 20, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'mid::dry-shape',
          label: 'Dry Shape',
          description: '0 → 0.5 normalized: focus on articulation before the bloom.',
          parameterMappings: Object.freeze({
            wet: { min: 0, max: 0.3 },
            decay: { min: 2.0, max: 3.0 },
            preDelay: { min: 0.015, max: 0.025 },
          }),
          control: Object.freeze({
            audioParam: 'wet',
            signalRange: Object.freeze({ min: 0, max: 0.5, transform: 'linear' }),
            secondaryParameters: Object.freeze(['decay', 'preDelay']),
          }),
        }),
        positive: Object.freeze({
          id: 'mid::halo',
          label: 'Halo Bloom',
          description: '0.5 → 1 normalized: progressively wetter, longer tails.',
          parameterMappings: Object.freeze({
            wet: { min: 0.3, max: 1 },
            decay: { min: 3.0, max: 4.5 },
            preDelay: { min: 0.025, max: 0.04 },
          }),
          control: Object.freeze({
            audioParam: 'wet',
            signalRange: Object.freeze({ min: 0.5, max: 1, transform: 'linear' }),
            secondaryParameters: Object.freeze(['decay', 'preDelay']),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'wet',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 1,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
        secondaryParameters: Object.freeze(['decay', 'preDelay']),
      }),
    }),
    Object.freeze({
      id: 'large',
      label: 'Nebula Large',
      description: 'Expansive nebula cathedral with discrete dry/space responses.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: 30, max: 90, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'large::dry-hold',
          label: 'Dry Hold',
          description: '0 → 0.5 normalized: hold back the wash, subtle ambience.',
          parameterMappings: Object.freeze({
            wet: { min: 0, max: 0.4 },
            decay: { min: 3.5, max: 5.2 },
            preDelay: { min: 0.06, max: 0.09 },
          }),
          control: Object.freeze({
            audioParam: 'wet',
            signalRange: Object.freeze({ min: 0, max: 0.5, transform: 'linear' }),
            secondaryParameters: Object.freeze(['decay', 'preDelay']),
          }),
        }),
        positive: Object.freeze({
          id: 'large::infinite',
          label: 'Infinite Bloom',
          description: '0.5 → 1 normalized: immersive tails and long pre-delay.',
          parameterMappings: Object.freeze({
            wet: { min: 0.4, max: 1 },
            decay: { min: 5.2, max: 7.0 },
            preDelay: { min: 0.09, max: 0.12 },
          }),
          control: Object.freeze({
            audioParam: 'wet',
            signalRange: Object.freeze({ min: 0.5, max: 1, transform: 'linear' }),
            secondaryParameters: Object.freeze(['decay', 'preDelay']),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'wet',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 1,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
        secondaryParameters: Object.freeze(['decay', 'preDelay']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
