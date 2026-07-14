import { describe, it, expect } from 'vitest';
import {
  resolveScopedContext,
  DEFAULT_STACK_ID,
} from '../../../src/input/source/ScopingResolver.ts';

/**
 * Characterization tests for the consolidated scope resolution.
 *
 * These pin the union of the two pre-existing `getScopedContext()` implementations:
 *   - SensorsController (base resolve, no ParameterManager fallback)
 *   - CosmicLFO         (base resolve + ParameterManager fallback for multidimensional axes)
 *
 * `modeController` is passed explicitly everywhere so the tests don't depend on the active voice's
 * `worldMode` (the voice registry default).
 */

describe('resolveScopedContext — base resolve (SensorsController behaviour)', () => {
  it('falls back to deck-i / null when no controller is present', () => {
    expect(resolveScopedContext({ modeController: null })).toEqual({
      stackId: DEFAULT_STACK_ID,
      dimensionId: null,
    });
  });

  it('reads activeStackId and activeDimensionId off modes.edit', () => {
    const modeController = {
      modes: { edit: { activeStackId: 'deck-ii', activeDimensionId: 'EW::I' } },
    };
    expect(resolveScopedContext({ modeController })).toEqual({
      stackId: 'deck-ii',
      dimensionId: 'EW::I',
    });
  });

  it('defaults the stack to deck-i when edit mode has no activeStackId', () => {
    const modeController = { modes: { edit: { activeDimensionId: 'EW::II' } } };
    expect(resolveScopedContext({ modeController })).toEqual({
      stackId: DEFAULT_STACK_ID,
      dimensionId: 'EW::II',
    });
  });

  it('falls back to getActiveDimensionId() when activeDimensionId is absent', () => {
    const modeController = {
      modes: { edit: { activeStackId: 'deck-i' } },
      getActiveDimensionId: () => 'EW::III',
    };
    expect(resolveScopedContext({ modeController }).dimensionId).toBe('EW::III');
  });

  it('prefers activeDimensionId over getActiveDimensionId()', () => {
    const modeController = {
      modes: { edit: { activeDimensionId: 'EW::I' } },
      getActiveDimensionId: () => 'EW::SHOULD-NOT-WIN',
    };
    expect(resolveScopedContext({ modeController }).dimensionId).toBe('EW::I');
  });

  it('normalizes an undefined getActiveDimensionId() result to null', () => {
    const modeController = {
      modes: { edit: { activeStackId: 'deck-i' } },
      getActiveDimensionId: () => undefined,
    };
    expect(resolveScopedContext({ modeController }).dimensionId).toBeNull();
  });

  it('does NOT consult ParameterManager when no parameterManager/axis is given', () => {
    // Sensors path: even with nothing active, no PM fallback occurs.
    const modeController = { modes: { edit: { activeStackId: 'deck-i' } } };
    expect(resolveScopedContext({ modeController }).dimensionId).toBeNull();
  });
});

describe('resolveScopedContext — ParameterManager fallback (CosmicLFO behaviour)', () => {
  const emptyMode = { modes: { edit: { activeStackId: 'deck-i' } } };

  it('falls back to the axis parameter active dimension when multidimensional', () => {
    const parameterManager = {
      getParameter: (name) =>
        name === 'x' ? { isMultidimensional: true, activeDimensionId: 'EW::PM' } : null,
    };
    const result = resolveScopedContext({
      modeController: emptyMode,
      parameterManager,
      axis: 'x',
    });
    expect(result.dimensionId).toBe('EW::PM');
  });

  it('does NOT fall back when the parameter is not multidimensional', () => {
    const parameterManager = {
      getParameter: () => ({ isMultidimensional: false, activeDimensionId: 'EW::PM' }),
    };
    expect(
      resolveScopedContext({ modeController: emptyMode, parameterManager, axis: 'x' })
        .dimensionId,
    ).toBeNull();
  });

  it('does NOT use the PM fallback when the controller already resolved a dimension', () => {
    const modeController = { modes: { edit: { activeDimensionId: 'EW::FROM-MODE' } } };
    const parameterManager = {
      getParameter: () => ({ isMultidimensional: true, activeDimensionId: 'EW::PM' }),
    };
    expect(
      resolveScopedContext({ modeController, parameterManager, axis: 'x' }).dimensionId,
    ).toBe('EW::FROM-MODE');
  });

  it('tolerates a ParameterManager without getParameter', () => {
    expect(
      resolveScopedContext({ modeController: emptyMode, parameterManager: {}, axis: 'x' })
        .dimensionId,
    ).toBeNull();
  });
});
