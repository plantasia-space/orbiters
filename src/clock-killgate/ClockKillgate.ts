// ClockKillgate — the clock kill-gate harness controller (NON-React, NON-product).
//
// PURPOSE (the gate, before any timeline-UI investment): on TWO machines/browsers, validate the shared
// clock over the REAL Connect server — (a) inter-client clock-offset stability over 60s, and (b) the
// audio click's scheduling steadiness. It is a thin wiring of the SHIPPED pieces, nothing new:
//
//   WsConnectTransport(VITE_WS_CONNECT, {sessionId})   — its own dedicated Connect socket
//        -> ConnectRelay                                — RelaySeam: serverNowMs/offset/ping + beat fan-out
//        -> BeatTimeline (clock/sync)                   — leaderless tempo/beat/phase, quantized launch
//        -> Transport (clock) + AudioClickBackend       — schedules a click on each beat on the audio clock
//
// It owns NO product state and imports NO product modules besides the two sync adapters it is meant to
// exercise (WsConnectTransport, ConnectRelay) — read carefully, NOT modified. Everything else is from the
// shared clock package. The UI layer (main.ts) only reads snapshots + drives start/stop/tempo.

import { Transport } from 'entangled-worlds-orbiters-shared/clock';
import { BeatTimeline } from 'entangled-worlds-orbiters-shared/clock/sync';
import { WsConnectTransport } from '../sync/adapters/WsConnectTransport';
import { ConnectRelay } from '../sync/adapters/ConnectRelay';
import { AudioClickBackend, type ScheduledClick } from './AudioClickBackend';

const PUMP_INTERVAL_MS = 25; // the production look-ahead pump cadence (design doc §0/§2)
const LOOKAHEAD_SEC = 0.1;
const PING_INTERVAL_MS = 2000; // refine the offset estimate periodically
const OFFSET_SAMPLE_INTERVAL_MS = 250; // how often the recorder samples serverNow offset

/** A single offset sample taken during a recording window. */
export interface OffsetSample {
  /** ms since the recording started. */
  tRelMs: number;
  /** local wall clock (Date.now) at the sample. */
  localWallMs: number;
  /** relay.serverNowMs() at the sample. */
  serverNowMs: number;
  /** serverNowMs - localWallMs — the measured offset. */
  offsetMs: number;
  /** relay.upMs (== downMs; symmetric leg estimate). */
  halfRttMs: number;
  /** peers known to the BeatTimeline at the sample. */
  peerCount: number;
  /** session beat position at the sample (shared across peers). */
  beatNow: number;
}

/** The full export payload a human downloads for offline jitter / cross-correlation analysis. */
export interface KillgateExport {
  meta: {
    schema: 'orb-118-killgate/v1';
    sessionId: string;
    peerId: string;
    wsUrl: string;
    sessionEpochMs: number;
    startedAtIso: string;
    durationMs: number;
    /** The ADOPTED shared tempo at export (BeatTimeline.tempoBpm — peer proposals update this, not this.bpm). */
    bpm: number;
    quantum: number;
    /**
     * The audio↔session pin established by BeatTimeline.pinAudio(), captured at export. It bridges the
     * two recorded series into ONE clock domain offline: scheduledClicks are in AudioContext seconds and
     * offsetSamples are in wall/session ms, so without this anchor they can't be cross-correlated. With it:
     *   sessionMs(click) = scheduledAudioSec * 1000 + audioToSessionMs
     * maps any click's SCHEDULED audio time onto the same session-ms axis the offset samples live on. To
     * compare the ACOUSTIC instant (what a mic hears) across clients, add the output-latency term:
     *   acoustic_session_ms(click) = (scheduledAudioSec + audioOutputLatencySec) * 1000 + audioToSessionMs
     * (see meta.notes). The latency term is what lets two clients be compared INCLUDING output latency.
     */
    audioToSessionMs: number;
    /**
     * The relay's measured server-time offset at export: serverNowMs() - Date.now(), in ms. This is the
     * SAME quantity sampled per-tick in offsetSamples, captured once at export for a quick single-number
     * read; offline subtract two clients' offsets to get their clock bias independent of output latency.
     */
    relayOffsetMs: number;
    /** Half the measured round-trip (relay.upMs == downMs); the symmetric one-way network leg estimate. */
    halfRttMs: number;
    /**
     * The launch values from the last BeatTimeline.launch() (null if the session never pressed Play). With
     * these, offline analysis knows the exact beat-grid start point + count-in length per client, so a
     * cross-client click offset can be attributed to (a) different startBeat, (b) different startAudioSec,
     * or (c) clock/latency — rather than being unexplained.
     */
    launch: { startBeat: number; startAudioSec: number; countInBeats: number } | null;
    userAgent: string;
    /**
     * Live audio hardware latency, read off the owned AudioContext at record time (see
     * AudioClickBackend.latencySnapshot). Numbers when the platform exposes them; explicit `null` where it
     * does not (outputLatency is non-standard — absent on some browsers, e.g. Safari). Never undefined.
     */
    audioBaseLatencySec: number | null;
    audioOutputLatencySec: number | null;
    audioSampleRate: number | null;
    /**
     * A/B state for this recording. `latencyCompApplied` = was output-latency compensation
     * ON while recording (clicks scheduled earlier by `latencyCompSec`)? `latencyCompSec` = the comp
     * value at export time (seconds; 0 when off/unsupported). With comp ON, scheduledAudioSec is
     * already the EARLIER (compensated) start, so the acoustic formula in `notes` recovers the
     * canonical beat time and two clients align; with it OFF they differ by Δ(outputLatency).
     */
    latencyCompApplied: boolean;
    latencyCompSec: number;
    /**
     * Manual calibration offset (ms) in effect at export. Added on TOP of latencyCompSec when
     * scheduling, to cover output latency the browser under-reports (e.g. iOS). scheduledAudioSec is
     * already shifted by (latencyCompSec + manualOffsetMs/1000), so the acoustic formula projects each
     * click to where it should physically sound once this is dialed in.
     */
    manualOffsetMs: number;
    notes: string;
  };
  /** offset samples over the window (read offsetMs stability + halfRttMs spread). */
  offsetSamples: OffsetSample[];
  /** every click scheduled during the window (intended atSec vs scheduledAudioSec; armed-ahead lead). */
  scheduledClicks: ScheduledClick[];
}

export interface KillgateSnapshot {
  audioRunning: boolean;
  /** True once the server's `sync:joined` has landed (relay learned the shared session epoch). */
  joined: boolean;
  peerCount: number;
  offsetMs: number;
  halfRttMs: number;
  bpm: number;
  beatNow: number;
  phaseNow: number;
  quantum: number;
  playing: boolean;
  countInBeats: number | null;
  scheduledCount: number;
  cancelledCount: number;
  recording: boolean;
  recordRemainingMs: number;
  /** Is output-latency compensation currently ON? */
  latencyComp: boolean;
  /** The live auto comp value applied to clicks, in ms (0 when off/unsupported). */
  latencyCompMs: number;
  /** The manual per-device offset in ms. */
  manualOffsetMs: number;
  /** Total compensation applied (auto + manual), in ms. */
  totalCompMs: number;
}

export interface ClockKillgateOptions {
  wsUrl: string;
  sessionId: string;
  recordDurationMs?: number;
  /**
   * Candidate fix (default OFF, for A/B): compensate the audio OUTPUT latency by scheduling
   * each click EARLIER by `AudioContext.outputLatency`, so the sound LEAVES THE SPEAKER at the
   * canonical session-beat time instead of one output-latency later. The beat/position math stays
   * canonical — only the audible scheduling shifts — so two clients' ACOUSTIC clicks align even when
   * their output latency differs. Toggleable at runtime via setLatencyComp() so a single session can
   * record both A (off) and B (on) for comparison. Validated by re-recording the kill-gate export.
   */
  latencyComp?: boolean;
}

export class ClockKillgate {
  private readonly wsUrl: string;
  private readonly sessionId: string;
  private readonly recordDurationMs: number;

  private ctx: AudioContext | null = null;
  private backend: AudioClickBackend | null = null;
  private transport: Transport | null = null;
  private transportRef!: WsConnectTransport;
  private relay!: ConnectRelay;
  private beat!: BeatTimeline;

  private readonly peerId = `killgate-${Math.random().toString(36).slice(2, 9)}`;
  private bpm = 120;
  private playing = false;
  /** When true, clicks are scheduled ctx.outputLatency earlier (see armNextBeatClick). */
  private latencyComp = false;
  /**
   * Manual calibration: an extra per-device output-latency offset in MILLISECONDS, on top of
   * the (often wrong) browser-reported value. Positive = "this device's speaker is N ms late" → fire
   * its clicks N ms earlier. This is the escape hatch for platforms whose AudioContext.outputLatency
   * under-reports the true acoustic latency (e.g. iOS, which reported ~12.6 ms when a mic measured
   * ~125 ms). The user nudges it once until two devices' clicks line up acoustically.
   */
  private manualOffsetMs = 0;
  private launchPending: { startBeat: number } | null = null;
  /**
   * The launch values from the most recent BeatTimeline.launch() (see play()), retained for the export.
   * Offline these let us reconstruct exactly where each client began on the shared beat grid and how long
   * its count-in was — the third leg (alongside offset bias + output latency) for explaining a cross-client
   * click offset. Null until the first play() of the session.
   */
  private lastLaunch: { startBeat: number; startAudioSec: number; countInBeats: number } | null = null;

  private pumpId: ReturnType<typeof setInterval> | null = null;
  private pingId: ReturnType<typeof setInterval> | null = null;
  private heartbeatId: ReturnType<typeof setInterval> | null = null;
  private clickEventId: number | null = null;
  private epochAnchorId: ReturnType<typeof setInterval> | null = null;
  private epochAnchored = false;

  // recording state
  private recording = false;
  private recordStartMs = 0;
  private recordEndMs = 0;
  private recordSampleId: ReturnType<typeof setInterval> | null = null;
  private offsetSamples: OffsetSample[] = [];
  private clickLogStartIndex = 0;
  private lastExport: KillgateExport | null = null;

  constructor(opts: ClockKillgateOptions) {
    this.wsUrl = opts.wsUrl;
    this.sessionId = opts.sessionId;
    this.recordDurationMs = opts.recordDurationMs ?? 60_000;
    this.latencyComp = !!opts.latencyComp;
  }

  /**
   * The output-latency compensation applied to click scheduling, in SECONDS. Read LIVE off
   * the owned AudioContext each time a click is armed (outputLatency can drift). Returns 0 when comp is
   * off or the platform omits `outputLatency` (non-standard — absent on e.g. Safari), so the OFF and
   * unsupported paths are byte-identical to the original uncompensated behaviour.
   */
  private outputLatencyCompSec(): number {
    if (!this.latencyComp || !this.ctx) return 0;
    const ol = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency;
    return typeof ol === 'number' && Number.isFinite(ol) ? ol : 0;
  }

  /** Toggle output-latency compensation at runtime (takes effect on the next armed click). */
  setLatencyComp(on: boolean): void {
    this.latencyComp = !!on;
  }

  /** Set the manual per-device audio offset in ms (takes effect on the next armed click). */
  setManualOffsetMs(ms: number): void {
    this.manualOffsetMs = Number.isFinite(ms) ? ms : 0;
  }

  /** The TOTAL compensation applied to a click, in seconds (auto outputLatency + manual). */
  private totalCompSec(): number {
    return this.outputLatencyCompSec() + this.manualOffsetMs / 1000;
  }

  /** Open the Connect socket + wire the relay/beat-timeline. Safe to call before audio is started. */
  connect(): void {
    this.transportRef = new WsConnectTransport(this.wsUrl, {
      sessionId: this.sessionId,
      peerId: this.peerId,
    });
    this.relay = new ConnectRelay(this.transportRef, { sessionId: this.sessionId });

    // The beat timeline pins to the audio clock; until audio starts we give it a wall-clock shim so
    // beatNow()/offset are readable immediately. start() swaps in the real audio backend + re-pins.
    const wallClock = { nowSec: (): number => performance.now() / 1000 };
    this.beat = new BeatTimeline({
      id: this.peerId,
      relay: this.relay,
      audioClock: wallClock,
      quantum: 4, // a 4/4 bar; tempo proposals keep this fixed for the gate
      trueOffsetMs: 0, // two machines: we MEASURE the offset via ping(), trueOffset is unknown/0
    });
    this.beat.join();

    // Heartbeat so a freshly-opened peer discovers us fast and adopts the live tempo.
    this.heartbeatId = setInterval(() => this.beat.announce(), 600);
    // Refine the server-time offset periodically (Cristian/SNTP in ConnectRelay.#onPong).
    this.pingId = setInterval(() => this.relay.ping(), PING_INTERVAL_MS);
    this.relay.ping(); // an immediate first probe

    // Re-anchor the timeline to the REAL server epoch once the relay learns it.
    //
    // BeatTimeline's constructor anchors to `relay.sessionEpochMs`, but that is still 0 here —
    // the server's `sync:joined` (which carries sessionEpochMs) arrives async AFTER construction.
    // With anchorSessionMs=0, beatNow() ≈ Date.now()/beatMs (billions). When the epoch lands we
    // re-anchor {anchorBeat:0, anchorSessionMs: epoch} via the public engine API so beats are
    // small and identical across peers (they share the server-provided epoch).
    //
    // GUARD against clobbering an already-adopted remote timeline: only re-anchor while this peer's
    // timeline is still the construction default (anchorSessionMs === 0). The default is the ONLY
    // state with epoch 0 — any real session's adopted timeline anchors to a real (non-zero) epoch,
    // and forceBeatAtTime stamps with sessionNowMs so the normal beat:hello→beat:timeline
    // last-writer-wins adopt still reconciles peers afterwards.
    this.maybeAnchorToEpoch();
    this.epochAnchorId = setInterval(() => this.maybeAnchorToEpoch(), 100);
  }

  /** Re-anchor the local timeline to the shared server epoch once it is known (see connect()). */
  private maybeAnchorToEpoch(): void {
    if (this.epochAnchored) return;
    const epoch = this.relay.sessionEpochMs;
    if (!Number.isFinite(epoch) || epoch <= 0) return; // epoch not learned yet
    // Only act on the construction default — never overwrite an adopted remote session timeline.
    if (this.beat.timeline.anchorSessionMs === 0) {
      this.beat.forceBeatAtTime(0, epoch);
    }
    this.epochAnchored = true;
    if (this.epochAnchorId) {
      clearInterval(this.epochAnchorId);
      this.epochAnchorId = null;
    }
  }

  /** Start audio (needs a user gesture). Swaps the wall-clock shim for the real AudioContext backend. */
  async start(): Promise<void> {
    if (this.ctx) return;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    await this.ctx.resume();

    this.backend = new AudioClickBackend(this.ctx);
    this.transport = new Transport(this.backend, { lookaheadSec: LOOKAHEAD_SEC });

    // Re-anchor the beat timeline onto the real audio clock now that it exists.
    this.beat.audioClock = this.backend;
    this.beat.pinAudio();

    // Anchor the transport position to AUDIO time directly (positionSec == backend.nowSec()): with this
    // 1:1 mapping a click's `atSec` (transport-position seconds) IS its audio time, so beatToAudioSec()
    // values can be scheduled verbatim and the Transport maps atSec -> the right audio time in tick().
    const nowAudio = this.backend.nowSec();
    this.transport.applyAnchoredState({ playState: 'paused', positionSec: nowAudio, anchorAudioSec: nowAudio });

    // The look-ahead pump: while playing, the transport arms each beat's click AHEAD of its audio deadline
    // and fires it at occurrence. tick() is a no-op for arming until play() flips the transport to playing.
    this.pumpId = setInterval(() => this.transport?.tick(), PUMP_INTERVAL_MS);
  }

  /**
   * Schedule the click for the NEXT integer beat and, when it fires, schedule the one after it. This
   * keeps a single live event that walks the beat grid at the (possibly changing) shared tempo, instead
   * of pre-baking a finite grid that drifts when the tempo is re-proposed.
   */
  private armNextBeatClick(fromBeat?: number): void {
    if (!this.transport || !this.backend) return;
    // Walk the beat grid. We pick the next integer beat strictly after `fromBeat` (the just-fired beat) or,
    // on the first arm, after the beat the launch point lands on, so the chain never re-arms a passed beat.
    const baseBeat = fromBeat ?? this.beat.beatNow();
    // beatToAudioSec() is an AudioContext-time value. Because the transport position is anchored 1:1 to
    // audio time (see start()), this same value is a valid transport-POSITION seconds — which is exactly
    // what schedule().atSec expects; Transport.tick() then maps atSec -> the click's audio time itself.
    //
    // Subtract the total compensation (auto outputLatency + manual offset) so the click LEAVES
    // THE SPEAKER at the canonical beat time (osc starts earlier; the sound then exits one output-latency
    // later, landing on the beat). The manual offset covers what the browser-reported latency misses
    // (e.g. iOS under-reports). Both are 0 by default, so the uncompensated path is unchanged. We
    // compensate ONLY the audible schedule, never the beat/position math, so the grid stays canonical.
    const comp = this.totalCompSec();
    let nextBeat = Math.floor(baseBeat + 1e-6) + 1;
    let atSec = this.beat.beatToAudioSec(nextBeat) - comp;
    // A large comp (or manual-offset jerk) minus a short count-in can push atSec behind the transport
    // position; such a past event never arms, and since the chain only re-arms from fire() it would stall
    // silently. Walk forward to the next beat still safely in the future. Bounded: comp is clamped to
    // ±0.5 s and atSec rises by 60/bpm each beat, so this converges in 1–2 steps (guard caps runaway).
    const horizon = this.backend.nowSec() + 0.001;
    for (let guard = 0; atSec <= horizon && guard < 10_000; guard += 1) {
      nextBeat += 1;
      atSec = this.beat.beatToAudioSec(nextBeat) - comp;
    }
    const accent = ((nextBeat % this.beat.quantum) + this.beat.quantum) % this.beat.quantum === 0;

    if (this.clickEventId != null) this.transport.unschedule(this.clickEventId);
    this.clickEventId = this.transport.schedule({
      atSec,
      payload: { accent },
      fire: () => {
        // Chain to the following beat. (The Transport fires this at occurrence, on the audio clock.)
        this.armNextBeatClick(nextBeat);
      },
    });
  }

  /** Propose a new shared tempo (leaderless; every peer adopts the newest proposal). */
  setTempo(bpm: number): void {
    this.bpm = Math.max(20, Math.min(300, Math.round(bpm)));
    this.beat.setTempo(this.bpm);
  }

  /** Opt-in, bar-quantized launch: begin the transport (and clicks) at the next quantum boundary. */
  play(): void {
    if (this.playing || !this.transport) return;
    // Quantized launch: both this peer and any peer pressing Play in the SAME bar resolve to the SAME
    // startBeat ⇒ they begin in phase. startAudioSec is that beat's local audio time.
    const { startBeat, startAudioSec, countInBeats } = this.beat.launch();
    this.playing = true;
    this.launchPending = { startBeat };
    // Retain the full launch tuple for the export (count-in length + the exact grid start point).
    this.lastLaunch = { startBeat, startAudioSec, countInBeats };

    // Start the transport AT the quantized launch point: anchor position == audio time at startAudioSec
    // and flip to playing. Until backend time reaches startAudioSec the position is "in the count-in"
    // (clicks before startBeat have a passed atSec ⇒ never arm); the first armed click is startBeat.
    this.transport.applyAnchoredState({
      playState: 'playing',
      positionSec: startAudioSec,
      anchorAudioSec: startAudioSec,
    });
    // Arm the click chain from the launch beat (so the very first audible click IS the bar boundary).
    this.armNextBeatClick(startBeat - 1);
  }

  stop(): void {
    if (!this.playing || !this.transport) return;
    this.playing = false;
    this.launchPending = null;
    if (this.clickEventId != null) {
      this.transport.unschedule(this.clickEventId);
      this.clickEventId = null;
    }
    this.transport.pause();
    this.beat.setLocalPlaying(false);
  }

  // ---- recording -------------------------------------------------------------------------
  /** Begin a fixed-duration recording window that samples offset + captures scheduled clicks. */
  startRecording(): void {
    if (this.recording) return;
    this.recording = true;
    this.recordStartMs = Date.now();
    this.recordEndMs = this.recordStartMs + this.recordDurationMs;
    this.offsetSamples = [];
    this.clickLogStartIndex = this.backend ? this.backend.scheduled.length : 0;

    this.sampleOffset(); // sample immediately at t=0
    this.recordSampleId = setInterval(() => {
      this.sampleOffset();
      if (Date.now() >= this.recordEndMs) this.stopRecording();
    }, OFFSET_SAMPLE_INTERVAL_MS);
  }

  stopRecording(): KillgateExport | null {
    if (!this.recording) return this.lastExport;
    this.recording = false;
    if (this.recordSampleId) {
      clearInterval(this.recordSampleId);
      this.recordSampleId = null;
    }
    this.lastExport = this.buildExport();
    return this.lastExport;
  }

  private sampleOffset(): void {
    const localWallMs = Date.now();
    const serverNowMs = this.relay.serverNowMs();
    this.offsetSamples.push({
      tRelMs: localWallMs - this.recordStartMs,
      localWallMs,
      serverNowMs,
      offsetMs: serverNowMs - localWallMs,
      halfRttMs: this.relay.upMs,
      peerCount: this.beat.peers.size,
      beatNow: this.beat.beatNow(),
    });
  }

  private buildExport(): KillgateExport {
    const clicks = this.backend ? this.backend.scheduled.slice(this.clickLogStartIndex) : [];
    // Read the audio hardware latency LIVE off the context's owner at record time. If audio was never
    // started (no backend) there is no context to read — record explicit nulls, never undefined.
    const lat = this.backend
      ? this.backend.latencySnapshot()
      : { outputLatencySec: null, baseLatencySec: null, sampleRate: null };
    return {
      meta: {
        schema: 'orb-118-killgate/v1',
        sessionId: this.sessionId,
        peerId: this.peerId,
        wsUrl: this.wsUrl,
        sessionEpochMs: this.relay.sessionEpochMs,
        startedAtIso: new Date(this.recordStartMs).toISOString(),
        durationMs: Date.now() - this.recordStartMs,
        // The ADOPTED shared tempo — a peer's proposal updates BeatTimeline.timeline, NOT this.bpm.
        bpm: this.beat.tempoBpm,
        quantum: this.beat.quantum,
        // The audio↔session pin: sessionMsToAudioSec(ms) = (ms - audioToSessionMs)/1000, so
        // audioToSessionMs = -sessionMsToAudioSec(0)*1000. Lets offline analysis project a click's
        // AudioContext seconds onto the session-ms axis the offset samples live on.
        audioToSessionMs: -this.beat.sessionMsToAudioSec(0) * 1000,
        relayOffsetMs: this.relay.serverNowMs() - Date.now(),
        halfRttMs: this.relay.upMs,
        launch: this.lastLaunch ? { ...this.lastLaunch } : null,
        userAgent: navigator.userAgent,
        audioBaseLatencySec: lat.baseLatencySec,
        audioOutputLatencySec: lat.outputLatencySec,
        audioSampleRate: lat.sampleRate,
        latencyCompApplied: this.latencyComp,
        latencyCompSec: this.outputLatencyCompSec(),
        manualOffsetMs: this.manualOffsetMs,
        notes:
          'Scheduling-side data only. True acoustic steadiness requires a manual mic recording of the ' +
          'speaker, time-aligned to scheduledAudioSec. offsetMs should be flat over the window; ' +
          'scheduledAudioSec deltas between consecutive same-accent clicks should equal 60/bpm. ' +
          'CROSS-CLIENT ACOUSTIC COMPARISON (the point of this export): put each click on ONE session-ms ' +
          'axis that INCLUDES audio output latency via ' +
          'acoustic_session_ms(click) = (scheduledAudioSec + audioOutputLatencySec)*1000 + audioToSessionMs. ' +
          'Comparing two clients on that axis yields the expected acoustic offset; subtracting the ' +
          'audioOutputLatencySec term isolates the clock/offset bias from the output-latency difference ' +
          '(the ~32 ms inter-client offset the first recording could not split because these latency ' +
          'fields were undefined). audioOutputLatencySec may be null where the platform omits it (e.g. ' +
          'Safari) — then only baseLatency/sampleRate are available and the latency split is partial. ' +
          'relayOffsetMs/halfRttMs (also per-tick in offsetSamples) give the clock bias directly; ' +
          'launch.{startBeat,startAudioSec,countInBeats} pin each client\'s start point on the beat grid. ' +
          'When meta.latencyCompApplied is true, each click was scheduled meta.latencyCompSec ' +
          'earlier (output-latency compensation), so scheduledAudioSec is the COMPENSATED start and the ' +
          'acoustic formula above lands on the canonical beat time — two clients should then align ' +
          'acoustically. Record A (comp off) and B (comp on) and compare the inter-client acoustic offset. ' +
          'meta.manualOffsetMs is an additional per-device calibration (ms) added on top, to cover output ' +
          'latency the browser under-reports (iOS reported ~12.6 ms when a mic measured ~125 ms): dial it ' +
          'until two devices line up acoustically. scheduledAudioSec already includes both compensations.',
      },
      offsetSamples: this.offsetSamples.slice(),
      scheduledClicks: clicks,
    };
  }

  /** The most recently completed export (for the Export JSON button). */
  getLastExport(): KillgateExport | null {
    return this.lastExport;
  }

  // ---- read model ------------------------------------------------------------------------
  snapshot(): KillgateSnapshot {
    const offsetMs = this.relay.serverNowMs() - Date.now();
    let countInBeats: number | null = null;
    if (this.launchPending) {
      countInBeats = Math.max(0, this.launchPending.startBeat - this.beat.beatNow());
      if (countInBeats <= 0) this.launchPending = null;
    }
    return {
      audioRunning: !!this.ctx,
      joined: this.relay.sessionEpochMs > 0,
      peerCount: this.beat.peers.size,
      offsetMs,
      halfRttMs: this.relay.upMs,
      bpm: this.beat.tempoBpm,
      beatNow: this.beat.beatNow(),
      phaseNow: this.beat.phaseNow(),
      quantum: this.beat.quantum,
      playing: this.playing,
      countInBeats,
      scheduledCount: this.backend?.scheduledCount ?? 0,
      cancelledCount: this.backend?.cancelledCount ?? 0,
      recording: this.recording,
      recordRemainingMs: this.recording ? Math.max(0, this.recordEndMs - Date.now()) : 0,
      latencyComp: this.latencyComp,
      latencyCompMs: this.outputLatencyCompSec() * 1000,
      manualOffsetMs: this.manualOffsetMs,
      totalCompMs: this.totalCompSec() * 1000,
    };
  }

  dispose(): void {
    if (this.pumpId) clearInterval(this.pumpId);
    if (this.pingId) clearInterval(this.pingId);
    if (this.heartbeatId) clearInterval(this.heartbeatId);
    if (this.epochAnchorId) clearInterval(this.epochAnchorId);
    if (this.recordSampleId) clearInterval(this.recordSampleId);
    this.relay?.dispose();
    this.transportRef?.close();
    this.ctx?.close().catch(() => {});
  }
}
