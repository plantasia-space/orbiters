export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.tremolo',
  label: 'Tremolo',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::II',
  dimensionLabel: 'EW::II',
  defaults: Object.freeze({
    frequency: 5,
    depth: 0,
    spread: 0,
    wet: 0,
    type: 'sine',
  }),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Heart Pulse',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'slow',
      label: 'Heart Pulse Slow',
      description: 'Breathing star; cinematic slow pulse.',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'sine' }),
      target: 'frequency',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 50, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          label: 'Deep',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'frequency',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.08,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 100, transform: 'easeIn' }),
          }),
          parameterMappings: Object.freeze({
            frequency: { min: 100, max: 0.1 },
            depth: { min: 0.99, max: 0.4 },
            
            wet: { min: 1.0, max: 0.0 },
          }),
        }),
        positive: Object.freeze({
          label: 'Gentle',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'frequency',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.08,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0.1, max: 100, transform: 'easeIn' }),
          }),
          parameterMappings: Object.freeze({
            frequency: { min: 0.1, max: 100 },
            depth: { min: 0.4, max: 0.99 },
            
            wet: { min: 0.0, max: 1.0 },
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 100, transform: 'easeIn' }),
        secondaryParameters: Object.freeze(['depth', 'spread', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'sync',
      label: 'Heart Pulse Sync',
      description: 'Rhythmic trance / sidechain feel; transport-locked divisions.',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'sine' }),
      target: 'frequency',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -80, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          label: 'Heavy',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'frequency',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.08,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 16, transform: 'stepLock' }),
          }),
          parameterMappings: Object.freeze({
            frequency: { min: 16, max: 0.1 },
            depth: { min: 1.0, max: 0.5 },
            
            wet: { min: 1.0, max: 0.0 },
          }),
        }),
        positive: Object.freeze({
          label: 'Locked',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'frequency',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.08,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0.1, max: 16, transform: 'stepLock' }),
          }),
          parameterMappings: Object.freeze({
            frequency: { min: 0.1, max: 16 },
            depth: { min: 0.5, max: 1.0 },
            
            wet: { min: 0.0, max: 1.0 },
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'frequency',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 100, transform: 'stepLock' }),
        discrete: Object.freeze({
          frequencyDivisions: ['4n', '8n', '16n', '32n'],
        }),
        secondaryParameters: Object.freeze(['depth', 'spread', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'stereo',
      label: 'Heart Pulse Stereo',
      description: 'Left/right pulsing opposition; open spread to 180°.',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'sine' }),
      target: 'spread',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -90, max: 100, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          label: 'Wide',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'spread',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.08,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 180, transform: 'linear' }),
          }),
          parameterMappings: Object.freeze({
            frequency: { min: 8, max: 0.5 },
            depth: { min: 0.95, max: 0.5 },
            
            wet: { min: 1.0, max: 0.0 },
          }),
        }),
        positive: Object.freeze({
          label: 'Opposition',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'spread',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.08,
              minRamp: 0.02,
              maxRamp: 0.8,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 180, transform: 'linear' }),
          }),
          parameterMappings: Object.freeze({
            frequency: { min: 0.5, max: 8 },
            depth: { min: 0.5, max: 0.95 },
            
            wet: { min: 0.0, max: 1.0 },
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'spread',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.08,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['frequency', 'depth', 'wet']),
      }),
    }),
    Object.freeze({
      id: 'stutter',
      label: 'Heart Pulse Stutter',
      description: 'Hard squarey chop; abrupt gate toward 1 depth.',
      dimension: 'EW::II',
      fixed: Object.freeze({ type: 'sine' }),
      target: 'depth',
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -50, max: 100, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          label: 'Chop',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'depth',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.04,
              minRamp: 0.01,
              maxRamp: 0.5,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0, max: 1.0, transform: 'hardEdge' }),
          }),
          parameterMappings: Object.freeze({
            frequency: { min: 14, max: 2 },
            depth: { min: 1.0, max: 0.6 },
            
            wet: { min: 1.0, max: 0.0 },
          }),
        }),
        positive: Object.freeze({
          label: 'Gate',
          control: Object.freeze({
            mode: 'hybrid',
            audioParam: 'depth',
            provider: 'node',
            smoothing: Object.freeze({
              defaultRamp: 0.04,
              minRamp: 0.01,
              maxRamp: 0.5,
              curve: 'linear',
            }),
            signalRange: Object.freeze({ min: 0.6, max: 1.0, transform: 'hardEdge' }),
          }),
          parameterMappings: Object.freeze({
            frequency: { min: 2, max: 14 },
            depth: { min: 0.6, max: 1.0 },
            
            wet: { min: 0.0, max: 1.0 },
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'depth',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.04,
          minRamp: 0.01,
          maxRamp: 0.5,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 100, transform: 'hardEdge' }),
        secondaryParameters: Object.freeze(['frequency', 'spread', 'wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
