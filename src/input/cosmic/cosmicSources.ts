/**
 * @file src/input/cosmic/cosmicSources.ts
 * @description Canonical catalog of Cosmic LFO modulation SOURCES and WAVEFORMS — the
 * single source of truth for the panel's source/waveform model (Bruna's hard rule: no
 * two sources of truth). Both the legacy `CosmicLFO.js` and the React `CosmicAxisStack`
 * read THIS, so the source list / labels / icons can never drift apart.
 *
 * The Cosmic LFO modulates an axis with an oscillator whose FREQUENCY comes from a
 * selectable modulation source. There are two flavours, and the selected source decides
 * which controls the panel shows:
 *   - the 4 DISCRETE, world-data-driven sources (`COSMIC_DISCRETE_SOURCES`) → the panel
 *     shows the ×0.5 / ×2 frequency MULTIPLIERS (the frequency snaps to the source's
 *     value, the multipliers octave-step it);
 *   - the MANUAL source (`COSMIC_MANUAL_SOURCE`, key `'manual'`) → the panel shows a
 *     CONTINUOUS frequency KNOB the user dials in `[COSMIC_FREQ_MIN, COSMIC_FREQ_MAX]`.
 * `isManualSource()` is the one predicate that drives that fork.
 *
 * Each entry carries BOTH icon representations because the two consumers use different
 * icon systems: `libIcon` is the design-lib `<Icon name>` (React panel) and
 * `legacySymbol` is the herbarium svg filename the legacy DOM resolves via
 * `resolveHerbariumSymbol`. Identity (`key` / `label` / `i18nKey`) is shared.
 *
 * NOTE: this catalog is identity/label/icon ONLY. The actual frequency VALUE behind each
 * discrete source is injected at runtime from world data (CosmicLFO.setFrequencySources).
 * The old positional dropdown ids were not real source identities. They are intentionally
 * unsupported; do not expose, persist, or normalize them.
 */

import type { IconName } from 'plantasia.space-design/icons';

/** The manual (continuous-knob) source key. */
export const MANUAL_SOURCE_KEY = 'manual';
export const DEFAULT_COSMIC_SOURCE_KEY = 'minimumCosmicLfo';

export interface CosmicSourceDef {
  /** Canonical source identity (the PM/source value). */
  key: string;
  /** Human label (English default; localise via `i18nKey`). */
  label: string;
  i18nKey: string;
  /** design-lib `<Icon name>` (React panel) — typed so a wrong name is caught here. */
  libIcon: IconName;
  /** Herbarium svg filename (legacy DOM, via `resolveHerbariumSymbol`). */
  legacySymbol: string;
}

/**
 * The four discrete, world-data-driven modulation sources. Selecting any of these shows
 * the ×0.5 / ×2 multipliers. Array order = catalog/menu order.
 */
export const COSMIC_DISCRETE_SOURCES: readonly CosmicSourceDef[] = [
  {
    key: 'minimumCosmicLfo',
    label: 'Cosmic LFO',
    i18nKey: 'cosmicLfoMenu.sources.minimumCosmicLfo',
    libIcon: 'cosmic-lfo',
    legacySymbol: 'cosmic-lfo.svg',
  },
  {
    key: 'stellarLuminosityLsun',
    label: 'Stellar Luminosity (L☉)',
    i18nKey: 'cosmicLfoMenu.sources.stellarLuminosityLsun',
    libIcon: 'stellar-luminosity',
    legacySymbol: 'stellar-luminosity.svg',
  },
  {
    key: 'frequencyCpd',
    label: 'Frequency (CPD)',
    i18nKey: 'cosmicLfoMenu.sources.frequencyCpd',
    libIcon: 'frequency-cpd',
    legacySymbol: 'frequency-cpd.svg',
  },
  {
    key: 'mass',
    label: 'Mass',
    i18nKey: 'cosmicLfoMenu.sources.mass',
    libIcon: 'mass',
    legacySymbol: 'mass.svg',
  },
];

/**
 * The manual source — the ONE source that shows a continuous frequency knob instead of
 * the multipliers.
 */
export const COSMIC_MANUAL_SOURCE: CosmicSourceDef = {
  key: MANUAL_SOURCE_KEY,
  label: 'Frequency',
  i18nKey: 'cosmicLfoMenu.sources.manualFrequency',
  libIcon: 'manual-frequency',
  legacySymbol: 'manual-freq.svg',
};

/** Full menu order: the four discrete sources, then Manual (matches the legacy menu). */
export const COSMIC_SOURCES: readonly CosmicSourceDef[] = [
  ...COSMIC_DISCRETE_SOURCES,
  COSMIC_MANUAL_SOURCE,
];

/**
 * The fork that decides the panel's two modes: manual → continuous knob; anything else
 * (a discrete source) → multipliers. Accepts the legacy `'manual-frequency'` alias too.
 */
export function isManualSource(key: string | null | undefined): boolean {
  return key === MANUAL_SOURCE_KEY || key === 'manual-frequency';
}

export interface CosmicWaveformDef {
  key: string;
  label: string;
  i18nKey: string;
  libIcon: IconName;
  legacySymbol: string;
}

/** Oscillator waveforms — the `${axis}-waveform` param values. Array order = menu order. */
export const COSMIC_WAVEFORMS: readonly CosmicWaveformDef[] = [
  {
    key: 'sine',
    label: 'Sine',
    i18nKey: 'cosmicLfoMenu.waveforms.sine',
    libIcon: 'waveform-sine',
    legacySymbol: 'wf-sine.svg',
  },
  {
    key: 'square',
    label: 'Square',
    i18nKey: 'cosmicLfoMenu.waveforms.square',
    libIcon: 'waveform-square',
    legacySymbol: 'wf-square.svg',
  },
  {
    key: 'sawtooth',
    label: 'Sawtooth',
    i18nKey: 'cosmicLfoMenu.waveforms.sawtooth',
    libIcon: 'waveform-up',
    legacySymbol: 'wf-up.svg',
  },
  {
    key: 'triangle',
    label: 'Triangle',
    i18nKey: 'cosmicLfoMenu.waveforms.triangle',
    libIcon: 'waveform-updown',
    legacySymbol: 'wf-updown.svg',
  },
];

/** Allowed waveform keys, in order (legacy `ALLOWED_WAVEFORMS`). */
export const COSMIC_WAVEFORM_KEYS: readonly string[] = COSMIC_WAVEFORMS.map((w) => w.key);
