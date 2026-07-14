// @vitest-environment jsdom
/**
 * The `cosmic` EngineContext surface — a per-axis facade over the CosmicLFO
 * instances for the NON-PM cosmic controls (enable toggle, modulation-source select, waveform
 * select). The freq + amplitude knobs go through their PM params; this surface drives
 * start/stop + setFrequencySource + setWaveform and re-reads on the `orbiters:cosmic-changed`
 * window event (+ dimension change).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

function makeLfo() {
  let enabled = false;
  let source = 'manual';
  let waveform = 'sine';
  return {
    isCosmicEnabled: () => enabled,
    start: vi.fn(() => {
      enabled = true;
    }),
    stop: vi.fn(() => {
      enabled = false;
    }),
    getFrequencySource: () => source,
    setFrequencySource: vi.fn((k) => {
      source = k;
    }),
    getWaveform: () => waveform,
    setWaveform: vi.fn((k) => {
      waveform = k;
    }),
  };
}

let pm;
let lfos;
function provider(axis) {
  return lfos[axis] ?? null;
}

beforeEach(() => {
  pm = new ParameterManager();
  lfos = { x: makeLfo(), y: makeLfo(), z: makeLfo() };
});

describe('cosmic surface — per-axis facade over CosmicLFO', () => {
  it('forwards enable / source / waveform to the right axis', () => {
    const { cosmic } = createEngineContext({ parameterManager: pm, cosmicLfoProvider: provider });

    expect(cosmic.available('x')).toBe(true);
    expect(cosmic.isEnabled('x')).toBe(false);

    cosmic.setEnabled('x', true);
    expect(lfos.x.start).toHaveBeenCalledTimes(1);
    expect(cosmic.isEnabled('x')).toBe(true);
    expect(cosmic.isEnabled('y')).toBe(false); // per-axis isolation

    cosmic.setEnabled('x', false);
    expect(lfos.x.stop).toHaveBeenCalledTimes(1);
    expect(cosmic.isEnabled('x')).toBe(false);

    cosmic.setSource('y', 'minimumCosmicLfo');
    expect(lfos.y.setFrequencySource).toHaveBeenCalledWith('minimumCosmicLfo');
    expect(cosmic.getSource('y')).toBe('minimumCosmicLfo');
    expect(cosmic.getSource('x')).toBe('manual');

    cosmic.setWaveform('z', 'square');
    expect(lfos.z.setWaveform).toHaveBeenCalledWith('square');
    expect(cosmic.getWaveform('z')).toBe('square');
  });

  it('is unavailable and returns safe defaults with no LFO for the axis', () => {
    const { cosmic } = createEngineContext({ parameterManager: pm, cosmicLfoProvider: () => null });
    expect(cosmic.available('x')).toBe(false);
    expect(cosmic.isEnabled('x')).toBe(false);
    expect(cosmic.getSource('x')).toBe('manual');
    expect(cosmic.getWaveform('x')).toBe('sine');
    expect(() => cosmic.setEnabled('x', true)).not.toThrow();
    expect(() => cosmic.setSource('x', 'mass')).not.toThrow();
  });
});

describe('cosmic surface — subscribe re-read triggers', () => {
  it('fires on orbiters:cosmic-changed and orbiters:dimension-changed, stops after unsubscribe', () => {
    const { cosmic } = createEngineContext({ parameterManager: pm, cosmicLfoProvider: provider });
    const listener = vi.fn();
    const unsubscribe = cosmic.subscribe(listener);

    window.dispatchEvent(new CustomEvent('orbiters:cosmic-changed', { detail: { axis: 'x' } }));
    document.dispatchEvent(new Event('orbiters:dimension-changed'));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    window.dispatchEvent(new CustomEvent('orbiters:cosmic-changed', { detail: { axis: 'x' } }));
    document.dispatchEvent(new Event('orbiters:dimension-changed'));
    expect(listener).toHaveBeenCalledTimes(2); // no more after unsubscribe
  });

  // Per-voice cosmic-changed. Each tile's CosmicLFOs mirror on its OWN eventBus and its
  // `cosmic` surface subscribes to the SAME bus — so one voice's cosmic toggle never re-reads another's.
  it('cosmic-changed is isolated per voice: a change on bus A does not reach bus B', () => {
    const busA = new EventTarget();
    const busB = new EventTarget();
    const { cosmic: cA } = createEngineContext({ parameterManager: pm, cosmicLfoProvider: provider, eventBus: busA });
    const { cosmic: cB } = createEngineContext({ parameterManager: pm, cosmicLfoProvider: provider, eventBus: busB });
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    cA.subscribe(listenerA);
    cB.subscribe(listenerB);

    busA.dispatchEvent(new CustomEvent('orbiters:cosmic-changed', { detail: { axis: 'x' } }));
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();
  });
});
