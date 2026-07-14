/**
 * @file src/sync/meter.js
 * @description Time signature / meter model — thin re-export of the shared package's meter helpers
 * (`entangled-worlds-orbiters-shared/clock/meter`), which entangled-worlds also consumes. The model
 * itself (parse/normalize + the per-track resolver) now lives at the library level; this file exists
 * only so existing orbiters imports (`../../sync/meter.js` etc.) keep working unchanged.
 *
 * The shared clock counts QUARTER-note beats (tempo BPM = quarter notes). So the engine works in
 * `sharedBeatsPerBar` = quarter-note beats per bar = numerator × 4 / denominator. The metronome clicks
 * at the denominator's note value (`clickIntervalQuarterBeats = 4 / denominator`), so 6/8 and 3/4 share
 * a bar length but subdivide differently.
 *
 * "Do not use 'compass' in English for this concept" — it is meter / time signature.
 */

export {
  METER_PRESETS,
  DEFAULT_METER_ID,
  MIN_METER_NUMERATOR,
  MAX_METER_NUMERATOR,
  VALID_METER_DENOMINATORS,
  formatMeterId,
  isValidMeterId,
  normalizeMeterId,
  parseMeter,
  sharedBeatsPerBar,
  resolveTrackMeterFromTrackData,
} from 'entangled-worlds-orbiters-shared/clock/meter';
