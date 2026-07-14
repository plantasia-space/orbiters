/**
 * @file cosmicKickIds.ts
 * The scoped MIDI identity for the cosmic ×0.5 / ×2 kick switches.
 *
 * The kicks MUST register under the LEGACY component keys
 * (`${axis}.frequency-multiplier-low` / `-high`, whose WAC uiIds are `${axis}Cosmic1` /
 * `Cosmic2`) so `lookupComponentMetadataByKey` resolves them. Only then can
 * `_clearLegacyWidgetMappingsForComponent` find + drop the stale WAC element-id mapping,
 * the layered inheritance bind, and the learn go layered. The earlier invented keys
 * (`${axis}.cosmic-kick-1/2`) had no metadata entry, so all three silently no-op'd.
 *
 * Centralised + dependency-free so the contract is pinned by a unit test and a future
 * rename can't quietly re-introduce the defect. Keep in sync with the
 * `frequency-multiplier-low/-high` blueprints in `src/core/stackUtils.js`.
 */
export type Axis = 'x' | 'y' | 'z';

/** `'half'` → ×0.5 (legacy `${axis}Cosmic1`); `'double'` → ×2 (legacy `${axis}Cosmic2`). */
export function cosmicKickComponentId(axis: Axis, multiplier: 'half' | 'double'): string {
  return `${axis}.frequency-multiplier-${multiplier === 'half' ? 'low' : 'high'}`;
}
