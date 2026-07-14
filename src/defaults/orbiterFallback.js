/**
 * @file orbiterFallback.js
 * @description Provides a default orbiter release payload that can be used
 *              when API requests fail. This keeps the application responsive
 *              while real data is unavailable. Values can be edited later.
 */

import { AXIS_ROTATION_CONSTRAINTS } from '../config/Constants.js';
import { DEFAULT_COLOR_C } from '../orbiter/edit/designUtils.js';

const EFFECT_AXES = ['x', 'y', 'z'];
const DEFAULT_STACK_ID = 'deck-i';
const DEFAULT_DIMENSION_ID = 'EW::I';

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFallbackModule({
  effectId,
  moduleId,
  dimensionId,
  dimensionLabel,
  inputParamId,
  range,
  moduleMetadata = null,
  controlNormalized = 0.5,
  effectVersion = '1.0.0',
}) {
  return {
    effectId,
    effectVersion,
    moduleId,
    moduleMetadata: moduleMetadata ? { ...moduleMetadata } : null,
    inputParamId,
    range: {
      min: Number(range?.min) || 0,
      max: Number(range?.max) || 0,
      equilibrium: Number(range?.equilibrium ?? range?.init ?? 0),
    },
    settings: undefined,
    mappings: [],
    dimensionId,
    dimensionLabel,
    controlNormalized: Number.isFinite(controlNormalized) ? controlNormalized : 0.5,
  };
}

const FALLBACK_DIMENSIONS = {
  'EW::I': {
    dimensionId: 'EW::I',
    dimensionLabel: 'EW::I',
    design: {
      colorPrimary: '#d33682',
      colorSecondary: '#2aa198',
      roundedCorners: 4,
      frameBorderWidth: 1,
      fontFamily: "'Space Mono', monospace",
      fontId: 'spaceMono',
      fontImportUrl: 'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap',
      fontLabel: 'Space Mono',
      themeId: 'retro-arcade::light',
      themeLabel: 'Retro Arcade (Light)',
      themeVariant: 'light',
      ringColor: '#cb4b16',
      ringAmplitudeMultiplier: 3.7,
      ringRadiusMultiplier: 0.35,
      ringEnabled: true,
    },
    axes: {
      x: {
        modules: [
          createFallbackModule({
            effectId: 'tone.tempoPitch',
            moduleId: 'tempoFine',
            dimensionId: 'EW::I',
            dimensionLabel: 'EW::I',
            inputParamId: 'playbackRate',
            range: { min: -8, max: 8, equilibrium: 0 },
            moduleMetadata: {
              // `tempoFine` is a PERCENT module (mapPercentValue), so the unit is % — not semitones
              // (those are the pitch* modules). Keep the label honest to the actual mapping.
              label: 'Tempo ±8%',
              description: 'Adjust playback speed by up to ±8%.',
            },
            controlNormalized: 0.5,
          }),
        ],
      },
      y: {
        modules: [
          createFallbackModule({
            effectId: 'tone.autofilter',
            moduleId: 'square',
            dimensionId: 'EW::I',
            dimensionLabel: 'EW::I',
            inputParamId: 'inputParam',
            range: { min: -100, max: 100, equilibrium: 0 },
            moduleMetadata: {
              label: 'Oscillate Square',
              description: 'Auto-filter with square LFO.',
            },
            controlNormalized: 0.5,
          }),
        ],
      },
      z: {
        modules: [
          createFallbackModule({
            effectId: 'tone.biquadFilter',
            moduleId: 'highpass',
            dimensionId: 'EW::I',
            dimensionLabel: 'EW::I',
            inputParamId: 'frequency',
            range: { min: 1218.8, max: 1418.6, equilibrium: 20 },
            moduleMetadata: {
              label: 'Biquad Highpass',
              description: 'Cutoff frequency (Hz)',
            },
            controlNormalized: 0.5,
          }),
        ],
      },
    },
  },
  'EW::II': {
    dimensionId: 'EW::II',
    dimensionLabel: 'EW::II',
    design: {
      colorPrimary: '#d336a9',
      colorSecondary: '#2aa198',
      roundedCorners: 4,
      frameBorderWidth: 1,
      fontFamily: "'Space Mono', monospace",
      fontId: 'spaceMono',
      fontImportUrl: 'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap',
      fontLabel: 'Space Mono',
      themeId: 'retro-arcade::light',
      themeLabel: 'Custom',
      themeVariant: 'light',
      ringColor: '#3416ca',
      ringAmplitudeMultiplier: 1,
      ringRadiusMultiplier: 0.5,
      ringEnabled: true,
    },
    axes: {
      x: {
        modules: [
          createFallbackModule({
            effectId: 'tone.biquadFilter',
            moduleId: 'lowpass',
            dimensionId: 'EW::II',
            dimensionLabel: 'EW::II',
            inputParamId: 'frequency',
            range: { min: 2018, max: 1818.2, equilibrium: 20000 },
            moduleMetadata: {
              label: 'Biquad Lowpass',
              description: 'Cutoff frequency (Hz)',
            },
            controlNormalized: 0.5,
          }),
        ],
      },
      y: {
        modules: [
          createFallbackModule({
            effectId: 'tone.chorus',
            moduleId: 'deep',
            dimensionId: 'EW::II',
            dimensionLabel: 'EW::II',
            inputParamId: 'depth',
            range: { min: 10, max: 100, equilibrium: 0 },
            moduleMetadata: {
              label: 'Ocean Deep',
              description: 'Slow, deep modulation for thick chorus movement.',
            },
            controlNormalized: 0.5,
          }),
        ],
      },
      z: {
        modules: [
          createFallbackModule({
            effectId: 'tone.phaser',
            moduleId: 'slow',
            dimensionId: 'EW::II',
            dimensionLabel: 'EW::II',
            inputParamId: 'baseFrequency',
            range: { min: 30, max: 40, equilibrium: 0 },
            moduleMetadata: {
              label: 'Orbit Slow',
              description: 'Deep, slow cosmic swirl.',
            },
            controlNormalized: 0.5,
          }),
        ],
      },
    },
  },
  'EW::III': {
    dimensionId: 'EW::III',
    dimensionLabel: 'EW::III',
    design: {
      colorPrimary: '#d336be',
      colorSecondary: '#2aa198',
      roundedCorners: 4,
      frameBorderWidth: 1,
      fontFamily: "'Space Mono', monospace",
      fontId: 'spaceMono',
      fontImportUrl: 'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap',
      fontLabel: 'Space Mono',
      themeId: 'retro-arcade::light',
      themeLabel: 'Custom',
      themeVariant: 'light',
      ringColor: '#00ff4c',
      ringAmplitudeMultiplier: 1.1,
      ringRadiusMultiplier: 0.4,
      ringEnabled: true,
    },
    axes: {
      x: {
        modules: [
          createFallbackModule({
            effectId: 'tone.bitcrusher',
            moduleId: 'grit',
            dimensionId: 'EW::III',
            dimensionLabel: 'EW::III',
            inputParamId: 'bits',
            range: { min: 20, max: 70, equilibrium: 0 },
            moduleMetadata: {
              label: 'Crystal Dust Grit',
              description: 'Mid bit depth, audible crunch, old sampler feel.',
            },
            controlNormalized: 0.382,
          }),
        ],
      },
      y: {
        modules: [
          createFallbackModule({
            effectId: 'tone.pingpongdelay',
            moduleId: '8n',
            dimensionId: 'EW::III',
            dimensionLabel: 'EW::III',
            inputParamId: 'feedback',
            range: { min: 40, max: 90, equilibrium: 0 },
            moduleMetadata: {
              label: 'Petal Mid',
              description: 'Eighth-note mid echoes.',
            },
            controlNormalized: 0.027,
          }),
        ],
      },
      z: {
        modules: [
          createFallbackModule({
            effectId: 'tone.reverb',
            moduleId: 'mid',
            dimensionId: 'EW::III',
            dimensionLabel: 'EW::III',
            inputParamId: 'decay',
            range: { min: 20, max: 80, equilibrium: 0 },
            moduleMetadata: {
              label: 'Nebula Mid',
              description: 'Medium reverb space (0-100%).',
            },
            controlNormalized: 0.5,
          }),
        ],
      },
    },
  },
};

const FALLBACK_STACKS = {
  [DEFAULT_STACK_ID]: {
    id: DEFAULT_STACK_ID,
    kind: 'deck',
    label: 'Deck I',
    enabled: true,
    dimensions: deepClone(FALLBACK_DIMENSIONS),
  },
};

const FALLBACK_SELECTION = {
  activeStackId: DEFAULT_STACK_ID,
  activeDimensionId: DEFAULT_DIMENSION_ID,
};

function buildEffectsFromDimensions(dimensions) {
  const effects = EFFECT_AXES.reduce((acc, axis) => {
    acc[axis] = {
      dimensionId: DEFAULT_DIMENSION_ID,
      dimensionLabel: DEFAULT_DIMENSION_ID,
      modules: [],
    };
    return acc;
  }, {});

  Object.values(dimensions).forEach((dimension) => {
    const dimensionId = dimension.dimensionId || DEFAULT_DIMENSION_ID;
    const dimensionLabel = dimension.dimensionLabel || dimensionId;
    EFFECT_AXES.forEach((axis) => {
      const axisModules = Array.isArray(dimension.axes?.[axis]?.modules)
        ? dimension.axes[axis].modules
        : [];
      axisModules.forEach((module) => {
        effects[axis].modules.push({
          ...module,
          dimensionId,
          dimensionLabel,
        });
      });
    });
  });

  return effects;
}

const FALLBACK_EFFECTS = buildEffectsFromDimensions(FALLBACK_DIMENSIONS);

function createAxisParam(axis, label, description) {
  const {
    min,
    max,
    equilibrium,
    step,
  } = AXIS_ROTATION_CONSTRAINTS;

  return {
    axis,
    label,
    description,
    value: equilibrium,
    initValue: equilibrium,
    defaultValue: equilibrium,
    min,
    max,
    step,
  };
}

const BASE_PARAMETERS = {
  x: createAxisParam('x', 'Orbit X', 'Horizontal oscillator anchor.'),
  y: createAxisParam('y', 'Orbit Y', 'Vertical oscillator anchor.'),
  z: createAxisParam('z', 'Orbit Z', 'Depth oscillator anchor.'),
  speed: {
    axis: 'speed',
    label: 'Orbital speed',
    value: 0.25,
    initValue: 0.25,
    min: 0,
    max: 2,
    description: 'Animation speed coefficient.',
  },
};

const BASE_METADATA = {
  orbiterId: 'orbiter-fallback',
  orbiterName: 'sky-sounds-1',
  displayName: 'sky-sounds-1',
  developer: 'plantasia.space',
  availability: 'private',
  parameters: BASE_PARAMETERS,
  orbiterColors: {
    color1: '#d33682',
    color2: '#2aa198',
    color3: DEFAULT_COLOR_C,
  },
  roles: {
    editors: [],
    publishers: [],
    viewers: [],
  },
  isOfficialEngine: false,
  status: 'complete',
  description:
    'Hydrated fallback orbiter with Tone.js-ready stacks and multi-dimension effects.',
  orbiterSession: {
    schemaVersion: 1,
    stacks: deepClone(FALLBACK_STACKS),
    selection: { ...FALLBACK_SELECTION },
  },
  effects: deepClone(FALLBACK_EFFECTS),
};

const BASE_RELEASE = {
  version: 'fallback',
  snapshotAt: null,
  status: 'fallback',
  metadata: BASE_METADATA,
  assets: {
    orbiterFileURLs: [],
    orbiterFileURL: null,
  },
  buildNotes: 'Generated by local fallback preset.',
  errorMessage: null,
};

/**
 * Returns a deep copy of the fallback orbiter metadata with optional overrides.
 * @param {object} overrides
 * @returns {object}
 */
function buildMetadata(overrides = {}) {
  const parametersOverride = overrides.parameters || overrides.orbiterParams;
  return {
    ...BASE_METADATA,
    ...overrides,
    orbiterId: overrides.orbiterId ?? overrides.id ?? BASE_METADATA.orbiterId ?? null,
    id: overrides.orbiterId ?? overrides.id ?? BASE_METADATA.id ?? null,
    parameters: {
      ...BASE_PARAMETERS,
      ...(parametersOverride || {}),
    },
    orbiterSession: deepClone(
      overrides.orbiterSession || BASE_METADATA.orbiterSession || {},
    ),
    effects: deepClone(overrides.effects || BASE_METADATA.effects || FALLBACK_EFFECTS),
  };
}

/**
 * Creates a fallback orbiter payload suitable for the normalizer.
 * @param {object} options
 * @returns {object}
 */
export function createDefaultOrbiterFallback(options = {}) {
  const {
    orbiterId = 'orbiter-fallback',
    version = BASE_RELEASE.version,
    metadata = {},
    availableVersions = [],
    snapshotAt = new Date().toISOString(),
  } = options;

  const mergedMetadata = buildMetadata({
    ...metadata,
    orbiterId,
    id: orbiterId,
  });

  return {
    success: true,
    orbiterId,
    release: {
      ...BASE_RELEASE,
      version,
      snapshotAt,
      metadata: mergedMetadata,
      assets: {
        ...BASE_RELEASE.assets,
      },
    },
    availableVersions: Array.isArray(availableVersions) ? availableVersions : [],
    isLatest: true,
  };
}

export const DEFAULT_ORBITER_FALLBACK = createDefaultOrbiterFallback();
