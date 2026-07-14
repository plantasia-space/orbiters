// Transitional re-exports while the controller migrates to the orbiter namespace.
// TODO: Remove this file once all imports use orbiter/OrbiterModeController directly.

export { default as OrbitersPlayMode } from '../orbiter/OrbitersPlayMode.js';
export { default as OrbitersEditMode } from '../orbiter/edit/OrbitersEditMode.js';
export {
  default as WorldModeController,
  OrbiterModeController,
} from '../orbiter/OrbiterModeController.js';
