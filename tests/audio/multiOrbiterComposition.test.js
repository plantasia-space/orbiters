// @vitest-environment jsdom
/**
 * Slice A3 — multi-orbiter composition contract (decision 0001, "## Slice A3").
 *
 * Pins the wiring `createMultiOrbiterApp` performs so the composition owner is provably correct
 * before (and independent of) the big per-voice boot refactor:
 *  1. HOST ↔ ADAPTER seam — a voice constructed with `outputNode: host.getInputNode()` mixes into
 *     the shared master bus and skips its OWN limiter (one limiter on the summed mix, A3 acceptance).
 *  2. N → 1 sum — two voices on one host both route into the same bus, neither owns a limiter.
 *  3. REALM-REGISTRY composition + per-voice teardown — N voices register under real ids; tearing
 *     ONE down (unregister, not clear) leaves its siblings intact and re-points the active voice.
 *     This is why A3's dispose unregisters per voiceId rather than clearing the whole realm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { MultiOrbiterAudioHost } from '../../src/audio/MultiOrbiterAudioHost.js';
import { AudioEngineAdapter } from '../../src/audio/AudioEngineAdapter.js';
import { VoiceRegistry } from '../../src/voice/VoiceRegistry.js';

/** A voice's pre-terminal nodes — stands in for the graph the adapter builds before the master sum. */
function fakeVoiceNodes() {
  const node = () => {
    const out = [];
    return { out, connect(t) { out.push(t); return t; } };
  };
  return { masterGain: node(), masterMeter: node() };
}

describe('A3 host ↔ adapter wiring (the seam createMultiOrbiterApp threads)', () => {
  it('a voice given host.getInputNode() mixes into the shared bus with NO per-voice limiter', () => {
    const host = new MultiOrbiterAudioHost();
    const adapter = Object.create(AudioEngineAdapter.prototype);
    const { masterGain, masterMeter } = fakeVoiceNodes();
    Object.assign(adapter, {
      _outputNode: host.getInputNode(),
      masterGain,
      masterMeter,
      limiter: 'STALE',
    });

    adapter._connectTerminalOutput();

    expect(adapter.limiter).toBeNull(); // the shared host owns the one limiter
    expect(masterGain.out).toContain(masterMeter); // still metered pre-sum
    expect(masterGain.out).toContain(host.masterBus); // summed into the shared master bus
  });

  it('two voices on one host both feed the same bus; the host still has ONE limiter → destination', () => {
    const host = new MultiOrbiterAudioHost();
    const voices = [fakeVoiceNodes(), fakeVoiceNodes()].map((nodes) => {
      const adapter = Object.create(AudioEngineAdapter.prototype);
      Object.assign(adapter, { _outputNode: host.getInputNode(), ...nodes, limiter: 'STALE' });
      adapter._connectTerminalOutput();
      return { adapter, ...nodes };
    });

    for (const v of voices) {
      expect(v.adapter.limiter).toBeNull();
      expect(v.masterGain.out).toContain(host.masterBus);
    }
    // N voice masterGains → one masterBus → one masterLimiter → Destination (A3 acceptance shape).
    expect(host.masterBus.out).toContain(host.masterLimiter);
  });

  it('the constructor stores an injected outputNode (single-orbiter default is null → own limiter)', () => {
    const host = new MultiOrbiterAudioHost();
    expect(new AudioEngineAdapter({ outputNode: host.getInputNode() })._outputNode).toBe(host.getInputNode());
    expect(new AudioEngineAdapter()._outputNode).toBeNull();
  });
});

describe('A3 realm-registry composition + per-voice teardown', () => {
  let registry;
  beforeEach(() => { registry = new VoiceRegistry(); });

  it('registers N voices under real orbiter ids, preserving order; first is active', () => {
    registry.register('orb-a', { id: 'orb-a' });
    registry.register('orb-b', { id: 'orb-b' });
    registry.register('orb-c', { id: 'orb-c' });

    expect(registry.all().map((v) => v.id)).toEqual(['orb-a', 'orb-b', 'orb-c']);
    expect(registry.getActive().id).toBe('orb-a');
    expect(registry.size).toBe(3);
  });

  it('unregistering ONE voice leaves siblings intact (A3 teardown is per-voice, not clear())', () => {
    registry.register('orb-a', { id: 'orb-a' });
    registry.register('orb-b', { id: 'orb-b' });

    registry.unregister('orb-a'); // the active one
    expect(registry.has('orb-a')).toBe(false);
    expect(registry.has('orb-b')).toBe(true);
    expect(registry.getActive().id).toBe('orb-b'); // active re-points, never dangles
    expect(registry.size).toBe(1);
  });

  it('setActive switches the single-focus voice among the roster', () => {
    registry.register('orb-a', { id: 'orb-a' });
    registry.register('orb-b', { id: 'orb-b' });

    registry.setActive('orb-b');
    expect(registry.getActive().id).toBe('orb-b');
    expect(() => registry.setActive('nope')).toThrow(); // only registered ids
  });
});
