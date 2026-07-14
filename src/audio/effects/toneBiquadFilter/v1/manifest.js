export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.biquadFilter',
  label: 'Biquad Filter',
  version: '1.1.1',
  inputParam: 'inputParam',
  dimensionId: '*',
  dimensionLabel: null,
  // Optionally, provide per-dimension labels in the future:
  // dimensionLabels: Object.freeze({ 'EW::I': 'EW::I', 'EW::II': 'EW::II', 'EW::III': 'EW::III' }),
  defaults: Object.freeze({
    type: 'lowpass',
    frequency: 350,
    Q: 1,
    gain: 0,
  }),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Frequency',
    units: 'Hz',
    range: Object.freeze({ min: 20, max: 20000 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'lowpass',
      label: 'Biquad Lowpass',
      description: 'Cutoff frequency (Hz)',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'lowpass' }),
      valueRange: Object.freeze({ min: 20, max: 20000, units: 'Hz' }),
      initialRange: Object.freeze({ min: 20, max: 8000, equilibrium: 20000 }),
      parameterMappings: Object.freeze({
        frequency: Object.freeze({ min: 20, max: 20000 }),
      }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'tone.biquad.lowpass::negative',
          label: 'Cutoff Sweep',
          description: '0->0.5 closes the lowpass toward sub frequencies.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 20, max: 20000 }),
          }),
        }),
        positive: Object.freeze({
          id: 'tone.biquad.lowpass::positive',
          label: 'Bypass Hold',
          description: '0.5->1 keeps the filter fully open around 20 kHz.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 20000, max: 20000 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.18,
          minRamp: 0.005,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 20, max: 20000, transform: 'log' }),
      }),
    }),
    Object.freeze({
      id: 'highpass',
      label: 'Biquad Highpass',
      description: 'Cutoff frequency (Hz)',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'highpass' }),
      valueRange: Object.freeze({ min: 20, max: 20000, units: 'Hz' }),
      initialRange: Object.freeze({ min: 18000, max: 18000, equilibrium: 20 }),
      parameterMappings: Object.freeze({
        frequency: Object.freeze({ min: 20, max: 20000 }),
      }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'tone.biquad.highpass::negative',
          label: 'Bypass Hold',
          description: '0->0.5 keeps the highpass near 20 Hz (neutral).',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 20, max: 20 }),
          }),
        }),
        positive: Object.freeze({
          id: 'tone.biquad.highpass::positive',
          label: 'Cutoff Sweep',
          description: '0.5->1 raises the cutoff toward 20 kHz for aggressive thinning.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 20, max: 20000 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.18,
          minRamp: 0.005,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 20, max: 20000, transform: 'linear' }),
      }),
    }),
    Object.freeze({
      id: 'bandpass',
      label: 'Biquad Bandpass',
      description: 'Center frequency (Hz)',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'bandpass' }),
      valueRange: Object.freeze({ min: 20, max: 20000, units: 'Hz' }),
      initialRange: Object.freeze({ min: 300, max: 10000, equilibrium: 800 }),
      parameterMappings: Object.freeze({
        frequency: Object.freeze({ min: 20, max: 20000 }),
      }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'tone.biquad.bandpass::negative',
          label: 'Wide Glide',
          description: '0->0.5 emphasises the lower mids and broader bandwidth.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 20, max: 800 }),
          }),
        }),
        positive: Object.freeze({
          id: 'tone.biquad.bandpass::positive',
          label: 'Focused Peak',
          description: '0.5->1 moves the center toward the upper spectrum.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 800, max: 20000 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.18,
          minRamp: 0.005,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 20, max: 20000, transform: 'log' }),
      }),
    }),
    Object.freeze({
      id: 'wideband',
      label: 'Wideband Filter',
      description: 'Dual lowpass + highpass; full spectrum at equilibrium',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'lowpass' }),
      valueRange: Object.freeze({ min: 20, max: 20000, units: 'Hz' }),
      initialRange: Object.freeze({ min: 200, max: 18000, equilibrium: 4000 }),
      parameterMappings: Object.freeze({
        frequency: Object.freeze({ min: 200, max: 20000 }),
      }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'tone.biquad.wideband::negative',
          label: 'Contour Tuck',
          description: '0->0.5 narrows the spectrum toward the mids.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 200, max: 4000 }),
          }),
        }),
        positive: Object.freeze({
          id: 'tone.biquad.wideband::positive',
          label: 'Air Bloom',
          description: '0.5->1 opens the lowpass toward full bandwidth.',
          parameterMappings: Object.freeze({
            frequency: Object.freeze({ min: 4000, max: 20000 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'audio-param',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.25,
          minRamp: 0.01,
          maxRamp: 1.0,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 20, max: 20000, transform: 'log' }),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
