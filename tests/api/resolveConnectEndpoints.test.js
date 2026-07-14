// @vitest-environment jsdom
/**
 * The Connect endpoint resolver: standalone Vite inlines VITE_CONNECT_URL / VITE_WS_CONNECT, but the
 * host-embedded feed realm (root's webpack) has neither, so it must fall back to a host-injected global
 * and finally DERIVE dev-vs-prod from the host — otherwise a dev feed pairs a phone against PROD connect.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveConnectEndpoints } from '../../src/api/WebRTCManager.js';

function setHost(hostname) {
  // jsdom's location is read-only; redefine just the hostname for the test.
  Object.defineProperty(window, 'location', {
    value: { hostname, origin: `https://${hostname}` },
    configurable: true,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.VITE_CONNECT_URL;
  delete window.VITE_WS_CONNECT;
  delete window.ORBITER_APP_URL;
  setHost('example.test');
});

describe('resolveConnectEndpoints', () => {
  it('prefers the Vite build env when present (standalone orbiters)', () => {
    vi.stubEnv('VITE_CONNECT_URL', 'https://dev-connect.plantasia.space/');
    vi.stubEnv('VITE_WS_CONNECT', 'wss://dev-connect.plantasia.space/ws/');
    setHost('anything.example'); // env wins regardless of host
    expect(resolveConnectEndpoints()).toEqual({
      baseUrl: 'https://dev-connect.plantasia.space/',
      wsUrl: 'wss://dev-connect.plantasia.space/ws/',
    });
  });

  it('uses a host-injected window global when the Vite env is absent (host-embedded, root-provided)', () => {
    window.VITE_CONNECT_URL = 'https://dev-connect.plantasia.space/';
    window.VITE_WS_CONNECT = 'wss://dev-connect.plantasia.space/ws/';
    setHost('plantasia.space'); // prod-looking host, but the injected global wins
    expect(resolveConnectEndpoints().baseUrl).toBe('https://dev-connect.plantasia.space/');
  });

  it('derives dev-connect from a dev host when nothing is injected', () => {
    setHost('dev.plantasia.space');
    expect(resolveConnectEndpoints()).toEqual({
      baseUrl: 'https://dev-connect.plantasia.space/',
      wsUrl: 'wss://dev-connect.plantasia.space/ws/',
    });
  });

  it('derives dev-connect from a dev-prefixed injected orbiter app url', () => {
    setHost('plantasia.space'); // page host has no dev marker...
    window.ORBITER_APP_URL = 'https://dev-orbiters.plantasia.space/?graphics=high'; // ...but the orbiter url does
    expect(resolveConnectEndpoints().baseUrl).toBe('https://dev-connect.plantasia.space/');
  });

  it('defaults to prod connect on a plain prod host (no dev marker)', () => {
    setHost('plantasia.space');
    expect(resolveConnectEndpoints()).toEqual({
      baseUrl: 'https://connect.plantasia.space/',
      wsUrl: 'wss://connect.plantasia.space/ws/',
    });
  });

  it('does NOT treat a prod host that merely contains the letters "dev" as dev', () => {
    setHost('developers.plantasia.space'); // "dev" is not a standalone label here
    expect(resolveConnectEndpoints().baseUrl).toBe('https://connect.plantasia.space/');
  });
});
