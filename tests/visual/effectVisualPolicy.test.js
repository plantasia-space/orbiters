/**
 * The effect-visual enablement resolver: one policy mapping the graphics
 * preset + the (stubbed) user preference to per-group settings. Layers never
 * read the preset directly — this is the seam a future settings surface talks
 * to.
 */
import { describe, it, expect } from 'vitest';
import {
  EFFECT_VISUAL_GROUPS,
  resolveEffectVisualSettings,
  effectVisualGroupOf,
} from '../../src/visual/effectVisualPolicy.js';

describe('resolveEffectVisualSettings', () => {
  it('resolves every declared group, enabled by default (the "everything on" stub)', () => {
    const settings = resolveEffectVisualSettings({ key: 'MID' });
    expect(Object.keys(settings).sort()).toEqual([...EFFECT_VISUAL_GROUPS].sort());
    EFFECT_VISUAL_GROUPS.forEach((group) => {
      expect(settings[group].enabled).toBe(true);
    });
  });

  it('derives quality knobs from the preset (accepts a profile object or a key)', () => {
    expect(resolveEffectVisualSettings({ key: 'LOW' }).texture.echoCopies).toBe(2);
    expect(resolveEffectVisualSettings('HIGH').texture.echoCopies).toBe(5);
    expect(resolveEffectVisualSettings('LOW').echoes.summonedMoonCount).toBe(2);
    // The reverb's one costly knob: samples per pixel in the smeared ring. A weak
    // device takes fewer and the room still lets go.
    expect(resolveEffectVisualSettings('HIGH').spaceAir.blurTaps).toBe(14);
    expect(resolveEffectVisualSettings('LOW').spaceAir.blurTaps).toBe(6);
  });

  it('falls back to MID for unknown or missing presets', () => {
    expect(resolveEffectVisualSettings(null).texture.echoCopies).toBe(4);
    expect(resolveEffectVisualSettings('ULTRA').texture.echoCopies).toBe(4);
    expect(resolveEffectVisualSettings(undefined).echoes.summonedMoonCount).toBe(4);
  });

  it('the master preference gate disables every group before quality is considered', () => {
    const settings = resolveEffectVisualSettings('HIGH', { enabled: false });
    EFFECT_VISUAL_GROUPS.forEach((group) => {
      expect(settings[group].enabled).toBe(false);
    });
    // Quality knobs still resolve — a re-enable needs no second pass.
    expect(settings.texture.echoCopies).toBe(5);
  });

  it('per-group preference gates disable only their group', () => {
    const settings = resolveEffectVisualSettings('MID', {
      enabled: true,
      groups: { echoes: false },
    });
    expect(settings.echoes.enabled).toBe(false);
    expect(settings.texture.enabled).toBe(true);
    expect(settings.spaceAir.enabled).toBe(true);
  });
});

describe('effectVisualGroupOf', () => {
  it('names the group an effect answers in', () => {
    expect(effectVisualGroupOf('tone.pingpongdelay')).toBe('echoes');
    expect(effectVisualGroupOf('tone.jcreverb')).toBe('spaceAir');
    expect(effectVisualGroupOf('tone.vibrato')).toBe('wobble');
    expect(effectVisualGroupOf('tone.distortion')).toBe('grit');
    expect(effectVisualGroupOf('tone.bitcrusher')).toBe('grit');
    expect(effectVisualGroupOf('tone.chebyshev')).toBe('grit');
  });

  it('returns null for an effect with no visual — nothing to bind, and no switch to offer', () => {
    // The filters deliberately have none; the rest are not built yet.
    expect(effectVisualGroupOf('tone.filter')).toBeNull();
    expect(effectVisualGroupOf('tone.pitchshift')).toBeNull();
    expect(effectVisualGroupOf(null)).toBeNull();
    expect(effectVisualGroupOf(undefined)).toBeNull();
    // Not fooled by inherited object keys.
    expect(effectVisualGroupOf('constructor')).toBeNull();
    expect(effectVisualGroupOf('toString')).toBeNull();
  });
});
