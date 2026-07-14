import { getEffectDefinition } from './index.js';

const EFFECT_DEFINITION_CACHE = new Map();

function sanitizeEffectId(effectId) {
  if (!effectId || typeof effectId !== 'string') {
    return null;
  }
  const trimmed = effectId.trim();
  return trimmed.length ? trimmed : null;
}

export function getEffectDefinitionCached(effectId) {
  const key = sanitizeEffectId(effectId);
  if (!key) {
    return null;
  }

  if (EFFECT_DEFINITION_CACHE.has(key)) {
    return EFFECT_DEFINITION_CACHE.get(key);
  }

  const definition = getEffectDefinition(key) || null;
  EFFECT_DEFINITION_CACHE.set(key, definition);
  return definition;
}

function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function sameMajor(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  return pa.major === pb.major;
}

export function resolveEffectDefinitionWithStatus(effectId, requestedVersion = null, { allowPatch = true } = {}) {
  const definition = getEffectDefinitionCached(effectId);
  if (!definition) {
    return {
      definition: null,
      resolvedVersion: null,
      missingEffect: true,
      requestedVersion: requestedVersion ?? null,
    };
  }

  const activeVersion = definition.version ?? definition.manifest?.version ?? null;
  if (!requestedVersion || requestedVersion === activeVersion) {
    return {
      definition,
      resolvedVersion: activeVersion,
      missingEffect: false,
      requestedVersion: requestedVersion ?? activeVersion,
      upgradedFromVersion: null,
    };
  }

  if (allowPatch && sameMajor(requestedVersion, activeVersion)) {
    return {
      definition,
      resolvedVersion: activeVersion,
      missingEffect: false,
      requestedVersion,
      upgradedFromVersion: requestedVersion !== activeVersion ? requestedVersion : null,
    };
  }

  return {
    definition: null,
    resolvedVersion: null,
    missingEffect: true,
    requestedVersion,
  };
}

export function resolveEffectVersion(effectId, requestedVersion = null, options = {}) {
  const { resolvedVersion } = resolveEffectDefinitionWithStatus(effectId, requestedVersion, options);
  return resolvedVersion ?? null;
}

export function resolveModuleMetadata(effectId, moduleId) {
  const key = sanitizeEffectId(effectId);
  if (!key || !moduleId) {
    return null;
  }

  const definition = getEffectDefinitionCached(key);
  const manifestModules = definition?.manifest?.modules;
  if (!Array.isArray(manifestModules)) {
    return null;
  }

  const entry = manifestModules.find((module) => {
    if (!module) return false;
    const candidateId = module.id ?? module.moduleId ?? null;
    return candidateId === moduleId;
  });

  if (!entry) {
    return null;
  }

  return {
    id: entry.id ?? entry.moduleId ?? null,
    label: entry.label ?? null,
    description: entry.description ?? null,
    dimensionId: entry.dimensionId ?? entry.dimension ?? null,
    dimensionLabel: entry.dimensionLabel ?? null,
  };
}

export function resolveModuleMetadataWithStatus(effectId, moduleId, requestedVersion = null, options = {}) {
  const { definition, resolvedVersion, missingEffect, requestedVersion: reqVersion, upgradedFromVersion } =
    resolveEffectDefinitionWithStatus(effectId, requestedVersion, options);

  if (!definition || missingEffect) {
    return {
      moduleMetadata: null,
      resolvedVersion: null,
      missingEffect: true,
      requestedVersion: reqVersion,
    };
  }

  const manifestModules = definition?.manifest?.modules;
  if (!Array.isArray(manifestModules)) {
    return {
      moduleMetadata: null,
      resolvedVersion,
      missingEffect: false,
      missingModuleId: true,
      requestedVersion: reqVersion,
      upgradedFromVersion,
    };
  }

  const entry = manifestModules.find((module) => {
    if (!module) return false;
    const candidateId = module.id ?? module.moduleId ?? null;
    return candidateId === moduleId;
  });

  if (!entry) {
    return {
      moduleMetadata: null,
      resolvedVersion,
      missingEffect: false,
      missingModuleId: true,
      requestedVersion: reqVersion,
      upgradedFromVersion,
    };
  }

  return {
    moduleMetadata: {
      id: entry.id ?? entry.moduleId ?? null,
      label: entry.label ?? null,
      description: entry.description ?? null,
      dimensionId: entry.dimensionId ?? entry.dimension ?? null,
      dimensionLabel: entry.dimensionLabel ?? null,
    },
    resolvedVersion,
    missingEffect: false,
    missingModuleId: false,
    requestedVersion: reqVersion,
    upgradedFromVersion,
  };
}
