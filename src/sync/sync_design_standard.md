# Sync Design Standard (SDS)

The behavioral contract for sync, warp, and tempo. Every change to the files in this folder (and
to `../voice/Deck.js`) must keep these rules true; if code and this document disagree, one of them
is wrong — fix deliberately, then update the other.

## The five laws

1. **Warp decides *whether* a player time-stretches; Sync decides *which* tempo it stretches to** —
   the shared session tempo when synced, the player's own when not.
2. **The stretch is always `tempo ÷ track native BPM`.** Warp off = natural recorded speed.
3. **The BPM number is that player's tempo.** Synced: it IS the shared tempo — editing it moves
   every synced player, and only a synced player may move it. Unsynced: it is that player's own —
   editing it moves only them.
4. **A tempo only moves when someone deliberately moves it.** Boot seeds and track loads are
   placeholders, never "a tempo that's already playing".
5. **One contract, two transports.** In-window sync (several orbiters in one tab — collection or an
   embedding realm, over the in-tab pulse) and network sync (another tab/device in a room, over the
   Connect pulse) MUST behave identically. Any divergence is a bug, and fixes land once — in the
   shared seam — never patched per transport.

## Ownership (one owner per concept)

- **`Deck` (`../voice/Deck.js`)** — the per-player owner: sync flag, warp, own tempo `T`, native
  tempo `N`, meter, grid. The ONE follow rule lives here:
  `following = warp && (sync on, or — solo — a live session)`; `followRatio = tempo / N`, else 1.
- **`SyncCoordinator`** — the session: the single master-tempo mirror and the ONE gated `setTempo`
  seam. Nothing else writes the master; nothing copies it into a second owner.
- **The pulse (`pulseClock.js` / `sharedClock.js`)** — tempo replication: in-tab `LocalRelay`, or
  the leaderless room `BeatTimeline` over the Connect tee. The coordinator delegates writes to it
  and mirrors its `onTempoChange`.
- Exactly two audio-rate writers consume `followRatio` (the adapter for plain voices, the
  tempoPitch effect factory for voices carrying it) — mutually exclusive per voice, never both.

## What you hear — playback rate per state

`M` = shared session tempo · `T` = the player's own tempo · `N` = the track's native BPM.
"Plain" = no speed/pitch effect on the voice.

| SYNC | WARP | Plain voice | Voice with **tempo** knob | Voice with **pitch** knob |
|---|---|---|---|---|
| on | on | `M / N` | `M / N` (the knob writes tempo, below) | `(M / N) × knob` |
| on | off | 1.0 (natural) | knob only (free varispeed) | knob only |
| off | on | `T / N` | `T / N` | `(T / N) × knob` |
| off | off | 1.0 (natural) | knob only (free varispeed) | knob only |

- **Warp off + a turned speed/pitch knob still changes speed — by design** (the Ableton model: the
  knob is a free varispeed/pitch fader, independent of any tempo).
- **A track with no tempo cannot warp.** Never a silent ratio-1 no-op: warp is forced off and the
  Warp control disabled with a hint until the user sets the track BPM — then warp returns to its
  default (on). The mobile speed lock always wins over that re-enable. A collection deck's `N` is
  strictly its own — it MUST NOT borrow a sibling's value from any shared singleton.

## The tempo lifecycle

- **Load** — the transport adopts the track's native BPM. A construction-time seed (decks are built
  before their trackData exists) is a placeholder; a BPM the user typed while loading is respected.
- **Sync on, nothing established** — the enabler **establishes** the session at its own current
  tempo. Both transports: in-window via the deck's establish write; in a room the first member
  proposes its tempo as the room's starting tempo at join. Adopt-on-sync MUST NOT fan a
  never-established master (law 4).
- **Sync on, session live** — the joiner **adopts** the running tempo; joining never pushes your
  tempo onto the session (in a room: relinquish-claim + hello/timeline exchange; a silent socket
  reconnect re-runs the join and re-adopts).
- **Sync off** — **hold**: the player keeps the tempo it was playing; from there it's its own.
- **Editing** — all writes converge on the coordinator's gated seam; with several players only a
  player whose OWN sync is on may move the shared tempo. Unsynced edits are session-only; the
  persisted per-track value is the native BPM (kit panel).

## The speed/pitch knob (tempoPitch effect)

| Module | Following (warp on) | Not following (warp off) |
|---|---|---|
| tempo (%) | writes the tempo like a DJ pitch fader — synced: proposes the shared tempo (gated); unsynced: the player's own. Never double-multiplies | free varispeed |
| pitch (st) | pure multiplier on top; never touches any tempo | free pitch fader |

Units only change the mapping (`%` → linear, `st` → `2^(st/12)`). The fader anchor re-pins whenever
tempo moves from another source, so a stationary knob never jumps the tempo.

## Launch grid & metronome

**Launch quantize follows WARP, not sync.** A warp-off player always starts immediately — it plays
at its natural speed, so waiting for a bar line it won't track is a stumble, not a snap. The shared
bar-delay applies only to a deck that is itself synced; an unsynced deck rides its own grid.

| State | Play / playhead jump | Metronome |
|---|---|---|
| sync on · warp on | waits for the next shared bar (countdown) | shared clock |
| sync on · warp off | immediate, no wait | clicks at the track's native tempo |
| sync off · warp on | snaps to the player's own grid | own clock at `T` |
| sync off · warp off | immediate, no snap | native tempo |
| no tempo set | no snap, no countdown, no click (warp locked off) | silent |
