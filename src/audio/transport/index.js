/**
 * @file transport/index.js
 * @description The orbiters transport — a thin adapter over the shared package's seconds-first
 *              `Transport` (`entangled-worlds-orbiters-shared/clock`, the single tested time core).
 *
 * There is ONE transport concept, owned by the shared package (decision 006). This adapter maps the
 * play-state / position / loop surface AudioEngineAdapter relies on onto that Transport, backed by a
 * Tone-anchored `ClockBackend` (`createToneClockBackend`). Orbiters uses the transport purely as a
 * position machine — audio is scheduled by the players against `Tone.now()`, never routed through the
 * transport's look-ahead scheduler — so `positionSec()` is read straight off the audio clock and the
 * scheduler/`tick()` path stays dormant.
 *
 * Tempo is NOT a transport concern: the master tempo is owned by `SyncCoordinator` (`get bpm()`); this
 * transport neither stores nor mirrors bpm.
 */
import { Transport } from 'entangled-worlds-orbiters-shared/clock';
import { createToneClockBackend } from './toneClockBackend.js';

export class TransportController {
  constructor() {
    this.Tone = null;
    this._transport = null;
    // Loop range echoed back for AudioEngineAdapter's idempotence checks (seconds).
    this.loopStartSeconds = 0;
    this.loopEndSeconds = 0;
  }

  async init({ Tone } = {}) {
    this.Tone = Tone;
    if (!this.Tone) {
      throw new Error('[Transport] Tone.js reference is required.');
    }
    // A fresh Transport per init: paused at 0, no loop, rate 1 — the seconds-first position machine.
    this._transport = new Transport(createToneClockBackend(this.Tone));
    this.loopStartSeconds = 0;
    this.loopEndSeconds = 0;
  }

  get isRunning() {
    return this._transport?.playing === true;
  }

  get isLooping() {
    return this._transport?.loopEnabled === true;
  }

  async start() {
    if (!this._transport) return;
    if (this._transport.playing) return;
    await this.Tone.start(); // unlock the audio context
    this._transport.play();
  }

  async pause() {
    if (!this._transport) return;
    this._transport.pause();
  }

  async stop() {
    if (!this._transport) return;
    this._transport.pause();
    this._transport.seekSec(0);
  }

  async seek(ms) {
    if (!this._transport) return;
    this._transport.seekSec(Math.max(0, ms / 1000));
  }

  // Loop API — seconds-first, mirroring the old ms→seconds contract (min 20ms window).
  setLoopRange(startMs, endMs) {
    if (!this._transport) return;
    const startSec = Math.max(0, (startMs || 0) / 1000);
    const endSec = Math.max(startSec + 0.02, (endMs || 0) / 1000);
    this.loopStartSeconds = startSec;
    this.loopEndSeconds = endSec;
    this._transport.setLoopSec({ startSec, endSec });
  }

  clearLoop() {
    if (!this._transport) return;
    this._transport.setLoopSec(null);
  }

  getCurrentTimeMs() {
    return this._transport ? this._transport.positionSec() * 1000 : 0;
  }

  // Alias expected by UI/adapter
  getCurrentPositionMs() {
    return this.getCurrentTimeMs();
  }
}
