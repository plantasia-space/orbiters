/**
 * @file tests/multi/stageArrangement.test.js
 * @description Pure arrangement math for the multi-stage Studio arrange UX. Locks the model — stages start
 * EMPTY and fill only from explicit placements (DUPLICATES ALLOWED), the minimal realm reconcile, and the
 * drawer reorder.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDesiredArrangement,
  planReconcile,
  moveEntryBefore,
  swapDescriptor,
} from '../../src/multi/stageArrangement.js';

// A placement entry as the caller stores it (minted voiceId over the source card's id).
const place = (source, n) => ({ voiceId: `${source}::${n}`, sourceVoiceId: source });

describe('buildDesiredArrangement', () => {
  it('is all-empty with no placements — stages start as placeholders (nothing auto-loads)', () => {
    const desired = buildDesiredArrangement(new Map(), 4);
    expect(desired).toEqual([null, null, null, null]);
  });

  it('fills only the stages that have an explicit placement', () => {
    const overrides = new Map([
      [0, place('a', 1)],
      [2, place('c', 2)],
    ]);
    const desired = buildDesiredArrangement(overrides, 4);
    expect(desired.map((e) => e?.voiceId ?? null)).toEqual(['a::1', null, 'c::2', null]);
  });

  it('keeps a deliberately-cleared stage empty', () => {
    const overrides = new Map([
      [0, place('a', 1)],
      [1, null],
    ]);
    const desired = buildDesiredArrangement(overrides, 3);
    expect(desired.map((e) => e?.voiceId ?? null)).toEqual(['a::1', null, null]);
  });

  it('ALLOWS duplicates — the same source entry on two stages via distinct minted voiceIds', () => {
    const overrides = new Map([
      [0, place('a', 1)],
      [2, place('a', 2)],
    ]);
    const desired = buildDesiredArrangement(overrides, 3);
    expect(desired.map((e) => e?.voiceId ?? null)).toEqual(['a::1', null, 'a::2']);
  });
});

describe('planReconcile', () => {
  it('is a no-op when the realm already matches the desired arrangement', () => {
    const desired = buildDesiredArrangement(new Map([[0, place('a', 1)]]), 3);
    const { removes, adds } = planReconcile(['a::1', null, null], desired);
    expect(removes).toEqual([]);
    expect(adds).toEqual([]);
  });

  it('adds a voice for a stage whose placement is not live yet (a drop)', () => {
    const desired = buildDesiredArrangement(new Map([[1, place('b', 1)]]), 3);
    const { removes, adds } = planReconcile([null, null, null], desired);
    expect(removes).toEqual([]);
    expect(adds.map((a) => a.index)).toEqual([1]);
    expect(adds.map((a) => a.entry.voiceId)).toEqual(['b::1']);
  });

  it('removes voices on stages beyond the target (a shrink), leaving survivors untouched', () => {
    const desired = buildDesiredArrangement(new Map([[0, place('a', 1)], [2, place('c', 1)]]), 2);
    const { removes, adds } = planReconcile(['a::1', null, 'c::1'], desired);
    expect(removes).toEqual([{ index: 2, voiceId: 'c::1' }]);
    expect(adds).toEqual([]); // stage 0 survivor untouched — no audio cut
  });

  it('replaces a stage whose placement changed (remove old, add new)', () => {
    const desired = buildDesiredArrangement(new Map([[0, place('c', 1)]]), 3);
    const { removes, adds } = planReconcile(['a::1', null, null], desired);
    expect(removes).toEqual([{ index: 0, voiceId: 'a::1' }]);
    expect(adds).toEqual([{ index: 0, entry: { voiceId: 'c::1', sourceVoiceId: 'c' } }]);
  });

  it('clears a stage: removes its voice with no re-add', () => {
    const desired = buildDesiredArrangement(new Map([[0, place('a', 1)], [1, null]]), 3);
    const { removes, adds } = planReconcile(['a::1', 'b::1', null], desired);
    expect(removes).toEqual([{ index: 1, voiceId: 'b::1' }]);
    expect(adds).toEqual([]);
  });

  it('is a zero-delta when a placement mutates IN PLACE keeping its minted voiceId (a track swap)', () => {
    // A track swap re-seats the stage identity by rewriting the placement's fields but KEEPING the
    // minted voiceId — the live voice already carries the new session, so the next reconcile must
    // not remove/re-add anything.
    const overrides = new Map([[0, { voiceId: 'a::1', sourceVoiceId: 'b', trackId: 'track-b' }]]);
    const desired = buildDesiredArrangement(overrides, 2);
    const { removes, adds } = planReconcile(['a::1', null], desired);
    expect(removes).toEqual([]);
    expect(adds).toEqual([]);
  });
});

describe('swapDescriptor', () => {
  // The stage's live resolved request — every dimension present, with pinned versions.
  const current = {
    trackId: 'track-a',
    trackVersion: 3,
    orbiterId: 'orb-a',
    orbiterVersion: 2,
    entangledWorldId: 'world-a',
    entangledWorldVersion: 1,
  };

  it('swaps ONLY the track: kept dimensions stay explicit, their versions pinned, the new track unpinned', () => {
    const swap = swapDescriptor(current, { trackId: 'track-b' });
    expect(swap.dim).toBe('track');
    expect(swap.noop).toBe(false);
    expect(swap.session).toEqual({ trackId: 'track-b', orbiterId: 'orb-a', entangledWorldId: 'world-a' });
    expect(swap.requested).toEqual({ trackVersion: null, orbiterVersion: 2, entangledWorldVersion: 1 });
  });

  it('swaps ONLY the orbiter, keeping track + world', () => {
    const swap = swapDescriptor(current, { orbiterId: 'orb-b' });
    expect(swap.dim).toBe('orbiter');
    expect(swap.session).toEqual({ trackId: 'track-a', orbiterId: 'orb-b', entangledWorldId: 'world-a' });
    expect(swap.requested).toEqual({ trackVersion: 3, orbiterVersion: null, entangledWorldVersion: 1 });
  });

  it('swaps ONLY the world, keeping track + orbiter', () => {
    const swap = swapDescriptor(current, { entangledWorldId: 'world-b' });
    expect(swap.dim).toBe('world');
    expect(swap.session).toEqual({ trackId: 'track-a', orbiterId: 'orb-a', entangledWorldId: 'world-b' });
    expect(swap.requested).toEqual({ trackVersion: 3, orbiterVersion: 2, entangledWorldVersion: null });
  });

  it('classifies a multi-id card by precedence: track first', () => {
    const swap = swapDescriptor(current, { trackId: 'track-b', orbiterId: 'orb-b', entangledWorldId: 'world-b' });
    expect(swap.dim).toBe('track');
    expect(swap.session).toEqual({ trackId: 'track-b', orbiterId: 'orb-a', entangledWorldId: 'world-a' });
  });

  it('keeps an absent dimension explicitly null (never undefined — the merge would back-fill it)', () => {
    const swap = swapDescriptor({ trackId: 'track-a' }, { entangledWorldId: 'world-b' });
    expect(swap.session).toEqual({ trackId: 'track-a', orbiterId: null, entangledWorldId: 'world-b' });
    expect(swap.requested).toEqual({ trackVersion: null, orbiterVersion: null, entangledWorldVersion: null });
  });

  it('flags a re-drop of the already-playing entity as a noop', () => {
    expect(swapDescriptor(current, { trackId: 'track-a' }).noop).toBe(true);
    expect(swapDescriptor(current, { orbiterId: 'orb-a' }).noop).toBe(true);
    expect(swapDescriptor(current, { entangledWorldId: 'world-a' }).noop).toBe(true);
  });

  it('returns null when the card has no swappable dimension or the stage has no resolved track', () => {
    expect(swapDescriptor(current, { title: 'no ids' })).toBeNull();
    expect(swapDescriptor(null, { trackId: 'track-b' })).toBeNull();
    expect(swapDescriptor({ orbiterId: 'orb-a' }, { trackId: 'track-b' })).toBeNull();
  });
});

describe('moveEntryBefore', () => {
  const entries = [{ voiceId: 'a' }, { voiceId: 'b' }, { voiceId: 'c' }];

  it('moves an entry before another', () => {
    expect(moveEntryBefore(entries, 'c', 'a').map((e) => e.voiceId)).toEqual(['c', 'a', 'b']);
  });

  it('moves an entry to the end when beforeVoiceId is null', () => {
    expect(moveEntryBefore(entries, 'a', null).map((e) => e.voiceId)).toEqual(['b', 'c', 'a']);
  });

  it('returns the SAME reference when the source is not found (no-op)', () => {
    expect(moveEntryBefore(entries, 'x', 'a')).toBe(entries);
  });
});
