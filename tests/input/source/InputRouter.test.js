import { describe, it, expect, vi } from 'vitest';
import { createInputRouter } from '../../../src/input/source/InputRouter.ts';

/** A ParameterManager test double that records every dispatch. */
function makePM() {
  return {
    setDimensionValue: vi.fn(),
    setRawValue: vi.fn(),
    setNormalizedValue: vi.fn(),
    addDeltaNormalized: vi.fn(),
    addDeltaValue: vi.fn(),
  };
}

describe('InputRouter — dispatch by kind', () => {
  it("kind 'raw' with a dim → setDimensionValue", () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('SensorController', 9);
    src.set('y', -85, { kind: 'raw', dim: 'EW::I', priority: 8 });
    expect(pm.setDimensionValue).toHaveBeenCalledWith('y', 'EW::I', -85, 'SensorController', 8);
    expect(pm.setRawValue).not.toHaveBeenCalled();
  });

  it("kind 'raw' without a dim → setRawValue (active dimension)", () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('SensorController', 8);
    src.set('x', 0.25, { kind: 'raw' });
    expect(pm.setRawValue).toHaveBeenCalledWith('x', 0.25, 'SensorController', 8);
    expect(pm.setDimensionValue).not.toHaveBeenCalled();
  });

  it("kind 'normalized' → setNormalizedValue", () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('SensorController', 10);
    src.set('z', 0.5, { kind: 'normalized', priority: 10 });
    expect(pm.setNormalizedValue).toHaveBeenCalledWith('z', 0.5, 'SensorController', 10);
  });

  it("kind 'delta' → addDeltaNormalized (with dim passed through)", () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('CameraController', 1);
    src.set('x', 0.1, { kind: 'delta', dim: 'EW::II', priority: 1 });
    expect(pm.addDeltaNormalized).toHaveBeenCalledWith('x', 0.1, 'CameraController', 1, 'EW::II');
  });

  it("kind 'delta' without a dim → addDeltaNormalized with null dim", () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('CameraController', 1);
    src.set('x', 0.1, { kind: 'delta' });
    expect(pm.addDeltaNormalized).toHaveBeenCalledWith('x', 0.1, 'CameraController', 1, null);
  });

  it("kind 'rawDelta' → addDeltaValue (camera drag scaled into param range)", () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('CameraController', 1);
    src.set('y', 12.5, { kind: 'rawDelta', priority: 1 });
    expect(pm.addDeltaValue).toHaveBeenCalledWith('y', 12.5, 'CameraController', 1, null);
    expect(pm.addDeltaNormalized).not.toHaveBeenCalled();
  });

  it('defaults kind to raw when omitted', () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('S', 5);
    src.set('x', 42, { dim: 'EW::I' });
    expect(pm.setDimensionValue).toHaveBeenCalledWith('x', 'EW::I', 42, 'S', 5);
  });
});

describe('InputRouter — priority resolution', () => {
  it('uses the per-call priority when given', () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('S', 99);
    src.set('x', 1, { kind: 'normalized', priority: 3 });
    expect(pm.setNormalizedValue).toHaveBeenCalledWith('x', 1, 'S', 3);
  });

  it("falls back to the source's bound default priority", () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('S', 7);
    src.set('x', 1, { kind: 'normalized' });
    expect(pm.setNormalizedValue).toHaveBeenCalledWith('x', 1, 'S', 7);
  });

  it('binds the source id used for arbitration', () => {
    const pm = makePM();
    const src = createInputRouter(pm).source('SensorController', 8);
    expect(src.id).toBe('SensorController');
  });
});
