import { describe, expect, it } from 'vitest';

import {
  COSMIC_SOURCES,
  DEFAULT_COSMIC_SOURCE_KEY,
  MANUAL_SOURCE_KEY,
} from '../../../src/input/cosmic/cosmicSources.ts';

describe('cosmic source catalog', () => {
  it('uses canonical source ids only', () => {
    const sourceKeys = COSMIC_SOURCES.map((source) => source.key);

    expect(DEFAULT_COSMIC_SOURCE_KEY).toBe('minimumCosmicLfo');
    expect(sourceKeys).toEqual([
      'minimumCosmicLfo',
      'stellarLuminosityLsun',
      'frequencyCpd',
      'mass',
      MANUAL_SOURCE_KEY,
    ]);
    expect(sourceKeys.some((key) => key.startsWith('exo-'))).toBe(false);
  });
});
