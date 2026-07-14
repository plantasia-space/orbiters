// @vitest-environment jsdom
/**
 * The `connection` EngineContext surface — a facade over the singleton WebRTCManager for
 * the sensor device-pairing button. Reflects live-connection state (was hardcoded false → the
 * button showed "disconnected" while connected), re-reads on the `orbiters:connection-changed`
 * document event, and opens the pairing modal on click. Resolved through a LAZY provider (the
 * manager is built with SensorController on first Sensors-panel use).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

function makeManager(connected = false) {
  return {
    isConnected: connected,
    handleConnectionButtonClick: vi.fn(),
  };
}

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('connection surface — WebRTC facade', () => {
  it('reflects isConnected and opens the pairing modal on connect', () => {
    const mgr = makeManager(true);
    const { connection } = createEngineContext({ parameterManager: pm, webRtcProvider: () => mgr });
    expect(connection.available()).toBe(true);
    expect(connection.isConnected()).toBe(true);

    connection.openConnect();
    expect(mgr.handleConnectionButtonClick).toHaveBeenCalledTimes(1);
  });

  it('is unavailable + safe with no manager (pre-init / mobile / tests)', () => {
    const { connection } = createEngineContext({ parameterManager: pm, webRtcProvider: () => null });
    expect(connection.available()).toBe(false);
    expect(connection.isConnected()).toBe(false);
    expect(() => connection.openConnect()).not.toThrow();
  });

  it('resolves the manager LAZILY so one created after mount works', () => {
    let live = null;
    const { connection } = createEngineContext({ parameterManager: pm, webRtcProvider: () => live });
    expect(connection.available()).toBe(false);
    live = makeManager(true);
    expect(connection.available()).toBe(true);
    expect(connection.isConnected()).toBe(true);
  });

  it('reads the CURRENT isConnected on every call (reflects a later connect)', () => {
    const mgr = makeManager(false);
    const { connection } = createEngineContext({ parameterManager: pm, webRtcProvider: () => mgr });
    expect(connection.isConnected()).toBe(false);
    mgr.isConnected = true; // data channel opened
    expect(connection.isConnected()).toBe(true);
  });
});

describe('connection surface — subscribe re-read triggers', () => {
  it('fires on orbiters:connection-changed, stops after unsubscribe', () => {
    const { connection } = createEngineContext({ parameterManager: pm, webRtcProvider: () => makeManager() });
    const listener = vi.fn();
    const unsubscribe = connection.subscribe(listener);

    document.dispatchEvent(new CustomEvent('orbiters:connection-changed', { detail: { connected: true } }));
    document.dispatchEvent(new CustomEvent('orbiters:connection-changed', { detail: { connected: false } }));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    document.dispatchEvent(new CustomEvent('orbiters:connection-changed', { detail: { connected: true } }));
    expect(listener).toHaveBeenCalledTimes(2); // no more after unsubscribe
  });
});
