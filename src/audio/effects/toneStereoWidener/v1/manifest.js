export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.stereowidener',
  label: 'Stereo Widener',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::I',
  dimensionLabel: 'EW::I',
  defaults: Object.freeze({
    width: 0.5, // neutral
    wet: 0.5,
  }),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Aurora',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'narrow',
      label: 'Aurora Narrow',
      description: 'Centered, radio-focused, mono-compatible feel.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      target: 'width',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -20, max: 0, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          label: 'Focused',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'width',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.1,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 0.5, transform: 'easeOut' }),
          }),
          parameterMappings: Object.freeze({
            width: { min: 0.25, max: 0 },
            wet: { min: 1.0, max: 0.0 },
          }),
        }),
        positive: Object.freeze({
          label: 'Mono',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'width',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.1,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 0.5, transform: 'easeOut' }),
          }),
          parameterMappings: Object.freeze({
            width: { min: 0, max: 0.15 },
            wet: { min: 0.0, max: 1.0 },
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'width',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.1,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 100, transform: 'easeOut' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'landscape',
      label: 'Aurora Landscape',
      description: 'Honest stereo, light air, safe gain staging.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      target: 'width',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -60, max: 60, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          label: 'Centered',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'width',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.1,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 0.7, transform: 'linear' }),
          }),
          parameterMappings: Object.freeze({
            width: { min: 0.7, max: 0.3 },
            wet: { min: 1.0, max: 0.0 },
          }),
        }),
        positive: Object.freeze({
          label: 'Balanced',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'width',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.1,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0.3, max: 0.7, transform: 'linear' }),
          }),
          parameterMappings: Object.freeze({
            width: { min: 0.3, max: 0.7 },
            wet: { min: 0.0, max: 1.0 },
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'width',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.1,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'wide',
      label: 'Aurora Wide',
      description: 'Cinematic spread; big but still safe.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      target: 'width',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -40, max: 85, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          label: 'Natural',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'width',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.1,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 0.9, transform: 'log' }),
          }),
          parameterMappings: Object.freeze({
            width: { min: 0.9, max: 0.5 },
            wet: { min: 1.0, max: 0.0 },
          }),
        }),
        positive: Object.freeze({
          label: 'Expansive',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'width',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.1,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0.5, max: 0.9, transform: 'log' }),
          }),
          parameterMappings: Object.freeze({
            width: { min: 0.5, max: 0.9 },
            wet: { min: 0.0, max: 1.0 },
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'width',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.1,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 100, transform: 'log' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'void',
      label: 'Aurora Void',
      description: 'Extreme super-stereo; holographic edges, phasey.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      target: 'width',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -20, max: 100, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          label: 'Spacious',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'width',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.1,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 1.0, transform: 'exp' }),
          }),
          parameterMappings: Object.freeze({
            width: { min: 1.0, max: 0.1 },
            wet: { min: 1.0, max: 0.0 },
          }),
        }),
        positive: Object.freeze({
          label: 'Holographic',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'width',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.1,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0.7, max: 1.0, transform: 'exp' }),
          }),
          parameterMappings: Object.freeze({
            width: { min: 0.1, max: 0.8 },
            wet: { min: 0.0, max: 0.9 },
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'width',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.1,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 100, transform: 'exp' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
