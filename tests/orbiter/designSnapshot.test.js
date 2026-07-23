// @vitest-environment node
/**
 * The design copy/paste snapshot must round-trip EVERY designer color — a field
 * missing from the capture/apply pair silently drops that color when a design
 * is pasted onto another dimension (Color C, the selection color, shipped
 * without it once).
 */
import { describe, it, expect } from 'vitest';
import { DesignPanel } from '../../src/orbiter/edit/DesignPanel.js';

const DESIGN = {
  colorPrimary: '#ffffff',
  colorSecondary: '#bbbbbb',
  colorC: '#33ff41',
  roundedCorners: 12,
  frameBorderWidth: 2,
  ringColor: '#ff00ff',
  ringAmplitudeMultiplier: 1.2,
  ringRadiusMultiplier: 0.9,
  ringEnabled: true,
  fontFamily: 'monospace',
  fontId: 'mono',
  fontImportUrl: null,
  fontLabel: 'Mono',
  themeId: 7,
  themeLabel: 'Dusk',
  themeVariant: 'dark',
};

function bareHost(design) {
  return {
    design,
    themePreset: null,
    _ensureFontForDesign: () => {},
    syncControllers: () => {},
  };
}

describe('DesignPanel snapshot round-trip', () => {
  it('captures and applies every color, including Color C (Selected)', () => {
    const snapshot = DesignPanel.prototype._captureDesignSnapshot.call(bareHost({ ...DESIGN }));
    expect(snapshot.colorPrimary).toBe(DESIGN.colorPrimary);
    expect(snapshot.colorSecondary).toBe(DESIGN.colorSecondary);
    expect(snapshot.colorC).toBe(DESIGN.colorC);

    const target = bareHost({ ...DESIGN, colorPrimary: '#000001', colorSecondary: '#000002', colorC: '#000003' });
    const applied = DesignPanel.prototype._applyDesignSnapshot.call(target, snapshot);
    expect(applied).toBe(true);
    expect(target.design.colorPrimary).toBe(DESIGN.colorPrimary);
    expect(target.design.colorSecondary).toBe(DESIGN.colorSecondary);
    expect(target.design.colorC).toBe(DESIGN.colorC);
  });

  it('a snapshot from before Color C existed keeps the target color instead of wiping it', () => {
    const legacySnapshot = DesignPanel.prototype._captureDesignSnapshot.call(bareHost({ ...DESIGN }));
    delete legacySnapshot.colorC;
    const target = bareHost({ ...DESIGN, colorPrimary: '#000001', colorC: '#123456' });
    DesignPanel.prototype._applyDesignSnapshot.call(target, legacySnapshot);
    expect(target.design.colorC).toBe('#123456');
  });
});
