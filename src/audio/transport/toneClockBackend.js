/**
 * @file transport/toneClockBackend.js
 * @description The production `ClockBackend` for the shared-package `Transport` — the neutral,
 *              audio-anchored time source the transport derives its seconds-first position from.
 *
 * The shared `Transport` depends only on the `ClockBackend` contract
 * (`entangled-worlds-orbiters-shared/clock`): `nowSec()` for the current audio time, and `armAt()` to
 * schedule an audio event ahead. Orbiters uses the transport purely as a POSITION / play-state / loop
 * machine — audio is scheduled by the players themselves against `Tone.now()` (see
 * `src/audio/playback/player.js`), never routed through the transport's look-ahead scheduler. So this
 * backend provides the audio clock (`nowSec` = `Tone.now()`) and a `armAt` that is never exercised in
 * this app: the transport's `tick()`/scheduling path isn't pumped here, and `positionSec()` is derived
 * from the audio clock on read without it. The no-op arm keeps the contract total and honest — if a
 * future need does schedule through the transport, this is the one place a real `node.start(time)` wires
 * in.
 */

/** @returns {() => boolean} a cancel handle; false = nothing armed to cancel (orbiters arms nothing). */
const NO_ARM = () => false;

/**
 * @param {{ now?: () => number }} Tone the Tone.js module (or any object exposing `now()` in seconds).
 * @returns {import('entangled-worlds-orbiters-shared/clock').ClockBackend}
 */
export function createToneClockBackend(Tone) {
  if (!Tone || typeof Tone.now !== 'function') {
    throw new Error('[ToneClockBackend] a Tone reference exposing now() is required.');
  }
  return {
    nowSec() {
      return Tone.now();
    },
    // Orbiters schedules no audio through the transport (players self-schedule on Tone.now()); this
    // arm is never called. Kept total so the transport contract holds if scheduling is ever adopted.
    armAt() {
      return NO_ARM;
    },
  };
}
