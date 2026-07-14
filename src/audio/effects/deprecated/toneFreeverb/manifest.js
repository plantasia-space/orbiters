export const EFFECT_MANIFEST = Object.freeze({
  id: 'tone.freeverb',
  label: 'Freeverb',
  version: '1.0.1',
  inputParam: 'inputParam',
  dimensionId: 'EW::I',
  dimensionLabel: 'EW::I',
  defaults: Object.freeze({
    roomSize: 0.7,
    dampening: 3000,
    wet: 0.5,
  }),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Dry/Wet',
    units: '%',
    range: Object.freeze({ min: 0, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'small',
      label: 'Small Room',
      description: 'Room control (0-100%)',
      dimension: 'EW::I',
      fixed: Object.freeze({ 
        roomSize: 0.3 
      }),
      valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: 10, max: 60, equilibrium: 0 }),
      parameterMappings: Object.freeze({
        wet: { min: 0, max: 0.8 },
        dampening: { min: 8000, max: 1000 }, // inverted: 0% = bright, 100% = dark
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'wet',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 1,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
        secondaryParameters: Object.freeze(['dampening']),
      }),
    }),
    Object.freeze({
      id: 'medium',
      label: 'Medium Room',
      description: 'Room control (0-100%)',
      dimension: 'EW::I',
      fixed: Object.freeze({ 
        roomSize: 0.7 
      }),
      valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: 20, max: 80, equilibrium: 0 }),
      parameterMappings: Object.freeze({
        wet: { min: 0, max: .5 },
        dampening: { min: 6000, max: 500 }, // inverted
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'wet',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 1,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
        secondaryParameters: Object.freeze(['dampening']),
      }),
    }),
    Object.freeze({
      id: 'large',
      label: 'Large Room',
      description: 'Room control (0-100%)',
      dimension: 'EW::I',
      fixed: Object.freeze({ 
        roomSize: 0.9 
      }),
      valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),
      initialRange: Object.freeze({ min: 30, max: 90, equilibrium: 0 }),
      parameterMappings: Object.freeze({
        wet: { min: 0, max: .5 },
        dampening: { min: 4000, max: 200 }, // inverted
      }),
      control: Object.freeze({
        mode: 'hybrid',
        audioParam: 'wet',
        provider: 'node',
        smoothing: Object.freeze({
          defaultRamp: 0.12,
          minRamp: 0.02,
          maxRamp: 1,
          curve: 'linear',
        }),
        signalRange: Object.freeze({ min: 0, max: 1, transform: 'linear' }),
        secondaryParameters: Object.freeze(['dampening']),
      }),
    }),
  ]),
});

export default EFFECT_MANIFEST;
