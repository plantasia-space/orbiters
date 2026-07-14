/**
 * @file src/audio/MultiOrbiterAudioHost.js
 * @description The multi-orbiter composition owner (decision 0001). For views that show several
 * orbiters at once (hybrid/mixed collection, feed), ALL orbiters run in ONE iframe sharing ONE
 * `AudioContext`. This object owns the single shared master bus they mix into:
 *
 *     voice₁.masterGain ╲
 *     voice₂.masterGain ──▶ masterBus(Gain) ──▶ masterLimiter(-1dB) ──▶ Tone.Destination
 *     voiceₙ.masterGain ╱
 *
 * Each `AudioEngineAdapter` voice is constructed with `outputNode = host.getInputNode()` (the slice-1
 * seam) and, seeing an injected output, skips its OWN limiter — so there is ONE limiter on the summed
 * mix, not N (avoid N limiters fighting the master; one owner of the terminal output → speakers).
 *
 * Single-orbiter views never use this — those adapters own their own terminal limiter → Destination,
 * exactly as before. This host is additive: it changes nothing until a multi-orbiter boot wires it in
 * (A3). It deliberately does NOT touch tempo/transport — per-voice transport stays the adapter's
 * (independent-by-default, synced-on-demand via the shared clock).
 */
import * as Tone from 'tone';
import { enforceStereo } from './audioNodeUtils.js';

const MASTER_CEILING_DB = -1; // same ceiling a single orbiter's limiter uses (AudioEngineAdapter)

export class MultiOrbiterAudioHost {
  /**
   * @param {object} [opts]
   * @param {*} [opts.destination] terminal node the master feeds (defaults to `Tone.Destination` —
   *   the speakers). Injectable so tests can capture the terminal connection.
   */
  constructor({ destination } = {}) {
    this._destination = destination ?? Tone.Destination;

    // One summing bus (unity) → one limiter → speakers. Unity because each voice already applies its
    // own output trim; the master only sums + limits the aggregate so N voices can't clip together.
    this.masterBus = new Tone.Gain(1);
    this.masterLimiter = new Tone.Limiter(MASTER_CEILING_DB);
    enforceStereo(this.masterBus);
    enforceStereo(this.masterLimiter);

    this.masterBus.connect(this.masterLimiter);
    this.masterLimiter.connect(this._destination);

    // The host owns the shared AUDIO master only. The voice roster lives on the realm-scoped
    // `voiceRegistry` singleton (src/voice/VoiceRegistry.js) that every reader already resolves —
    // the composition owner (createMultiOrbiterApp, A3) registers its voices THERE and unregisters
    // them per-voiceId on teardown. The host deliberately does NOT hold a second registry: a
    // host.dispose() that cleared the realm would wipe sibling/single-orbiter voices too (the reason
    // an earlier host-owned registry was reverted in A2). See decisions/0001-A2-build-plan.md.
  }

  /**
   * The node each orbiter voice connects into (its `outputNode` seam). Stable for the host's lifetime.
   * @returns {*} the shared master bus.
   */
  getInputNode() {
    return this.masterBus;
  }

  /**
   * Tear down the shared master chain. Voices dispose their OWN adapters and unregister themselves
   * from the realm `voiceRegistry` (the host never touches the roster — see the constructor note).
   */
  dispose() {
    try { this.masterBus?.disconnect?.(); } catch (_) {}
    try { this.masterLimiter?.disconnect?.(); } catch (_) {}
    this.masterBus?.dispose?.();
    this.masterLimiter?.dispose?.();
    this.masterBus = null;
    this.masterLimiter = null;
  }
}
