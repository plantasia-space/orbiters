/**
 * ConnectRelay — production relay adapter implementing the shared clock's `RelaySeam`
 * (`entangled-worlds-orbiters-shared/clock/sync`) over the Connect WebSocket server.
 *
 * The leaderless `BeatTimeline` depends on this seam for: a shared session clock (`serverNowMs` +
 * `sessionEpochMs`), measured network latency (`upMs`/`downMs`), node registration, and peer message
 * fan-out (`send`). This adapter provides them by:
 *   - reading `sessionEpochMs` + `serverNowMs` from the server's `sync:joined` snapshot to seed the
 *     local↔session clock mapping;
 *   - running periodic `sync:ping`/`sync:pong` where the server stamps `serverNowMs`, and applying
 *     Cristian/SNTP estimation so `serverNowMs()` = local wall time + measured offset;
 *   - relaying `SyncMessage`s as `sync:beat` envelopes that the server broadcasts to session peers,
 *     and delivering inbound ones to every registered node except the original sender.
 *
 * It is transport-decoupled: it talks to a small `ConnectTransport` seam (send / onMessage / now), so
 * it unit-tests against a fake transport and can ride either its own socket or a shared Connect
 * connection. Real two-client timing is proven at the clock kill-gate, not here.
 *
 * PAIRED SERVER WORK (done): the Connect server handles `sync:beat` by broadcasting `msg` to
 * the other session peers (like `sync:param`) and stamps `serverNowMs` on `sync:joined`/`sync:pong`.
 */
import type { RelaySeam, RelayNode, SyncMessage } from 'entangled-worlds-orbiters-shared/clock/sync';

/** The minimal Connect connection surface this adapter needs (injectable for tests + connection reuse). */
export interface ConnectTransport {
  /** Send a JSON-serializable message to the Connect server. */
  send(message: unknown): void;
  /** Subscribe to inbound server messages; returns an unsubscribe fn. */
  onMessage(handler: (message: Record<string, unknown>) => void): () => void;
  /** Local wall-clock time in ms (Date.now in prod; controllable in tests). */
  now(): number;
}

const RTT_SAMPLE_COUNT = 6;
const MAX_PLAUSIBLE_RTT_MS = 2000;

export interface ConnectRelayOptions {
  sessionId?: string;
}

export class ConnectRelay implements RelaySeam {
  sessionEpochMs = 0;
  upMs = 0;
  downMs = 0;

  readonly #transport: ConnectTransport;
  readonly #sessionId: string;
  readonly #nodes = new Map<string, RelayNode>();
  readonly #rttSamples: number[] = [];
  #offsetMs = 0;
  #pendingPingT0: number | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(transport: ConnectTransport, { sessionId = 'orbiters-default' }: ConnectRelayOptions = {}) {
    this.#transport = transport;
    this.#sessionId = sessionId;
    this.#unsubscribe = transport.onMessage((m) => this.#handle(m));
  }

  // ── RelaySeam ──────────────────────────────────────────────────────────────
  /** Current server (session) wall time = local wall time + the measured offset. */
  serverNowMs(): number {
    return this.#transport.now() + this.#offsetMs;
  }

  register(node: RelayNode): void {
    this.#nodes.set(node.id, node);
  }

  /** Publish a beat-timeline message; the server broadcasts it to the other session peers. */
  send(fromId: string, msg: SyncMessage, toId: string | null = null): void {
    this.#transport.send({
      type: 'sync:beat',
      sessionId: this.#sessionId,
      from: fromId,
      to: toId,
      msg,
      senderNow: this.#transport.now(),
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  /** Send an RTT/offset probe; the server reflects it as `sync:pong` with its `serverNowMs` stamp. */
  ping(): void {
    this.#pendingPingT0 = this.#transport.now();
    this.#transport.send({ type: 'sync:ping', sessionId: this.#sessionId, t: this.#pendingPingT0 });
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#nodes.clear();
  }

  // ── inbound ────────────────────────────────────────────────────────────────
  #handle(m: Record<string, unknown>): void {
    switch (m.type) {
      case 'sync:joined': {
        if (Number.isFinite(m.sessionEpochMs)) this.sessionEpochMs = m.sessionEpochMs as number;
        // Seed an immediate (coarse) offset from the join stamp so serverNowMs() is usable before the
        // first ping refines it. RTT is unknown here, so this ignores one-way delay; ping() corrects it.
        if (Number.isFinite(m.serverNowMs)) this.#offsetMs = (m.serverNowMs as number) - this.#transport.now();
        break;
      }
      case 'sync:pong':
        this.#onPong(m);
        break;
      case 'sync:beat':
        this.#deliver(m);
        break;
      default:
        break;
    }
  }

  /** Cristian/SNTP: offset = serverStamp + rtt/2 − t1 (server stamped ~midpoint). Median-smoothed RTT. */
  #onPong(m: Record<string, unknown>): void {
    const t0 = Number(m.t);
    const serverStamp = Number(m.serverNowMs);
    if (this.#pendingPingT0 != null && t0 === this.#pendingPingT0) this.#pendingPingT0 = null;

    const t1 = this.#transport.now();
    const rtt = t1 - t0;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_PLAUSIBLE_RTT_MS) return;

    this.#rttSamples.push(rtt);
    if (this.#rttSamples.length > RTT_SAMPLE_COUNT) this.#rttSamples.shift();
    const sorted = [...this.#rttSamples].sort((a, b) => a - b);
    const medianRtt = sorted[Math.floor(sorted.length / 2)];
    // Symmetric leg assumption (single relay): up ≈ down ≈ rtt/2.
    this.upMs = this.downMs = medianRtt / 2;

    if (Number.isFinite(serverStamp)) this.#offsetMs = serverStamp + rtt / 2 - t1;
  }

  /** Deliver an inbound beat-timeline message to every registered node except its sender / non-target. */
  #deliver(m: Record<string, unknown>): void {
    const from = typeof m.from === 'string' ? m.from : null;
    const to = typeof m.to === 'string' ? m.to : null;
    const msg = m.msg as SyncMessage | undefined;
    if (!msg) return;
    for (const [id, node] of this.#nodes) {
      if (from && id === from) continue; // don't echo to the sender
      if (to && id !== to) continue; // targeted delivery
      node.receive(msg);
    }
  }
}
