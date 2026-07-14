// @vitest-environment node
/**
 * The Info-panel ("Monitor Control") open-state is a PER-VOICE factory, not a module
 * singleton. The key property: two stores (two orbiter tiles) are independent — opening the monitor
 * on one must NOT open it on the other. Pure data (no DOM), so unit-tested here.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInfoPanelStore, isInfoMode } from '../../src/ui/react/regions/infoPanelStore';

describe('createInfoPanelStore', () => {
  it('defaults to the Engine Monitor open (legacy default)', () => {
    expect(createInfoPanelStore().getMode()).toBe('monitor');
    expect(createInfoPanelStore(null).getMode()).toBeNull();
  });

  it('TWO stores are INDEPENDENT — one tile opening the monitor does not affect another', () => {
    const a = createInfoPanelStore(null);
    const b = createInfoPanelStore(null);
    a.setMode('monitor');
    expect(a.getMode()).toBe('monitor');
    expect(b.getMode()).toBeNull(); // the other tile is untouched
    b.setMode('track');
    expect(a.getMode()).toBe('monitor'); // still independent
    expect(b.getMode()).toBe('track');
  });

  it('notifies subscribers on change and is a no-op (no notify) when already in that state', () => {
    const store = createInfoPanelStore('monitor');
    const listener = vi.fn();
    store.subscribe(listener);
    store.setMode('track');
    expect(listener).toHaveBeenCalledTimes(1);
    store.setMode('track'); // same value → no-op
    expect(listener).toHaveBeenCalledTimes(1);
    store.setMode(null); // close
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("a store's subscribers are not notified by another store's changes", () => {
    const a = createInfoPanelStore(null);
    const b = createInfoPanelStore(null);
    const aListener = vi.fn();
    a.subscribe(aListener);
    b.setMode('monitor');
    expect(aListener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', () => {
    const store = createInfoPanelStore(null);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.setMode('monitor');
    off();
    store.setMode('track');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isInfoMode guards known modes', () => {
    expect(isInfoMode('monitor')).toBe(true);
    expect(isInfoMode('orbiter')).toBe(true);
    expect(isInfoMode('nope')).toBe(false);
  });
});
