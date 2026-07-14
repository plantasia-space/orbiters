// @vitest-environment jsdom
/**
 * The meter denominator field's raw domain used to be an INDEX into VALID_METER_DENOMINATORS with a
 * `format` to display the real number — but Param's direct keyboard-entry path writes the typed
 * literal back as the raw value, bypassing `format` entirely, so typing "4" set index 4 (denominator
 * 16), not denominator 4.
 *
 * A first fix (raw value = denominator, with `step` scaled to the current denominator so arrows still
 * double/halve) was caught in review: Param's OWN internal step-grid snap (anchored at a fixed `min`)
 * corrupts a typed literal BEFORE it reaches our handler once the dynamic step gets large relative to
 * `min` — e.g. at denominator 16 (step 8), typing "4" resolved to 1, not 4. `resolveDenominatorInput`
 * fixes this properly: `step` is fixed at 1 (so Param's grid is a no-op for any integer), and only an
 * EXACT ±1 delta (which only a single arrow/wheel tick can produce with a fixed step of 1) is read as
 * "move one entry through the geometric sequence" — every other delta is the literal typed target.
 */
import { describe, it, expect } from 'vitest';
import {
  snapToValidDenominator,
  resolveDenominatorInput,
} from '../../src/ui/react/regions/SyncSettingsMenu.tsx';

describe('snapToValidDenominator', () => {
  it('is the identity for every valid denominator', () => {
    expect(snapToValidDenominator(1)).toBe(1);
    expect(snapToValidDenominator(2)).toBe(2);
    expect(snapToValidDenominator(4)).toBe(4);
    expect(snapToValidDenominator(8)).toBe(8);
    expect(snapToValidDenominator(16)).toBe(16);
    expect(snapToValidDenominator(32)).toBe(32);
  });

  it('snaps an in-between value to the nearest valid power of two (log2-nearest)', () => {
    expect(snapToValidDenominator(3)).toBe(4);
    expect(snapToValidDenominator(6)).toBe(8);
    expect(snapToValidDenominator(20)).toBe(16);
    expect(snapToValidDenominator(24)).toBe(32);
  });

  it('clamps out-of-range and non-finite input to the valid bounds', () => {
    expect(snapToValidDenominator(0)).toBe(1);
    expect(snapToValidDenominator(-5)).toBe(1);
    expect(snapToValidDenominator(1000)).toBe(32);
    expect(snapToValidDenominator(NaN)).toBe(1);
  });
});

describe('resolveDenominatorInput — the exact bugs caught in review', () => {
  it('typing a literal value resolves to that value regardless of the current denominator (the reported bug)', () => {
    // Typing "4" while at 16 used to resolve to 1 with the rejected step-scaled design.
    expect(resolveDenominatorInput(4, 16)).toBe(4);
    // Typing "8" while at 32 used to resolve to 1.
    expect(resolveDenominatorInput(8, 32)).toBe(8);
    // The ORIGINAL index-mapping bug's exact repro: typing "4" (used to become 16), typing "2" (used to become 4).
    expect(resolveDenominatorInput(4, 4)).toBe(4);
    expect(resolveDenominatorInput(2, 4)).toBe(2);
  });

  it('a typed literal resolves the same way no matter which denominator it started from', () => {
    for (const current of [1, 2, 4, 8, 16, 32]) {
      expect(resolveDenominatorInput(4, current)).toBe(4);
      expect(resolveDenominatorInput(24, current)).toBe(32);
    }
  });

  it('an exact +1/-1 delta (the only delta an arrow/wheel tick with step=1 can produce) steps one entry through the geometric sequence', () => {
    expect(resolveDenominatorInput(5, 4)).toBe(8); // arrow up from 4
    expect(resolveDenominatorInput(3, 4)).toBe(2); // arrow down from 4
    expect(resolveDenominatorInput(17, 16)).toBe(32); // arrow up from 16
    expect(resolveDenominatorInput(15, 16)).toBe(8); // arrow down from 16
    expect(resolveDenominatorInput(2, 1)).toBe(2); // arrow up from the floor
    // At the ceiling, Param clamps `current + step` (33) down to `max` (32) BEFORE calling us, so we
    // actually receive raw=32, current=32 (delta 0) — falls to the literal branch, still resolves to
    // the already-valid 32.
    expect(resolveDenominatorInput(32, 32)).toBe(32);
  });

  it('exhaustively matches direct snapToValidDenominator for every non-±1 delta, for every valid current', () => {
    for (const current of [1, 2, 4, 8, 16, 32]) {
      for (let raw = -5; raw <= 40; raw += 1) {
        const delta = raw - current;
        if (delta === 1 || delta === -1) continue; // covered by the stepping test above
        expect(resolveDenominatorInput(raw, current)).toBe(snapToValidDenominator(raw));
      }
    }
  });
});
