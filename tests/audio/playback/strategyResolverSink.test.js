// @vitest-environment jsdom
/**
 * The resolver owns the WHOLE playback decision: the final sink
 * ('stretch' | 'prebuffer' | 'stream') and the speed lock — including the
 * ?stretchEngine URL flags, the sticky buffered override, the
 * engine-requirement gate, and the mobile-stream lock rule. This is the
 * matrix the player used to finish inside AudioEngineAdapter (untestable
 * without constructing it); pure here, it's a table test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const device = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../../src/config/Constants.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isMobileDevice: () => device.mobile };
});

const { resolvePlaybackStrategy } = await import('../../../src/audio/playback/strategyResolver.js');

const SHORT = { durationMs: 3 * 60 * 1000 };   // under every threshold
const LONG = { durationMs: 20 * 60 * 1000 };   // over every threshold

const setUrl = (search) => window.history.replaceState({}, '', `/${search}`);

afterEach(() => {
  setUrl('');
  device.mobile = false;
});

describe('resolvePlaybackStrategy — final sink', () => {
  it('bufferable tracks run on the stretch engine (the default player)', () => {
    expect(resolvePlaybackStrategy({ trackData: SHORT }).sink).toBe('stretch');
  });

  it('?stretchEngine=0 falls back to the classic buffer-source sink', () => {
    setUrl('?stretchEngine=0');
    expect(resolvePlaybackStrategy({ trackData: SHORT }).sink).toBe('prebuffer');
  });

  it('long tracks stream', () => {
    expect(resolvePlaybackStrategy({ trackData: LONG }).sink).toBe('stream');
  });

  it('?stretchEngine=1 forces the engine even onto stream-resolved tracks', () => {
    setUrl('?stretchEngine=1');
    const resolution = resolvePlaybackStrategy({ trackData: LONG });
    expect(resolution.sink).toBe('stretch');
  });

  it('the sticky buffered override (explicit unlock) wins over the auto stream verdict', () => {
    const resolution = resolvePlaybackStrategy({ trackData: LONG, forceBuffered: true });
    expect(resolution.sink).toBe('stretch');
  });

  it('the requirement block clears exactly when an override changes the sink', () => {
    const granular = { x: { modules: [{ effectId: 'granular', moduleId: 'grains' }] } };
    const blocked = resolvePlaybackStrategy({ trackData: LONG, effectsConfig: granular });
    expect(blocked.sink).toBe('stream');
    expect(blocked.requirementBlocked).toBe(true);

    const unblocked = resolvePlaybackStrategy({
      trackData: LONG, effectsConfig: granular, forceBuffered: true,
    });
    expect(unblocked.sink).toBe('stretch');
    expect(unblocked.requirementBlocked).toBe(false);
  });
});

describe('resolvePlaybackStrategy — speed lock', () => {
  it('locks only mobile streaming voices', () => {
    device.mobile = true;
    const locked = resolvePlaybackStrategy({ trackData: LONG });
    expect(locked.shouldLockSpeed).toBe(true);
    expect(locked.speedLockReason).toBe('mobile-stream');

    const buffered = resolvePlaybackStrategy({ trackData: SHORT });
    expect(buffered.shouldLockSpeed).toBe(false);

    device.mobile = false;
    const desktopStream = resolvePlaybackStrategy({ trackData: LONG });
    expect(desktopStream.shouldLockSpeed).toBe(false);
    expect(desktopStream.speedLockReason).toBeNull();
  });

  it('the mobile lock lifts when an override moves the voice onto the engine', () => {
    device.mobile = true;
    const resolution = resolvePlaybackStrategy({ trackData: LONG, forceBuffered: true });
    expect(resolution.sink).toBe('stretch');
    expect(resolution.shouldLockSpeed).toBe(false);
  });

  it('?forceSpeedLock=1 locks unconditionally (the off-mobile test hatch)', () => {
    setUrl('?forceSpeedLock=1');
    const resolution = resolvePlaybackStrategy({ trackData: SHORT });
    expect(resolution.shouldLockSpeed).toBe(true);
    expect(resolution.speedLockReason).toBe('force-speed-lock-param');
  });
});
