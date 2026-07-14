// @vitest-environment jsdom
/**
 * The DJ-deck tempo model in toneTempoPitch/v1/factory.js — deck-fed.
 *
 * Each orbiter is a DJ deck; the tempo fader (tempoFine/tempoWide) is its pitch fader.
 *  - NOT following (warp off; or a fresh voice with no deck feed): independent — the fader plays
 *    native × (1 + knob%), 0% = the song's native tempo, and it NEVER drives any tempo owner.
 *  - Following: the deck plays its TRANSPORT tempo (baseRate = deck.followRatio) and the fader
 *    DRIVES that transport via an anchor: T = anchorM × (1 + (userRate − anchorUserRate)). The deck
 *    routes the write (synced → the shared master through the coordinator's one gate; unsynced → the
 *    deck's own tempo). The anchor re-captures whenever the transport moves from elsewhere, so the
 *    fader is a deviation from the current transport — equilibrium = T (no native-relative "130"
 *    bug) and a stationary fader never fights.
 */
import { describe, it, expect, vi } from 'vitest';
import { createToneTempoPitchEffect } from '../../src/audio/effects/toneTempoPitch/v1/factory.js';

const Tone = {
  Gain: class { constructor() {} dispose() {} },
  intervalToFrequencyRatio: (s) => Math.pow(2, s / 12),
};

/** A fake deck: drives the effect's live feed + presents the snapshot a late mount reads. */
function makeDeck(nativeTempo) {
  let listener = null;
  const state = { bpm: null, baseRate: 1, following: false };
  return {
    nativeTempo,
    setTempo: vi.fn(),
    onChange(fn) { listener = fn; return () => { listener = null; }; },
    getSnapshot() { return { ...state, trackBpm: nativeTempo }; },
    /** Simulate the deck emitting: transport tempo + follow state (ratio derived like the real deck). */
    drive({ bpm = state.bpm, following = state.following } = {}, reason = 'bpm') {
      state.bpm = bpm;
      state.following = following;
      state.baseRate = following && bpm > 0 && nativeTempo > 0 ? bpm / nativeTempo : 1;
      listener?.(this.getSnapshot(), reason);
    },
  };
}

/** Build the effect with a rate-capturing playbackController; the active module defaults to tempoFine. */
function makeEffect(nativeTempo, { deck = makeDeck(nativeTempo) } = {}) {
  const rates = [];
  const playbackController = {
    setPlaybackRate: vi.fn((r) => rates.push(r)),
    getPlaybackRateParam: () => null,
  };
  const effect = createToneTempoPitchEffect({ Tone, settings: { playbackController }, deck });
  const tempo = effect.modules.find((m) => m.id === 'tempoFine');
  return { effect, deck, tempo, rates, lastRate: () => rates.at(-1) };
}

describe('DJ-deck tempo model — toneTempoPitch factory', () => {
  it('independent deck (not following): the fader plays native × (1 + knob%) and never drives a tempo', () => {
    const { deck, tempo, lastRate } = makeEffect(130);
    tempo.applyValue(10); // +10%
    expect(lastRate()).toBeCloseTo(1.1, 5);
    tempo.applyValue(-8); // −8%
    expect(lastRate()).toBeCloseTo(0.92, 5);
    expect(deck.setTempo).not.toHaveBeenCalled();
  });

  it('following: the deck plays its TRANSPORT tempo, not its native (equilibrium = T, no 130 bug)', () => {
    const { deck, lastRate } = makeEffect(130);
    deck.drive({ following: true }, 'sync-status');
    deck.drive({ bpm: 100 }); // transport T = 100
    // Plays at the transport (100/130), NOT native (rate 1) and NOT native-relative.
    expect(lastRate()).toBeCloseTo(100 / 130, 5);
  });

  it('following: the fader nudges the transport from its anchor — 0% holds T, no jump to native', () => {
    const { deck, tempo } = makeEffect(130);
    deck.drive({ bpm: 100, following: true }, 'sync-status'); // anchor captured at (T=100, userRate=1.0)
    deck.setTempo.mockClear();

    tempo.applyValue(0); // 0% → stays at the transport, NOT a jump to native 130
    expect(deck.setTempo).toHaveBeenLastCalledWith(expect.closeTo(100, 6), { sourceType: 'module' });

    tempo.applyValue(10); // +10% from the anchor → +10% on the transport
    expect(deck.setTempo).toHaveBeenLastCalledWith(expect.closeTo(110, 6), { sourceType: 'module' });
  });

  it('following: an external transport change re-anchors a stationary fader (no fight)', () => {
    const { deck, tempo } = makeEffect(130);
    deck.drive({ bpm: 100, following: true }, 'sync-status'); // anchor (100, 1.0)
    // Another deck / the number moves the transport to 120 while our fader is stationary at 0%.
    deck.drive({ bpm: 120 }); // re-anchor → (120, 1.0)
    deck.setTempo.mockClear();

    tempo.applyValue(10); // +10% now deviates from 120, not 100
    expect(deck.setTempo).toHaveBeenLastCalledWith(expect.closeTo(132, 6), { sourceType: 'module' });
  });

  it('following: the deck own echo does NOT re-anchor (fader stays linear, no compounding)', () => {
    const { deck, tempo } = makeEffect(130);
    deck.drive({ bpm: 100, following: true }, 'sync-status'); // anchor (100, 1.0)
    tempo.applyValue(10); // drives transport → 110
    deck.drive({ bpm: 110 }); // the echo of OUR OWN drive — must NOT re-anchor
    deck.setTempo.mockClear();

    tempo.applyValue(12); // linear from the kept anchor (100,1.0): 100×(1+1.12−1.0)=112, NOT compounded
    expect(deck.setTempo).toHaveBeenLastCalledWith(expect.closeTo(112, 6), { sourceType: 'module' });
  });

  it('a deck-less voice stays independent and never drives (no feed → no follow)', () => {
    const rates = [];
    const playbackController = {
      setPlaybackRate: vi.fn((r) => rates.push(r)),
      getPlaybackRateParam: () => null,
    };
    const effect = createToneTempoPitchEffect({ Tone, settings: { playbackController } });
    const tempo = effect.modules.find((m) => m.id === 'tempoFine');
    tempo.applyValue(10);
    expect(rates.at(-1)).toBeCloseTo(1.1, 5); // native × (1 + knob%), no projection
  });

  it('warp OFF: plays native (free), stays in session, never drives the transport', () => {
    const { deck, tempo, lastRate } = makeEffect(130);
    deck.drive({ bpm: 100, following: false }, 'sync-status'); // synced-but-warp-off = not following
    deck.setTempo.mockClear();

    tempo.applyValue(10); // not following → independent rate, no drive
    expect(lastRate()).toBeCloseTo(1.1, 5);
    expect(deck.setTempo).not.toHaveBeenCalled();
  });
});
