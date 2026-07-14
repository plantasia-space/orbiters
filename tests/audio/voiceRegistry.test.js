// @vitest-environment node
/**
 * Keystone — VoiceRegistry: the single source of which orbiter voices exist and which is
 * focused. Pure data structure (no Tone, no DOM), so it's fully unit-tested here. The migration
 * moves each old single-orbiter global onto this registry atomically (no parallel/mirror path).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VoiceRegistry } from '../../src/voice/VoiceRegistry.js';

describe('VoiceRegistry', () => {
  let reg;
  beforeEach(() => { reg = new VoiceRegistry(); });

  it('starts empty with no active voice', () => {
    expect(reg.size).toBe(0);
    expect(reg.activeId).toBeNull();
    expect(reg.getActive()).toBeNull();
    expect(reg.get('nope')).toBeNull();
    expect(reg.has('nope')).toBe(false);
  });

  it('the FIRST registered voice becomes active (single-orbiter needs no extra wiring)', () => {
    const ctx = { id: 'orb-1', audioEngine: {} };
    expect(reg.register('orb-1', ctx)).toBe(ctx);
    expect(reg.size).toBe(1);
    expect(reg.has('orb-1')).toBe(true);
    expect(reg.get('orb-1')).toBe(ctx);
    expect(reg.activeId).toBe('orb-1');
    expect(reg.getActive()).toBe(ctx);
  });

  it('keeps the first voice active when more register; all() preserves order', () => {
    reg.register('a', { id: 'a' });
    reg.register('b', { id: 'b' });
    reg.register('c', { id: 'c' });
    expect(reg.size).toBe(3);
    expect(reg.activeId).toBe('a'); // focus is not stolen by later registrations
    expect(reg.all().map((v) => v.id)).toEqual(['a', 'b', 'c']);
  });

  it('setActive focuses a registered voice and rejects unknown ids', () => {
    reg.register('a', { id: 'a' });
    reg.register('b', { id: 'b' });
    expect(reg.setActive('b')).toEqual({ id: 'b' });
    expect(reg.activeId).toBe('b');
    expect(reg.getActive()).toEqual({ id: 'b' });
    expect(() => reg.setActive('ghost')).toThrow(/no voice registered/);
  });

  it('register replaces an existing voice without changing focus', () => {
    reg.register('a', { id: 'a', v: 1 });
    reg.register('b', { id: 'b' });
    reg.setActive('b');
    reg.register('a', { id: 'a', v: 2 }); // replace a
    expect(reg.get('a')).toEqual({ id: 'a', v: 2 });
    expect(reg.activeId).toBe('b'); // focus unchanged
  });

  it('unregistering the active voice falls back to the first remaining (never dangles)', () => {
    reg.register('a', { id: 'a' });
    reg.register('b', { id: 'b' });
    reg.register('c', { id: 'c' });
    reg.setActive('b');
    expect(reg.unregister('b')).toBe(true);
    expect(reg.has('b')).toBe(false);
    expect(reg.activeId).toBe('a'); // first remaining
    expect(reg.unregister('x')).toBe(false); // no-op for unknown
  });

  it('unregistering the last voice clears the active pointer', () => {
    reg.register('only', { id: 'only' });
    reg.unregister('only');
    expect(reg.size).toBe(0);
    expect(reg.activeId).toBeNull();
    expect(reg.getActive()).toBeNull();
  });

  it('rejects an empty/invalid id', () => {
    expect(() => reg.register('', {})).toThrow();
    expect(() => reg.register(null, {})).toThrow();
  });

  it('clear() drops everything', () => {
    reg.register('a', { id: 'a' });
    reg.register('b', { id: 'b' });
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.activeId).toBeNull();
  });

  // Focus-change notification — the multi-orbiter shell follows the focused tile (mirror its
  // colors to documentElement for portalled menus + move the focus ring).
  describe('onActiveChange', () => {
    it('fires when the FIRST voice auto-activates on register', () => {
      const seen = [];
      reg.onActiveChange((id) => seen.push(id));
      reg.register('a', { id: 'a' });
      expect(seen).toEqual(['a']);
    });

    it('does NOT fire when a later voice registers (focus is unchanged)', () => {
      reg.register('a', { id: 'a' });
      const seen = [];
      reg.onActiveChange((id) => seen.push(id));
      reg.register('b', { id: 'b' });
      expect(seen).toEqual([]); // active stayed 'a'
    });

    it('fires on EVERY setActive — even re-selecting the already-active voice (re-mirror)', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      const seen = [];
      reg.onActiveChange((id) => seen.push(id));
      reg.setActive('b');
      reg.setActive('b'); // re-select: still notifies so a menu opened now re-reads fresh colors
      reg.setActive('a');
      expect(seen).toEqual(['b', 'b', 'a']);
    });

    it('fires on unregister of the active voice with the new active id (null when last)', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      reg.setActive('b');
      const seen = [];
      reg.onActiveChange((id) => seen.push(id));
      reg.unregister('b'); // active falls back to 'a'
      reg.unregister('a'); // last → null
      expect(seen).toEqual(['a', null]);
    });

    it('does NOT fire when unregistering a NON-active voice', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      const seen = [];
      reg.onActiveChange((id) => seen.push(id));
      reg.unregister('b'); // 'a' still active
      expect(seen).toEqual([]);
    });

    it('unsubscribe stops further notifications', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      const seen = [];
      const off = reg.onActiveChange((id) => seen.push(id));
      reg.setActive('b');
      off();
      reg.setActive('a');
      expect(seen).toEqual(['b']);
    });

    it('a throwing listener does not break the registry or other listeners', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      const seen = [];
      reg.onActiveChange(() => { throw new Error('boom'); });
      reg.onActiveChange((id) => seen.push(id));
      expect(() => reg.setActive('b')).not.toThrow();
      expect(seen).toEqual(['b']);
      expect(reg.activeId).toBe('b');
    });
  });

  // Multi-focus selection — shift-click focuses several tiles at once. `activeId` stays the
  // PRIMARY of the selection; the set is the superset. In single-focus the set is exactly {activeId}.
  describe('multi-focus selection', () => {
    it('single-focus: the selection is exactly the one active voice', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      expect(reg.selectionSize).toBe(1);
      expect(reg.getSelection()).toEqual(['a']);
      expect(reg.getFocusTargets()).toEqual(['a']);
      expect(reg.isSelected('a')).toBe(true);
      expect(reg.isSelected('b')).toBe(false);
    });

    it('toggleSelection adds a voice and makes it the new PRIMARY', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      reg.register('c', { id: 'c' });
      reg.toggleSelection('c'); // shift-click c
      expect(reg.selectionSize).toBe(2);
      expect(reg.isSelected('a')).toBe(true);
      expect(reg.isSelected('c')).toBe(true);
      expect(reg.activeId).toBe('c'); // newly added becomes primary
      expect(reg.getSelection()).toEqual(['a', 'c']);
      expect(reg.getFocusTargets()).toEqual(['a', 'c']);
    });

    it('toggleSelection removes a selected voice; primary hands off when it leaves', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      reg.toggleSelection('b'); // selection {a,b}, primary b
      expect(reg.activeId).toBe('b');
      reg.toggleSelection('b'); // remove the primary
      expect(reg.selectionSize).toBe(1);
      expect(reg.isSelected('b')).toBe(false);
      expect(reg.activeId).toBe('a'); // handed back to the remaining selected voice
    });

    it('addToSelection adds a voice WITHOUT repointing the primary (layout-grow path)', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      reg.register('c', { id: 'c' });
      reg.toggleSelection('b'); // selection {a,b}, primary b
      expect(reg.activeId).toBe('b');
      const seenActive = [];
      const seenSelection = [];
      reg.onActiveChange((id) => seenActive.push(id));
      reg.onSelectionChange((ids) => seenSelection.push([...ids]));
      reg.addToSelection('c'); // grow — c joins, primary MUST stay b
      expect(reg.isSelected('c')).toBe(true);
      expect(reg.getSelection()).toEqual(['a', 'b', 'c']);
      expect(reg.activeId).toBe('b'); // primary preserved (unlike toggleSelection)
      expect(seenActive).toEqual([]); // no active-change fired
      expect(seenSelection).toEqual([['a', 'b', 'c']]); // selection-change fired once
    });

    it('addToSelection is idempotent and rejects unknown ids', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      reg.toggleSelection('b');
      const seen = [];
      reg.onSelectionChange((ids) => seen.push([...ids]));
      reg.addToSelection('b'); // already selected → no-op, no notification
      expect(seen).toEqual([]);
      expect(reg.getSelection()).toEqual(['a', 'b']);
      expect(() => reg.addToSelection('ghost')).toThrow(/no voice registered/);
    });

    it('shift-toggling the SOLE focused voice is a no-op (always ≥1 focused)', () => {
      reg.register('a', { id: 'a' });
      const seen = [];
      reg.onSelectionChange((ids) => seen.push([...ids]));
      reg.toggleSelection('a');
      expect(reg.selectionSize).toBe(1);
      expect(reg.isSelected('a')).toBe(true);
      expect(seen).toEqual([]); // nothing changed, no notification
    });

    it('a plain setActive COLLAPSES a multi-selection back to single focus', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      reg.register('c', { id: 'c' });
      reg.toggleSelection('b');
      reg.toggleSelection('c'); // selection {a,b,c}
      expect(reg.selectionSize).toBe(3);
      reg.setActive('b'); // plain click → single focus
      expect(reg.selectionSize).toBe(1);
      expect(reg.getSelection()).toEqual(['b']);
      expect(reg.activeId).toBe('b');
    });

    it('rejects toggling an unknown id', () => {
      reg.register('a', { id: 'a' });
      expect(() => reg.toggleSelection('ghost')).toThrow(/no voice registered/);
    });

    it('unregister removes the voice from the selection and keeps the invariant', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      reg.register('c', { id: 'c' });
      reg.toggleSelection('b');
      reg.toggleSelection('c'); // {a,b,c}, primary c
      reg.unregister('c'); // primary leaves
      expect(reg.isSelected('c')).toBe(false);
      expect(reg.selectionSize).toBe(2);
      expect(reg.isSelected('a')).toBe(true);
      expect(reg.isSelected('b')).toBe(true);
      expect(reg.activeId === 'a' || reg.activeId === 'b').toBe(true); // a still-selected voice
    });

    it('unregistering a non-primary selected voice shrinks the set, keeps the primary', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      reg.toggleSelection('b'); // {a,b}, primary b
      reg.unregister('a'); // non-primary selected
      expect(reg.selectionSize).toBe(1);
      expect(reg.getSelection()).toEqual(['b']);
      expect(reg.activeId).toBe('b');
    });

    describe('onSelectionChange notifications', () => {
      it('fires on register of the first voice, on toggle, and on collapse', () => {
        const seen = [];
        reg.onSelectionChange((ids) => seen.push([...ids]));
        reg.register('a', { id: 'a' }); // [a]
        reg.register('b', { id: 'b' }); // no selection change (a stays sole)
        reg.toggleSelection('b'); // [a,b]
        reg.setActive('a'); // collapse → [a]
        expect(seen).toEqual([['a'], ['a', 'b'], ['a']]);
      });

      it('setActive that does NOT change an already-single selection stays quiet on selection', () => {
        reg.register('a', { id: 'a' });
        reg.register('b', { id: 'b' });
        reg.setActive('b'); // was {a}, becomes {b} — a real change
        const seen = [];
        reg.onSelectionChange((ids) => seen.push([...ids]));
        reg.setActive('b'); // already single {b} — no selection change
        expect(seen).toEqual([]);
      });

      it('unsubscribe stops selection notifications', () => {
        reg.register('a', { id: 'a' });
        reg.register('b', { id: 'b' });
        const seen = [];
        const off = reg.onSelectionChange((ids) => seen.push([...ids]));
        reg.toggleSelection('b');
        off();
        reg.setActive('a');
        expect(seen).toEqual([['a', 'b']]);
      });
    });

    it('clear() drops the selection too', () => {
      reg.register('a', { id: 'a' });
      reg.register('b', { id: 'b' });
      reg.toggleSelection('b');
      reg.clear();
      expect(reg.selectionSize).toBe(0);
      expect(reg.getSelection()).toEqual([]);
      expect(reg.getFocusTargets()).toEqual([]);
      expect(reg.isSelected('a')).toBe(false);
    });
  });

  describe('onVoicesChange', () => {
    it('fires on EVERY register (incl. non-first) and on unregister', () => {
      const counts = [];
      reg.onVoicesChange((voices) => counts.push(voices.length));
      reg.register('a', { id: 'a' }); // first
      reg.register('b', { id: 'b' }); // non-first — active/selection do NOT change, but roster does
      reg.register('c', { id: 'c' });
      reg.unregister('b');
      expect(counts).toEqual([1, 2, 3, 2]);
    });

    it('does not fire when unregister removes a non-existent voice', () => {
      const counts = [];
      reg.register('a', { id: 'a' });
      reg.onVoicesChange((voices) => counts.push(voices.length));
      reg.unregister('ghost');
      expect(counts).toEqual([]);
    });

    it('unsubscribe stops notifications; a throwing listener does not break others', () => {
      const seen = [];
      const off = reg.onVoicesChange(() => seen.push('x'));
      reg.onVoicesChange(() => { throw new Error('boom'); });
      reg.onVoicesChange(() => seen.push('y'));
      reg.register('a', { id: 'a' });
      off();
      reg.register('b', { id: 'b' });
      // First register: all three ran (x, throw-caught, y). Second: x is off → only y.
      expect(seen).toEqual(['x', 'y', 'y']);
    });
  });

  describe('assignAudioEngine', () => {
    it('is the one write path: sets the entry engine and notifies with the context', () => {
      const ctx = { id: 'a' };
      reg.register('a', ctx);
      const seen = [];
      reg.onAudioEngineAssigned((context) => seen.push(context));

      const engine = { name: 'adapter' };
      expect(reg.assignAudioEngine('a', engine)).toBe(ctx);
      expect(ctx.audioEngine).toBe(engine);
      expect(seen).toEqual([ctx]);

      // A rebuilt engine (fresh adapter identity) re-assigns and re-notifies.
      const rebuilt = { name: 'rebuilt' };
      reg.assignAudioEngine('a', rebuilt);
      expect(ctx.audioEngine).toBe(rebuilt);
      expect(seen).toEqual([ctx, ctx]);
      expect(seen[1].audioEngine).toBe(rebuilt);
    });

    it('rejects unknown ids (registration is a precondition of assignment)', () => {
      expect(() => reg.assignAudioEngine('ghost', {})).toThrow(/no voice registered/);
    });

    it('unsubscribe stops notifications; a throwing listener does not break others', () => {
      reg.register('a', { id: 'a' });
      const seen = [];
      const off = reg.onAudioEngineAssigned(() => seen.push('x'));
      reg.onAudioEngineAssigned(() => { throw new Error('boom'); });
      reg.onAudioEngineAssigned(() => seen.push('y'));
      reg.assignAudioEngine('a', {});
      off();
      reg.assignAudioEngine('a', {});
      expect(seen).toEqual(['x', 'y', 'y']);
      expect(reg.onAudioEngineAssigned(null)).toBeTypeOf('function');
    });
  });

  describe('slot order', () => {
    it('stores a copy and notifies voices-change; getSlotOrder returns it', () => {
      let notified = 0;
      reg.onVoicesChange(() => { notified += 1; });
      const order = ['a', null, 'b'];
      reg.setSlotOrder(order);
      expect(reg.getSlotOrder()).toEqual(['a', null, 'b']);
      order.push('mutated'); // external mutation must not leak in (stored a copy)
      expect(reg.getSlotOrder()).toEqual(['a', null, 'b']);
      expect(notified).toBe(1);
    });

    it('defaults to null and can be cleared', () => {
      expect(reg.getSlotOrder()).toBeNull();
      reg.setSlotOrder(['a']);
      expect(reg.getSlotOrder()).toEqual(['a']);
      reg.setSlotOrder(null);
      expect(reg.getSlotOrder()).toBeNull();
    });

    it('clear() resets the slot order', () => {
      reg.setSlotOrder(['a', 'b']);
      reg.clear();
      expect(reg.getSlotOrder()).toBeNull();
    });
  });
});
