/**
 * @file src/api/orbiterFonts.js
 * @description Font catalog source for Orbiters.
 *
 * SOURCE OF TRUTH: the `plantasia.space-design/theme` package — NOT the backend
 * `fonts-config-files` endpoint anymore (see planning/theme-architecture/PLAN.md). The library ships
 * the baked font catalog; `loadThemeCatalog` hot-updates it from the herbarium CDN (with a baked
 * fallback), so a CDN miss/outage can never break the font list. This rebuilds the same
 * endpoint-shaped payload the edit panel's `_normalizeFontCatalog` already consumes, so nothing
 * downstream changes. Mirrors `orbiterThemes.js`.
 */
import { loadThemeCatalog, THEME_CATALOG_VERSION, getCatalogFonts } from 'plantasia.space-design/theme';
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
 * Returns the fonts-config payload (endpoint shape) built from the library catalog. Each item carries
 * id/label/family/importUrl/weights straight from the catalog font list, so the edit panel's
 * `_normalizeFontCatalog` keeps working unchanged.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object>}
 */
export async function fetchOrbitersFonts(options = {}) {
  const catalog = await loadCatalog(options.signal);
  const cv = catalog.configVersion;
  const items = getCatalogFonts(catalog);
  return {
    group: 'orbiter-fonts',
    latestVersion: cv,
    version: cv,
    versions: {
      [cv]: { version: cv, orbiterFonts: { package: 'UI Fonts', items } },
    },
    lastUpdated: null,
  };
}
