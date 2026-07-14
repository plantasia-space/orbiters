/**
 * @file WebSocketSyncAdapter.js
 * @description Tier 2 sync adapter — LAN / multi-machine via Connect WebSocket relay. After the pulse
 * migration this adapter carries only PRESENCE (join / peers / conductor election) plus the
 * raw-message TEE (`onRawMessage`/`sendRaw`) that the room pulse rides. The conductor TEMPO channel
 * (sync:timeline/heartbeat) + the x/y/z param mirror (sync:param) + their RTT latency-correction are
 * removed — tempo replicates leaderlessly over the pulse's own relay (ConnectRelay, which does its own
 * ping/offset over the tee), not here.
 *
 * Protocol (additive to existing Connect messages — handled before the standard register/registered flow):
 *
 *   sync:register    — first message on open; identifies this as a sync-only connection
 *   sync:join        — join a named session; server replies sync:joined
 *   sync:joined      — server confirms join, sends the peer list
 *   sync:peer-joined — server broadcasts when a new peer joins
 *   sync:peer-left   — server broadcasts when a peer leaves or disconnects
 *   sync:leave       — graceful leave
 *
 * Leader election: same as BroadcastChannelAdapter — first active peer is the conductor. `isConductor`
 * is surfaced for the on-screen role label + the iframe export; it no longer gates any tempo path.
 */

const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 5;

export class WebSocketSyncAdapter {
  #ws = null;
  #wsUrl = null;
  #sessionId = 'orbiters-default';
  // peerId + joinedAt are app metadata for conductor election, sent to server as-is
  #peerId = `peer-${Math.random().toString(36).slice(2, 9)}`;
  #joinedAt = Date.now();
  #isConductor = false;
  #knownConductorId = null;
  #joinedExistingSession = false;
  #peers = new Map(); // peerId → joinedAt
  #peerVoiceCounts = new Map(); // peerId → that peer's synced-voice count (for the SYNC badge total)
  #registered = false; // true once server responds with sync:registered
  #peerCountCallback = null;
  #rawMessageCallbacks = new Set(); // Tee — fired for every inbound parsed message
  #sendQueue = []; // messages buffered while WS is connecting
  #reconnectAttempts = 0;
  #reconnectTimer = null; // pending auto-reconnect setTimeout — cancelled on disconnect/destroy
  #destroyed = false;

  /**
   * @param {string} wsUrl — WebSocket URL, e.g. from import.meta.env.VITE_WS_CONNECT
   * @param {string} [sessionId] — sync session name; defaults to 'orbiters-default'
   */
  constructor(wsUrl, sessionId = 'orbiters-default') {
    this.#wsUrl = wsUrl;
    this.#sessionId = sessionId;
  }

  /** @param {(count: number) => void} cb */
  onPeerCount(cb) { this.#peerCountCallback = cb; }

  /**
   * Additive tee: subscribe to EVERY inbound parsed message, in addition to
   * the existing typed handling below. Lets the shared clock (ConnectRelay) ride this
   * SAME Connect socket — one client = one Connect peer — instead of opening a 2nd
   * connection. Does not affect existing callbacks. Returns an unsubscribe fn.
   * @param {(msg: object) => void} cb
   * @returns {() => void}
   */
  onRawMessage(cb) {
    this.#rawMessageCallbacks.add(cb);
    return () => this.#rawMessageCallbacks.delete(cb);
  }

  /**
   * Additive raw send: transmit an arbitrary JSON-serializable message on this
   * socket, buffering until session join completes (same buffering the typed path uses).
   * Lets ConnectRelay publish its sync:beat / sync:ping envelopes over the shared socket.
   * @param {object} obj
   */
  sendRaw(obj) {
    if (this.#ws?.readyState === WebSocket.OPEN && this.#registered) {
      try {
        this.#ws.send(JSON.stringify(obj));
      } catch (e) {
        console.warn('[SyncAdapter:WS] sendRaw failed:', e);
      }
    } else if (!this.#destroyed) {
      // Not yet registered/joined — buffer; flushed by the sync:registered handler.
      this.#sendQueue.push(obj);
    }
  }

  /**
   * Opens the WebSocket and announces this peer to the sync session.
   * Returns true immediately (connection is async); messages are queued
   * until the socket opens.
   * @returns {boolean} false if WebSocket is unavailable or URL is missing
   */
  connect() {
    if (typeof WebSocket === 'undefined') {
      console.warn('[SyncAdapter:WS] WebSocket not available.');
      return false;
    }
    if (!this.#wsUrl) {
      console.warn('[SyncAdapter:WS] No WebSocket URL configured (VITE_WS_CONNECT).');
      return false;
    }
    // Re-enable after a disconnect() (sync toggle off→on) without rebuilding the adapter.
    this.#destroyed = false;
    // Double-connect guard: a socket already open or connecting needs no second open.
    if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) {
      return true;
    }
    this.#openSocket();
    return true;
  }

  /**
   * Leave the session but stay RE-CONNECTABLE (sync toggle off, B4): send sync:leave so peers get a
   * sync:peer-left and decrement their room count, close the socket, and stop the loops — WITHOUT the
   * permanent teardown of destroy() (raw-message subscribers + the room-pulse wiring survive, so a later
   * connect() + pulse.rejoin() re-joins cleanly). `#destroyed` suppresses the auto-reconnect in onclose.
   */
  disconnect() {
    this.#destroyed = true; // suppress onclose auto-reconnect; connect() clears it
    clearTimeout(this.#reconnectTimer); // cancel any pending auto-reconnect (else it would re-join while OFF)
    this.#reconnectTimer = null;
    this.#send({ type: 'sync:leave', sessionId: this.#sessionId }); // tell peers we left BEFORE detaching
    this.#detachSocket(); // detach handlers + close + null #ws (a stale onclose can't re-open)
    this.#registered = false;
    this.#peers.clear();
    this.#peerVoiceCounts.clear();
    this.#isConductor = false;
    this.#knownConductorId = null;
    this.#joinedExistingSession = false;
    this.#sendQueue = [];
    // NOTE: #rawMessageCallbacks deliberately preserved (the room pulse stays subscribed across a toggle).
  }

  get peerCount() { return this.#peers.size; }
  get isConductor() { return this.#isConductor; }

  /** This connection's own peer id — the key OTHER peers announce their voice count under. */
  get selfPeerId() { return this.#peerId; }

  /**
   * Σ of the OTHER peers' announced synced-voice counts (never self). One browser tab = one connection
   * but may host N synced voices, so the badge sums announced voice-counts here instead of counting
   * connections (`peerCount`) — a multi-orbiter tab then counts as its true N, not 1.
   */
  get remoteSyncedVoiceCount() {
    let sum = 0;
    for (const n of this.#peerVoiceCounts.values()) sum += n;
    return sum;
  }

  /**
   * Record a peer's announced synced-voice count (rides the room pulse's `sync:beat` relay, decoded in
   * sharedClock). Ignores self and malformed counts; re-renders the badge only on a real change.
   * @param {string} peerId — the announcing connection's peer id
   * @param {number} count — its synced-voice count (non-negative integer)
   */
  recordPeerVoiceCount(peerId, count) {
    if (!peerId || peerId === this.#peerId) return; // never count self
    if (!this.#peers.has(peerId)) return; // only LIVE peers — a stray/late announce can't resurrect a
                                          // peer we already dropped on sync:peer-left (the heartbeat
                                          // re-announces once a genuine peer is in the set)
    const n = Number(count);
    if (!Number.isInteger(n) || n < 0) return; // drop malformed announces
    if (this.#peerVoiceCounts.get(peerId) === n) return; // no change → no churn
    this.#peerVoiceCounts.set(peerId, n);
    this.#peerCountCallback?.(this.#peers.size); // re-render via the existing peers status fan-out
  }

  destroy() {
    this.#destroyed = true;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#send({ type: 'sync:leave', sessionId: this.#sessionId });
    this.#detachSocket();
    this.#peers.clear();
    this.#peerVoiceCounts.clear();
    this.#isConductor = false;
    this.#knownConductorId = null;
    this.#joinedExistingSession = false;
    this.#sendQueue = [];
    this.#rawMessageCallbacks.clear();
  }

  // ── private ──────────────────────────────────────────────────────────────

  #openSocket() {
    // Detach the prior socket's handlers before replacing it, so a stale socket's late onclose can never
    // resurrect a connection we've moved on from (e.g. a fast off→on toggle, or an auto-reconnect).
    this.#detachSocket();
    let socket;
    try {
      socket = new WebSocket(this.#wsUrl);
      this.#ws = socket;
    } catch (e) {
      console.warn('[SyncAdapter:WS] Failed to open WebSocket:', e);
      return;
    }

    socket.onopen = () => {
      this.#reconnectAttempts = 0;
      this.#registered = false;
      // Step 1: register as a sync-only connection.
      // Server responds with sync:registered; sync:join is sent from #onMessage.
      socket.send(JSON.stringify({
        type: 'sync:register',
        peerId: this.#peerId,       // app metadata for conductor election
        joinedAt: this.#joinedAt,   // app metadata for conductor election
      }));
    };

    socket.onmessage = (event) => {
      try {
        this.#onMessage(JSON.parse(event.data));
      } catch (e) {
        console.warn('[SyncAdapter:WS] Failed to parse message:', e);
      }
    };

    socket.onclose = () => {
      // Only the CURRENT live socket may schedule a reconnect, and never after disconnect()/destroy().
      if (this.#destroyed || socket !== this.#ws) return;
      if (this.#reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.#reconnectAttempts++;
        console.info(`[SyncAdapter:WS] Reconnecting (attempt ${this.#reconnectAttempts})…`);
        this.#reconnectTimer = setTimeout(() => {
          this.#reconnectTimer = null;
          if (this.#destroyed) return; // a disconnect()/destroy() landed while the reconnect was pending
          this.#openSocket();
        }, RECONNECT_DELAY_MS);
      } else {
        console.warn('[SyncAdapter:WS] Max reconnect attempts reached.');
      }
    };

    socket.onerror = (e) => {
      console.warn('[SyncAdapter:WS] WebSocket error:', e);
    };
  }

  /** Detach the current socket's handlers + close it, so its async onclose can't drive our lifecycle. */
  #detachSocket() {
    const ws = this.#ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* already closing/closed */ }
    this.#ws = null;
  }

  // Send a typed control message (sync:leave) immediately if the socket is open; else drop — it's
  // transient. (Buffered-until-join replication rides `sendRaw`/`#sendQueue`, flushed on sync:registered.)
  #send(msg) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      try {
        this.#ws.send(JSON.stringify(msg));
      } catch (e) {
        console.warn('[SyncAdapter:WS] send failed:', e);
      }
    }
  }

  #onMessage(msg) {
    // Tee: fan every inbound parsed message to raw subscribers BEFORE the
    // typed handling (additive — the switch below is unchanged). Isolated so a
    // throwing subscriber can never break the existing sync path.
    if (this.#rawMessageCallbacks.size) {
      for (const cb of this.#rawMessageCallbacks) {
        try {
          cb(msg);
        } catch (e) {
          console.warn('[SyncAdapter:WS] raw subscriber threw:', e);
        }
      }
    }

    switch (msg.type) {
      case 'sync:registered': {
        // Server confirmed our sync-only connection; now join the session
        this.#registered = true;
        this.#ws.send(JSON.stringify({
          type: 'sync:join',
          sessionId: this.#sessionId,
          peerId: this.#peerId,
          joinedAt: this.#joinedAt,
        }));
        // Flush any messages that were queued before registration
        const queued = this.#sendQueue.splice(0);
        queued.forEach((m) => this.#ws.send(JSON.stringify(m)));
        break;
      }

      case 'sync:joined': {
        // Server confirms session join; receive list of existing peers
        const snapshot = Array.isArray(msg.peers) ? msg.peers : [];
        snapshot.forEach(({ peerId, joinedAt }) => {
          if (peerId !== this.#peerId) this.#peers.set(peerId, joinedAt);
        });
        // Reconcile voice counts to this authoritative snapshot: drop any peer not present (covers a
        // sync:peer-left we missed while the socket was down on an auto-reconnect). Present peers
        // re-announce on their heartbeat, so their counts repopulate.
        const present = new Set(snapshot.map((p) => p.peerId));
        for (const id of this.#peerVoiceCounts.keys()) {
          if (!present.has(id)) this.#peerVoiceCounts.delete(id);
        }
        this.#joinedExistingSession = this.#peers.size > 0;
        this.#evaluateConductor();
        this.#peerCountCallback?.(this.#peers.size);
        break;
      }

      case 'sync:peer-joined': {
        if (msg.peerId && msg.peerId !== this.#peerId) {
          this.#peers.set(msg.peerId, msg.joinedAt);
          // force: re-elect even if we already self-elected. Without the (now-removed) conductor
          // heartbeat carrying isConductor, this is the only signal that demotes a peer which elected
          // itself in a near-simultaneous join (both saw an empty peer list) once it learns of an
          // older peer — so the oldest joinedAt is the single conductor (matches BroadcastChannelAdapter).
          this.#evaluateConductor({ force: true });
          this.#peerCountCallback?.(this.#peers.size);
        }
        break;
      }

      case 'sync:peer-left': {
        this.#peers.delete(msg.peerId);
        this.#peerVoiceCounts.delete(msg.peerId); // drop its badge contribution

        if (this.#knownConductorId === msg.peerId) {
          this.#knownConductorId = null;
          this.#joinedExistingSession = false;
        }
        if (this.#peers.size === 0) {
          this.#joinedExistingSession = false;
        }
        this.#evaluateConductor({ force: true });
        this.#peerCountCallback?.(this.#peers.size);
        break;
      }

      default:
        break;
    }
  }

  #evaluateConductor({ force = false } = {}) {
    if (!force && this.#isConductor) return;
    if (this.#knownConductorId && this.#knownConductorId !== this.#peerId) {
      this.#isConductor = false;
      return;
    }
    if (this.#joinedExistingSession && this.#peers.size > 0) {
      this.#isConductor = false;
      return;
    }
    const all = [[this.#peerId, this.#joinedAt], ...this.#peers.entries()];
    const [conductorId] = all.reduce((min, curr) => (
      this.#compareConductorCandidate(curr, min) < 0 ? curr : min
    ));
    this.#isConductor = conductorId === this.#peerId;
    this.#knownConductorId = conductorId;
  }

  #compareConductorCandidate(a, b) {
    const joinedDelta = Number(a[1]) - Number(b[1]);
    if (joinedDelta !== 0) return joinedDelta;
    return String(a[0]).localeCompare(String(b[0]));
  }
}
