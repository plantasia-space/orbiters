/**
 * A/B/C/D slot assignment for the mobile picker. Must (1) never drop a live voice — even if the
 * published stage order is stale/empty (a reconcile can leave it pointing at just-unregistered ids), so
 * the picker never vanishes; (2) match the desktop's stage-index letters when the order is fresh; (3) keep
 * slot indices unique.
 */
import { describe, it, expect } from 'vitest';
import { assignOrbiterSlots } from '../../src/api/WebRTCManager.js';

const letters = (assigned) => assigned.map((a) => a.slotIndex);

describe('assignOrbiterSlots', () => {
  it('uses stage order when it matches the live voices (fixes the B↔C swap)', () => {
    // Registration order [a,b,c] but the desktop stages them [c,a,b] → a=B(1), b=C(2), c=A(0).
    const assigned = assignOrbiterSlots(['a', 'b', 'c'], ['c', 'a', 'b']);
    expect(assigned).toEqual([
      { id: 'a', slotIndex: 1 },
      { id: 'b', slotIndex: 2 },
      { id: 'c', slotIndex: 0 },
    ]);
  });

  it('falls back to registration order when the stage order is null (never empty/dropped)', () => {
    expect(letters(assignOrbiterSlots(['a', 'b', 'c'], null))).toEqual([0, 1, 2]);
  });

  it('does NOT drop voices when the stage order is STALE (ids no longer present) — the disappearing-picker bug', () => {
    // order points at ids that are gone; live voices are a,b,c. Every voice must still get a unique slot.
    const assigned = assignOrbiterSlots(['a', 'b', 'c'], ['gone1', 'gone2', 'gone3']);
    expect(assigned.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(letters(assigned)).toEqual([0, 1, 2]); // fell back to registration order, none dropped
  });

  it('keeps slot indices unique when order is partial (some voices in it, some not)', () => {
    // order places c at stage 0; a and b are absent from order → fill the remaining free slots 1,2.
    const assigned = assignOrbiterSlots(['a', 'b', 'c'], ['c']);
    const idxs = letters(assigned);
    expect(new Set(idxs).size).toBe(idxs.length); // unique
    expect(assigned.find((a) => a.id === 'c').slotIndex).toBe(0); // c keeps its stage slot
  });

  it('caps at four voices and handles empty input', () => {
    expect(assignOrbiterSlots(['a', 'b', 'c', 'd', 'e'], null)).toHaveLength(4);
    expect(assignOrbiterSlots([], null)).toEqual([]);
    expect(assignOrbiterSlots(['a'], [])).toEqual([{ id: 'a', slotIndex: 0 }]);
  });
});
