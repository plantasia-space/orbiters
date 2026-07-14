// @vitest-environment jsdom
/**
 * The voice's frame pass — ONE owner for every effect that changes how the picture is
 * drawn. The promises it has to keep: at rest it costs nothing (the frame goes straight
 * to the screen, not through a target that would quietly strip its antialiasing); the
 * frame it hands back is never darker than the one it was given (a blur must blur, not
 * dim); the planet stays sharp while the room smears; and — the reason it exists —
 * a distortion and a reverb on the same voice BOTH speak, in one target and one draw,
 * instead of one silently evicting the other.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createVoiceFramePass, FRAME_PASS_DEFAULTS } from '../../src/visual/voiceFramePass.js';

/**
 * A renderer that records HOW the frame was drawn — straight, or through a target — and
 * that HOLDS its viewport/scissor state, so a pass which fails to hand the renderer back
 * as it found it is caught here rather than in a sibling voice's cell.
 */
function createRecordingRenderer() {
  let currentTarget = null;
  const viewport = new THREE.Vector4(0, 0, 320, 200);
  const scissor = new THREE.Vector4(0, 0, 320, 200);
  let scissorTest = false;
  return {
    autoClear: true,
    draws: [],
    getPixelRatio: () => 1,
    getDrawingBufferSize: (v) => v.set(320, 200),
    getRenderTarget: () => currentTarget,
    setRenderTarget: vi.fn((t) => { currentTarget = t; }),
    getViewport: (v) => v.copy(viewport),
    setViewport: vi.fn((x, y, w, h) => {
      if (x?.isVector4) viewport.copy(x);
      else viewport.set(x, y, w, h);
    }),
    getScissor: (v) => v.copy(scissor),
    setScissor: vi.fn((x, y, w, h) => {
      if (x?.isVector4) scissor.copy(x);
      else scissor.set(x, y, w, h);
    }),
    getScissorTest: () => scissorTest,
    setScissorTest: vi.fn((on) => { scissorTest = on; }),
    clear: vi.fn(),
    render: vi.fn(function record(scene) {
      this.draws.push({ scene, target: currentTarget });
    }),
  };
}

/** A world with a real body, so the pass can measure where the planet is. */
function createWorld() {
  const scene = new THREE.Scene();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial());
  body.name = 'worldTextureSphere';
  scene.add(body);
  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100);
  camera.position.set(0, 0, 3);
  camera.updateMatrixWorld();
  return { scene, camera };
}

/** The quad's live uniforms, as the renderer sees them on the frame just drawn. */
function uniformsOf(renderer) {
  return renderer.draws.at(-1).scene.children[0].material.uniforms;
}

describe('voice frame pass', () => {
  it('AT REST, GETS OUT OF THE WAY: one straight draw, no target, no quad', () => {
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);

    pass.render(renderer, scene, camera, null);

    // The cost is not paid, and the renderer's own antialiasing is not thrown away.
    expect(renderer.draws).toHaveLength(1);
    expect(renderer.draws[0].target).toBeNull();
    expect(renderer.setRenderTarget).not.toHaveBeenCalled();

    pass.dispose();
  });

  it('a SILENT reverb and a CLEAN sound leave the pass bypassed', () => {
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);

    pass.setGrit({ crush: 0, clip: 0, fold: 0 });
    pass.setReverb({ strength: 0 });
    pass.render(renderer, scene, camera, null);

    expect(renderer.draws).toHaveLength(1);
    pass.dispose();
  });

  it('EITHER channel alone earns the pass its keep', () => {
    const { scene, camera } = createWorld();

    const gritOnly = createRecordingRenderer();
    const a = createVoiceFramePass(gritOnly);
    a.setGrit({ clip: 0.5 });
    a.render(gritOnly, scene, camera, null);
    expect(gritOnly.draws).toHaveLength(2); // world → target, quad → screen
    a.dispose();

    const reverbOnly = createRecordingRenderer();
    const b = createVoiceFramePass(reverbOnly);
    b.setReverb({ strength: 0.5 });
    b.render(reverbOnly, scene, camera, null);
    expect(reverbOnly.draws).toHaveLength(2);
    b.dispose();
  });

  it('A DISTORTION AND A REVERB ON ONE VOICE BOTH SPEAK — one target, one draw', () => {
    // The whole reason this pass exists. A voice has a single post-pass slot: when the
    // two effects each held their own, the second to mount evicted the first and one of
    // them silently did nothing. They are channels of one shader now.
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);

    pass.setGrit({ crush: 0.8, pixelSize: 6, levels: 4 });
    pass.setReverb({ strength: 0.6 });
    pass.render(renderer, scene, camera, null);

    const u = uniformsOf(renderer);
    expect(u.uCrush.value).toBeCloseTo(0.8, 5);
    expect(u.uReverb.value).toBeCloseTo(0.6, 5);
    // Both effects, and still exactly one trip through one target.
    expect(renderer.draws).toHaveLength(2);
    expect(renderer.draws.filter((d) => d.target !== null)).toHaveLength(1);

    // The renderer is handed back exactly as it was found — a sibling voice draws next.
    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.autoClear).toBe(true);

    pass.dispose();
  });

  it('converts back out of linear colour, so the picture never darkens when an effect speaks', () => {
    // Rendering into a target hands back LINEAR colour; the renderer only converts to
    // sRGB when it draws to the canvas, and it cannot do that for a raw shader. Without
    // the conversion the world dimmed the moment an effect kicked in.
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);

    pass.setReverb({ strength: 0.5 });
    pass.render(renderer, scene, camera, null);

    const material = renderer.draws[1].scene.children[0].material;
    expect(material.fragmentShader).toContain('colorspace_fragment');

    pass.dispose();
  });

  it('clamps every channel — a hot tail cannot drive the picture past full', () => {
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);

    pass.setGrit({ crush: 4, clip: 4, fold: 4 });
    pass.setReverb({ strength: 4 });
    pass.render(renderer, scene, camera, null);

    const u = uniformsOf(renderer);
    expect(u.uCrush.value).toBe(1);
    expect(u.uClip.value).toBe(1);
    expect(u.uFold.value).toBe(1);
    expect(u.uReverb.value).toBe(1);

    pass.dispose();
  });

  it('THE THREE DIRTS ARE THREE PICTURES — each is driven alone, and any of them wakes the pass', () => {
    // A bit-crusher, a distortion and a waveshaper sound nothing alike. Before this they
    // all produced the identical blocks-and-dither, so the world could not tell you which
    // effect was speaking. Each kind now owns its own channel and none leaks into another.
    const { scene, camera } = createWorld();

    ['crush', 'clip', 'fold'].forEach((kind) => {
      const renderer = createRecordingRenderer();
      const pass = createVoiceFramePass(renderer);

      pass.setGrit({ [kind]: 0.7 });
      pass.render(renderer, scene, camera, null);

      // This kind speaks…
      const u = uniformsOf(renderer);
      expect(u[`u${kind[0].toUpperCase()}${kind.slice(1)}`].value).toBeCloseTo(0.7, 5);
      // …the pass earns its keep for it…
      expect(renderer.draws).toHaveLength(2);
      // …and the other two stay silent.
      const others = ['uCrush', 'uClip', 'uFold']
        .filter((name) => name.toLowerCase() !== `u${kind}`);
      others.forEach((name) => expect(u[name].value).toBe(0));

      pass.dispose();
    });
  });

  it('only the BIT-CRUSHER pixelates: the blocks are what losing bits looks like', () => {
    // A clipped or folded picture keeps its resolution — the shader must sample the frame
    // at full detail for them, or a distortion would look like a crusher.
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);

    pass.setGrit({ clip: 1, fold: 1, pixelSize: 1, levels: 32 });
    pass.render(renderer, scene, camera, null);

    const u = uniformsOf(renderer);
    expect(u.uPixelSize.value).toBe(1);   // no blocks
    expect(u.uLevels.value).toBe(32);     // no banding

    pass.dispose();
  });

  it('measures the world each frame, so the sharp core stays on the planet at any zoom', () => {
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);
    pass.setReverb({ strength: 0.5 });

    pass.render(renderer, scene, camera, null);
    const innerNear = uniformsOf(renderer).uInner.value;

    camera.position.set(0, 0, 9); // the same world, further away
    camera.updateMatrixWorld();
    pass.render(renderer, scene, camera, null);
    const innerFar = uniformsOf(renderer).uInner.value;

    // The planet is smaller on screen from further away, so the sharp core shrinks with
    // it. A radius handed over once would have drifted off the planet.
    expect(innerNear).toBeGreaterThan(innerFar);
    expect(innerFar).toBeGreaterThan(0);

    pass.dispose();
  });

  it('hands the renderer back EXACTLY as it found it — viewport and scissor too', () => {
    // A sibling voice draws into the same framebuffer right after us. Leaving our rect
    // behind would send its world into the wrong cell.
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);

    const rect = { x: 40, y: 10, width: 120, height: 90 };
    pass.setReverb({ strength: 0.5 });
    pass.render(renderer, scene, camera, rect);

    const viewport = new THREE.Vector4();
    const scissor = new THREE.Vector4();
    renderer.getViewport(viewport);
    renderer.getScissor(scissor);
    expect(viewport.toArray()).toEqual([0, 0, 320, 200]);
    expect(scissor.toArray()).toEqual([0, 0, 320, 200]);
    expect(renderer.getScissorTest()).toBe(false);
    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.autoClear).toBe(true);

    pass.dispose();
  });

  it('restores the renderer even when the draw THROWS', () => {
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);
    pass.setReverb({ strength: 0.5 });

    renderer.render = () => { throw new Error('driver lost'); };
    expect(() => pass.render(renderer, scene, camera, { x: 5, y: 5, width: 50, height: 50 }))
      .toThrow('driver lost');

    // A throw must not strand the renderer pointed at our target, or nothing draws again.
    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.getScissorTest()).toBe(false);
    expect(renderer.autoClear).toBe(true);

    pass.dispose();
  });

  it('keeps the frame\'s ALPHA — an effect must not paint an opaque box over a transparent cell', () => {
    // The voice's cell is transparent where nothing is drawn (the embed depends on it).
    // Forcing alpha to 1 turned that into a black rectangle the moment an effect spoke.
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);

    pass.setGrit({ clip: 0.5 });
    pass.render(renderer, scene, camera, null);

    const shader = renderer.draws[1].scene.children[0].material.fragmentShader;
    expect(shader).not.toContain('vec4(colour, 1.0)');
    expect(shader).toContain('texel.a');

    pass.dispose();
  });

  it('measures the world off a FRESH camera matrix — the sharp core cannot lag the camera', () => {
    // The camera automation moves the camera in the same frame; three only refreshes its
    // matrices later, inside render(). Reading the stale matrix left the sharp core one
    // frame behind the planet, visibly swimming while the camera moved. The pass must not
    // depend on someone else having updated the camera first.
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);
    pass.setReverb({ strength: 0.5 });

    pass.render(renderer, scene, camera, null);
    const before = uniformsOf(renderer).uInner.value;

    // Move the camera and DO NOT update its matrix — exactly what production does.
    camera.position.set(0, 0, 12);
    pass.render(renderer, scene, camera, null);
    const after = uniformsOf(renderer).uInner.value;

    expect(after).toBeLessThan(before); // it saw the move on the SAME frame
  });

  it('measures the world\'s radius through its PARENTS — an ancestor\'s scale counts', () => {
    // The world hangs under parents that scale it. Reading the body's local scale alone
    // got the radius wrong, so the blur ate into the planet or left a sharp ring of sky.
    const renderer = createRecordingRenderer();
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100);
    camera.position.set(0, 0, 3);

    const build = (parentScale) => {
      const scene = new THREE.Scene();
      const parent = new THREE.Group();
      parent.scale.setScalar(parentScale);
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial());
      body.name = 'worldTextureSphere';
      parent.add(body);
      scene.add(parent);
      scene.updateMatrixWorld(true);
      return scene;
    };

    const pass = createVoiceFramePass(renderer);
    pass.setReverb({ strength: 0.5 });

    pass.render(renderer, build(1), camera, null);
    const plain = uniformsOf(renderer).uInner.value;

    pass.render(renderer, build(2), camera, null);
    const scaledUp = uniformsOf(renderer).uInner.value;

    // Twice as big under its parent → twice the sharp core. Local scale alone saw neither.
    expect(scaledUp).toBeGreaterThan(plain * 1.5);

    pass.dispose();
  });

  it('falls back to a safe core for a world it cannot measure (no body in the scene)', () => {
    const renderer = createRecordingRenderer();
    const pass = createVoiceFramePass(renderer);

    pass.setReverb({ strength: 0.5 });
    pass.render(renderer, new THREE.Scene(), new THREE.Camera(), null);

    expect(uniformsOf(renderer).uInner.value).toBe(FRAME_PASS_DEFAULTS.reverb.innerRadius);

    pass.dispose();
  });

  it('caps the sample count — a phone driver cannot be handed an unbounded loop', () => {
    const renderer = createRecordingRenderer();
    const { scene, camera } = createWorld();
    const pass = createVoiceFramePass(renderer);

    pass.setReverb({ strength: 0.5, taps: 999 });
    pass.render(renderer, scene, camera, null);

    expect(uniformsOf(renderer).uTaps.value).toBe(16);

    pass.dispose();
  });
});
