/**
 * @file src/input/SensorsController.js
 * @description Abstraction over internal (DeviceMotion) and external sensor streams,
 * fanning out motion data to rack axes and managing UI toggle state per dimension.
 */

import { MathUtils, Quaternion, Euler } from 'three';
import {
    INTERNAL_SENSORS_USABLE,
    EXTERNAL_SENSORS_USABLE,
    isMobileDevice,
    SENSOR_FEEDBACK_THROTTLE_MS,
    getPriority,
    DEFAULT_PRIORITY,
} from '../config/Constants.js';
import notifications from '../core/AppNotifications.js';
import { getScopedState, setScopedState } from '../core/stackUtils.js';
import { createInputRouter } from './source/InputRouter.ts';
import { resolveScopedContext } from './source/ScopingResolver.ts';
import { voiceRegistry } from '../voice/VoiceRegistry.js';
import { broadcastAction } from '../multi/multiFocusBroadcast.js';
import { syncCoordinator } from '../sync/SyncCoordinator.js';

const SENSOR_COMPONENT_IDS = {
    x: 'x.sensor-toggle',
    y: 'y.sensor-toggle',
    z: 'z.sensor-toggle',
};

// Per-axis arbitration priority resolved once from the single source of truth
// (PRIORITY_MAP), not per sensor sample — commitAxisValue runs on the hot device-motion path.
const SENSOR_AXIS_PRIORITY = {
    x: getPriority('sensor-x'),
    y: getPriority('sensor-y'),
    z: getPriority('sensor-z'),
    distance: getPriority('sensor-distance'),
};

/**
 * @class SensorController
 * @description Manages device orientation and motion sensor inputs and maps them to user parameters.
 * Handles toggle-based activation/deactivation of sensor axes (x, y, z, distance).
 * Integrates with a user-defined `ParameterManager` for real-time updates.
 */
export class SensorController {
    // Private static instance variable
    static #instance = null;

    /**
     * Returns the existing instance without creating a new one.
     * @returns {SensorController|null} The current instance if initialized, otherwise null.
     */
    static getExistingInstance() {
        return SensorController.#instance;
    }

    /**
     * Indicates whether the controller has already been instantiated.
     * @returns {boolean} True if an instance exists, false otherwise.
     */
    static hasInstance() {
        return SensorController.#instance !== null;
    }

    /**
     * Returns the singleton instance of SensorController.
     * @param {ParameterManager} parameterManager - The user manager instance.
     * @returns {SensorController} The singleton instance.
     */
    static getInstance(parameterManager) {
        if (!SensorController.#instance) {
            SensorController.#instance = new SensorController(parameterManager);
        }
        return SensorController.#instance;
    }

    /**
     * Private constructor to prevent direct instantiation.
     * @param {ParameterManager} parameterManager - The user manager instance.
     */
    constructor(parameterManager) {
        if (SensorController.#instance) {
            throw new Error('Use SensorController.getInstance() to get the singleton instance.');
        }

        // Initialize properties
        this.isSensorActive = false;
        this.parameterManager = parameterManager;
        // The seam this controller pushes through. Lazily bound (see _inputSource())
        // because parameterManager may not be ready at construction.
        this._inputSourceHandle = null;
        this.activeAxes = { x: false, y: false, z: false, distance: false };
        this.toggleElements = {};
        this.dimensionToggleCache = new Map();
        this.axisThrottleState = new Map();
        this.isMobileRuntime = typeof navigator !== 'undefined' && isMobileDevice();
        this.throttleUpdate = this.throttle(this.updateParameters.bind(this), SENSOR_FEEDBACK_THROTTLE_MS); // 16-50ms depending on preset
        this._boundDimensionListener = null;

        // Current normalized values
        this.currentYaw = 0.5;   // Normalized [0,1], 0.5 is center
        this.currentPitch = 0.5; // Normalized [0,1], 0.5 is center
        this.currentRoll = 0.5;  // Normalized [0,1], 0.5 is center

        // Quaternion tracking
        this.currentQuaternion = new Quaternion(); // Represents the current orientation
        this.calibrationQuatInverse = null; // Inverse of calibration quaternion

        // Pre-allocated objects for sensor event processing (avoid per-event allocation)
        this._tempEuler = new Euler();
        this._tempQuaternion = new Quaternion();
        // Dead zone threshold — changes smaller than this are ignored to reduce jitter
        this.DEAD_ZONE = 0.005;

        // Debug log timing
        this.lastDebugTime = 0;

        // Motion tracking
        this.velocityY = 0;
        this.positionY = 0;
        this.initialAccelerationY = 0;
        this.lastTimestamp = null;
        this.calibrated = false;

        // Bind toggle handlers for event listeners.
        this.handleToggleChange = this.handleToggleChange.bind(this);

        // Bind handleDeviceOrientation and handleDeviceMotion once to maintain reference
        this.boundHandleDeviceOrientation = this.handleDeviceOrientation.bind(this);
        this.boundHandleDeviceMotion = this.handleDeviceMotion.bind(this);

        // Initialize toggles and calibration button
        this.initializeToggles();
        this.initializeCalibrationButton();

        this.syncTogglesFromScopedState();
        this._boundDimensionListener = () => this.syncTogglesFromScopedState();
        if (typeof document !== 'undefined') {
            document.addEventListener('orbiters:dimension-changed', this._boundDimensionListener);
        }

        // The sensor connection is ONE shared device stream, but a shared realm has N orbiters.
        // Route its data to whichever voice is FOCUSED — bind this controller's target ParameterManager
        // to the active voice and re-point it (rebuilding the input router) whenever focus changes. So one
        // phone drives the orbiter you're working on; switch focus and the data follows. This aligns the
        // WRITE target with the dimension SCOPE, which already follows the active voice (getScopedContext →
        // resolveScopedContext). Single-orbiter has one voice → resolves to it and never changes.
        this._rebindToActiveVoice();
        this._unsubscribeActiveVoice =
            typeof voiceRegistry.onActiveChange === 'function'
                ? voiceRegistry.onActiveChange(() => {
                    // Route the shared phone stream to the newly-focused voice, and re-read ITS own stored
                    // axis toggles (per-voice: `getScopedState` is keyed by the voice's stackId), so the
                    // sensor interface reflects the focused orbiter's own instance. Each orbiter keeps its
                    // own 3-dimensions × 3-axes config; only the one live device connection is shared. A
                    // future mobile "which orbiter?" picker just drives `voiceRegistry.setActive()` — the
                    // routing + interface then follow with no further wiring.
                    this._rebindToActiveVoice();
                    this.syncTogglesFromScopedState();
                })
                : null;

        // Determine whether internal or external sensors are usable
        this.useInternalSensors = INTERNAL_SENSORS_USABLE;
        this.useExternalSensors = EXTERNAL_SENSORS_USABLE;

        // Initialize sensors based on availability
        if (this.useInternalSensors) {
            this.initializeInternalSensors();
        } else if (this.useExternalSensors) {
            this.initializeExternalSensors();
        } else {
            console.warn('SensorController: No usable sensors detected.');
        }

        // Initiate calibration
        this.calibrateDevice();
    }

    /**
     * Initializes the toggles for sensor axes (x, y, z, distance) and binds their change events.
     * Assumes toggles are custom web components with a 'state' attribute.
     * Logs the initial state of each toggle for debugging purposes.
     */
    initializeToggles() {
        ['toggleSensorX', 'toggleSensorY', 'toggleSensorZ', 'toggleSensorDistance'].forEach((id) => {
            const toggle = document.getElementById(id);
            const axis = id.replace('toggleSensor', '').toLowerCase();

            if (toggle) {
                console.debug(`[Init Debug] Toggle ID: ${id}, Axis: ${axis}, Initial state: ${toggle.state}`);

                this.toggleElements[axis] = toggle;
                const componentId = `${axis}.sensor-toggle`;
                toggle.dataset.midiComponentId = componentId;
                toggle.setAttribute('data-midi-param-id', componentId);
                if (typeof window !== 'undefined' && typeof window.registerAutomatableElement === 'function') {
                    window.registerAutomatableElement(toggle, { midiParamId: componentId, automatable: true });
                }

                // Bind change event to the toggle.
                toggle.addEventListener('change', () => this.handleToggleChange(toggle, axis));
            } else {
                console.warn(`SensorController: Toggle element '${id}' not found.`);
            }
        });
    }

    /**
     * Checks if the device supports orientation sensors.
     * @static
     * @returns {boolean} True if `DeviceOrientationEvent` is supported, false otherwise.
     */
    static isSupported() {
        return typeof DeviceOrientationEvent !== 'undefined';
    }

    /**
     * Initializes internal sensors.
     * Placeholder for any internal sensor initialization logic.
     */
    initializeInternalSensors() {
        console.log('SensorController: Initializing internal sensors.');
        // Add internal sensor initialization logic here if needed.
    }

    /**
     * Initializes external sensors.
     * Placeholder for any external sensor initialization logic.
     */
    initializeExternalSensors() {
        console.log('SensorController: Initializing external sensors.');
        // Add external sensor initialization logic here if needed.
    }

    /**
     * Requests user permission to access orientation sensors (iOS 13+ only).
     * @async
     * @returns {Promise<boolean>} Resolves to `true` if permission is granted, `false` otherwise.
     */
    async requestPermission() {
        if (
            typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function'
        ) {
            try {
                const response = await DeviceOrientationEvent.requestPermission();
                return response === 'granted';
            } catch (error) {
                console.error('SensorController: Error requesting permission:', error);
                return false;
            }
        }
        return true; // Assume permission is granted on non-iOS devices.
    }

    /**
     * Activates the device orientation and motion sensors if supported and permission is granted.
     * Binds the `deviceorientation` and `devicemotion` events to listen for changes.
     * @async
     */
    async activateSensors() {
        if (!SensorController.isSupported()) {
            console.warn('SensorController: Device orientation not supported by this browser/device.');
            return;
        }

        const permissionGranted = await this.requestPermission();
        if (!permissionGranted) {
            console.warn('SensorController: Permission to access sensors denied.');
            return;
        }

        this.startListening();
        this.isSensorActive = true;
        console.log('SensorController: Sensors activated.');
    }

    /**
     * Starts listening for `deviceorientation` and `devicemotion` events to capture orientation and motion changes.
     * Ensures that only one listener is active at a time.
     * @private
     */
    startListening() {
        if (!this.isSensorActive) {
            window.addEventListener('deviceorientation', this.boundHandleDeviceOrientation, true);
            window.addEventListener('devicemotion', this.boundHandleDeviceMotion, true);
            console.log('SensorController: Started listening to deviceorientation and devicemotion events.');
        }
    }

    /**
     * Stops listening for `deviceorientation` and `devicemotion` events.
     * Resets the `isSensorActive` flag.
     * @public
     */
    stopListening() {
        if (this.isSensorActive) {
            window.removeEventListener('deviceorientation', this.boundHandleDeviceOrientation, true);
            window.removeEventListener('devicemotion', this.boundHandleDeviceMotion, true);
            this.isSensorActive = false;
            this.clearMobileThrottleState();
            console.log('SensorController: Stopped listening to deviceorientation and devicemotion events.');
        }
    }

    /**
     * Calibrates the device by setting initial reference points for orientation.
     * Prompts the user to hold the device steady near their body.
     * @private
     */
    calibrateDevice() {
        console.log('SensorController: Starting calibration.');
      
        // If we are using external sensors on a desktop, just grab the last known data
        // If we don't have it yet, we show a warning and exit.
        if (this.useExternalSensors) {
          this.calibrateFromExternal();
        } else {
          this.calibrateFromInternal();
        }
      }

      calibrateFromInternal() {
        const onCalibrate = (event) => {
          if (event.alpha != null && event.beta != null && event.gamma != null) {
            this.finishCalibration(event.alpha, event.beta, event.gamma);
            window.removeEventListener('deviceorientation', onCalibrate);
          }
        };
      
        // Listen for one valid reading
        window.addEventListener('deviceorientation', onCalibrate, { once: true });
      }
      
      calibrateFromExternal() {
        // Use the last external data your app received from the remote sensor
        if (!this.lastExternalSensorData) {
          console.warn('No external sensor data available yet. Cannot calibrate.');
          return;
        }
        const { alpha, beta, gamma } = this.lastExternalSensorData;
        if (alpha == null || beta == null || gamma == null) {
          console.warn('External sensor data is missing alpha/beta/gamma. Cannot calibrate.');
          return;
        }
        this.finishCalibration(alpha, beta, gamma);
      }
      
      // Central place to store calibration info — stores as inverse quaternion
      finishCalibration(alpha, beta, gamma) {
        this.initialAlpha = alpha;
        this.initialBeta = beta;
        this.initialGamma = gamma;

        // Build calibration quaternion from the reference pose
        this._tempEuler.set(
            MathUtils.degToRad(beta),
            MathUtils.degToRad(gamma),
            MathUtils.degToRad(alpha),
            'YXZ'
        );
        this.calibrationQuatInverse = new Quaternion()
            .setFromEuler(this._tempEuler)
            .invert();

        this.calibrated = true;
      }


    /**
     * Handles `deviceorientation` events, maps yaw, pitch, and roll directly to normalized X, Y, Z.
     * Prevents overshooting and sticks to limits until direction changes.
     * Skips processing for inactive axes for efficiency.
     * @param {DeviceOrientationEvent} event - Orientation event containing `alpha`, `beta`, and `gamma`.
     */
    handleDeviceOrientation(event) {
       // console.log('[SensorController] Received deviceorientation event:', event);
        this.processSensorData(event, false, this.getCurrentDimensionId());
    }

  getCurrentDimensionId() {
    const { dimensionId } = this.getScopedContext();
    return dimensionId ?? null;
  }

  resolveDimensionId(preferredDimensionId = null) {
    return preferredDimensionId ?? this.getCurrentDimensionId();
  }

  ensureDimensionToggleState(dimensionId = 'default') {
    const key = dimensionId ?? 'default';
    if (!this.dimensionToggleCache.has(key)) {
      this.dimensionToggleCache.set(key, { x: false, y: false, z: false, distance: false });
    }
    return this.dimensionToggleCache.get(key);
  }

  setDimensionToggleState(dimensionId, axis, value) {
    if (!['x', 'y', 'z', 'distance'].includes(axis)) {
      return;
    }
    const record = this.ensureDimensionToggleState(dimensionId);
    record[axis] = Boolean(value);
  }

  getDimensionToggleState(dimensionId) {
    if (!dimensionId) {
      return this.ensureDimensionToggleState('default');
    }
    return this.ensureDimensionToggleState(dimensionId);
  }

  hydrateDimensionToggleState(dimensionId) {
    if (!dimensionId) {
      return this.ensureDimensionToggleState('default');
    }
    const record = this.ensureDimensionToggleState(dimensionId);
    ['x', 'y', 'z'].forEach((axis) => {
      const stored = this.getStoredToggleState(axis, dimensionId);
      if (stored !== undefined) {
        record[axis] = Boolean(stored);
      }
    });
    return record;
  }

  getAllDimensionToggleStates() {
    const dimensionIds = new Set();
    const currentDimension = this.getCurrentDimensionId();
    if (currentDimension) {
      dimensionIds.add(currentDimension);
    }

    // Include any dimensions we have cached via previous operations.
    this.dimensionToggleCache.forEach((_, key) => {
      dimensionIds.add(key);
    });

    // Attempt to include dimensions from the active voice's WorldModeController if available.
    const wm = voiceRegistry.getActive()?.worldMode;
    const definitions = wm?.getAvailableDimensions?.() ?? wm?.dimensionList;
    if (Array.isArray(definitions)) {
      definitions.forEach((entry) => dimensionIds.add(entry?.id ?? entry));
    }

    const snapshot = {};
    dimensionIds.forEach((dimensionId) => {
      const record = this.hydrateDimensionToggleState(dimensionId);
      snapshot[dimensionId ?? 'default'] = {
        sX: Boolean(record.x),
        sY: Boolean(record.y),
        sZ: Boolean(record.z),
      };
    });
    return snapshot;
  }

  hasAnySensorAxisActive() {
    if (Object.values(this.activeAxes || {}).some(Boolean)) {
      return true;
    }
    for (const record of this.dimensionToggleCache.values()) {
      if (record && (record.x || record.y || record.z)) {
        return true;
      }
    }
    return false;
  }

  getActiveDimensionsForAxis(axis) {
    const dims = new Set();
    const currentDimension = this.getCurrentDimensionId();

    if (axis === 'distance') {
      if (this.activeAxes.distance && currentDimension) {
        dims.add(currentDimension);
      }
    } else if (['x', 'y', 'z'].includes(axis)) {
      if (this.activeAxes[axis] && currentDimension) {
        dims.add(currentDimension);
      }
    }

    this.dimensionToggleCache.forEach((record, dimensionId) => {
      if (!record) return;
      if (record[axis]) {
        dims.add(dimensionId);
      }
    });

    const list = Array.from(dims);
    if (list.length > 1 && list.includes('default')) {
      return list.filter((dimensionId) => dimensionId !== 'default');
    }
    return list;
  }
  
  /**
   * Processes sensor data and maps it to normalized x, y, z values using quaternions.
   * Ensures smooth, continuous mapping without gimbal lock or jumps.
   * @param {Object} event - Sensor data ({ alpha, beta, gamma } in degrees).
   * @param {boolean} isExternal - Whether the data is from an external source.
   */
  processSensorData(event, isExternal = false, dimensionId = null) {
      const targetDimensionId = this.resolveDimensionId(dimensionId);

      // 1) Build quaternion from raw Euler angles
      const rawAlpha = event.alpha ?? 0;
      const rawBeta  = event.beta  ?? 0;
      const rawGamma = event.gamma ?? 0;

      this._tempEuler.set(
          MathUtils.degToRad(rawBeta),   // X-axis (Pitch)
          MathUtils.degToRad(rawGamma),  // Y-axis (Roll)
          MathUtils.degToRad(rawAlpha),  // Z-axis (Yaw)
          'YXZ'
      );
      this._tempQuaternion.setFromEuler(this._tempEuler).normalize();

      // 2) Apply calibration in quaternion space (correct for non-commutative rotations)
      if (this.calibrated && this.calibrationQuatInverse) {
          this._tempQuaternion.premultiply(this.calibrationQuatInverse).normalize();
      }

      // 3) Check continuity (dot < 0 => flip signs to avoid sudden jumps)
      if (this.currentQuaternion.dot(this._tempQuaternion) < 0) {
          this._tempQuaternion.x *= -1;
          this._tempQuaternion.y *= -1;
          this._tempQuaternion.z *= -1;
          this._tempQuaternion.w *= -1;
      }

      // 4) Slerp for smooth interpolation — less smoothing for external (WebRTC)
      //    data since it already carries network latency
      const slerpFactor = isExternal ? 0.9 : 0.75;
      this.currentQuaternion.slerp(this._tempQuaternion, slerpFactor);

      // 5) Map quaternion components to [0,1] using a tighter input range.
      //    Quaternion components naturally saturate and reverse at limits — no wrapping.
      //    ±90° of rotation corresponds to q ≈ ±0.707; mapping from [-0.7, 0.7]
      //    gives full [0,1] output range for typical phone movement, clamping beyond.
      const Q_RANGE = 0.7;
      const normalizedX = this.mapRange(this.currentQuaternion.z, -Q_RANGE, Q_RANGE, 0, 1); // Yaw
      const normalizedY = this.mapRange(this.currentQuaternion.x, -Q_RANGE, Q_RANGE, 0, 1); // Pitch
      const normalizedZ = this.mapRange(this.currentQuaternion.y, -Q_RANGE, Q_RANGE, 0, 1); // Roll

      // 6) Apply dead zone and push to active dimensions
      const explicitTarget = targetDimensionId ?? null;

      const ensureExplicitTarget = (axisTargets, axisName) => {
        if (!explicitTarget) {
          return axisTargets;
        }
        const state = this.getDimensionToggleState(explicitTarget);
        if (state && state[axisName]) {
          if (!axisTargets.includes(explicitTarget)) {
            axisTargets.push(explicitTarget);
          }
        }
        return axisTargets;
      };

      const activeXDimensions = ensureExplicitTarget(this.getActiveDimensionsForAxis('x'), 'x');
      if (activeXDimensions.length) {
          if (Math.abs(normalizedX - this.currentYaw) >= this.DEAD_ZONE) {
              this.currentYaw = normalizedX;
          }
          for (let i = 0; i < activeXDimensions.length; i++) {
            this.pushAxisValue('x', this.currentYaw, activeXDimensions[i], { isExternal });
          }
      }

      const activeYDimensions = ensureExplicitTarget(this.getActiveDimensionsForAxis('y'), 'y');
      if (activeYDimensions.length) {
          if (Math.abs(normalizedY - this.currentPitch) >= this.DEAD_ZONE) {
              this.currentPitch = normalizedY;
          }
          for (let i = 0; i < activeYDimensions.length; i++) {
            this.pushAxisValue('y', this.currentPitch, activeYDimensions[i], { isExternal });
          }
      }

      const activeZDimensions = ensureExplicitTarget(this.getActiveDimensionsForAxis('z'), 'z');
      if (activeZDimensions.length) {
          if (Math.abs(normalizedZ - this.currentRoll) >= this.DEAD_ZONE) {
              this.currentRoll = normalizedZ;
          }
          for (let i = 0; i < activeZDimensions.length; i++) {
            this.pushAxisValue('z', this.currentRoll, activeZDimensions[i], { isExternal });
          }
      }

      // 7) Throttled debug log — check timing before allocating the log object
      const now = performance.now();
      if (now - this.lastDebugTime > 500) {
          this.lastDebugTime = now;
          console.debug('[SensorController Debug]', JSON.stringify({
              rawAngles: { alpha: rawAlpha, beta: rawBeta, gamma: rawGamma },
              quaternion: {
                x: this.currentQuaternion.x.toFixed(3),
                y: this.currentQuaternion.y.toFixed(3),
                z: this.currentQuaternion.z.toFixed(3),
                w: this.currentQuaternion.w.toFixed(3)
              },
              finalNormalized: {
                x: this.currentYaw.toFixed(3),
                y: this.currentPitch.toFixed(3),
                z: this.currentRoll.toFixed(3)
              },
              isExternal
          }, null, 2));
      }
  }

  /**
   * Pushes a normalized sensor value into the ParameterManager so the audio path reacts.
   * Handles multidimensional parameters (x, y, z) by resolving the active dimension context.
   * @param {string} axis - Axis identifier ('x', 'y', 'z', or 'distance').
   * @param {number} normalizedValue - Normalized value in [0, 1].
   * @private
   */
  pushAxisValue(axis, normalizedValue, dimensionId = null, options = {}) {
    const { skipThrottle = false, isExternal = false } = options;

    if (!skipThrottle && this.handleMobileAxisThrottle(axis, normalizedValue, dimensionId, { isExternal })) {
      return;
    }

    this.commitAxisValue(axis, normalizedValue, dimensionId);
  }

  commitAxisValue(axis, normalizedValue, dimensionId = null) {
    if (!this.parameterManager) {
      return;
    }

    try {
      const clamped = MathUtils.clamp(normalizedValue ?? 0, 0, 1);
      const param = this.parameterManager.parameters?.get?.(axis);

      if (!param) {
        // Parameter not registered yet; nothing to push.
        return;
      }

      // Priority from the single source of truth (PRIORITY_MAP), per axis
      // (sensor-x/y/z = 8/9/10, sensor-distance = 10.5), precomputed — not a flat 15.
      const inputSource = this._inputSource();
      if (!inputSource) return;
      const priority = SENSOR_AXIS_PRIORITY[axis] ?? DEFAULT_PRIORITY;

      if (param.isMultidimensional) {
        const { dimensionId: activeDimensionId } = this.getScopedContext();
        const preferredDimension = dimensionId === 'default' ? null : dimensionId;
        const targetDimension = preferredDimension || activeDimensionId || param.activeDimensionId;
        if (!targetDimension) {
          console.warn(`[SensorController] Cannot push axis '${axis}': no active dimension.`);
          return;
        }

        if (!this.shouldApplySensorToAxis(axis, targetDimension)) {
          return;
        }

        const dimensionState =
          typeof param.dimensions?.get === 'function'
            ? param.dimensions.get(targetDimension)
            : param.dimensions?.[targetDimension];

        const min = dimensionState?.min ?? param.min ?? 0;
        const max = dimensionState?.max ?? param.max ?? 1;
        const rawValue = this.parameterManager.denormalize(clamped, min, max);

        if (Number.isFinite(rawValue)) {
          inputSource.set(axis, rawValue, { kind: 'raw', dim: targetDimension, priority });
          // Multi-focus: the local write above hit the FOCUSED voice; when more than one orbiter
          // is selected (Decision 004), gang the same axis write across the rest of the selection via the
          // shared broadcast owner, so one phone drives every selected orbiter at once. No-op for a single
          // focus (multiFocusActive === false). Siblings write through their own raw engine command surface
          // (no re-entry into this controller → no feedback loop), applying to their own like-id dimension.
          broadcastAction(voiceRegistry.activeId, 'params', 'setDimensionValue', [
            axis, targetDimension, rawValue, 'SensorController', priority, undefined,
          ]);
        }
      } else {
        inputSource.set(axis, clamped, { kind: 'normalized', priority });
      }
    } catch (error) {
      console.error(`[SensorController] Failed to push axis '${axis}' value:`, error);
    }
  }

  shouldApplySensorToAxis(axis, dimensionId = null) {
    if (!axis) {
      return false;
    }

    if (!dimensionId) {
      return true;
    }

    const parameterManager = this.parameterManager;
    if (typeof parameterManager?.isParameterDimensionLocked === 'function') {
      try {
        if (parameterManager.isParameterDimensionLocked(axis, dimensionId)) {
          return false;
        }
      } catch (error) {
        console.warn('[SensorController] Failed to check parameter lock state:', error);
      }
    }

    const syncEnabled = syncCoordinator.isEnabled === true;
    if (!syncEnabled) {
      return true;
    }

    const audioEngine = voiceRegistry.getActive()?.audioEngine ?? null;
    if (typeof audioEngine?.hasTempoManagedSpeedTarget === 'function') {
      try {
        if (audioEngine.hasTempoManagedSpeedTarget(axis, dimensionId)) {
          return false;
        }
      } catch (error) {
        console.warn('[SensorController] Failed to check tempo-managed target state:', error);
      }
    }

    return true;
  }

  handleMobileAxisThrottle(axis, normalizedValue, dimensionId = null, { isExternal = false } = {}) {
    const throttleMs = this.getMobilePushThrottleMs();
    if (
      isExternal ||
      !this.isMobileRuntime ||
      throttleMs <= 0
    ) {
      return false;
    }

    const dimensionKey = dimensionId ?? 'default';
    const throttleKey = `${axis}:${dimensionKey}`;
    const now = this.getHighResTimestamp();
    let state = this.axisThrottleState.get(throttleKey);

    if (!state) {
      state = { lastPush: 0, timeoutId: null, pendingValue: undefined, pendingDimensionId: dimensionId };
      this.axisThrottleState.set(throttleKey, state);
    }

    const elapsed = now - state.lastPush;

    if (elapsed >= throttleMs) {
      state.lastPush = now;
      if (state.timeoutId) {
        clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }
      state.pendingValue = undefined;
      state.pendingDimensionId = undefined;
      this.axisThrottleState.set(throttleKey, state);
      return false;
    }

    state.pendingValue = normalizedValue;
    state.pendingDimensionId = dimensionId;

    if (!state.timeoutId) {
      const delay = Math.max(throttleMs - elapsed, 0);
      state.timeoutId = setTimeout(() => {
        const currentState = this.axisThrottleState.get(throttleKey);
        if (!currentState) {
          return;
        }

        currentState.timeoutId = null;
        const pendingValue = currentState.pendingValue;
        const pendingDimensionId = currentState.pendingDimensionId;
        currentState.pendingValue = undefined;
        currentState.pendingDimensionId = undefined;
        currentState.lastPush = this.getHighResTimestamp();
        this.axisThrottleState.set(throttleKey, currentState);

        if (typeof pendingValue !== 'undefined') {
          this.pushAxisValue(axis, pendingValue, pendingDimensionId, { skipThrottle: true, isExternal: false });
        }
      }, delay);
    }

    this.axisThrottleState.set(throttleKey, state);
    return true;
  }

  clearMobileThrottleState() {
    this.axisThrottleState.forEach((entry) => {
      if (entry?.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
    });
    this.axisThrottleState.clear();
  }

  getMobilePushThrottleMs() {
    const dynamicThrottle = Number(SENSOR_FEEDBACK_THROTTLE_MS);
    return Number.isFinite(dynamicThrottle) && dynamicThrottle > 0 ? dynamicThrottle : 0;
  }

  getHighResTimestamp() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

    /**
     * Clamps a value from one range to another.
     * @param {number} value - The value to clamp.
     * @param {number} min - The minimum value.
     * @param {number} max - The maximum value.
     * @returns {number} The clamped value.
     */
    clamp(value, min, max) {
        return MathUtils.clamp(value, min, max);
    }

        /**
         * Maps a value from one range to another.
         * @param {number} val - The value to map.
         * @param {number} inMin - Input range minimum.
         * @param {number} inMax - Input range maximum.
         * @param {number} outMin - Output range minimum.
         * @param {number} outMax - Output range maximum.
         * @returns {number} The mapped value.
         */
        mapRange(val, inMin, inMax, outMin, outMax) {
            return MathUtils.clamp(
                ((val - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin,
                outMin,
                outMax
            );
        }

    /**
     * Handles `devicemotion` events to calculate translation distance based on Y-axis acceleration.
     * @param {DeviceMotionEvent} event - The motion event containing acceleration data.
     */
    handleDeviceMotion(event) {
        if (!this.calibrated) {
            // Ignore motion events until calibration is complete
            return;
        }

        try {
            const currentTime = event.timeStamp;
            const deltaTime = this.lastTimestamp ? (currentTime - this.lastTimestamp) / 1000 : 0; // Convert ms to seconds
            this.lastTimestamp = currentTime;

            // Get Y-axis acceleration and remove the initial calibration offset
            const accY = event.accelerationIncludingGravity.y || 0;
            const deltaAccY = accY - this.initialAccelerationY;

            // Apply a simple low-pass filter to reduce noise
            const alpha = 0.8; // Smoothing factor
            const filteredAccY = alpha * deltaAccY + (1 - alpha) * (this.previousAccY || 0);
            this.previousAccY = filteredAccY;

            // Integrate acceleration to get velocity
            this.velocityY += filteredAccY * deltaTime;

            // Integrate velocity to get position
            this.positionY += this.velocityY * deltaTime;

            // Normalize distance (0 near, 1 at 0.8 meters)
            const normalizedDistance = Math.min(Math.abs(this.positionY) / 0.8, 1);

            // Update user manager if 'distance' axis is active
            const activeDistanceDimensions = this.getActiveDimensionsForAxis('distance');
            if (activeDistanceDimensions.length) {
                // Assuming 0.5 is center for distance as well
                const distanceNorm = this.mapRange(normalizedDistance, 0, 1, 0, 1);
                activeDistanceDimensions.forEach((dimensionKey) => {
                    this.pushAxisValue('distance', distanceNorm, dimensionKey);
                });
            }

            // Optionally, reset position and velocity if device is stationary (to prevent drift)
            if (Math.abs(filteredAccY) < 0.05) { // Threshold for considering the device as stationary
                this.velocityY *= 0.9; // Dampen velocity
                this.positionY *= 0.9; // Dampen position
            }

            // Optionally, expose the distance for debugging
        } catch (error) {
            console.error('SensorController: Error in handleDeviceMotion:', error);
        }
    }

    /**
     * Maps normalized parameters and updates the `parameterManager`.
     * @private
     */
    updateParameters() {
        try {
            // Since we're directly mapping normalized values in processSensorData,
            // this method can be simplified or removed if not needed.
            // If additional processing is required, implement here.
        } catch (error) {
            console.error('SensorController: Error in updateParameters:', error);
        }
    }

    /**
     * Handles changes to toggle states for sensor axes.
     * Updates the `activeAxes` state and manages sensor activation/deactivation.
     * @param {HTMLElement} toggle - The toggle element.
     * @param {string} axis - The axis ('x', 'y', 'z', or 'distance') corresponding to the toggle.
     */
    handleToggleChange(toggle, axis, options = {}) {
        const {
            source = 'local',
            broadcast = true,
            persistOverride = true,
            dimensionId = null,
            normalizedState,
        } = options;

        let isActive;
        if (typeof normalizedState === 'boolean') {
            isActive = normalizedState;
        } else {
            const rawState = toggle?.state ?? toggle?.value ?? toggle?.checked;
            isActive = this.normalizeToggleState(rawState);
        }

        const currentDimension = this.getCurrentDimensionId();
        const preferredDimension = dimensionId === 'default' ? null : dimensionId;
        const targetDimension = preferredDimension ?? currentDimension ?? 'default';
        const isCurrentDimension = !preferredDimension || preferredDimension === currentDimension;

        const toggleId = toggle?.id ?? '(virtual)';
        console.debug(
            `[Toggle Debug] Toggle ID: ${toggleId}, Axis: ${axis}, Dimension: ${targetDimension}, State: ${isActive}`
        );

        if (axis in this.activeAxes || axis === 'distance') {
            if (axis === 'distance') {
                this.activeAxes.distance = isActive;
            } else if (isCurrentDimension && axis in this.activeAxes) {
                this.activeAxes[axis] = isActive;
            }

            this.setDimensionToggleState(targetDimension, axis, isActive);

            const shouldActivateSensor = axis !== 'distance' && isActive;
            if (shouldActivateSensor) {
                if (!this.isSensorActive) this.activateSensors();
            } else if (axis !== 'distance') {
                if (!this.hasAnySensorAxisActive() && this.isSensorActive) {
                    this.stopListening();
                }
            }
        }

        console.debug(`[Toggle Debug] ActiveAxes After:`, this.activeAxes);

        if (broadcast) {
            this.emitToggleChange(axis, isActive, source, targetDimension);
        }

        if (persistOverride && axis !== 'distance') {
            this.persistToggleState(axis, isActive, targetDimension);
        }
    }

    /**
     * Whether a sensor axis is enabled for the ACTIVE dimension. Reads the PERSISTED
     * scoped toggle state for the current dimension directly (falling back to the live `activeAxes`
     * cache), so it is authoritative regardless of the `orbiters:dimension-changed` listener order
     * — the React `sensors` surface re-reads this on a dimension change and must not depend on
     * `syncTogglesFromScopedState` having already run.
     * @param {('x'|'y'|'z')} axis
     * @returns {boolean}
     */
    isAxisEnabled(axis) {
        if (!['x', 'y', 'z'].includes(axis)) {
            return false;
        }
        const stored = this.getStoredToggleState(axis, this.getCurrentDimensionId());
        if (stored !== undefined) {
            return Boolean(stored);
        }
        return Boolean(this.activeAxes[axis]);
    }

    /**
     * Enable/disable a sensor axis for the ACTIVE dimension from the React UI.
     *
     * The `sensors` EngineContext surface calls this so the React toggle drives the SAME path a
     * WAC switch flip would — persist scoped toggle state, broadcast `sensorToggleChanged`, and
     * activate/stop the device-motion listeners — WITHOUT needing the DOM toggle element (we pass
     * a virtual `null` toggle + the explicit `normalizedState`, exactly like `applyRemoteToggle`'s
     * current-dimension branch). Enabling an axis lazily calls `activateSensors()` (which may
     * prompt for the device-orientation permission on iOS). 'distance' is not exposed here.
     * @param {('x'|'y'|'z')} axis
     * @param {boolean} isActive
     */
    setAxisActive(axis, isActive) {
        if (!['x', 'y', 'z'].includes(axis)) {
            return;
        }
        this.handleToggleChange(null, axis, {
            source: 'react',
            broadcast: true,
            persistOverride: true,
            dimensionId: this.getCurrentDimensionId(),
            normalizedState: Boolean(isActive),
        });
    }

    /**
     * Throttles a function call to a specified limit.
     * Prevents excessive executions of expensive operations.
     * @param {Function} func - The function to throttle.
     * @param {number} limit - The time in milliseconds to throttle executions.
     * @returns {Function} The throttled function.
     */
    throttle(func, limit) {
        let inThrottle;
        return function (...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => (inThrottle = false), limit);
            }
        };
    }

    /**
     * Normalizes a toggle state to a boolean.
     * @param {*} rawState - The raw state value from the toggle element.
     * @returns {boolean} The normalized boolean state.
     */
    normalizeToggleState(rawState) {
        if (typeof rawState === 'boolean') {
            return rawState;
        }
        if (rawState === null || typeof rawState === 'undefined') {
            return false;
        }
        const numeric = Number(rawState);
        if (!Number.isNaN(numeric)) {
            return numeric === 1;
        }
        if (typeof rawState === 'string') {
            const lowered = rawState.toLowerCase();
            if (lowered === 'true') return true;
            if (lowered === 'false') return false;
        }
        return Boolean(rawState);
    }

    /**
     * Converts an internal axis identifier to the external toggle key used for messaging.
     * @param {string} axis - One of 'x', 'y', or 'z'.
     * @returns {string|null} The toggle key (e.g., 'sX') or null if unsupported.
     */
    axisToToggleKey(axis) {
        switch (axis) {
            case 'x':
                return 'sX';
            case 'y':
                return 'sY';
            case 'z':
                return 'sZ';
            default:
                return null;
        }
    }

    /**
     * Converts an external toggle key back to the controller axis identifier.
     * @param {string} key - The toggle key (e.g., 'sX').
     * @returns {string|null} The axis ('x', 'y', or 'z') or null if unsupported.
     */
    toggleKeyToAxis(key) {
        switch (key) {
            case 'sX':
                return 'x';
            case 'sY':
                return 'y';
            case 'sZ':
                return 'z';
            default:
                return null;
        }
    }

    getScopedContext() {
        // Scope resolution consolidated into one shared resolver (was duplicated
        // verbatim across CosmicLFO / Sensors / MIDI). Sensors uses the base resolve with
        // no ParameterManager fallback, matching the prior behaviour exactly.
        return resolveScopedContext();
    }

    /**
     * Lazily bind the {@link InputSource} this controller pushes through. Created from
     * `parameterManager` (the ParameterManager) the first time it's available; null until then.
     * @returns {import('./source/InputSource.ts').InputSource | null}
     */
    _inputSource() {
        if (!this.parameterManager) return null;
        if (!this._inputSourceHandle) {
            this._inputSourceHandle = createInputRouter(this.parameterManager)
                .source('SensorController', getPriority('sensor-x'));
        }
        return this._inputSourceHandle;
    }

    /** Point sensor output at the FOCUSED voice's ParameterManager (falling back to the one the
     *  controller was constructed with) and drop the cached input router so it rebuilds against the new
     *  target. Called on construction and on every active-voice change. The router is a plain PM-holding
     *  wrapper (no listeners), so re-creating it is cheap and leak-free. */
    _rebindToActiveVoice() {
        const active = voiceRegistry.getActive();
        if (!active) return; // no active voice (teardown) → keep the current target
        // Always target the ACTIVE voice — even if its PM is momentarily absent (target null → the
        // `commitAxisValue` guard drives NOTHING until it attaches), never the previously-focused voice.
        // In practice a voice registers with its PM synchronously, so this resolves to a real PM.
        const activePm = active.parameterManager ?? null;
        if (activePm !== this.parameterManager) {
            this.parameterManager = activePm;
            this._inputSourceHandle = null;
        }
    }

    getToggleComponentId(axis) {
        return SENSOR_COMPONENT_IDS[axis] ?? null;
    }

    persistToggleState(axis, isActive, dimensionId = null) {
        const componentId = this.getToggleComponentId(axis);
        if (!componentId) return;
        const { stackId, dimensionId: currentDimension } = this.getScopedContext();
        const preferredDimension = dimensionId === 'default' ? null : dimensionId;
        const targetDimension = preferredDimension ?? currentDimension;
        if (!stackId || !targetDimension) return;
        try {
            setScopedState(stackId, componentId, Boolean(isActive), { dimensionId: targetDimension });
            this.setDimensionToggleState(targetDimension, axis, isActive);
        } catch (error) {
            console.warn('[SensorController] Failed to persist toggle state:', error);
        }
    }

    getStoredToggleState(axis, dimensionId = null) {
        const componentId = this.getToggleComponentId(axis);
        if (!componentId) return undefined;
        const { stackId, dimensionId: currentDimension } = this.getScopedContext();
        const preferredDimension = dimensionId === 'default' ? null : dimensionId;
        const targetDimension = preferredDimension ?? currentDimension;
        if (!stackId || !targetDimension) return undefined;
        try {
            return getScopedState(stackId, componentId, { dimensionId: targetDimension });
        } catch (error) {
            console.warn('[SensorController] Failed to read toggle state:', error);
            return undefined;
        }
    }

    syncTogglesFromScopedState() {
        const currentDimension = this.getCurrentDimensionId() ?? 'default';
        ['x', 'y', 'z'].forEach((axis) => {
            const toggle = this.toggleElements[axis];
            if (!toggle) return;
            const stored = this.getStoredToggleState(axis, currentDimension);
            const desired = stored === undefined ? false : Boolean(stored);
            const current = this.normalizeToggleState(toggle?.state ?? toggle?.value ?? toggle?.checked);
            this.setDimensionToggleState(currentDimension, axis, desired);
            if (desired !== current) {
                if (typeof toggle.setState === 'function') {
                    toggle.setState(desired ? 1 : 0, false);
                } else if ('checked' in toggle) {
                    toggle.checked = desired;
                }
                this.handleToggleChange(toggle, axis, {
                    source: 'dimension-sync',
                    broadcast: false,
                    persistOverride: false,
                    dimensionId: currentDimension,
                });
            } else {
                this.activeAxes[axis] = desired;
            }
        });
    }

    /**
     * Broadcasts toggle changes so other modules (e.g., WebRTC) can react.
     * @param {string} axis - The axis identifier.
     * @param {boolean} isActive - Whether the axis is active.
     * @param {string} source - Identifier for the source of the change.
     */
    emitToggleChange(axis, isActive, source = 'local', dimensionId = null) {
        const key = this.axisToToggleKey(axis);
        if (!key) {
            return;
        }

        const resolvedDimension = dimensionId ?? this.getCurrentDimensionId() ?? 'default';

        document.dispatchEvent(
            new CustomEvent('sensorToggleChanged', {
                detail: {
                    axis,
                    key,
                    value: isActive,
                    source,
                    dimension: resolvedDimension
                }
            })
        );
    }

    /**
     * Applies a remote toggle change and updates internal state without rebroadcasting.
     * @param {string} key - The external toggle key ('sX', 'sY', 'sZ').
     * @param {boolean|number|string} value - The desired state.
     */
    applyRemoteToggle(key, value, dimensionId = null) {
        const axis = this.toggleKeyToAxis(key);
        if (!axis) {
            console.warn(`SensorController: Unknown toggle key '${key}' received from remote.`);
            return;
        }

        const normalized = this.normalizeToggleState(value);
        const currentDimension = this.getCurrentDimensionId();
        const preferredDimension =
          dimensionId === 'default' ? null : dimensionId;
        const isCurrentDimension =
          !preferredDimension || preferredDimension === currentDimension;

        if (isCurrentDimension) {
          const toggle =
            this.toggleElements[axis] ||
            document.getElementById(`toggleSensor${axis.toUpperCase()}`);
          if (toggle) {
            if (typeof toggle.setState === 'function') {
              toggle.setState(normalized ? 1 : 0, false);
            } else {
              toggle.state = normalized ? 1 : 0;
            }
          }
          this.handleToggleChange(toggle, axis, {
            source: 'remote',
            broadcast: false,
            persistOverride: true,
            dimensionId: preferredDimension ?? currentDimension,
            normalizedState: normalized,
          });
        } else {
          this.handleToggleChange(null, axis, {
            source: 'remote',
            broadcast: false,
            persistOverride: true,
            dimensionId: preferredDimension,
            normalizedState: normalized,
          });
        }

        this.emitToggleChange(axis, normalized, 'remote', preferredDimension ?? currentDimension);
    }

    /**
     * Returns a snapshot of the current toggle states for remote synchronization.
     * @returns {{sX: boolean, sY: boolean, sZ: boolean}} The current toggle states.
     */
    getToggleStates(dimensionId = null) {
        if (!dimensionId || dimensionId === 'default') {
            return {
                sX: !!this.activeAxes.x,
                sY: !!this.activeAxes.y,
                sZ: !!this.activeAxes.z
            };
        }
        const record = this.hydrateDimensionToggleState(dimensionId);
        return {
            sX: !!record.x,
            sY: !!record.y,
            sZ: !!record.z
        };
    }

    /**
     * Loads dynamic SVG icons for the calibration button.
     * Ensures the SVG is fetched and injected dynamically.
     * @public
     */
    loadCalibrationButtonSVG() {
        const calibrationButtonIcon = document.querySelector('#sensor-calibration .button-icon');
        if (!calibrationButtonIcon) {
            console.warn('SensorController: Calibration button icon element not found.');
            return;
        }

        const src = calibrationButtonIcon.getAttribute('data-src');
        if (src) {
            this.fetchAndSetSVG(src, calibrationButtonIcon, true);
        }
    }

    /**
     * Fetches and sets SVG content into a specified element.
     * @param {string} src - URL of the SVG file to fetch.
     * @param {HTMLElement} element - DOM element to insert the fetched SVG into.
     * @param {boolean} [isInline=true] - Whether to insert the SVG inline.
     * @private
     */
    fetchAndSetSVG(src, element, isInline = true) {
        if (!isInline) return;

        fetch(src)
            .then(response => {
                if (!response.ok) throw new Error(`Failed to load SVG: ${src}`);
                return response.text();
            })
            .then(svgContent => {
                const parser = new DOMParser();
                const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
                const svgElement = svgDoc.documentElement;

                if (svgElement && svgElement.tagName.toLowerCase() === 'svg') {
                    svgElement.setAttribute('fill', 'currentColor');
                    svgElement.setAttribute('role', 'img');
                    svgElement.classList.add('icon-svg');
                    element.innerHTML = ''; // Clear existing content
                    element.appendChild(svgElement); // Insert the SVG
                } else {
                    console.error(`Invalid SVG content fetched from: ${src}`);
                }
            })
            .catch(error => console.error(`SensorController: Error loading SVG from ${src}:`, error));
    }

    /**
     * Initializes the sensor calibration button and SVG loading.
     * Call this method after the DOM is fully loaded.
     * @public
     */
    initializeCalibrationButton() {
        const calibrationButton = document.getElementById('sensor-calibration');
        if (!calibrationButton) {
            console.warn('SensorController: Calibration button not found.');
            return;
        }

        // Attach an event listener for calibration
        calibrationButton.addEventListener('click', () => {
            calibrationButton.disabled = true; // Disable button during calibration
            this.calibrateDevice();

            // Re-enable the button after a short delay to prevent multiple calibrations
            setTimeout(() => {
                calibrationButton.disabled = false;
            }, 6000); // 6 seconds (adjust based on calibration time)
        });

        // Load the SVG dynamically
        this.loadCalibrationButtonSVG();
    }

    /**
     * Sets sensor values externally (e.g., via WebRTC).
     * @param {Object} data - Sensor data from external device.
     * @param {number} data.alpha - Rotation around Z axis (degrees).
     * @param {number} data.beta - Rotation around X axis (degrees).
     * @param {number} data.gamma - Rotation around Y axis (degrees).
     */
    setExternalSensorData(data, dimensionId = null) {
        if (!this.useExternalSensors) {
          console.warn('[SensorController] External sensors not enabled.');
          return;
        }
      
        // e.g. data = { alpha: 123, beta: 45, gamma: -67 }
        this.lastExternalSensorData = data; 
      
        // Optionally process immediately 
        this.processSensorData(data, true, dimensionId);
      }
    /**
     * Switch between internal and external sensor sources.
     * @param {boolean} useExternal - If true, use external sensors; otherwise, use internal.
     */
    switchSensorSource(useExternal) {
        this.useExternalSensors = useExternal;
        this.useInternalSensors = !useExternal;

        if (useExternal) {
            this.stopListening(); // Stop internal sensor listeners
        } else {
            this.startListening(); // Start internal sensor listeners
        }
    }
}
