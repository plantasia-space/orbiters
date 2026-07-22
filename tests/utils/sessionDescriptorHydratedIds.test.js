// @vitest-environment jsdom
// (config/Constants.js touches `navigator`/`window` at import time.)
/**
 * A hydrated release blob must contribute only the id of the entity it IS.
 *
 * Release payloads nest other releases, and an orbiter release carries `entitiesPreview` —
 * the linked ids of the session its author built and tested it against. Those are an editing
 * reference, never a playback input. A recursive id hunt through a track release reached the
 * embedded orbiter's reference trackId and adopted it as the session's track, so picking a
 * different audio in the orbiter form resolved straight back to the author's original one.
 */
import { describe, it, expect } from 'vitest';
import { buildSessionDescriptor } from '../../src/session/sessionDescriptor.js';

const CHOSEN_TRACK = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REFERENCE_TRACK = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ORBITER = 'cccccccccccccccccccccccc';

/** A track release shaped like the real hydrated payload: it embeds the orbiter's release,
 *  whose metadata names a DIFFERENT track as the author's reference. */
function trackReleaseEmbeddingOrbiterReference() {
  return {
    trackId: CHOSEN_TRACK,
    release: {
      version: 5,
      metadata: { trackId: CHOSEN_TRACK, trackName: 'The one the user picked' },
      assets: {},
    },
    hydration: {
      orbiterId: ORBITER,
      orbiterRelease: {
        version: 2,
        metadata: {
          orbiterId: ORBITER,
          // The trap: the author's reference session, carrying another track entirely.
          entitiesPreview: { trackId: REFERENCE_TRACK },
        },
      },
    },
  };
}

describe('buildSessionDescriptor — hydrated blobs contribute only their own id', () => {
  it("a track release's embedded orbiter reference does not become the session track", () => {
    const descriptor = buildSessionDescriptor({
      hydrated: { trackSession: trackReleaseEmbeddingOrbiterReference() },
    });

    expect(descriptor.trackId).toBe(CHOSEN_TRACK);
    expect(descriptor.trackId).not.toBe(REFERENCE_TRACK);
  });

  it('the host request still wins over the hydrated blob', () => {
    const descriptor = buildSessionDescriptor({
      host: { requested: { trackId: CHOSEN_TRACK } },
      hydrated: { trackSession: trackReleaseEmbeddingOrbiterReference() },
    });

    expect(descriptor.trackId).toBe(CHOSEN_TRACK);
  });

  it('reads the id from release metadata when the payload has no top-level id', () => {
    const descriptor = buildSessionDescriptor({
      hydrated: {
        trackSession: {
          release: { version: 1, metadata: { trackId: CHOSEN_TRACK } },
        },
      },
    });

    expect(descriptor.trackId).toBe(CHOSEN_TRACK);
  });

  it('an orbiter blob contributes its orbiterId and no track at all', () => {
    const descriptor = buildSessionDescriptor({
      hydrated: {
        orbiterSession: {
          orbiterId: ORBITER,
          release: {
            metadata: { orbiterId: ORBITER, entitiesPreview: { trackId: REFERENCE_TRACK } },
          },
        },
      },
    });

    expect(descriptor.orbiterId).toBe(ORBITER);
    expect(descriptor.trackId).not.toBe(REFERENCE_TRACK);
  });
});

// The shallow reader replaced a recursive scan, so it must still accept the wrapper shapes
// that scan handled — otherwise a blob yields no id and the session silently fails to load.
describe('buildSessionDescriptor — hydrated blob wrapper shapes', () => {
  for (const [label, blob] of [
    ['top-level id', { trackId: CHOSEN_TRACK }],
    ['release metadata', { release: { metadata: { trackId: CHOSEN_TRACK } } }],
    ['track wrapper', { track: { trackId: CHOSEN_TRACK } }],
    ['data wrapper', { data: { trackId: CHOSEN_TRACK } }],
    ['session wrapper', { session: { trackId: CHOSEN_TRACK } }],
  ]) {
    it(`reads the track id from a ${label}`, () => {
      const descriptor = buildSessionDescriptor({ hydrated: { trackSession: blob } });
      expect(descriptor.trackId).toBe(CHOSEN_TRACK);
    });
  }
});
