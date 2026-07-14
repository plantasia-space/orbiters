// @vitest-environment jsdom
/**
 * The rack-effect slot observation seam (the visual layers' event source):
 *   - `EffectsRack.observeSlots` — notified `(slot, false)` right before a slot's
 *     effect is disposed (so taps detach while the node is valid); observer
 *     errors are contained; unsubscribe works.
 *   - `AudioEngineAdapter.peekEffectSlots` / `observeEffectSlots` — the
 *     adapter-level aggregation across every dimension chain (all chains run
 *     in series and stay audible, so no active-dimension filtering).
 */
import { describe, it, expect, vi } from 'vitest';
import { EffectsRack } from '../../src/audio/effects/rack.js';
import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';

function fakeSlot() {
  return {
    config: { effectId: 'tone.feedbackdelay' },
    effectNode: { disconnect: vi.fn() },
    effectInstance: { dispose: vi.fn() },
    module: { setAutomationBridge: vi.fn() },
    automation: null,
  };
}

describe('EffectsRack.observeSlots', () => {
  it('notifies (slot, false) before each live slot is disposed at rack teardown', () => {
    const rack = new EffectsRack({ channel: 'x', dimensionId: 'EW::III' });
    const slot = fakeSlot();
    rack.slots[0] = slot;

    const seen = [];
    rack.observeSlots((observedSlot, present) => {
      // Notified BEFORE teardown: the node must not have been disconnected yet.
      seen.push([observedSlot, present, slot.effectNode.disconnect.mock.calls.length]);
    });
    rack.dispose();

    expect(seen).toEqual([[slot, false, 0]]);
    expect(slot.effectInstance.dispose).toHaveBeenCalled();
  });

  it('unsubscribe stops notifications; a throwing observer cannot break the rack', () => {
    const rack = new EffectsRack({ channel: 'y', dimensionId: 'EW::III' });
    rack.slots[0] = fakeSlot();

    const unsubscribed = vi.fn();
    rack.observeSlots(unsubscribed)();
    const throwing = vi.fn(() => { throw new Error('visual layer bug'); });
    rack.observeSlots(throwing);

    expect(() => rack.dispose()).not.toThrow();
    expect(unsubscribed).not.toHaveBeenCalled();
    expect(throwing).toHaveBeenCalled();
  });

  it('tolerates non-function observers', () => {
    const rack = new EffectsRack({ channel: 'z', dimensionId: 'EW::III' });
    expect(() => rack.observeSlots(null)()).not.toThrow();
  });
});

describe('AudioEngineAdapter effect-slot aggregation', () => {
  function fakeAdapterThis(chains) {
    return {
      _dimensionChains: new Map(chains),
      _effectSlotObservers: new Set(),
    };
  }

  it('peekEffectSlots walks every dimension chain and axis rack, skipping empty slots', () => {
    const slotA = fakeSlot();
    const slotB = fakeSlot();
    const fakeThis = fakeAdapterThis([
      ['EW::I', { axisRacks: { x: { slots: [null, slotA] }, y: null } }],
      ['EW::III', { axisRacks: { x: { slots: [slotB] }, z: { slots: [] } } }],
    ]);

    const slots = AudioEngineAdapter.prototype.peekEffectSlots.call(fakeThis);
    expect(slots).toEqual([slotA, slotB]);
  });

  it('observeEffectSlots relays rack notifications to subscribers until unsubscribed', () => {
    const fakeThis = fakeAdapterThis([]);
    const cb = vi.fn();
    const unsubscribe = AudioEngineAdapter.prototype.observeEffectSlots.call(fakeThis, cb);

    const slot = fakeSlot();
    AudioEngineAdapter.prototype._notifyEffectSlot.call(fakeThis, slot, true);
    expect(cb).toHaveBeenCalledWith(slot, true);

    unsubscribe();
    AudioEngineAdapter.prototype._notifyEffectSlot.call(fakeThis, slot, false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber cannot break the relay', () => {
    const fakeThis = fakeAdapterThis([]);
    AudioEngineAdapter.prototype.observeEffectSlots.call(fakeThis, () => { throw new Error('bug'); });
    const healthy = vi.fn();
    AudioEngineAdapter.prototype.observeEffectSlots.call(fakeThis, healthy);

    expect(() => AudioEngineAdapter.prototype._notifyEffectSlot.call(fakeThis, fakeSlot(), true)).not.toThrow();
    expect(healthy).toHaveBeenCalled();
  });
});
