/**
 * @file sync/sharedClock.js
 * @description The NETWORK / multiplayer PULSE (a `?room` session). Rides the live
 * `WebSocketSyncAdapter` through its additive tee (onRawMessage / sendRaw) — one client = one Connect
 * peer, no second socket — and wraps the leaderless `BeatTimeline` via the shared pulse facade
 * (`createPulseClock`). Same `getState()` seam + tempo facade (`setTempo` / `onTempoChange`) as the
 * in-tab `LocalRelay` pulse, so `SyncCoordinator` delegates tempo to it identically.
 *
 * Leaderless tempo: a joining client ADOPTS the room's tempo (the hello→timeline exchange); the user's
 * knob is the only local proposal (`setTempo` → broadcast). We do NOT seed our local tempo on join, and
 * we do NOT re-anchor the beat epoch — both would broadcast and CLOBBER the room (last-writer-wins).
 *
 * Why no epoch re-anchor: cross-machine alignment comes from the server-time OFFSET (estimateOffset over
 * ping/pong against `serverNowMs`), not the epoch zero-point. Every peer constructs with
 * `anchorSessionMs = 0` and therefore agrees on `beatNow` via the shared server-aligned `sessionMs`;
 * the old `forceBeatAtTime(0, sessionEpoch)` only made beat numbers smaller (cosmetic) at the cost of a
 * broadcast that would overwrite a peer's tempo. Beat numbers stay float-safe (~3.6e9 ⇒ ULP ≪ 1µs).
 *
 * One-owner rule: this clock NEVER writes `Tone.Transport`. Tempo flows in via `setTempo` (delegated
 * from `SyncCoordinator`) and out via `onTempoChange` (the per-voice projection).
 */
import { ConnectRelay } from './adapters/ConnectRelay';
import { WebSocketSyncAdapterTransport } from './adapters/WebSocketSyncAdapterTransport.js';
import { getLaunchGridQuarterBeats } from './launchGrid.js';
import { createPulseClock } from './pulseClock.js';
import { syncEnabledDeckCount, deckFor } from '../voice/Deck.js';

const PING_INTERVAL_MS = 2000; // refine the server-time offset (Cristian/SNTP in ConnectRelay.#onPong)
const ANNOUNCE_INTERVAL_MS = 1000; // heartbeat so peers discover us + adopt the live tempo (killgate-proven)
// Presence kind for the SYNC-badge voice count. Rides the same sync:beat relay as the beat:* messages
// (BeatTimeline ignores unknown kinds); a dedicated relay node decodes it. NOT a beat protocol message.
const VOICE_COUNT_KIND = 'orbiters:voice-count';

/**
 * Wire the room pulse over the live WS adapter's tee. Returns the pulse facade (getState / getTempoBpm /
 * getCurrentBeat / setTempo / onTempoChange / setEnabled) with a dispose() that also tears down the
 * network lifecycle. Hand the returned object to `syncCoordinator.init({ pulse, seedPulse: false })`.
 *
 * @param {import('./adapters/WebSocketSyncAdapter.js').WebSocketSyncAdapter} adapter — the live WS adapter
 * @param {{ sessionId: string, audioEngine?: object|null }} opts
 */
export function initSharedClockPulse(adapter, { sessionId, audioEngine, onFirstInRoom } = {}) {
  const transport = new WebSocketSyncAdapterTransport(adapter);
  const relay = new ConnectRelay(transport, { sessionId });

  // Audio clock: prefer the Tone audio (sample) clock so beat/offset math lines up with the audio path;
  // fall back to a wall clock before audio is running.
  const Tone = audioEngine?.transport?.Tone ?? null;
  const audioClock = {
    nowSec: () =>
      Tone && typeof Tone.now === 'function'
        ? Tone.now()
        : (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
  };

  let joined = false;
  const pulse = createPulseClock({
    relay,
    audioClock,
    id: `orbiter-${Math.random().toString(36).slice(2, 9)}`,
    // A shared session is live once sync is ENABLED (beat.enabled, wired to SyncCoordinator
    // enable/disable) AND we've joined AND there's someone to lock with — either a network peer
    // (≥1 other client) OR ≥2 synced voices in THIS tab (a multi-orbiter tab, which shares ONE socket,
    // so its sibling voices are NOT network peers; they still must launch together on the grid).
    // Sync OFF, or a truly solo single orbiter → null → never quantizes/follows.
    isJoined: (beat) => beat.enabled && joined && (beat.peers.size >= 1 || syncEnabledDeckCount() >= 2),
    // The shared beat grid is meter-agnostic (plain quarter-beats); each voice derives its OWN bar
    // boundaries from its OWN meter over this grid (see AudioEngineAdapter._computeBarDelayMs).
    // Per-deck launch grids: the room pulse reports the FOCUSED deck's grid (module value = the
    // boot fallback before any deck exists).
    getQuantum: () => deckFor(null)?.launchGridQuarterBeats ?? getLaunchGridQuarterBeats(),
  });
  const beat = pulse.beat;
  // Start INERT: don't announce/adopt/broadcast until the user enables sync (SyncCoordinator.enable →
  // pulse.setEnabled(true)). Without this the room pulse would participate before sync is turned on.
  pulse.setEnabled(false);

  // SYNC-badge voice count: announce how many synced voices THIS tab carries so every peer sums voices,
  // not connections (a multi-orbiter tab is one socket but N voices). Announce keys on the ADAPTER peer
  // id (the sync:peer-left namespace) so a leaver's count is dropped correctly. A dedicated relay node
  // decodes peers' counts into the adapter; BeatTimeline ignores this kind.
  const announceVoiceCount = () => {
    // Only announce once we've actually joined the room AND sync is on — else a per-voice toggle
    // (notifyVoiceSyncChanged → enable → announce) could send before sync:joined, and the raw send
    // would be buffered/flushed at sync:registered, i.e. before we're really in the session.
    if (!joined || !beat.enabled) return;
    // Count = this tab's synced voices. A MULTI tab sets a per-voice syncEnabled flag
    // (syncEnabledDeckCount); a SINGLE orbiter enables sync via the coordinator aggregate WITHOUT a
    // per-voice flag, so it reads 0 there — fall back to 1 (we only get here with sync ON), which
    // matches the badge's own-count (`inTabSyncedCount`: syncedCount() ?? (enabled ? 1 : 0)).
    const count = syncEnabledDeckCount() || 1;
    relay.send(beat.id, { kind: VOICE_COUNT_KIND, peerId: adapter.selfPeerId, count });
  };
  relay.register({
    id: `${beat.id}#voices`,
    receive: (msg) => {
      if (msg?.kind !== VOICE_COUNT_KIND) return;
      adapter.recordPeerVoiceCount(msg.peerId, msg.count);
    },
  });

  let pingId = null;
  let announceId = null;

  const stopLoops = () => {
    if (pingId) clearInterval(pingId);
    if (announceId) clearInterval(announceId);
    pingId = null;
    announceId = null;
  };

  // The server's sync:joined seeds relay.sessionEpochMs + a coarse offset (ConnectRelay, also on the tee,
  // seeds itself first). Then we estimate the precise offset, announce presence, and start the heartbeat.
  // We do NOT re-anchor the epoch here (see the file header) — that would broadcast + clobber the room.
  const onRaw = (msg) => {
    // A NEW peer joined while we're already in: re-announce our voice count so its badge learns us at
    // once (event-driven; the 1s heartbeat is only the safety net for a missed/late announce).
    if (joined && msg?.type === 'sync:peer-joined') {
      announceVoiceCount();
      return;
    }
    if (msg?.type !== 'sync:joined') return;
    // A REPEAT sync:joined while we believe we're in = the adapter auto-reconnected (the socket
    // dropped and re-sent sync:join). Re-run the join: without it the fresh session never gets our
    // beat:hello, no peer replies its timeline, and a tempo the room changed while we were away is
    // adopted only on its NEXT change — "joined but didn't adopt the tempo".
    if (joined) {
      stopLoops();
      // Drop ghost peers from the PREVIOUS connection: the fresh session's live peers re-add
      // themselves via the hello exchange below; without this a peer that left while our socket was
      // down would keep isJoined()/quantize alive against nobody.
      beat.peers.clear();
      beat.peerIntents?.clear?.();
    }
    joined = true;
    relay.ping(); // immediate first probe
    beat.join(); // estimate offset, pin the audio clock, announce presence (beat:hello)
    announceVoiceCount(); // announce this tab's synced-voice count on join
    // ADOPT-ON-JOIN (replaces the old swallow-guard): if we're joining an ESTABLISHED room (peers already
    // present), relinquish our local timeline claim so the hello-replies' beat:timeline is adopted — else
    // our boot setTempo's recent stamp would reject the (older) room tempo via newerTs, and a real-BPM
    // joiner would keep its own tempo. Deferred to a microtask so the adapter has processed THIS same
    // sync:joined (peer list set) but BEFORE any reply arrives (those need a network round-trip). A FIRST
    // client (no peers) keeps its claim, so its tempo IS the room's starting tempo.
    queueMicrotask(() => {
      if ((adapter.peerCount ?? 0) > 0) {
        pulse.relinquishClaim();
      } else {
        // FIRST client in the room: our tempo IS the room's starting tempo (the tempo-priority law,
        // room path). Propose the enabling deck's CURRENT tempo now — the beat timeline only ever saw
        // deliberate synced/solo writes, so without this an unsynced deck edit made before SYNC never
        // reached the room and a later joiner adopted a boot value instead. Safe: nobody to clobber.
        onFirstInRoom?.();
      }
    });
    pingId = setInterval(() => relay.ping(), PING_INTERVAL_MS);
    announceId = setInterval(() => { beat.announce(); announceVoiceCount(); }, ANNOUNCE_INTERVAL_MS);
    console.info('[shared-clock] room pulse joined session %s (epoch %s)', sessionId, String(relay.sessionEpochMs));
  };
  const unsub = adapter.onRawMessage(onRaw);

  console.info('[shared-clock] room pulse wired — awaiting sync:joined for session %s', sessionId);

  return {
    ...pulse,
    /**
     * Re-announce this tab's synced-voice count to the room NOW (not waiting for the ≤1s heartbeat).
     * Called by `SyncCoordinator.notifyVoiceSyncChanged` so a per-voice sync toggle updates every peer's
     * badge live. No-op until sync is enabled (guarded in `announceVoiceCount`).
     */
    announceVoiceCount,
    /**
     * Stop participating (B4/A#5). `disable()` calls this; "not enabled" must also stop the JS ping/
     * announce loops, not just `beat.enabled` — otherwise they run forever after sync-off (mobile no-
     * polling rule). On re-enable the loops restart from the fresh sync:joined.
     */
    setEnabled(on) {
      pulse.setEnabled(on);
      if (!on) stopLoops();
    },
    /**
     * Re-arm after a sync toggle off→on (B4). `WebSocketSyncAdapter.disconnect()` left the raw-message
     * subscription intact but dropped the socket; reset `joined` + stop the stale loops so the NEXT
     * sync:joined (from `adapter.connect()` in `SyncCoordinator.enable`) re-runs the join (offset estimate
     * + announce + loops). Idempotent.
     */
    rejoin() {
      stopLoops();
      joined = false;
    },
    dispose() {
      unsub();
      stopLoops();
      relay.dispose();
      pulse.dispose();
    },
  };
}
