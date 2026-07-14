export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.panner',
  label: 'Panner',
  version: '1.0.0',
  inputParam: 'inputParam',
  dimensionId: 'EW::I',
  dimensionLabel: 'EW::I',
  defaults: Object.freeze({
    pan: 0,
  }),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Pan',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'linear',
      label: 'Linear Pan',
      description: 'Classic straight-line pan response.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -100, max: 100, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'panner.linear::left',
          label: 'Pan Left',
          description: 'Negative sweep: linear gain toward the left speaker.',
          parameterMappings: Object.freeze({
            pan: Object.freeze({ min: -1, max: 0, transform: 'linear' }),
          }),
        }),
        positive: Object.freeze({
          id: 'panner.linear::right',
          label: 'Pan Right',
          description: 'Positive sweep: linear gain toward the right speaker.',
          parameterMappings: Object.freeze({
            pan: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'pan',
        provider: 'channel-strip',
        smoothing: Object.freeze({
          defaultRamp: 0.05,
          minRamp: 0.005,
          maxRamp: 0.3,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -1, max: 1, transform: 'linear' }),
      }),
    }),
    Object.freeze({
      id: 'logarithmic',
      label: 'Logarithmic Pan',
      description: 'Faster perceived motion near center, smoother toward the edges.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -100, max: 100, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'panner.log::left',
          label: 'Pan Left (Log)',
          description: 'Negative sweep emphasizes movement near the center before gliding outward.',
          parameterMappings: Object.freeze({
            pan: Object.freeze({ min: -1, max: 0, transform: 'easeOut' }),
          }),
        }),
        positive: Object.freeze({
          id: 'panner.log::right',
          label: 'Pan Right (Log)',
          description: 'Positive sweep: dramatic motion near center, gentle near the extremes.',
          parameterMappings: Object.freeze({
            pan: Object.freeze({ min: 0, max: 1, transform: 'easeOut' }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'pan',
        provider: 'channel-strip',
        smoothing: Object.freeze({
          defaultRamp: 0.05,
          minRamp: 0.005,
          maxRamp: 0.3,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -1, max: 1, transform: 'linear' }),
      }),
    }),
    Object.freeze({
      id: 'inverse',
      label: 'Inverse Log Pan',
      description: 'Gentle shifts near center, accelerated motion near extremes.',
      dimension: 'EW::I',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -100, max: 100, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'panner.inverse::left',
          label: 'Pan Left (Inverse)',
          description: 'Negative sweep: subtle center moves with strong pushes toward hard-left.',
          parameterMappings: Object.freeze({
            pan: Object.freeze({ min: -1, max: 0, transform: 'easeIn' }),
          }),
        }),
        positive: Object.freeze({
          id: 'panner.inverse::right',
          label: 'Pan Right (Inverse)',
          description: 'Positive sweep: fine control near center, aggressive beyond mid-throw.',
          parameterMappings: Object.freeze({
            pan: Object.freeze({ min: 0, max: 1, transform: 'easeIn' }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'pan',
        provider: 'channel-strip',
        smoothing: Object.freeze({
          defaultRamp: 0.05,
          minRamp: 0.005,
          maxRamp: 0.3,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -1, max: 1, transform: 'linear' }),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
