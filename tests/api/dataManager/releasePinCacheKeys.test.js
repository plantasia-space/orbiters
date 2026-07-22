/**
 * A pinned release and the live one are different bytes. The cache keys them apart — `version: null`
 * means "whatever is live" — so a payload may only claim the live key when the entity's own pointer
 * agrees that it IS live.
 *
 * Two ways that invariant was breakable:
 *  1. Collection priming seeded every item under `version: null` regardless of which version the
 *     payload actually carried, so priming a pinned item answered later live requests with it.
 *  2. `applyConfigOverrides` deleted any version key the caller had not mentioned, so an override
 *     naming only `orbiterId` silently unpinned the track it inherited.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Constants } from '../../../src/config/Constants.js';
import {
  primeTrackReleaseCache,
  primeOrbiterReleaseCache,
  primeWorldReleaseCache,
} from '../../../src/api/dataManager/loaders.js';
import { resolveRequestVersionPins } from '../../../src/api/dataManager/index.js';

/** A hydrated track payload at `version`, whose entity pointer sits at `currentReleaseVersion`. */
const trackPayload = (version, currentReleaseVersion) => ({
  trackId: 't1',
  currentReleaseVersion,
  release: { version, status: 'ready', metadata: {}, assets: {} },
  releases: [{ version, status: 'ready' }],
  // primeTrackReleaseCache only seeds payloads fetchTrackRelease would honour for a hydrated
  // request, which means both hydration subtrees must be present.
  hydration: { orbiterRelease: {}, worldRelease: {} },
});

const versionsWrittenTo = (mockFn) => mockFn.mock.calls.map(([, , opts]) => opts.version);

beforeEach(() => {
  vi.spyOn(Constants, 'setTrackRelease').mockImplementation(() => {});
  vi.spyOn(Constants, 'setOrbiterRelease').mockImplementation(() => {});
  vi.spyOn(Constants, 'setWorldRelease').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collection priming keys a payload by what it actually is', () => {
  it('a live payload claims both its version and the live key', () => {
    expect(primeTrackReleaseCache('t1', trackPayload(15, 15))).toBe(true);
    expect(versionsWrittenTo(Constants.setTrackRelease).sort()).toEqual([15, null].sort());
  });

  it('a PINNED payload never claims the live key', () => {
    expect(primeTrackReleaseCache('t1', trackPayload(9, 15))).toBe(true);
    const written = versionsWrittenTo(Constants.setTrackRelease);
    expect(written).toEqual([9]);
    expect(written).not.toContain(null);
  });

  it('falls back to the payload release list when there is no pointer', () => {
    const payload = trackPayload(15, null);
    payload.releases = [{ version: 14 }, { version: 15 }];
    expect(primeTrackReleaseCache('t1', payload)).toBe(true);
    expect(versionsWrittenTo(Constants.setTrackRelease)).toContain(null);
  });

  it('a pinned payload with no pointer never claims the live key', () => {
    const payload = trackPayload(9, null);
    payload.releases = [{ version: 9 }, { version: 15 }];
    expect(primeTrackReleaseCache('t1', payload)).toBe(true);
    expect(versionsWrittenTo(Constants.setTrackRelease)).toEqual([9]);
  });

  it('with nothing to check against, only the exact version is seeded', () => {
    const payload = trackPayload(9, null);
    payload.releases = [];
    expect(primeTrackReleaseCache('t1', payload)).toBe(true);
    expect(versionsWrittenTo(Constants.setTrackRelease)).toEqual([9]);
  });

  it('orbiter and world priming follow the same rule', () => {
    primeOrbiterReleaseCache('o1', { currentReleaseVersion: 4, release: { version: 2 } });
    expect(versionsWrittenTo(Constants.setOrbiterRelease)).toEqual([2]);

    primeWorldReleaseCache('w1', { currentReleaseVersion: 4, release: { version: 4 } });
    expect(versionsWrittenTo(Constants.setWorldRelease).sort()).toEqual([4, null].sort());
  });
});

describe('version pins are inherited unless explicitly unpinned', () => {
  /** Drives the real pruning used by DataManager.applyConfigOverrides. */
  const prune = (currentRequest, overrides) => {
    const sanitizedOverrides = Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined)
    );
    return resolveRequestVersionPins({
      currentRequest,
      sanitizedOverrides,
      nextRequest: { ...currentRequest, ...sanitizedOverrides },
    });
  };

  it('keeps an inherited track pin when the override only names an orbiter', () => {
    const next = prune({ trackId: 't1', trackVersion: 7, version: 7 }, { orbiterId: 'o2' });
    expect(next.trackVersion).toBe(7);
    expect(next.version).toBe(7);
  });

  it('keeps an inherited orbiter pin when the override only names a track', () => {
    const next = prune({ trackId: 't1', orbiterVersion: 4 }, { trackId: 't2' });
    expect(next.orbiterVersion).toBe(4);
  });

  it('an explicit unpin clears the alias too, so the cache key cannot stay pinned', () => {
    const next = prune({ trackId: 't1', trackVersion: 7, version: 7 }, { trackVersion: null });
    expect('trackVersion' in next).toBe(false);
    expect('version' in next).toBe(false);
  });

  it('an explicit re-pin moves the alias with it', () => {
    const next = prune({ trackId: 't1', trackVersion: 7, version: 7 }, { trackVersion: 3 });
    expect(next.trackVersion).toBe(3);
    expect(next.version).toBe(3);
  });

  it('a pin given through the legacy alias sets both', () => {
    const next = prune({ trackId: 't1' }, { version: 5 });
    expect(next.trackVersion).toBe(5);
    expect(next.version).toBe(5);
  });

  it('drops an inherited pin that was already empty', () => {
    const next = prune({ trackId: 't1', trackVersion: null }, { orbiterId: 'o2' });
    expect('trackVersion' in next).toBe(false);
    expect('version' in next).toBe(false);
  });

  // The active request is what was ASKED FOR. Rebuilding it from the SERVED release turned every
  // live voice into a pinned one the moment it loaded: the served version of a live request is
  // just the live release's number, and the next override that omitted the key inherited it.
  it('a live request stays live after a load that served a numbered version', () => {
    const servedVersion = 15;
    const requestAfterLoad = { trackId: 't1', trackVersion: null, version: null };
    expect(requestAfterLoad.trackVersion).not.toBe(servedVersion);

    const next = prune(requestAfterLoad, { orbiterId: 'o2' });
    expect('trackVersion' in next).toBe(false);
    expect('version' in next).toBe(false);
  });

  it('never leaves trackVersion and its alias disagreeing', () => {
    const cases = [
      [{ trackVersion: 7, version: 7 }, { orbiterId: 'o2' }],
      [{ trackVersion: 7, version: 7 }, { trackVersion: null }],
      [{ trackVersion: 7, version: 7 }, { trackVersion: 3 }],
      [{ trackVersion: 2, version: 9 }, { orbiterId: 'o2' }],
      [{}, { version: 5 }],
      [{}, { trackVersion: '' }],
    ];
    for (const [current, overrides] of cases) {
      const next = prune({ trackId: 't1', ...current }, overrides);
      expect(next.version ?? null).toBe(next.trackVersion ?? null);
    }
  });
});
