/**
 * @file src/input/midi/toggleAction.ts
 * @description On/off toggle-action dispatch.
 *
 * A toggle (the cosmic-enable + sensor-enable hexagons, the header loop button) is a LATCHING
 * control: it holds its on/off state. Mapped to a typical MIDI pad/button — which sends a
 * MOMENTARY press (127 on press, 0 on release) — the control must FLIP on each PRESS and hold,
 * then flip back on the NEXT press. So inbound MIDI fires the bound action on a RISING edge only
 * (a note-on, or a CC crossing the threshold upward); the release/falling edge is ignored. The
 * action is a FLIP signal — the React seam inverts the CURRENT state (read fresh via a ref), so a
 * latch driven by MIDI and by an on-screen click stay in agreement.
 *
 * (Earlier this used LEVEL semantics — state = value>=64 — which made a momentary pad read
 * press=on / release=off. Rising-edge flip is what a latch wants. A SUSTAINED/latching MIDI
 * controller, the rarer case, would only flip on its press-down; momentary pads are the norm.)
 *
 * Pure + DOM-free so the MIDIController can delegate here and this unit-tests without the
 * controller's heavy import graph (mirrors {@link ./kickTrigger.KickTriggerDispatcher} — same
 * rising-edge mechanism; kept distinct for the semantic: a kick is momentary, a toggle latches).
 */

/** A "flip the maintained state" signal. The React seam reads the current value + inverts it. */
export type FlipAction = () => void;

/** A CC/velocity at or above this is a "press"; below is "released" (legacy toggle parity). */
export const TOGGLE_THRESHOLD = 64;

export class ToggleActionDispatcher {
  private readonly actions = new Map<string, FlipAction>();
  private readonly lastValue = new Map<string, number>();

  /** Bind (or, with no action, clear) the flip action for a learn-target id. */
  register(id: string, onFlip?: FlipAction): void {
    if (!id) return;
    if (typeof onFlip === 'function') this.actions.set(id, onFlip);
    else this.actions.delete(id);
  }

  /** Drop the action and rising-edge state for an id (on unmount / unregister). */
  unregister(id: string): void {
    this.actions.delete(id);
    this.lastValue.delete(id);
  }

  has(id: string): boolean {
    return this.actions.has(id);
  }

  /**
   * Clear the remembered rising-edge value (all ids, or one) WITHOUT dropping the actions. Called
   * on a dimension change so a controller held above the threshold across the switch can flip the
   * now-active dimension's toggle on its next press (a normal press already re-arms on its release,
   * so this only matters for a held control).
   */
  resetState(id?: string): void {
    if (id) this.lastValue.delete(id);
    else this.lastValue.clear();
  }

  /**
   * Feed an inbound MIDI value for `id`. Fires the bound flip action exactly once on a RISING edge
   * (previous < threshold, current >= threshold) — a press. A held control or a release/note-off
   * never re-fires (it re-arms on the drop below threshold). Returns true iff it fired.
   */
  handle(id: string, midiValue: number): boolean {
    const cur = Number.isFinite(midiValue) ? midiValue : 0;
    const prev = this.lastValue.get(id) ?? 0;
    this.lastValue.set(id, cur);
    const action = this.actions.get(id);
    if (!action) return false;
    if (prev < TOGGLE_THRESHOLD && cur >= TOGGLE_THRESHOLD) {
      try {
        action();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[toggleAction] action failed:', error);
      }
      return true;
    }
    return false;
  }
}
