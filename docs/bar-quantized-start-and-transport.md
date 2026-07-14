# Bar-quantized playback start and load-time tempo/rate relationship

Status: planning (revised after review) — **ship-today slice scoped at top**
Owner: audio/sync
Scope: orbiters client (Connect backend changes not required)

## Today slice (ship first, no architecture)

This section defines the minimum we ship in the current session. Everything below the `---` is planning context and longer-term options; the today slice is bounded to exactly this:

**In scope today**

- Session-bar quantization only (align start to the shared session downbeat).
- Hardcoded 4/4. `BEATS_PER_BAR = 4`.
- Feature-flagged via `window.__orbitersQuantizeStart === true` (or equivalent toggle) — **off by default** until we've tested on mobile.
- Scheduling lives in `AudioEngineAdapter.play()` as temporary adapter-level orchestration. This is explicitly acknowledged as *not* the final home (see `transport-musical-timing-review.md`) — it must be folded into `MusicalTimeModel` once that lands.
- Both backends delayed via **one** adapter-level `setTimeout`. Do not combine it with `earliestStartTime` for Player on today's slice (double delay). Sample-accurate Player scheduling is deferred to the model-driven follow-up (step 5 in sequencing).
- Single pending handle: `AudioEngineAdapter._pendingQuantizedStart = { timer, canceled }`. Cancel on: user stop, user pause, new play call, track change, sync disable.
- Firing order and fallback go through a single helper `startTransportAndPlayback()` used by both the delayed path and the rejection-fallback path, preserving the current `transport.start()` → `playback.triggerPlay()` order (AudioEngineAdapter.js:724). If `triggerPlay()` rejects, stop the transport to avoid leaving it running without audio.
- `pause()` and `stop()` must cancel a pending quantized start **before** their existing "not playing" early returns (AudioEngineAdapter.js:735). A pending start is logically "not playing" yet still user-visible.
- Debug logs gated on `window.__orbitersDebugSync === true`.

**Explicitly out of scope today**

- `MusicalTimeModel` / conversion refactor (full review is in `transport-musical-timing-review.md`).
- Musical-time loop persistence.
- Time-signature plumbing (non-4/4).
- `WrapGridState.computeAlignedSourcePositionMs({ beatOverride })` API change — for today, re-align once at fire time (option "re-align at fire time" below) instead of extending the API.
- Sub-10ms start alignment on streaming. Bar-level alignment (tens of ms) is acceptable.
- Part B (load-time rate reset) — **defer** unless you can reproduce stale rate at first play on today's build. Don't drift into tempoPitch architecture work under a ship-today clock.
- Bar-quantized stop / pause / seek. Only `play` quantizes.

**Mobile streaming fallback (required for ship)**

`setTimeout` + `audio.play()` on mobile can fail if the user-gesture transient activation window has expired by the time the delay elapses. The today slice must handle this:

```
const startTransportAndPlayback = async () => {
  // Preserves current order: transport first, playback after (AudioEngineAdapter.js:724).
  transport.start();
  try {
    await playback.triggerPlay();
  } catch (err) {
    // Don't leave transport running without audio.
    try { transport.stop(); } catch {}
    throw err;
  }
};

const firePending = async () => {
  if (canceled) return;
  try {
    await startTransportAndPlayback();
  } catch (err) {
    // Transient activation likely lost (mobile). Clear pending and try once immediately.
    if (window.__orbitersDebugSync) console.warn('[quantize] delayed play() rejected, retrying immediately', err);
    this._pendingQuantizedStart = null;
    try {
      await startTransportAndPlayback();
    } catch (err2) {
      // Hard fail — surface as recoverable play error, transport already stopped above.
      this._emitPlayError?.(err2);
    }
  }
};
```

Keep the flag off on mobile initially if we can't exercise this path end-to-end today. Better to ship the desktop win and enable mobile in a follow-up than to regress mobile playback.

**Pending-start cancellation contract**

One field on the adapter. Any state transition that invalidates the pending start must clear the timer and mark canceled. Transitions to cover:

- `adapter.pause()` / `adapter.stop()` — cancel, do not start.
- `adapter.play(...)` called again before the pending fires — cancel previous, compute fresh.
- Track change — cancel.
- `syncCoordinator` disabled (receiver drops sync) — cancel and fall through to immediate play, or keep not-playing, TBD on the UX call during implementation.
- Dimension change that removes the tempo target for the active axis — cancel.

**Ownership note (today only)**

The today-slice orchestration temporarily reads the shared timeline (`syncCoordinator.getCurrentBeat`), computes a delay in ms, and fires `triggerPlay` + `transport.start`. This is three responsibilities in `AudioEngineAdapter.play()` that properly belong in the future `MusicalTimeModel` + a small scheduler. We accept the violation for the sake of shipping today. The review doc records this so we don't forget to delete it.

**Acceptance for today**

1. Two orbiters on the same session, sync enabled, flag on — pressing play on either lands the audio start within one shared bar of the first beat of the next bar, measured against `syncCoordinator.getCurrentBeat` at onset.
2. Flag off → exact existing behavior, no regressions.
3. Mobile streaming with flag on → either works or cleanly falls back to immediate play with a console warning; no stuck transport.
4. No second rate owner introduced (no changes to tempoPitch effect today).

---

## Manual audio offset (per-device latency calibration) — shipped

**What it is.** A single per-device number, in milliseconds, that shifts *when this device's audio
leaves the speaker* relative to the shared beat grid. A **positive** offset fires this device's
audio **earlier**; a negative offset fires it later. Default is `0` (no shift). It is a per-**device**
value (all voices/orbiters on the device share it), not per-track or per-session.

**Where it lives / how it is applied.** The value is owned by `src/config/audioOffset.js`
(`getManualAudioOffsetMs()` / `setManualAudioOffsetMs()`), resolved once per load in this order:
`?audioOffset=<ms>` URL param → `localStorage['audioOffsetMs']` → `0`, clamped to ±500 ms.

It is applied as a **playhead lead**, not a fire-time shift. `AudioEngineAdapter._alignWrapPlaybackPosition`
passes the offset as `outputLeadMs` into `WrapGridState.computeAlignedSourcePositionMs`, which advances
the aligned **source read-head** by `outputLeadMs × rate` (wall-ms → source-seconds via the sync
playback rate `baseRate = sessionBpm/trackBpm`). Playing a position slightly *ahead* of where the beat
grid says means that content leaves the speaker that many ms **earlier** — exactly the output-latency
compensation we want. A positive offset leads; a negative offset lags; `0` (default) leaves the aligned
position byte-identical.

Why here and not the start delay: the quantized start (and every periodic correction) re-derives the
playhead from the **live** shared beat at fire time (`_alignWrapPlaybackPosition` →
`computeAlignedSourcePositionMs` reads `getCurrentSyncBeat()`). Shifting only the *fire time* earlier
would be immediately cancelled by that re-alignment (the earlier fire reads an earlier beat → an earlier
source position → net zero — verified). Applying the offset at the **one owner of the beat→playhead
mapping** (`WrapGridState.leadSourcePositionMs`) makes it survive re-alignment. The **seek** path does
not go through the aligned start, so it applies the same lead directly
(`AudioEngineAdapter._leadSeekPositionMs` → the same `leadSourcePositionMs`), or a seek during a synced
session would silently drop the compensation. This all only runs while sync is enabled, which is exactly
when the offset matters (cross-device); solo, the shift is inaudible, so the offset is a no-op there by
construction.

**Known limitations (acceptable for a by-ear coarse calibration; revisit if they bite):**

- *Rate scaling.* Wall-ms → source scales by `baseRate` (`sessionBpm/trackBpm`), the rate for a voice
  with no speed-control effect. If a `tempoPitch` effect owns the actual playback rate (or a wrap-off
  voice plays at rate 1 while synced), the achieved lead is mis-scaled by `baseRate/actualRate`. A
  *static* mismatch is absorbed into the number the user dials by ear; a rate change *mid-session* can
  shift the acoustic alignment, so re-tune after engaging/adjusting a tempo effect.
- *Visible playhead.* The lead is written into the real player position, so the waveform playhead sits
  `offset × rate` (~tens–hundreds of ms) ahead of the grid line. Acoustically intended; only a small
  visual discrepancy.
- *Negative offset at a cold non-looping start.* A negative offset near source 0 wraps toward the track
  tail (Euclidean wrap). Output latency is always positive, so a negative by-ear value is unusual; for
  looping tracks it is correct (it plays the material just before the downbeat).

**Why it exists.** A device's true acoustic output latency — the gap between scheduling a sound and
it actually leaving the speaker — **cannot be reliably measured or inferred automatically in this
flow.** `AudioContext.outputLatency` is non-standard (absent on e.g. Safari) and, where present,
under-reports on some platforms: iOS has been observed reporting ~12.6 ms when a microphone measured
~125 ms. Bluetooth speakers/headphones add another 150–300 ms that nothing in the browser exposes.
There is no automatic signal we can trust, so we give the user a manual escape hatch instead of
pretending to auto-compensate.

**When to use it.** Only when playing a **shared/synced session across two or more devices** and
they sound out of step even though they are on the same beat grid. On a single device, or for one
device in isolation, the offset just shifts that device's own audio uniformly — inaudible — so there
is nothing to tune. Reach for it when device B's speaker is audibly *behind* device A's: give B a
positive offset so it fires earlier and catches up.

**How to tune it by ear.** Put both devices side by side playing the same session. On the device
that sounds **late**, nudge its offset **up** (fire earlier) a few ms at a time and listen until the
two devices' onsets collapse into a single hit — dial until they line up acoustically. It is a
one-time, per-device calibration: once dialed in, persist it (it is saved to `localStorage`
automatically, or bookmark the device's URL with `?audioOffset=<ms>`). During tuning without a built
control, use the console handle installed at boot:

```
orbitersAudioOffset.set(90)   // fire 90 ms earlier on this device (persisted)
orbitersAudioOffset.get()     // read the current offset (ms)
```

This mirrors the SYNC clock/killgate reference control (`src/clock-killgate/*`), whose copy reads:
*"Manual audio offset (ms) — fires this device's clicks earlier — dial until two devices line up
acoustically."*

## Metronome (per-device local monitor) — shipped

A device-level metronome click on the beat while playing, with an accent on the downbeat (per the meter,
below). It is a **local monitor**: it plays to the raw AudioContext destination (outside the Tone master
graph), and it is **muted while capture is recording** — screen/tab capture records the whole tab output,
so a routing trick can't hide the click; muting during a recording is the honest "not in the recording"
behavior. Owner: a single `metronome` instance (`src/audio/metronome.js`) — one per device, not per voice,
so a multi-orbiter realm never stacks clicks. Clock: the global `Tone.Transport` (the playback clock), so
the click is always in time with what this device hears; a small look-ahead pump arms each upcoming beat's
click on the audio clock. On/off is a per-device preference (`src/config/metronome.js`, `?metronome=1` /
`localStorage.metronomeEnabled` / `window.orbitersMetronome`). Verified live: clicks land on the beat
(0.5 s apart at 120 bpm) with the downbeat accent following the meter (4/4 → every 4, 3/4 → every 3).

## Meter / time signature (per-track) — shipped

The meter (4/4, 3/4, 6/8) is a **per-track** musical property, **saved and loaded exactly like the track
tempo** — through the same per-track `sync` settings (`PUT /me/users/configurations/track-settings/:id`, the
`trackUserSettingsPersistence` debounce, resolved on load with canonical → per-user precedence). Owner:
`SyncCoordinator` (`meter` getter + `setMeter`), seeded at `initSync` from `resolveTrackMeterFromTrackData`
(kept app-side, `src/sync/meter.js`, so no shared-package publish). Commit mirrors tempo:
`commitTrackMeterFromUi` → `syncCoordinator.setMeter` + `saveActiveTrackSyncSettings`.

The engine works in `sharedBeatsPerBar` = quarter-note beats per bar = numerator × 4 ÷ denominator (4/4 → 4,
3/4 → 3, 6/8 → 3), which drives the **metronome downbeat accent**. The meter does **not** yet drive the
launch/quantize bar — the launch grid is defined in 4/4 beats and can be sub-bar, so the two axes are kept
independent for now; coupling them cleanly needs the launch grid re-expressed in bars (follow-up).

All three controls live in the header sync-row `SyncSettingsMenu` (Settings2 icon → Popover), using the
design library: the offset arrow Slider + Param, a `Switch` for the metronome, and a `DropdownMenu` for the
meter.

## Motivation

Multi-orbiter sessions want two things the current transport does not give them:

1. **Bar-quantized start.** For tracks in 4/4, pressing play on any orbiter should delay the actual audio start until the next downbeat on the shared session timeline, so all orbiters fall in on bar 1.
2. **Deterministic rate on load.** When a new track loads, the session BPM, track BPM, and audio playback rate must be reconciled before the first `audio.play()` call.

This is a design note, not a spec. It captures what we have, what would change, and the open questions we want to resolve before writing code.

The **today slice** above narrows (1) to the minimum we can ship safely in one session; this rest-of-doc remains the longer-range planning context for (1) and (2).

## Current state (accurate)

- **Shared timeline.** `SyncCoordinator` (`src/sync/SyncCoordinator.js`) owns `{ bpm, epoch }` where `epoch` is a `performance.now()` timestamp at beat 0. `getCurrentBeat(now)` returns the current shared beat. This is our source of truth for cross-orbiter alignment. Note: this timeline is **not** mapped onto `Tone.Transport.position` or `Tone.Transport.seconds` — scheduling against Tone's transport does **not** give us shared-epoch quantization.
- **Transport.** `TransportController` (`src/audio/transport/index.js`) only handles BPM / start / stop / seek for `Tone.Transport`. It does not read from or project onto the shared timeline. `Tone.Transport.start()` anchors to wall-clock at the moment of the call.
- **Sync-aware alignment on play.** `AudioEngineAdapter.play()` already calls `await this._alignWrapPlaybackPosition({ force: true })` before `transport.start()` (AudioEngineAdapter.js:724). That in turn uses `WrapGridState.computeAlignedSourcePositionMs()` → `getSourceAudioTimeSec()` with `syncCoordinator.getCurrentBeat()` to snap the audio file position to "where the shared beat says we should be." So alignment **is** sync-aware today — the thing missing is deferring the actual `audio.play()` until a bar boundary.
- **Two playback backends.**
  - `PlayerPlayback` (Tone.Player, buffered) — `triggerPlay()` accepts `earliestStartTime` and schedules into `Tone.now() + lookAhead` space (`src/audio/playback/player.js:191`). Supports future-scheduled starts.
  - `StreamingPlayer` (`HTMLMediaElement`) — `triggerPlay()` calls `audio.play()` immediately (`src/audio/playback/streamingPlayer.js:649`). No scheduling API. Mobile typically uses this backend. This is the harder case.
- **Grid marker.** `WrapGridState` stores `gridMarkerTimeSec` (the source-time of the track's beat 1). Already present and used by alignment math.
- **Track BPM.** `resolveTrackBpmFromTrackData` resolves on load. `syncCoordinator.setTrackBpm(...)` fires `sync-bpm-change` which tempoPitch modules handle.
- **Tempo rate ownership.** `toneTempoPitch` (`src/audio/effects/toneTempoPitch/v1/factory.js`) is the single owner of playback rate when a tempo effect is configured; `_syncWrapPlaybackRate` in `AudioEngineAdapter` short-circuits when any tempo-managed target exists (`AudioEngineAdapter.js:1447`). **We must not introduce a second rate owner** — this is an existing project invariant.

## Proposed design

### Part A — Bar-quantized start

**Trigger.** `AudioEngineAdapter.play({ quantize: 'bar' | 'off' })`. Default: `'bar'` when `syncCoordinator.isEnabled && peerCount > 0`, otherwise `'off'`. UI provides a toggle.

**Ownership.** Scheduling lives in `AudioEngineAdapter.play()` (or a small helper adjacent to it), not in `TransportController` and not in `Tone.Transport.scheduleOnce`. Reason: the shared timeline lives in `performance.now()` space; `Tone.Transport` is a separate clock that is also not running until we call `transport.start()`. The cleanest primitive is a wall-clock delay.

**Scheduling math.** (v1 hardcodes 4/4.)

```
BEATS_PER_BAR   = 4
QUANTIZE_SLACK_MS = 40                              // minimum headroom before a scheduled start
nowPerf         = performance.now()
secondsPerBeat  = 60 / syncCoordinator.bpm
nowBeat         = syncCoordinator.getCurrentBeat(nowPerf)
nextBarBeat     = ceil((nowBeat + ε) / BEATS_PER_BAR) * BEATS_PER_BAR
delayMs         = (nextBarBeat - nowBeat) * secondsPerBeat * 1000
if (delayMs < QUANTIZE_SLACK_MS) delayMs += BEATS_PER_BAR * secondsPerBeat * 1000
targetStartPerf = nowPerf + delayMs
```

**Per-backend start.**

- `PlayerPlayback` (Tone.Player): convert `targetStartPerf` into a `Tone.now()`-relative time. `earliestStartTime = Tone.now() + delayMs/1000 + phaseCorrection` where `phaseCorrection` compensates for the offset between `performance.now()` and `Tone.now()` (both are monotonic clocks but not identical). Sample both at the start of the call:
  ```
  const perfNow = performance.now();
  const toneNow = Tone.now();
  const targetToneTime = toneNow + (targetStartPerf - perfNow) / 1000;
  ```
  Then `await this.playback.triggerPlay({ earliestStartTime: targetToneTime })`.
- `StreamingPlayer`: no scheduling API today. Two options:
  - **B1 — setTimeout.** Defer `audio.play()` by `delayMs` via `setTimeout`. Mobile `setTimeout` resolution is typically fine for bar-level alignment (tens of ms). Simplest.
  - **B2 — add a `StreamingPlayer.triggerPlay({ delayMs })` API** that uses `setTimeout` internally and cancels cleanly on pause/stop. Same mechanism, better encapsulation. Recommended.

  Either way, the streaming backend cannot line up to sub-10ms the way Tone's sample-accurate scheduling can. Acceptable for bar quantization.

**Position at start.** Today, alignment is computed once, before `transport.start()`, using `getCurrentBeat(now)`. With quantization, the beat advances during the delay, so alignment must be computed for the *target* beat, not the current one. Options:

- **Re-align at fire time.** In the scheduled callback (just before `audio.play()` / inside the Tone scheduler), call `_alignWrapPlaybackPosition({ force: true })` again with the target beat. Simplest; small double-work.
- **Pre-compute for target beat.** Extend `computeAlignedSourcePositionMs({ beatOverride })` so the adapter can ask "where would we be at beat X?" without walking through `syncCoordinator`. Cleaner; requires a small `WrapGridState` API change.

Recommendation: **pre-compute for target beat.** It keeps the scheduling path free of async re-alignment and makes the math explicit.

**What "beat" to quantize to.** Two interpretations:

- **A1 — Session bar only.** Start the audio on the next session downbeat. The track's own downbeat may land anywhere (depending on `gridMarkerTimeSec`). We honor that automatically via `computeAlignedSourcePositionMs`.
- **A2 — Session bar AND track bar.** Start when the session beat lines up with the track's bar grid. Requires considering `gridMarkerTimeSec` phase in the bar math.

Recommendation: **A1 for v1.** A2 matters only when the track BPM equals the session BPM and the user wants the track's bar 1 to fall on a session bar 1. Defer until requested.

**Cancellation.** Pending quantized starts must cancel on: user stop, user pause, track change, sync disable, dimension change that removes tempo targets. Track a single `_pendingQuantizedStart` handle in `AudioEngineAdapter` and clear it in each of those transitions.

### Part B — Load-time tempo/speed/audio-rate reset

**Revised diagnosis.** The earlier claim that `handleBpmChange` doesn't drive a rate commit was wrong — it does, via `handleSyncChange` → `applyEffectivePlaybackRate` (`factory.js:187-189`). The real failure modes are narrower:

1. **Construction-time seed.** The tempoPitch factory reads `window.__orbitersSync` once at construction (`factory.js:197-209`). If the effect is built *before* `sync/init.js` populates `window.__orbitersSync`, the initial `sharedState.baseRate`/`syncEnabled`/`sourceType` come from defaults (1, false, 'manual'). A subsequent `sync-bpm-change` updates them, but any `applyValue` call *between* construction and that first event uses the wrong baseRate.
2. **Inactive module.** `applyEffectivePlaybackRate` early-returns when `!isActive` (`factory.js:78`). If the configured module for an axis is not the active one when a BPM event arrives, that event never commits a rate. When the user later switches the active module, the new active module needs to commit the current effective rate — it does so in `setIsActive`, but only from *its* last input, not from the shared state's current truth.
3. **Automation bridge pre-start.** `automationBridge.ramp` schedules on the Tone clock. Before `Tone.Transport` is running / before `Tone.start()` has resolved the audio context, a ramp may be enqueued and not applied. Direct `setPlaybackRate` (fallback path) runs immediately; ramp path may not.

**Fix — stay on the single rate owner.** Do not add `AudioEngineAdapter.recomputePlaybackRateFromSync()` walking effect racks; that creates a second path to the same node.

Instead, fix the three issues in-module:

1. **Drop `window.__orbitersSync` as the seed.** Import `syncCoordinator` directly in the factory (it's already imported for `setTempo`). Seed `sharedState` from `syncCoordinator.bpm`, `syncCoordinator.trackBpm`, `syncCoordinator.isEnabled`, `syncCoordinator.tempoSourceType`. Same values, no global-window race.
2. **Add an idempotent `refreshSyncState()` on the effect factory.** Callable from outside (e.g., by `AudioEngineAdapter` once after load/configure-module). It re-reads from `syncCoordinator` into `sharedState` and calls `activeModule.handleSyncChange(sourceType)`. This is *the same* code path the event handler already uses — not a new rate owner, just an explicit trigger when we know we need a fresh read (load, active-module change).
3. **In `setIsActive(true)`**, when activating a module, commit the effective rate derived from current `sharedState` (not from `lastUserPlaybackRate` alone). The existing code already calls `applyEffectivePlaybackRate()` there — verify it uses `sharedState.baseRate` for the non-authority branch (it does, `factory.js:92`). Add a unit test that a mid-session module switch lands on the right rate.

The remaining concern (ramp-before-transport) is a separate audit: verify `automationBridge.ramp` on the streaming backend eventually applies even if called pre-play, or fall back to direct `setPlaybackRate` when transport is not running.

### Part C — Time signature

For v1, hardcode 4/4 and `BEATS_PER_BAR = 4` with a TODO. When per-track time signature lands:

- Add `timeSignature: { numerator, denominator }` to track metadata (Connect change — out of scope).
- `resolveTrackBpmFromTrackData` gains a sibling `resolveTimeSignatureFromTrackData`.
- `SyncCoordinator` stores `#timeSignature` alongside `#trackBpm` and exposes `beatsPerBar`.

## Open questions

1. **Who wins on join?** If orbiter A has been playing (quantized-started) and orbiter B joins and hits play, the shared epoch is the same, so B's `getCurrentBeat` is consistent. Verify with a cross-orbiter start offset test.
2. **Track BPM mismatch between orbiters.** Two orbiters on different tracks share a session BPM but have different `trackBpm`. Part A quantizes to session beats, so it still works; the "bar on the track" differs between peers. Accept and document.
3. **Pause/resume semantics.** After pause, resume-in-place (not re-quantized) matches user expectation. Cold start quantizes.
4. **Loop boundaries.** If an A-B loop exists and the quantized-start position lands outside it, honor the loop: start at `max(loopStart, alignedPosition)`. Let the existing loop checker handle the wrap.
5. **UI affordance.** Play button countdown during quantize wait? Minimum: show a "waiting for bar" state on the transport button for the delay window.
6. **Metric for success.** A debug HUD showing the measured `performance.now()` of actual audio-onset vs `targetStartPerf` — tells us cross-orbiter alignment drift. Guard behind `window.__orbitersDebugSync`.
7. **`performance.now()` ↔ `Tone.now()` offset stability.** The sample-both-at-call-site conversion assumes the offset is stable over the delay window. It is, in practice, but worth logging a sanity check on fire.

## Non-goals (v1)

- Bar-quantized stop. Stop is immediate.
- Non-4/4 time signatures.
- Preserving pre-grid intro material on quantized start (A2).
- Sub-bar quantization (beat-, half-note-).
- Connect-side changes.

## Sequencing

Revised for ship-today mode:

1. **Today slice** (session-bar quantization, feature-flagged, 4/4, adapter-level orchestration). No `WrapGridState` API change; no tempoPitch changes; re-align at fire time; single `setTimeout` for streaming with reject fallback.
2. **Stabilize mobile streaming fallback.** Validate the transient-activation rejection path on iOS/Android; promote the flag to "on by default" only after this lands.
3. **Part B** (load-time rate reset) — only if stale-rate-at-first-play is observed in practice. Still scoped to in-module fixes in `toneTempoPitch`; do not introduce a second rate owner.
4. **Transport/musical-timing review Phases 1-2** (`MusicalTimeModel` library + migrate conversion sites). Pure refactor, no user-visible change.
5. **Part A v1 proper** — move today's adapter-level orchestration onto `MusicalTimeModel` (add `beatOverride` / `nearestBarStart` there), delete the temporary adapter code. Add the debug HUD.
6. Review Phases 3-5 per the review doc (time-sig plumbing, musical-time loops, playhead reconciliation).

The today slice is explicitly a stopgap. Step 5 is where it gets deleted and replaced by the proper model-driven path; the review doc calls this out so it doesn't become permanent architecture.
