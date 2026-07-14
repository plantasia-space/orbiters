/**
 * @file src/multi/stageArrangement.js
 * @description Pure arrangement math for the multi-stage Orbiter Studio's arrange UX (card drawer +
 * drag-to-stage + reorder). No DOM, no React, no realm — just the decisions the arrange surface needs,
 * kept framework-free so they are one source of truth and unit-testable:
 *
 *   - `buildDesiredArrangement` — the entry that SHOULD occupy each visible stage: a stage holds a voice
 *     ONLY when the user has explicitly placed one there (a dragged card). Stages start EMPTY (a
 *     placeholder), exactly like root's mixed-collection — nothing is auto-loaded from the collection; the
 *     collection only populates the drawer of cards the user drags from.
 *   - `planReconcile` — given the live stage→voice map and that desired arrangement, compute the minimal
 *     `{ removes, adds }` to converge the realm. Two passes (remove-then-add) so untouched stages keep
 *     their voice (no audio cut for survivors) and a replaced stage frees before it re-adds.
 *   - `moveEntryBefore` — reorder the drawer's entry list (drag one card before another / to the end).
 *   - `swapDescriptor` — the session descriptor for an in-place swap: a card dropped on an OCCUPIED
 *     stage replaces only its own dimension (track / orbiter / world) of that stage's live session.
 *
 * Duplicates are allowed (product decision): the same collection entry can play on two stages at once.
 * Each explicit placement carries its OWN `voiceId` (minted by the caller over the entry's shared audio
 * ids), so two live copies never collide on the realm's voiceId key. This math therefore does NOT dedupe
 * by entry — it trusts that every placement's `voiceId` is already distinct.
 */

/**
 * The entry that SHOULD occupy each of `target` stages. A stage is filled ONLY by an explicit placement
 * (a dragged card); with no placement it is EMPTY (a placeholder). Nothing is auto-loaded — growing the
 * count reveals empty placeholders, and a fresh collection shows all placeholders until the user drags.
 * @param {Map<number, {voiceId:string}|null>} overrides explicit stage placements — a placement entry
 *   (its own minted `voiceId`), or `null`/absent for an empty stage.
 * @param {number} target visible stage count.
 * @returns {Array<{voiceId:string}|null>} the add-ready entry per stage index (length `target`).
 */
export function buildDesiredArrangement(overrides, target) {
  const desired = [];
  for (let i = 0; i < target; i++) desired.push(overrides.get(i) ?? null);
  return desired;
}

/**
 * Compute the minimal realm mutations to make each stage hold its desired entry.
 * @param {Array<string|null>} slotVoiceIds live stage index → occupying voiceId (null = empty stage).
 * @param {Array<{voiceId:string}|null>} desiredEntries stage index → the entry that SHOULD occupy it
 *   (null = the stage should be empty). Its length is the target visible stage count.
 * @returns {{ removes: Array<{index:number, voiceId:string}>, adds: Array<{index:number, entry:object}> }}
 *   `removes` = voices whose stage no longer wants them (changed or beyond the target); apply these first.
 *   `adds` = stages whose desired entry isn't live yet; apply after the removes (so a replaced slot is free).
 */
export function planReconcile(slotVoiceIds, desiredEntries) {
  const target = desiredEntries.length;
  const removes = [];
  for (let i = 0; i < slotVoiceIds.length; i++) {
    const cur = slotVoiceIds[i];
    if (!cur) continue;
    const desiredId = i < target ? desiredEntries[i]?.voiceId ?? null : null;
    if (cur !== desiredId) removes.push({ index: i, voiceId: cur });
  }
  const adds = [];
  for (let i = 0; i < target; i++) {
    const entry = desiredEntries[i];
    if (entry && slotVoiceIds[i] !== entry.voiceId) adds.push({ index: i, entry });
  }
  return { removes, adds };
}

/**
 * The full session descriptor for dropping `entry` onto a stage whose live session is `current`
 * (the voice's resolved config request). The card's OWN dimension is classified by id precedence
 * (track → orbiter → world, the same order the roster uses); only that dimension changes — the other
 * two are carried over EXPLICITLY from `current` (the engine's descriptor merge only overwrites
 * truthy fields, and an absent id would be back-filled from the new track's defaults instead of
 * keeping what is playing). Surviving dimensions also pin their CURRENT versions in `requested` so
 * they re-resolve byte-identical (warm cache hits, no accidental version upgrade mid-swap); the
 * swapped dimension requests no version (latest).
 * @param {{trackId?:string, trackVersion?:(string|null), orbiterId?:(string|null),
 *   orbiterVersion?:(string|null), entangledWorldId?:(string|null),
 *   entangledWorldVersion?:(string|null)}|null} current the stage's live resolved request.
 * @param {{trackId?:(string|null), orbiterId?:(string|null), entangledWorldId?:(string|null)}} entry
 *   the dropped card.
 * @returns {{dim:('track'|'orbiter'|'world'), session:object, requested:object, noop:boolean}|null}
 *   null when the card carries no swappable dimension or the stage has no resolved track to swap
 *   against; `noop` when the swap would land the exact triad already playing.
 */
export function swapDescriptor(current, entry) {
  if (!current?.trackId) return null;
  const dim = entry?.trackId ? 'track' : entry?.orbiterId ? 'orbiter' : entry?.entangledWorldId ? 'world' : null;
  if (!dim) return null;

  const session = {
    trackId: dim === 'track' ? entry.trackId : current.trackId,
    orbiterId: dim === 'orbiter' ? entry.orbiterId : current.orbiterId ?? null,
    entangledWorldId: dim === 'world' ? entry.entangledWorldId : current.entangledWorldId ?? null,
  };
  const requested = {
    trackVersion: dim === 'track' ? null : current.trackVersion ?? null,
    orbiterVersion: dim === 'orbiter' ? null : current.orbiterVersion ?? null,
    entangledWorldVersion: dim === 'world' ? null : current.entangledWorldVersion ?? null,
  };
  const noop =
    session.trackId === current.trackId &&
    session.orbiterId === (current.orbiterId ?? null) &&
    session.entangledWorldId === (current.entangledWorldId ?? null);
  return { dim, session, requested, noop };
}

/**
 * Reorder `entries` so `sourceVoiceId` sits immediately before `beforeVoiceId` (or at the end when
 * `beforeVoiceId` is null). Returns the SAME array reference when nothing moved, so callers can skip a
 * no-op update. Ported from root's `moveEntryBefore` (keyed by `voiceId` instead of `itemId`).
 * @param {Array<{voiceId:string}>} entries
 * @param {string} sourceVoiceId
 * @param {string|null} beforeVoiceId
 */
export function moveEntryBefore(entries, sourceVoiceId, beforeVoiceId) {
  const sourceIndex = entries.findIndex((e) => e.voiceId === sourceVoiceId);
  if (sourceIndex < 0) return entries;

  const next = [...entries];
  const [source] = next.splice(sourceIndex, 1);
  if (!source) return entries;

  if (beforeVoiceId === null) {
    next.push(source);
    return next;
  }
  const targetIndex = next.findIndex((e) => e.voiceId === beforeVoiceId);
  if (targetIndex < 0) {
    next.push(source);
    return next;
  }
  next.splice(targetIndex, 0, source);
  return next;
}
