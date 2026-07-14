// @vitest-environment node
/**
 * Modules that consume the decoded buffer (engineRequirement
 * 'prebuffer-required' or 'stretch-required') pull a track onto the buffered
 * path — but only when downloading + decoding the whole track is feasible
 * here. On an infeasible track (too long, or predicted too slow) the voice
 * stays streaming and the resolution flags `requirementBlocked`, which the
 * player surfaces as locked engine features with an explicit unlock, instead
 * of attempting a hopeless full prebuffer.
 */
import { describe, it, expect } from 'vitest';
import { resolvePlaybackStrategy } from '../../../src/audio/playback/strategyResolver.js';

// 20 minutes: over every duration threshold, so buffering is infeasible.
const LONG_TRACK = { durationMs: 20 * 60 * 1000 };
// 3 minutes: under every duration threshold, so buffering is feasible.
const SHORT_TRACK = { durationMs: 3 * 60 * 1000 };

describe('resolvePlaybackStrategy — engine requirement', () => {
  it('long tracks stream when no module needs the decoded buffer', () => {
    const resolution = resolvePlaybackStrategy({
      effectsConfig: {
        x: { modules: [{ effectId: 'tone.reverb', moduleId: 'small' }] },
      },
      trackData: LONG_TRACK,
    });
    expect(resolution.strategy).toBe('stream');
    expect(resolution.requirementBlocked).toBe(false);
  });

  it('a prebuffer-required module resolves buffered on a feasible track', () => {
    const resolution = resolvePlaybackStrategy({
      effectsConfig: {
        x: { modules: [{ effectId: 'granular', moduleId: 'cloud' }] },
      },
      trackData: SHORT_TRACK,
    });
    expect(resolution.strategy).toBe('prebuffer');
    expect(resolution.requirement).toBe('prebuffer-required');
    expect(resolution.reason).toBe('effects-require-prebuffer');
    expect(resolution.bufferedFeasible).toBe(true);
    expect(resolution.requirementBlocked).toBe(false);
  });

  it('a prebuffer-required module on an infeasible track streams, blocked', () => {
    const resolution = resolvePlaybackStrategy({
      effectsConfig: {
        x: { modules: [{ effectId: 'granular', moduleId: 'cloud' }] },
      },
      trackData: LONG_TRACK,
    });
    expect(resolution.strategy).toBe('stream');
    expect(resolution.requirement).toBe('prebuffer-required');
    expect(resolution.bufferedFeasible).toBe(false);
    expect(resolution.requirementBlocked).toBe(true);
    expect(resolution.reason).toBe('engine-requirement-blocked-stream');
  });

  it('a stretch-required module follows the same feasibility gate', () => {
    const feasible = resolvePlaybackStrategy({
      effectsConfig: {
        x: { modules: [{ effectId: 'tone.tempoPitch', moduleId: 'tempoStretchWide' }] },
      },
      trackData: SHORT_TRACK,
    });
    expect(feasible.strategy).toBe('prebuffer');
    expect(feasible.requirementBlocked).toBe(false);

    const blocked = resolvePlaybackStrategy({
      effectsConfig: {
        x: { modules: [{ effectId: 'tone.tempoPitch', moduleId: 'tempoStretchWide' }] },
      },
      trackData: LONG_TRACK,
    });
    expect(blocked.strategy).toBe('stream');
    expect(blocked.requirement).toBe('stretch-required');
    expect(blocked.requirementBlocked).toBe(true);
  });

  it('the requirement applies from any axis slot', () => {
    const resolution = resolvePlaybackStrategy({
      effectsConfig: {
        x: { modules: [{ effectId: 'tone.reverb', moduleId: 'small' }] },
        z: { modules: [{ effectId: 'granular', moduleId: 'haze' }] },
      },
      trackData: SHORT_TRACK,
    });
    expect(resolution.strategy).toBe('prebuffer');
  });

  it('unknown duration streams + blocks automatically (the explicit unlock is never gated)', () => {
    const resolution = resolvePlaybackStrategy({
      effectsConfig: {
        x: { modules: [{ effectId: 'granular', moduleId: 'cloud' }] },
      },
      trackData: {},
    });
    expect(resolution.strategy).toBe('stream');
    expect(resolution.requirementBlocked).toBe(true);
  });
});
