// @vitest-environment jsdom
/**
 * Slice A3 — multi-orbiter roster URL contract (decision 0001, "## Slice A3").
 *
 * Pins the wire format A3's boot dispatcher reads to decide single- vs multi-orbiter and to build
 * the voice list. The host (A4) will carry the same shape over the postMessage bridge; this URL
 * form is what lets A3 be driven + verified locally without the host change.
 */
import { describe, it, expect } from 'vitest';
import { getMultiOrbiterModeFromUrl, getRosterFromUrl } from '../../src/utils/urlParams.js';

/** Encode an object the way the host does: base64 of its JSON (the decoder normalizes url-safe + padding). */
function encodeRoster(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function params(obj) {
  return new URLSearchParams(obj);
}

describe('getMultiOrbiterModeFromUrl — the multi-orbiter boot flag', () => {
  it("returns 'multi' for ?multi=1 and ?multi=true", () => {
    expect(getMultiOrbiterModeFromUrl(params({ multi: '1' }))).toBe('multi');
    expect(getMultiOrbiterModeFromUrl(params({ multi: 'true' }))).toBe('multi');
    expect(getMultiOrbiterModeFromUrl(params({ multi: 'TRUE' }))).toBe('multi');
  });

  it('returns null when absent or not a truthy flag (single-orbiter default)', () => {
    expect(getMultiOrbiterModeFromUrl(params({}))).toBeNull();
    expect(getMultiOrbiterModeFromUrl(params({ multi: '0' }))).toBeNull();
    expect(getMultiOrbiterModeFromUrl(params({ multi: 'false' }))).toBeNull();
  });
});

describe('getRosterFromUrl — parse + validate the voice list', () => {
  it('parses an ordered array of voice descriptors', () => {
    const roster = encodeRoster([
      { voiceId: 'v1', trackId: 't1', orbiterId: 'o1', entangledWorldId: 'w1' },
      { voiceId: 'v2', trackId: 't2', orbiterId: 'o2', entangledWorldId: 'w2' },
    ]);
    const result = getRosterFromUrl(params({ roster }));
    expect(result).toEqual([
      { voiceId: 'v1', trackId: 't1', orbiterId: 'o1', entangledWorldId: 'w1', sessionId: null, directPayload: null },
      { voiceId: 'v2', trackId: 't2', orbiterId: 'o2', entangledWorldId: 'w2', sessionId: null, directPayload: null },
    ]);
  });

  it('accepts the { maxVoices, voices } envelope and truncates to the cap', () => {
    const roster = encodeRoster({
      maxVoices: 2,
      voices: [
        { trackId: 't1' },
        { trackId: 't2' },
        { trackId: 't3' },
      ],
    });
    const result = getRosterFromUrl(params({ roster }));
    expect(result).toHaveLength(2);
    expect(result.map((v) => v.trackId)).toEqual(['t1', 't2']);
  });

  it('falls back voiceId to orbiterId, then trackId, when absent', () => {
    const roster = encodeRoster([
      { trackId: 't1', orbiterId: 'o1' }, // → voiceId 'o1'
      { trackId: 't2' }, // → voiceId 't2'
    ]);
    const result = getRosterFromUrl(params({ roster }));
    expect(result[0].voiceId).toBe('o1');
    expect(result[1].voiceId).toBe('t2');
  });

  it('drops voices with no trackId (cannot build an audio graph), keeps the rest', () => {
    const roster = encodeRoster([
      { voiceId: 'v1', trackId: 't1' },
      { voiceId: 'v2' }, // no trackId → dropped
      { voiceId: 'v3', trackId: 't3' },
    ]);
    const result = getRosterFromUrl(params({ roster }));
    expect(result.map((v) => v.voiceId)).toEqual(['v1', 'v3']);
  });

  it('carries an optional per-voice directPayload and sessionId through', () => {
    const directPayload = { trackSession: {}, orbiterSession: {}, entangledWorldSession: {} };
    const roster = encodeRoster([{ trackId: 't1', sessionId: 's1', directPayload }]);
    const result = getRosterFromUrl(params({ roster }));
    expect(result[0].sessionId).toBe('s1');
    expect(result[0].directPayload).toEqual(directPayload);
  });

  it('returns null for absent / empty / malformed / all-invalid rosters', () => {
    expect(getRosterFromUrl(params({}))).toBeNull();
    expect(getRosterFromUrl(params({ roster: '' }))).toBeNull();
    expect(getRosterFromUrl(params({ roster: Buffer.from('not json', 'utf8').toString('base64') }))).toBeNull();
    expect(getRosterFromUrl(params({ roster: encodeRoster({ nope: true }) }))).toBeNull();
    expect(getRosterFromUrl(params({ roster: encodeRoster([{ orbiterId: 'o1' }]) }))).toBeNull();
  });
});
