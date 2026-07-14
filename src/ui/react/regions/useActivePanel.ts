/**
 * @file src/ui/react/regions/useActivePanel.ts
 * @description Read the active interaction PANEL (the PanelManager mode) inside a
 * region, re-rendering whenever it changes.
 *
 * The "panels" (Jamming / Sensors / Cosmic LFO / Playback / MIDI) are interaction
 * MODES, not layout regions: they all share ONE constant chrome (header, volume
 * rail, XYZ gauges, transport, interaction menu) and each one only ADDS or REMOVES
 * a few controls on top of that base — Jamming is the base with nothing extra
 * (`PanelManager.js`). React regions encode that by rendering the constant chrome
 * always, and gating the per-panel extras on the active panel's `action`:
 *   - `sensors`     → the per-axis sensor toggles (under each XYZ knob)
 *   - `cosmic-lfo`  → the Cosmic LFO sub-panel
 *   - `playback`    → the waveform + zoom strip
 *
 * Returns the active `PanelOption` (id + action + label), or `undefined` before the
 * PanelManager has activated a panel — which correctly resolves to the Jamming base
 * (no extras), the right default for the play UI.
 */
import { useEnginePanels } from '../../../react/engine/EngineContext';
import { useEngineSubscription } from '../../../react/engine/useEngineSubscription';
import type { PanelOption } from '../../../react/engine/engineTypes';

export function useActivePanel(): PanelOption | undefined {
  const panels = useEnginePanels();
  // Re-read whenever the panel switches (React menu OR the legacy chrome) —
  // `panels.subscribe` keys on `orbiters:panel-change`.
  useEngineSubscription(panels);
  const activeId = panels.active();
  return panels.list().find((p) => p.id === activeId);
}
