/**
 * @file sync/init.js
 * @description Wires SyncCoordinator to the audio engine after initialization.
 * Called from createInitializeBaseFlow.js once the audio engine is registered on the active voice.
 *
 * Tier selection:
 *   ?room=<name>  →  Tier 2: WebSocketSyncAdapter (Connect server, global)
 *   (no param)    →  Tier 1: BroadcastChannelAdapter (same browser only)
 */

import { syncCoordinator } from './SyncCoordinator.js';
import { BroadcastChannelAdapter } from './adapters/BroadcastChannelAdapter.js';
import { WebSocketSyncAdapter } from './adapters/WebSocketSyncAdapter.js';
// Resolver moved to the shared pkg (local trackSyncMetadata no longer exports it).
import { resolveTrackBpmFromTrackData } from 'entangled-worlds-orbiters-shared/clock/track-metadata';
import { getLaunchGridFromUrl, getMultiOrbiterModeFromUrl } from '../utils/urlParams.js';
import { getLaunchGridBars, getLaunchGridQuarterBeats, setLaunchGridBeats } from './launchGrid.js';
import { deckFor } from '../voice/Deck.js';
import { createLocalPulseClock } from './pulseClock.js';
import { initSharedClockPulse } from './sharedClock.js';
import { voiceRegistry } from '../voice/VoiceRegistry.js';

const WS_URL = import.meta.env?.VITE_WS_CONNECT ?? 'wss://connect.plantasia.space/ws/';

// The realm-wide shared-clock handle (decision 005: no window globals as seams — this replaces
// `window.__orbitersSharedClock`). A plain module singleton: any importer gets the SAME live handle
// regardless of whether ITS OWN initSync ever ran (a multi-orbiter audio-only voice reads the primary
// voice's pulse this way). `{ getState, dispose } | null`.
let sharedClockHandle = null;

/** The current shared-clock snapshot (`{ joined, beatNow, phaseNow, tempoBpm, quantum } | null`), or
 *  null when no pulse is wired yet. The one read seam for `window.__orbitersSharedClock.getState()`. */
export function getSharedClockState() {
  return sharedClockHandle?.getState?.() ?? null;
}

// A multi-orbiter tab boots N voices, each calling initSync — but a tab is ONE Connect peer, so the
// room SOCKET + shared-clock PULSE are built ONCE and reused by the sibling voices. (A fresh adapter
// per voice made every voice its own peer and left the singleton coordinator — and therefore the SYNC
// badge — reading a never-connected adapter, so remote voices were ignored.) The coordinator is still
// re-init'd per voice with that one adapter+pulse (idempotent: #wirePulse unsubscribes first), so each
// voice seeds its own trackBpm/tempo exactly as before. Keyed by room so a room change rebuilds.
// Single-orbiter never caches (one voice → always builds fresh), so its path stays byte-identical.
let sharedRoom = null; // { room, adapter, pulse } | null

function getRoomParam() {
  try {
    return new URL(window.location.href).searchParams.get('room') || null;
  } catch {
    return null;
  }
}

/**
 * @param {import('../audio/AudioEngineAdapter.js').AudioEngineAdapter} audioEngine
 * @param {object|null} trackData — full track release response, may contain audioAnalysis
 * @param {import('../core/ParameterManager.js').ParameterManager|null} parameterManager
 */
export function initSync(audioEngine, trackData, parameterManager = null) {
  if (!audioEngine?.transport) {
    console.warn('[Sync] initSync called before audio engine transport is ready.');
    return;
  }

  const trackBpm = resolveTrackBpmFromTrackData(trackData);
  const room = getRoomParam();
  const multi = getMultiOrbiterModeFromUrl() === 'multi';

  // Reuse this multi-orbiter tab's ONE socket + pulse if a sibling voice already built them; otherwise
  // build fresh. Single-orbiter / in-tab never reuse (one voice → always build).
  const reuse = room && multi && sharedRoom?.room === room;
  let adapter;
  let pulse = null;
  let seedPulse = false;
  if (reuse) {
    adapter = sharedRoom.adapter;
    pulse = sharedRoom.pulse;
  } else {
    adapter = room
      ? new WebSocketSyncAdapter(WS_URL, room)
      : new BroadcastChannelAdapter();

    // The shared PULSE (tempo+beat+phase) over the proven BeatTimeline engine.
    // Default-on (no URL flag), built BEFORE init so the coordinator delegates tempo to it; its getState()
    // is the seam the audio path reads for the bar-quantized START. Two topologies:
    //   - IN-TAB (no room): a LocalRelay pulse — several voices in one realm lock with zero network.
    //   - ROOM (?room):     a pulse over the Connect tee — cross-tab/cross-computer in the same session.
    // Dispose any prior handle first (re-init / track switch). Clear it before building so a re-init
    // that builds NO pulse never leaves the audio path reading a disposed handle.
    try { sharedClockHandle?.dispose?.(); } catch {}
    sharedClockHandle = null;
    seedPulse = true;
    if (room && adapter instanceof WebSocketSyncAdapter) {
      // ROOM: the Connect-tee pulse (rides the one ?room socket). A joining client ADOPTS the room tempo
      // (seedPulse:false) — seeding would broadcast + clobber it (last-writer-wins).
      pulse = initSharedClockPulse(adapter, {
        sessionId: room,
        audioEngine,
        // First client in the room: establish the session at the enabling deck's current tempo (the
        // same tempo-priority law the in-tab establish path applies). Routed through the coordinator's
        // one gate so it also marks the master as established.
        onFirstInRoom: () => {
          // Registration order stands in for "who enabled first": in practice exactly one deck is
          // synced when an empty-room join completes (the enabler that connected us). If a second
          // deck flips sync inside the join round-trip, either tempo is a defensible session start —
          // neither has adopted anything yet.
          const enabler = voiceRegistry.all().find((v) => v?.deck?.syncEnabled === true)?.deck;
          const tempo = enabler?.tempo ?? syncCoordinator.bpm;
          if (Number.isFinite(tempo) && tempo > 0) {
            syncCoordinator.setTempo(tempo, { sourceType: 'manual' });
          }
        },
      });
      seedPulse = false;
    } else if (!room) {
      // IN-TAB: a shared session is live once ≥2 voices coexist in this realm AND sync is enabled — the
      // de-singletonized feed. (Per "room required", the old localClock cross-tab BroadcastChannel peer
      // case is intentionally dropped.) Solo orbiter → null → never quantizes → byte-identical.
      pulse = createLocalPulseClock({
        isJoined: () => syncCoordinator.isEnabled && voiceRegistry.size >= 2,
        // Meter-agnostic shared beat grid; each voice derives its OWN bars from its OWN meter.
        // The launch grid is per-deck now — the pulse's quantum reports the FOCUSED deck's grid
        // (the realm boot value is only the fallback before any deck exists).
        getQuantum: () => deckFor(null)?.launchGridQuarterBeats ?? getLaunchGridQuarterBeats(),
      });
    }
    if (pulse) {
      sharedClockHandle = { getState: pulse.getState, dispose: pulse.dispose };
    }
    // Remember a multi-room build so sibling voices reuse this one socket + pulse.
    sharedRoom = (room && multi) ? { room, adapter, pulse } : null;
  }

  // Wire the (singleton) coordinator to that one adapter+pulse — EVERY voice, so each seeds its own
  // trackBpm/tempo (last-writer-wins, unchanged). Idempotent on reuse: #wirePulse unsubscribes first.
  // The master tempo starts at the transport "BPM" number (the master clock), not the track's native BPM.
  const numberBpm = Number(parameterManager?.getRawValue?.('sync-bpm'));
  syncCoordinator.init({
    adapter,
    trackBpm,
    masterBpm: Number.isFinite(numberBpm) && numberBpm > 0 ? numberBpm : null,
    pulse,
    seedPulse,
    isRoom: Boolean(room), // B2: only a room adapter's (live, server-scoped) peers feed the SYNC badge
  });

  if (parameterManager?.setRawValue && Number.isFinite(trackBpm) && trackBpm > 0) {
    try {
      parameterManager.setRawValue('sync-track-bpm', trackBpm);
    } catch {}
  }

  // No `window.__orbitersSync` alias — readers import the `syncCoordinator` singleton
  // directly (it's the one session coordinator). The shared clock stays realm-global (see
  // `getSharedClockState` above), same reasoning.

  // Launch-quantize grid (beats per launch boundary). A session can pin it with ?launchGrid=<n>.
  // The grid is PER-DECK now — the module value is the seed for decks constructed later, and any
  // deck already registered (this voice's own, constructed at registration) adopts the pin here.
  const urlGrid = getLaunchGridFromUrl();
  if (urlGrid != null) {
    setLaunchGridBeats(urlGrid);
    voiceRegistry.all().forEach((voice) => voice?.deck?.setLaunchGridBars(getLaunchGridBars()));
  }
}
