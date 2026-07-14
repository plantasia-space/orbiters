/**
 * Time signature / meter model + per-track resolver.
 */
import { describe, it, expect } from 'vitest';
import {
  METER_PRESETS,
  DEFAULT_METER_ID,
  isValidMeterId,
  normalizeMeterId,
  parseMeter,
  sharedBeatsPerBar,
  resolveTrackMeterFromTrackData,
} from '../../src/sync/meter.js';

describe('meter ids', () => {
  it('keeps 4/4, 3/4, 6/8 as quick-picks and defaults to 4/4', () => {
    expect(METER_PRESETS.map((m) => m.id)).toEqual(['4/4', '3/4', '6/8']);
    expect(DEFAULT_METER_ID).toBe('4/4');
  });
  it('isValidMeterId accepts arbitrary numerator/power-of-two-denominator meters', () => {
    expect(isValidMeterId('3/4')).toBe(true);
    expect(isValidMeterId('7/16')).toBe(true);
    expect(isValidMeterId({ numerator: 12, denominator: 8 })).toBe(true);
    expect(isValidMeterId('9/7')).toBe(false);
    expect(isValidMeterId(null)).toBe(false);
  });
  it('normalizeMeterId falls back to the default', () => {
    expect(normalizeMeterId(' 6/8 ')).toBe('6/8');
    expect(normalizeMeterId(' 7 / 16 ')).toBe('7/16');
    expect(normalizeMeterId({ numerator: 5, denominator: 4 })).toBe('5/4');
    expect(normalizeMeterId('nope')).toBe('4/4');
    expect(normalizeMeterId(undefined)).toBe('4/4');
  });
});

describe('sharedBeatsPerBar (quarter-note beats per bar = the engine bar)', () => {
  it('4/4 → 4, 3/4 → 3, 6/8 → 3', () => {
    expect(sharedBeatsPerBar('4/4')).toBe(4);
    expect(sharedBeatsPerBar('3/4')).toBe(3);
    expect(sharedBeatsPerBar('6/8')).toBe(3);
    expect(sharedBeatsPerBar('7/8')).toBe(3.5);
  });
  it('parseMeter exposes numerator/denominator, bar length, and click spacing', () => {
    expect(parseMeter('6/8')).toMatchObject({
      id: '6/8',
      numerator: 6,
      denominator: 8,
      beatsPerBar: 6,
      beatUnit: 8,
      sharedBeatsPerBar: 3,
      clickIntervalQuarterBeats: 0.5,
      clicksPerBar: 6,
    });
  });
});

describe('resolveTrackMeterFromTrackData — canonical > per-user > default', () => {
  it('prefers the owner canonical meter over a per-user override (mirrors tempo)', () => {
    const td = {
      metadata: { effectiveSettings: { sync: { meter: '3/4' } } },
      trackUserSettings: { sync: { meter: '6/8' } },
    };
    expect(resolveTrackMeterFromTrackData(td)).toBe('3/4');
  });
  it('falls back to the owner layer when there is no per-user meter', () => {
    expect(resolveTrackMeterFromTrackData({
      track: { metadata: { effectiveSettings: { sync: { meter: '5/4' } } } },
    })).toBe('5/4');
    expect(resolveTrackMeterFromTrackData({
      metadata: { effectiveSettings: { sync: { meter: '7/8' } } },
    })).toBe('7/8');
  });
  it('falls back to the per-user layer when owner settings are absent', () => {
    expect(resolveTrackMeterFromTrackData({ trackUserSettings: { sync: { meter: '6/8' } } })).toBe('6/8');
    expect(resolveTrackMeterFromTrackData({ trackUserSettings: { sync: { meter: '7/16' } } })).toBe('7/16');
    expect(resolveTrackMeterFromTrackData({
      trackUserSettings: { sync: { meter: { numerator: 12, denominator: 8 } } },
    })).toBe('12/8');
  });
  it('falls back to analysis when no saved preference exists', () => {
    const td = {
      metadata: {
        audioAnalysis: {
          analysis: {
            time_signature: { numerator: 7, denominator: 8 },
          },
        },
      },
    };
    expect(resolveTrackMeterFromTrackData(td)).toBe('7/8');
  });
  it('defaults to 4/4 when absent or invalid', () => {
    expect(resolveTrackMeterFromTrackData({})).toBe('4/4');
    expect(resolveTrackMeterFromTrackData(null)).toBe('4/4');
    expect(resolveTrackMeterFromTrackData({ trackUserSettings: { sync: { meter: '9/7' } } })).toBe('4/4');
  });
});
