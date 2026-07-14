/**
 * The per-module visual-feedback store: one switch per (dimension, axis) module,
 * per voice. Coverage: everything is on until something is switched off (absent
 * voice / dimension / axis all read as enabled), the descriptor only carries what
 * was chosen, hydration tolerates a missing or malformed session key, unknown keys
 * on an axis survive a write (so an amount can join `enabled` later without a
 * migration), and subscribers hear the voice that changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isVisualFeedbackEnabled,
  setVisualFeedbackEnabled,
  hydrateVisualFeedback,
  getVisualFeedbackDescriptor,
  clearVisualFeedback,
  subscribeVisualFeedback,
} from '../../src/visual/visualFeedbackSettings.js';

const VOICE = 'primary';
const DIM = 'dim-1';

beforeEach(() => {
  // The store is a module singleton; hydrating nothing is how a voice starts fresh.
  hydrateVisualFeedback(VOICE, null);
  hydrateVisualFeedback('other', null);
});

describe('visual feedback settings', () => {
  it('reads as enabled until something is switched off', () => {
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'x')).toBe(true);
    expect(isVisualFeedbackEnabled(null, DIM, 'x')).toBe(true);
    expect(isVisualFeedbackEnabled(VOICE, null, 'x')).toBe(true);
    expect(getVisualFeedbackDescriptor(VOICE)).toBeNull();
  });

  it('switches one module off and leaves its siblings alone', () => {
    setVisualFeedbackEnabled(VOICE, DIM, 'y', false);
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'y')).toBe(false);
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'x')).toBe(true);
    expect(isVisualFeedbackEnabled(VOICE, 'dim-2', 'y')).toBe(true);
    expect(isVisualFeedbackEnabled('other', DIM, 'y')).toBe(true);
  });

  it('carries only what was chosen, as an object per axis (room for an amount)', () => {
    setVisualFeedbackEnabled(VOICE, DIM, 'z', false);
    expect(getVisualFeedbackDescriptor(VOICE)).toEqual({ 'dim-1': { z: { enabled: false } } });
  });

  it('keeps a key it does not own yet when the switch moves', () => {
    hydrateVisualFeedback(VOICE, { [DIM]: { x: { enabled: true, amount: 0.6 } } });
    setVisualFeedbackEnabled(VOICE, DIM, 'x', false);
    expect(getVisualFeedbackDescriptor(VOICE)).toEqual({
      'dim-1': { x: { enabled: false, amount: 0.6 } },
    });
  });

  it('hydrates a saved session, and survives a missing or malformed key', () => {
    hydrateVisualFeedback(VOICE, { [DIM]: { x: { enabled: false }, y: { enabled: true } } });
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'x')).toBe(false);
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'y')).toBe(true);

    // A session saved before this existed: everything comes back on.
    hydrateVisualFeedback(VOICE, undefined);
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'x')).toBe(true);

    expect(() => hydrateVisualFeedback(VOICE, { [DIM]: 'nonsense', bad: null })).not.toThrow();
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'x')).toBe(true);
    expect(getVisualFeedbackDescriptor(VOICE)).toBeNull();
  });

  it('hands out a copy, not the live descriptor', () => {
    setVisualFeedbackEnabled(VOICE, DIM, 'x', false);
    const descriptor = getVisualFeedbackDescriptor(VOICE);
    descriptor[DIM].x.enabled = true;
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'x')).toBe(false);
  });

  it('a new session REPLACES the last one — a track cannot inherit the previous track‘s switches', () => {
    hydrateVisualFeedback(VOICE, { [DIM]: { x: { enabled: false } } });
    // The next track loads and its session says nothing about visual feedback.
    hydrateVisualFeedback(VOICE, { 'dim-9': { z: { enabled: false } } });
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'x')).toBe(true);
    expect(getVisualFeedbackDescriptor(VOICE)).toEqual({ 'dim-9': { z: { enabled: false } } });
  });

  it('forgets a voice on teardown, so a reused id starts clean', () => {
    setVisualFeedbackEnabled(VOICE, DIM, 'x', false);
    clearVisualFeedback(VOICE);
    expect(isVisualFeedbackEnabled(VOICE, DIM, 'x')).toBe(true);
    expect(getVisualFeedbackDescriptor(VOICE)).toBeNull();
  });

  it('tells subscribers which voice changed, and stops on unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVisualFeedback(listener);

    setVisualFeedbackEnabled(VOICE, DIM, 'x', false);
    expect(listener).toHaveBeenCalledWith(VOICE);

    // A no-op write (already off) is not a change and must not wake the bridge.
    listener.mockClear();
    setVisualFeedbackEnabled(VOICE, DIM, 'x', false);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    setVisualFeedbackEnabled(VOICE, DIM, 'x', true);
    expect(listener).not.toHaveBeenCalled();
  });
});
