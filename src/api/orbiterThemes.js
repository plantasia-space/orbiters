/**
 * @file src/api/orbiterThemes.js
 * @description Theme catalog source for Orbiters.
 *
 * SOURCE OF TRUTH: the `plantasia.space-design/theme` package — NOT the backend `theme-config`
 * endpoint anymore (see planning/theme-architecture/PLAN.md). The library ships the baked catalog;
 * `loadThemeCatalog` hot-updates it from the herbarium CDN (with a baked fallback), so a CDN
 * miss/outage can never break theming. This rebuilds the same endpoint-shaped payload the existing
 * `ThemePresetController` normalizer already consumes, so nothing downstream changes.
 */
import { loadThemeCatalog, THEME_CATALOG_VERSION, buildBrandVars } from 'plantasia.space-design/theme';
import { getHerbariumBase } from '../utils/cdnAssets.js';

let catalogPromise = null;
function loadCatalog(signal) {
  if (!catalogPromise) {
    // herbarium base if configured; undefined => loadThemeCatalog returns the baked catalog.
    const baseUrl = getHerbariumBase() || undefined;
    catalogPromise = loadThemeCatalog({ baseUrl, version: THEME_CATALOG_VERSION, signal });
  }
  return catalogPromise;
}

/**
 * Returns the theme-config payload (endpoint shape) built from the library catalog. Each item's
 * `id` is the preset's permanent, rename-proof `uid` (so the normalizer's `baseId` stays stable
 * across a slug rename); the original name-slug rides along as `slug` so legacy descriptors whose
 * `themeId` still holds the slug (from before uids existed) keep resolving. Full `styles.{light,dark}` included.
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<object>}
 */
export async function fetchOrbitersThemes(options = {}) {
  const catalog = await loadCatalog(options.signal);
  // The catalog preset references its font by id (`fontBody`); the usable family + webfont import URL
  // live in the font catalog. Resolve them here so the edit panel can both set the font family AND
  // load the webfont (it reads item.fontFamily / fontId / fontImportUrl / fontLabel).
  const fonts = catalog.fontsByVersion?.[catalog.configVersion] ?? [];
  const fontById = new Map(fonts.map((font) => [font.id, font]));
  const items = catalog.presets.map((preset) => {
    const bodyFont = fontById.get(preset.fontBody);
    return {
      ...preset,
      id: preset.uid,
      slug: preset.id,
      fontId: preset.fontBody ?? null,
      fontFamily: bodyFont?.family ?? preset.fontFamily ?? null,
      fontLabel: bodyFont?.label ?? null,
      fontImportUrl: bodyFont?.importUrl ?? null,
    };
  });
  return {
    group: 'orbiter-theme-themes',
    latestVersion: catalog.configVersion,
    version: catalog.configVersion,
    items,
    lastUpdated: null,
  };
}

/**
 * Applies the catalog's GLOBAL brand record (brand primitives + entity accents) to `:root` once.
 * Theme-independent: it sits beneath the per-orbiter / chrome tokens and is NOT cleared on a theme
 * switch. Reuses the memoized catalog (no extra request). When the catalog has no brand (older
 * versions / before the first brand publish) `buildBrandVars` returns `{}` and nothing is written.
 * Mirrors the plantasia.space-root applier.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export async function applyBrandVars(options = {}) {
  if (typeof document === 'undefined') return;
  const catalog = await loadCatalog(options.signal);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(buildBrandVars(catalog.brand))) {
    if (value) root.style.setProperty(key, value);
  }
}
