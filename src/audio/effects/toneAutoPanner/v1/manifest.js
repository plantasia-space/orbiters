export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.autopanner',
  label: 'Auto Panner',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::I',
  dimensionLabel: 'EW::I',
  // Defaults passed to Tone.AutoPanner constructor
  defaults: Object.freeze({
    type: 'sine',
    depth: 0.5,
    frequency: 1.0,
    wet: 0.5,
    spread: 180,
  }),
  // Primary user control for the module
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Gravity Pan',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'sine',
      label: 'Gravity Pan Sine',
      description: 'Smooth left-right orbit with sine wave.',
      dimension: 'EW::I',
      fixed: Object.freeze({ type: 'sine', start: true, spread: 180 }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'autopanner.sine::subtle',
          label: 'Subtle',
          description: 'Negative sweep: gentle pan, dry focus.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0.8, max: 0.0 }),
            frequency: Object.freeze({ min: 21., max: .0 }),
            wet: Object.freeze({ min: 1., max: 1. }),
          }),
        }),
        positive: Object.freeze({
          id: 'autopanner.sine::wide',
          label: 'Wide',
          description: 'Positive sweep: full stereo orbit.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0., max: 1. }),
            frequency: Object.freeze({ min: 0, max: 16 }),
            wet: Object.freeze({ min: 1., max: 1. }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'depth',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
        secondaryParameters: Object.freeze(['frequency', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'triangle',
      label: 'Gravity Pan Triangle',
      description: 'Linear sweep with constant speed.',
      dimension: 'EW::I',
      fixed: Object.freeze({ type: 'triangle', start: true, spread: 180 }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'autopanner.triangle::tight',
          label: 'Tight',
          description: 'Negative sweep: controlled linear pan.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 1.0, max: 0. }),
            frequency: Object.freeze({ min: 0.1, max: 120. }),
            wet: Object.freeze({ min: 1, max: 1. }),
          }),
        }),
        positive: Object.freeze({
          id: 'autopanner.triangle::sweep',
          label: 'Sweep',
          description: 'Positive sweep: fast linear motion.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0., max: 1. }),
            frequency: Object.freeze({ min: 2, max: 16 }),
            wet: Object.freeze({ min: 1., max: 1. }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'depth',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
        secondaryParameters: Object.freeze(['frequency', 'wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
