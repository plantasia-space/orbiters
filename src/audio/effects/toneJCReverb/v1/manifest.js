export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.jcreverb',
  label: 'JC Reverb',
  version: '1.1.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::III',
  dimensionLabel: 'EW::III',
  defaults: Object.freeze({
    roomSize: 0.4,
    wet: 0.5,
  }),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Temple',
    units: '%',
    range: Object.freeze({ min: -100, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'small',
      label: 'Temple Small',
      description: 'Short, boxy, reflective chamber.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -60, max: 60, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'jcreverb.small::dry',
          label: 'Dry Focus',
          description: 'Left sweep keeps the room tight and mostly dry.',
          parameterMappings: Object.freeze({
            roomSize: Object.freeze({ min: 0.05, max: 0.2 }),
            wet: Object.freeze({ min: 0.38, max: 0.0 }),
          }),
        }),
        positive: Object.freeze({
          id: 'jcreverb.small::bloom',
          label: 'Bloom',
          description: 'Right sweep opens to 0.4 room size with more mix.',
          parameterMappings: Object.freeze({
            roomSize: Object.freeze({ min: 0.2, max: 0.4 }),
            wet: Object.freeze({ min: 0., max: 0.7 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'roomSize',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -100, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'hall',
      label: 'Temple Hall',
      description: 'Classic JCReverb tuned space with a musical tail.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -80, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'jcreverb.hall::dry',
          label: 'Dry Hold',
          description: 'Left sweep keeps room size minimal and wet low.',
          parameterMappings: Object.freeze({
            roomSize: Object.freeze({ min: 0.15, max: 0.45 }),
            wet: Object.freeze({ min: 0.5, max: 0.0 }),
          }),
        }),
        positive: Object.freeze({
          id: 'jcreverb.hall::soar',
          label: 'Soar',
          description: 'Right sweep opens to 0.75 with a full wet blend.',
          parameterMappings: Object.freeze({
            roomSize: Object.freeze({ min: 0.45, max: 0.75 }),
            wet: Object.freeze({ min: 0.0, max: 1.0 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'roomSize',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -100, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'cloud',
      label: 'Temple Cloud',
      description: 'Softer, diffused reverb body.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -80, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'jcreverb.cloud::mist',
          label: 'Mist',
          description: 'Negative sweep keeps the cloud restrained for subtle pads.',
          parameterMappings: Object.freeze({
            roomSize: Object.freeze({ min: 0.2, max: 0.65 }),
            wet: Object.freeze({ min: 0.7, max: 0.0 }),
          }),
        }),
        positive: Object.freeze({
          id: 'jcreverb.cloud::nebula',
          label: 'Nebula',
          description: 'Positive sweep opens to 0.9 room size with lush wet blend.',
          parameterMappings: Object.freeze({
            roomSize: Object.freeze({ min: 0.65, max: 0.9 }),
            wet: Object.freeze({ min: 0., max: 0.85 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'roomSize',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -100, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
    Object.freeze({
      id: 'infinite',
      label: 'Temple Almost Infinite',
      description: 'Long, washed halo that hovers just shy of endless.',
      dimension: 'EW::III',
      fixed: Object.freeze({}),
      valueRange: Object.freeze({ min: -100, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: -80, max: 80, equilibrium: 0 }),
      segments: Object.freeze({
        negative: Object.freeze({
          id: 'jcreverb.infinite::calm',
          label: 'Calm',
          description: 'Left sweep gives long-but-manageable tails for layering.',
          parameterMappings: Object.freeze({
            roomSize: Object.freeze({ min: 0.35, max: 0.8 }),
            wet: Object.freeze({ min: 0.6, max: 0. }),
          }),
        }),
        positive: Object.freeze({
          id: 'jcreverb.infinite::endless',
          label: 'Endless',
          description: 'Right sweep drives toward near-infinite sustain without runaway feedback.',
          parameterMappings: Object.freeze({
            roomSize: Object.freeze({ min: 0.8, max: 0.95 }),
            wet: Object.freeze({ min: 0.0, max: 0.9 }),
          }),
        }),
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'roomSize',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 0.8,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: -100, max: 100, transform: 'linear' }),
        secondaryParameters: Object.freeze(['wet']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
