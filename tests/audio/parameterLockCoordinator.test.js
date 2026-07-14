/**
 * The lock coordinator: several causes claim knob dimensions; a dimension
 * stays locked exactly as long as at least one cause claims it, and lock /
 * unlock calls reach ParameterManager only as deltas (never re-locking what
 * is already locked). This is the split-ownership bug class the coordinator
 * exists to prevent — ParameterManager's locks are a plain set, so two
 * independent lockers would release each other's locks. The cause map is
 * replaced ATOMICALLY (one apply per update): per-cause setters would apply
 * intermediate unions, briefly locking stale targets after a period with no
 * manager.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParameterLockCoordinator } from '../../src/audio/parameterLockCoordinator.js';

let manager;
const makeCoordinator = (getManager = () => manager) =>
  new ParameterLockCoordinator({ getManager });

beforeEach(() => {
  manager = {
    lockParameterDimension: vi.fn(),
    unlockParameterDimension: vi.fn(),
  };
});

const X1 = { axis: 'x', dimensionId: 'dim-1' };
const Y1 = { axis: 'y', dimensionId: 'dim-1' };

describe('ParameterLockCoordinator', () => {
  it('unlocks namespaced dimension ids without parsing the composite key', () => {
    const coordinator = makeCoordinator();

    coordinator.setCauses({ speed: [{ axis: 'x', dimensionId: 'EW::I' }] });
    coordinator.setCauses({});

    expect(manager.unlockParameterDimension).toHaveBeenCalledWith('x', 'EW::I');
  });

  it('locks a cause\'s targets and releases them when the cause clears', () => {
    const coordinator = makeCoordinator();
    coordinator.setCauses({ 'speed-lock': [X1, Y1] });
    expect(manager.lockParameterDimension).toHaveBeenCalledWith('x', 'dim-1');
    expect(manager.lockParameterDimension).toHaveBeenCalledWith('y', 'dim-1');

    coordinator.setCauses({ 'speed-lock': [] });
    expect(manager.unlockParameterDimension).toHaveBeenCalledWith('x', 'dim-1');
    expect(manager.unlockParameterDimension).toHaveBeenCalledWith('y', 'dim-1');
  });

  it('a dimension claimed by two causes survives one cause clearing', () => {
    const coordinator = makeCoordinator();
    coordinator.setCauses({ 'speed-lock': [X1], 'engine-block': [X1] });

    coordinator.setCauses({ 'speed-lock': [], 'engine-block': [X1] });
    expect(manager.unlockParameterDimension).not.toHaveBeenCalled();

    coordinator.setCauses({ 'speed-lock': [], 'engine-block': [] });
    expect(manager.unlockParameterDimension).toHaveBeenCalledWith('x', 'dim-1');
  });

  it('applies deltas only — an unchanged claim never re-locks', () => {
    const coordinator = makeCoordinator();
    coordinator.setCauses({ 'speed-lock': [X1] });
    coordinator.setCauses({ 'speed-lock': [X1] });
    coordinator.setCauses({ 'speed-lock': [X1], 'engine-block': [Y1] });
    expect(manager.lockParameterDimension).toHaveBeenCalledTimes(2); // x once, y once
  });

  it('replacing a cause\'s targets unlocks only what it no longer claims', () => {
    const coordinator = makeCoordinator();
    coordinator.setCauses({ 'engine-block': [X1, Y1] });
    manager.lockParameterDimension.mockClear();

    coordinator.setCauses({ 'engine-block': [Y1] });
    expect(manager.unlockParameterDimension).toHaveBeenCalledWith('x', 'dim-1');
    expect(manager.unlockParameterDimension).toHaveBeenCalledTimes(1);
    expect(manager.lockParameterDimension).not.toHaveBeenCalled();
  });

  it('after a no-manager period, the next update applies only CURRENT causes (no stale locks)', () => {
    let live = null;
    const coordinator = makeCoordinator(() => live);
    // While there is no manager, a cause comes and goes — nothing must leak.
    coordinator.setCauses({ 'speed-lock': [X1, { axis: 'x' }, { dimensionId: 'dim-1' }] });

    live = manager;
    coordinator.setCauses({ 'engine-block': [Y1] });
    expect(manager.lockParameterDimension).toHaveBeenCalledTimes(1);
    expect(manager.lockParameterDimension).toHaveBeenCalledWith('y', 'dim-1');
    expect(manager.unlockParameterDimension).not.toHaveBeenCalled();
  });
});
