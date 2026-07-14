import { describe, it, expect } from 'vitest';
import { WsConnectTransport } from '../../src/sync/adapters/WsConnectTransport.ts';

/** A fake WebSocket the test drives manually (open, deliver inbound, inspect outbound). */
function fakeWs() {
  const ws = {
    readyState: 0, // CONNECTING
    sent: [],
    send(data) { this.sent.push(JSON.parse(data)); },
    close() { this.readyState = 3; },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return ws;
}

function makeTransport(ws, opts = {}) {
  return new WsConnectTransport('wss://connect.test/ws', { WebSocketImpl: () => ws, sessionId: 's1', peerId: 'P', ...opts });
}

const types = (ws) => ws.sent.map((m) => m.type);

describe('WsConnectTransport — Connect handshake + queue + fan-out', () => {
  it('registers on open, then joins on sync:registered', () => {
    const ws = fakeWs();
    makeTransport(ws);

    ws.readyState = 1; // OPEN
    ws.onopen();
    expect(ws.sent.at(-1)).toMatchObject({ type: 'sync:register', peerId: 'P' });

    ws.onmessage({ data: JSON.stringify({ type: 'sync:registered' }) });
    expect(ws.sent.at(-1)).toMatchObject({ type: 'sync:join', sessionId: 's1', peerId: 'P' });
  });

  it('queues sends until joined, then flushes them in order', () => {
    const ws = fakeWs();
    const t = makeTransport(ws);
    ws.readyState = 1;
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ type: 'sync:registered' }) });

    // not joined yet → queued
    t.send({ type: 'sync:beat', n: 1 });
    t.send({ type: 'sync:beat', n: 2 });
    expect(types(ws)).not.toContain('sync:beat');

    ws.onmessage({ data: JSON.stringify({ type: 'sync:joined', sessionEpochMs: 10, serverNowMs: 20 }) });
    const beats = ws.sent.filter((m) => m.type === 'sync:beat').map((m) => m.n);
    expect(beats).toEqual([1, 2]);

    // after joined, sends go straight through
    t.send({ type: 'sync:beat', n: 3 });
    expect(ws.sent.at(-1)).toMatchObject({ type: 'sync:beat', n: 3 });
  });

  it('fans every inbound message out to subscribers (incl. sync:joined)', () => {
    const ws = fakeWs();
    const t = makeTransport(ws);
    const seen = [];
    t.onMessage((m) => seen.push(m.type));

    ws.readyState = 1;
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ type: 'sync:registered' }) });
    ws.onmessage({ data: JSON.stringify({ type: 'sync:joined', sessionEpochMs: 1, serverNowMs: 2 }) });
    ws.onmessage({ data: JSON.stringify({ type: 'sync:beat', from: 'X', msg: { kind: 'beat:hello', id: 'X' } }) });

    expect(seen).toEqual(['sync:registered', 'sync:joined', 'sync:beat']);
  });

  it('ignores malformed inbound JSON without throwing', () => {
    const ws = fakeWs();
    const t = makeTransport(ws);
    const seen = [];
    t.onMessage((m) => seen.push(m));
    expect(() => ws.onmessage({ data: '{not json' })).not.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('now() returns a finite timestamp', () => {
    const t = makeTransport(fakeWs());
    expect(Number.isFinite(t.now())).toBe(true);
  });
});
