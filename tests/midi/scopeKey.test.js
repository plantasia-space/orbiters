/**
 * Scope keys (`<scope>:<entityId>`) — the ScopedMidiMap's slice identity. Unknown scopes and
 * malformed keys resolve to null so a bad key can never silently create a phantom slice.
 */
import { describe, it, expect } from 'vitest';
import { makeScopeKey, orbiterScopeKey, parseScopeKey } from '../../src/input/midi/scopeKey.js';

describe('scopeKey', () => {
  it('round-trips scope + entityId', () => {
    expect(makeScopeKey('collection', 'col-1')).toBe('collection:col-1');
    expect(parseScopeKey('collection:col-1')).toEqual({ scope: 'collection', entityId: 'col-1' });
    expect(orbiterScopeKey('orb-A')).toBe('orbiter:orb-A');
  });

  it('rejects unknown scopes and missing parts', () => {
    expect(makeScopeKey('surface', 'x')).toBeNull();
    expect(makeScopeKey('orbiter', '')).toBeNull();
    expect(makeScopeKey('', 'x')).toBeNull();
    expect(parseScopeKey('surface:x')).toBeNull();
    expect(parseScopeKey('orbiter:')).toBeNull();
    expect(parseScopeKey('no-separator')).toBeNull();
    expect(parseScopeKey(null)).toBeNull();
  });

  it('keeps colons inside the entityId intact', () => {
    expect(parseScopeKey('orbiter:a:b')).toEqual({ scope: 'orbiter', entityId: 'a:b' });
  });
});
