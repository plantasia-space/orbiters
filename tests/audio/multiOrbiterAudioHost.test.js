// @vitest-environment node
/**
 * (decision 0001) — slice A1. The `MultiOrbiterAudioHost` composition owner: one shared master
 * bus → one limiter → speakers, the node N orbiter voices mix into. Tone is faked (no real
 * AudioContext) — we assert the GRAPH the host builds (sum → limit → terminal) and clean teardown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A fake Tone whose nodes record their outgoing connections + lifecycle, so we can assert the master
// chain shape without a Web Audio context.
vi.mock('tone', () => {
  const mkNode = (tag, arg) => ({
    tag,
    arg,
    out: [],
    disconnected: false,
    disposed: false,
    set: vi.fn(),
    connect(target) { this.out.push(target); return target; },
    disconnect() { this.disconnected = true; },
    dispose() { this.disposed = true; },
  });
  class Gain { constructor(v) { return mkNode('Gain', v); } }
  class Limiter { constructor(v) { return mkNode('Limiter', v); } }
  const Destination = { tag: 'Destination' };
  return { Gain, Limiter, Destination };
});

import * as Tone from 'tone';
import { MultiOrbiterAudioHost } from '../../src/audio/MultiOrbiterAudioHost.js';

describe('MultiOrbiterAudioHost — shared master bus (A1)', () => {
  let host;
  beforeEach(() => { host = new MultiOrbiterAudioHost(); });

  it('builds sum-bus → limiter(-1 dB) → Tone.Destination', () => {
    expect(host.masterBus.tag).toBe('Gain');
    expect(host.masterBus.arg).toBe(1); // unity — voices already trim their own output
    expect(host.masterLimiter.tag).toBe('Limiter');
    expect(host.masterLimiter.arg).toBe(-1); // same ceiling a single orbiter uses
    // bus → limiter → destination
    expect(host.masterBus.out).toContain(host.masterLimiter);
    expect(host.masterLimiter.out).toContain(Tone.Destination);
  });

  it('exposes the sum bus as the voice input node', () => {
    expect(host.getInputNode()).toBe(host.masterBus);
  });

  it('does NOT hold its own voice registry — the roster lives on the realm voiceRegistry singleton', () => {
    // A host-owned registry was reverted in A2: host.dispose() clearing it would wipe sibling +
    // single-orbiter voices. The composition owner registers voices on the realm singleton instead.
    expect(host.voices).toBeUndefined();
  });

  it('feeds an injected destination instead of the speakers when given one', () => {
    const sink = { tag: 'capture' };
    const h = new MultiOrbiterAudioHost({ destination: sink });
    expect(h.masterLimiter.out).toContain(sink);
    expect(h.masterLimiter.out).not.toContain(Tone.Destination);
  });

  it('forces the master nodes to stereo', () => {
    expect(host.masterBus.set).toHaveBeenCalledWith(expect.objectContaining({ channelCount: 2 }));
    expect(host.masterLimiter.set).toHaveBeenCalledWith(expect.objectContaining({ channelCount: 2 }));
  });

  it('dispose() disconnects + disposes the master chain and nulls it', () => {
    const bus = host.masterBus;
    const limiter = host.masterLimiter;
    host.dispose();
    expect(bus.disconnected).toBe(true);
    expect(bus.disposed).toBe(true);
    expect(limiter.disconnected).toBe(true);
    expect(limiter.disposed).toBe(true);
    expect(host.masterBus).toBeNull();
    expect(host.masterLimiter).toBeNull();
    expect(() => host.dispose()).not.toThrow(); // idempotent
  });
});
