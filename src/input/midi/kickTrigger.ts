/**
 * @file src/input/midi/kickTrigger.ts
 * @description Momentary kick-trigger dispatch.
 *
 * A kick switch is an ACTION (e.g. a ×0.5 / ×2 frequency multiplier), not a value. Inbound
 * MIDI must fire the registered action on a RISING edge only — a note-on, or a CC crossing
 * the threshold upward — so a held control or a release/note-off never re-fires. Pure and
 * DOM-free, so the MIDIController can delegate here and this logic unit-tests without the
 * controller's heavy import graph.
 */

export type TriggerAction = () => void;

/** A CC/velocity at or above this is "pressed"; below is "released". */
export const RISING_THRESHOLD = 64;

export class KickTriggerDispatcher {
  private readonly actions = new Map<string, TriggerAction>();
  private readonly lastValue = new Map<string, number>();

  /** Bind (or, with no action, clear) the trigger for a learn-target id. */
  register(id: string, onTrigger?: TriggerAction): void {
    if (!id) return;
    if (typeof onTrigger === 'function') this.actions.set(id, onTrigger);
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
   * Feed an inbound MIDI value for `id`. Fires the bound action exactly once on a rising
   * edge (previous < threshold, current >= threshold). Returns true iff it fired.
   */
  handle(id: string, midiValue: number): boolean {
    const cur = Number.isFinite(midiValue) ? midiValue : 0;
    const prev = this.lastValue.get(id) ?? 0;
    this.lastValue.set(id, cur);
    const action = this.actions.get(id);
    if (!action) return false;
    if (prev < RISING_THRESHOLD && cur >= RISING_THRESHOLD) {
      try {
        action();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[kickTrigger] action failed:', error);
      }
      return true;
    }
    return false;
  }
}
