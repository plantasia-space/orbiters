// @vitest-environment jsdom
/**
 * The cosmic kick switches must use the LEGACY component keys
 * (`${axis}.frequency-multiplier-low` / `-high`) as their scoped MIDI `componentId`,
 * NOT the invented `${axis}.cosmic-kick-1` / `-2`.
 *
 * Root cause: `MIDIController._clearLegacyWidgetMappingsForComponent(componentId)` and the
 * layered-inheritance path both resolve the legacy WAC uiIds via
 * `lookupComponentMetadataByKey(componentId)`. The invented keys have NO entry in the
 * component-metadata registry, so the lookup returned null — the stale WAC `${axis}Cosmic1/2`
 * element-id mapping was never cleared and inheritance could not bind. Using the legacy keys
 * makes the lookup resolve to the right `uiIds`, so clear + inherit work and the learn goes
 * layered. This pins that mapping contract so a rename can't silently regress it again.
 */
import { describe, it, expect } from 'vitest';
import { lookupComponentMetadataByKey } from '../../src/input/midi/componentMetadata.js';
import { UI_COMPONENT_SCOPES } from '../../src/core/stackUtils.js';
import { cosmicKickComponentId } from '../../src/ui/react/regions/cosmicKickIds.ts';

const AXES = ['x', 'y', 'z'];

describe('kick componentId → legacy frequency-multiplier metadata (D1)', () => {
  it.each(AXES)('%s.frequency-multiplier-low resolves to uiId %sCosmic1 (DIMENSION)', (axis) => {
    const meta = lookupComponentMetadataByKey(`${axis}.frequency-multiplier-low`);
    expect(meta).toBeTruthy();
    expect(meta.id).toBe(`${axis}.frequency-multiplier-low`);
    expect(meta.uiIds).toEqual([`${axis}Cosmic1`]);
    expect(meta.rootParam).toBe(`${axis}Cosmic1`);
    expect(meta.scope).toBe(UI_COMPONENT_SCOPES.DIMENSION); // → supportsLayers, learn goes layered
  });

  it.each(AXES)('%s.frequency-multiplier-high resolves to uiId %sCosmic2 (DIMENSION)', (axis) => {
    const meta = lookupComponentMetadataByKey(`${axis}.frequency-multiplier-high`);
    expect(meta).toBeTruthy();
    expect(meta.id).toBe(`${axis}.frequency-multiplier-high`);
    expect(meta.uiIds).toEqual([`${axis}Cosmic2`]);
    expect(meta.rootParam).toBe(`${axis}Cosmic2`);
    expect(meta.scope).toBe(UI_COMPONENT_SCOPES.DIMENSION);
  });

  it.each(AXES)('the OLD invented %s.cosmic-kick-1/2 keys resolve to nothing (the bug)', (axis) => {
    // These are exactly what made `_clearLegacyWidgetMappingsForComponent` no-op: no metadata,
    // so no uiIds to clear and no layered inheritance.
    expect(lookupComponentMetadataByKey(`${axis}.cosmic-kick-1`)).toBeNull();
    expect(lookupComponentMetadataByKey(`${axis}.cosmic-kick-2`)).toBeNull();
  });

  it('resolves a kick component by its legacy WAC uiId too (the id `_clearLegacy…` deletes)', () => {
    // `_clearLegacyWidgetMappingsForComponent` deletes `midiWidgetMappings` entries keyed by the
    // resolved uiIds. The same uiId must round-trip back to the component (byUiId index).
    const byUiId = lookupComponentMetadataByKey('xCosmic1');
    expect(byUiId?.id).toBe('x.frequency-multiplier-low');
  });
});

describe('CosmicLfoPanel kick componentId is the resolvable legacy key (D1 wiring guard)', () => {
  // This is the guard the metadata tests above could not give: it pins the ACTUAL componentId
  // the React kicks register under (`cosmicKickComponentId`, used by `CosmicMultipliers`).
  // Revert it to `${axis}.cosmic-kick-1/2` and the lookups below go null → these fail.
  it.each(AXES)('%s ×0.5 (half) → legacy frequency-multiplier-low metadata', (axis) => {
    const id = cosmicKickComponentId(axis, 'half');
    expect(id).toBe(`${axis}.frequency-multiplier-low`);
    expect(lookupComponentMetadataByKey(id)?.uiIds).toEqual([`${axis}Cosmic1`]);
  });

  it.each(AXES)('%s ×2 (double) → legacy frequency-multiplier-high metadata', (axis) => {
    const id = cosmicKickComponentId(axis, 'double');
    expect(id).toBe(`${axis}.frequency-multiplier-high`);
    expect(lookupComponentMetadataByKey(id)?.uiIds).toEqual([`${axis}Cosmic2`]);
  });
});
