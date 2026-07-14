/**
 * @file src/input/midi/stepSelect.ts
 * @description Single-CC stepped SELECT dispatch.
 *
 * The cosmic source / waveform selects are lib `ActionButtonGroup` cycle controls: a single
 * collapsed trigger that opens a menu to re-pick (no per-OPTION DOM element, so no per-option
 * MIDI-learn target). The single learn target is the trigger itself. Inbound MIDI therefore maps
 * ONE CC across the N options by VALUE → index (a quantized "selector knob"): sweep the control
 * and the selection steps through the options. Each ~127/N band selects one option.
 *
 * It fires the bound select-by-index action only when the resolved INDEX changes, so a continuous
 * knob sweep fires once per band crossing (not on every CC tick). The first message after
 * (re)register reconciles the selection to the controller's position. Pure + DOM-free so the
 * MIDIController can delegate here and this unit-tests without the controller's import graph
 * (mirrors {@link ./kickTrigger.KickTriggerDispatcher} and {@link ./toggleAction.ToggleActionDispatcher}).
 *
 * NOTE (UX): a MOMENTARY button (127 on press, 0 on release) jumps to the LAST option on press
 * and the FIRST on release — a selector wants a knob/fader, not a pad. Flagged for device review.
 */

/** Select the option at `index` (0-based, already clamped into range). */
export type SelectIndexAction = (index: number) => void;

interface StepSelectEntry {
  count: number;
  onIndex: SelectIndexAction;
}

/** Map a MIDI value (0..127) to an option index in [0, count-1]. */
export function midiValueToIndex(midiValue: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const v = Number.isFinite(midiValue) ? midiValue : 0;
  const norm = Math.min(1, Math.max(0, v / 127));
  return Math.min(count - 1, Math.max(0, Math.floor(norm * count)));
}

export class StepSelectDispatcher {
  private readonly entries = new Map<string, StepSelectEntry>();
  private readonly lastIndex = new Map<string, number>();

  /**
   * Bind (or, with no action / a non-positive count, clear) the stepped-select for a learn-target
   * id. `count` is the number of options; `onIndex` selects the option at a resolved index.
   */
  register(id: string, config?: { count?: number; onIndex?: SelectIndexAction }): void {
    if (!id) return;
    const count = config?.count;
    const onIndex = config?.onIndex;
    if (typeof onIndex === 'function' && Number.isFinite(count) && (count as number) > 0) {
      this.entries.set(id, { count: count as number, onIndex });
    } else {
      this.entries.delete(id);
    }
  }

  /** Drop the action and last-index for an id (on unmount / unregister). */
  unregister(id: string): void {
    this.entries.delete(id);
    this.lastIndex.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Clear the remembered index (all ids, or one) WITHOUT dropping the actions. The selects are
   * DIMENSION-scoped (per-axis-per-dim) but the dispatcher keys index state by the
   * dimension-stable widget id, so the MIDIController calls this on a dimension change to re-arm:
   * the next inbound CC then reconciles the now-active dimension's selection.
   */
  resetState(id?: string): void {
    if (id) this.lastIndex.delete(id);
    else this.lastIndex.clear();
  }

  /**
   * Feed an inbound MIDI value for `id`. Resolves the option index by VALUE and fires the bound
   * action ONLY when that index changes, so a continuous sweep fires once per band crossing.
   * Returns true iff the action fired.
   *
   * The per-index dedupe is also load-bearing for DE-DUPLICATION: a DIMENSION-scoped select's
   * widgetId is written into BOTH the layered map AND `midiWidgetMappings`, so the MIDIController
   * calls `handle()` twice for one inbound message (the element-id loop + the layered path). The
   * second call resolves the identical index and no-ops here. Do NOT replace this with a
   * value-keyed dedupe — that would re-introduce a double `onChange` per message.
   */
  handle(id: string, midiValue: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const index = midiValueToIndex(midiValue, entry.count);
    if (this.lastIndex.get(id) === index) return false;
    this.lastIndex.set(id, index);
    try {
      entry.onIndex(index);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[stepSelect] action failed:', error);
    }
    return true;
  }
}
