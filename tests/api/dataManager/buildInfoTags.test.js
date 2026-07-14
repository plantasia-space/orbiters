// @vitest-environment jsdom
/**
 * `buildInfoTags` — the clean `{label, value}` row form of the track /
 * entangled-world / orbiter metadata the React Info panel renders. Reuses the same tag builders
 * `buildPlaceholderConfig` feeds into the legacy grid; keyed by the React info-menu value.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildInfoTags } from '../../../src/api/dataManager/placeholders.js';
import { initI18n } from '../../../src/i18n/index.js';

describe('buildInfoTags', () => {
  // Row labels now come from i18n. Initialise i18next (defaults to English here) so the
  // labels resolve to their en.json values, which this suite asserts.
  beforeAll(async () => {
    await initI18n();
  });

  it('returns rows keyed by the three static info modes', () => {
    const tags = buildInfoTags(null, null, null);
    expect(Object.keys(tags).sort()).toEqual(['entangled-world', 'orbiter', 'track']);
    for (const mode of ['track', 'entangled-world', 'orbiter']) {
      expect(Array.isArray(tags[mode])).toBe(true);
      for (const row of tags[mode]) {
        expect(typeof row.label).toBe('string');
        expect(row).toHaveProperty('value');
      }
    }
  });

  it('exposes the expected labels for each mode even with empty inputs', () => {
    const tags = buildInfoTags(null, null, null);
    const labels = (mode) => tags[mode].map((r) => r.label);

    expect(labels('track')).toEqual(['Track', 'Artists', 'by', 'Rights', 'Release date']);
    expect(labels('entangled-world')).toEqual(['World', 'Exoplanet', 'CPD', 'Stellar L⊙', 'Mass (MJ)', 'Moons']);
    expect(labels('orbiter')).toEqual(['Orbiter', 'by']);
  });

  it('surfaces real track + orbiter values when present', () => {
    const track = { trackName: 'bwv1054 andante dub' };
    const orbiter = { orbiterName: 'Test Orbiter' };
    const tags = buildInfoTags(track, orbiter, null);

    const trackRow = tags.track.find((r) => r.label === 'Track');
    const orbiterRow = tags.orbiter.find((r) => r.label === 'Orbiter');
    expect(trackRow.value).toBe('bwv1054 andante dub');
    expect(orbiterRow.value).toBe('Test Orbiter');
  });
});
