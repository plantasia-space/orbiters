export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.chorus',
  label: 'Chorus',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::II',
  dimensionLabel: 'EW::II',
  // Defaults passed to Tone.Chorus constructor
  defaults: Object.freeze({
    frequency: 1.2,
    delayTime: 4,
    depth: 0.5,
    feedback: 0.8,
    wet: 0.5,
    spread: 180,
    type: 'sine',
  }),
  // Primary user control for the module
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Ocean',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'soft',
      label: 'Ocean Soft',
      description: 'Gentle shimmer with mellow modulation and moderate width.',
      dimension: 'EW::II',
      fixed: Object.freeze({ spread: 180, type: 'sine' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -40, max: 40, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'chorus.soft::wide',
          label: 'Wide',
          description: 'Negative sweep: inverted from fast/wide down to equilibrium.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0.85, max: 0.0 }), // INVERTED: full to bypass
            frequency: Object.freeze({ min: 4, max: 1.3 }), // INVERTED: fast to mid (equilibrium)
            delayTime: Object.freeze({ min: 10, max: 5 }), // INVERTED: wide to mid (equilibrium)
            wet: Object.freeze({ min: 0.85, max: 0.0 }), // INVERTED: full wet to bypass
          }),
        }),
        positive: Object.freeze({
          id: 'chorus.soft::subtle',
          label: 'Subtle',
          description: 'Positive sweep: from equilibrium to dry/narrow.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0.0, max: 0.35 }), // MIRROR: bypass to subtle
            frequency: Object.freeze({ min: 1.3, max: 0.2 }), // MIRROR: mid to slow
            delayTime: Object.freeze({ min: 5, max: 2.2 }), // MIRROR: mid to narrow
            wet: Object.freeze({ min: 0.0, max: 0.4 }), // MIRROR: bypass to dry blend
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
        secondaryParameters: Object.freeze(['frequency', 'delayTime', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'wide',
      label: 'Ocean Wide',
      description: 'Expansive stereo detune and lush width.',
      dimension: 'EW::II',
      fixed: Object.freeze({ spread: 180, type: 'sine' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'chorus.wide::expansive',
          label: 'Expansive',
          description: 'Negative sweep: inverted from wide/expansive down to equilibrium.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0.95, max: 0.0 }), // INVERTED: full to bypass
            frequency: Object.freeze({ min: 5, max: 1.8 }), // INVERTED: fast to mid (equilibrium)
            delayTime: Object.freeze({ min: 16, max: 9 }), // INVERTED: very wide to mid (equilibrium)
            wet: Object.freeze({ min: 0.95, max: 0.0 }), // INVERTED: full wet to bypass
          }),
        }),
        positive: Object.freeze({
          id: 'chorus.wide::focused',
          label: 'Focused',
          description: 'Positive sweep: from equilibrium to focused/tight.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0.0, max: 0.4 }), // MIRROR: bypass to subtle
            frequency: Object.freeze({ min: 1.8, max: 0.25 }), // MIRROR: mid to slow
            delayTime: Object.freeze({ min: 9, max: 4.5 }), // MIRROR: mid to narrow
            wet: Object.freeze({ min: 0.0, max: 0.45 }), // MIRROR: bypass to dry
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
        secondaryParameters: Object.freeze(['frequency', 'delayTime', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'deep',
      label: 'Ocean Deep',
      description: 'Slow, deep modulation for thick chorus movement.',
      dimension: 'EW::II',
      fixed: Object.freeze({ spread: 180, type: 'sine' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -60, max: 60, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'chorus.deep::lush',
          label: 'Lush',
          description: 'Negative sweep: inverted from deep/thick down to equilibrium.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 1, max: 0.0 }), // INVERTED: full to bypass
            frequency: Object.freeze({ min: 2.2, max: 0.8 }), // INVERTED: moderate to slow (equilibrium)
            delayTime: Object.freeze({ min: 18, max: 8 }), // INVERTED: deep to mid (equilibrium)
            wet: Object.freeze({ min: 0.95, max: 0.0 }), // INVERTED: full wet to bypass
          }),
        }),
        positive: Object.freeze({
          id: 'chorus.deep::tight',
          label: 'Tight',
          description: 'Positive sweep: from equilibrium to tight/dry.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0.0, max: 0.5 }), // MIRROR: bypass to subtle
            frequency: Object.freeze({ min: 0.8, max: 0.12 }), // MIRROR: slow to very slow
            delayTime: Object.freeze({ min: 8, max: 4 }), // MIRROR: mid to tight
            wet: Object.freeze({ min: 0.0, max: 0.55 }), // MIRROR: bypass to dry
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
        secondaryParameters: Object.freeze(['frequency', 'delayTime', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'flutter',
      label: 'Ocean Flutter',
      description: 'Fast, flittering modulation with light delay and feedback.',
      dimension: 'EW::II',
      fixed: Object.freeze({ spread: 180, type: 'sine' }),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -70, max: 70, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'chorus.flutter::rapid',
          label: 'Rapid',
          description: 'Negative sweep: inverted from fast flutter down to equilibrium.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0.85, max: 0.0 }), // INVERTED: high to bypass
            frequency: Object.freeze({ min: 12, max: 3.5 }), // INVERTED: very fast to mid (equilibrium)
            delayTime: Object.freeze({ min: 9, max: 5.5 }), // INVERTED: moderate to equilibrium
            wet: Object.freeze({ min: 0.9, max: 0.0 }), // INVERTED: full wet to bypass
          }),
        }),
        positive: Object.freeze({
          id: 'chorus.flutter::calm',
          label: 'Calm',
          description: 'Positive sweep: from equilibrium to calm/slow.',
          parameterMappings: Object.freeze({
            depth: Object.freeze({ min: 0.0, max: 0.4 }), // MIRROR: bypass to subtle
            frequency: Object.freeze({ min: 3.5, max: 0.6 }), // MIRROR: mid to slow
            delayTime: Object.freeze({ min: 5.5, max: 2.8 }), // MIRROR: equilibrium to tight
            wet: Object.freeze({ min: 0.0, max: 0.45 }), // MIRROR: bypass to dry
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
        secondaryParameters: Object.freeze(['frequency', 'delayTime', 'wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
