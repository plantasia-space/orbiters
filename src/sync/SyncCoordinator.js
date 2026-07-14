/**
 * @file SyncCoordinator.js
 * @description Per-voice tempo PROJECTOR + enable owner. Tempo/beat/phase
 * is owned by the leaderless, server-anchored PULSE (`pulseClock` over `BeatTimeline`), NOT by a
 * conductor here anymore. This coordinator now:
 *   - delegates `setTempo` to the pulse; its `onTempoChange` (→ #onPulseTempo) mirrors the tempo into
 *     `#timeline`, drives the Transport, and fans the per-voice projection to each voice's SyncView;
 *   - owns the per-voice ENABLE state fan-out (each voice hears its own sync-enable).
 *
 * Removed: the conductor tempo path (`sync:timeline`/`sync:heartbeat` publish + adoption); and (stage 1
 * of the pulse migration) the x/y/z PARAM mirroring — it copied the tempo-knob VALUE onto peers, which is meaningless
 * across different knob ranges. Tempo replicates leaderlessly over the pulse relay (beat:* messages),
 * in-tab (LocalRelay, no network) and across a room (Connect tee); the knob is independent per user.
 *
 * `#timeline` survives as a read mirror (bpm for chrome/embed readers; epoch for the solo `#currentBeat`
 * fallback when the pulse isn't joined). The adapter's conductor election stays (it feeds the on-screen
 * role label + the iframe export), but it no longer gates anything here.
 */

import { voiceRegistry } from '../voice/VoiceRegistry.js';

export class SyncCoordinator {
  #adapter = null;
  // The shared PULSE (pulseClock facade over the leaderless BeatTimeline)
  // is the tempo OWNER when present (in-tab today; room in a later slice). When set, setTempo delegates
  // to it and its onTempoChange drives the per-voice projection. #timeline is the master-tempo mirror
  // this coordinator owns (`get bpm()`) — the single tempo value readers consult (metronome, displays).
  #pulse = null;
  #pulseUnsub = null;
  #timeline = { bpm: 120, epoch: null };
  #mode = 'TEMPO_ONLY';
  #enabled = false;
  // True when the adapter is a ROOM (Connect/WebSocket) adapter, whose peer set is live +
  // server-room-scoped — the right "others in this session" source for the badge. The in-tab
  // BroadcastChannelAdapter has NO room concept (it counts every same-origin tab), so its peers must NOT
  // feed the badge; the in-tab realm count comes from voiceSyncEnable instead.
  #isRoom = false;
  #trackBpm = null;
  #detectedTrackBpm = null;
  #tempoSourceType = 'manual';
  // Whether the session tempo was ever DELIBERATELY set (an accepted setTempo, or a remote pulse
  // adoption). The boot seed (init masterBpm / 120 default) is only a placeholder: adopt-on-sync
  // must never fan a tempo nobody established — that's how "press SYNC" used to snap a deck back to
  // the boot value instead of the first enabler establishing its own (the tempo-priority law).
  #masterEstablished = false;

  // Session-level notification surface for the on-screen chrome (the on-screen UI
  // subscribes here directly — replaces the transitional `window` CustomEvent bus). The PULSE owns
  // tempo; this is only the coordinator's notification fan-out. Per-voice views (audio path) are fed
  // separately and unchanged.
  #sessionBpmListeners = new Set();
  #sessionStatusListeners = new Set();

  /**
   * @param {{ adapter, trackBpm?: number|null, pulse?: object|null, seedPulse?: boolean, isRoom?: boolean }} opts
   */
  init({ adapter, trackBpm = null, masterBpm = null, pulse = null, seedPulse = true, isRoom = false }) {
    this.#adapter = adapter;
    this.#isRoom = isRoom === true;
    this.#trackBpm = (Number.isFinite(trackBpm) && trackBpm > 0) ? trackBpm : null;
    this.#detectedTrackBpm = this.#trackBpm;
    // The master tempo is the "BPM" number (the master clock this coordinator owns), NOT any track's
    // native BPM. A synced deck ADOPTS this master; a track's native only drives that deck's own UNSYNCED
    // playback and its follow projection (baseRate = master / trackBpm). Seed from the number's value,
    // else 120 — never the track (seeding from the track made "press sync" jump the master to the track's
    // native instead of the deck conforming to the master).
    // Seed ONCE — the first voice's init. init() runs again for every voice loaded later, and
    // re-seeding there moved a RUNNING session's tempo (loading deck B while deck A played synced
    // re-seeded the master from B's number, which the trailing fan then pushed into A). After boot
    // the master moves only through setTempo (the one gate) / pulse adoption; a deck that syncs on
    // later establishes or adopts via the tempo-priority rule.
    if (!this.isInitialized) {
      // A solo deck seeds this master from its track's native BPM (`seedTrackTempo`), and that happens
      // BEFORE initSync runs — the deck is seeded from trackData while the audio adapter is built. So
      // a track tempo already here outranks the boot default; overwriting it is how a single orbiter
      // ended up stuck on 120 while a collection deck showed its real tempo.
      const fromTrack = this.#tempoSourceType === 'track' && this.#timeline.bpm > 0;
      if (!fromTrack) {
        this.#tempoSourceType = 'manual';
        const seedBpm = [masterBpm, 120].find((v) => Number.isFinite(v) && v > 0);
        this.#timeline = { bpm: seedBpm, epoch: performance.now() };
      } else {
        this.#timeline = { bpm: this.#timeline.bpm, epoch: performance.now() };
      }
      this.#masterEstablished = false; // a seed is a placeholder, not an established session tempo
    }

    // No onTimeline/onParameter wiring: the conductor tempo path AND the x/y/z param mirror are gone.
    // Tempo flows leaderlessly through the pulse (beat:* messages over the pulse relay), not the
    // adapter's sync:timeline/heartbeat/param. Only the peer-count presence signal stays on the adapter.
    this.#adapter.onPeerCount(() => this.#emitStatusChange('peers'));

    // Wire the pulse as the tempo owner (in-tab now; room in slice 4). The trailing #emitBpmChange('init')
    // is the single initial fan-out (seed-before-subscribe avoids a double-fire).
    this.#wirePulse(pulse ?? null, { seed: seedPulse });

    this.#emitBpmChange('init');
    this.#emitStatusChange('init');
  }

  /**
   * Make `pulse` the tempo owner. `seed` imposes the current local tempo on the pulse: in-tab
   * (LocalRelay) that broadcast is a no-op, so seeding is how in-tab siblings lock to the local track
   * tempo. In a ROOM, seed MUST be false — broadcasting our tempo would clobber the room (last-writer-
   * wins); a joining client instead ADOPTS the room tempo via the leaderless hello/timeline exchange.
   */
  #wirePulse(pulse, { seed = true } = {}) {
    if (this.#pulseUnsub) { this.#pulseUnsub(); this.#pulseUnsub = null; }
    this.#pulse = pulse ?? null;
    if (!this.#pulse) return;
    if (seed) this.#pulse.setTempo(this.#timeline.bpm, { sourceType: this.#tempoSourceType });
    this.#pulseUnsub = this.#pulse.onTempoChange((e) => this.#onPulseTempo(e));
  }

  enable() {
    if (this.#enabled) return;
    // connect() is idempotent + reopens after a disconnect() (double-connect guarded inside the adapter).
    const connected = this.#adapter.connect();
    if (!connected) {
      console.warn('[SyncCoordinator] Adapter failed to connect.');
      return;
    }
    this.#enabled = true;
    // B4: re-arm the room pulse so a toggle off→on re-joins. disable() used adapter.disconnect() (a
    // re-connectable close that left the room-pulse subscription intact); rejoin() resets the pulse's
    // joined flag so the fresh sync:joined from connect() above re-runs the join. In-tab pulses have no
    // rejoin (LocalRelay never left), so this is a no-op there.
    this.#pulse?.rejoin?.();
    // The pulse participates only while sync is enabled: setEnabled(true) lets it announce/adopt/
    // broadcast (in a room) so an OFF orbiter is never driven by the room. Tempo replicates over the
    // pulse's own relay (in-tab: no-op; room: the Connect tee) — no conductor tempo heartbeat. The
    // adapter still connects for presence (peer-count + conductor election for the role label).
    this.#pulse?.setEnabled(true);
    this.#emitStatusChange('enable');
    // ADOPT-ON-SYNC: push the CURRENT shared tempo to the freshly-enabled voice(s) so they snap to the
    // tempo that's already playing — display AND projection. enable() previously emitted only status, so
    // a voice that turned sync on never received the live tempo (the number stayed put). Status is emitted
    // first (above) so the per-voice display gate sees enabled=true before this bpm arrives. In a room the
    // joiner then refines to the peer's tempo via the network adopt-on-join.
    // ONLY an established tempo is "already playing" — fanning the boot seed here snapped the first
    // enabler back to a value nobody set (its own tempo must establish instead, in-tab via the deck's
    // establish write, in a room via the first-in-room proposal at join).
    if (this.#masterEstablished) this.#emitBpmChange('enable');
  }

  disable() {
    if (!this.#enabled) return;
    this.#enabled = false;
    this.#pulse?.setEnabled(false); // stop the room pulse participating (no broadcast/adopt while off)
    // B4: leave the session RE-CONNECTABLY when the adapter supports it (room/WebSocket) — sends
    // sync:leave so peers get a sync:peer-left and decrement their room count, but keeps the adapter
    // re-usable so enable() can re-join. The in-tab BroadcastChannelAdapter has no disconnect() →
    // destroy() (it rebuilds cheaply on the next connect()).
    if (typeof this.#adapter.disconnect === 'function') this.#adapter.disconnect();
    else this.#adapter.destroy();
    this.#emitStatusChange('disable');
  }

  /**
   * @param {'TEMPO_ONLY'|'PHASE_LOCK'} mode — stored preference only (read by embed/UI). Beat/phase
   * alignment is now inherent to the pulse; there is no separate drift-correction loop.
   */
  setMode(mode) {
    if (mode !== 'TEMPO_ONLY' && mode !== 'PHASE_LOCK') return;
    this.#mode = mode;
    this.#emitStatusChange('mode');
  }

  /**
   * Propose a session BPM change. This is the ONLY way to change the shared tempo — and the ONLY
   * place that decides whether a caller may (the master tempo used to have three writers,
   * each carrying its own copy of "may this player move the master?"; that shape is exactly how the
   * same leak class kept recurring). UI controls should call this; the tempo lives in exactly one
   * place (`#timeline.bpm`, exposed as `get bpm()`) — do not copy it into a second owner.
   * @param {number} bpm
   * @param {{ sourceType?: string, byVoiceId?: string|null }} [options] `byVoiceId` tags a
   *   voice-scoped write (a deck's own BPM number, its tempo fader): with ≥2 voices registered, only
   *   a voice whose OWN sync is on may move the shared master — an unsynced deck doesn't even follow
   *   the master, so letting its edit through would silently retune every synced sibling. Omit
   *   `byVoiceId` for a system-level write (pulse adoption, external host control via
   *   `externalControl.js`) — those are never voice-gated.
   * @returns {boolean} whether the write was accepted.
   */
  setTempo(bpm, options = {}) {
    if (!Number.isFinite(bpm) || bpm <= 0) return false;
    const { byVoiceId = null, ...pulseOptions } = options;
    if (byVoiceId != null && voiceRegistry.size > 1
      && voiceRegistry.get(byVoiceId)?.deck?.syncEnabled !== true) {
      return false;
    }
    // A deliberate accepted write ESTABLISHES the session tempo — from here on adopt-on-sync may fan
    // it. The boot seed alone never establishes (see #masterEstablished).
    this.#masterEstablished = true;
    // The PULSE owns tempo (in-tab + room): propose to it and #onPulseTempo applies the result — mirror
    // into #timeline, drive the Transport, fan the per-voice projection, and broadcast leaderlessly over
    // the pulse relay. The pulse's epsilon guard breaks the projection→knob feedback loop.
    this.#pulse?.setTempo(bpm, pulseOptions);
    // Reconcile the mirror when the pulse did NOT re-emit (its epsilon guard skipped an equal tempo,
    // or no pulse is wired yet). Without this an accepted write can leave #timeline on a stale boot
    // seed — e.g. mirror seeded 129, pulse already at the proposed 120 — and the next adopt-on-sync
    // would fan the stale mirror. When the pulse DID emit, #onPulseTempo already ran synchronously
    // and this is a no-op.
    if (this.#timeline.bpm !== bpm) {
      // Keep the epoch untouched: a pre-init write must not flip isInitialized (init() still seeds).
      this.#timeline = { bpm, epoch: this.#timeline.epoch };
      if (typeof pulseOptions.sourceType === 'string') this.#tempoSourceType = pulseOptions.sourceType;
      this.#emitBpmChange('set-tempo');
      this.#emitStatusChange('tempo');
    }
    return true;
  }

  /**
   * A track finished loading and its native BPM should become the transport tempo (SDS, the tempo
   * lifecycle: "Load — the transport adopts the track's native BPM"). Used by a SOLO deck, whose
   * transport tempo IS this master; a collection deck owns its own and adopts it directly.
   *
   * This is a LOAD, not a choice: it never marks the session established, so the first deck to enable
   * sync still establishes from its own tempo, and it no-ops the moment anyone HAS deliberately chosen
   * a tempo — a boot seed is a placeholder, a BPM the user typed while loading is respected (law 4).
   *
   * @param {number} bpm
   */
  seedTrackTempo(bpm) {
    if (this.#masterEstablished) return;
    const n = Number(bpm);
    if (!Number.isFinite(n) || n <= 0 || n === this.#timeline.bpm) return;
    // Let the pulse own the write, exactly as `setTempo` does — `#onPulseTempo` mirrors and fans it.
    // While sync is off the pulse is inert, so this never broadcasts to a room.
    this.#pulse?.setTempo(n, { sourceType: 'track' });
    if (this.#timeline.bpm !== n) {
      // No pulse wired yet (or its epsilon guard skipped an equal tempo): reconcile the mirror.
      this.#timeline = { bpm: n, epoch: this.#timeline.epoch };
      this.#tempoSourceType = 'track';
      this.#emitBpmChange('track-tempo');
      this.#emitStatusChange('track-tempo');
    }
  }

  setTrackBpm(trackBpm, options = {}) {
    const bpm = Number(trackBpm);
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    this.#trackBpm = bpm;
    if (options?.updateDetected === true || !Number.isFinite(this.#detectedTrackBpm)) {
      this.#detectedTrackBpm = bpm;
    }
    this.#emitBpmChange(options?.source || 'track-bpm');
    this.#emitStatusChange(options?.source || 'track-bpm');
  }

  get isEnabled() { return this.#enabled; }
  get mode() { return this.#mode; }
  get bpm() { return this.#timeline.bpm; }
  // A ROOM (cross-device) session adopts an existing peer's tempo on join; an in-tab session has no
  // remote tempo to adopt, so the first deck to enable sync establishes it (read by Deck.setSyncEnabled).
  get isRoom() { return this.#isRoom; }
  get trackBpm() { return this.#trackBpm; }
  get detectedTrackBpm() { return this.#detectedTrackBpm; }
  get tempoSourceType() { return this.#tempoSourceType; }
  get peerCount() { return this.#adapter?.peerCount ?? 0; }
  // "Others present in this session" for the SYNC badge — LIVE + room-scoped. Only a ROOM
  // (Connect/WebSocket) adapter qualifies: its peer set is server-room-scoped and decrements on
  // sync:peer-left. The in-tab BroadcastChannelAdapter counts every same-origin tab (no room concept),
  // so it must NOT contribute — in-tab partners are counted separately via voiceSyncEnable. NOT the
  // engine's `beat.peers` (monotonic — never expires).
  get sessionPeerCount() { return this.#isRoom ? (this.#adapter?.peerCount ?? 0) : 0; }
  // Σ of OTHER peers' announced SYNCED-voice counts — the true "others in this session" for the badge
  // (a multi-orbiter tab is one connection but N voices; `sessionPeerCount` would miscount it as 1).
  // Room-scoped only; 0 for the in-tab BroadcastChannel path (which has no announced voice counts).
  get sessionRemoteVoiceCount() { return this.#isRoom ? (this.#adapter?.remoteSyncedVoiceCount ?? 0) : 0; }
  get isConductor() { return this.#adapter?.isConductor ?? false; }
  // True once `init()` has run (the timeline epoch is set). Lets readers that used to gate on the
  // presence of the old `window.__orbitersSync` alias keep the same "not wired yet → skip" semantics.
  get isInitialized() { return this.#timeline.epoch !== null; }
  // Beat comes from the pulse ONLY when a shared session is live (joined) — its getState() returns the
  // shared-grid beatNow then, else null. Solo / not-joined falls back to the legacy per-voice timeline so
  // single-orbiter stays byte-identical (the pulse's grid is anchored to a far epoch, not performance.now).
  getCurrentBeat(now = performance.now()) {
    const shared = this.#pulse?.getState();
    return shared ? shared.beatNow : this.#currentBeat(now);
  }

  /**
   * Re-fan the per-voice status (each voice's OWN sync-enable) WITHOUT changing the realm
   * aggregate. Needed because toggling one of several synced voices off leaves the aggregate enabled,
   * so `enable()/disable()` emit nothing — but the toggled voice must still hear its new OFF state.
   * Driven by `recomputeSyncAggregate` (Deck.js).
   */
  notifyVoiceSyncChanged() {
    this.#emitStatusChange('voice-sync');
    // Room: re-announce this tab's synced-voice count NOW so every peer's badge updates live on a
    // per-voice toggle (in-tab pulse has no announceVoiceCount → no-op).
    this.#pulse?.announceVoiceCount?.();
    // ADOPT-ON-SYNC (per-voice toggle): when one of several voices flips its own sync on while the realm
    // aggregate was already enabled, enable() doesn't run — so re-push the current tempo here too, so the
    // newly-synced voice adopts the live shared tempo instead of keeping its own. Same establishment
    // gate as enable(): a boot seed is not a live shared tempo.
    if (this.#masterEstablished) this.#emitBpmChange('voice-sync');
  }

  /**
   * Re-fan the per-voice status after a voice's WRAP flag (follow-shared-tempo) toggles, so its
   * audio path re-applies the rate (wrap on → projected; wrap off → natural). Driven by Deck.setWarp.
   */
  notifyVoiceWrapChanged() { this.#emitStatusChange('voice-wrap'); }

  /**
   * Subscribe the session (on-screen chrome) to bpm changes. Returns an unsubscribe fn.
   * Non-functions are ignored. The detail payload matches the per-voice view feed.
   */
  onBpmChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this.#sessionBpmListeners.add(fn);
    return () => this.#sessionBpmListeners.delete(fn);
  }

  /**
   * Subscribe the session (on-screen chrome) to sync status changes (enable/disable/peer/mode/tempo).
   * Returns an unsubscribe fn. Non-functions are ignored.
   */
  onStatusChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this.#sessionStatusListeners.add(fn);
    return () => this.#sessionStatusListeners.delete(fn);
  }

  // ── private ──────────────────────────────────────────────────────────────

  #currentBeat(now = performance.now()) {
    if (!this.#timeline.epoch) return 0;
    return (now - this.#timeline.epoch) / (60_000 / this.#timeline.bpm);
  }

  /**
   * The pulse adopted a new tempo (local proposal OR a remote peer's, leaderless). Store it as the
   * master-tempo mirror (`get bpm()`, the one value tempo readers consult) and fan the per-voice
   * projection. This REPLACES the conductor's setTempo/#onRemoteTimeline emit path when a pulse owns tempo.
   */
  #onPulseTempo({ tempoBpm, sourceType } = {}) {
    if (!Number.isFinite(tempoBpm) || tempoBpm <= 0) return;
    // A REMOTE adoption is a real session tempo (a peer established it) — count it as established.
    if (sourceType === 'remote') this.#masterEstablished = true;
    this.#timeline = { bpm: tempoBpm, epoch: this.#timeline.epoch ?? performance.now() };
    if (typeof sourceType === 'string') this.#tempoSourceType = sourceType;
    this.#emitBpmChange('pulse');
    this.#emitStatusChange('tempo');
  }

  #emitBpmChange(source) {
    const bpm = this.#timeline?.bpm;
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    const trackBpm = this.#trackBpm;
    // No baseRate here — the deck's followRatio is the ONE rate owner (its snapshot carries it).
    // Shipping a second, coordinator-derived copy (bpm / its own trackBpm singleton) was a
    // divergence trap: consumers must never read a rate from this detail.
    const detail = { bpm, trackBpm, source, sourceType: this.#tempoSourceType };
    // Fan the master to EVERY deck — the adopt gate lives in the deck (the ONE site of "does this
    // player follow the master"): a synced deck (or a solo one) adopts it into its transport tempo,
    // an unsynced collection deck ignores it. Gating here again would be a second copy of that rule.
    voiceRegistry.all().forEach((voice) => {
      voice?.deck?.receiveMasterChange(detail);
    });
    // Session-level listeners (on-screen chrome) — replaces the old window CustomEvent.
    this.#sessionBpmListeners.forEach((fn) => {
      try { fn(detail); } catch { /* listener errors must not break the fan-out */ }
    });
  }

  #emitStatusChange(source) {
    const detail = {
      enabled: this.#enabled,
      mode: this.#mode,
      bpm: this.#timeline?.bpm ?? null,
      trackBpm: this.#trackBpm,
      detectedTrackBpm: this.#detectedTrackBpm,
      peerCount: this.#adapter?.peerCount ?? 0,
      isConductor: this.#adapter?.isConductor ?? false,
      source,
    };
    // Fan to every deck; each merges its OWN flags (sync-enable, warp) into what it retains and
    // re-emits deck-scoped — a voice the user switched OFF hears ITS OWN off, not the realm aggregate.
    voiceRegistry.all().forEach((voice) => {
      voice?.deck?.receiveStatusChange(detail);
    });
    // Session-level listeners (on-screen chrome) — the realm aggregate (the SYNC engine on/off).
    this.#sessionStatusListeners.forEach((fn) => {
      try { fn(detail); } catch { /* listener errors must not break the fan-out */ }
    });
  }

}

export const syncCoordinator = new SyncCoordinator();
