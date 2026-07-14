// @vitest-environment jsdom
/**
 * The React calibrate button (header, Sensors panel) is a MIDI-learn target, wired the
 * same GLOBAL momentary-action way as the transport play/stop buttons. For its learn to resolve
 * metadata (and defensively clear/inherit a persisted legacy WAC `sensor-calibration` mapping, if
 * one ever existed — the old calibrate button was a plain click, so usually none),
 * `lookupComponentMetadataByKey('sensor-calibration')` must resolve to the stackUtils component —
 * the same contract `_clearLegacyWidgetMappingsForComponent` relies on (see the cosmic-kick
 * precedent in kickComponentMetadata.test.js). This pins the stackUtils entry so a rename or
 * removal can't silently break calibrate-learn.
 */
import { describe, it, expect } from 'vitest';
import { lookupComponentMetadataByKey } from '../../src/input/midi/componentMetadata.js';
import {
  UI_COMPONENT_SCOPES,
  getUiComponentMetadata,
  listUiComponents,
} from '../../src/core/stackUtils.js';

describe('sensor-calibration componentId → metadata', () => {
  it('resolves sensor-calibration to a GLOBAL (UNIQUE) momentary action', () => {
    const meta = lookupComponentMetadataByKey('sensor-calibration');
    expect(meta).toBeTruthy();
    expect(meta.id).toBe('sensor-calibration');
    expect(meta.rootParam).toBe('sensor-calibration');
    expect(meta.uiIds).toEqual(['sensor-calibration']); // legacy WAC element id → clear/inherit
    expect(meta.scope).toBe(UI_COMPONENT_SCOPES.UNIQUE);
    expect(meta.defaultValue).toBe(false); // momentary, like play-toggle / stop / record
  });

  it('is a UNIQUE component the metadata API + registry both describe', () => {
    expect(getUiComponentMetadata('sensor-calibration')?.scope).toBe(UI_COMPONENT_SCOPES.UNIQUE);
    const uniqueIds = listUiComponents({ scope: UI_COMPONENT_SCOPES.UNIQUE }).map((c) => c.id);
    expect(uniqueIds).toContain('sensor-calibration');
  });
});
