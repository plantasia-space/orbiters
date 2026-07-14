export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.feedbackdelay',
  label: 'Feedback Delay',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::III',
  dimensionLabel: 'EW::III',
  // Defaults passed to Tone.FeedbackDelay constructor
  defaults: Object.freeze({
    delayTime: 0.25,
    feedback: 0.25,
    wet: 0.5,
  }),
  // Primary user control for the module
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Spiral Echo',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'short',
      label: 'Spiral Echo Short',
      description: 'Tight slap / drum space / rhythmic glue.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      target: 'feedback',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -60, max: 60, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'feedbackdelay.short::slap',
          label: 'Slap',
          description: 'Left sweep introduces fast reflections and quick repeats.',
          parameterMappings: Object.freeze({
            delayTime: Object.freeze({ min: 0.03, max: 0.15 }),
            feedback: Object.freeze({ min: 0.0, max: 0.55 }),
            wet: Object.freeze({ min: 0.0, max: 0.85 }),
          }),
        }),
        positive: Object.freeze({
          id: 'feedbackdelay.short::dry',
          label: 'Dry Control',
          description: 'Right sweep keeps the slap tight and almost bypassed.',
          parameterMappings: Object.freeze({
            delayTime: Object.freeze({ min: 0.03, max: 0.08 }),
            feedback: Object.freeze({ min: 0.0, max: 0.35 }),
            wet: Object.freeze({ min: 0.0, max: 0.45 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'feedback',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -100, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['delayTime', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'mid',
      label: 'Spiral Echo Mid',
      description: 'Classic tempo delay feel.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      target: 'feedback',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -70, max: 70, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'feedbackdelay.mid::classic',
          label: 'Classic',
          description: 'Negative sweep blooms into tempo-locked echoes.',
          parameterMappings: Object.freeze({
            delayTime: Object.freeze({ min: 0.08, max: 0.45 }),
            feedback: Object.freeze({ min: 0.0, max: 0.7 }),
            wet: Object.freeze({ min: 0.0, max: 0.9 }),
          }),
        }),
        positive: Object.freeze({
          id: 'feedbackdelay.mid::tight',
          label: 'Tight',
          description: 'Positive sweep stays controlled and closer to dry.',
          parameterMappings: Object.freeze({
            delayTime: Object.freeze({ min: 0.08, max: 0.3 }),
            feedback: Object.freeze({ min: 0.0, max: 0.5 }),
            wet: Object.freeze({ min: 0.0, max: 0.6 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'feedback',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -100, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['delayTime', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'long',
      label: 'Spiral Echo Long',
      description: 'Wide ambient trails.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      target: 'feedback',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -80, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'feedbackdelay.long::halo',
          label: 'Halo',
          description: 'Negative sweep washes into longer stereo ambience.',
          parameterMappings: Object.freeze({
            delayTime: Object.freeze({ min: 0.18, max: 0.8 }),
            feedback: Object.freeze({ min: 0.1, max: 0.85 }),
            wet: Object.freeze({ min: 0.0, max: 1.0 }),
          }),
        }),
        positive: Object.freeze({
          id: 'feedbackdelay.long::clarity',
          label: 'Clarity',
          description: 'Positive sweep keeps the tail cleaner and drier.',
          parameterMappings: Object.freeze({
            delayTime: Object.freeze({ min: 0.18, max: 0.5 }),
            feedback: Object.freeze({ min: 0.1, max: 0.65 }),
            wet: Object.freeze({ min: 0.0, max: 0.7 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'feedback',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -100, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['delayTime', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'infinite',
      label: 'Spiral Echo Infinite',
      description: 'Almost self-regenerating, near loop.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      target: 'feedback',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -90, max: 90, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'feedbackdelay.infinite::hover',
          label: 'Hover',
          description: 'Negative sweep leans into long, regenerating repeats.',
          parameterMappings: Object.freeze({
            delayTime: Object.freeze({ min: 0.28, max: 0.9 }),
            feedback: Object.freeze({ min: 0.45, max: 0.85 }),
            wet: Object.freeze({ min: 0.0, max: 1.0 }),
          }),
        }),
        positive: Object.freeze({
          id: 'feedbackdelay.infinite::control',
          label: 'Control',
          description: 'Positive sweep reins the loop back toward stability.',
          parameterMappings: Object.freeze({
            delayTime: Object.freeze({ min: 0.28, max: 0.65 }),
            feedback: Object.freeze({ min: 0.45, max: 0.95 }),
            wet: Object.freeze({ min: 0.0, max: 0.8 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'feedback',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.01,
          maxRamp: 0.6,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -100, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['delayTime', 'wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
