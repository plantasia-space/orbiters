import { describe, expect, it } from 'vitest';
import { buildQueueData } from '../../src/api/queueDataService.js';
import {
  getQueueModeFromUrl,
  getQueueStartFromUrl,
  getQueueTracksFromUrl,
} from '../../src/utils/urlParams.js';

describe('buildQueueData', () => {
  it('builds a collectionData-shaped object from track ids', () => {
    const data = buildQueueData(['a', 'b', 'c']);
    expect(data.collectionId).toBeNull();
    expect(data.permissions).toEqual({ canView: true, canEdit: false });
    expect(data.roster.map((r) => r.trackId)).toEqual(['a', 'b', 'c']);
    expect(data.roster[0].entityType).toBe('track');
    // voiceIds must be distinct per stage
    expect(new Set(data.roster.map((r) => r.voiceId)).size).toBe(3);
  });

  it('dedupes and puts the start track first', () => {
    const data = buildQueueData(['a', 'b', 'a', 'c'], { startTrackId: 'b' });
    expect(data.roster.map((r) => r.trackId)).toEqual(['b', 'a', 'c']);
  });

  it('ignores junk ids and caps the roster', () => {
    const ids = [null, '', 42, ...Array.from({ length: 80 }, (_, i) => `t${i}`)];
    const data = buildQueueData(ids);
    expect(data.roster.length).toBe(50);
    expect(data.roster[0].trackId).toBe('t0');
  });
});

describe('queue url params', () => {
  it('parses queue mode, tracks shortcut and start', () => {
    expect(getQueueModeFromUrl(new URLSearchParams('?queue=me'))).toBe('me');
    expect(getQueueModeFromUrl(new URLSearchParams('?queue=other'))).toBeNull();
    expect(getQueueTracksFromUrl(new URLSearchParams('?tracks=a,b,,c'))).toEqual(['a', 'b', 'c']);
    expect(getQueueTracksFromUrl(new URLSearchParams('?tracks='))).toBeNull();
    expect(getQueueStartFromUrl(new URLSearchParams('?start=abc'))).toBe('abc');
  });
});
