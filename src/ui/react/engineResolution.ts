/**
 * @file src/ui/react/engineResolution.ts
 * @description The PURE resolution-report policy for the React↔runtime seam.
 *
 * This module deliberately has no singleton imports (only the `MIDI_SUPPORTED`
 * platform flag), so the report shape and the "loud on drift" policy are testable in
 * isolation — `resolveEngineSingletons` reaches the real singletons and is dragged into
 * the whole Main.js import graph, which can't be unit-imported.
 *
 * Background: every reader in `resolveEngineSingletons` shape-guards its singleton and
 * returns null on mismatch. A singleton that is PRESENT but shape-drifted (e.g. a renamed
 * export) used to resolve to null silently → a blank region with no error, once the
 * legacy fallback that masked it was removed. The report makes that observable;
 * `warnOnMissingExpectedSurfaces` makes it loud in dev.
 */

import { MIDI_SUPPORTED } from '../../config/Constants.js';

/** The engine surfaces whose reader can resolve to null (so are worth reporting). */
export type EngineSurfaceKey =
  | 'midi'
  | 'dims'
  | 'panels'
  | 'transport'
  | 'sync'
  | 'cosmic'
  | 'sensors'
  | 'webRtc'
  | 'audioEngine'
  | 'info';

/** A flat record of which surfaces resolved to a live singleton at mount. */
export type EngineResolutionReport = Record<EngineSurfaceKey, boolean>;

/**
 * Surfaces whose singletons are module-level and therefore MUST be live by the time the
 * React shell mounts (mount happens well after boot): `panels` (PanelManagerInstance),
 * `transport` (transportControl), `sync` (syncCoordinator) are all module-level exports.
 * A false for one of these is a real signal — most likely singleton shape drift, e.g. a
 * renamed/changed export — not a not-yet-initialized lazy surface.
 *
 * The remaining surfaces are created lazily / conditionally and are legitimately absent at
 * mount, so they never warn: `cosmic` (post audio-init), `sensors`/`webRtc` (first
 * Sensors-panel use), `audioEngine` (audio init), `dims` (edit mode only), `info` (no track
 * loaded yet). `midi` is conditionally expected — see `warnOnMissingExpectedSurfaces`.
 */
export const ALWAYS_EXPECTED_SURFACES: EngineSurfaceKey[] = ['panels', 'transport', 'sync'];

/**
 * Emit a loud, dev-only warning when an EXPECTED engine surface failed to resolve at
 * mount. Silent null-resolution used to hide singleton shape drift behind a blank region;
 * this surfaces it instead.
 *
 * `midi` is expected only when the platform supports Web MIDI (mirrors
 * `disableMidiUIForUnsupportedEnv` in Main.js); when unsupported, its absence is legitimate.
 *
 * @param report the mount-time resolution report.
 * @param midiSupported injected for testability; defaults to the platform capability.
 * @returns the list of missing expected surfaces (returned so tests need not spy on console).
 */
export function warnOnMissingExpectedSurfaces(
  report: EngineResolutionReport,
  midiSupported: boolean = MIDI_SUPPORTED,
): EngineSurfaceKey[] {
  const expected: EngineSurfaceKey[] = midiSupported
    ? [...ALWAYS_EXPECTED_SURFACES, 'midi']
    : ALWAYS_EXPECTED_SURFACES;
  const missing = expected.filter((key) => !report[key]);
  if (missing.length && import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mountOrbitersUI] expected engine surfaces absent at mount: ${missing.join(', ')} — ` +
        'likely singleton shape drift (a renamed/changed export); the matching regions will render empty.',
    );
  }
  return missing;
}
