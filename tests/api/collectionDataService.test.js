// @vitest-environment jsdom
/**
 * The collection-data client. While the endpoint is not landed the client runs in
 * stub mode; these lock the stub contract (roster shape aligned with the realm descriptor + permissions)
 * and the id guard, so collection mode has a stable interface to build against.
 */
import { describe, it, expect } from 'vitest';
import {
  fetchCollectionData,
  normalizeCollectionPayload,
  saveCollectionLayout,
} from '../../src/api/collectionDataService.js';

describe('fetchCollectionData — stub contract', () => {
  it('rejects a missing collection id', async () => {
    await expect(fetchCollectionData('')).rejects.toMatchObject({ code: 'invalid-collection-id' });
  });

  it('returns a roster matching the realm descriptor + permissions + layout keys', async () => {
    const data = await fetchCollectionData('col-123');
    expect(data.collectionId).toBe('col-123');
    expect(Array.isArray(data.roster)).toBe(true);
    expect(data.roster.length).toBeGreaterThan(0);
    for (const entry of data.roster) {
      // aligned with getRosterFromUrl so it feeds the realm straight in
      expect(entry).toHaveProperty('voiceId');
      expect(entry).toHaveProperty('trackId');
      expect(entry).toHaveProperty('orbiterId');
      expect(entry).toHaveProperty('entangledWorldId');
      expect(typeof entry.trackId).toBe('string');
    }
    expect(data.permissions).toEqual({ canView: true, canEdit: true });
    expect(data).toHaveProperty('layout');
  });
});

describe('normalizeCollectionPayload — permissions + display fields', () => {
  // Mycelium's /collections/{id}/public returns a TOP-LEVEL permissionsPayload (a sibling of
  // `collection`), computed from the viewer's Bearer token — capabilities.canEdit + viewerRole.
  const baseItems = [{ entityType: 'track', entityId: 'trk-1', itemId: 'item-1', miniCard: { title: 'Song', subtitle: 'An Artist', image: 'http://img/1.png' } }];

  it('reads canEdit from the top-level permissionsPayload.capabilities', () => {
    const data = normalizeCollectionPayload({
      collection: { _id: 'col-1', items: baseItems },
      permissionsPayload: { viewerRole: 'editor', capabilities: { canView: true, canEdit: true } },
    });
    expect(data.permissions).toEqual({ canView: true, canEdit: true });
  });

  it('treats viewerRole "owner" as canEdit even if capabilities.canEdit is false', () => {
    const data = normalizeCollectionPayload({
      collection: { _id: 'col-1', items: baseItems },
      permissionsPayload: { viewerRole: 'owner', capabilities: { canView: true, canEdit: false } },
    });
    expect(data.permissions.canEdit).toBe(true);
  });

  it('a viewer (no capabilities.canEdit) can still view — edit is off', () => {
    const data = normalizeCollectionPayload({
      collection: { _id: 'col-1', items: baseItems },
      permissionsPayload: { viewerRole: 'viewer', capabilities: { canView: true, canEdit: false } },
    });
    expect(data.permissions).toEqual({ canView: true, canEdit: false });
  });

  it('falls back to a flat { canView, canEdit } shape when no permissionsPayload is present', () => {
    const data = normalizeCollectionPayload({ collection: { _id: 'col-1', items: baseItems, permissions: { canView: true, canEdit: true } } });
    expect(data.permissions).toEqual({ canView: true, canEdit: true });
  });

  it('carries display fields (title / subtitle / image / entityType) onto the roster entry', () => {
    const data = normalizeCollectionPayload({ collection: { _id: 'col-1', items: baseItems } });
    expect(data.roster[0]).toMatchObject({
      voiceId: 'item-1',
      trackId: 'trk-1',
      entityType: 'track',
      title: 'Song',
      subtitle: 'An Artist',
      image: 'http://img/1.png',
    });
  });

  it("maps mycelium's real item shape — id/entityId + nested entity.miniCard (title/imageSmall/artists)", () => {
    // The exact shape GET /collections/{id}/public?hydrationLevel=2 returns per item.
    const data = normalizeCollectionPayload({
      collection: {
        _id: 'col-9',
        subtype: 'ii-orbiters',
        items: [
          {
            id: 'citem-1', // collection item id → voiceId
            entityType: 'track',
            entityId: 'track-abc', // entity id → trackId
            entity: {
              miniCard: {
                entityType: 'track',
                title: 'Skysounds 3 IX',
                imageSmall: 'https://img/thumb_small.webp',
                artists: [{ displayName: 'Bruna Guarnieri', username: 'bruna33' }],
                isOfficial: true,
              },
            },
          },
        ],
      },
    });
    expect(data.roster[0]).toMatchObject({
      voiceId: 'citem-1',
      trackId: 'track-abc',
      entityType: 'track',
      title: 'Skysounds 3 IX',
      image: 'https://img/thumb_small.webp',
      subtitle: 'Bruna Guarnieri',
    });
    // collection.subtype drives the initial visible stage count (2 = ii-orbiters).
    expect(data.layout).toMatchObject({ subtype: 2 });
  });

  it('carries isOfficial and falls back to the owner name for an orbiter subtitle (no artists)', () => {
    // An orbiter miniCard carries no `artists` — root's normalizer uses the owner's name as the subtitle.
    const data = normalizeCollectionPayload({
      collection: {
        _id: 'col-10',
        items: [
          {
            id: 'citem-orb',
            entityType: 'orbiter',
            entityId: 'orb-xyz',
            entity: {
              miniCard: {
                entityType: 'orbiter',
                title: 'Coniothyrium lignorum',
                imageSmall: 'https://img/orb_small.webp',
                artists: [],
                isOfficial: true,
                owner: { displayName: 'Maar World Records', username: 'maar' },
              },
            },
          },
        ],
      },
    });
    expect(data.roster[0]).toMatchObject({
      voiceId: 'citem-orb',
      orbiterId: 'orb-xyz',
      entityType: 'orbiter',
      title: 'Coniothyrium lignorum',
      subtitle: 'Maar World Records',
      isOfficial: true,
    });
  });

  it('leaves title null for an unhydrated entity (the card renders "Untitled", never the raw id)', () => {
    // A deleted/unavailable orbiter comes back with null display fields — the raw ObjectId (voiceId) must
    // never leak as the title. The normalizer keeps title null; the card supplies a friendly fallback.
    const data = normalizeCollectionPayload({
      collection: {
        _id: 'col-11',
        items: [
          {
            id: '69d94d386d14d84113b8d0e6',
            entityType: 'orbiter',
            entityId: 'orb-null',
            entity: { miniCard: { entityType: 'orbiter', title: null, imageSmall: null, artists: [], owner: null } },
          },
        ],
      },
    });
    expect(data.roster[0].title).toBeNull();
    expect(data.roster[0].voiceId).toBe('69d94d386d14d84113b8d0e6');
    // The voiceId (an ObjectId) must not have leaked into the title.
    expect(data.roster[0].title).not.toBe(data.roster[0].voiceId);
  });

  it('drops an archived/unavailable entity from the roster (no dead "Untitled" card, no failing prefetch)', () => {
    // An archived track ships only a placeholder miniCard flagged `unavailable: true` (title null,
    // status/reason 'archived'). It can't boot — its release fetch errors — so the normalizer must
    // drop it entirely, same as root's collection view (`unavailable !== true`).
    const data = normalizeCollectionPayload({
      collection: {
        _id: 'col-12',
        items: [
          {
            id: 'citem-live',
            entityType: 'track',
            entityId: 'track-live',
            entity: { miniCard: { entityType: 'track', title: 'Still Here', imageSmall: null, artists: [] } },
          },
          {
            id: 'citem-archived',
            entityType: 'track',
            entityId: 'track-archived',
            entity: {
              miniCard: {
                entityType: 'track',
                title: null,
                imageSmall: null,
                artists: [],
                status: 'archived',
                unavailable: true,
                reason: 'archived',
                fallbackEligible: true,
              },
            },
          },
          // Item-level unavailable flag (root's `raw.unavailable`) and a null entity must drop too.
          { id: 'citem-flat', entityType: 'track', entityId: 'track-flat', unavailable: true },
          { id: 'citem-null', entityType: 'track', entityId: 'track-null', entity: null },
        ],
      },
    });
    expect(data.roster).toHaveLength(1);
    expect(data.roster[0].trackId).toBe('track-live');
  });
});

describe('saveCollectionLayout — stub', () => {
  it('acknowledges a write in stub mode', async () => {
    await expect(saveCollectionLayout('col-123', { subtype: 2, splitY: 0.5 })).resolves.toBe(true);
  });
  it('rejects a missing id', async () => {
    await expect(saveCollectionLayout('', {})).rejects.toThrow();
  });
});
