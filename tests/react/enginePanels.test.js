// @vitest-environment jsdom
/**
 * The `panels` EngineContext surface (strategy §3) — list / active / activate /
 * subscribe, built by createEngineContext from a fake PanelManager slice and the
 * `orbiters:panel-change` window event PanelManager already dispatches.
 *
 * Proves: with a panel manager wired, list comes from panelOptions, active reads
 * the manager, activate delegates, and subscribe keys on the window event so a
 * switch from anywhere (React or the legacy chrome) notifies React. Without a
 * manager, list() is empty and the shell stays safe (no interaction menu rendered).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParameterManager } from '../../src/core/ParameterManager.js';
import { createEngineContext } from '../../src/react/engine/createEngineContext.ts';

const PANEL_EVENT = 'orbiters:panel-change';

function makePanelManager(initial = null) {
  let current = initial;
  return {
    activateCalls: [],
    activatePanel(id) {
      this.activateCalls.push(id);
      current = id;
    },
    getActivePanel: () => current,
  };
}

const PANEL_OPTIONS = [
  { id: 'SENSORS_PANEL', action: 'sensors', label: 'Sensors' },
  { id: 'COSMIC_LFO_PANEL', action: 'cosmic-lfo', label: 'Cosmic LFO' },
];

let pm;
beforeEach(() => {
  pm = new ParameterManager();
});

describe('panels surface — with a panel manager', () => {
  it('lists the panel options, reads active, and delegates activate', () => {
    const panelManager = makePanelManager('SENSORS_PANEL');
    const { panels } = createEngineContext({
      parameterManager: pm,
      midiController: null,
      panelManager,
      panelOptions: PANEL_OPTIONS,
    });

    expect(panels.list()).toEqual(PANEL_OPTIONS);
    expect(panels.active()).toBe('SENSORS_PANEL');

    panels.activate('COSMIC_LFO_PANEL');
    expect(panelManager.activateCalls).toEqual(['COSMIC_LFO_PANEL']);
    expect(panels.active()).toBe('COSMIC_LFO_PANEL');
  });

  it('subscribe fires on the orbiters:panel-change event and unsubscribes cleanly', () => {
    const panelManager = makePanelManager();
    const { panels } = createEngineContext({
      parameterManager: pm,
      midiController: null,
      panelManager,
      panelOptions: PANEL_OPTIONS,
    });

    const listener = vi.fn();
    const unsubscribe = panels.subscribe(listener);

    window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: { panelId: 'COSMIC_LFO_PANEL' } }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: { panelId: 'SENSORS_PANEL' } }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('panels surface — without a panel manager', () => {
  it('list() is empty and active() is null; subscribe is a no-op', () => {
    const { panels } = createEngineContext({ parameterManager: pm, midiController: null });
    expect(panels.list()).toEqual([]);
    expect(panels.active()).toBeNull();
    expect(typeof panels.subscribe(() => {})).toBe('function');
  });
});
