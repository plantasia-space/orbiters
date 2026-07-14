// @vitest-environment node
/**
 * CHARACTERIZATION — TransportController's OBSERVABLE contract (stage 1).
 *
 * Pins what production actually relies on today, at the behaviour level rather than the mechanism:
 * the play-state (`isRunning`), position (`getCurrentTimeMs`/`getCurrentPositionMs`), loop state
 * (`isLooping` + `loopStartSeconds`/`loopEndSeconds`), and the start/pause/stop/seek effects. These are
 * the exact reads AudioEngineAdapter makes on `this.transport` (gates + the position fallback), so this
 * file anchors the convergence onto the shared-package Transport as behaviour-preserving: it must stay
 * green UNCHANGED after `TransportController` becomes an adapter over that Transport.
 *
 * Deliberately NOT asserted here: that the methods write the global `Tone.Transport` singleton. That is
 * the parallel-implementation detail this removes; the multi-orbiter seam test that pinned it
 * (`multiOrbiterSeams.test.js`) is updated in the swap. The contract that survives is the observable
 * state above, which any correct transport backing must satisfy.
 */
import { describe, it, expect, vi } from 'vitest';
import { TransportController } from '../../src/audio/transport/index.js';

/**
 * A faithful fake Tone: a controllable audio clock (`now()`), a context unlock (`start()`), and a
 * `Transport` stub whose position/loop fields behave like the real singleton (stop() rewinds seconds to
 * 0, pause() leaves it). Serves both the current Tone.Transport-backed controller and the converged
 * shared-Transport-backed one — the test asserts only the controller's own observable state.
 */
function makeFakeTone() {
  let audioNow = 0;
  const Transport = {
    bpm: { value: 0 },
    swing: 0,
    swingSubdivision: null,
    position: null,
    seconds: 0,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    start: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(function stop() { Transport.seconds = 0; }),
  };
  return {
    Transport,
    getTransport: () => Transport,
    now: () => audioNow,
    start: vi.fn(() => Promise.resolve()),
    /** test helper: advance the audio clock (only the converged impl reads it) */
    _advance: (dt) => { audioNow += dt; },
  };
}

async function freshController() {
  const Tone = makeFakeTone();
  const t = new TransportController();
  await t.init({ Tone, tempo: 120 });
  return { Tone, t };
}

describe('TransportController — observable contract (characterization)', () => {
  it('starts paused after init', async () => {
    const { t } = await freshController();
    expect(t.isRunning).toBe(false);
    expect(t.isLooping).toBe(false);
  });

  it('start() unlocks the audio context and runs once (idempotent while running)', async () => {
    const { Tone, t } = await freshController();
    await t.start();
    await t.start();
    expect(Tone.start).toHaveBeenCalledTimes(1); // context unlocked exactly once
    expect(t.isRunning).toBe(true);
  });

  it('pause() stops running without rewinding', async () => {
    const { t } = await freshController();
    await t.start();
    await t.seek(2000);
    await t.pause();
    expect(t.isRunning).toBe(false);
    expect(t.getCurrentTimeMs()).toBeCloseTo(2000, 6);
  });

  it('stop() halts and rewinds position to 0', async () => {
    const { t } = await freshController();
    await t.start();
    await t.seek(2000);
    await t.stop();
    expect(t.isRunning).toBe(false);
    expect(t.getCurrentTimeMs()).toBeCloseTo(0, 6);
  });

  it('seek() moves the reported position (ms → the transport clock)', async () => {
    const { t } = await freshController();
    await t.seek(2000);
    expect(t.getCurrentTimeMs()).toBeCloseTo(2000, 6);
    expect(t.getCurrentPositionMs()).toBeCloseTo(2000, 6); // the alias UI/adapter reads
  });

  it('setLoopRange() enables looping and reports the range in seconds', async () => {
    const { t } = await freshController();
    t.setLoopRange(1000, 3000);
    expect(t.isLooping).toBe(true);
    expect(t.loopStartSeconds).toBeCloseTo(1, 6);
    expect(t.loopEndSeconds).toBeCloseTo(3, 6);
  });

  it('clearLoop() disables looping', async () => {
    const { t } = await freshController();
    t.setLoopRange(1000, 3000);
    t.clearLoop();
    expect(t.isLooping).toBe(false);
  });
});
