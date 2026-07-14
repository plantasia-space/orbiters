import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchJsonFromApi } from '../../src/api/httpClient.js';
import {
  fetchMidiMappings,
  replaceScopedMappings,
} from '../../src/api/midiLearnService.js';

vi.mock('../../src/api/httpClient.js', () => ({
  fetchJsonFromApi: vi.fn(),
}));

vi.mock('../../src/api/dataManager/loaders.js', () => ({
  getEmbeddedAuthToken: vi.fn(() => 'tok'),
  requestEmbeddedAuthToken: vi.fn(),
}));

vi.mock('../../src/ui/loginPrompt.js', () => ({
  ensureLoginPrompt: vi.fn(),
  getLoginHref: vi.fn(() => '/login'),
}));

const okJson = (body = {}) => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(body) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchMidiMappings', () => {
  it('scopes the request to one orbiter when an id is passed', async () => {
    fetchJsonFromApi.mockResolvedValue(okJson({ midiLearn: { orbiters: {} } }));
    await fetchMidiMappings('orb-123');
    expect(fetchJsonFromApi).toHaveBeenCalledWith(
      '/me/users/configurations/midi-learn?orbiterId=orb-123',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('scopes the request to one collection when a {scope, entityId} ref is passed', async () => {
    fetchJsonFromApi.mockResolvedValue(okJson({ midiLearn: { collections: {} } }));
    await fetchMidiMappings({ scope: 'collection', entityId: 'col-9' });
    expect(fetchJsonFromApi).toHaveBeenCalledWith(
      '/me/users/configurations/midi-learn?scope=collection&entityId=col-9',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('requests the full tree (no param) when called with no id', async () => {
    fetchJsonFromApi.mockResolvedValue(okJson({ midiLearn: { orbiters: {} }, orbiterNames: {} }));
    await fetchMidiMappings();
    expect(fetchJsonFromApi).toHaveBeenCalledWith(
      '/me/users/configurations/midi-learn',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('replaceScopedMappings', () => {
  it('copies every source binding BEFORE clearing any leftover (no data-loss window)', async () => {
    fetchJsonFromApi.mockResolvedValue(okJson({}));

    await replaceScopedMappings({
      scope: 'orbiter',
      sourceBindings: { pA: { cc: 1 }, pB: { cc: 2 } },
      targetEntityId: 'target',
      targetParamIds: ['pB', 'pOld1', 'pOld2'], // pB is overwritten; pOld1/pOld2 are leftovers
    });

    const bodies = fetchJsonFromApi.mock.calls.map(([, opts]) => opts.body);
    const isCopy = (b) => b.binding !== null;
    const lastCopyIdx = bodies.map(isCopy).lastIndexOf(true);
    const firstClearIdx = bodies.map(isCopy).indexOf(false);

    // All copies precede all clears.
    expect(lastCopyIdx).toBeLessThan(firstClearIdx);

    // Copies: both source params written to the target.
    const copies = bodies.filter(isCopy);
    expect(copies).toEqual([
      { scope: 'orbiter', entityId: 'target', parameterId: 'pA', binding: { cc: 1 } },
      { scope: 'orbiter', entityId: 'target', parameterId: 'pB', binding: { cc: 2 } },
    ]);

    // Clears: only the leftovers the source didn't overwrite (pB is NOT cleared).
    const clearedParams = bodies.filter((b) => b.binding === null).map((b) => b.parameterId);
    expect(clearedParams).toEqual(['pOld1', 'pOld2']);
  });

  it('clears nothing when the target had no prior mappings', async () => {
    fetchJsonFromApi.mockResolvedValue(okJson({}));
    await replaceScopedMappings({
      scope: 'orbiter',
      sourceBindings: { pA: { cc: 1 } },
      targetEntityId: 'target',
      targetParamIds: [],
    });
    const cleared = fetchJsonFromApi.mock.calls.filter(([, o]) => o.body.binding === null);
    expect(cleared).toHaveLength(0);
  });

  it('throws without a scope or a target entity id', async () => {
    await expect(
      replaceScopedMappings({ scope: 'orbiter', sourceBindings: {}, targetEntityId: '' }),
    ).rejects.toThrow(/targetEntityId/);
    await expect(
      replaceScopedMappings({ scope: '', sourceBindings: {}, targetEntityId: 'x' }),
    ).rejects.toThrow(/scope/);
  });

  it('copies collection shell mappings under the collection scope', async () => {
    fetchJsonFromApi.mockResolvedValue(okJson({}));
    await replaceScopedMappings({
      scope: 'collection',
      sourceBindings: { 'drawer-toggle': { cc: 40 } },
      targetEntityId: 'col-9',
      targetParamIds: [],
    });
    const [, opts] = fetchJsonFromApi.mock.calls[0];
    expect(opts.body).toEqual({
      scope: 'collection',
      entityId: 'col-9',
      parameterId: 'drawer-toggle',
      binding: { cc: 40 },
    });
  });
});
