/**
 * WsConnectTransport — a concrete `ConnectTransport` (see ConnectRelay) over a dedicated Connect
 * WebSocket connection. It performs the sync:register → sync:join handshake, queues outbound messages
 * until the session is joined, and fans every inbound server message out to subscribers (ConnectRelay
 * reads sync:joined / sync:pong / sync:beat from that stream).
 *
 * Scope: this opens its OWN Connect connection — correct for the non-React kill-gate
 * harness, where a clean dedicated socket is simplest. Production orbiters should instead SHARE the one
 * existing Connect connection (a client is one peer); that connection-sharing is separate integration work.
 *
 * The WebSocket implementation is injectable (`WebSocketImpl`) so this unit-tests against a fake socket;
 * real network behaviour (RTT, loss, reconnect) is exercised at the clock kill-gate.
 */
import type { ConnectTransport } from './ConnectRelay';

type Listener = (message: Record<string, unknown>) => void;

interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
}

type WebSocketFactory = (url: string) => MinimalWebSocket;

const OPEN = 1;

export interface WsConnectTransportOptions {
  sessionId?: string;
  peerId?: string;
  /** Inject a WebSocket constructor (defaults to the global). Lets tests drive a fake socket. */
  WebSocketImpl?: WebSocketFactory;
}

export class WsConnectTransport implements ConnectTransport {
  readonly #sessionId: string;
  readonly #peerId: string;
  readonly #ws: MinimalWebSocket;
  readonly #listeners = new Set<Listener>();
  readonly #queue: unknown[] = [];
  #joined = false;

  constructor(wsUrl: string, opts: WsConnectTransportOptions = {}) {
    this.#sessionId = opts.sessionId ?? 'orbiters-default';
    this.#peerId = opts.peerId ?? `beat-${Math.random().toString(36).slice(2, 9)}`;
    const WebSocketCtor = (globalThis as unknown as {
      WebSocket: new (u: string) => MinimalWebSocket;
    }).WebSocket;
    const make: WebSocketFactory = opts.WebSocketImpl ?? ((url) => new WebSocketCtor(url));
    this.#ws = make(wsUrl);

    this.#ws.onopen = () => {
      this.#raw({ type: 'sync:register', peerId: this.#peerId, joinedAt: this.now() });
    };
    this.#ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#onInbound(msg);
    };
  }

  // ── ConnectTransport ─────────────────────────────────────────────────────
  now(): number {
    return Date.now();
  }

  onMessage(handler: Listener): () => void {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  /** Send to the server; messages before the session is joined are queued and flushed on join. */
  send(message: unknown): void {
    if (this.#joined && this.#ws.readyState === OPEN) {
      this.#raw(message);
    } else {
      this.#queue.push(message);
    }
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      /* already closing */
    }
    this.#listeners.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────
  #raw(message: unknown): void {
    if (this.#ws.readyState !== OPEN) return;
    try {
      this.#ws.send(JSON.stringify(message));
    } catch {
      /* drop on closed socket */
    }
  }

  #onInbound(msg: Record<string, unknown>): void {
    // Handshake side-effects, then ALWAYS fan out (a transport is a pipe; the relay filters types).
    if (msg.type === 'sync:registered') {
      this.#raw({ type: 'sync:join', sessionId: this.#sessionId, peerId: this.#peerId, joinedAt: this.now() });
    } else if (msg.type === 'sync:joined') {
      this.#joined = true;
      const queued = this.#queue.splice(0);
      for (const m of queued) this.#raw(m);
    }
    for (const l of this.#listeners) l(msg);
  }
}
