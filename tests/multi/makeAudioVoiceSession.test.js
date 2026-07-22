// @vitest-environment jsdom
/**
 * Slice A3 — the audio-only secondary voice session + the per-voice factory routing.
 *
 * The real audio graph (fetchTrackData → AudioEngineAdapter.initialize/preload) needs a real
 * AudioContext + network, so it is browser/hardware-verified, not unit-tested here. What IS pinned:
 * the SYNCHRONOUS contract — registration shape, handle shape, suspend-is-no-op, dispose — and that
 * the factory routes index 0 → full app, 1..n → audio-only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeAudioVoiceSession } from '../../src/multi/makeAudioVoiceSession.js';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';

beforeEach(() => voiceRegistry.clear());

describe('makeAudioVoiceSession — synchronous contract', () => {
  it('registers the voice (id + managers, no audioEngine yet) and returns the handle shape', () => {
    const session = makeAudioVoiceSession({ entry: { voiceId: 'v1', trackId: 't1' }, outputNode: {} });

    expect(session.voiceId).toBe('v1');
    expect(typeof session.start).toBe('function');
    expect(typeof session.dispose).toBe('function');
    expect(session.parameterManager).toBeTruthy();

    const voice = voiceRegistry.get('v1');
    expect(voice).toBeTruthy();
    expect(voice.parameterManager).toBe(session.parameterManager);
    expect(voice.dataManager).toBeTruthy();
    expect(voice.audioEngine).toBeUndefined(); // filled only after start() async init
  });

  it('suspend is a no-op (audio-only voice has no visual/idle resources)', () => {
    const session = makeAudioVoiceSession({ entry: { voiceId: 'v1', trackId: 't1' }, outputNode: {} });
    expect(() => session.suspend()).not.toThrow();
  });

  it('dispose before start does not throw (no engine built yet)', () => {
    const session = makeAudioVoiceSession({ entry: { voiceId: 'v1', trackId: 't1' }, outputNode: {} });
    expect(() => session.dispose()).not.toThrow();
  });

  it('the primary registers first, so a secondary leaves it the active/focused voice', () => {
    voiceRegistry.register('primary', { id: 'primary' }); // primary boots first in createMultiOrbiterApp
    makeAudioVoiceSession({ entry: { voiceId: 'v1', trackId: 't1' }, outputNode: {} });
    expect(voiceRegistry.activeId).toBe('primary');
    expect(voiceRegistry.size).toBe(2);
  });
});

describe('makeOrbiterVoiceSession — compositor wiring', () => {
  it('boots EVERY voice as a full createOrbitersApp sharing the renderHost renderer/canvas, and registers its controller', async () => {
    vi.resetModules();
    const controllers = [{ id: 'wc-p' }, { id: 'wc-s' }];
    let n = 0;
    const createOrbitersApp = vi.fn(({ voiceId }) => ({
      voiceId,
      worldController: controllers[n++],
      parameterManager: {},
      start: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    }));
    vi.doMock('../../src/orbitersApp.js', () => ({ createOrbitersApp }));

    const { makeOrbiterVoiceSession } = await import('../../src/multi/makeOrbiterVoiceSession.js');
    const bus = {};
    const cells = [];
    // The ViewportCompositor stand-in: ONE renderer + canvas the whole realm shares.
    const renderHost = {
      renderer: { id: 'shared-renderer' },
      canvas: { id: 'shared-canvas' },
      createCell: vi.fn(() => {
        const cell = { remove: vi.fn(), addEventListener: vi.fn() };
        cells.push(cell);
        return cell;
      }),
      addVoice: vi.fn(),
      removeVoice: vi.fn(),
    };

    makeOrbiterVoiceSession({ entry: { voiceId: 'p', trackId: 't0', trackVersion: 12 }, index: 0, total: 2, isPrimary: true, outputNode: bus, renderHost });
    const secondary = makeOrbiterVoiceSession({ entry: { voiceId: 's', trackId: 't1' }, index: 1, total: 2, isPrimary: false, outputNode: bus, renderHost });

    // Every voice is a FULL scene+UI voice that BORROWS the realm's one renderer + canvas (no per-voice
    // context) and mounts its FULL interface into its own cell (G2). Primary = index 0.
    const expected = { p: true, s: false };
    for (const voiceId of ['p', 's']) {
      expect(createOrbitersApp).toHaveBeenCalledWith(
        expect.objectContaining({
          voiceId,
          outputNode: bus,
          installLifecycle: false,
          mountChrome: true,
          uiContainer: expect.any(Object),
          isPrimary: expected[voiceId],
          canvasEl: renderHost.canvas,
          sharedRenderer: renderHost.renderer,
          eventBus: expect.any(EventTarget),
        }),
      );
    }
    // One cell per voice, and each voice's scene+camera registered with the compositor.
    expect(renderHost.createCell).toHaveBeenCalledTimes(2);
    expect(renderHost.addVoice).toHaveBeenCalledWith({ voiceId: 'p', cell: cells[0], controller: controllers[0] });
    expect(renderHost.addVoice).toHaveBeenCalledWith({ voiceId: 's', cell: cells[1], controller: controllers[1] });
    expect(createOrbitersApp.mock.calls[0][0].sessionDescriptor).toEqual({
      trackId: 't0',
      trackVersion: 12,
      orbiterId: undefined,
      entangledWorldId: undefined,
    });

    // Dispose unregisters the voice from the compositor.
    secondary.dispose();
    expect(renderHost.removeVoice).toHaveBeenCalledWith('s');

    vi.doUnmock('../../src/orbitersApp.js');
  });

  it('throws without a renderHost (the shared renderer is mandatory for the multi visual path)', async () => {
    vi.resetModules();
    vi.doMock('../../src/orbitersApp.js', () => ({ createOrbitersApp: vi.fn() }));
    const { makeOrbiterVoiceSession } = await import('../../src/multi/makeOrbiterVoiceSession.js');
    expect(() =>
      makeOrbiterVoiceSession({ entry: { voiceId: 'p', trackId: 't0' }, index: 0, total: 1, outputNode: {} }),
    ).toThrow(/renderHost/);
    vi.doUnmock('../../src/orbitersApp.js');
  });
});
