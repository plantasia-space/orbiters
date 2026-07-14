// @vitest-environment jsdom
/**
 * The speed & reverse modules on Tempo & Pitch: ONE bipolar input maps
 * linearly onto a signed rate of −1..+3. The input equilibrium (0) rests at 1×
 * normal forward; one extreme reaches 3× forward, the other slows through a
 * real stop (rate 0, at −50) and on into 1× reverse. The magnitude drives the
 * rate and the sign drives the read direction, combined only inside this
 * factory (one rate owner). The module drives the engine through applyValue,
 * never the rate param (which would ramp the rate and lose the sign), and
 * leaving the module restores forward playback.
 */
import { describe, it, expect, vi } from 'vitest';
import { createToneTempoPitchEffect } from '../../src/audio/effects/toneTempoPitch/v1/factory.js';

const Tone = {
  Gain: class { constructor() {} dispose() {} },
  intervalToFrequencyRatio: (s) => Math.pow(2, s / 12),
};

function makeEffect() {
  const playbackController = {
    setPlaybackRate: vi.fn(),
    getPlaybackRateParam: vi.fn(() => ({ value: 1 })),
    setRateMode: vi.fn(() => true),
    setPitchSemitones: vi.fn(() => true),
    setPlaybackReverse: vi.fn(async () => {}),
  };
  const effect = createToneTempoPitchEffect({ Tone, settings: { playbackController } });
  const tape = effect.modules.find((m) => m.id === 'speedReverseTape');
  const stretch = effect.modules.find((m) => m.id === 'speedReverseStretch');
  return { effect, tape, stretch, playbackController };
}

const lastRate = (pc) => pc.setPlaybackRate.mock.calls.at(-1)?.[0];

describe('speed & reverse modules — toneTempoPitch factory', () => {
  it('exposes both flavors and never the rate param (drives via applyValue)', () => {
    const { tape, stretch } = makeEffect();
    expect(tape).toBeTruthy();
    expect(stretch).toBeTruthy();
    expect(tape.getTargetParam()).toBeNull();
    expect(stretch.getTargetParam()).toBeNull();
    expect(tape.valueRange).toMatchObject({ min: -100, max: 100, equilibrium: 0 });
  });

  it('centre (0) rests at 1× normal forward play', () => {
    const { effect, tape, playbackController } = makeEffect();
    effect.configureModule('speedReverseTape');
    playbackController.setPlaybackReverse.mockClear();

    tape.applyValue(0);
    expect(playbackController.setPlaybackReverse).not.toHaveBeenCalledWith(true);
    expect(lastRate(playbackController)).toBeCloseTo(1, 5);
  });

  it('the forward extreme speeds up to 3×, midway to 2×', () => {
    const { effect, tape, playbackController } = makeEffect();
    effect.configureModule('speedReverseTape');

    tape.applyValue(100);
    expect(playbackController.setPlaybackReverse).not.toHaveBeenCalledWith(true);
    expect(lastRate(playbackController)).toBeCloseTo(3, 5);

    tape.applyValue(50);
    expect(lastRate(playbackController)).toBeCloseTo(2, 5);
  });

  it('the reverse extreme plays 1× backwards; the negative midpoint stops', () => {
    const { effect, tape, playbackController } = makeEffect();
    effect.configureModule('speedReverseTape');

    tape.applyValue(-100);
    expect(playbackController.setPlaybackReverse).toHaveBeenLastCalledWith(true);
    expect(lastRate(playbackController)).toBeCloseTo(1, 5);

    // Halfway down the input crosses the real zero → a true stop (rate ~0, the
    // sink glides to silence), still forward direction (0 is not negative).
    playbackController.setPlaybackReverse.mockClear();
    tape.applyValue(-50);
    expect(playbackController.setPlaybackReverse).toHaveBeenLastCalledWith(false);
    expect(lastRate(playbackController)).toBeLessThanOrEqual(0.01);
  });

  it('crossing the stop flips direction exactly once, seamlessly', () => {
    const { effect, tape, playbackController } = makeEffect();
    effect.configureModule('speedReverseTape');
    playbackController.setPlaybackReverse.mockClear();

    tape.applyValue(0);   // 1× forward
    tape.applyValue(-40); // forward, slowing
    tape.applyValue(-50); // the stop (still forward)
    tape.applyValue(-80); // now reverse
    const dirCalls = playbackController.setPlaybackReverse.mock.calls.map((c) => c[0]);
    expect(dirCalls).toEqual([true]);
  });

  it('tape pushes varispeed, stretch pushes locked pitch', () => {
    const { effect, playbackController } = makeEffect();
    effect.configureModule('speedReverseTape');
    expect(playbackController.setRateMode).toHaveBeenLastCalledWith('varispeed');

    effect.configureModule('speedReverseStretch');
    expect(playbackController.setRateMode).toHaveBeenLastCalledWith('stretch');
  });

  it('leaving the module restores forward playback', () => {
    const { effect, tape, playbackController } = makeEffect();
    effect.configureModule('speedReverseTape');
    tape.applyValue(-100);
    expect(playbackController.setPlaybackReverse).toHaveBeenLastCalledWith(true);

    effect.configureModule('tempoFine');
    expect(playbackController.setPlaybackReverse).toHaveBeenLastCalledWith(false);
  });

  it('dispose restores forward playback', () => {
    const { effect, tape, playbackController } = makeEffect();
    effect.configureModule('speedReverseTape');
    tape.applyValue(-100);

    effect.dispose();
    expect(playbackController.setPlaybackReverse).toHaveBeenLastCalledWith(false);
  });

  it('stays independent on a following deck — the mapping is not scaled by the follow ratio', () => {
    const playbackController = {
      setPlaybackRate: vi.fn(),
      getPlaybackRateParam: vi.fn(() => ({ value: 1 })),
      setRateMode: vi.fn(() => true),
      setPitchSemitones: vi.fn(() => true),
      setPlaybackReverse: vi.fn(async () => {}),
    };
    // A synced+warp deck: following with a 2× base (follow) ratio.
    const deck = {
      getSnapshot: () => ({ baseRate: 2, bpm: 120, following: true }),
      onChange: () => () => {},
      setTempo: vi.fn(),
    };
    const effect = createToneTempoPitchEffect({ Tone, settings: { playbackController }, deck });
    effect.configureModule('speedReverseTape');
    const tape = effect.modules.find((m) => m.id === 'speedReverseTape');

    tape.applyValue(100); // +100 → 3× forward; must NOT become baseRate(2) × 3 = 6
    expect(lastRate(playbackController)).toBeCloseTo(3, 5);
  });

  it('ignores input while inactive, applies the held value on activation', () => {
    const { effect, tape, playbackController } = makeEffect();

    tape.applyValue(-100); // module not active (tempoFine is the default)
    expect(playbackController.setPlaybackReverse).not.toHaveBeenCalled();

    effect.configureModule('speedReverseTape');
    expect(playbackController.setPlaybackReverse).toHaveBeenLastCalledWith(true);
    expect(lastRate(playbackController)).toBeCloseTo(1, 5);
  });
});
