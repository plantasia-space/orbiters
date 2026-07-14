export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.eq3',
  label: 'EQ3',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: Object.freeze(['EW::I', 'EW::II']),
  dimensionLabel: null,
  defaults: Object.freeze({
    type: 'lowshelf',
    frequency: 120,
    Q: 0.707,
    gain: 0,
  }),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Band Gain',
    units: 'dB',
    range: Object.freeze({ min: -12, max: 12 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'low',
      label: 'Spectrum Low',
      description: 'Low band gain (dB)',
      dimension: 'EW::II',
      target: 'gain',
      fixed: Object.freeze({
        type: 'lowshelf',
        frequency: 120,
      }),
      valueRange: Object.freeze({ min: -12, max: 12, units: 'dB' }),
      initialRange: Object.freeze({ min: -10, max: 10, equilibrium: 0 }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'gain',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.04,
          minRamp: 0.004,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -12, max: 12, transform: 'linear' }),
      }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'eq3-low::cut',
          label: 'Low Cut',
          description: '0→0.5 attenuates the low band down to -12 dB.',
        }),
        positive: Object.freeze({
          id: 'eq3-low::boost',
          label: 'Low Boost',
          description: '0.5→1 boosts the low band up to +12 dB.',
        }),
      }),
    }),
    Object.freeze({
      id: 'mid',
      label: 'Spectrum Mid',
      description: 'Mid band gain (dB)',
      dimension: 'EW::II',
      target: 'gain',
      fixed: Object.freeze({
        type: 'peaking',
        frequency: 750,
        Q: 0.7,
      }),
      valueRange: Object.freeze({ min: -12, max: 12, units: 'dB' }),
      initialRange: Object.freeze({ min: -8, max: 8, equilibrium: 0 }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'gain',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.04,
          minRamp: 0.004,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -12, max: 12, transform: 'linear' }),
      }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'eq3-mid::cut',
          label: 'Mid Cut',
          description: '0→0.5 attenuates the mid band down to -12 dB.',
        }),
        positive: Object.freeze({
          id: 'eq3-mid::boost',
          label: 'Mid Boost',
          description: '0.5→1 boosts the mid band up to +12 dB.',
        }),
      }),
    }),
    Object.freeze({
      id: 'high',
      label: 'Spectrum High',
      description: 'High band gain (dB)',
      dimension: 'EW::II',
      target: 'gain',
      fixed: Object.freeze({
        type: 'highshelf',
        frequency: 3500,
      }),
      valueRange: Object.freeze({ min: -12, max: 12, units: 'dB' }),
      initialRange: Object.freeze({ min: -10, max: 10, equilibrium: 0 }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'gain',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.04,
          minRamp: 0.004,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -12, max: 12, transform: 'linear' }),
      }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'eq3-high::cut',
          label: 'High Cut',
          description: '0→0.5 attenuates the high band down to -12 dB.',
        }),
        positive: Object.freeze({
          id: 'eq3-high::boost',
          label: 'High Boost',
          description: '0.5→1 boosts the high band up to +12 dB.',
        }),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
