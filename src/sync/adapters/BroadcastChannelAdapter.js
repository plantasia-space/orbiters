/**
 * @file BroadcastChannelAdapter.js
 * @description Tier 1 sync adapter — same-origin tabs/iframes on the same machine. After the pulse migration
 * it carries only PRESENCE (hello/present/bye + conductor election). The conductor TEMPO channel
 * (sync:timeline/heartbeat) + the x/y/z param mirror (sync:param) are removed — in-tab tempo is shared
 * via the one pulse (a LocalRelay singleton), not these messages.
 *
 * Protocol:
 *   sync:hello    — new tab announces itself; existing tabs respond with sync:present
 *   sync:present  — existing tab announces itself (no further response triggered)
 *   sync:bye      — tab is closing
 *
 * Leader election: first active tab is the conductor. `isConductor` is surfaced for the on-screen role
 * label + the iframe export; it no longer gates any tempo path.
 */

const CHANNEL_NAME = 'orbiters:sync';

export class BroadcastChannelAdapter {
  #channel = null;
  #tabId = `tab-${Math.random().toString(36).slice(2, 9)}`;
  #joinedAt = Date.now();
  #isConductor = false;
  #knownConductorId = null;
  #peers = new Map(); // tabId → joinedAt
  #peerCountCallback = null;

  /**
   * Opens the channel, announces this tab, and starts conductor election.
   * @returns {boolean} false if BroadcastChannel is unavailable
   */
  connect() {
    if (typeof BroadcastChannel === 'undefined') {
      console.warn('[SyncAdapter:BC] BroadcastChannel not available in this context.');
      return false;
    }
    this.#channel = new BroadcastChannel(CHANNEL_NAME);
    this.#channel.onmessage = (e) => this.#onMessage(e.data);

    // Announce ourselves — existing peers will respond with sync:present
    this.#broadcast({ type: 'sync:hello', tabId: this.#tabId, joinedAt: this.#joinedAt });

    // After 100ms assume we've heard from all existing peers, elect conductor
    setTimeout(() => this.#evaluateConductor(), 100);
    return true;
  }

  /** @param {(count: number) => void} cb */
  onPeerCount(cb) {
    this.#peerCountCallback = cb;
  }

  get peerCount() {
    return this.#peers.size;
  }

  get isConductor() {
    return this.#isConductor;
  }

  destroy() {
    this.#broadcast({ type: 'sync:bye', tabId: this.#tabId });
    this.#channel?.close();
    this.#channel = null;
    this.#peers.clear();
    this.#isConductor = false;
    this.#knownConductorId = null;
  }

  // ── private ──────────────────────────────────────────────────────────────

  #broadcast(msg) {
    try {
      this.#channel?.postMessage(msg);
    } catch (e) {
      console.warn('[SyncAdapter:BC] postMessage failed:', e);
    }
  }

  #onMessage(msg) {
    switch (msg.type) {
      case 'sync:hello': {
        const isNew = !this.#peers.has(msg.tabId);
        this.#peers.set(msg.tabId, msg.joinedAt);
        if (isNew) {
          // Introduce ourselves — sync:present never triggers a further response
          this.#broadcast({
            type: 'sync:present',
            tabId: this.#tabId,
            joinedAt: this.#joinedAt,
            isConductor: this.#isConductor,
          });
          this.#evaluateConductor();
          this.#peerCountCallback?.(this.#peers.size);
        }
        break;
      }
      case 'sync:present': {
        const isNew = !this.#peers.has(msg.tabId);
        this.#peers.set(msg.tabId, msg.joinedAt);
        if (msg.isConductor === true && msg.tabId !== this.#tabId) {
          this.#knownConductorId = msg.tabId;
        }
        if (isNew) {
          this.#evaluateConductor();
          this.#peerCountCallback?.(this.#peers.size);
        }
        break;
      }
      case 'sync:bye': {
        this.#peers.delete(msg.tabId);
        if (this.#knownConductorId === msg.tabId) {
          this.#knownConductorId = null;
        }
        this.#evaluateConductor({ force: true });
        this.#peerCountCallback?.(this.#peers.size);
        break;
      }
    }
  }

  #evaluateConductor({ force = false } = {}) {
    if (!force && this.#isConductor) return;
    if (this.#knownConductorId && this.#knownConductorId !== this.#tabId) {
      this.#isConductor = false;
      return;
    }
    // Oldest tab wins; tabId breaks same-millisecond joins consistently.
    const all = [[this.#tabId, this.#joinedAt], ...this.#peers.entries()];
    const [conductorId] = all.reduce((min, curr) => (
      this.#compareConductorCandidate(curr, min) < 0 ? curr : min
    ));
    this.#isConductor = conductorId === this.#tabId;
    this.#knownConductorId = conductorId;
  }

  #compareConductorCandidate(a, b) {
    const joinedDelta = Number(a[1]) - Number(b[1]);
    if (joinedDelta !== 0) return joinedDelta;
    return String(a[0]).localeCompare(String(b[0]));
  }
}
