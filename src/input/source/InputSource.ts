/**
 * @file src/input/source/InputSource.ts
 * @description The one seam every input source routes through (contract).
 *
 * Today the four input sources each hand-roll their push into ParameterManager:
 *   - CosmicLFO        → pm.setDimensionValue(axis, dim, rawValue, src, 10)
 *   - SensorsController → pm.setDimensionValue(...) OR pm.setNormalizedValue(...) (priority 15)
 *   - CameraController  → pm.addDeltaNormalized(axis, deltaNorm, src, 1)
 *   - MIDIController    → pm.setDimensionValue(...) (priority from PRIORITY_MAP) — plus a
 *                         widget-DOM path, intentionally NOT migrated here.
 *
 * That's three different methods, four ad-hoc priority constants, and four copies of
 * dimension-scope resolution. This interface unifies the outbound side: a source holds an
 * {@link InputSource} (bound to its identity + default priority) and calls `set(...)`. The
 * dimension is resolved once behind the seam via {@link ./ScopingResolver}, and the call is
 * dispatched to the matching ParameterManager entry by its {@link ValueKind}.
 *
 * This file is the contract only — the concrete router that wraps ParameterManager and the
 * per-source adapters land in the following increments (Camera → Sensors → Cosmic), each
 * driven by a real consumer so the shape stays honest rather than speculative.
 */

/**
 * How `value` in {@link SetOptions} should be interpreted — the write shapes the existing
 * sources use, mapped to ParameterManager's entry points:
 *   - `raw`        → absolute value in the parameter's own range → `setDimensionValue` /
 *                    `setRawValue` (when no `dim` is given)
 *   - `normalized` → absolute value in `[0, 1]`                  → `setNormalizedValue`
 *   - `delta`      → relative change in normalized `[-1, 1]`     → `addDeltaNormalized`
 *   - `rawDelta`   → relative change in the parameter's range    → `addDeltaValue`
 */
export type ValueKind = 'raw' | 'normalized' | 'delta' | 'rawDelta';

/** Per-call options for {@link InputSource.set}. */
export interface SetOptions {
  /**
   * Interpretation of the pushed value. Defaults to `raw` (the most common case:
   * CosmicLFO, MIDI, and Sensors' multidimensional path).
   */
  kind?: ValueKind;
  /**
   * Arbitration priority (lower wins on simultaneous writes — see ParameterManager).
   * Omit to use the source's bound default priority.
   */
  priority?: number;
  /**
   * Target dimension. Omit to resolve the active dimension via the ScopingResolver behind
   * the seam. Ignored for single-dimension parameters.
   */
  dim?: string | null;
}

/**
 * A handle one input source uses to push into ParameterManager. Bound at creation to a
 * stable source identity and a default priority; the dimension scope is resolved behind
 * the seam unless `dim` is given explicitly.
 */
export interface InputSource {
  /** Stable identity string used for arbitration ("same controller may keep writing"). */
  readonly id: string;

  /**
   * Push `value` for `param` (e.g. an axis) into ParameterManager through the one canonical
   * entry point. Dispatches by {@link SetOptions.kind}. When {@link SetOptions.dim} is omitted
   * the value goes to the parameter's active dimension (ParameterManager resolves it).
   */
  set(param: string, value: number, options?: SetOptions): void;
}

/**
 * The single canonical entry point onto ParameterManager. One instance is created with the
 * app's ParameterManager; each input source asks it for an {@link InputSource} handle. This
 * is where the three ParameterManager methods are funnelled into one place (implemented in
 * the next increment, alongside the first real consumer).
 */
export interface InputRouter {
  /**
   * Mint an {@link InputSource} bound to `id` and `defaultPriority`. The handle resolves its
   * dimension scope through the shared ScopingResolver, optionally consulting the router's
   * ParameterManager fallback for multidimensional axes (CosmicLFO's behaviour).
   */
  source(id: string, defaultPriority: number): InputSource;
}
