// @vitest-environment jsdom
/**
 * Slice A3 — the multi-orbiter composition owner + shell (decision 0001-A3-build-plan).
 *
 * The per-voice factory is injected, so this pins the OWNER's orchestration without a real
 * AudioContext or DOM boot: one host, N voices each bound to host.getInputNode(), index 0 = primary,
 * ONE shared lifecycle handler set, and clean per-voice teardown (unregister, never clear the realm).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMultiOrbiterApp } from '../../src/multi/createMultiOrbiterApp.js';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';

function fakeHost() {
  return { masterBus: { tag: 'bus' }, getInputNode() { return this.masterBus; }, dispose: vi.fn() };
}

/** A factory that records how it was called and returns a controllable voice session. */
function recordingFactory() {
  const calls = [];
  const make = ({ entry, index, isPrimary, host, outputNode }) => {
    calls.push({ entry, index, isPrimary, outputNode, sameBus: outputNode === host.getInputNode() });
    return {
      voiceId: entry.voiceId,
      start: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    };
  };
  return { make, calls };
}

const ROSTER = [
  { voiceId: 'v0', trackId: 't0' },
  { voiceId: 'v1', trackId: 't1' },
];

beforeEach(() => {
  voiceRegistry.clear();
});

describe('createMultiOrbiterApp — composition', () => {
  it('constructs ONE host and one voice per roster entry, each bound to the shared bus', () => {
    const host = fakeHost();
    const { make, calls } = recordingFactory();
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });

    expect(app.host).toBe(host);
    expect(app.voices).toHaveLength(2);
    expect(calls.map((c) => c.index)).toEqual([0, 1]);
    expect(calls.map((c) => c.isPrimary)).toEqual([true, false]); // index 0 = primary
    expect(calls.every((c) => c.sameBus)).toBe(true); // every voice wired to host.getInputNode()
  });

  it('skips a voice whose factory returns null (one bad entry cannot sink the realm)', () => {
    const host = fakeHost();
    const make = ({ entry, index }) => (index === 1 ? null : { voiceId: entry.voiceId });
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });
    expect(app.voices.map((v) => v.voiceId)).toEqual(['v0']);
  });

  it('throws on an empty roster or a non-function factory', () => {
    expect(() => createMultiOrbiterApp({ roster: [], makeVoiceSession: () => ({}) })).toThrow();
    expect(() => createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: null })).toThrow();
  });
});

describe('createMultiOrbiterApp — render host', () => {
  it('builds ONE render host, threads it to every voice, and disposes it after the voices', () => {
    const host = fakeHost();
    const renderHost = { dispose: vi.fn() };
    const createRenderHost = vi.fn(() => renderHost);
    const seen = [];
    const make = ({ entry, renderHost: rh }) => {
      seen.push(rh);
      return { voiceId: entry.voiceId, dispose: vi.fn() };
    };
    const app = createMultiOrbiterApp({
      roster: ROSTER, makeVoiceSession: make, createHost: () => host, createRenderHost,
    });

    expect(createRenderHost).toHaveBeenCalledTimes(1); // ONE per realm, like the audio host
    expect(seen).toEqual([renderHost, renderHost]); // same instance to every voice

    app.dispose();
    expect(renderHost.dispose).toHaveBeenCalledTimes(1);
  });

  it('no createRenderHost → renderHost is null (audio-only / unit paths need no shared renderer)', () => {
    const host = fakeHost();
    let received = 'unset';
    const make = ({ entry, renderHost: rh }) => {
      received = rh;
      return { voiceId: entry.voiceId };
    };
    createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });
    expect(received).toBeNull();
  });
});

describe('createMultiOrbiterApp — start()', () => {
  it('starts every voice once, and is idempotent', async () => {
    const host = fakeHost();
    const { make } = recordingFactory();
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });

    await app.start();
    await app.start(); // idempotent
    for (const v of app.voices) expect(v.start).toHaveBeenCalledTimes(1);
  });

  it('boots voices CONCURRENTLY — a slow voice does not gate the others starting', async () => {
    const host = fakeHost();
    // voice 0 never resolves; concurrent boot means voice 1 still gets started immediately.
    const make = ({ entry, index }) => ({
      voiceId: entry.voiceId,
      start: index === 0 ? vi.fn(() => new Promise(() => {})) : vi.fn(() => Promise.resolve()),
    });
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });

    app.start(); // do NOT await — the never-resolving voice 0 would hang a sequential await
    await Promise.resolve(); // let the synchronous fan-out kick every voice's start
    expect(app.voices[0].start).toHaveBeenCalledTimes(1);
    expect(app.voices[1].start).toHaveBeenCalledTimes(1); // started despite voice 0 still pending
  });

  it('one voice failing to start does not stop the others', async () => {
    const host = fakeHost();
    const make = ({ entry, index }) => ({
      voiceId: entry.voiceId,
      start: index === 0 ? vi.fn(() => { throw new Error('boom'); }) : vi.fn(),
    });
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });
    await app.start();
    expect(app.voices[1].start).toHaveBeenCalledTimes(1);
  });
});

describe('createMultiOrbiterApp — shared lifecycle', () => {
  it('installs ONE visibility/pagehide handler set that fans out to all voices', async () => {
    const host = fakeHost();
    const { make } = recordingFactory();
    const winListeners = {};
    const docListeners = {};
    const windowTarget = { addEventListener: (t, fn) => { (winListeners[t] ??= []).push(fn); } };
    const documentTarget = {
      visibilityState: 'visible',
      addEventListener: (t, fn) => { (docListeners[t] ??= []).push(fn); },
    };
    const app = createMultiOrbiterApp({
      roster: ROSTER, makeVoiceSession: make, createHost: () => host, windowTarget, documentTarget,
    });
    await app.start();

    // exactly one handler each — not N (one per voice)
    expect(docListeners.visibilitychange).toHaveLength(1);
    expect(winListeners.pagehide).toHaveLength(1);

    documentTarget.visibilityState = 'hidden';
    docListeners.visibilitychange[0]();
    for (const v of app.voices) expect(v.suspend).toHaveBeenCalledTimes(1);

    documentTarget.visibilityState = 'visible';
    docListeners.visibilitychange[0]();
    for (const v of app.voices) expect(v.resume).toHaveBeenCalledTimes(1);
  });
});

describe('createMultiOrbiterApp — runtime roster mutation (collection mode)', () => {
  it('addVoice appends a voice at the given slot, starts it when the realm is started, and returns its id', async () => {
    const host = fakeHost();
    const { make, calls } = recordingFactory();
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });
    await app.start();

    const id = await app.addVoice({ voiceId: 'v2', trackId: 't2' }, 2);
    expect(id).toBe('v2');
    expect(app.voices.map((v) => v.voiceId)).toEqual(['v0', 'v1', 'v2']);
    // built at the requested slot index, and started because the realm was already started
    expect(calls.at(-1)).toMatchObject({ index: 2 });
    expect(app.voices[2].start).toHaveBeenCalledTimes(1);
  });

  it('addVoice does NOT auto-start before the realm has started', async () => {
    const host = fakeHost();
    const { make } = recordingFactory();
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });
    await app.addVoice({ voiceId: 'v2', trackId: 't2' }, 2);
    expect(app.voices[2].start).not.toHaveBeenCalled();
    await app.start();
    expect(app.voices[2].start).toHaveBeenCalledTimes(1); // started with the rest
  });

  it('removeVoice disposes + unregisters ONLY that voice, leaving siblings intact', () => {
    const host = fakeHost();
    const make = ({ entry }) => {
      voiceRegistry.register(entry.voiceId, { id: entry.voiceId });
      return { voiceId: entry.voiceId, dispose: vi.fn() };
    };
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });
    const removed = app.voices[1];

    expect(app.removeVoice('v1')).toBe(true);
    expect(removed.dispose).toHaveBeenCalledTimes(1);
    expect(app.voices.map((v) => v.voiceId)).toEqual(['v0']); // pulled from the array
    expect(voiceRegistry.has('v1')).toBe(false);
    expect(voiceRegistry.has('v0')).toBe(true); // sibling untouched
    expect(app.removeVoice('nope')).toBe(false); // unknown id is a no-op
  });
});

describe('createMultiOrbiterApp — dispose()', () => {
  it('disposes every voice + the host, unregisters per-voice, and is idempotent', () => {
    const host = fakeHost();
    // voices register themselves into the realm registry like the real factory does
    const make = ({ entry }) => {
      voiceRegistry.register(entry.voiceId, { id: entry.voiceId });
      return { voiceId: entry.voiceId, dispose: vi.fn() };
    };
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });
    expect(voiceRegistry.size).toBe(2);

    app.dispose();
    for (const v of app.voices) expect(v.dispose).toHaveBeenCalledTimes(1);
    expect(host.dispose).toHaveBeenCalledTimes(1);
    expect(voiceRegistry.size).toBe(0); // both unregistered (per-voice, not clear())
    expect(() => app.dispose()).not.toThrow();
    expect(host.dispose).toHaveBeenCalledTimes(1); // still once
  });

  it('unregisters ONLY its own voices, leaving an unrelated realm voice intact', () => {
    const host = fakeHost();
    voiceRegistry.register('unrelated', { id: 'unrelated' }); // e.g. a sibling single-orbiter voice
    const make = ({ entry }) => {
      voiceRegistry.register(entry.voiceId, { id: entry.voiceId });
      return { voiceId: entry.voiceId, dispose: vi.fn() };
    };
    const app = createMultiOrbiterApp({ roster: ROSTER, makeVoiceSession: make, createHost: () => host });
    app.dispose();
    expect(voiceRegistry.has('unrelated')).toBe(true); // never cleared the whole realm
    expect(voiceRegistry.size).toBe(1);
  });
});
