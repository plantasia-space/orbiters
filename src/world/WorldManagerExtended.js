import { WorldManager as SharedWorldManager } from 'entangled-worlds-orbiters-shared/world';

/**
 * Orbiters-specific extension point for the shared WorldManager. This will host
 * custom geometry and audio-reactive variants that are unique to Orbiters.
 */
export class WorldManagerExtended extends SharedWorldManager {
  constructor(scene, options = {}) {
    super(scene, options);

    const { customCreators = {} } = options;
    Object.entries(customCreators).forEach(([mode, creator]) => {
      const numericMode = Number(mode);
      if (!Number.isNaN(numericMode) && typeof creator === 'function') {
        this.registerWorldCreator(numericMode, creator);
      }
    });
  }

  /**
   * Allows registering additional world modes after construction.
   * @param {number} mode
   * @param {(args: object) => Promise<THREE.Object3D>} creator
   */
  registerCustomMode(mode, creator) {
    if (typeof creator !== 'function') {
      throw new Error('[WorldManagerExtended] creator must be a function');
    }
    this.registerWorldCreator(mode, creator);
  }
}
