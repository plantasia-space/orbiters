// @vitest-environment jsdom
/**
 * The space/air group's visual layer. The reverb's PRESENCE is what it is actually
 * doing to the sound — the measured tail, scaled by the mix — never its settings
 * alone: a reverb sitting at its default wet with nothing playing is silent, and a
 * silent effect has no visual and costs nothing. Once it does ring, the ROOM around
 * the world is let go, and the world's own rim keeps breathing with the tail. The
 * layer adds nothing to the scene: it writes one channel of the voice's frame pass.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSpaceAirLayer } from '../../src/visual/spaceAirLayer.js';

// The pass itself is WebGL — its own contract (bypass at rest, the sharp core, the
// colour space, grit and reverb composing in one draw) is proved against a fake
// renderer in voiceFramePass.test.js. Here we prove what the LAYER decides: how far
// the room is let go, and whether it is let go at all.
function createStubChannel() {
  const channel = {
    strength: 0,
    taps: undefined,
    released: false,
    set: vi.fn((params) => {
      if (params.strength !== undefined) channel.strength = params.strength;
      if (params.taps !== undefined) channel.taps = params.taps;
    }),
    release: vi.fn(() => { channel.released = true; }),
  };
  return channel;
}

function createStubCanvas({ exists = true } = {}) {
  return {
    existsValue: exists,
    sync: vi.fn(),
    exists() { return this.existsValue; },
    drive: vi.fn(),
    reset: vi.fn(),
  };
}

/** Run the layer until its presence envelope settles on the given state. */
function settle(layer, state, { frames = 60, dt = 0.016, from = 0 } = {}) {
  for (let i = 0; i < frames; i += 1) {
    layer.update(from + i * dt, dt, state);
  }
}

/** A tail this hot drives presence to its ceiling (tailLevel · TAIL_GAIN >= 1). */
const RINGING = { tailLevel: 0.1, wet: 0.5, decaySec: 4 };
/** The same reverb, loaded and mixed in — but with nothing playing through it. */
const LOADED_BUT_SILENT = { tailLevel: 0, wet: 0.5, decaySec: 4 };

describe('space/air layer', () => {
  it('shows NOTHING for a loaded reverb that is not ringing (a silent effect has no visual)', () => {
    // The regression that fogged worlds the moment they loaded: a reverb defaults to
    // wet 0.5, so driving the visual off the SETTING blurred the world before a
    // single note played.
    const channel = createStubChannel();
    const glowCanvas = createStubCanvas();
    const layer = createSpaceAirLayer({ channel, glowCanvas });

    settle(layer, LOADED_BUT_SILENT);

    expect(channel.strength).toBe(0);
    expect(glowCanvas.reset).toHaveBeenCalled();
    expect(glowCanvas.drive.mock.calls.some(([v]) => v.strength > 0)).toBe(false);

    layer.dispose();
  });

  it('adds no geometry to the world — the reverb changes how the frame is DRAWN', () => {
    // The old layer summoned a mist sphere and a halo sprite for worlds without an
    // atmosphere. Both ignored the world's real size, so a small planet was swallowed
    // by a fog ball. The reverb now owns no scene object at all.
    const channel = createStubChannel();
    const layer = createSpaceAirLayer({ channel });

    expect(layer.group).toBeUndefined();

    layer.dispose();
    // The channel is handed back, or the frame pass would never be torn down.
    expect(channel.released).toBe(true);
    expect(channel.strength).toBe(0);
  });

  it('smears the room once it rings, deeper the longer the room', () => {
    const channel = createStubChannel();
    const glowCanvas = createStubCanvas();
    const layer = createSpaceAirLayer({ channel, glowCanvas });

    settle(layer, RINGING);

    // presence at its ceiling, decayNorm = 4/8: depth = 1 · (0.35 + 0.5·0.65)
    expect(channel.strength).toBeCloseTo(0.675, 3);
    const glow = glowCanvas.drive.mock.lastCall[0];
    expect(glow.strength).toBeCloseTo(0.675, 3);
    expect(glow.decayNorm).toBeCloseTo(0.5, 5);

    layer.dispose();
    expect(glowCanvas.reset).toHaveBeenCalled();
  });

  it('a bigger room lets the picture go further', () => {
    const small = createStubChannel();
    const big = createStubChannel();
    const shortRoom = createSpaceAirLayer({ channel: small });
    const longRoom = createSpaceAirLayer({ channel: big });

    settle(shortRoom, { tailLevel: 0.1, wet: 0.5, decaySec: 1 });
    settle(longRoom, { tailLevel: 0.1, wet: 0.5, decaySec: 8 });

    expect(big.strength).toBeGreaterThan(small.strength);

    shortRoom.dispose();
    longRoom.dispose();
  });

  it('reads as invisible at bypass: wet 0 shows nothing even with a hot tail', () => {
    const channel = createStubChannel();
    const layer = createSpaceAirLayer({ channel });

    settle(layer, { tailLevel: 0.9, wet: 0, decaySec: 8 });

    expect(channel.strength).toBe(0);
    layer.dispose();
  });

  it('lets the room come back into focus once the tail rings out', () => {
    const channel = createStubChannel();
    const glowCanvas = createStubCanvas();
    const layer = createSpaceAirLayer({ channel, glowCanvas });

    settle(layer, RINGING);
    expect(channel.strength).toBeGreaterThan(0);

    // The dry stops: the tail decays away and the picture settles with it.
    settle(layer, LOADED_BUT_SILENT, { frames: 400, from: 1 });

    expect(channel.strength).toBe(0);
    expect(glowCanvas.reset).toHaveBeenCalled();

    layer.dispose();
  });

  it('takes its sample count from the resolved quality setting', () => {
    const channel = createStubChannel();
    const layer = createSpaceAirLayer({ channel, taps: 6 });

    // A weak device takes fewer samples in the smeared ring and the room still lets go.
    expect(channel.taps).toBe(6);

    layer.dispose();
  });
});
