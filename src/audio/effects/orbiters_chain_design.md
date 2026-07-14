Master Audio Chain (Deck I)

Player (Tone.Player or HTMLMediaElement)
    ↓
normalizationGain (input gain from backend metadata playbackGainDb)
    ↓
Effects Processing Chains
    ↓

decks
 ├── deck-i
 │    └── Effects Chains
 │         ├── EW:I
 │         │     └── [x → module A xParam → module B xParam]
 │         │            ↓
 │         │         [y → module A yParam → module B yParam]
 │         │            ↓
 │         │         [z → module A zParam → module B zParam]
 │         │            ↓
 │         ├── EW:II
 │         │     └── [x → module A xParam → module B xParam]
 │         │            ↓
 │         │         [y → module A yParam → module B yParam]
 │         │            ↓
 │         │         [z → module A zParam → module B zParam]
 │         │            ↓
 │         └── EW:III
 │               └── [x → module A xParam → module B xParam]
 │                      ↓
 │                   [y → module A yParam → module B yParam]
 │                      ↓
 │                   [z → module A zParam → module B zParam]
 │         ↓
 │    bodyLevelGain (master fader: -60 to +6 dB)
 │         ↓
 │    masterGain (output stage)
 │         ↓
 │    limiter (Tone.Limiter, -1 dB ceiling)
 │         ↓
 │    masterMeter + Tone.Destination → premix-deck-i
 │
 ├── deck-ii
 │    └── player
 │         ├── EW:I
 │         │     └── [x → module A xParam → module B xParam]
 │         │            ↓
 │         │         [y → module A yParam → module B yParam]
 │         │            ↓
 │         │         [z → module A zParam → module B zParam]
 │         │            ↓
 │         ├── EW:II
 │         │     └── [x → module A xParam → module B xParam]
 │         │            ↓
 │         │         [y → module A yParam → module B yParam]
 │         │            ↓
 │         │         [z → module A zParam → module B zParam]
 │         │            ↓
 │         └── EW:III
 │               └── [x → module A xParam → module B xParam]
 │                      ↓
 │                   [y → module A yParam → module B yParam]
 │                      ↓
 │                   [z → module A zParam → module B zParam] → premix-deck-ii
 │
 └── send-i
      ├── MOON:I
      │     └── [x → module A xParam → module B xParam]
      │            ↓
      │         [y → module A yParam → module B yParam]
      │            ↓
      │         [z → module A zParam → module B zParam]
      │            ↓
      ├── MOON:II
      │     └── [x → module A xParam → module B xParam]
      │            ↓
      │         [y → module A yParam → module B yParam]
      │            ↓
      │         [z → module A zParam → module B zParam]
      │            ↓
      └── MOON:III
            └── [x → module A xParam → module B xParam]
                   ↓
                [y → module A yParam → module B yParam]
                   ↓
                [z → module A zParam → module B zParam] → premix-deck-iii


⸻

Mixer stage

main

 ├── PREMIX-DECK-I
 │     └── [x → module A xParam → module B xParam]
 │            ↓
 │         [y → module A yParam → module B yParam]
 │            ↓
 │         [z → module A zParam → module B zParam]
 │            ↓
 ├── PREMIX-DECK-II
 │     └── [x → module A xParam → module B xParam]
 │            ↓
 │         [y → module A yParam → module B yParam]
 │            ↓
 │         [z → module A zParam → module B zParam]
 │            ↓
 └── PREMIX-DECK-III
       └── [x → module A xParam → module B xParam]
              ↓
           [y → module A yParam → module B yParam]
              ↓
           [z → module A zParam → module B zParam]
      ↓
 Master Controller (blend A, B, C)
      ↓
 → mix (final output)


⸻



UI Knob (-180° to +180°)
    ↓
ParameterManager (stores rotation value by dimension)
    ↓
AudioEngineAdapter (routes to correct rack)
    ↓
EffectsRack (finds active module)
    ↓
MappingManager (converts rotation → sonic parameters)
    ↓
Tone.js Effect (with smoothing to avoid artifacts)


⸻


## Master Audio Chain Architecture

### Complete Signal Flow

```
Player (Tone.Player or HTMLMediaElement)
    ↓
normalizationGain (input gain - applies backend playbackGainDb)
    ↓
Effects Processing (x, y, z dimension chains)
    ↓
bodyLevelGain (master fader: -60 to +6 dB range)
    ↓
masterGain (output stage, unity gain)
    ↓
limiter (Tone.Limiter, -1 dB ceiling)
    ↓
masterMeter (monitoring) + Tone.Destination (speakers)
```

### Component Details

**normalizationGain** (Input Gain)
- Applied BEFORE all effects processing
- Uses `playbackGainDb` from backend audio analysis metadata
- Converts dB to linear gain: `gainLinear = Tone.dbToGain(gainDb)`
- Default: 0 dB (unity gain) if metadata not available
- Safety clamping: respects `maxAllowableGainDb` from backend
- Purpose: Ensures consistent perceived loudness across different tracks

**bodyLevelGain** (Master Fader)
- User-controlled master volume fader
- Range: -60 dB to +6 dB
- Positioned AFTER effects processing
- Acts as final level control before output protection

**Per-stage input headroom** (`STAGE_HEADROOM_DB = -1 dB`)
- Applied at the **input** of each dimension stage (EW::I/II/III `inputGain`), not at the output.
- The orbiter runs 3 dimension stages in series. The original -6 dB sat at each stage's deck
  channel (end-of-stage): it over-attenuated (3 × -6 = -18 dB) AND gave each stage's processors
  no input headroom, so they could clip internally before being pulled down.
- Cutting -1 dB at each stage input instead gives every processor progressive headroom
  (dim 1 sees -1, dim 2 -2, dim 3 -3) and distributes the deck headroom across the chain
  rather than lumping it at the output.
- A small -0.5 dB final trim at masterGain (`OUTPUT_HEADROOM_DB`) tops it off → ≈ 3 dB total.
- With a -6 dBFS reference: no-gain output ≈ -9 dBFS, max premix (+6 dB) ≈ -3 dBFS (verified
  with offline pink-noise RMS + LUFS analysis).

**masterGain** (Output Stage + final trim)
- Applies the -0.5 dB `OUTPUT_HEADROOM_DB` final global trim; also the consistent connection point.

**limiter** (Output Protection)
- Tone.Limiter with -1 dB ceiling
- Positioned AFTER master fader (critical for safety)
- Prevents clipping even when master fader is at +6 dB
- Protects against inter-sample peaks in DAC
- Transparent under normal operation, only engages when signal exceeds -1 dBFS

### Architecture Rationale

**Why normalizationGain Before Effects?**
- Effects receive consistent input levels regardless of source loudness
- Matches standard audio engineering practice
- User's master fader retains expected behavior as final level control
- Prevents effects from being starved or overdriven by varying source levels

**Why Limiter After Master Fader?**
- Master fader has +6 dB headroom, which could cause clipping
- If limiter were before master fader, the +6 dB boost would bypass protection
- Limiter must be the final safety net after ALL gain stages
- Provides transparent protection without affecting normal operation
- -1 dB ceiling leaves safety margin for inter-sample peaks

**Connection Flow**

*Without Effects:*
```
Player → normalizationGain → bodyLevelGain → masterGain → limiter → output
```

*With Effects (typical):*
```
Player → normalizationGain → [EW:I x,y,z] → [EW:II x,y,z] → [EW:III x,y,z] → bodyLevelGain → masterGain → limiter → output
```

### Multi-orbiter shared master (decision 0001)

The chain above is **per orbiter voice**. For views that show several orbiters at once (hybrid/mixed
collection, feed), all orbiters run in **one iframe** sharing **one `AudioContext`**, and the terminal
output is shared instead of N voices each hitting `Tone.Destination`:

```
voice₁ … → masterGain ╲
voice₂ … → masterGain ──▶ MultiOrbiterAudioHost: masterBus(sum) → limiter(-1 dB) → Tone.Destination
voiceₙ … → masterGain ╱
```

- `MultiOrbiterAudioHost` (`src/audio/MultiOrbiterAudioHost.js`) owns the **single** master bus + the
  **single** limiter on the **summed** mix — so N voices can't clip together, with **one** limiter, not N.
  It also owns the **voice registry** (`src/voice/VoiceRegistry.js`) — the single source of which orbiter
  voices exist and which is focused (the de-singletonization keystone) — so the host is the one owner of a multi-orbiter
  view (audio + voices).
- Each voice is constructed with `outputNode = host.getInputNode()`. Seeing an injected output,
  `AudioEngineAdapter._connectTerminalOutput()` mixes `masterGain` straight into the shared bus and
  builds **no per-voice limiter** (its `masterMeter` taps `masterGain` for the voice's own level).
- The per-voice `masterGain` still applies the `OUTPUT_HEADROOM_DB` trim, so the shared master is a pure
  unity sum + ceiling (no double trim).
- Tempo/transport are **not** shared by this host — per-voice transport stays independent-by-default,
  synced-on-demand via the shared clock. The host is audio-routing only.

Single-orbiter views never use the host: that adapter owns its own terminal limiter → `Tone.Destination`,
exactly as documented above.

### Implementation Notes

- Connections are dynamic, managed by `_rewireGlobalChain()`
- Nodes are disconnected and reconnected when effects chains change
- normalizationGain value is set once during initialization via `_applyNormalizationGain()`
- The per-voice limiter is always present in the **single-orbiter** chain (output safety) — the **one**
  exception is multi-orbiter mode, where limiting moves to the shared `MultiOrbiterAudioHost` (above).
- All nodes use `enforceStereo()` (shared helper in `src/audio/audioNodeUtils.js`) for stereo processing

