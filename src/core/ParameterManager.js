/**
 * @file ParameterManager.js
 * @description Manages application parameters, including adding, updating, subscribing, and emitting parameter changes.
 * Supports both single parameters and multidimensional parameters.
 * @version 2.1.0
 * @autor 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2025-10-25
 */

import { linear, logarithmic } from './Transformations.js';

export const PARAM_INTERNAL_PRECISION_DECIMALS = 9;
export const PARAM_DISPLAY_DECIMALS = 4;
const LIVE_UPDATE_INTENT = 'live';
const COMMIT_UPDATE_INTENT = 'commit';

export function formatParameterDisplayValue(value, decimals = PARAM_DISPLAY_DECIMALS) {
  const precision = Number.isInteger(decimals) && decimals >= 0 ? decimals : PARAM_DISPLAY_DECIMALS;
  return Number(value ?? 0).toFixed(precision);
}

function normalizeUpdateIntent(value, fallback = LIVE_UPDATE_INTENT) {
  return value === COMMIT_UPDATE_INTENT ? COMMIT_UPDATE_INTENT : fallback;
}

function resolveControllerUpdateIntent(sourceController = null) {
  if (!sourceController || typeof sourceController !== 'object') return null;
  if (typeof sourceController.getParameterUpdateIntent === 'function') {
    return sourceController.getParameterUpdateIntent();
  }
  return sourceController.parameterUpdateIntent ?? sourceController.updateIntent ?? null;
}

function resolveUpdateIntent(sourceController = null, options = {}) {
  const explicit = normalizeUpdateIntent(options?.updateIntent, null);
  if (explicit) return explicit;
  const fromController = normalizeUpdateIntent(resolveControllerUpdateIntent(sourceController), null);
  if (fromController) return fromController;
  if (sourceController == null) return COMMIT_UPDATE_INTENT;
  return LIVE_UPDATE_INTENT;
}

function buildParameterChangeMeta({
  sourceController = null,
  priority = Infinity,
  dimensionId = null,
  updateIntent = LIVE_UPDATE_INTENT,
  reason = 'value-change',
} = {}) {
  const normalizedIntent = normalizeUpdateIntent(updateIntent);
  return {
    sourceController,
    priority,
    dimensionId,
    updateIntent: normalizedIntent,
    isCommitted: normalizedIntent === COMMIT_UPDATE_INTENT,
    reason,
  };
}

/**
 * @class ParameterManager
 * @memberof CoreModule
 * @description Manages application parameters — their values, ranges, transformations, and
 * subscriber notifications. One instance PER orbiter voice (no process singleton);
 * each voice owns its own `parameters`/`lockedParams`/`lockedDimensions` store. The composition
 * root (`createOrbitersApp`) constructs the instance and threads it to every consumer via DI.
 */
export class ParameterManager {
  constructor() {
    /**
     * @type {Map<string, Parameter>}
     * @description Stores parameters mapped by their names.
     */
    this.parameters = new Map(); // Map of parameterName -> parameter object

    /**
     * @type {Set<string>}
     * @description Parameters that are currently locked across all dimensions.
     */
    this.lockedParams = new Set();

    /**
     * @type {Map<string, Set<string>>}
     * @description Dimension-specific locks. Key = paramName, Value = Set of locked dimensionIds.
     */
    this.lockedDimensions = new Map();
  }

  /**
   * Adds or updates a parameter with the given configuration.
   * If the parameter already exists, it updates its properties; otherwise, it creates a new parameter.
   * @public
   * @param {string} name - The unique name of the parameter.
   * @param {number} [normalizedValue=0] - The normalized value [0,1].
   * @param {number} [min=0] - The minimum raw value of the parameter.
   * @param {number} [max=1] - The maximum raw value of the parameter.
   * @param {boolean} [isBidirectional=false] - If true, allows two-way updates between controllers and parameters.
   * @param {string} [scale="linear"] - The scaling type of the parameter ("linear" or "logarithmic").
   * @param {function} [inputTransform=(x) => x] - Function to transform input values before setting rawValue.
   * @param {function} [outputTransform=(x) => x] - Function to transform raw values before notifying subscribers.
   *
   * @returns {void}
   *
   * @example
   * const paramManager = new ParameterManager();
   * paramManager.addParameter('volume', 0.5, 0, 100, true, 'linear');
   */
  addParameter(
    name,
    normalizedValue = 0,
    min = 0,
    max = 1,
    isBidirectional = false,
    scale = "linear",
    inputTransform = (x) => x,
    outputTransform = (x) => x
  ) {
    if (this.parameters.has(name)) {
      const param = this.parameters.get(name);
      let rangeChanged = false;
      let scaleChanged = false;

      if (min !== param.min || max !== param.max) {
        rangeChanged = true;
        param.min = min;
        param.max = max;
      }

      if (scale !== param.scale) {
        scaleChanged = true;
        param.scale = scale;
      }

      // Update raw and normalized values
      const transformedRawValue = inputTransform(normalizedValue);
      const clampedRawValue = Math.min(max, Math.max(min, transformedRawValue));
      const roundedRawValue = Number(clampedRawValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
      const updatedNormalizedValue = Number(this.normalize(roundedRawValue, min, max).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));

      param.rawValue = roundedRawValue;
      param.normalizedValue = updatedNormalizedValue;
      param.isBidirectional = isBidirectional;
      param.inputTransform = inputTransform;
      param.outputTransform = outputTransform;

      if (rangeChanged) {
        // Emit range update event
        this.emitRangeUpdate(name, min, max);
      }

      if (scaleChanged) {
        // Emit scale update event
        this.emitScaleUpdate(name, scale);
      }

      // Notify subscribers of value change
      const outputValue = param.outputTransform(param.rawValue);
      this.emitValueUpdate(name, Number(outputValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS)));

      return;
    }

    // Otherwise, create a new parameter
    const transformedRawValue = inputTransform(normalizedValue);
    const clampedRawValue = Math.min(max, Math.max(min, transformedRawValue));
    const roundedRawValue = Number(clampedRawValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
    const normalized = Number(this.normalize(roundedRawValue, min, max).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));

    this.parameters.set(name, {
      name,
      rawValue: roundedRawValue,
      normalizedValue: normalized,
      // The EQUILIBRIUM (reset/neutral) value, in raw units — snapshotted from the value
      // this parameter is FIRST registered with (e.g. 0 for the ±180 axes, 120 for BPM).
      // Distinct from the live rawValue; consumers (the numeric keypad's value slider)
      // read it via getParameter() to reset to it, so equilibria are declared ONCE at
      // registration and never hardcoded per control.
      defaultValue: roundedRawValue,
      min,
      max,
      subscribers: new Set(),
      isBidirectional,
      lastPriority: Infinity,
      lastUpdateTimestamp: 0,
      lastController: null,
      scale,
      inputTransform,
      outputTransform,
    });

    // Emit both range and value update events
    this.emitRangeUpdate(name, min, max);
    const initialOutputValue = outputTransform(roundedRawValue);
    this.emitValueUpdate(name, Number(initialOutputValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS)));
    this.emitScaleUpdate(name, scale);
  }

  /**
   * Adds or updates a multidimensional parameter that stores separate values per dimension.
   * @public
   * @param {string} name - The unique name of the parameter (e.g., "x", "y", "z").
   * @param {Array<string>} dimensionIds - Array of dimension IDs (e.g., ["EW::I", "EW::II", "EW::III"]).
   * @param {number} [defaultValue=0] - The default raw value for all dimensions.
   * @param {number} [min=0] - The minimum raw value of the parameter.
   * @param {number} [max=1] - The maximum raw value of the parameter.
   * @param {Object} [options={}] - Additional options.
   * @param {boolean} [options.isBidirectional=false] - If true, allows two-way updates.
   * @param {number} [options.step=0.01] - The step size for the parameter.
   * @param {string} [options.scope="DIMENSION"] - The scope of the parameter.
   * @param {string} [options.scale="linear"] - The scaling type ("linear" or "logarithmic").
   * @param {function} [options.inputTransform=(x) => x] - Function to transform input values.
   * @param {function} [options.outputTransform=(x) => x] - Function to transform output values.
   * @returns {void}
   * 
   * @example
   * paramManager.addMultidimensionalParameter(
   *   "x",
   *   ["EW::I", "EW::II", "EW::III"],
   *   0,    // default value (equilibrium)
   *   -180, // min
   *   180,  // max
   *   { isBidirectional: true, step: 0.01, scope: 'DIMENSION' }
   * );
   */
  addMultidimensionalParameter(
    name,
    dimensionIds,
    defaultValue = 0,
    min = 0,
    max = 1,
    options = {}
  ) {
    const {
      isBidirectional = false,
      step = 0.01,
      scope = "DIMENSION",
      scale = "linear",
      inputTransform = (x) => x,
      outputTransform = (x) => x
    } = options;

    if (this.parameters.has(name)) {
      // Reduce log noise: only log when explicitly debugging params
      try {
        
      } catch (_) {}
      const param = this.parameters.get(name);
      
      // Convert to multidimensional if not already
      if (!param.isMultidimensional) {
        param.isMultidimensional = true;
        param.scope = scope;
        param.dimensions = new Map();
        param.activeDimensionId = dimensionIds[0];
      }
      // Preserve any equilibrium set at first (single-dim) registration; otherwise seed it
      // from this call's defaultValue. The equilibrium is declared ONCE and stays stable.
      if (param.defaultValue == null) {
        param.defaultValue = Number(
          Math.min(max, Math.max(min, defaultValue)).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS),
        );
      }

      // Initialize/update dimensions
      dimensionIds.forEach(dimensionId => {
        if (!param.dimensions.has(dimensionId)) {
          const clampedValue = Math.min(max, Math.max(min, defaultValue));
          const roundedValue = Number(clampedValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
          const normalized = Number(this.normalize(roundedValue, min, max).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
          
          param.dimensions.set(dimensionId, {
            value: roundedValue,
            normalizedValue: normalized,
            min,
            max,
            lastPriority: Infinity,
            lastUpdateTimestamp: 0,
            lastController: null
          });
        }
      });

      param.min = min;
      param.max = max;
      param.isBidirectional = isBidirectional;
      param.step = step;
      param.scale = scale;
      param.inputTransform = inputTransform;
      param.outputTransform = outputTransform;

      return;
    }

    // Create new multidimensional parameter
    const dimensions = new Map();
    
    dimensionIds.forEach(dimensionId => {
      const clampedValue = Math.min(max, Math.max(min, defaultValue));
      const roundedValue = Number(clampedValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
      const normalized = Number(this.normalize(roundedValue, min, max).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
      
      dimensions.set(dimensionId, {
        value: roundedValue,
        normalizedValue: normalized,
        min,
        max,
        lastPriority: Infinity,
        lastUpdateTimestamp: 0,
        lastController: null
      });
    });

    this.parameters.set(name, {
      name,
      isMultidimensional: true,
      scope,
      dimensions,
      activeDimensionId: dimensionIds[0],
      // Equilibrium (reset) value in raw units — the `defaultValue` this param is registered
      // with (e.g. AXIS_EQ = 0). Read via getParameter() so resets are declared once here.
      defaultValue: Number(Math.min(max, Math.max(min, defaultValue)).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS)),
      subscribers: new Set(),
      isBidirectional,
      step,
      min,
      max,
      scale,
      inputTransform,
      outputTransform,
    });

    //console.log(`[ParameterManager] Created multidimensional parameter '${name}' with ${dimensionIds.length} dimensions`);
  }

  /**
   * Sets the value for a specific dimension of a multidimensional parameter.
   * @public
   * @param {string} paramName - The name of the parameter.
   * @param {string} dimensionId - The dimension ID to update.
   * @param {number} value - The new raw value to set.
   * @param {object|null} [sourceController=null] - The controller making the change.
   * @param {number} [priority=Infinity] - The priority of the update.
   * @returns {void}
   * 
   * @example
   * paramManager.setDimensionValue("x", "EW::I", -85, controller, 2);
   */
  setDimensionValue(paramName, dimensionId, value, sourceController = null, priority = Infinity, options = {}) {
    if (this.lockedParams.has(paramName)) return;
    if (this.isParameterDimensionLocked(paramName, dimensionId)) return;
    const param = this.parameters.get(paramName);
    
    if (!param) {
      console.warn(`[ParameterManager] setDimensionValue: Parameter '${paramName}' not found.`);
      return;
    }

    if (!param.isMultidimensional) {
      console.warn(`[ParameterManager] setDimensionValue: Parameter '${paramName}' is not multidimensional.`);
      return;
    }

    const dimensionState = param.dimensions.get(dimensionId);
    
    if (!dimensionState) {
      console.warn(`[ParameterManager] setDimensionValue: Dimension '${dimensionId}' not found for parameter '${paramName}'.`);
      return;
    }

    const now = Date.now();
    const simultaneousThreshold = 50; // 50 ms for "simultaneous" updates
    const isSimultaneous = now - (dimensionState.lastUpdateTimestamp || 0) < simultaneousThreshold;
    const isSameController = sourceController === dimensionState.lastController;

    const updateIntent = resolveUpdateIntent(sourceController, options);

    if (
      (!isSimultaneous || priority < dimensionState.lastPriority) ||
      (isSimultaneous && isSameController)
    ) {
      // Apply transformations
      const transformedValue = param.inputTransform(value);
      const clampedValue = Math.min(dimensionState.max, Math.max(dimensionState.min, transformedValue));
      const roundedValue = Number(clampedValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
      const normalizedValue = Number(this.normalize(roundedValue, dimensionState.min, dimensionState.max).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));

      const valueChanged = dimensionState.value !== roundedValue;
      const shouldNotifyUnchanged = options?.notifyIfUnchanged === true;
      if (valueChanged || shouldNotifyUnchanged) {
        // Log when LFO pushes a new value
        if (sourceController && typeof sourceController === 'string' && sourceController.startsWith('CosmicLFO:')) {
          //console.log(`[ParameterManager] ${sourceController} → ${paramName}:${dimensionId} = ${roundedValue.toFixed(3)} (was ${dimensionState.value.toFixed(3)})`);
        }

        if (valueChanged) {
          dimensionState.value = roundedValue;
          dimensionState.normalizedValue = normalizedValue;
        }
        dimensionState.lastPriority = priority;
        dimensionState.lastUpdateTimestamp = now;
        dimensionState.lastController = sourceController;
        const metadata = buildParameterChangeMeta({
          sourceController,
          priority,
          dimensionId,
          updateIntent,
          reason: valueChanged ? 'value-change' : 'unchanged-commit',
        });

        // Notify subscribers if this is the active dimension or they're listening to this specific dimension
        const notifiedCount = 0;
        param.subscribers.forEach(({ controller, priority: subPriority, dimensionId: subDimensionId }) => {
          const shouldNotify = 
            (subDimensionId === null && dimensionId === param.activeDimensionId) || // Listening to active dimension
            (subDimensionId === dimensionId); // Listening to this specific dimension

          if (shouldNotify && (controller !== sourceController || param.isBidirectional)) {
            if (typeof controller.onParameterChanged === 'function') {
              const transformedValue = param.outputTransform(dimensionState.value);
              const formattedValue = Number(transformedValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
              controller.onParameterChanged(paramName, formattedValue, dimensionId, metadata);
            }
          }
        });
      }
    }
  }

  /**
   * Gets the value for a specific dimension of a multidimensional parameter.
   * @public
   * @param {string} paramName - The name of the parameter.
   * @param {string} [dimensionId=null] - The dimension ID to get value from. If null, uses active dimension.
   * @returns {number|null} - The raw value or null if not found.
   * 
   * @example
   * const xValue = paramManager.getDimensionValue("x", "EW::I"); // -85
   */
  getDimensionValue(paramName, dimensionId = null) {
    const param = this.parameters.get(paramName);
    
    if (!param) {
      console.warn(`[ParameterManager] getDimensionValue: Parameter '${paramName}' not found.`);
      return null;
    }

    if (!param.isMultidimensional) {
      return param.rawValue; // Return regular parameter value
    }

    const targetDimensionId = dimensionId || param.activeDimensionId;
    const dimensionState = param.dimensions.get(targetDimensionId);

    return dimensionState ? dimensionState.value : null;
  }

  /**
   * Sets the active dimension for all multidimensional parameters.
   * Notifies subscribers that are listening to the "active dimension".
   * @public
   * @param {string} dimensionId - The dimension ID to make active.
   * @returns {void}
   * 
   * @example
   * paramManager.setActiveDimension("EW::II");
   */
  setActiveDimension(dimensionId) {
    //console.log(`[ParameterManager] Setting active dimension to: ${dimensionId}`);

    // Update active dimension for all multidimensional parameters
    this.parameters.forEach((param, paramName) => {
      if (param.isMultidimensional) {
        const previousDimensionId = param.activeDimensionId;
        
        if (previousDimensionId !== dimensionId) {
          param.activeDimensionId = dimensionId;
          //console.log(`[ParameterManager] Updated ${paramName}.activeDimensionId: ${previousDimensionId} → ${dimensionId}`);
          
          const dimensionState = param.dimensions.get(dimensionId);
          
          if (dimensionState) {
            // Notify all subscribers listening to "active dimension" (dimensionId = null)
            param.subscribers.forEach(({ controller, dimensionId: subDimensionId }) => {
              if (subDimensionId === null) { // Only notify active dimension subscribers
                if (typeof controller.onParameterChanged === 'function') {
                  const transformedValue = param.outputTransform(dimensionState.value);
                  const formattedValue = Number(transformedValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
                  const metadata = buildParameterChangeMeta({
                    dimensionId,
                    updateIntent: COMMIT_UPDATE_INTENT,
                    reason: 'active-dimension-change',
                  });
                  //console.log(`[ParameterManager] Notifying subscriber for ${paramName}: value=${formattedValue}, dimensionId=${dimensionId}`);
                  controller.onParameterChanged(paramName, formattedValue, dimensionId, metadata);
                }
              }
            });
          }
        }
      }
    });
  }

  /**
   * Emits a range update event for a parameter.
   * Notifies all subscribed controllers about the new range.
   * @private
   * @param {string} name - The name of the parameter.
   * @param {number} min - The new minimum value.
   * @param {number} max - The new maximum value.
   *
   * @returns {void}
   *
   * @example
   * this.emitRangeUpdate('volume', 0, 100);
   */
  emitRangeUpdate(name, min, max) {
    const param = this.parameters.get(name);
    param.subscribers.forEach(({ controller }) => {
      if (typeof controller.onRangeChanged === 'function') {
        controller.onRangeChanged(name, min, max);
      }
    });
    //console.debug(`[ParameterManager] Emitted range update for '${name}' with min=${min}, max=${max}`);
  }

  /**
   * Emits a value update event for a parameter.
   * Notifies all subscribed controllers about the new value.
   * @private
   * @param {string} name - The name of the parameter.
   * @param {number} value - The new transformed value.
   *
   * @returns {void}
   *
   * @example
   * this.emitValueUpdate('volume', 50);
   */
  emitValueUpdate(name, value) {
    const param = this.parameters.get(name);
    const metadata = buildParameterChangeMeta({
      updateIntent: COMMIT_UPDATE_INTENT,
      reason: 'emit-value-update',
    });
    param.subscribers.forEach(({ controller }) => {
      if (typeof controller.onParameterChanged === 'function') {
        controller.onParameterChanged(name, value, undefined, metadata);
      }
    });
    //console.debug(`[ParameterManager] Emitted value update for '${name}' with value=${value}`);
  }

  /**
   * Emits a scale update event for a parameter.
   * Notifies all subscribed controllers about the new scale type.
   * @private
   * @param {string} name - The name of the parameter.
   * @param {string} scale - The new scale type (e.g., "linear" or "logarithmic").
   *
   * @returns {void}
   *
   * @example
   * this.emitScaleUpdate('frequency', 'logarithmic');
   */
  emitScaleUpdate(name, scale) {
    const param = this.parameters.get(name);
    param.subscribers.forEach(({ controller }) => {
      if (typeof controller.onScaleChanged === 'function') {
        controller.onScaleChanged(name, scale);
      }
    });
    //console.debug(`[ParameterManager] Emitted scale update for '${name}' with scale=${scale}`);
  }

  /**
   * Subscribes a controller to a parameter with a specified priority.
   * Controllers with higher priority (lower number) receive updates first.
   * @public
   * @param {Controller} controller - The controller subscribing to the parameter. Must implement callback methods.
   * @param {string} parameterName - The name of the parameter to subscribe to.
   * @param {number} [priority=Infinity] - The priority of the controller (1 is highest).
   * @param {string|null} [dimensionId=null] - For multidimensional parameters: null = active dimension, string = specific dimension.
   *
   * @returns {void}
   *
   * @throws Will log an error if the controller does not implement 'onParameterChanged'.
   *
   * @example
   * const controller = {
   *   onParameterChanged: (name, value, dimensionId) => { console.log(`${name} changed to ${value} in ${dimensionId}`); },
   *   onRangeChanged: (name, min, max) => {  },
   *   onScaleChanged: (name, scale) => {  },
   * };
   * const paramManager = new ParameterManager();
   * paramManager.subscribe(controller, 'x', 2, null); // Subscribe to active dimension
   * paramManager.subscribe(controller, 'x', 1, 'EW::II'); // Subscribe to specific dimension
   */
  subscribe(controller, parameterName, priority = Infinity, dimensionId = null) {
    if (typeof controller.onParameterChanged !== 'function') {
      console.error(`Controller must implement 'onParameterChanged' method.`);
      return;
    }

    if (this.parameters.has(parameterName)) {
      const param = this.parameters.get(parameterName);
      param.subscribers.add({ controller, priority, dimensionId });
      //console.debug(`[subscribe] Controller subscribed to '${parameterName}' with priority ${priority}, dimensionId: ${dimensionId || 'active'}`);
    } else {
      // console.warn(`Parameter '${parameterName}' does not exist. Adding with default values.`);
      // Initialize with default normalized value 0
      this.addParameter(parameterName, 0, 0, 1, false);
      const param = this.parameters.get(parameterName);
      param.subscribers.add({ controller, priority, dimensionId });
      //console.debug(`[subscribe] Controller subscribed to newly added parameter '${parameterName}' with priority ${priority}`);
    }

    // Immediately notify the controller of the current value
    const param = this.parameters.get(parameterName);
    if (param) {
      if (param.isMultidimensional) {
        const targetDimensionId = dimensionId || param.activeDimensionId;
        const dimensionState = param.dimensions.get(targetDimensionId);
        if (dimensionState) {
          const transformedValue = param.outputTransform(dimensionState.value);
          const metadata = buildParameterChangeMeta({
            dimensionId: targetDimensionId,
            updateIntent: COMMIT_UPDATE_INTENT,
            reason: 'subscribe',
          });
          controller.onParameterChanged?.(parameterName, transformedValue, targetDimensionId, metadata);
          controller.onParameterChangedAny?.(parameterName, transformedValue, targetDimensionId);
        }
      } else {
        const transformedValue = param.outputTransform(param.rawValue);
        const metadata = buildParameterChangeMeta({
          updateIntent: COMMIT_UPDATE_INTENT,
          reason: 'subscribe',
        });
        controller.onParameterChanged(parameterName, transformedValue, undefined, metadata);
      }
    }
  }

  /**
   * Unsubscribes a controller from a parameter.
   * Removes the controller from the parameter's subscriber list.
   * @public
   * @param {object} controller - The controller to unsubscribe.
   * @param {string} parameterName - The name of the parameter to unsubscribe from.
   *
   * @returns {void}
   *
   * @example
   * paramManager.unsubscribe(controller, 'volume');
   */
  unsubscribe(controller, parameterName) {
    if (this.parameters.has(parameterName)) {
      const param = this.parameters.get(parameterName);
      const initialSize = param.subscribers.size;
      param.subscribers = new Set(
        [...param.subscribers].filter((sub) => sub.controller !== controller)
      );
      if (param.subscribers.size < initialSize) {
        //console.debug(`[unsubscribe] Controller unsubscribed from '${parameterName}'`);
      } else {
        console.warn(`[unsubscribe] Controller was not subscribed to '${parameterName}'`);
      }
    } else {
      console.warn(`[unsubscribe] Parameter '${parameterName}' does not exist.`);
    }
  }

  /**
   * Updates the raw value of a parameter and notifies subscribers.
   * For multidimensional parameters, updates the active dimension.
   * Handles bidirectional updates if enabled and ensures priority rules.
   * @public
   * @param {string} parameterName - The name of the parameter to update.
   * @param {number} rawValue - The new raw value to set.
   * @param {object|null} [sourceController=null] - The controller making the change (optional).
   * @param {number} [priority=Infinity] - The priority of the update (1 is highest).
   *
   * @returns {void}
   *
   * @example
   * paramManager.setRawValue('volume', 75, controller, 1);
   * paramManager.setRawValue('x', -85, controller, 2); // Updates active dimension for multidimensional param
   */
  setRawValue(parameterName, rawValue, sourceController = null, priority = Infinity, options = {}) {
    if (this.lockedParams.has(parameterName)) return;
    if (this.parameters.has(parameterName)) {
      const param = this.parameters.get(parameterName);
      const updateIntent = resolveUpdateIntent(sourceController, options);

      // Handle multidimensional parameters
      if (param.isMultidimensional) {
        ////console.log(`[ParameterManager] setRawValue('${parameterName}'): param.activeDimensionId = ${param.activeDimensionId}`);
        this.setDimensionValue(
          parameterName,
          param.activeDimensionId,
          rawValue,
          sourceController,
          priority,
          options,
        );
        return;
      }

      // Original single parameter logic
      const now = Date.now();
      const simultaneousThreshold = 50; // 50 ms for "simultaneous" updates

      // Determine if this update is "simultaneous"
      const isSimultaneous = now - (param.lastUpdateTimestamp || 0) < simultaneousThreshold;

      // Check if the source controller is the same
      const isSameController = sourceController === param.lastController;

      if (
        (!isSimultaneous || priority < param.lastPriority) ||
        (isSimultaneous && isSameController)
      ) {
        // Apply inputTransform to the incoming rawValue
        const transformedRawValue = param.inputTransform(rawValue);

        const clampedRawValue = Math.min(param.max, Math.max(param.min, transformedRawValue)); // Clamp rawValue to the range
        const roundedRawValue = Number(clampedRawValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
        const normalizedValue = Number(this.normalize(roundedRawValue, param.min, param.max).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));

        const valueChanged = param.rawValue !== roundedRawValue;
        const shouldNotifyUnchanged = options?.notifyIfUnchanged === true;
        if (valueChanged || shouldNotifyUnchanged) {
          if (valueChanged) {
            param.rawValue = roundedRawValue;
            param.normalizedValue = normalizedValue;
          }
          param.lastPriority = priority;
          param.lastUpdateTimestamp = now;
          param.lastController = sourceController;
          const metadata = buildParameterChangeMeta({
            sourceController,
            priority,
            updateIntent,
            reason: valueChanged ? 'value-change' : 'unchanged-commit',
          });

          //console.debug(`[setRawValue] Updated '${parameterName}' to rawValue=${param.rawValue}, normalizedValue=${param.normalizedValue}`);

          // Notify subscribers
          param.subscribers.forEach(({ controller }) => {
            if (controller !== sourceController || param.isBidirectional) {
              if (typeof controller.onParameterChanged === 'function') {
                // Apply the output transformation before notifying
                const transformedValue = param.outputTransform(param.rawValue);
                const formattedValue = Number(transformedValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
                //console.debug(`[setRawValue] Notifying controller of '${parameterName}' with value=${transformedValue}`);
                controller.onParameterChanged(parameterName, formattedValue, undefined, metadata);
              } else {
                console.warn(`[setRawValue] Controller does not implement 'onParameterChanged' or 'onParameterChangedAny':`, controller);
              }
            }
          });
        } else {
          //console.debug(`[setRawValue] No change in rawValue for '${parameterName}'. Update skipped.`);
        }
      } else {
        //console.debug(`[setRawValue] Update for '${parameterName}' ignored due to priority or simultaneous threshold.`);
      }
    } else {
      console.warn(`[setRawValue] Parameter '${parameterName}' not found.`);
    }
  }

  /**
   * Sets the value from a controller by applying the inputTransform.
   * Facilitates controller-driven updates with priority handling.
   * @public
   * @param {string} parameterName - The name of the parameter to update.
   * @param {number} controllerValue - The normalized value from the controller [0, 1].
   * @param {object|null} [sourceController=null] - The controller making the change (optional).
   * @param {number} [priority=Infinity] - The priority of the update (1 is highest).
   *
   * @returns {void}
   *
   * @example
   * paramManager.setControllerValue('balance', 0.8, controller, 2);
   */
  setControllerValue(parameterName, controllerValue, sourceController = null, priority = Infinity) {
    if (this.lockedParams.has(parameterName)) return;
    if (this.parameters.has(parameterName)) {
      const param = this.parameters.get(parameterName);
      // Apply inputTransform to controllerValue to get rawValue
      const rawValue = param.inputTransform(controllerValue);
      this.setRawValue(parameterName, rawValue, sourceController, priority);
    } else {
      console.warn(`[ParameterManager] setControllerValue: Parameter '${parameterName}' not found.`);
    }
  }

  /**
   * Updates the normalized value of a parameter and notifies subscribers.
   * Converts normalized to raw before updating.
   * Handles priority and simultaneous updates.
   * @public
   * @param {string} parameterName - The name of the parameter to update.
   * @param {number} normalizedValue - The new normalized value to set [0, 1].
   * @param {object|null} [sourceController=null] - The controller making the change (optional).
   * @param {number} [priority=Infinity] - The priority of the update (1 is highest).
   *
   * @returns {void}
   *
   * @example
   * paramManager.setNormalizedValue('frequency', 0.75, controller, 1);
   */
  setNormalizedValue(parameterName, normalizedValue, sourceController = null, priority = Infinity, options = {}) {
    if (this.lockedParams.has(parameterName)) return;
    if (this.parameters.has(parameterName)) {
      const param = this.parameters.get(parameterName);
      const updateIntent = resolveUpdateIntent(sourceController, options);

      const now = Date.now();
      const simultaneousThreshold = 50; // 50 ms for "simultaneous" updates

      // Determine if this update is "simultaneous"
      const isSimultaneous = now - (param.lastUpdateTimestamp || 0) < simultaneousThreshold;

      // Check if the source controller is the same
      const isSameController = sourceController === param.lastController;

      if (
        (!isSimultaneous || priority < param.lastPriority) ||
        (isSimultaneous && isSameController)
      ) {
        // Denormalize the normalized value to rawValue
        const denormalizedValue = this.denormalize(normalizedValue, param.min, param.max);

        // Apply inputTransform to the denormalized value
        const transformedRawValue = param.inputTransform(denormalizedValue);

        const clampedRawValue = Math.min(param.max, Math.max(param.min, transformedRawValue)); // Clamp rawValue to the range
        const roundedRawValue = Number(clampedRawValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
        const updatedNormalizedValue = Number(this.normalize(roundedRawValue, param.min, param.max).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));


        const valueChanged = param.rawValue !== roundedRawValue || param.normalizedValue !== normalizedValue;
        const shouldNotifyUnchanged = options?.notifyIfUnchanged === true;

        if (valueChanged || shouldNotifyUnchanged) {
          if (valueChanged) {
            param.rawValue = roundedRawValue;
            param.normalizedValue = updatedNormalizedValue;
          }
          param.lastPriority = priority;
          param.lastUpdateTimestamp = now;
          param.lastController = sourceController;
          const metadata = buildParameterChangeMeta({
            sourceController,
            priority,
            updateIntent,
            reason: valueChanged ? 'value-change' : 'unchanged-commit',
          });


          // Notify subscribers
          param.subscribers.forEach(({ controller }) => {
            //console.debug(`[Notification Check] Controller: ${controller.constructor.name}, Source: ${sourceController?.constructor.name}`);
            if (controller !== sourceController || param.isBidirectional) {
                //console.debug(`[Notify Subscriber] Notifying '${controller.constructor.name}' for '${parameterName}' with value=${param.rawValue}`);
                if (typeof controller.onParameterChanged === 'function') {
                    const transformedValue = param.outputTransform(param.rawValue);
                    const formattedValue = Number(transformedValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
                    controller.onParameterChanged(parameterName, formattedValue, undefined, metadata);
                } else {
                    console.warn(`[Notification Warning] Controller does not implement 'onParameterChanged':`, controller);
                }
            } else {
                //console.debug(`[Notification Skipped] SourceController matches and parameter is not bidirectional.`);
            }
        });
        } else {
          //console.debug(`[setNormalizedValue] No change in normalizedValue for '${parameterName}'. Update skipped.`);
        }
      } else {
        //console.debug(`[setNormalizedValue] Update for '${parameterName}' ignored due to priority or simultaneous threshold.`);
      }
    }
  }

  /**
   * Sets the parameter to the middle (normalized value of 0.5) directly,
   * without any priority or simultaneous logic.
   * @public
   * @param {string} parameterName - The name of the parameter to set to middle.
   *
   * @returns {void}
   *
   * @example
   * paramManager.setToMiddle('balance');
   */
  setToMiddle(parameterName) {
    if (this.lockedParams.has(parameterName)) return;
    const param = this.parameters.get(parameterName);
    if (!param) {
      console.warn(`[setToMiddle] Parameter '${parameterName}' does not exist.`);
      return;
    }

    // Calculate the middle in raw terms
    const rawMid = Number(((param.min + param.max) / 2).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
    param.rawValue = rawMid;
    param.normalizedValue = Number(0.5.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));

    // Directly notify all subscribers (no checks)
    param.subscribers.forEach(({ controller }) => {
      if (typeof controller.onParameterChanged === 'function') {
        const transformedValue = param.outputTransform(param.rawValue);
        const formattedValue = Number(transformedValue.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
        const metadata = buildParameterChangeMeta({
          updateIntent: COMMIT_UPDATE_INTENT,
          reason: 'set-to-middle',
        });
        controller.onParameterChanged(parameterName, formattedValue, undefined, metadata);
      }
    });
  }

  /**
   * Retrieves the current raw value of a parameter.
   * For multidimensional parameters, returns the value of the active dimension.
   * @public
   * @param {string} parameterName - The name of the parameter.
   *
   * @returns {number|null} - The raw value of the parameter or null if it doesn't exist.
   *
   * @example
   * const rawVolume = paramManager.getRawValue('volume');
   * const xValue = paramManager.getRawValue('x'); // Returns active dimension's value
   */
  getRawValue(parameterName) {
    const param = this.parameters.get(parameterName);
    if (!param) return null;
    
    if (param.isMultidimensional) {
      return this.getDimensionValue(parameterName, param.activeDimensionId);
    }
    
    return param.rawValue ?? null;
  }

  /**
   * Retrieves the current normalized value of a parameter.
   * For multidimensional parameters, returns the normalized value of the given dimension,
   * or of the active dimension when none is specified.
   * @public
   * @param {string} parameterName - The name of the parameter.
   * @param {string|null} [dimensionId=null] - Optional explicit dimension id for multidimensional params.
   *
   * @returns {number|null} - The normalized value of the parameter or null if it doesn't exist.
   *
   * @example
   * const normalizedVolume = paramManager.getNormalizedValue('volume');
   * const normalizedXActive = paramManager.getNormalizedValue('x');
   * const normalizedXDim2 = paramManager.getNormalizedValue('x', 'EW::II');
   */
  getNormalizedValue(parameterName, dimensionId = null) {
    const param = this.parameters.get(parameterName);
    if (!param) return null;
    
    if (param.isMultidimensional) {
      const target = dimensionId || param.activeDimensionId;
      const dimensionState = target ? param.dimensions.get(target) : null;
      return dimensionState ? dimensionState.normalizedValue : null;
    }
    
    return param.normalizedValue ?? null;
  }

  /**
   * Normalizes a raw value to a [0, 1] range based on min and max.
   * @private
   * @param {number} rawValue - The raw value to normalize.
   * @param {number} min - The minimum range.
   * @param {number} max - The maximum range.
   *
   * @returns {number} - The normalized value.
   *
   * @example
   * const normalized = paramManager.normalize(50, 0, 100); // returns 0.5
   */
  normalize(rawValue, min, max) {
    const normalized = (rawValue - min) / (max - min);
    return Number(normalized.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
  }

  /**
   * Denormalizes a normalized value [0, 1] to the raw range.
   * @private
   * @param {number} normalizedValue - The normalized value to denormalize.
   * @param {number} min - The minimum range.
   * @param {number} max - The maximum range.
   *
   * @returns {number} - The denormalized raw value.
   *
   * @example
   * const raw = paramManager.denormalize(0.75, 0, 100); // returns 75
   */
  denormalize(normalizedValue, min, max) {
    const raw = normalizedValue * (max - min) + min;
    return Number(raw.toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
  }

  /**
   * Lists all registered parameters with their current values and settings.
   * Useful for debugging and inspecting parameter states.
   * @public
   *
   * @returns {Array<Object>} - An array of parameter details.
   *
   * @example
   * const allParams = paramManager.listParameters();
   * console.log(allParams);
   */
  listParameters() {
    return Array.from(this.parameters.entries()).map(([name, param]) => ({
      name,
      rawValue: param.rawValue,
      normalizedValue: param.normalizedValue,
      min: param.min,
      max: param.max,
      isBidirectional: param.isBidirectional,
      lastPriority: param.lastPriority,
      subscribers: [...param.subscribers],
      scale: param.scale,
      inputTransform: param.inputTransform,
      outputTransform: param.outputTransform,
    }));
  }

  /**
   * Gets the details of a specific parameter by name.
   * Useful for accessing and debugging individual parameters.
   * @public
   * @param {string} paramName - The name of the parameter to retrieve.
   *
   * @returns {Object|null} - The parameter details or null if not found.
   *
   * @example
   * const volumeParam = paramManager.getParameter('volume');
   * const xParam = paramManager.getParameter('x'); // Includes dimension info if multidimensional
   * console.log(volumeParam);
   */
  getParameter(paramName) {
    if (this.parameters.has(paramName)) {
      const param = this.parameters.get(paramName);
      
      const baseInfo = {
        name: paramName,
        isBidirectional: param.isBidirectional,
        lastPriority: param.lastPriority,
        subscribers: [...param.subscribers],
        scale: param.scale,
        inputTransform: param.inputTransform,
        outputTransform: param.outputTransform,
        // Equilibrium (reset) value in raw units, set at registration (may be undefined for
        // params registered before this field existed). The numeric keypad resets to it.
        defaultValue: param.defaultValue,
      };

      if (param.isMultidimensional) {
        return {
          ...baseInfo,
          isMultidimensional: true,
          scope: param.scope,
          activeDimensionId: param.activeDimensionId,
          dimensions: Object.fromEntries(param.dimensions),
          min: param.min,
          max: param.max,
          step: param.step,
        };
      } else {
        return {
          ...baseInfo,
          isMultidimensional: false,
          rawValue: param.rawValue,
          normalizedValue: param.normalizedValue,
          min: param.min,
          max: param.max,
        };
      }
    }
    return null; // Parameter not found
  }

  /**
   * new: add a raw delta to a parameter (single or multidimensional)
   */
  addDeltaValue(parameterName, deltaRaw, sourceController = null, priority = Infinity, dimensionId = null) {
    if (this.lockedParams.has(parameterName)) return;
    const param = this.parameters.get(parameterName);
    if (!param) {
      console.warn(`[ParameterManager] addDeltaValue: Parameter '${parameterName}' not found.`);
      return;
    }

    if (param.isMultidimensional) {
      const targetDim = dimensionId || param.activeDimensionId;
      const dimState = targetDim ? param.dimensions.get(targetDim) : null;
      if (!dimState) {
        console.warn(`[ParameterManager] addDeltaValue: Dimension '${targetDim}' not found for '${parameterName}'.`);
        return;
      }
      const next = Number((dimState.value + deltaRaw).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
      this.setDimensionValue(parameterName, targetDim, next, sourceController, priority);
      return;
    }

    const next = Number(((param.rawValue ?? 0) + deltaRaw).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
    this.setRawValue(parameterName, next, sourceController, priority);
  }

  /**
   * new: add a normalized delta [0..1] to a parameter (converted to raw delta by range)
   */
  addDeltaNormalized(parameterName, deltaNormalized, sourceController = null, priority = Infinity, dimensionId = null) {
    if (this.lockedParams.has(parameterName)) return;
    const param = this.parameters.get(parameterName);
    if (!param) {
      console.warn(`[ParameterManager] addDeltaNormalized: Parameter '${parameterName}' not found.`);
      return;
    }

    if (param.isMultidimensional) {
      const targetDim = dimensionId || param.activeDimensionId;
      const dimState = targetDim ? param.dimensions.get(targetDim) : null;
      if (!dimState) {
        console.warn(`[ParameterManager] addDeltaNormalized: Dimension '${targetDim}' not found for '${parameterName}'.`);
        return;
      }
      const rawDelta = deltaNormalized * (dimState.max - dimState.min);
      const next = Number((dimState.value + rawDelta).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
      this.setDimensionValue(parameterName, targetDim, next, sourceController, priority);
      return;
    }

    const rawDelta = deltaNormalized * (param.max - param.min);
    const next = Number(((param.rawValue ?? 0) + rawDelta).toFixed(PARAM_INTERNAL_PRECISION_DECIMALS));
    this.setRawValue(parameterName, next, sourceController, priority);
  }

  /**
   * new: alias matching the phrasing "set delta value"
   */
  setDeltaValue(parameterName, deltaRaw, sourceController = null, priority = Infinity, dimensionId = null) {
    this.addDeltaValue(parameterName, deltaRaw, sourceController, priority, dimensionId);
  }

  /**
   * Locks a parameter, silently rejecting all subsequent writes until unlocked.
   * Notifies all subscribers via `onParameterLocked(name, true)`.
   * @public
   * @param {string} parameterName - The name of the parameter to lock.
   */
  lockParameter(parameterName) {
    if (this.lockedParams.has(parameterName)) return;
    this.lockedParams.add(parameterName);
    const param = this.parameters.get(parameterName);
    if (param) {
      param.subscribers.forEach(({ controller }) => {
        controller.onParameterLocked?.(parameterName, true);
      });
    }
  }

  /**
   * Unlocks a previously locked parameter, allowing writes again.
   * Notifies all subscribers via `onParameterLocked(name, false)`.
   * @public
   * @param {string} parameterName - The name of the parameter to unlock.
   */
  unlockParameter(parameterName) {
    if (!this.lockedParams.has(parameterName)) return;
    this.lockedParams.delete(parameterName);
    const param = this.parameters.get(parameterName);
    if (param) {
      param.subscribers.forEach(({ controller }) => {
        controller.onParameterLocked?.(parameterName, false);
      });
    }
  }

  /**
   * Returns whether a parameter is currently locked.
   * @public
   * @param {string} parameterName - The name of the parameter.
   * @returns {boolean}
   */
  isParameterLocked(parameterName) {
    return this.lockedParams.has(parameterName);
  }

  /**
   * Locks a specific dimension of a parameter.
   * Only writes targeting that dimensionId are rejected; other dimensions remain writable.
   * Notifies subscribers via `onParameterLocked(name, true, dimensionId)`.
   * @public
   * @param {string} parameterName
   * @param {string} dimensionId
   */
  lockParameterDimension(parameterName, dimensionId) {
    if (!dimensionId) return;
    let dimSet = this.lockedDimensions.get(parameterName);
    if (!dimSet) {
      dimSet = new Set();
      this.lockedDimensions.set(parameterName, dimSet);
    }
    if (dimSet.has(dimensionId)) return;
    dimSet.add(dimensionId);
    const param = this.parameters.get(parameterName);
    if (param) {
      param.subscribers.forEach(({ controller }) => {
        controller.onParameterLocked?.(parameterName, true, dimensionId);
      });
    }
  }

  /**
   * Unlocks a specific dimension of a parameter.
   * @public
   * @param {string} parameterName
   * @param {string} dimensionId
   */
  unlockParameterDimension(parameterName, dimensionId) {
    if (!dimensionId) return;
    const dimSet = this.lockedDimensions.get(parameterName);
    if (!dimSet || !dimSet.has(dimensionId)) return;
    dimSet.delete(dimensionId);
    if (dimSet.size === 0) this.lockedDimensions.delete(parameterName);
    const param = this.parameters.get(parameterName);
    if (param) {
      param.subscribers.forEach(({ controller }) => {
        controller.onParameterLocked?.(parameterName, false, dimensionId);
      });
    }
  }

  /**
   * Checks if a specific dimension of a parameter is locked.
   * Returns true if the whole parameter is locked OR the specific dimension is locked.
   * @public
   * @param {string} parameterName
   * @param {string} [dimensionId]
   * @returns {boolean}
   */
  isParameterDimensionLocked(parameterName, dimensionId) {
    if (this.lockedParams.has(parameterName)) return true;
    if (!dimensionId) return false;
    const dimSet = this.lockedDimensions.get(parameterName);
    return Boolean(dimSet && dimSet.has(dimensionId));
  }

  /**
   * new: return current x/y/z root params (raw values; for multidimensional, uses active dimension)
   */
  getActiveRootParams() {
    return {
      x: this.getRawValue('x') ?? 0,
      y: this.getRawValue('y') ?? 0,
      z: this.getRawValue('z') ?? 0,
    };
  }
}

/**
 * @typedef {Object} Parameter
 * @property {string} name - The name of the parameter.
 * @property {boolean} [isMultidimensional=false] - Whether this parameter stores values per dimension.
 * @property {string} [scope] - The scope of the parameter (for multidimensional params).
 * @property {Map<string, DimensionState>} [dimensions] - Map of dimension IDs to their state (for multidimensional params).
 * @property {string} [activeDimensionId] - The currently active dimension ID (for multidimensional params).
 * @property {number} [rawValue] - The current raw value (for single params).
 * @property {number} [normalizedValue] - The current normalized value [0,1] (for single params).
 * @property {number} min - The minimum raw value.
 * @property {number} max - The maximum raw value.
 * @property {number} [step] - The step size (for multidimensional params).
 * @property {Set<Subscriber>} subscribers - Set of subscribers with their controllers, priorities, and dimension IDs.
 * @property {boolean} isBidirectional - Indicates if two-way updates are allowed.
 * @property {number} [lastPriority] - The priority of the last update (for single params).
 * @property {number} [lastUpdateTimestamp] - Timestamp of the last update (for single params).
 * @property {object|null} [lastController] - The controller that made the last update (for single params).
 * @property {string} scale - The scale type ("linear" or "logarithmic").
 * @property {function} inputTransform - Function to transform input values.
 * @property {function} outputTransform - Function to transform output values.
 */

/**
 * @typedef {Object} DimensionState
 * @property {number} value - The raw value for this dimension.
 * @property {number} normalizedValue - The normalized value [0,1] for this dimension.
 * @property {number} min - The minimum raw value.
 * @property {number} max - The maximum raw value.
 * @property {number} lastPriority - The priority of the last update.
 * @property {number} lastUpdateTimestamp - Timestamp of the last update.
 * @property {object|null} lastController - The controller that made the last update.
 */

/**
 * @typedef {Object} Subscriber
 * @property {Controller} controller - The controller subscribing to the parameter.
 * @property {number} priority - The priority level of the subscriber.
 * @property {string|null} [dimensionId=null] - For multidimensional params: null = active dimension, string = specific dimension.
 */

/**
 * @typedef {Object} Controller
 * @property {function(string, number, string=): void} onParameterChanged - Callback invoked when a parameter's value changes. Third param is dimensionId for multidimensional params.
 * @property {function(string, number, number): void} onRangeChanged - Callback invoked when a parameter's range changes.
 * @property {function(string, string): void} onScaleChanged - Callback invoked when a parameter's scale changes.
 */

/**
 * @example
 * // Example of subscribing a controller to a parameter
 * const controller = {
 *   onParameterChanged: (name, value, dimensionId) => {
 *     console.log(`Parameter ${name} changed to ${value}${dimensionId ? ` in ${dimensionId}` : ''}`);
 *   },
 *   onRangeChanged: (name, min, max) => {
 *     console.log(`Parameter ${name} range updated to min: ${min}, max: ${max}`);
 *   },
 *   onScaleChanged: (name, scale) => {
 *     console.log(`Parameter ${name} scale changed to ${scale}`);
 *   }
 * };
 * const paramManager = new ParameterManager();
 * 
 * // Subscribe to active dimension
 * paramManager.subscribe(controller, 'x', 2, null);
 * 
 * // Subscribe to specific dimension
 * paramManager.subscribe(controller, 'x', 1, 'EW::II');
 */
