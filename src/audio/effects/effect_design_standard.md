# Effect Design Standard (EDS)

A common structure for building effects that go into the rack.  
This standard ensures consistency, clarity, and supports versioning for future evolution.

How an effect's state and events become *visible* is governed by the companion
`src/visual/visual_design_standard.md` — the fixed, engine-level sound→visual vocabulary.

When we control audio parameters directly from the user interface — for example, by updating them every frame from knobs, MIDI, or sensors — we create sudden jumps in the signal. These fast value changes happen at the control rate of JavaScript, not at the audio sample rate, and the result is audible clicks or “zipper noise.” To avoid this, we need to move as much control as possible into the audio domain, using continuous signals (Tone.Signal, AudioParam, or rampTo functions) that run at audio rate. This keeps modulation smooth, eliminates artifacts, and makes the sound engine behave more like professional audio environments such as Max/MSP or Pure Data.

**Neutral control / bypass convention**
- Rack inputs are always normalised to `[0,1]` and conceptually mapped to a ±180° encoder.
- `0.0 → 0.5` represents the negative rotation (segment A), `0.5 → 1.0` the positive rotation (segment B). Each segment maps independently between the three anchors declared in the module’s `valueRange`: `min → equilibrium → max`.
- `equilibrium` MUST reflect the true neutral/bypass point for the module. We never shift it away from 0 just to satisfy numeric ranges; instead the mapper handles out-of-band equilibria and clamps appropriately.
- A normalised value of `0` = full bypass. Effects should set whatever primary param (often `wet`) to zero and leave secondary params untouched so they can re-engage seamlessly once the knob leaves 0.
- When we later add per-segment curves or even different parameter targets per direction, we do so in the mapping layer (piecewise curves, negative vs positive mappings) rather than altering manifests to fake the equilibrium.

	1.	UI ≠ Audio.
The UI (knobs, MIDI, sensors) updates a value for display, but it does NOT write directly into the effect parameter every frame.
	2.	If the target parameter is an audio parameter (AudioParam):
  2.	If the target parameter is an audio parameter:
We smooth at audio rate based on the parameter domain:
  - Log-domain (e.g., frequency; when `control.signalRange.transform === 'log'`): schedule directly on the AudioParam using `exponentialRampToValueAtTime` (clamped to > 0).
  - Linear-domain: drive via a `Tone.Signal` and `rampTo()`.
Both approaches run at audio rate and avoid zipper noise.
	3.	If the target is NOT an audio parameter:
We do NOT try to modulate it live. We only change it on big events (preset change, mode change), or we control a nearby thing that IS an AudioParam (like wet, gain, filter) instead. When a secondary parameter absolutely must follow UI data (e.g., mapping a single knob to both `wet` and `decay`), we throttle the updates: queue the latest normalized value, flush it on a coarse cadence (≈60–100 ms), and recompute heavy assets (IRs, buffers) only after the throttled write completes.

---

## 1. Core Principles

- **Declarative first**: effects and modules are described as data (manifests), not hard-coded logic.  
- **Single input param** per effect instance (rack-mapped), explicitly named (`inputParam`) and mapped to a Tone property (e.g., `frequency`, `gain`, `pan`).  
- **Preset-like modules**: each module = fixed params + a small set of exposed user params.  
- **Deterministic construction**: `EFFECT_DEFAULTS` → `settings` (instance overrides) → module `fixed`.  
- **Versioned manifests**: every effect carries a `version` (semver), enabling migrations and parallel versions.  
- **UI ≠ audio**: UI/MIDI/sensor updates set targets; audio-rate smoothing nodes (Tone.Signal / AudioParam) perform the actual modulation to avoid zipper noise.  

---

## 2. File Layout (per effect)

```
effects/<effect-id>/
  v1/
    manifest.js           // EFFECT_MANIFEST: id, label, version (1.x.x), defaults, modules schema
    factory.js            // createEffect() using manifest + Tone
    index.js              // exports <effectId>EffectDefinition for v1
  v2/                     // only if a breaking major ships and v1 must stay compatible
    manifest.js
    factory.js
    index.js
  latest.js               // re-export the active major (e.g., from v1/index.js or v2/index.js)
  validators.js           // optional runtime checks
```

---

## 3. Effect Manifest

Declarative “what”, no logic.

```js
// effects/<effect-id>/manifest.js
export const EFFECT_MANIFEST = Object.freeze({
  id: 'your.effect.id',
  label: 'Your Effect',
  version: '1.0.0',
  inputParam: 'inputParam',
  dimensionId: 'EW::I',
  dimensionLabel: 'EW::I',
  defaults: Object.freeze({
    // effect defaults here
  }),
  userParamSpec: Object.freeze({
    id: 'inputParam',
    label: 'Control',
    units: '%',
    range: Object.freeze({ min: 0, max: 100 }),
  }),
  modules: Object.freeze([
    Object.freeze({
      id: 'module-a',
      label: 'Variant A',
      description: 'User-facing description',
      dimension: 'EW::I',
      // Fixed params applied on configure()
      fixed: Object.freeze({ /* tone params applied once */ }),

      // UI hard limits for the rack control
      valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),

      // Starting values inside the allowed range
      initialRange: Object.freeze({ min: 10, max: 80, equilibrium: 50 }),

      // NEW: Parameter mappings (UI value → Tone param ranges)
      // Map the single rack input (userParamSpec range) to one or more Tone.js parameters.
      // Linear mapping is applied: normalized = (v - valueRange.min) / (valueRange.max - valueRange.min)
      // paramValue = min + (max - min) * normalized
      parameterMappings: Object.freeze({
        someParam: { min: 0, max: 1 },
        anotherParam: { min: 20, max: 20000 },
      }),

      // NEW: Control metadata describing how the rack may modulate this module.
      control: Object.freeze({
        mode: 'audio-param',               // 'audio-param' | 'hybrid' | 'discrete'
        audioParam: 'nodePath.toParam',    // path resolved by the factory or provided externally
        provider: 'node',                  // 'node' (default) | 'playbackController' | custom source
        smoothing: Object.freeze({
          defaultRamp: 0.05,               // seconds for rampTo()
          minRamp: 0.005,
          maxRamp: 1,
          curve: 'linear',                 // future extension
        }),
        signalRange: Object.freeze({       // optional: hints for normalization or Tone.Signal range
          min: 0,
          max: 1,
          transform: 'linear',             // future: 'log', 'exponential'
        }),
        secondaryParameters: Object.freeze([
          // optional list of non-audio params updated only on coarse events
          'decay',
          'preDelay',
        ]),
      }),

      // NEW: Engine capability requirement for playback backend selection.
      // - 'stream-safe': module is expected to run correctly in streaming mode.
      // - 'prebuffer-required': module requires prebuffer backend (e.g. true reverse playback).
      engineRequirement: 'stream-safe',

      // Legacy (optional): if present, still supported by the rack mapping manager
      // mappings: [...]
    }),
  ]),
});
```

Notes:
- valueRange defines UI hard limits.
- initialRange defines the starting state within valueRange.
- parameterMappings maps the single rack input to one or many Tone parameters.
- control metadata defines whether the rack can drive the module at audio rate, which path exposes an AudioParam, and what smoothing envelopes to apply.  
  - `audio-param`: Tone.Signal is connected to an AudioParam or property with a `.value`.  
  - `hybrid`: continuous control for the primary audio param, but secondary properties update only on high-level events.  
  - `discrete`: manual changes only (preset switches, mode toggles).
- `engineRequirement` defines the minimum playback backend capability per module:
  - `stream-safe`: module supports streaming playback backend.
  - `prebuffer-required`: module requires prebuffer backend and must not trigger live backend swap while playing.
- Current factories implement linear mapping. Curves can be added later if needed.

---

## 4. Factory

Imperative “how”, minimal:

- Build node with defaults + overrides
- Wrap modules with:
  - configure() → apply fixed
  - applyValue(v) → compute normalized v from module.valueRange and write to all parameterMappings targets:
    - normalized = (v - valueRange.min) / (valueRange.max - valueRange.min)
    - mapped = min + (max - min) * normalized
    - setToneValue(node, target, mapped)
- Honor `control` metadata:
  - expose `getTargetParam()` so the rack can attach Tone.Signal or AudioParam automation.
  - avoid direct `.value =` writes inside animation loops; rely on the smoothing layer instead.
  - apply secondary parameters (non-audio) inside `configure()` or on coarse events only.

---

## 5. Versioning & Up-Versioning (developer rules)

- Each manifest has a **semver** `version`.
  - `PATCH`: bug fix
  - `MINOR`: additive, backward-compatible
  - `MAJOR`: breaking changes
- Storage: persist `effectVersion` with every module payload.
- Loader behavior (current runtime):
  - Tries the requested version; if missing but the same major is active, falls back to the active patch.
  - Emits `compat.upgradedFromVersion` when a patch fallback happens.
  - Emits `compat.missingEffect` if the id/version is not registered; `compat.missingModuleId` if the module id is not in the manifest.
- Shipping a change:
  - **Patch/Minor (non-breaking):** bump `version` inside `v1/manifest.js`; optionally add `migrateToActive(payload)` to rewrite old patch payloads; keep `latest.js` pointing to `v1/`.
  - **Breaking Major:** add `v2/` (manifest/factory/index), point `latest.js` to `v2/`, and either migrate payloads forward or keep `v1/` as compat for old data. No down-convert.
- Registry wiring:
  - `effects/index.js` imports from `./<effectId>/latest.js` (one active definition per effect id).
  - If you add a compat major, register both and let the loader pick by requested version; new saves write the active major version.

### Authoring deprecation

Version compatibility and authoring visibility are separate concerns.
An effect may remain fully loadable for old saved orbiters while being hidden from new authoring flows.

Use this when an effect:
- is too expensive for current performance targets
- has been superseded by a better implementation
- should remain supported only for legacy content

Implementation rule:
- Keep the same effect `id` and runtime registration so old payloads still resolve.
- Mark the effect definition exported from `effects/<effect-id>/vN/index.js` with authoring metadata:

```js
export const someEffectDefinition = {
  id: EFFECT_MANIFEST.id,
  label: EFFECT_MANIFEST.label,
  version: EFFECT_MANIFEST.version,
  inputParam: EFFECT_MANIFEST.inputParam,
  authoring: {
    deprecated: true,
    legacyLabel: 'Legacy',
  },
  manifest: EFFECT_MANIFEST,
  create: createSomeEffect,
};
```

Required behavior:
- Deprecated effects MUST still load at runtime for existing artifacts.
- Deprecated effects MUST NOT appear in new authoring pickers or empty-slot module lists.
- If an old orbiter already uses a deprecated effect, the editor MAY show that exact selected module as a legacy option so the artifact remains editable without losing state.
- Deprecation does NOT require a new major version by itself. Only breaking runtime/schema changes require a new major.

Practical rule:
- Use versioning for runtime compatibility.
- Use `authoring.deprecated` for lifecycle/UI visibility.

---

## 6. Input Mapping (Rack → Effect)

Standard: parameterMappings

```ts
// Per-module parameterMappings
type ParameterMappings = {
  [toneParam: string]: {
    min: number; // target param min
    max: number; // target param max
    // future: curve?: 'linear' | 'exp' | 'log' | 'sigmoid' | 'expHz';
    // future: clamp?: boolean;
  };
};
```

Runtime behavior
1. Normalize rack input to module.valueRange.
2. For each parameterMappings entry:
   - mapped = min + (max - min) * normalized
   - Hand the mapped value to the smoothing layer when `control.mode !== 'discrete'`.
   - Otherwise write into the Tone node property (node[param] or node[param].value) sparingly.
3. Fixed params are applied once in configure().

Legacy mappings
- The older mappings[] with inputRange/outputRange/curve is still compatible with the rack mapping manager but is superseded by parameterMappings in factories.

---

## 7. Defaults Precedence

1. `manifest.defaults`
2. `settings` (instance overrides)
3. `module.fixed` on `configure()`
4. `applyValue()` resolves `mappings[]` (one-to-many) for rack input

---

## 8. Validation (Optional)

- Check manifests with a minimal schema.  
- Validate ranges, required keys, and `mappings`.

---

## 9. API Contract

Every effect must export:

```ts
type EffectDefinition = {
  id: string;
  label: string;
  version: string;
  inputParam: string;
  create({ Tone, settings? }): {
    id: string;
    label: string;
    version: string;
    inputParam: string;
    node: Tone.AudioNode;
    modules: Module[];
    configureModule(moduleId: string): void;
    dispose(): void;
    // Module should include a declarative `mappings?: MappingSpec[]`
  }
}
```

Module members beyond `id`/`label`/`applyValue` are **optional** — the rack and the
mapping manager treat a missing member as neutral (no mappings, no automation target,
nothing to configure). Declare only real behavior; never ship no-op stubs to
"complete" the surface.

---

## 10. Examples (Updated)

### Freeverb (current)
```js
parameterMappings: Object.freeze({
  wet: { min: 0, max: 0.8 },
  dampening: { min: 8000, max: 1000 }, // inverted by choosing min>max if desired
}),
valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),
initialRange: Object.freeze({ min: 10, max: 60, equilibrium: 0 }),
```

### Ping Pong Delay (current)
```js
parameterMappings: Object.freeze({
  wet: { min: 0, max: 1 },
  feedback: { min: 0, max: 0.5 },
}),
valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),
initialRange: Object.freeze({ min: 20, max: 80, equilibrium: 50 }),
```

### Reverb (current)
```js
parameterMappings: Object.freeze({
  wet: { min: 0, max: 1 },
  // If desired, different modules can add:
  // decay: { min: 0.2, max: 0.8 },
  // preDelay: { min: 0.0, max: 0.01 },
}),
valueRange: Object.freeze({ min: 0, max: 100, units: '%' }),
initialRange: Object.freeze({ min: 10, max: 60, equilibrium: 30 }),
```

### Filter (recommended shape)
```js
// Current codebase uses target: 'frequency'. Recommended to migrate to:
parameterMappings: Object.freeze({
  frequency: { min: 20, max: 20000 },
  // Optionally:
  // Q: { min: 0.5, max: 12 },
  // gain: { min: -6, max: 6 },
}),
valueRange: Object.freeze({ min: 20, max: 20000, units: 'Hz' }),
initialRange: Object.freeze({ min: 20, max: 8000, equilibrium: 20000 }),
```

Consistency checklist (as of latest changes)
- Freeverb: uses parameterMappings (wet, dampening), valueRange 0–100%, initialRange set. OK.
- PingPongDelay: uses parameterMappings (wet, feedback), valueRange 0–100%, initialRange set. OK.
- Reverb: uses parameterMappings (wet), valueRange 0–100%, initialRange set. OK.
- Filter: currently uses target with Hz domain. Migrating to parameterMappings is recommended for full consistency.
