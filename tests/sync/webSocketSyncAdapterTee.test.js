import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketSyncAdapter } from '../../src/sync/adapters/WebSocketSyncAdapter.js';
import { WebSocketSyncAdapterTransport } from '../../src/sync/adapters/WebSocketSyncAdapterTransport.js';

/** A minimal global WebSocket stub the test drives manually (open, deliver inbound, inspect outbound). */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last = null;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    FakeWebSocket.last = this;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // ── test helpers ──
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  deliver(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe('WebSocketSyncAdapter additive tee + sendRaw', () => {
  beforeEach(() => {
    globalThis.WebSocket = FakeWebSocket;
    FakeWebSocket.last = null;
  });
  afterEach(() => {
    delete globalThis.WebSocket;
  });

  it('onRawMessage fires for every inbound parsed message (and unsubscribes)', () => {
    const adapter = new WebSocketSyncAdapter('wss://x/ws', 'room1');
    const seen = [];
    const unsub = adapter.onRawMessage((m) => seen.push(m.type));

    adapter.connect();
    const ws = FakeWebSocket.last;
    ws.open();
    ws.deliver({ type: 'sync:registered' });
    ws.deliver({ type: 'sync:joined', peers: [] });
    ws.deliver({ type: 'sync:beat', from: 'p2', msg: { kind: 'beat:hello', id: 'p2' } });

    expect(seen).toEqual(['sync:registered', 'sync:joined', 'sync:beat']);

    unsub();
    ws.deliver({ type: 'sync:pong', t: 1 });
    expect(seen).toEqual(['sync:registered', 'sync:joined', 'sync:beat']); // unchanged after unsub
  });

  it('does not disturb the existing typed handling (peer count still tracked)', () => {
    const adapter = new WebSocketSyncAdapter('wss://x/ws', 'room1');
    let peerCount = -1;
    adapter.onPeerCount((c) => { peerCount = c; });
    adapter.onRawMessage(() => { throw new Error('raw subscriber boom'); }); // must be isolated

    adapter.connect();
    const ws = FakeWebSocket.last;
    ws.open();
    ws.deliver({ type: 'sync:registered' });
    ws.deliver({ type: 'sync:joined', peers: [{ peerId: 'a', joinedAt: 1 }, { peerId: 'b', joinedAt: 2 }] });

    expect(peerCount).toBe(2); // a throwing raw subscriber did not break the typed path
  });

  it('sendRaw buffers until joined, flushes in order, then sends immediately', () => {
    const adapter = new WebSocketSyncAdapter('wss://x/ws', 'room1');
    adapter.connect();
    const ws = FakeWebSocket.last;

    adapter.sendRaw({ type: 'sync:beat', n: 1 }); // pre-open → queued
    ws.open();
    adapter.sendRaw({ type: 'sync:beat', n: 2 }); // open but not registered → queued
    expect(ws.sent.filter((m) => m.type === 'sync:beat')).toHaveLength(0);

    ws.deliver({ type: 'sync:registered' }); // sends sync:join, then flushes the queue in order
    const beats = ws.sent.filter((m) => m.type === 'sync:beat');
    expect(beats.map((b) => b.n)).toEqual([1, 2]);

    adapter.sendRaw({ type: 'sync:ping', t: 5 }); // registered → immediate
    expect(ws.sent.at(-1)).toMatchObject({ type: 'sync:ping', t: 5 });
  });
});

describe('WebSocketSyncAdapter — synced-voice count aggregation (SYNC badge)', () => {
  beforeEach(() => {
    globalThis.WebSocket = FakeWebSocket;
    FakeWebSocket.last = null;
  });
  afterEach(() => {
    delete globalThis.WebSocket;
  });

  const joinWithPeers = (adapter, peers) => {
    adapter.connect();
    const ws = FakeWebSocket.last;
    ws.open();
    ws.deliver({ type: 'sync:registered' });
    ws.deliver({ type: 'sync:joined', peers });
    return ws;
  };

  it('sums other peers’ announced voice counts; ignores self and malformed', () => {
    const adapter = new WebSocketSyncAdapter('wss://x/ws', 'room1');
    joinWithPeers(adapter, [{ peerId: 'a', joinedAt: 1 }, { peerId: 'b', joinedAt: 2 }]);

    adapter.recordPeerVoiceCount('a', 3);
    adapter.recordPeerVoiceCount('b', 1);
    expect(adapter.remoteSyncedVoiceCount).toBe(4);

    adapter.recordPeerVoiceCount(adapter.selfPeerId, 9); // self — never counted
    adapter.recordPeerVoiceCount('c', -1); // negative — dropped
    adapter.recordPeerVoiceCount('c', 2.5); // non-integer — dropped
    adapter.recordPeerVoiceCount('c', 'x'); // non-numeric — dropped
    expect(adapter.remoteSyncedVoiceCount).toBe(4);
  });

  it('re-renders (peer-count callback) only on a real change', () => {
    const adapter = new WebSocketSyncAdapter('wss://x/ws', 'room1');
    joinWithPeers(adapter, [{ peerId: 'a', joinedAt: 1 }]);
    let renders = 0;
    adapter.onPeerCount(() => { renders += 1; });

    adapter.recordPeerVoiceCount('a', 2);
    adapter.recordPeerVoiceCount('a', 2); // same → no churn
    expect(renders).toBe(1);
    adapter.recordPeerVoiceCount('a', 3); // changed → re-render
    expect(renders).toBe(2);
  });

  it('drops a peer’s contribution on sync:peer-left', () => {
    const adapter = new WebSocketSyncAdapter('wss://x/ws', 'room1');
    const ws = joinWithPeers(adapter, [{ peerId: 'a', joinedAt: 1 }, { peerId: 'b', joinedAt: 2 }]);
    adapter.recordPeerVoiceCount('a', 3);
    adapter.recordPeerVoiceCount('b', 2);
    expect(adapter.remoteSyncedVoiceCount).toBe(5);

    ws.deliver({ type: 'sync:peer-left', peerId: 'a' });
    expect(adapter.remoteSyncedVoiceCount).toBe(2); // a's 3 dropped
  });

  it('ignores counts from a peer not in the live set (no resurrection after leave)', () => {
    const adapter = new WebSocketSyncAdapter('wss://x/ws', 'room1');
    const ws = joinWithPeers(adapter, [{ peerId: 'a', joinedAt: 1 }]);
    adapter.recordPeerVoiceCount('a', 3);
    expect(adapter.remoteSyncedVoiceCount).toBe(3);

    adapter.recordPeerVoiceCount('ghost', 5); // never joined → not counted
    expect(adapter.remoteSyncedVoiceCount).toBe(3);

    ws.deliver({ type: 'sync:peer-left', peerId: 'a' });
    adapter.recordPeerVoiceCount('a', 9); // a late in-flight announce after leave must not resurrect a
    expect(adapter.remoteSyncedVoiceCount).toBe(0);
  });

  it('reconciles stale counts to the sync:joined snapshot (missed leave on reconnect)', () => {
    const adapter = new WebSocketSyncAdapter('wss://x/ws', 'room1');
    const ws = joinWithPeers(adapter, [{ peerId: 'a', joinedAt: 1 }, { peerId: 'b', joinedAt: 2 }]);
    adapter.recordPeerVoiceCount('a', 3);
    adapter.recordPeerVoiceCount('b', 2);
    expect(adapter.remoteSyncedVoiceCount).toBe(5);

    // Socket drops and auto-reconnects; while offline b left, so the fresh snapshot omits b.
    ws.deliver({ type: 'sync:joined', peers: [{ peerId: 'a', joinedAt: 1 }] });
    expect(adapter.remoteSyncedVoiceCount).toBe(3); // b's stale 2 dropped, a's 3 kept
  });

  it('clears all counts on disconnect', () => {
    const adapter = new WebSocketSyncAdapter('wss://x/ws', 'room1');
    joinWithPeers(adapter, [{ peerId: 'a', joinedAt: 1 }]);
    adapter.recordPeerVoiceCount('a', 4);
    expect(adapter.remoteSyncedVoiceCount).toBe(4);

    adapter.disconnect();
    expect(adapter.remoteSyncedVoiceCount).toBe(0);
  });
});

describe('WebSocketSyncAdapterTransport bridge', () => {
  it('bridges send→sendRaw, onMessage→onRawMessage(unsub), now→Date.now', () => {
    const sent = [];
    const handlers = new Set();
    let unsubbed = false;
    const mockAdapter = {
      sendRaw: (m) => sent.push(m),
      onRawMessage: (cb) => {
        handlers.add(cb);
        return () => { handlers.delete(cb); unsubbed = true; };
      },
    };

    const t = new WebSocketSyncAdapterTransport(mockAdapter);
    t.send({ a: 1 });
    expect(sent).toEqual([{ a: 1 }]);

    let got = null;
    const off = t.onMessage((m) => { got = m; });
    handlers.forEach((h) => h({ type: 'x' }));
    expect(got).toEqual({ type: 'x' });

    off();
    expect(unsubbed).toBe(true);

    expect(typeof t.now()).toBe('number');
    expect(t.now()).toBeGreaterThan(0);
  });
});
