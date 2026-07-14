# Visual design standard — the fixed sound→visual vocabulary

Companion to `src/audio/effects/effect_design_standard.md` (the EDS). The EDS governs how a
control module drives an audio parameter; this document governs how audio state becomes
visible. In production so far: the granular accretion disk, the echoes group (moons), and
the space/air group (cloud shell + glow) — the remaining groups exist as `/fx-harness`
prototypes.

## Principles

1. **One vocabulary, engine-level, module-agnostic.** Visuals bind to an effect's merged
   engine/param state and its events — never to control modules. Whichever module or input
   drives `grainSize`, a grain always renders with the same lifetime and scale response.
   Users learn one sound→visual language, once.
2. **Vocabulary is per semantic group, not per effect.** All delays share the echoes visual,
   all reverbs the space/air visual, and so on (~9 groups cover the whole rack). A family may
   carry a small parameter-level accent (ping-pong = alternating sides), and a family can be
   promoted to its own look when its identity demands it — granular's disk is the precedent.
3. **Blended metaphor: space provides the form, plants the behaviour.** Every look is a space
   object behaving like a living thing — rings tremble like leaves in wind, a body blooms
   open as a filter opens, moons answer each other like fireflies. Restraint rule: a little
   wonder, never a light show ("not too trippy, but a little").
4. **Modulate the world first (cost tiers).** Tier 0 = drive elements the scene already draws
   (body material, cloud shell, rings, moons, playhead satellite) via uniforms, colors, and
   transforms — zero new draw calls. Tier 1 = a dedicated pooled layer (instanced sprites,
   shader-animated), justified only by an event-rich engine. The heavier an effect's *audio*
   cost, the cheaper its visual must be: reverb and delay already spend the phone's budget,
   so their visuals are pure tier 0.
5. **Summoned canvas — no world misses out.** A group's visual prefers the world elements the
   planet actually has (real moons carry the echoes, the world's own shell carries the mist).
   When the element is absent, the effect *summons* an ephemeral stand-in — ghost moons that
   grow in while the delay exists, a fainter mist for a world without a sky — visual-only,
   disposed with the effect, never persisted into the world's data. Summoned stand-ins look
   ghostly/translucent so a world's real features stay distinguishable. Never substitute a
   *different* element (echoes never borrow the rings) — the vocabulary's shape is fixed;
   only its materiality changes.
6. **Honest signals, measured not simulated.** Event-shaped visuals read a real level meter
   on the effect's wet path (precedent: the oscilloscope ring reads the voice's master meter
   every frame). A reverb halo keeps glowing exactly as long as the tail rings; echo blinks
   land exactly when repeats are audible. Declare each group's meter in its spec — it is an
   audio-graph cost and must be counted.
7. **Per-orbiter elements only.** The vocabulary binds to elements owned by the voice.
   World-shared canvas (scene fog, background, global lights) is out of contract — behavior
   must be identical solo and in a shared multi-orbiter scene, with no attribution ambiguity.
8. **Presence follows wet.** `|wet|` (or the group's equivalent) scales the visual's
   presence; bypass means invisible, and visuals gate on transport like the disk layer does.

## Runtime rules (same as the disk layer)

- **Lifecycle: create on demand, dispose when idle.** Nothing exists until the effect does;
  full teardown (geometry, materials, callbacks, meters) when it goes away.
- **One loop.** No layer owns a RAF. The scene controller drives every layer's `update` with
  one clamped `{nowSec, dtSec}` clock; when the scene pauses, layers pause for free.
- **No per-frame allocation.** Event spawns write into pre-allocated attributes; per-frame
  work is reading params/meters and setting a handful of uniforms.
- **A visual can never break the audio.** Listener and meter errors are swallowed at the
  seam; the audio scheduler must not observe the visual layer at all.

## Enablement — two layers, one resolver

Effect visuals are decoration over the audio truth, so they must be cheap to turn down and
possible to turn off. Two layers, resolved in one place:

1. **Automatic (ships first): the graphics preset drives quality.** The scene already
   resolves a low/mid/high preset (`src/config/performance.js`, `?graphics=` override).
   Every group's tunables — pool sizes, echo copies, trail ghost counts, generated texture
   sizes, and whether a tier-1 layer mounts at all — derive from that preset. No layer reads
   the preset directly: one policy resolver maps preset → per-group settings, and layers
   receive their settings at mount.
2. **Manual (seam only, no UI yet): a future user preference.** The same resolver accepts a
   preference input — off/on overall, possibly per group; the shape is undecided — that
   gates mounting before quality is even considered. Until a real preference exists the
   input is a constant "everything on". A future settings surface only ever touches the
   resolver, never the layers.

Production entry criterion (met): the resolver is `src/visual/effectVisualPolicy.js` —
the automatic layer is wired (the app resolves on every profile change and hands the
bridges a live settings getter) and the manual layer is stubbed to "on". Layer bindings:
rack-effect groups mount through `src/visual/effectVisualsBridge.js` (slot lifecycle via
the adapter's `observeEffectSlots` seam), source-engine groups through their own bridge
(granular's `granularVisualBridge.js`).

## Group specs

| Group (families) | Canvas elements (summoned if absent) | Binding | Tier | Meter |
|---|---|---|---|---|
| Texture — granular | dedicated accretion-disk layer | grain spawn events + merged params | 1 | no (engine events) |
| Echoes — feedback/ping-pong delay | moons | delay time → orbit distance; measured wet per stereo side → per-side blink intensity; feedback audible in the decaying blinks | 0 | yes, wet per side |
| Space/air — reverbs | cloud shell + soft glow | wet/decay → shell density and size; measured wet tail → glow breath (lingers after the dry stops) | 0 | yes, wet |
| Motion-wobble — chorus, phaser, tremolo, vibrato | rings, body | rate → sway frequency, depth → amplitude; leaves-in-wind behaviour; phaser accent → a bright band sweeping the ring at the rate | 0 | no (state) |
| Brightness — filters, wah, EQ | body material | cutoff → dawn/dusk terminator; closed = dimmed to silhouette, open = bloom | 0 | no (state) |
| Grit — distortion, bitcrusher, chebyshev | the voice's whole FRAME (a post pass) | drive → the picture goes lo-fi: pixelate + colour reduction + ordered (Bayer) dither. The dirt crushes the IMAGE, not a surface — the world is not weathered, it is badly reproduced. Pass-through at zero drive; one render target and one full-screen pass, mounted only while a grit module is enabled | 1 | no (state) |
| Position — panners, widener | body/rings transform | pan → lateral lean (phototropism); width → the ring splits into a ghostly stereo pair drifting apart | 0 | no (state) |
| Pitch — pitch/frequency shifters | body/disk hue | shift down → redshift, up → blueshift | 0 | no (state) |
| Time — varispeed, stretch | trail ghosts along the moons' paths | star trails (long exposure): slowing below 1× smears the moons into fading trails — time changes how motion is *seen*, never the motion itself; crisp at and above 1× | 0 | no (state) |

**Motion restraint (learned from the time prototype):** rotation and orbital speed are not
available as visual channels — the worlds already orbit and the camera already moves, so
speeding or reversing that motion overloads the one channel the scene uses constantly.
Sway (wobble) passes because it is a small oscillation on top, not a change to the flow.

## Adding or changing a group

Declare in this table: the group's families, its canvas elements (and what the summoned
stand-in looks like when the world lacks them), the param/event → visual bindings, the cost
tier, and whether it needs a meter. Prototype in `/fx-harness` first — the harness stage
exposes the same canvas elements the orbiter scene owns, plus toggles that switch each
element between the world's own and the summoned stand-in. A production layer must be the same module the harness renders
(no parallel implementations).
