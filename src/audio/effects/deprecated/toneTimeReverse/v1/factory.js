import { EFFECT_MANIFEST } from './manifest.js';

const RATE_EPSILON = 0.0005;

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function semitoneToRatio(semitones, Tone) {
  const numeric = toNumber(semitones, 0);
  if (!Number.isFinite(numeric)) return 1;
  if (Tone?.intervalToFrequencyRatio) {
    return Tone.intervalToFrequencyRatio(numeric);
  }
  return Math.pow(2, numeric / 12);
}

function mapPercentValue(value, range = {}) {
  const min = toNumber(range?.min, -100);
  const max = toNumber(range?.max, 100);
  const percent = clamp(toNumber(value, 0), min, max);
  const reverse = percent < 0;
  const rateFactor = 1 + Math.abs(percent) / 100;
  const playbackRate = Math.max(0.01, rateFactor);
  return { playbackRate, reverse };
}

function mapSemitoneValue(value, range, Tone, quantizeStep = 1) {
  const min = toNumber(range?.min, -12);
  const max = toNumber(range?.max, 12);
  const clamped = clamp(toNumber(value, 0), min, max);
  const snapped = Math.round(clamped / quantizeStep) * quantizeStep;
  const reverse = snapped < 0;
  const playbackRate = semitoneToRatio(Math.abs(snapped), Tone);
  return { playbackRate, reverse };
}

function createModule({ moduleSpec, playbackController, Tone }) {
  const range = moduleSpec.valueRange || EFFECT_MANIFEST.userParamSpec?.range || null;
  const isQuantized = Boolean(range?.quantize);
  const quantizeStep = Number(range?.quantize?.step ?? 1) || 1;

  let automationBridge = null;
  let lastPlaybackRate = null;
  let lastReverse = null;
  let lastInput = null;

  const applyValue = (value) => {
    if (!playbackController) return;
    if (value === lastInput && lastPlaybackRate !== null) return;
    lastInput = value;

    const mapping = isQuantized
      ? mapSemitoneValue(value, range, Tone, quantizeStep)
      : mapPercentValue(value, range);

    if (
      lastPlaybackRate === null ||
      Math.abs(lastPlaybackRate - mapping.playbackRate) > RATE_EPSILON
    ) {
      if (automationBridge?.ramp) {
        automationBridge.ramp(mapping.playbackRate);
      } else {
        playbackController?.setPlaybackRate?.(mapping.playbackRate);
      }
      lastPlaybackRate = mapping.playbackRate;
    }

    if (lastReverse !== mapping.reverse) {
      playbackController?.setPlaybackReverse?.(mapping.reverse, { retrigger: true });
      lastReverse = mapping.reverse;
    }
  };

  return {
    id: moduleSpec.id,
    label: moduleSpec.label,
    description: moduleSpec.description,
    inputParam: EFFECT_MANIFEST.inputParam,
    toneProperty: moduleSpec.target,
    tonePropertyDescription: moduleSpec.description,
    valueRange: range,
    userParams: [],
    configure() {},
    applyValue,
    getTargetParam: () => playbackController?.getPlaybackRateParam?.() ?? null,
    getMappings: () => [],
    getDefaultMappings: () => [],
    setMappings: () => {},
    setAutomationBridge(bridge) {
      automationBridge = bridge;
      if (bridge && lastPlaybackRate !== null) {
        automationBridge.ramp(lastPlaybackRate);
      }
    },
  };
}

export function createToneTimeReverseEffect({ Tone, settings } = {}) {
  if (!Tone?.Gain) {
    throw new Error('[ToneTimeReverseEffect] Tone.Gain constructor is required.');
  }

  const playbackController = settings?.playbackController ?? null;
  const node = new Tone.Gain(1);

  const modules = EFFECT_MANIFEST.modules.map((moduleSpec) =>
    createModule({ moduleSpec, playbackController, Tone }),
  );

  return {
    id: EFFECT_MANIFEST.id,
    label: EFFECT_MANIFEST.label,
    version: EFFECT_MANIFEST.version,
    inputParam: EFFECT_MANIFEST.inputParam,
    node,
    modules,
    configureModule() {},
    dispose() {
      modules.splice(0, modules.length);
      if (typeof node.dispose === 'function') {
        node.dispose();
      }
    },
    manifest: EFFECT_MANIFEST,
  };
}

export default createToneTimeReverseEffect;
