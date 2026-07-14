/**
 * @file src/input/source/InputRouter.ts
 * @description The one canonical entry point onto ParameterManager.
 *
 * Wraps a ParameterManager and hands out {@link InputSource} handles. Every input source
 * pushes through `source.set(param, value, { kind, priority, dim })`, and this is the single
 * place that funnels the three write shapes into ParameterManager's matching methods:
 *
 *   kind 'raw'        → setDimensionValue(param, dim, value, …)  (dim given)
 *                     → setRawValue(param, value, …)             (dim omitted → active dim)
 *   kind 'normalized' → setNormalizedValue(param, value, …)
 *   kind 'delta'      → addDeltaNormalized(param, value, …, dim)
 *   kind 'rawDelta'   → addDeltaValue(param, value, …, dim)
 *
 * Priorities are NOT invented here — callers pass the value resolved from the single
 * source-of-truth table (`PRIORITY_MAP` / `getPriority` in src/config/Constants.js), or fall
 * back to the source's bound default. The source identity is bound once so ParameterManager's
 * "same controller may keep writing" arbitration works.
 */

import type { InputRouter, InputSource, SetOptions } from './InputSource.js';

/** The slice of ParameterManager this router dispatches to. */
export interface RoutableParameterManager {
  setDimensionValue(
    param: string, dimensionId: string, value: number,
    sourceController?: unknown, priority?: number,
  ): void;
  setRawValue(
    param: string, value: number, sourceController?: unknown, priority?: number,
  ): void;
  setNormalizedValue(
    param: string, value: number, sourceController?: unknown, priority?: number,
  ): void;
  addDeltaNormalized(
    param: string, deltaNormalized: number, sourceController?: unknown,
    priority?: number, dimensionId?: string | null,
  ): void;
  addDeltaValue(
    param: string, deltaRaw: number, sourceController?: unknown,
    priority?: number, dimensionId?: string | null,
  ): void;
}

class RoutedInputSource implements InputSource {
  readonly id: string;
  private readonly pm: RoutableParameterManager;
  private readonly defaultPriority: number;

  constructor(pm: RoutableParameterManager, id: string, defaultPriority: number) {
    this.pm = pm;
    this.id = id;
    this.defaultPriority = defaultPriority;
  }

  set(param: string, value: number, options: SetOptions = {}): void {
    const priority = options.priority ?? this.defaultPriority;
    const kind = options.kind ?? 'raw';
    const dim = options.dim ?? null;

    switch (kind) {
      case 'normalized':
        this.pm.setNormalizedValue(param, value, this.id, priority);
        return;
      case 'delta':
        this.pm.addDeltaNormalized(param, value, this.id, priority, dim);
        return;
      case 'rawDelta':
        this.pm.addDeltaValue(param, value, this.id, priority, dim);
        return;
      case 'raw':
      default:
        if (dim != null) {
          this.pm.setDimensionValue(param, dim, value, this.id, priority);
        } else {
          // No explicit dimension → ParameterManager writes the parameter's active dimension.
          this.pm.setRawValue(param, value, this.id, priority);
        }
    }
  }
}

/** Create the canonical input router for a ParameterManager. */
export function createInputRouter(parameterManager: RoutableParameterManager): InputRouter {
  return {
    source(id: string, defaultPriority: number): InputSource {
      return new RoutedInputSource(parameterManager, id, defaultPriority);
    },
  };
}
