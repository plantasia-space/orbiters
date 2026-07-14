// @vitest-environment jsdom
/**
 * Keyboard shortcuts must act on the FOCUSED orbiter. The dimension (1/2/3) and panel
 * (J/P/C/S) handlers used to read the cached `this.worldModeController` / `this.panelManager` deps,
 * which are last-writer-wins across tiles (every tile's boot calls updateDependencies), so they hit
 * whichever tile booted last — not the focused one. They now resolve `voiceRegistry.getActive()`.
 *
 * Each test seeds a DISTINCT "cached dep" (a third target) so a regression to the old behavior would
 * call that instead of the active voice — proving the routing goes through the registry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';
import { KeyboardController } from '../../src/input/KeyboardController.js';

const makeMode = () => ({
  getAvailableDimensions: () => [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }],
  setActiveDimension: vi.fn(() => true),
});
const makePanels = () => ({ activatePanel: vi.fn(), getActivePanel: () => null });

describe('KeyboardController routes shortcuts to the focused voice', () => {
  let kb;
  let aMode;
  let bMode;
  let aPanels;
  let bPanels;
  let cachedMode;
  let cachedPanels;

  beforeEach(() => {
    voiceRegistry.clear();
    aMode = makeMode();
    bMode = makeMode();
    aPanels = makePanels();
    bPanels = makePanels();
    // The cached deps point at a THIRD target that is NOT either registered voice — a regression to
    // reading `this.*` would call these instead of the active voice.
    cachedMode = makeMode();
    cachedPanels = makePanels();
    voiceRegistry.register('A', { id: 'A', worldMode: aMode, panelManager: aPanels });
    voiceRegistry.register('B', { id: 'B', worldMode: bMode, panelManager: bPanels });
    kb = KeyboardController.initialize({ worldModeController: cachedMode, panelManager: cachedPanels });
  });

  it('dimension 1/2/3 targets the ACTIVE voice worldMode (follows focus), never the cached dep', () => {
    voiceRegistry.setActive('A');
    kb.setActiveDimensionByIndex(1);
    expect(aMode.setActiveDimension).toHaveBeenCalledWith('d2', expect.anything());
    expect(bMode.setActiveDimension).not.toHaveBeenCalled();
    expect(cachedMode.setActiveDimension).not.toHaveBeenCalled();

    voiceRegistry.setActive('B');
    kb.setActiveDimensionByIndex(2);
    expect(bMode.setActiveDimension).toHaveBeenCalledWith('d3', expect.anything());
    expect(cachedMode.setActiveDimension).not.toHaveBeenCalled();
  });

  it('panel J/P/C/S targets the ACTIVE voice panelManager (follows focus), never the cached dep', () => {
    voiceRegistry.setActive('A');
    kb.activatePanel('jamming');
    expect(aPanels.activatePanel).toHaveBeenCalledWith('jamming');
    expect(bPanels.activatePanel).not.toHaveBeenCalled();
    expect(cachedPanels.activatePanel).not.toHaveBeenCalled();

    voiceRegistry.setActive('B');
    kb.activatePanel('cosmic-lfo');
    expect(bPanels.activatePanel).toHaveBeenCalledWith('cosmic-lfo');
    expect(cachedPanels.activatePanel).not.toHaveBeenCalled();
  });
});
