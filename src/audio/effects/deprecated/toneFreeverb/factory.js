import { EFFECT_MANIFEST } from './manifest.js';

function resolvePath(target, path) {
  const segments = Array.isArray(path) ? path : String(path).split('.');
  const leaf = segments.pop();
  let context = target;
  for (const segment of segments) {
    if (context == null) break;
    context = context[segment];
  }
  return { context, leaf };
}

function setToneValue(node, path, value, rampSeconds = 0) {
  const { context, leaf } = resolvePath(node, path);
  if (!context || !leaf) return;
  const property = context[leaf];
  if (property && typeof property === 'object' && 'value' in property) {
    if (rampSeconds > 0 && typeof property.rampTo === 'function') {
      property.rampTo(value, rampSeconds);
    } else {
      property.value = value;
    }
  } else {
    context[leaf] = value;
  }
}

function getToneProperty(node, path) {
  const { context, leaf } = resolvePath(node, path);
  if (!context || !leaf) return null;
  const property = context[leaf];
  if (property && typeof property === 'object' && 'value' in property) {
    return property;
  }
  return property ?? null;
}

function applyFixedParams(node, fixed) {
  if (!fixed) return;
  Object.entries(fixed).forEach(([property, value]) => {
    if (typeof value === 'undefined') return;
    setToneValue(node, property, value);
  });
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function createModule({ node, manifest, moduleSpec }) {
  const range = moduleSpec.valueRange || manifest.userParamSpec?.range || null;
  // Get all mapped parameters instead of single target
  const parameterMappings = moduleSpec.parameterMappings || {};
  const mappedParameters = Object.keys(parameterMappings);
  const primaryParam = moduleSpec.control?.audioParam || mappedParameters[0] || null;
  let automationBridge = null;
  
  const getTargetParam = () => getToneProperty(node, mappedParameters[0]); // Return first parameter for compatibility
  const fixedParams = Object.entries(moduleSpec.fixed || {}).map(([property, value]) => ({
    property,
    value,
  }));

  const applyValue = (value) => {
    const numeric = toNumber(value);
    if (numeric == null) return;
    
    try {
      // Apply all parameter mappings
      Object.entries(parameterMappings).forEach(([paramName, paramRange]) => {
        const uiRange = range || { min: 0, max: 100 };
        
        // Normalize UI value to 0-1
        const normalized = (numeric - uiRange.min) / (uiRange.max - uiRange.min);
        
        // Map to parameter range
        const mappedValue = paramRange.min + (paramRange.max - paramRange.min) * normalized;
        
        if (automationBridge?.ramp && primaryParam && paramName === primaryParam) {
          automationBridge.ramp(mappedValue);
        } else {
          setToneValue(node, paramName, mappedValue);
        }
      });
    } catch (error) {
      console.warn('[ToneFreeverbEffect] Failed to apply value', error);
    }
  };

  const userParam = {
    id: manifest.userParamSpec?.id ?? manifest.inputParam,
    label: manifest.userParamSpec?.label ?? 'Input',
    toneProperty: mappedParameters.join(','), // Show all mapped parameters
    tonePropertyTargets: mappedParameters,
    description: moduleSpec.description,
    valueRange: range,
    applyValue,
    getTargetParam,
  };

  return {
    id: moduleSpec.id,
    label: moduleSpec.label,
    description: moduleSpec.description,
    inputParam: manifest.inputParam,
    toneProperty: userParam.toneProperty,
    tonePropertyDescription: moduleSpec.description,
    valueRange: range,
    fixedParams,
    userParams: [userParam],
    getTargetParam,
    applyValue,
    configure() {
      applyFixedParams(node, moduleSpec.fixed);
    },
    getMappings() {
      return [];
    },
    getDefaultMappings() {
      return [];
    },
    setMappings() {},
    setAutomationBridge(bridge) {
      automationBridge = bridge;
    },
  };
}

export function createToneFreeverbEffect({ Tone, settings } = {}) {
  if (!Tone?.Freeverb) {
    throw new Error('[ToneFreeverbEffect] Tone.Freeverb constructor is required.');
  }

  const isSettingsArray = Array.isArray(settings);
  const ctorArgs = isSettingsArray
    ? settings
    : [{ ...EFFECT_MANIFEST.defaults, ...(settings || {}) }];

  const node = isSettingsArray
    ? new Tone.Freeverb(...ctorArgs)
    : new Tone.Freeverb(ctorArgs[0]);

  const modules = EFFECT_MANIFEST.modules.map((moduleSpec) =>
    createModule({ node, manifest: EFFECT_MANIFEST, moduleSpec }),
  );

  modules[0]?.configure?.();

  return {
    id: EFFECT_MANIFEST.id,
    label: EFFECT_MANIFEST.label,
    version: EFFECT_MANIFEST.version,
    inputParam: EFFECT_MANIFEST.inputParam,
    node,
    modules,
    configureModule(moduleId) {
      const module = modules.find((item) => item.id === moduleId);
      module?.configure?.();
    },
    dispose() {
      modules.splice(0, modules.length);
      if (typeof node.dispose === 'function') {
        node.dispose();
      }
    },
    manifest: EFFECT_MANIFEST,
  };
}

export default createToneFreeverbEffect;
