import { describe, expect, it } from 'vitest';
import {
  getWorldInteractionModeFromUrl,
  isMultiStageBootFromUrl,
  resolveBootTargetFromUrl,
} from '../../src/utils/urlParams.js';
import { isStudioEnabled } from '../../src/ui/react/studio/studioMode.ts';

const rosterParam = (voices) =>
  `roster=${Buffer.from(JSON.stringify(voices), 'utf8').toString('base64')}`;

describe('edit mode is a single-orbiter surface', () => {
  it('stays available on a single-orbiter URL', () => {
    expect(getWorldInteractionModeFromUrl(new URLSearchParams('?mode=edit'))).toBe('edit');
    expect(isStudioEnabled('?mode=edit')).toBe(true);
    expect(isStudioEnabled('?mode=play')).toBe(false);
    expect(isStudioEnabled('')).toBe(false);
  });

  it.each([
    ['a collection', '?collection=abc123&mode=edit'],
    ['the user queue', '?queue=me&mode=edit'],
    ['an inline track list', '?tracks=t1,t2&mode=edit'],
    ['an inline roster', `?multi=1&${rosterParam([{ trackId: 't1' }])}&mode=edit`],
  ])('is ignored when the URL boots %s', (_label, search) => {
    expect(isMultiStageBootFromUrl(new URLSearchParams(search))).toBe(true);
    expect(getWorldInteractionModeFromUrl(new URLSearchParams(search))).toBe('play');
    expect(isStudioEnabled(search)).toBe(false);
  });

  it.each([
    ['a flag with no roster', '?multi=1&mode=edit'],
    ['a roster that decodes to nothing usable', `?multi=1&${rosterParam([{ noTrack: 1 }])}&mode=edit`],
    ['a roster without the multi flag', `?${rosterParam([{ trackId: 't1' }])}&mode=edit`],
    ['an empty collection id', '?collection=&mode=edit'],
    ['an empty track list', '?tracks=&mode=edit'],
  ])('still edits on %s — that URL falls through to single-orbiter', (_label, search) => {
    expect(isMultiStageBootFromUrl(new URLSearchParams(search))).toBe(false);
    expect(resolveBootTargetFromUrl(new URLSearchParams(search)).kind).toBe('single');
    expect(isStudioEnabled(search)).toBe(true);
  });
});

describe('the boot target the composition root dispatches on', () => {
  it.each([
    ['?queue=me', 'queue'],
    ['?tracks=t1,t2', 'queue'],
    ['?collection=abc123', 'collection'],
    [`?multi=1&${rosterParam([{ trackId: 't1' }])}`, 'multi'],
    ['', 'single'],
  ])('resolves %s to the %s branch', (search, kind) => {
    expect(resolveBootTargetFromUrl(new URLSearchParams(search)).kind).toBe(kind);
  });

  it('prefers the queue over a collection id, as the boot branches do', () => {
    const target = resolveBootTargetFromUrl(new URLSearchParams('?queue=me&collection=abc123'));
    expect(target.kind).toBe('queue');
    expect(target.queueTracks).toBeNull();
  });
});
