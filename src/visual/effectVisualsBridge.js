/**
 * @file visual/effectVisualsBridge.js
 * @description Binds a voice's rack-effect lifetimes to their group visual
 *              layers — create on demand, dispose when idle, the same contract
 *              as the granular visual bridge. Nothing exists until the voice's
 *              rack holds an effect of a covered group; the group's layer
 *              (ghost pool, canvases, wet meters, render callback) is built at
 *              that moment and fully torn down when the group's last effect
 *              leaves the rack.
 *
 *              Mounted per voice at the registry's engine-assignment seam
 *              (like the granular bridge). One `peekEffectSlots` covers slots
 *              created during adapter init (persisted rack config); one
 *              `observeEffectSlots` covers every later create/dispose — no
 *              retries, no polling.
 *
 *              Group truth is engine-level and measured: each covered slot
 *              gets a meter on its wet-only tap (the echo lines of a ping-pong
 *              delay per stereo side; the wet return otherwise), scaled by the
 *              live wet mix so bypass reads as invisible. All dimension chains
 *              run in series and stay audible, so slots bind regardless of the
 *              active dimension.
 */

import * as THREE from 'three';
import { EARTH_RADIUS_UNITS } from 'entangled-worlds-orbiters-shared/world';
import { ORBIT_TILT_DEG } from '../world/Ring.js';
import { createEchoesMoonsLayer } from './echoesMoonsLayer.js';
import { createSpaceAirLayer } from './spaceAirLayer.js';
import { createWobbleMoonsLayer } from './wobbleMoonsLayer.js';
import { createGritDitherLayer } from './gritDitherLayer.js';
import { createVoiceFramePass } from './voiceFramePass.js';
import { createPositionLensLayer } from './positionLensLayer.js';
import { createColorTintLayer } from './colorTintLayer.js';
import {
  createWorldGlowCanvas,
  createWorldMoonsCanvas,
  createWorldMoonsSurfaceCanvas,
  createWorldMoonsTintCanvas,
} from './worldCanvasAdapters.js';
import { createWetPathMeter } from './wetPathMeter.js';
import { effectVisualGroupOf } from './effectVisualPolicy.js';
import { isVisualFeedbackEnabled } from './visualFeedbackSettings.js';

// Which group a slot answers in is `effectVisualGroupOf` (one classification, in
// the policy — the Studio panel reads the same one to decide whether a module even
// HAS a visual to switch). The FILTERS deliberately have none: every mapping we
// tried cost far more than it was worth and none looked good enough to keep. A
// filter changes the sound and leaves the world alone.

/**
 * How far this module is driven from REST, 0..1 — the one number a visual answers to.
 *
 * The rule, and it holds for every effect: at equilibrium the visual is absent. Not
 * subtle — absent. The world must look exactly as it would with no module at all,
 * because that is exactly what the ear hears. The answer grows as the control travels
 * away from equilibrium and is fullest at the end of its travel — as full at −100% as
 * at +100%: the SOUND differs there, the amount of answering does not.
 *
 * The number comes from the voice's ParameterManager, which already holds every
 * parameter normalized (whatever the parameter's own scale or transform), keyed by the
 * module's own identity — its dimension and its axis. Equilibrium is the middle of that
 * normalized travel: the axes are declared with equilibrium 0 in a symmetric range, and
 * the rack maps a control of 0.5 to a module's equilibrium.
 *
 * Read it LIVE from the manager, never from the slot's stored `controlNormalized`: that
 * one holds whatever was persisted until the axis first moves, which lit the world up at
 * rest — the exact bug this replaced.
 *
 * @param {object|null} parameterManager - The voice's manager.
 * @param {object|null} slot - The rack slot; carries its dimension and its axis.
 * @returns {number}
 */
function driveOf(parameterManager, slot) {
  return Math.abs(signedDriveOf(parameterManager, slot));
}

/**
 * The same drive, keeping the SIDE it is driven to: −1..1, 0 at equilibrium.
 *
 * Most groups want only how hard a module is driven — a sweep answers as fully at −100%
 * as at +100%, and that stays true here. But some modules are a direction as much as an
 * amount: a pan has a side, a stereo field narrows or widens. Those read this one, and the
 * magnitude of it is exactly `driveOf`.
 *
 * @param {object|null} parameterManager - The voice's manager.
 * @param {object|null} slot - The rack slot; carries its dimension and its axis.
 * @returns {number}
 */
function signedDriveOf(parameterManager, slot) {
  if (!parameterManager?.getNormalizedValue || !slot?.axis) return 0;
  const normalized = parameterManager.getNormalizedValue(slot.axis, slot.dimensionId ?? null);
  if (!Number.isFinite(normalized)) return 0;
  return (clamp01(normalized) - 0.5) * 2;
}

/** The one module of the position group whose drive is a SIDE, not a width. */
const PANNER_EFFECT_ID = 'tone.panner';

/** The EQ's bands, each its own colour channel — a slot's module IS the band it weighs. */
const EQ_BANDS = ['low', 'mid', 'high'];

/** The reverb node exposes room size (0..1), not seconds — the rack folds its
 *  decay mapping into it. Span it back over the vocabulary's decay range. */
const REVERB_DECAY_SPAN_SEC = 8;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * Which PICTURE each dirt makes. The grit group is one group because all three
 * effects dirty the sound — but they dirty it in three different ways, so the world
 * answers each one differently:
 *   crush — the bit-crusher throws away bits, so the picture throws away bits.
 *   clip  — the distortion drives the sound into its rail, so the picture clips.
 *   fold  — the waveshaper folds the wave back on itself, so the colour folds too.
 */
const GRIT_KIND_BY_EFFECT = new Map([
  ['tone.bitcrusher', 'crush'],
  ['tone.distortion', 'clip'],
  ['tone.chebyshev', 'fold'],
]);

/** A Tone param is an object with `.value`; tolerate plain numbers and junk. */
function readParamValue(param) {
  const value = typeof param === 'object' && param !== null ? param.value : param;
  return Number.isFinite(value) ? value : 0;
}

function meterContextOf(node) {
  return node?.context?.rawContext ?? node?.context ?? null;
}

/**
 * @param {object} voiceEntry - The voice's registry entry; reads
 *        `worldController` (scene host) and `audioEngine` (the adapter hosting
 *        the voice's effect racks). Entries without a scene mount nothing.
 * @param {object} [options]
 * @param {() => object|null} [options.getVisualSettings] - Live source of the
 *        voice's resolved effect-visual settings (`effectVisualPolicy.js`);
 *        each group's entry gates its layer and supplies its quality knobs.
 * @returns {{ refresh(): void, dispose(): void }}
 */
export function mountEffectVisuals(voiceEntry, { getVisualSettings = null } = {}) {
  const worldController = voiceEntry?.worldController ?? null;
  const adapter = voiceEntry?.audioEngine ?? null;
  const scene = worldController?.scene ?? null;
  // Whose modules these are: the per-module switches are a choice of THIS voice's
  // orbiter, and a sibling's must not gate them.
  const voiceId = voiceEntry?.id ?? null;
  // This voice's parameters, already normalized — how far a module is driven is read from
  // here, not re-derived. A sibling voice reads its own.
  const parameterManager = voiceEntry?.parameterManager ?? null;
  if (!worldController || !adapter || !scene) {
    return { refresh() {}, dispose() {} };
  }

  // THE voice's frame pass — one owner, shared by every group that changes how the
  // picture is DRAWN (grit crushes it, the reverb lets the room go). The controller
  // has a single post-pass slot: if each group mounted its own, the second to mount
  // would silently evict the first and one of the two effects would do nothing at
  // all. So the pass is built once, on the first group that needs it, and handed
  // back when the last one lets go.
  let framePass = null;
  let framePassHolders = 0;

  function acquireFrameChannel(setterName) {
    if (!framePass) {
      framePass = createVoiceFramePass(worldController.renderer);
      worldController.setPostPass(framePass);
    }
    framePassHolders += 1;
    let released = false;
    return {
      set(params) {
        framePass?.[setterName](params);
      },
      release() {
        if (released) return;
        released = true;
        framePassHolders -= 1;
        if (framePassHolders > 0) return;
        worldController.setPostPass(null);
        framePass.dispose();
        framePass = null;
      },
    };
  }

  /** Per group: live slot → its meters/node binding, plus the mounted layer. */
  const groups = {
    echoes: { bindings: new Map(), layer: null },
    spaceAir: { bindings: new Map(), layer: null },
    wobble: { bindings: new Map(), layer: null },
    grit: { bindings: new Map(), layer: null },
    position: { bindings: new Map(), layer: null },
    color: { bindings: new Map(), layer: null },
  };
  // Scratch state fed to the layers — mutated in place, never re-allocated
  // (render callbacks run on the mobile-hot frame path).
  const echoesState = { levelL: 0, levelR: 0, delaySec: 0, wet: 0 };
  const spaceAirState = { tailLevel: 0, wet: 0, decaySec: 0 };
  const wobbleState = { rateHz: 0, depth: 0, wet: 0, effectId: null };
  const gritState = { crush: 0, clip: 0, fold: 0 };
  const positionState = { pan: 0, width: 0 };
  const colorState = { low: 0, mid: 0, high: 0 };
  let renderCallback = null;
  let disposed = false;

  function groupKeyOf(slot) {
    return effectVisualGroupOf(slot?.config?.effectId);
  }

  function buildBinding(groupKey, slot) {
    const node = slot?.effectNode ?? null;
    const context = meterContextOf(node);
    // The wobble, grit, position and colour groups measure nothing: wobble's motion is
    // the effect's own LFO (reconstructed from the public rate), and the rest are how
    // hard the effect is driven. No meter, so no audio-graph cost.
    if (groupKey === 'wobble' || groupKey === 'grit' || groupKey === 'position' || groupKey === 'color') {
      // The slot itself, because those groups answer to the CONTROL's distance from
      // equilibrium, which is read live off the manager, not to anything hanging off the
      // node. Colour also needs the module: an EQ slot's module IS the band it weighs.
      return {
        node,
        slot,
        effectId: slot?.config?.effectId ?? null,
        moduleId: slot?.config?.moduleId ?? null,
        left: null,
        right: null,
        mono: null,
      };
    }
    // Ping-pong: the two delay lines ARE the stereo sides. Everything else:
    // one wet-only tap (`effectReturn` on mono effects, `_merge` on stereo).
    if (groupKey === 'echoes' && node?._leftDelay && node?._rightDelay) {
      return {
        node,
        left: createWetPathMeter(context, node._leftDelay),
        right: createWetPathMeter(context, node._rightDelay),
        mono: null,
      };
    }
    const tap = node?.effectReturn ?? node?._merge ?? null;
    return { node, left: null, right: null, mono: tap ? createWetPathMeter(context, tap) : null };
  }

  function disposeBinding(binding) {
    binding.left?.dispose();
    binding.right?.dispose();
    binding.mono?.dispose();
  }

  function updateFrame(frame) {
    const echoes = groups.echoes;
    if (echoes.layer) {
      echoesState.levelL = 0;
      echoesState.levelR = 0;
      echoesState.wet = 0;
      echoesState.delaySec = 0;
      echoes.bindings.forEach((binding) => {
        const wet = clamp01(readParamValue(binding.node?.wet));
        if (wet > echoesState.wet) echoesState.wet = wet;
        if (wet <= 0.001) return;
        const time = readParamValue(binding.node?.delayTime);
        if (time > echoesState.delaySec) echoesState.delaySec = time;
        if (binding.left || binding.right) {
          const left = (binding.left?.read() ?? 0) * wet;
          const right = (binding.right?.read() ?? 0) * wet;
          if (left > echoesState.levelL) echoesState.levelL = left;
          if (right > echoesState.levelR) echoesState.levelR = right;
        } else if (binding.mono) {
          const level = binding.mono.read() * wet;
          if (level > echoesState.levelL) echoesState.levelL = level;
          if (level > echoesState.levelR) echoesState.levelR = level;
        }
      });
      echoes.layer.update(frame.nowSec, frame.dtSec, echoesState);
    }

    const spaceAir = groups.spaceAir;
    if (spaceAir.layer) {
      spaceAirState.tailLevel = 0;
      spaceAirState.wet = 0;
      spaceAirState.decaySec = 0;
      spaceAir.bindings.forEach((binding) => {
        const wet = clamp01(readParamValue(binding.node?.wet));
        if (wet > spaceAirState.wet) spaceAirState.wet = wet;
        if (wet <= 0.001) return;
        const decay = clamp01(readParamValue(binding.node?.roomSize)) * REVERB_DECAY_SPAN_SEC;
        if (decay > spaceAirState.decaySec) spaceAirState.decaySec = decay;
        if (binding.mono) {
          const level = binding.mono.read() * wet;
          if (level > spaceAirState.tailLevel) spaceAirState.tailLevel = level;
        }
      });
      spaceAir.layer.update(frame.nowSec, frame.dtSec, spaceAirState);
    }

    const wobble = groups.wobble;
    if (wobble.layer) {
      // With several modulators on one rack the strongest one — the one you
      // actually hear moving the sound — owns the surface, accent and all.
      // Blending four LFOs would just average them into mush.
      let strongest = 0;
      wobbleState.rateHz = 0;
      wobbleState.depth = 0;
      wobbleState.wet = 0;
      wobbleState.effectId = null;
      wobble.bindings.forEach((binding) => {
        const wet = clamp01(readParamValue(binding.node?.wet));
        if (wet <= 0.001) return;
        // The phaser has no `depth` — its sweep is always full-throw and only its
        // wet mix decides how present it is. Absent depth therefore reads as 1,
        // not as 0, or the phaser would be permanently invisible.
        const depth = binding.node?.depth === undefined
          ? 1
          : clamp01(readParamValue(binding.node.depth));
        const presence = wet * depth;
        if (presence <= strongest) return;
        strongest = presence;
        wobbleState.wet = wet;
        wobbleState.depth = depth;
        wobbleState.rateHz = readParamValue(binding.node?.frequency);
        wobbleState.effectId = binding.effectId;
      });
      wobble.layer.update(frame.nowSec, frame.dtSec, wobbleState);
    }

    const grit = groups.grit;
    if (grit.layer) {
      // Three kinds of dirt, three different pictures — a bit-crusher and a distortion
      // do not sound alike and must not look alike. Each kind is driven only by its OWN
      // effects, so a rack holding both shows both. Within ONE kind, the module driven
      // furthest from rest owns the picture: averaging would let a module sitting at
      // equilibrium wash out the one you can actually hear.
      gritState.crush = 0;
      gritState.clip = 0;
      gritState.fold = 0;
      grit.bindings.forEach((binding) => {
        const kind = GRIT_KIND_BY_EFFECT.get(binding.effectId);
        if (!kind) return;
        const amount = driveOf(parameterManager, binding.slot);
        if (amount > gritState[kind]) gritState[kind] = amount;
      });
      grit.layer.update(frame.nowSec, frame.dtSec, gritState);
    }

    const position = groups.position;
    if (position.layer) {
      // Two modules, two different moves of the same lens — the pan slides it, the width
      // opens it — so they are NOT collapsed into one number the way several dirt modules
      // are. Within each, the module driven furthest from rest owns its move.
      let pan = 0;
      let width = 0;
      position.bindings.forEach((binding) => {
        const signed = signedDriveOf(parameterManager, binding.slot);
        if (binding.effectId === PANNER_EFFECT_ID) {
          if (Math.abs(signed) > Math.abs(pan)) pan = signed;
        } else if (Math.abs(signed) > Math.abs(width)) {
          width = signed;
        }
      });
      positionState.pan = pan;
      positionState.width = width;
      position.layer.update(frame.nowSec, frame.dtSec, positionState);
    }

    const color = groups.color;
    if (color.layer) {
      // Each band is its own channel, so the bands do not compete the way several dirt
      // modules do — they MIX, exactly as the colours do. Two EQs both weighing the lows
      // leave the one driven furthest owning blue.
      colorState.low = 0;
      colorState.mid = 0;
      colorState.high = 0;
      color.bindings.forEach((binding) => {
        const band = binding.moduleId;
        if (!EQ_BANDS.includes(band)) return;
        const signed = signedDriveOf(parameterManager, binding.slot);
        if (Math.abs(signed) > Math.abs(colorState[band])) colorState[band] = signed;
      });
      color.layer.update(frame.nowSec, frame.dtSec, colorState);
    }
  }

  function ensureRenderCallback() {
    if (renderCallback) return;
    renderCallback = (frame) => updateFrame(frame);
    worldController.addRenderCallback(renderCallback);
  }

  function releaseRenderCallbackIfIdle() {
    if (!renderCallback || Object.values(groups).some((group) => group.layer)) return;
    worldController.removeRenderCallback(renderCallback);
    renderCallback = null;
  }

  function ensureLayer(groupKey) {
    const group = groups[groupKey];
    if (group.layer) return;
    // The user-preference gate: resolved settings decide whether the group's
    // layer exists at all (bindings still track, so a future live toggle only
    // needs to re-run this).
    const settings = getVisualSettings?.()?.[groupKey];
    if (settings?.enabled === false) return;
    let layer = null;
    if (groupKey === 'echoes') {
      layer = createEchoesMoonsLayer({
        radius: EARTH_RADIUS_UNITS,
        canvas: createWorldMoonsCanvas({ scene }),
        summonedMoonCount: settings?.summonedMoonCount,
      });
      // Ghost moons live on the same tilted plane as the world's real moon
      // group and orbit rings.
      layer.group.rotation.x = THREE.MathUtils.degToRad(ORBIT_TILT_DEG);
    } else if (groupKey === 'spaceAir') {
      // Owns no scene object: like grit, the reverb changes how the voice's frame
      // is DRAWN — the room around the world smears as the tail rings.
      layer = createSpaceAirLayer({
        channel: acquireFrameChannel('setReverb'),
        glowCanvas: createWorldGlowCanvas({ scene }),
        taps: settings?.blurTaps,
      });
    } else if (groupKey === 'grit') {
      // Owns no scene object either — it changes how the voice's frame is DRAWN. The
      // pass lands inside this voice's own rect, so a sibling orbiter stays clean.
      layer = createGritDitherLayer({
        channel: acquireFrameChannel('setGrit'),
        pixelSize: settings?.pixelSize,
        levels: settings?.levels,
        ditherScale: settings?.ditherScale,
      });
    } else if (groupKey === 'position') {
      // Owns no scene object either — it changes the LENS of the camera this voice already
      // has. The camera's placement stays with the scene's camera automation: that one
      // moves the camera, this one only ever writes its projection, so nothing is written
      // twice on a frame. A sibling orbiter has its own camera and is untouched.
      layer = createPositionLensLayer({
        camera: worldController.camera,
        fovNarrowDeg: settings?.fovNarrowDeg,
        fovWideDeg: settings?.fovWideDeg,
        shiftFrac: settings?.shiftFrac,
      });
    } else if (groupKey === 'color') {
      // Owns no scene object either — it tints the moons the world already draws, on
      // their own material, so nothing is added to draw. The colour lands on the moons
      // rather than on the scene's lights: a light colours everything it falls on, the
      // world's whole body included, and the world's own colour is not the effect's to
      // take. Per-voice: the moons are this voice's scene's.
      layer = createColorTintLayer({
        canvas: createWorldMoonsTintCanvas({ scene }),
        channelSpan: settings?.channelSpan,
      });
    } else if (groupKey === 'wobble') {
      // Owns no scene object — it only reshapes the moons the world already
      // draws, so there is nothing to attach and no draw call added.
      layer = createWobbleMoonsLayer({
        canvas: createWorldMoonsSurfaceCanvas({
          scene,
          bumpScale: settings?.bumpScale,
          noiseTextureSize: settings?.noiseTextureSize,
        }),
      });
    }
    if (!layer) return;
    if (layer.group) worldController.attachOverlay(layer.group);
    group.layer = layer;
    ensureRenderCallback();
  }

  function teardownLayer(groupKey) {
    const group = groups[groupKey];
    if (!group.layer) return;
    if (group.layer.group) worldController.detachOverlay(group.layer.group);
    group.layer.dispose();
    group.layer = null;
    releaseRenderCallbackIfIdle();
  }

  function onSlot(slot, present) {
    if (disposed) return;
    const groupKey = groupKeyOf(slot);
    if (!groupKey) return;
    const group = groups[groupKey];
    // A module whose visual feedback is switched off binds NOTHING: no meter on
    // the audio graph, no layer, no texture, no render callback. That is what
    // makes an orbiter cheap to load — the cost is never paid, not paid and
    // hidden. Re-read on every call, so `refresh()` alone flips a live module.
    const wanted = present && isVisualFeedbackEnabled(voiceId, slot?.dimensionId, slot?.axis);
    if (wanted) {
      if (group.bindings.has(slot)) return;
      group.bindings.set(slot, buildBinding(groupKey, slot));
      ensureLayer(groupKey);
    } else {
      const binding = group.bindings.get(slot);
      if (!binding) return;
      disposeBinding(binding);
      group.bindings.delete(slot);
      if (group.bindings.size === 0) {
        teardownLayer(groupKey);
      }
    }
  }

  const unobserve = adapter.observeEffectSlots?.((slot, present) => onSlot(slot, present))
    ?? (() => {});
  adapter.peekEffectSlots?.()?.forEach((slot) => onSlot(slot, true));

  return {
    /**
     * Re-decide every live slot against the settings — the switch moved. Binding
     * and unbinding are the same path the rack's own create/dispose takes, so a
     * module turned on mid-session builds exactly what it would have built at
     * load, and one turned off leaves nothing behind. The audio graph is not
     * touched, which is the whole point.
     */
    refresh() {
      if (disposed) return;
      adapter.peekEffectSlots?.()?.forEach((slot) => onSlot(slot, true));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unobserve();
      Object.keys(groups).forEach((groupKey) => {
        groups[groupKey].bindings.forEach((binding) => disposeBinding(binding));
        groups[groupKey].bindings.clear();
        teardownLayer(groupKey);
      });
    },
  };
}

export default mountEffectVisuals;
