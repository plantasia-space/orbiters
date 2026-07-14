/**
 * @file entityResolver.js
 * @description Deterministic resolver that loads Tracks → Orbiters → Entangled Worlds,
 * respecting hydrated payloads and emitting rich debug metadata.
 * 
 * Key Features:
 * - Single-pass resolution (no double-loading)
 * - Hydration-aware (reuses pre-fetched data)
 * - Deterministic fallback chain (Track → Orbiter → World)
 * - Rich debug metadata for troubleshooting
 * 
 * @version 1.0.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2025-11-01
 */

import { assembleConfig } from '../api/dataManager/assembler.js';
import { loadFromHydratedSession } from '../api/dataManager/hydration.js';
import { sanitizeId } from './sessionDescriptor.js';
import { Constants } from '../config/Constants.js';
import { cloneStacksState } from '../core/stackUtils.js';
import { effectsFromStacks } from './editModeHelpers.js';

/**
 * @typedef {Object} SessionResolutionInput
 * @property {Object} descriptor - Normalized descriptor ({ trackId, orbiterId, entangledWorldId, ... }).
 * @property {Object} [hydratedBlobs] - Optional hydrated payloads ({ trackSession, orbiterSession, entangledWorldSession }).
 * @property {string} [source] - Provenance of the descriptor ('url', 'host', 'hydrated', 'fallback').
 */

/**
 * @typedef {Object} SessionResolutionResult
 * @property {boolean} ok - Whether resolution succeeded
 * @property {Object|null} track - Resolved track entity
 * @property {Object|null} orbiter - Resolved orbiter entity
 * @property {Object|null} entangledWorld - Resolved world entity
 * @property {Object|null} request - Final request descriptor used
 * @property {Object} debug - Debug metadata
 * @property {string} debug.source - Input source
 * @property {Object} debug.descriptor - Normalized input descriptor
 * @property {Object} debug.hydrated - Which entities were hydrated
 * @property {string} debug.strategy - Resolution strategy used
 * @property {Array} debug.steps - Per-entity resolution steps
 * @property {Array} debug.fallbacks - List of fallbacks applied
 * @property {Array} debug.warnings - Non-critical issues
 * @property {Array} debug.errors - Critical errors
 * @property {Object} debug.resolved - Final resolved IDs
 * @property {Object} debug.performance - Timing information
 * @property {boolean} debug.cachedSession - Whether session was from cache
 * @property {Error|undefined} error - Error object if resolution failed
 */

const ENTITY_KEYS = /** @type {const} */ (['track', 'orbiter', 'entangledWorld']);

function normalizeDescriptor(descriptor = {}) {
  return {
    trackId: sanitizeId(descriptor.trackId),
    trackVersion: sanitizeId(descriptor.trackVersion),
    orbiterId: sanitizeId(descriptor.orbiterId),
    orbiterVersion: sanitizeId(descriptor.orbiterVersion),
    entangledWorldId: sanitizeId(descriptor.entangledWorldId),
    entangledWorldVersion: sanitizeId(descriptor.entangledWorldVersion),
  };
}

function hasHydratedPayload(hydrated = {}) {
  return Boolean(hydrated.trackSession || hydrated.orbiterSession || hydrated.entangledWorldSession);
}

function buildStep({ entity, requested, resolved, hydrated, track, orbiter }) {
  const step = {
    entity,
    requested: requested ?? null,
    resolved: resolved ?? null,
    hydrated: Boolean(hydrated),
    fallback: null,
    status: resolved ? 'resolved' : 'missing',
  };

  // Detect orbiter fallback scenarios
  if (entity === 'orbiter' && !requested && resolved && track?.defaultOrbiterId === resolved) {
    step.fallback = 'track-default';
  }
  
  // Detect world fallback scenarios
  if (entity === 'entangledWorld') {
    const defaultWorld = track?.defaultEntangledWorldId || orbiter?.defaultEntangledWorldId || null;
    if (!requested && resolved && defaultWorld === resolved) {
      step.fallback = 'track-orbiter-default';
    }
  }
  
  // Detect override scenarios (requested but got different)
  if (requested && resolved && requested !== resolved) {
    step.fallback = 'resolved-different';
    step.status = 'overridden';
  }
  
  return step;
}

/**
 * Checks if the session is already cached in Constants.
 * @param {Object} descriptor - Normalized descriptor
 * @returns {boolean}
 */
function isSessionCached(descriptor) {
  try {
    const configKey = Constants.buildConfigKey(descriptor);
    const cached = Constants.getCurrentConfig(configKey);
    return Boolean(cached);
  } catch {
    return false;
  }
}

/**
 * Resolves session entities using deterministic ordering (Track → Orbiter → Entangled World).
 * 
 * Resolution Strategy:
 * 1. If hydrated payloads exist → use loadFromHydratedSession
 * 2. Otherwise → use assembleConfig (network fetch with caching)
 * 3. Detect and report fallbacks, cache hits, and errors
 * 
 * @param {SessionResolutionInput} params
 * @returns {Promise<SessionResolutionResult>}
 */
export async function resolveSessionEntities({
  descriptor = {},
  hydratedBlobs = {},
  source = 'unknown',
} = {}) {
  const startTime = performance.now();
  const normalizedDescriptor = normalizeDescriptor(descriptor);
  const hydratedFlags = {
    track: Boolean(hydratedBlobs?.trackSession),
    orbiter: Boolean(hydratedBlobs?.orbiterSession),
    entangledWorld: Boolean(hydratedBlobs?.entangledWorldSession),
  };
  
  const cachedSession = isSessionCached(normalizedDescriptor);

  const debug = {
    source,
    descriptor: normalizedDescriptor,
    hydrated: { ...hydratedFlags },
    strategy: hasHydratedPayload(hydratedBlobs) ? 'hydrated-first' : 'network',
    cachedSession,
    steps: [],
    fallbacks: [],
    warnings: [],
    errors: [],
    performance: {
      startTime,
      endTime: 0,
      durationMs: 0,
    },
  };

  // Preflight validation
  if (!normalizedDescriptor.trackId) {
    const error = new Error('trackId is required to resolve session entities.');
    debug.errors.push({ stage: 'preflight', message: error.message });
    debug.performance.endTime = performance.now();
    debug.performance.durationMs = debug.performance.endTime - startTime;
    
    return {
      ok: false,
      track: null,
      orbiter: null,
      entangledWorld: null,
      request: null,
      debug,
      error,
    };
  }

  let combined = null;
  let caughtError = null;

  const stageLabel = debug.strategy === 'hydrated-first' ? 'hydrate-load' : 'assemble-config';

  try {
    if (debug.strategy === 'hydrated-first') {
      combined = await loadFromHydratedSession({
        trackSession: hydratedBlobs.trackSession ?? null,
        orbiterSession: hydratedBlobs.orbiterSession ?? null,
        entangledWorldSession: hydratedBlobs.entangledWorldSession ?? null,
        descriptor: normalizedDescriptor,
      });
    } else {
      combined = await assembleConfig(normalizedDescriptor);
    }

    if (hydratedBlobs.orbiterSession && combined) {
      const sessionPayload = hydratedBlobs.orbiterSession;
      const hydratedStacks =
        sessionPayload.stacks && typeof sessionPayload.stacks === 'object'
          ? cloneStacksState(sessionPayload.stacks)
          : null;
      const hydratedSelection =
        sessionPayload.selection && typeof sessionPayload.selection === 'object'
          ? { ...sessionPayload.selection }
          : null;
      const hydratedEngine =
        sessionPayload.engine && typeof sessionPayload.engine === 'object'
          ? { ...sessionPayload.engine }
          : null;

      if (!combined.orbiter || typeof combined.orbiter !== 'object') {
        combined.orbiter = {};
      }

      if (hydratedStacks) {
        combined.orbiter.stacks = hydratedStacks;
        combined.orbiter.effects = effectsFromStacks(hydratedStacks, { includeAllDimensions: true });
      }

      if (hydratedSelection) {
        combined.orbiter.selection = hydratedSelection;
        combined.orbiter.stackSelection = hydratedSelection;
      }

      if (hydratedEngine) {
        combined.orbiter.engine = {
          ...(combined.orbiter.engine || {}),
          ...hydratedEngine,
        };
      }

      combined.orbiter.sessionState = {
        ...sessionPayload,
        stacks: hydratedStacks || sessionPayload.stacks || null,
      };
    }
  } catch (error) {
    caughtError = error instanceof Error ? error : new Error(String(error));
    debug.errors.push({
      stage: stageLabel,
      entity: null,
      message: caughtError.message,
      stack: caughtError.stack,
    });
  }

  if (!combined || caughtError) {
    const error =
      caughtError || new Error('Failed to assemble session configuration (no payload returned).');
    if (!caughtError) {
      debug.errors.push({ stage: stageLabel, entity: null, message: error.message });
    }
    debug.performance.endTime = performance.now();
    debug.performance.durationMs = debug.performance.endTime - startTime;
    
    return {
      ok: false,
      track: null,
      orbiter: null,
      entangledWorld: null,
      request: null,
      debug,
      error,
    };
  }

  const track = combined.track ?? null;
  const orbiter = combined.orbiter ?? null;
  const entangledWorld = combined.entangledWorld ?? null;
  const resolvedRequest = combined.request ?? {};

  // Build ordered entity resolution steps
  const orderedEntities = {
    track: {
      requested: normalizedDescriptor.trackId,
      resolved: track?.trackId ?? resolvedRequest.trackId ?? null,
      hydrated: hydratedFlags.track,
    },
    orbiter: {
      requested: normalizedDescriptor.orbiterId,
      resolved: orbiter?.orbiterId ?? resolvedRequest.orbiterId ?? null,
      hydrated: hydratedFlags.orbiter,
    },
    entangledWorld: {
      requested: normalizedDescriptor.entangledWorldId,
      resolved: entangledWorld?.worldId ?? resolvedRequest.entangledWorldId ?? null,
      hydrated: hydratedFlags.entangledWorld,
    },
  };

  ENTITY_KEYS.forEach((entity) => {
    const step = buildStep({
      entity,
      requested: orderedEntities[entity].requested,
      resolved: orderedEntities[entity].resolved,
      hydrated: orderedEntities[entity].hydrated,
      track,
      orbiter,
    });
    debug.steps.push(step);
    
    if (step.fallback) {
      debug.fallbacks.push({ entity, reason: step.fallback });
    }
    
    // Add warnings for overrides
    if (step.status === 'overridden') {
      debug.warnings.push({
        entity,
        message: `Requested ${entity} '${step.requested}' was not available, using '${step.resolved}' instead.`,
      });
    }
  });

  debug.resolved = {
    trackId: orderedEntities.track.resolved,
    orbiterId: orderedEntities.orbiter.resolved,
    entangledWorldId: orderedEntities.entangledWorld.resolved,
  };
  
  debug.performance.endTime = performance.now();
  debug.performance.durationMs = debug.performance.endTime - startTime;

  const result = {
    ok: true,
    track,
    orbiter,
    entangledWorld,
    request: resolvedRequest,
    debug,
    error: undefined,
  };

  // Auto-log if debugging is enabled
  if (shouldLogResolution()) {
    try { console.debug(formatResolutionLog(result)); } catch (_) {}
  }

  return result;
}

export default resolveSessionEntities;

// ============================================================================
// Helper Functions for Testing and Debugging
// ============================================================================

/**
 * Formats the resolution result for console logging.
 * @param {SessionResolutionResult} result
 * @returns {string}
 */
export function formatResolutionLog(result) {
  const { ok, debug } = result;
  const lines = [
    `\n${'='.repeat(80)}`,
    `Session Resolution ${ok ? '✅ SUCCESS' : '❌ FAILED'}`,
    `${'='.repeat(80)}`,
    `Source: ${debug.source}`,
    `Strategy: ${debug.strategy}${debug.cachedSession ? ' (cached)' : ''}`,
    `Duration: ${debug.performance.durationMs.toFixed(2)}ms`,
    '',
    'Input Descriptor:',
    `  trackId: ${debug.descriptor.trackId || 'null'}`,
    `  orbiterId: ${debug.descriptor.orbiterId || 'null'}`,
    `  entangledWorldId: ${debug.descriptor.entangledWorldId || 'null'}`,
    '',
    'Resolution Steps:',
  ];

  debug.steps.forEach((step) => {
    const icon = step.status === 'resolved' ? '✓' : step.status === 'overridden' ? '⚠' : '✗';
    const hydrated = step.hydrated ? ' [hydrated]' : '';
    const fallback = step.fallback ? ` (${step.fallback})` : '';
    lines.push(`  ${icon} ${step.entity}: ${step.resolved || 'missing'}${hydrated}${fallback}`);
  });

  if (debug.fallbacks.length > 0) {
    lines.push('', 'Fallbacks Applied:');
    debug.fallbacks.forEach((fb) => {
      lines.push(`  - ${fb.entity}: ${fb.reason}`);
    });
  }

  if (debug.warnings.length > 0) {
    lines.push('', 'Warnings:');
    debug.warnings.forEach((warning) => {
      lines.push(`  ⚠ ${warning.entity}: ${warning.message}`);
    });
  }

  if (debug.errors.length > 0) {
    lines.push('', 'Errors:');
    debug.errors.forEach((error) => {
      lines.push(`  ✗ [${error.stage}] ${error.message}`);
    });
  }

  lines.push('', 'Final Resolution:');
  lines.push(`  trackId: ${debug.resolved?.trackId || 'null'}`);
  lines.push(`  orbiterId: ${debug.resolved?.orbiterId || 'null'}`);
  lines.push(`  entangledWorldId: ${debug.resolved?.entangledWorldId || 'null'}`);
  lines.push(`${'='.repeat(80)}\n`);

  return lines.join('\n');
}

/**
 * Enables verbose resolution logging (useful for debugging).
 */
export function enableResolutionLogging() {
  if (typeof window !== 'undefined') {
    window.__DEBUG_SESSION_RESOLUTION = true;
  }
}

/**
 * Disables verbose resolution logging.
 */
export function disableResolutionLogging() {
  if (typeof window !== 'undefined') {
    window.__DEBUG_SESSION_RESOLUTION = false;
  }
}

/**
 * Checks if resolution logging is enabled.
 * @returns {boolean}
 */
export function shouldLogResolution() {
  return typeof window !== 'undefined' && Boolean(window.__DEBUG_SESSION_RESOLUTION);
}
