// @vitest-environment jsdom
/**
 * The per-PLAYER, per-session metronome enabled store — deliberately NOT persisted. Each voice owns
 * an independent flag (single-orbiter uses the null slot), so players' metronomes never link.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isMetronomeEnabled,
  setMetronomeEnabled,
  METRONOME_CHANGED_EVENT,
  __resetMetronomeCacheForTests,
} from '../../src/config/metronome.js';

beforeEach(() => {
  __resetMetronomeCacheForTests();
});

describe('metronome enabled store', () => {
  it('defaults to off', () => {
    expect(isMetronomeEnabled()).toBe(false);
  });

  it('is not read from localStorage or the URL — session only', () => {
    window.localStorage.setItem('metronomeEnabled', '1');
    window.history.replaceState({}, '', `${window.location.pathname}?metronome=1`);
    expect(isMetronomeEnabled()).toBe(false);
    window.localStorage.removeItem('metronomeEnabled');
    window.history.replaceState({}, '', window.location.pathname);
  });

  it('set dispatches the change event but does not persist', () => {
    const seen = [];
    const onChange = (e) => seen.push(e.detail.enabled);
    window.addEventListener(METRONOME_CHANGED_EVENT, onChange);
    setMetronomeEnabled(true);
    window.removeEventListener(METRONOME_CHANGED_EVENT, onChange);
    expect(seen).toEqual([true]);
    expect(isMetronomeEnabled()).toBe(true);
    expect(window.localStorage.getItem('metronomeEnabled')).toBeNull();
  });

  it('resets to off between test/session boundaries', () => {
    setMetronomeEnabled(true);
    __resetMetronomeCacheForTests();
    expect(isMetronomeEnabled()).toBe(false);
  });
});

describe('metronome enabled store — per-player flags', () => {
  it('flags are independent per voice: A on, B off, both on — never linked', () => {
    setMetronomeEnabled(true, 'voice-a');
    expect(isMetronomeEnabled('voice-a')).toBe(true);
    expect(isMetronomeEnabled('voice-b')).toBe(false);
    expect(isMetronomeEnabled()).toBe(false); // the single-orbiter slot is its own flag too

    setMetronomeEnabled(true, 'voice-b');
    expect(isMetronomeEnabled('voice-a')).toBe(true);
    expect(isMetronomeEnabled('voice-b')).toBe(true);

    setMetronomeEnabled(false, 'voice-a');
    expect(isMetronomeEnabled('voice-a')).toBe(false);
    expect(isMetronomeEnabled('voice-b')).toBe(true); // turning A off leaves B untouched
  });

  it('the change event carries the voiceId so only that player reacts', () => {
    const seen = [];
    const onChange = (e) => seen.push({ enabled: e.detail.enabled, voiceId: e.detail.voiceId });
    window.addEventListener(METRONOME_CHANGED_EVENT, onChange);
    setMetronomeEnabled(true, 'voice-a');
    setMetronomeEnabled(false, 'voice-b');
    window.removeEventListener(METRONOME_CHANGED_EVENT, onChange);
    expect(seen).toEqual([
      { enabled: true, voiceId: 'voice-a' },
      { enabled: false, voiceId: 'voice-b' },
    ]);
  });
});

