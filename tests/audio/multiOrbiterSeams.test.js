// @vitest-environment jsdom
/**
 * Multi-orbiter shared-audio — slice 1 (decision 0001).
 *
 * SEAMS — the backward-compatible injection points on AudioEngineAdapter: an injected `transport` and
 * `outputNode`, both defaulting to today's behaviour. (The TransportController contract itself is pinned
 * by `transportController.characterization.test.js`; the controller adapts the shared
 * package Transport rather than mutating a global `Tone.Transport`, so the old mechanism assertions moved
 * to that behaviour-level file.)
 */
import { describe, it, expect, vi } from 'vitest';
import { TransportController } from '../../src/audio/transport/index.js';
import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';

describe('AudioEngineAdapter — multi-orbiter injection seams (slice 1)', () => {
  it('uses an injected transport when provided', () => {
    const shared = new TransportController();
    const adapter = new AudioEngineAdapter({ transport: shared });
    expect(adapter.transport).toBe(shared);
  });

  it('constructs its own TransportController by default (single-orbiter unchanged)', () => {
    const adapter = new AudioEngineAdapter();
    expect(adapter.transport).toBeInstanceOf(TransportController);
  });

  it('stores an injected output node, and is null (→ Tone.Destination) by default', () => {
    const node = { connect: vi.fn(), disconnect: vi.fn() };
    expect(new AudioEngineAdapter({ outputNode: node })._outputNode).toBe(node);
    expect(new AudioEngineAdapter()._outputNode).toBeNull();
  });
});

describe('AudioEngineAdapter._connectTerminalOutput — multi-orbiter master bus (A1)', () => {
  // The terminal-output decision is unit-testable without a real AudioContext: the multi-orbiter branch
  // (an injected shared bus) builds NO Tone node, it only re-routes masterGain. We exercise it on a bare
  // instance with fake nodes. The single-orbiter branch builds real Tone nodes (needs a context) and is
  // browser-verified, not unit-tested here — same as the rest of the audio-graph build.
  function fakeNode() {
    const out = [];
    return { out, connect(t) { out.push(t); return t; } };
  }

  it('mixes into the injected master bus with NO per-voice limiter (one limiter on the summed mix)', () => {
    const adapter = Object.create(AudioEngineAdapter.prototype);
    const outputNode = fakeNode();
    const masterMeter = fakeNode();
    const masterGain = fakeNode();
    Object.assign(adapter, { _outputNode: outputNode, masterMeter, masterGain, limiter: 'STALE' });

    adapter._connectTerminalOutput();

    expect(adapter.limiter).toBeNull(); // the shared MultiOrbiterAudioHost owns the limiter
    expect(masterGain.out).toContain(masterMeter); // per-voice level still metered (pre-sum)
    expect(masterGain.out).toContain(outputNode); // and summed into the shared master bus
  });
});
