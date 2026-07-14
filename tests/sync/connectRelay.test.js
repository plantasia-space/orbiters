import { describe, it, expect } from 'vitest';
import { ConnectRelay } from '../../src/sync/adapters/ConnectRelay.ts';

/** A controllable Connect transport: fixed clock, captured outbound, manual inbound. */
function fakeTransport(startNow = 1000) {
  let now = startNow;
  const sent = [];
  let handler = () => {};
  return {
    sent,
    setNow: (n) => { now = n; },
    advance: (d) => { now += d; },
    emit: (m) => handler(m),
    transport: {
      send: (m) => sent.push(m),
      onMessage: (cb) => { handler = cb; return () => { handler = () => {}; }; },
      now: () => now,
    },
  };
}

function makeNode(id) {
  const received = [];
  return { node: { id, online: true, localWallMs: () => 0, receive: (m) => received.push(m) }, received };
}

describe('ConnectRelay — RelaySeam over Connect', () => {
  it('captures sessionEpochMs and seeds a coarse offset from sync:joined', () => {
    const t = fakeTransport(1000);
    const relay = new ConnectRelay(t.transport, { sessionId: 's1' });

    t.emit({ type: 'sync:joined', sessionEpochMs: 5000, serverNowMs: 1234 });

    expect(relay.sessionEpochMs).toBe(5000);
    // offset = serverNowMs - localNow = 1234 - 1000 = 234 → serverNowMs() = now + offset
    expect(relay.serverNowMs()).toBe(1234);
    t.advance(10);
    expect(relay.serverNowMs()).toBe(1244);
  });

  it('refines the offset + RTT legs via Cristian on ping/pong', () => {
    const t = fakeTransport(1000);
    const relay = new ConnectRelay(t.transport, { sessionId: 's1' });

    relay.ping();
    expect(t.sent.at(-1)).toMatchObject({ type: 'sync:ping', t: 1000 });

    t.advance(40); // t1 = 1040, rtt = 40
    t.emit({ type: 'sync:pong', t: 1000, serverNowMs: 2000 });

    // up = down = rtt/2 = 20; offset = serverStamp + rtt/2 - t1 = 2000 + 20 - 1040 = 980
    expect(relay.upMs).toBe(20);
    expect(relay.downMs).toBe(20);
    expect(relay.serverNowMs()).toBe(1040 + 980); // 2020
  });

  it('ignores implausible RTT pongs (too large)', () => {
    const t = fakeTransport(1000);
    const relay = new ConnectRelay(t.transport, { sessionId: 's1' });
    relay.ping();
    t.advance(5000); // rtt = 5000 > 2000 → rejected
    t.emit({ type: 'sync:pong', t: 1000, serverNowMs: 2000 });
    expect(relay.upMs).toBe(0); // unchanged
  });

  it('send() emits a sync:beat envelope carrying the message', () => {
    const t = fakeTransport(1000);
    const relay = new ConnectRelay(t.transport, { sessionId: 's1' });
    const msg = { kind: 'beat:hello', id: 'A' };

    relay.send('A', msg);

    expect(t.sent.at(-1)).toMatchObject({
      type: 'sync:beat',
      sessionId: 's1',
      from: 'A',
      to: null,
      msg,
      senderNow: 1000,
    });
  });

  it('delivers inbound sync:beat to other nodes, never echoes to the sender', () => {
    const t = fakeTransport();
    const relay = new ConnectRelay(t.transport, { sessionId: 's1' });
    const a = makeNode('A');
    const b = makeNode('B');
    relay.register(a.node);
    relay.register(b.node);

    const msg = { kind: 'beat:transport', id: 'A', playing: true, atSessionMs: 42 };
    t.emit({ type: 'sync:beat', from: 'A', to: null, msg });

    expect(a.received).toHaveLength(0); // sender doesn't receive its own
    expect(b.received).toEqual([msg]);
  });

  it('respects targeted (to) delivery', () => {
    const t = fakeTransport();
    const relay = new ConnectRelay(t.transport, { sessionId: 's1' });
    const a = makeNode('A');
    const b = makeNode('B');
    const c = makeNode('C');
    [a, b, c].forEach((n) => relay.register(n.node));

    const msg = { kind: 'beat:hello', id: 'A' };
    t.emit({ type: 'sync:beat', from: 'A', to: 'B', msg });

    expect(b.received).toEqual([msg]);
    expect(c.received).toHaveLength(0);
    expect(a.received).toHaveLength(0);
  });
});
