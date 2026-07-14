/**
 * @file src/ui/react/regions/CollapsedMidiAnchors.tsx
 * @description Persistent per-option MIDI-learn anchors for a COLLAPSED ActionButtonGroup.
 *
 * In the collapsed (single trigger + drop-up menu) form, the lib renders the per-option rows inside
 * a Radix menu that only MOUNTS while the menu is open. So the per-option learn targets — and the
 * registered actions keyed on their DOM ids — vanish the moment the menu closes: a CC can't be
 * mapped, and inbound MIDI has nothing to fire. (The expanded action-stack works because its option
 * buttons are always rendered.)
 *
 * These anchors restore per-option MIDI in the collapsed form WITHOUT a shared-lib change: one
 * element per option, ALWAYS in the DOM, carrying the SAME `id` + `data-automatable` the
 * `useTrigger`/`useTriggerGroup` registration keys on. So each option's action stays registered and
 * inbound MIDI fires whether the menu is open or closed. They keep a real layout rect at all times
 * (CSS `opacity`, never `display:none`) so the MIDI-learn overlay attaches reliably, but are
 * invisible + click-through until MIDI-learn mode is active (`body.midi-learn-mode`, toggled by
 * MidiLearnUiController), where they fade in as a small labelled column by the trigger to be mapped.
 *
 * Used ONLY in the collapsed form — in the expanded form the visible action-stack buttons already
 * carry the ids (the caller passes `domProps` there, NOT here), so exactly one element per option
 * owns each id (the learn overlays key on `getElementById`, so a duplicate would shadow).
 */

export interface CollapsedMidiAnchorItem {
  /** The option's scoped MIDI componentId (the same one the action is registered under). */
  componentId: string;
  /** Short label shown on the anchor chip in learn mode (e.g. "Play", "Sensors"). */
  label: string;
  /** The `{ id, data-automatable }` from the option's `useTrigger`/`useTriggerGroup` registration. */
  midiProps: Record<string, string>;
}

export function CollapsedMidiAnchors({ items }: { items: CollapsedMidiAnchorItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="orbiters-react-ui__midi-anchors" data-ui-interactive aria-hidden="true">
      {items.map((item) => (
        <button
          key={item.componentId}
          type="button"
          tabIndex={-1}
          {...item.midiProps}
          className="orbiters-react-ui__midi-anchor"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
