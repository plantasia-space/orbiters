/**
 * @file sync/adapters/WebSocketSyncAdapterTransport.js
 * @description A `ConnectTransport` (the seam ConnectRelay talks to) backed by an
 * EXISTING WebSocketSyncAdapter, so the shared clock rides the SAME Connect socket the app
 * already holds (one client = one Connect peer) instead of opening a second connection the way
 * WsConnectTransport does (that one is only for the standalone clock kill-gate harness).
 *
 * It bridges the three-method ConnectTransport contract onto the adapter's additive tee:
 *   send(message)  → adapter.sendRaw(message)     (buffers until the session join completes)
 *   onMessage(cb)  → adapter.onRawMessage(cb)      (every inbound parsed message; returns unsub)
 *   now()          → Date.now()                    (wall clock; ConnectRelay measures the offset)
 *
 * ConnectRelay owns the only RTT/offset loop on this socket (its ping/pong over the tee); the adapter
 * no longer runs one of its own (the pulse migration removed the conductor-timeline latency correction).
 */
export class WebSocketSyncAdapterTransport {
  #adapter;

  /** @param {import('./WebSocketSyncAdapter.js').WebSocketSyncAdapter} adapter */
  constructor(adapter) {
    this.#adapter = adapter;
  }

  /** @param {unknown} message */
  send(message) {
    this.#adapter.sendRaw(message);
  }

  /**
   * @param {(message: Record<string, unknown>) => void} handler
   * @returns {() => void} unsubscribe
   */
  onMessage(handler) {
    return this.#adapter.onRawMessage(handler);
  }

  /** @returns {number} local wall-clock time in ms */
  now() {
    return Date.now();
  }
}
