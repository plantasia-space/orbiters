import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemePresetController } from '../../src/orbiter/edit/ThemePresetController.js';
import { fetchOrbitersThemes } from '../../src/api/orbiterThemes.js';

vi.mock('../../src/api/orbiterThemes.js', () => ({
  fetchOrbitersThemes: vi.fn(),
}));

// Preset `uid` is now an opaque id (`th-001`); the name-slug rides as `slug`. The catalog
// transform sets each item's `id` to the uid and carries `slug` so pre-migration descriptors whose
// `themeId` still holds the slug keep resolving via `findThemeById`'s `legacyId` fallback.
describe('ThemePresetController — legacy slug resolution after the opaque-uid migration', () => {
  beforeEach(() => {
    fetchOrbitersThemes.mockReset();
    fetchOrbitersThemes.mockResolvedValue({
      items: [
        {
          id: 'th-001', // the opaque uid (orbiterThemes maps preset.uid → id)
          uid: 'th-001',
          slug: 'ps-default', // the legacy name-slug (orbiterThemes maps preset.id → slug)
          label: 'PS Default',
          styles: {
            light: { primary: '#ffffff', secondary: '#000000' },
            dark: { primary: '#000000', secondary: '#ffffff' },
          },
        },
      ],
    });
  });

  it('resolves both the opaque uid::mode and the legacy slug::mode to the same variant', async () => {
    const controller = new ThemePresetController({ design: {} });
    await controller.ensureCatalog();

    const byUid = controller.findThemeById('th-001::light');
    const bySlug = controller.findThemeById('ps-default::light');

    expect(byUid).toBeTruthy();
    expect(byUid.id).toBe('th-001::light');
    expect(byUid.legacyId).toBe('ps-default::light');
    // A pre-migration descriptor (themeId = slug::mode) resolves to the exact same entry.
    expect(bySlug).toBe(byUid);
  });

  it('returns null for an unknown id (no silent fallthrough)', async () => {
    const controller = new ThemePresetController({ design: {} });
    await controller.ensureCatalog();
    expect(controller.findThemeById('does-not-exist::light')).toBeNull();
  });

  it('resolveSelectionId maps a saved legacy slug::mode to the canonical uid (the Select option value)', async () => {
    // A pre-migration orbiter saved its themeId as the name-slug (`ps-default::dark`). The React/lil-gui
    // preset Select keys its options by the catalog's opaque uid (`th-001::dark`), so resolveSelectionId
    // must return the uid — returning the slug verbatim matched no option and left the trigger blank.
    const controller = new ThemePresetController({
      design: { themeId: 'ps-default::dark' },
      getTranslation: () => (key) => key,
    });
    await controller.ensureCatalog();
    expect(controller.resolveSelectionId()).toBe('th-001::dark');
  });

  it('resolveSelectionId returns the canonical uid unchanged when the saved id is already a uid', async () => {
    const controller = new ThemePresetController({
      design: { themeId: 'th-001::light' },
      getTranslation: () => (key) => key,
    });
    await controller.ensureCatalog();
    expect(controller.resolveSelectionId()).toBe('th-001::light');
  });
});
