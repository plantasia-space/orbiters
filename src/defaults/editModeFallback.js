import { DEFAULT_ORBITER_FALLBACK } from './orbiterFallback.js';
import { AXIS_ROTATION_CONSTRAINTS, DEFAULT_EDIT_TRACK_ID } from '../config/Constants.js';
import { sanitizeMappings } from '../audio/effects/mappingManager.js';
import { createDefaultStacks } from '../core/stackUtils.js';
import { ensureStacksDimensions } from './editModeStacks.js';
import { nestEntangledWorldIntoTrack } from '../api/dataManager/normalizers.js';
import { DEFAULT_COLOR_C } from '../orbiter/edit/designUtils.js';

const FALLBACK_COLOR_PRIMARY = DEFAULT_ORBITER_FALLBACK?.release?.metadata?.orbiterColors?.color1 || 'rgb(255, 255, 255)';
const FALLBACK_COLOR_SECONDARY = DEFAULT_ORBITER_FALLBACK?.release?.metadata?.orbiterColors?.color2 || 'rgb(0, 0, 0)';
const DEFAULT_DIMENSION_ID = 'EW::I';

function buildAxisParam(axis, overrides = {}) {
  const label = overrides.label || axis.toUpperCase();
  const {
    min,
    max,
    equilibrium,
    step,
  } = AXIS_ROTATION_CONSTRAINTS;

  const clamp = (value, lower, upper) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return equilibrium;
    return Math.min(upper, Math.max(lower, numeric));
  };

  return {
    axis,
    label,
    description: overrides.description || `${label} axis control`,
    min,
    max,
    initValue: clamp(overrides.initValue ?? equilibrium, min, max),
    value: clamp(overrides.value ?? overrides.initValue ?? equilibrium, min, max),
    defaultValue: clamp(overrides.defaultValue ?? overrides.initValue ?? equilibrium, min, max),
    minLimit: min,
    maxLimit: max,
    step: step,
  };
}

export function buildEditModeFallback({ trackId = DEFAULT_EDIT_TRACK_ID } = {}) {
  
  const fallbackRelease = DEFAULT_ORBITER_FALLBACK.release || {};
  const fallbackMetadata = fallbackRelease.metadata || {};
  const orbiterId = fallbackMetadata.orbiterId || DEFAULT_ORBITER_FALLBACK.orbiterId || 'orbiter-fallback';
  const rootStyles = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const cssColor1 = rootStyles?.getPropertyValue('--color1').trim();
  const cssColor2 = rootStyles?.getPropertyValue('--color2').trim();
  const cssColor3 = rootStyles?.getPropertyValue('--color3').trim();
  const cssRadius = rootStyles?.getPropertyValue('--orbiters-rounded-corners').trim();
  const cssBorder = rootStyles?.getPropertyValue('--orbiters-frame-border-width').trim();

  const orbiterColors = {
    color1: cssColor1 || FALLBACK_COLOR_PRIMARY,
    color2: cssColor2 || FALLBACK_COLOR_SECONDARY,
    color3: cssColor3 || DEFAULT_COLOR_C
  };

  const mappingDefaults = {
    x: buildAxisParam('x'),
    y: buildAxisParam('y'),
    z: buildAxisParam('z')
  };

  const emptyModule = () => ({
    effectId: null,
    moduleId: null,
    inputParamId: null,
    range: { min: null, max: null, equilibrium: null },
    settings: undefined,
    mappings: [],
  });

  const emptyRack = () => ({
    dimensionId: DEFAULT_DIMENSION_ID,
    modules: [emptyModule(), emptyModule()]
  });

  const effectsDefaults = {
    x: emptyRack(),
    y: emptyRack(),
    z: emptyRack()
  };

  const stacksDefaults = createDefaultStacks();
  ensureStacksDimensions(stacksDefaults, DEFAULT_DIMENSION_ID, DEFAULT_DIMENSION_ID);

  const fallbackCombined = {
    track: {
      trackId,
      version: 'edit',
      name: 'Edit Mode Track',
      displayName: 'Edit Mode Track',
      owner: 'Orbiters',
      defaultOrbiterId: orbiterId,
      defaultOrbiterVersion: fallbackRelease.version || 'fallback',
      defaultEntangledWorldId: 'edit-world',
      defaultEntangledWorldVersion: 'edit',
    },
    orbiter: {
      orbiterId,
      version: fallbackRelease.version || 'fallback',
      snapshotAt: null,
      status: 'fallback',
      metadata: fallbackMetadata,
      orbiterName: fallbackMetadata.orbiterName || fallbackMetadata.name || 'Fallback Orbiter',
      developer: fallbackMetadata.developer || 'Plantasia',
      availability: fallbackMetadata.availability ?? 'private',
      orbiterColors,
      orbiterParams: mappingDefaults,
      effects: effectsDefaults,
      stacks: stacksDefaults,
      orbiterJSONURL: fallbackMetadata.orbiterJSONURL || null,
      assets: fallbackRelease.assets || {},
      buildNotes: fallbackRelease.buildNotes || null,
      errorMessage: null,
    },
    entangledWorld: {
      worldId: 'edit-world',
      version: 'edit',
      snapshotAt: null,
      status: 'fallback',
      moonAmount: 0,
      metadata: {
        glow: { enabled: false },
        clouds: { enabled: false }
      },
    },
  };

  const engineDefault = {
    id: orbiterId,
    url: fallbackMetadata.orbiterJSONURL || null,
    label: fallbackMetadata.orbiterName || fallbackMetadata.name || 'Fallback Orbiter',
    versionId: fallbackRelease.version || 'edit',
    dimensionId: 'default'
  };

  return {
    // Nest the world into the track so the edit-mode fallback path matches
    // every other combined producer — keeps Main.js free of the re-patch.
    combined: nestEntangledWorldIntoTrack(fallbackCombined),
    designDefaults: {
      colorPrimary: orbiterColors.color1,
      colorSecondary: orbiterColors.color2,
      colorC: orbiterColors.color3,
      roundedCorners: cssRadius ? parseFloat(cssRadius) || 0 : 12,
      fontFamily: 'Inter, sans-serif',
      fontId: null,
      fontImportUrl: null,
      frameBorderWidth: cssBorder ? parseFloat(cssBorder) || 0 : 2
    },
    mappingDefaults: {
      x: { ...mappingDefaults.x },
      y: { ...mappingDefaults.y },
      z: { ...mappingDefaults.z }
    },
    stacksDefaults,
    effectsDefaults,
    engineDefault
  };
}
