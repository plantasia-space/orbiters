// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchUserSettings } from '../../src/api/settingsApi.js';
import { loadThemeCatalog, resolvePreset } from 'plantasia.space-design/theme';
import { applyStudioChromeTheme, clearStudioChromeTheme, resetStudioChromeThemeCache } from '../../src/ui/studioChromeTheme.js';

vi.mock('../../src/api/settingsApi.js', () => ({
  fetchUserSettings: vi.fn(),
}));

vi.mock('../../src/utils/cdnAssets.js', () => ({
  getHerbariumBase: () => 'https://herbarium.test',
}));

vi.mock('plantasia.space-design/theme', () => ({
  THEME_CATALOG_VERSION: 'test-version',
  DEFAULT_THEME_PRESET_ID: 'ps-default',
  loadThemeCatalog: vi.fn(() => Promise.resolve({ presets: [] })),
  resolvePreset: vi.fn((_catalog, id, mode, fonts) => ({
    preset: { uid: id },
    vars: {
      '--background': `${id}-${mode}-background`,
      '--foreground': `${id}-${mode}-foreground`,
    },
    fonts,
  })),
}));

const SETTINGS_FONTS = {
  body: {
    family: "'Orbit', sans-serif",
    importUrl: 'https://fonts.test/orbit.css',
  },
  title: {
    family: "'Inter', sans-serif",
    importUrl: 'https://fonts.test/inter.css',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // The resolved theme is cached module-globally (resolved once in production); reset between tests
  // so each case re-resolves with its own mocked settings/catalog.
  resetStudioChromeThemeCache();
  resolvePreset.mockImplementation((_catalog, id, mode, fonts) => ({
    preset: { uid: id },
    vars: {
      '--background': `${id}-${mode}-background`,
      '--foreground': `${id}-${mode}-foreground`,
    },
    fonts,
  }));
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  delete document.body.dataset.orbStudioChromeTheme;
  localStorage.clear(); // the cold-load fast-start cache lives here — isolate it per test
});

describe('applyStudioChromeTheme', () => {
  it('prefers the canonical theme id over stale label and variantMap fields', async () => {
    fetchUserSettings.mockResolvedValue({
      version: 1,
      general: { themeMode: 'dark' },
      design: {
        fonts: SETTINGS_FONTS,
        theme: {
          id: 'cacao-love',
          label: 'Northern Lights',
          variantMap: {
            light: 'northern-lights::light',
            dark: 'northern-lights::dark',
          },
        },
      },
    });
    const target = document.createElement('aside');

    await applyStudioChromeTheme(target);

    expect(loadThemeCatalog).toHaveBeenCalledWith({
      baseUrl: 'https://herbarium.test',
      version: 'test-version',
      signal: undefined,
    });
    expect(resolvePreset).toHaveBeenCalledWith(
      { presets: [] },
      'cacao-love',
      'dark',
      SETTINGS_FONTS,
    );
    expect(target.style.getPropertyValue('--background')).toBe('cacao-love-dark-background');
    expect(target.style.getPropertyValue('--font-sans')).toBe("'Orbit', sans-serif");
    expect(document.body.dataset.orbStudioChromeTheme).toBe('on');
    expect(document.body.style.getPropertyValue('--orb-studio-chrome-background')).toBe(
      'cacao-love-dark-background',
    );
  });

  it('backfills surface-critical portal tokens a preset omits (popover/card from background)', async () => {
    // The portal CSS bridge's per-token fallback is self-referential (cyclic → invalid), so a preset
    // without `--popover` used to render portalled dropdowns TRANSPARENT. The portal writer must
    // guarantee those tokens from the nearest sibling the preset did set.
    fetchUserSettings.mockResolvedValue({
      version: 1,
      general: { themeMode: 'dark' },
      design: { theme: { id: 'cacao-love' } },
    });
    const target = document.createElement('aside');

    await applyStudioChromeTheme(target);

    const body = document.body.style;
    expect(body.getPropertyValue('--orb-studio-chrome-popover')).toBe('cacao-love-dark-background');
    expect(body.getPropertyValue('--orb-studio-chrome-popover-foreground')).toBe(
      'cacao-love-dark-foreground',
    );
    expect(body.getPropertyValue('--orb-studio-chrome-card')).toBe('cacao-love-dark-background');
    // EVERY bridged token must end up defined (the cycle makes any omission invalid) — the full
    // surface set derives from background/foreground when the preset sets nothing closer.
    expect(body.getPropertyValue('--orb-studio-chrome-secondary')).toBe('cacao-love-dark-background');
    expect(body.getPropertyValue('--orb-studio-chrome-muted')).toBe('cacao-love-dark-background');
    expect(body.getPropertyValue('--orb-studio-chrome-accent')).toBe('cacao-love-dark-background');
    expect(body.getPropertyValue('--orb-studio-chrome-accent-foreground')).toBe(
      'cacao-love-dark-foreground',
    );
    expect(body.getPropertyValue('--orb-studio-chrome-primary')).toBe('cacao-love-dark-foreground');
    expect(body.getPropertyValue('--orb-studio-chrome-primary-foreground')).toBe(
      'cacao-love-dark-background',
    );
    // The target element keeps preset-only vars (it inherits normally; no cycle there).
    expect(target.style.getPropertyValue('--popover')).toBe('');
  });

  it('derives background/foreground from a card-only preset so the bridge can still paint', async () => {
    // A preset may name only a card/popover surface. Those are the roots every other portal token
    // backfills from, so derive them rather than leaving the whole mirror unpaintable.
    fetchUserSettings.mockResolvedValue({
      version: 1,
      general: { themeMode: 'dark' },
      design: { theme: { id: 'card-only' } },
    });
    resolvePreset.mockImplementation((_catalog, id) => ({
      preset: { uid: id },
      vars: { '--card': 'ink', '--card-foreground': 'chalk' },
    }));
    const target = document.createElement('aside');

    await applyStudioChromeTheme(target);

    expect(document.body.dataset.orbStudioChromeTheme).toBe('on');
    expect(document.body.style.getPropertyValue('--orb-studio-chrome-background')).toBe('ink');
    expect(document.body.style.getPropertyValue('--orb-studio-chrome-foreground')).toBe('chalk');
  });

  it('leaves the portal bridge OFF when a resolve yields no paintable surface', async () => {
    // With the bridge ON but nothing mirrored, every bridged token resolves INVALID (the fallback is
    // self-referential) and portalled panels render TRANSPARENT — the scene shows through the confirm
    // dialog. Staying off keeps the library's own dark tokens, which are opaque.
    fetchUserSettings.mockResolvedValue({
      version: 1,
      general: { themeMode: 'dark' },
      design: { theme: { id: 'empty-styles' } },
    });
    resolvePreset.mockImplementation((_catalog, id) => ({ preset: { uid: id }, vars: {} }));
    const target = document.createElement('aside');

    await applyStudioChromeTheme(target);

    expect(document.body.dataset.orbStudioChromeTheme).toBeUndefined();
    expect(document.body.style.getPropertyValue('--orb-studio-chrome-background')).toBe('');
  });

  it('falls back to the library DEFAULT (never the stale variantMap) when the theme id does not resolve', async () => {
    resolvePreset.mockImplementation((_catalog, id, mode, fonts) => {
      if (id === 'missing-old-id') {
        return { preset: null, vars: {}, fonts: undefined };
      }
      return {
        preset: { uid: id },
        vars: {
          '--background': `${id}-${mode}-background`,
          '--foreground': `${id}-${mode}-foreground`,
        },
        fonts,
      };
    });
    fetchUserSettings.mockResolvedValue({
      general: { themeMode: 'light' },
      design: {
        theme: {
          id: 'missing-old-id',
          // Stale leftover from a previous pick — must NEVER be used as a resolution source.
          variantMap: {
            light: 'northern-lights::light',
          },
        },
      },
    });
    const target = document.createElement('aside');

    await applyStudioChromeTheme(target);

    // The canonical id is tried first, then the library default — the stale variantMap ref
    // (`northern-lights`) is never a candidate (matches plantasia.space-root / entangled-worlds).
    expect(resolvePreset).toHaveBeenNthCalledWith(1, { presets: [] }, 'missing-old-id', 'light', undefined);
    expect(resolvePreset).toHaveBeenNthCalledWith(2, { presets: [] }, 'ps-default', 'light', undefined);
    expect(resolvePreset).not.toHaveBeenCalledWith({ presets: [] }, 'northern-lights', 'light', undefined);
    expect(target.style.getPropertyValue('--background')).toBe('ps-default-light-background');
  });

  it('clears target and portal vars without touching orbiter entity vars', async () => {
    fetchUserSettings.mockResolvedValue({
      general: { themeMode: 'dark' },
      design: { theme: { id: 'twister' } },
    });
    document.documentElement.style.setProperty('--color1', '#ff00aa');
    const target = document.createElement('aside');

    await applyStudioChromeTheme(target);
    clearStudioChromeTheme(target);

    expect(target.style.getPropertyValue('--background')).toBe('');
    expect(document.body.style.getPropertyValue('--orb-studio-chrome-background')).toBe('');
    expect(document.body.dataset.orbStudioChromeTheme).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--color1')).toBe('#ff00aa');
  });

  it('persists the resolved theme to localStorage (version-INDEPENDENT) after a resolve', async () => {
    fetchUserSettings.mockResolvedValue({
      general: { themeMode: 'dark' },
      design: { theme: { id: 'cacao-love' }, fonts: SETTINGS_FONTS },
    });

    await applyStudioChromeTheme(document.createElement('aside'));

    const raw = localStorage.getItem('orbiters.studioChromeTheme.v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    // The fast-start cache is NOT version-stamped — it's last-known-good vars that survive a
    // catalog/lib-version bump (freshness comes from the background resolve, not from invalidation).
    expect(parsed.version).toBeUndefined();
    expect(parsed.vars['--background']).toBe('cacao-love-dark-background');
  });

  it('cold-load: paints the persisted theme synchronously, before any settings/catalog network', async () => {
    // Seed localStorage as a prior session's resolve would have, then re-import the module so its
    // module-load hydration re-reads it. No `version` field (the cache is version-INDEPENDENT)
    // — this also proves a version-less entry still loads on cold start.
    localStorage.setItem(
      'orbiters.studioChromeTheme.v1',
      JSON.stringify({ vars: { '--background': 'persisted-background' }, fonts: null }),
    );
    vi.resetModules();
    const mod = await import('../../src/ui/studioChromeTheme.js');

    const target = document.createElement('aside');
    const pending = mod.applyStudioChromeTheme(target); // persisted fast-path: returns after a SYNC paint

    // No await: the persisted vars are already on the element (no network was waited on).
    expect(target.style.getPropertyValue('--background')).toBe('persisted-background');

    await pending; // let the background resolve settle (its result is irrelevant here)
  });

  it('cold-load: a reset BEFORE the background resolve completes skips the stale re-apply', async () => {
    localStorage.setItem(
      'orbiters.studioChromeTheme.v1',
      JSON.stringify({ version: 'test-version', vars: { '--background': 'persisted-background' }, fonts: null }),
    );
    vi.resetModules();
    const mod = await import('../../src/ui/studioChromeTheme.js');

    // Make the resolve HANG so we can reset while it's in flight.
    let releaseSettings;
    fetchUserSettings.mockReturnValue(
      new Promise((res) => { releaseSettings = () => res({ general: { themeMode: 'dark' }, design: { theme: { id: 'cacao-love' } } }); }),
    );

    const target = document.createElement('aside');
    document.body.appendChild(target); // connected → a re-apply WOULD take effect if not guarded
    mod.applyStudioChromeTheme(target);
    expect(target.style.getPropertyValue('--background')).toBe('persisted-background');

    mod.resetStudioChromeThemeCache(); // bumps generation → the in-flight resolve is now stale
    releaseSettings();
    await new Promise((r) => setTimeout(r, 10)); // let the (stale) resolve chain settle

    // The stale resolve must NOT have clobbered the target with 'cacao-love-dark-background'.
    expect(target.style.getPropertyValue('--background')).toBe('persisted-background');
  });
});
