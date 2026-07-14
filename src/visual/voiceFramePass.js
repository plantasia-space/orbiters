/**
 * @file visual/voiceFramePass.js
 * @description THE voice's frame pass — one owner for every effect that changes
 *              how the picture is DRAWN rather than what is in it. A voice has a
 *              single post-pass slot, so two such effects cannot each hold one:
 *              they compose here, as CHANNELS of one shader, in one target and
 *              one draw. The cost is the same whether one frame effect is live or
 *              both.
 *
 *              The channels, in the order the picture goes through them:
 *              - `grit`   — the sound overdrives, bit-crushes, waveshapes: the
 *                           picture goes lo-fi. Blocks grow, colours collapse to
 *                           a few steps, an ordered dither breaks the gradients.
 *              - `reverb` — the sound is let go into a room: the sky AROUND the
 *                           world smears outward and the stars pull into streaks,
 *                           coming back into focus as the tail dies. The planet
 *                           stays sharp — a room blurs the space, not the thing.
 *
 *              AT REST, GET OUT OF THE WAY. With every channel silent the frame is
 *              drawn straight to the screen — not routed through a target and mixed
 *              to zero, which would cost a second draw and quietly throw away the
 *              renderer's antialiasing. A silent effect changes not one pixel.
 */

import * as THREE from 'three';

const VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// The blur's sample count is bounded by a CONSTANT: GLSL ES 1.0 cannot loop to a
// uniform, and phone drivers are the reason this pass is shaped the way it is.
const MAX_TAPS = 16;

// Bayer 4x4 by recursion instead of a lookup table: a dynamically indexed array is
// the one thing GLSL ES 1.0 cannot be trusted with across phone drivers.
// No `precision` line: three injects the right one for the device.
const FRAGMENT = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uResolution;    // drawing-buffer size of this voice's cell, px

  // Grit is three different sounds, so it is three different pictures. Each answers
  // only to its own kind of dirt, and a rack can hold more than one at once.
  uniform float uCrush;        // 0..1 — BIT-CRUSHER: the picture is quantised
  uniform float uClip;         // 0..1 — DISTORTION: the picture is driven until it clips
  uniform float uFold;         // 0..1 — CHEBYSHEV: the picture folds back on itself
  uniform float uPixelSize;    // block size at full crush, px (1 = no blocks)
  uniform float uLevels;       // colour steps per channel at full crush
  uniform float uDitherScale;  // Bayer cell size, px
  uniform float uMono;         // 0..1 — toward luminance only

  uniform float uReverb;       // 0..1 — how far the room is let go
  uniform vec2 uCenter;        // the world's centre, in UV
  uniform float uInner;        // the world's own edge, in UV — sharp inside this
  uniform float uFalloff;      // how far past the edge the smear reaches full depth
  uniform float uTaps;         // active blur samples (<= MAX_TAPS)
  uniform float uAspect;       // cell aspect, so the smear is round on any cell

  varying vec2 vUv;

  // The frame as the BIT-CRUSHER sees it: snapped to its block's centre, so a block
  // takes one colour instead of a smear — the picture loses resolution the way the
  // sound loses sample rate. At crush 0 the block is one pixel, so the snap lands on
  // the texel we would have read anyway and this is the clean frame, exactly. The
  // other two kinds of dirt never touch the sampling — they only reshape the colour.
  vec4 crushedSample(vec2 uv) {
    float block = max(uPixelSize, 1.0);
    vec2 px = floor(uv * uResolution / block) * block + block * 0.5;
    return texture2D(tDiffuse, px / uResolution);
  }

  float bayer2(vec2 a) {
    a = floor(a);
    return fract(a.x / 2.0 + a.y * a.y * 0.75);
  }
  float bayer4(vec2 a) {
    return bayer2(0.5 * a) * 0.25 + bayer2(a);
  }

  void main() {
    // THE PLANET STAYS SHARP. The smear only begins past the world's own edge and
    // deepens outward from there — the reverb blurs the ROOM the world sits in, not
    // the world. uInner is the world's projected radius, so this holds at any zoom.
    vec2 toCenter = vUv - uCenter;
    toCenter.x *= uAspect;
    float radius = length(toCenter);
    toCenter.x /= max(uAspect, 0.0001);
    float reach = uReverb * 0.2 * smoothstep(uInner, uInner + uFalloff, radius);

    // Alpha rides along with the colour. It must NOT be forced to 1: a voice's cell can
    // be transparent where nothing is drawn, and an opaque rectangle would appear behind
    // the world the moment an effect spoke — most visibly in the embed.
    vec4 texel;
    if (reach < 0.0005) {
      // Inside the world, and everywhere when the reverb is silent: ONE read, no taps.
      // This is what keeps the pass cheap — the samples are only ever spent on the
      // ring of sky around the planet, never on the planet itself.
      texel = crushedSample(vUv);
    } else {
      vec4 sum = vec4(0.0);
      float weight = 0.0;
      for (int i = 0; i < ${MAX_TAPS}; i++) {
        float fi = float(i);
        if (fi >= uTaps) break;
        float t = fi / max(uTaps - 1.0, 1.0);   // 0 = this pixel, 1 = fully pulled in
        float w = 1.0 - t * 0.75;               // later taps count for less: a tail, not an edge
        sum += crushedSample(vUv - toCenter * reach * t) * w;
        weight += w;
      }
      texel = sum / max(weight, 0.0001);
    }
    vec3 colour = texel.rgb;

    // DISTORTION — the sound is driven until it clips. The picture is driven too:
    // it is pushed hot and the highlights flatten against the ceiling, exactly as a
    // clipped waveform flattens against its rail. Saturation comes up with the drive,
    // the way a distorted sound gains harmonics. Nothing is quantised: a distortion
    // is not a bit-crusher, and must not look like one.
    if (uClip > 0.0) {
      float drive = 1.0 + uClip * 3.0;
      vec3 hot = colour * drive;
      // A soft knee, then the rail: bright things bloom and pin, they do not band.
      vec3 clipped = hot / (1.0 + hot * uClip);
      clipped = min(clipped * (1.0 + uClip * 0.6), vec3(1.0));
      float luma = dot(clipped, vec3(0.2126, 0.7152, 0.0722));
      clipped = mix(vec3(luma), clipped, 1.0 + uClip * 0.8);   // harmonics: colour gets louder
      colour = mix(colour, clamp(clipped, 0.0, 1.0), uClip);
    }

    // CHEBYSHEV — a waveshaper folds the wave back on itself and breeds harmonics.
    // The colour ramp folds the same way: past the top it comes back DOWN instead of
    // pinning, so the picture solarises — bright surfaces invert into strange bands.
    // A fold is not a clip, and it must not read like one.
    if (uFold > 0.0) {
      vec3 driven = colour * (1.0 + uFold * 2.2);
      // Triangle fold: the ramp turns around at 1 instead of stopping there. It must
      // hold BLACK at black — a fold that sends 0 to 1 lights up the empty sky, which
      // is a fold of nothing at all.
      vec3 folded = 1.0 - abs(1.0 - fract(driven * 0.5) * 2.0);
      colour = mix(colour, folded, uFold);
    }

    // BIT-CRUSHER — the sound loses its bits, so the picture loses its bits. Colours
    // collapse to a few steps and an ordered dither breaks the gradients. The dither
    // IS the colour reduction: the threshold rides the quantisation, so the steps
    // break into a pattern instead of banding. (The blocks came in at sample time.)
    if (uCrush > 0.0) {
      colour = mix(colour, vec3(dot(colour, vec3(0.2126, 0.7152, 0.0722))), uMono);
      float threshold = bayer4(gl_FragCoord.xy / max(uDitherScale, 1.0)) - 0.5;
      float levels = max(uLevels, 2.0) - 1.0;
      colour = floor(colour * levels + threshold + 0.5) / levels;
    }

    gl_FragColor = vec4(colour, texel.a);

    // The scene rendered into our target is LINEAR — the renderer only converts to
    // sRGB when it draws to the canvas, and it cannot do that for a raw shader.
    // Without this the whole picture darkens the moment an effect speaks, which
    // would read as the effect dimming the world. It must only crush, or blur.
    #include <colorspace_fragment>
  }
`;

/** Where each channel sits when it is saying nothing. A channel at rest must leave
 *  the picture bit-for-bit as it would have been drawn. */
export const FRAME_PASS_DEFAULTS = Object.freeze({
  grit: Object.freeze({
    strength: 0,
    pixelSize: 4,
    levels: 4,
    ditherScale: 2,
    mono: 0,
  }),
  reverb: Object.freeze({
    strength: 0,
    taps: 8,
    /** The world's projected radius in UV — everything inside it stays sharp. Measured
     *  from the real world each frame; this is only the fallback for a scene with no body. */
    innerRadius: 0.24,
    /** How far past the world's edge the smear takes to reach full depth. */
    falloff: 0.3,
  }),
});

/** Colour steps a clean picture is allowed — high enough to be invisible. */
const CLEAN_LEVELS = 32;

/**
 * @param {THREE.WebGLRenderer} renderer
 * @returns {{
 *   render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
 *          rect: {x:number,y:number,width:number,height:number}|null): void,
 *   setGrit(params: object): void,
 *   setReverb(params: object): void,
 *   dispose(): void,
 * }}
 */
export function createVoiceFramePass(renderer) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    // LINEAR, not nearest: the blur reads between texels. Grit does its own snapping
    // to block centres, so it is unharmed by a filter it never relies on.
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });

  const uniforms = {
    tDiffuse: { value: target.texture },
    uResolution: { value: new THREE.Vector2(size.x, size.y) },

    uCrush: { value: 0 },
    uClip: { value: 0 },
    uFold: { value: 0 },
    // Start where "untouched" is: one-pixel blocks, full colour. The layer eases these in.
    uPixelSize: { value: 1 },
    uLevels: { value: CLEAN_LEVELS },
    uDitherScale: { value: FRAME_PASS_DEFAULTS.grit.ditherScale },
    uMono: { value: 0 },

    uReverb: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uInner: { value: FRAME_PASS_DEFAULTS.reverb.innerRadius },
    uFalloff: { value: FRAME_PASS_DEFAULTS.reverb.falloff },
    uTaps: { value: FRAME_PASS_DEFAULTS.reverb.taps },
    uAspect: { value: 1 },
  };

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms,
      depthTest: false,
      depthWrite: false,
    }),
  );
  const quadScene = new THREE.Scene().add(quad);
  const quadCamera = new THREE.Camera();
  const drawingSize = new THREE.Vector2();
  // Scratch — the render path allocates nothing.
  const centreWorld = new THREE.Vector3();
  const edgeWorld = new THREE.Vector3();
  const cameraRight = new THREE.Vector3();
  const bodyScale = new THREE.Vector3();
  const previousViewport = new THREE.Vector4();
  const previousScissor = new THREE.Vector4();

  /**
   * Where the world IS, and how big it is, on this frame's screen. Measured here
   * rather than handed in: the camera moves every frame, so a radius passed once
   * would drift and the sharp core would slide off the planet.
   */
  function measureWorld(scene, camera, aspect) {
    const body = scene?.getObjectByName?.('worldTextureSphere')
      ?? scene?.getObjectByName?.('worldNormalSphere')
      ?? null;
    if (!body?.geometry) return;
    if (!body.geometry.boundingSphere) body.geometry.computeBoundingSphere();

    // The camera automation moves the camera in this same frame, and three only refreshes
    // its matrices later, inside render(). Projecting off the stale matrix would leave the
    // sharp core one frame behind the planet — it would visibly swim while the camera moves.
    camera.updateMatrixWorld();

    // The body's WORLD scale, not its local one: the world sits under parents that scale it,
    // and reading `body.scale` alone gets the radius wrong — enough for the blur to eat into
    // the planet, or to leave a sharp ring of empty sky around it.
    body.getWorldScale(bodyScale);
    const scale = Math.max(Math.abs(bodyScale.x), Math.abs(bodyScale.y), Math.abs(bodyScale.z));
    const radius = (body.geometry.boundingSphere?.radius ?? 0) * scale;
    if (radius <= 0) return;

    body.getWorldPosition(centreWorld);
    // One radius along the camera's right: on a sphere that IS the silhouette edge.
    cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(radius);
    edgeWorld.copy(centreWorld).add(cameraRight);
    centreWorld.project(camera);
    edgeWorld.project(camera);

    uniforms.uCenter.value.set(centreWorld.x * 0.5 + 0.5, centreWorld.y * 0.5 + 0.5);
    uniforms.uInner.value = Math.hypot(
      (edgeWorld.x - centreWorld.x) * 0.5 * aspect,
      (edgeWorld.y - centreWorld.y) * 0.5,
    );
  }

  return {
    render(activeRenderer, scene, camera, rect = null) {
      // Every channel silent → the frame is drawn as if this pass did not exist.
      if (
        uniforms.uCrush.value <= 0
        && uniforms.uClip.value <= 0
        && uniforms.uFold.value <= 0
        && uniforms.uReverb.value <= 0
      ) {
        activeRenderer.render(scene, camera);
        return;
      }

      const dpr = activeRenderer.getPixelRatio();
      let width;
      let height;
      if (rect) {
        width = Math.max(1, Math.floor(rect.width * dpr));
        height = Math.max(1, Math.floor(rect.height * dpr));
      } else {
        activeRenderer.getDrawingBufferSize(drawingSize);
        width = drawingSize.x;
        height = drawingSize.y;
      }
      // Resize only on an actual change — the compare is two numbers, not a per-frame alloc.
      if (width !== uniforms.uResolution.value.x || height !== uniforms.uResolution.value.y) {
        target.setSize(width, height);
        uniforms.uResolution.value.set(width, height);
      }
      uniforms.uAspect.value = width / Math.max(height, 1);
      if (uniforms.uReverb.value > 0) measureWorld(scene, camera, uniforms.uAspect.value);

      // Hand the renderer back exactly as we found it: in a shared realm the next voice
      // draws with whatever state we leave behind, and a throw must not strand it. That
      // means the VIEWPORT and SCISSOR too, not just the target — a sibling voice drawn
      // after us would otherwise inherit our rect and render into the wrong cell.
      const previousTarget = activeRenderer.getRenderTarget();
      const previousAutoClear = activeRenderer.autoClear;
      activeRenderer.getViewport(previousViewport);
      activeRenderer.getScissor(previousScissor);
      const previousScissorTest = activeRenderer.getScissorTest();
      try {
        // The world into our own target, at the cell's size (three multiplies CSS px by dpr).
        activeRenderer.setRenderTarget(target);
        activeRenderer.setScissorTest(false);
        if (rect) activeRenderer.setViewport(0, 0, rect.width, rect.height);
        activeRenderer.clear();
        activeRenderer.render(scene, camera);

        // …and back as one quad, inside this voice's rect. autoClear stays OFF: a sibling
        // voice has already drawn into this framebuffer and clearing would wipe it.
        activeRenderer.setRenderTarget(previousTarget);
        activeRenderer.autoClear = false;
        if (rect) {
          activeRenderer.setViewport(rect.x, rect.y, rect.width, rect.height);
          activeRenderer.setScissor(rect.x, rect.y, rect.width, rect.height);
          activeRenderer.setScissorTest(true);
        }
        activeRenderer.render(quadScene, quadCamera);
      } finally {
        activeRenderer.setRenderTarget(previousTarget);
        activeRenderer.autoClear = previousAutoClear;
        activeRenderer.setViewport(previousViewport);
        activeRenderer.setScissor(previousScissor);
        activeRenderer.setScissorTest(previousScissorTest);
      }
    },

    /**
     * The grit channel — three kinds of dirt, each with its own picture, each driven
     * by its OWN effect. A rack can hold a bit-crusher and a distortion at once, and
     * they must not be averaged into one look.
     *
     * @param {object} params
     * @param {number} [params.crush] - Bit-crusher: the picture is quantised.
     * @param {number} [params.clip] - Distortion: the picture is driven until it clips.
     * @param {number} [params.fold] - Chebyshev: the picture folds back on itself.
     */
    setGrit(params) {
      if (params.crush !== undefined) {
        uniforms.uCrush.value = Math.min(1, Math.max(0, params.crush));
      }
      if (params.clip !== undefined) {
        uniforms.uClip.value = Math.min(1, Math.max(0, params.clip));
      }
      if (params.fold !== undefined) {
        uniforms.uFold.value = Math.min(1, Math.max(0, params.fold));
      }
      if (params.pixelSize !== undefined) uniforms.uPixelSize.value = params.pixelSize;
      if (params.levels !== undefined) uniforms.uLevels.value = params.levels;
      if (params.ditherScale !== undefined) uniforms.uDitherScale.value = params.ditherScale;
      if (params.mono !== undefined) uniforms.uMono.value = params.mono;
    },

    /** The reverb channel: how far the room is let go, and how finely it is sampled. */
    setReverb(params) {
      if (params.strength !== undefined) {
        uniforms.uReverb.value = Math.min(1, Math.max(0, params.strength));
      }
      if (params.taps !== undefined) {
        uniforms.uTaps.value = Math.min(MAX_TAPS, Math.max(2, Math.round(params.taps)));
      }
      if (params.falloff !== undefined) {
        uniforms.uFalloff.value = Math.max(0.01, params.falloff);
      }
    },

    dispose() {
      target.dispose();
      quad.geometry.dispose();
      quad.material.dispose();
    },
  };
}

export default createVoiceFramePass;
