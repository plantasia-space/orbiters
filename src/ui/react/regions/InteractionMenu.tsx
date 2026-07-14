/**
 * @file src/ui/react/regions/InteractionMenu.tsx
 * @description The interaction-menu region (strategy §5, reuse-map "Interaction
 * menu") — the panel switcher (Sensors / Cosmic LFO / Playback / Jamming).
 *
 * Reproduces index.html's `.interaction-button` dropdown (`data-action` items →
 * PanelManager panels). Composed from the lib `ActionButtonGroup` (the orbiters
 * corner button-group), wired to the `panels` EngineContext surface:
 *   - `panels.list()`     → the menu options (id+action+label)
 *   - `panels.active()`   → the selected option
 *   - `panels.activate()` → PanelManager.activatePanel (runs the real onEnter/onExit
 *                            side effects: sensors/MIDI/cosmic). This region IS fully
 *                            wireable — no audio seam needed.
 *   - `panels.subscribe()`→ re-render on `orbiters:panel-change` so a switch from the
 *                            legacy chrome reflects here too.
 *
 * Renders nothing when no panel manager is wired (empty list) — safe in every mode.
 */
import { ActionButtonGroup, type ActionOption } from 'plantasia.space-design/react';
import { usePortalContainer } from '../PortalContainerProvider';
import { Icon, type IconName } from 'plantasia.space-design/icons';
import { useEnginePanels } from '../../../react/engine/EngineContext';
import { useEngineSubscription } from '../../../react/engine/useEngineSubscription';
import { useTriggerGroup } from '../../../react/parameters';
import { useNavViewportState } from './useNavViewportState';
import { CollapsedMidiAnchors } from './CollapsedMidiAnchors';
import { getT } from '../../../i18n/index.js';

/** Each panel's icon, mirroring the legacy interaction-menu SVGs. */
const PANEL_ICONS: Record<string, IconName> = {
  sensors: 'motion-sensor',
  'cosmic-lfo': 'cosmic-lfo',
  playback: 'playback',
  jamming: 'jam',
};

export function InteractionMenu() {
  const panels = useEnginePanels();
  // Theme the collapsed menu (Sensors/Cosmic/Playback/Jamming) from the orbiter, not the host.
  const portalContainer = usePortalContainer();

  // Re-read the active panel whenever ANYTHING switches it (React or WAC chrome).
  useEngineSubscription(panels);

  const list = panels.list();
  // MIDI-learn: one GLOBAL momentary trigger per panel, under the LEGACY action key (`sensors`
  // /`cosmic-lfo`/`playback`/`jamming`) so a learned CC inherits + clears the legacy menu-item
  // mapping. Fired via the per-option action-stack button (desktop). Called unconditionally
  // (rules of hooks) — empty list registers nothing.
  const getMidiProps = useTriggerGroup(
    list.map((p) => ({ componentId: p.action, onTrigger: () => panels.activate(p.id), scope: 'GLOBAL' as const })),
  );

  // Collapsing the action stack is a VERTICAL decision, not a horizontal one: prefer the expanded
  // icon stack, and drop to ONE drop-up button only when there isn't enough vertical room for it.
  // `isShort` keys off this orbiter's own box height — which in the multi-stage grid is effectively
  // the screen height divided by the number of orbiter rows — against the same height threshold the
  // single orbiter uses. So a tall narrow tile (e.g. side-by-side) keeps the expanded stack instead
  // of collapsing just because it's narrow.
  const collapsed = useNavViewportState().isShort;

  if (list.length === 0) {
    return null;
  }

  const options: ActionOption[] = list.map((p) => ({
    value: p.id,
    label: p.label,
    kind: 'select',
    icon: PANEL_ICONS[p.action] ? <Icon name={PANEL_ICONS[p.action]} /> : undefined,
    // EXPANDED: the always-rendered action-stack button is the per-panel MIDI-learn target (it owns
    // the id). COLLAPSED: the menu rows are transient (Radix mounts them only while open), so the id
    // must NOT live here — the always-present `CollapsedMidiAnchors` below own it instead. Exactly
    // one element per id, or the learn overlay's getElementById would shadow (CollapsedMidiAnchors §).
    domProps: collapsed ? undefined : getMidiProps(p.action),
  }));
  const active = panels.active() ?? options[0]?.value;

  return (
    <div
      className="orbiters-react-ui__interaction-menu"
      data-ui-interactive
      data-ui-react-region="interaction-menu"
    >
      {/* Desktop+tall → expanded vertical icon stack (each a stable MIDI target). Compressed/mobile
          → one drop-up trigger + menu, with the anchors below preserving per-panel MIDI. */}
      <ActionButtonGroup
        container={portalContainer}
        options={options}
        value={active}
        onChange={(id) => panels.activate(id)}
        expandable
        collapsed={collapsed}
        orientation="vertical"
        placement="top"
        align="end"
        aria-label={getT()('interaction.menuLabel')}
      />
      {/* Collapsed-only: persistent per-panel MIDI-learn anchors (the menu rows are transient). */}
      {collapsed && (
        <CollapsedMidiAnchors
          items={list.map((p) => ({ componentId: p.action, label: p.label, midiProps: getMidiProps(p.action) }))}
        />
      )}
    </div>
  );
}
