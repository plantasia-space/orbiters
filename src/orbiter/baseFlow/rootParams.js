/**
 * @file src/orbiter/baseFlow/rootParams.js
 * @description Pure per-voice root-parameter hydration — registering a voice's root axes (x/y/z) and
 * its premix-deck-i level from track data. Extracted from createInitializeBaseFlow so BOTH the full
 * base flow AND the audio-only voice session (multi-orbiter secondaries) hydrate params
 * through the SAME code (no forked param path), WITHOUT dragging in the heavy boot graph
 * (Interaction → MIDIController → Main) that the full base flow imports.
 */
import { AXIS_ROTATION_CONSTRAINTS } from '../../config/Constants.js';
import { linear } from '../../core/Transformations.js';

const ROOT_AXES = ['x', 'y', 'z'];
const identity = (x) => x;

export function initializeRootParams(parameterManager, trackData) {
  const fallbackConfig = {
    value: 0,
    min: -60,
    max: 6,
    scale: 'linear',
    inputTransform: linear.inverse,
    outputTransform: linear.forward,
  };

  const premixKey = 'premix-deck-i';
  const incoming =
    trackData?.orbiter?.orbiterParams?.[premixKey] &&
    typeof trackData.orbiter.orbiterParams[premixKey] === 'object'
      ? trackData.orbiter.orbiterParams[premixKey]
      : {};

  const config = {
    ...fallbackConfig,
    ...incoming,
    value: Number.isFinite(incoming?.value ?? incoming?.initValue)
      ? Number(incoming.value ?? incoming.initValue)
      : fallbackConfig.value,
    min: Number.isFinite(incoming?.min) ? Number(incoming.min) : fallbackConfig.min,
    max: Number.isFinite(incoming?.max) ? Number(incoming.max) : fallbackConfig.max,
  };

  const normalized =
    typeof parameterManager.normalize === 'function' && config.max !== config.min
      ? parameterManager.normalize(config.value, config.min, config.max)
      : 0;

  parameterManager.addParameter(
    premixKey,
    normalized,
    config.min,
    config.max,
    true,
    config.scale,
    config.inputTransform,
    config.outputTransform,
  );
  parameterManager.setRawValue(premixKey, config.value);
}

export function hydrateRootAxesFromTrack(parameterManager, trackData) {
  if (!parameterManager || !trackData?.orbiter?.orbiterParams) {
    return;
  }

  const axisDefaults = {
    min: AXIS_ROTATION_CONSTRAINTS?.min ?? -180,
    max: AXIS_ROTATION_CONSTRAINTS?.max ?? 180,
    equilibrium: AXIS_ROTATION_CONSTRAINTS?.equilibrium ?? 0,
  };

  ROOT_AXES.forEach((axis) => {
    const paramConfig = trackData.orbiter.orbiterParams[axis];
    if (!paramConfig || typeof paramConfig !== 'object') return;

    const min = Number.isFinite(paramConfig.min) ? Number(paramConfig.min) : axisDefaults.min;
    const max = Number.isFinite(paramConfig.max) ? Number(paramConfig.max) : axisDefaults.max;
    const valueCandidate =
      Number.isFinite(paramConfig.value) ? Number(paramConfig.value) : Number(paramConfig.initValue);
    const value = Number.isFinite(valueCandidate) ? valueCandidate : axisDefaults.equilibrium;

    parameterManager.addParameter(
      axis,
      value,
      min,
      max,
      true,
      paramConfig.scale || 'linear',
      identity,
      identity
    );
    parameterManager.setRawValue(axis, value);
  });
}
