export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.autofilter',
  label: 'Auto Filter',
  version: '1.1.1',
  inputParam: 'inputParam',
  dimensionId: Object.freeze(['EW::I', 'EW::II']),
  dimensionLabel: null,
  // Defaults passed to Tone.AutoFilter constructor
  defaults: Object.freeze({
    type: 'sine',
    baseFrequency: 200,
    depth: 0.5,
    frequency: 1.2,
    octaves: 2,
    wet: 0.5,
  }),
  // Primary user control for the module
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Oscillate',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  // Each module picks an LFO waveform type; the primary control targets baseFrequency
  modules: Object.freeze([
    Object.freeze({
      id: 'sine',
      label: 'Oscillate Sine',
      description: 'Auto-filter with sine LFO.',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'sine' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'autofilter.sine::submerge',
          label: 'Submerge',
          description: 'Negative sweep: wide, swampy low sweeps.',
          parameterMappings: Object.freeze({
            baseFrequency: Object.freeze({ min: 60, max: 350, transform: 'linear' }),
            depth: Object.freeze({ min: 0.9, max: 0 }),
            wet: Object.freeze({ min: 0.85, max: 0 }),
            frequency: Object.freeze({ min: 0.15, max: 1.5, transform: 'linear' }),
          }),
        }),
        positive: Object.freeze({
          id: 'autofilter.sine::motion',
          label: 'Motion',
          description: 'Positive sweep: airy, bright shimmer.',
          parameterMappings: Object.freeze({
            baseFrequency: Object.freeze({ min: 350, max: 4000, transform: 'linear' }),
            depth: Object.freeze({ min: 0, max: 1 }),
            wet: Object.freeze({ min: 0, max: 1 }),
            frequency: Object.freeze({ min: 0.8, max: 12, transform: 'linear' }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'baseFrequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.18,
          minRamp: 0.01,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 40, max: 4000, transform: 'linear' }),
        secondaryParameters: Object.freeze(['depth', 'wet', 'frequency']),
      }),
    }),
    Object.freeze({
      id: 'square',
      label: 'Oscillate Square',
      description: 'Auto-filter with square LFO.',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'square' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'autofilter.square::pulse-down',
          label: 'Pulse Down',
          description: 'Negative sweep: choppy low-mid tremolo.',
          parameterMappings: Object.freeze({
            baseFrequency: Object.freeze({ min: 70, max: 400, transform: 'linear' }),
            depth: Object.freeze({ min: 0.85, max: 0 }),
            wet: Object.freeze({ min: 0.8, max: 0 }),
            frequency: Object.freeze({ min: 0.2, max: 2, transform: 'linear' }),
          }),
        }),
        positive: Object.freeze({
          id: 'autofilter.square::motion',
          label: 'Motion',
          description: 'Positive sweep: razor-edged square chops.',
          parameterMappings: Object.freeze({
            baseFrequency: Object.freeze({ min: 400, max: 3800, transform: 'linear' }),
            depth: Object.freeze({ min: 0, max: 1 }),
            wet: Object.freeze({ min: 0, max: 1 }),
            frequency: Object.freeze({ min: 0.8, max: 10, transform: 'linear' }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'baseFrequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.18,
          minRamp: 0.01,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 40, max: 4000, transform: 'linear' }),
        secondaryParameters: Object.freeze(['depth', 'wet', 'frequency']),
      }),
    }),
    Object.freeze({
      id: 'triangle',
      label: 'Oscillate Triangle',
      description: 'Auto-filter with triangle LFO.',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'triangle' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'autofilter.triangle::ebb',
          label: 'Ebb',
          description: 'Negative sweep: mellow heartbeats.',
          parameterMappings: Object.freeze({
            baseFrequency: Object.freeze({ min: 70, max: 500, transform: 'linear' }),
            depth: Object.freeze({ min: 0.8, max: 0 }),
            wet: Object.freeze({ min: 0.75, max: 0 }),
            frequency: Object.freeze({ min: 0.15, max: 1.8, transform: 'linear' }),
          }),
        }),
        positive: Object.freeze({
          id: 'autofilter.triangle::motion',
          label: 'Motion',
          description: 'Positive sweep: shimmering triangle pans.',
          parameterMappings: Object.freeze({
            baseFrequency: Object.freeze({ min: 500, max: 4000, transform: 'linear' }),
            depth: Object.freeze({ min: 0, max: 1 }),
            wet: Object.freeze({ min: 0, max: 1 }),
            frequency: Object.freeze({ min: 0.8, max: 8, transform: 'linear' }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'baseFrequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.18,
          minRamp: 0.01,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 40, max: 4000, transform: 'linear' }),
        secondaryParameters: Object.freeze(['depth', 'wet', 'frequency']),
      }),
    }),
    Object.freeze({
      id: 'sawtooth',
      label: 'Oscillate Sawtooth',
      description: 'Auto-filter with sawtooth LFO.',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'sawtooth' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'autofilter.saw::grit',
          label: 'Grit',
          description: 'Negative sweep: gritty down-saw movement.',
          parameterMappings: Object.freeze({
            baseFrequency: Object.freeze({ min: 60, max: 350, transform: 'linear' }),
            depth: Object.freeze({ min: 0.85, max: 0 }),
            wet: Object.freeze({ min: 0.85, max: 0 }),
            frequency: Object.freeze({ min: 0.2, max: 2, transform: 'linear' }),
          }),
        }),
        positive: Object.freeze({
          id: 'autofilter.saw::motion',
          label: 'Motion',
          description: 'Positive sweep: high-energy saw shredding.',
          parameterMappings: Object.freeze({
            baseFrequency: Object.freeze({ min: 350, max: 4000, transform: 'linear' }),
            depth: Object.freeze({ min: 0, max: 1 }),
            wet: Object.freeze({ min: 0, max: 1 }),
            frequency: Object.freeze({ min: 0.8, max: 12, transform: 'linear' }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'baseFrequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.18,
          minRamp: 0.01,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 40, max: 4000, transform: 'linear' }),
        secondaryParameters: Object.freeze(['depth', 'wet', 'frequency']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
