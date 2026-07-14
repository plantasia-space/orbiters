/**
 * @file src/ui/studioChromeTheme.js
 * @description Themes the Orbiter Studio CHROME — specifically the external edit-panel shell
 * (`.orb-studio__panel` / the mobile drawer) — from the USER's chosen preset, decoupling it from the
 * orbiter's own content theme.
 *
 * Why scoped (not :root): orbitersUI.css maps the orbiter entity/content theme onto the design-library
 * token contract ONLY under `.orbiters-react-ui`. This module writes the user's app/chrome preset onto
 * the Studio shell element and mirrors it for Studio portals. These two scopes must stay separate:
 * - `.orbiters-react-ui` = orbiter entity theme saved on the orbiter.
 * - `.orb-studio__panel` / mobile drawer / `.orb-studio__portal-surface` = user chrome theme from
 *   `/me/users/settings`.
 *
 * The preference itself is the same one ps-root writes and resolves. The current root contract stores
 * the selected preset in `design.theme.id`; older persisted settings may still carry stale
 * `label`/`variantMap`, so those are fallback-only and must not override a resolvable id.
 * See planning/theme-architecture/PLAN.md.
 */
import {
  loadThemeCatalog,
  resolvePreset,
  THEME_CATALOG_VERSION,
  DEFAULT_THEME_PRESET_ID,
} from 'plantasia.space-design/theme';
import { fetchUserSettings } from '../api/settingsApi.js';
import { getHerbariumBase } from '../utils/cdnAssets.js';

const FONT_LINK_PREFIX = 'studio-chrome-font-';
const PORTAL_VAR_PREFIX = '--orb-studio-chrome-';
const BODY_CHROME_ATTR = 'orbStudioChromeTheme';
const COLOR_ALIAS_KEYS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'success-foreground',
  'border',
  'border-2',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
];
// ── One-time resolution + cache ──────────────────────────────────────────────
// The resolved chrome theme (library tokens + fonts) does NOT depend on the target element, so it is
// resolved ONCE — settings + catalog fetched a single time — and cached. Every apply after that writes
// the cached vars SYNCHRONOUSLY: no network, no flash. This is what makes re-mounting targets cheap —
// the mobile bottom sheet (`DrawerContent`) remounts on EVERY open, and there are multiple targets
// (desktop panel / mobile sheet / mobile bar). Before this, each of those re-fetched and flashed the
// DEFAULT preset before the user's preset landed. `orbiters:auth-token` invalidates the cache (the
// embedded dashboard's token arrives after mount, so the pre-auth DEFAULT must be replaced by the
// user's real preset) via refreshStudioChromeTheme().
let resolvedChrome = null; // { vars, fonts } once resolved — the cache
let resolveInFlight = null; // de-dupes concurrent first-resolves
let resolveGen = 0; // bumped on every reset; a resolve only writes if its generation is still current
const targetVars = new WeakMap();
let portalVars = new Set();

// ── localStorage fast-start (cold-load) cache ────────────────────────────────
// The in-memory `resolvedChrome` is empty on every cold reload, so the first apply has to wait on the
// settings + catalog network round-trip (flash of the unthemed/default chrome). Persist the last
// resolved { vars, fonts } so a reload can paint the user's chrome SYNCHRONOUSLY before any network. It
// is only a fast START: the authoritative resolve still runs in the background and overwrites this, so a
// stale persist (preset changed elsewhere, OR a catalog/token-shape change) self-corrects within the
// same session. Intentionally NOT version-stamped: the old THEME_CATALOG_VERSION guard dropped this
// cache on every lib release, re-flashing the unthemed/default chrome before the network resolve landed
// (mirrors the ps-root FOUC fix) — and it keyed on the BAKED version, which a herbarium CDN
// edit never bumps anyway. A slightly-stale paint (missing a newly-added token for one frame) is always
// corrected by the background resolve; only bump the `.v1` SHAPE suffix if the stored object shape
// changes incompatibly.
const STORAGE_KEY = 'orbiters.studioChromeTheme.v1';

function loadPersistedChrome() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.vars) return null;
    return { vars: parsed.vars, fonts: parsed.fonts || null };
  } catch {
    return null; // malformed / disabled storage — persistence is a nicety, never fatal.
  }
}

function savePersistedChrome(resolved) {
  if (typeof localStorage === 'undefined' || !resolved?.vars) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ vars: resolved.vars, fonts: resolved.fonts || null }),
    );
    persistedChrome = { vars: resolved.vars, fonts: resolved.fonts || null };
  } catch {
    // storage full / disabled — ignore.
  }
}

let persistedChrome = loadPersistedChrome();

function normalizeThemeReference(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/::(?:light|dark)$/i, '');
}

function getSettingsThemeCandidates(theme) {
  // Match plantasia.space-root AND entangled-worlds: the selected preset is `design.theme.id` (the
  // permanent rename-proof `uid` first, legacy slug fallback inside the design-library resolver). The
  // sibling `label` and `variantMap` fields are STALE leftovers from older merged settings writes (the
  // root contract normalizes saved settings down to `{ id }`), so they are NOT resolution sources —
  // including `variantMap` here would silently re-animate exactly the stale data the model retires, and
  // would diverge from root/EW which resolve id-only. Light/dark is applied by `resolvePreset(…, mode)`,
  // never via the stored variant ref. Candidates: the canonical id, then the library default.
  return [
    normalizeThemeReference(theme?.id),
    DEFAULT_THEME_PRESET_ID,
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
}

function ensureFontLink(id, href) {
  if (typeof document === 'undefined') return;
  const linkId = `${FONT_LINK_PREFIX}${id}`;
  let link = document.getElementById(linkId);
  if (!href) {
    if (link) link.remove();
    return;
  }
  if (!link) {
    link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

function clearTargetVars(target) {
  const vars = targetVars.get(target);
  if (vars) {
    vars.forEach((key) => target.style.removeProperty(key));
  }
  target.style.removeProperty('--font-sans');
  target.style.removeProperty('--font-title');
  target.style.removeProperty('font-family');
  targetVars.delete(target);
}

function writeVarsToTarget(target, vars) {
  clearTargetVars(target);
  const applied = new Set();
  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue;
    target.style.setProperty(key, value);
    applied.add(key);
  }
  for (const key of COLOR_ALIAS_KEYS) {
    const source = `--${key}`;
    // Only alias tokens the preset ACTUALLY set. Writing `--color-x: var(--x)` for a token the preset
    // omits resolves to EMPTY (the base token is unset), which then SHADOWS any value the element would
    // otherwise inherit — blanking borders/colors instead of falling through. (e.g. presets without
    // `--border-2`.)
    if (!vars[source]) continue;
    const alias = `--color-${key}`;
    target.style.setProperty(alias, `var(${source})`);
    applied.add(alias);
  }
  targetVars.set(target, applied);
}

function clearPortalVars() {
  if (typeof document === 'undefined') return;
  const { body } = document;
  portalVars.forEach((key) => body.style.removeProperty(key));
  portalVars = new Set();
  delete body.dataset[BODY_CHROME_ATTR];
}

// Portal surfaces read tokens through the CSS bridge in orbitersUI.css, whose per-token fallback
// (`--x: var(--orb-studio-chrome-x, var(--x))`) is SELF-referential — CSS resolves that cycle to
// invalid, so any token the preset omits renders as `initial` on portalled content (a TRANSPARENT
// popover over the page, not an inherited default). Guarantee the surface-critical tokens by
// backfilling each missing one from the nearest sibling the preset did set.
// EVERY token the portal-surface bridge maps must end up defined, or its cycle resolves invalid —
// so this list covers the full bridged set, each falling back through its nearest siblings.
// Order matters: base surfaces fill first so later entries can inherit their backfilled values.
const PORTAL_VAR_BACKFILL = [
  // The two roots first — a preset that names only a card/popover surface can still paint everything.
  ['background', ['card', 'popover']],
  ['foreground', ['card-foreground', 'popover-foreground']],
  ['card', ['background']],
  ['card-foreground', ['foreground']],
  ['popover', ['card', 'background']],
  ['popover-foreground', ['card-foreground', 'foreground']],
  ['secondary', ['muted', 'card', 'background']],
  ['secondary-foreground', ['muted-foreground', 'foreground']],
  ['muted', ['secondary', 'card', 'background']],
  ['muted-foreground', ['secondary-foreground', 'foreground']],
  ['accent', ['secondary', 'muted', 'card', 'background']],
  ['accent-foreground', ['secondary-foreground', 'foreground']],
  ['primary', ['foreground']],
  ['primary-foreground', ['background']],
  ['border', ['border-2', 'input']],
  ['input', ['border', 'border-2']],
  ['ring', ['border', 'border-2', 'input']],
];

function backfillPortalVars(vars) {
  const filled = { ...vars };
  for (const [key, sources] of PORTAL_VAR_BACKFILL) {
    if (filled[`--${key}`]) continue;
    const source = sources.find((candidate) => filled[`--${candidate}`]);
    if (source) filled[`--${key}`] = filled[`--${source}`];
  }
  return filled;
}

function writeVarsForPortals(rawVars) {
  if (typeof document === 'undefined') return;
  const { body } = document;
  clearPortalVars();

  const vars = backfillPortalVars(rawVars);
  // The bridge's per-token fallback is self-referential, so a token with no mirrored value resolves
  // INVALID (a transparent surface), NOT to the library default. `--background`/`--foreground` are the
  // roots every other token backfills from: without them the mirror cannot paint a surface at all, so
  // leave the bridge OFF and let portalled content keep the library's own `dark` tokens (opaque, if
  // unthemed) instead of turning it on and rendering see-through panels.
  if (!vars['--background'] || !vars['--foreground']) return;
  body.dataset[BODY_CHROME_ATTR] = 'on';

  for (const [key, value] of Object.entries(vars)) {
    if (!value || !key.startsWith('--')) continue;
    const portalKey = `${PORTAL_VAR_PREFIX}${key.slice(2)}`;
    body.style.setProperty(portalKey, value);
    portalVars.add(portalKey);
  }
  for (const key of COLOR_ALIAS_KEYS) {
    // Same as writeVarsToTarget: skip aliases whose base token the preset didn't set, so the portal
    // surface never gets an empty `--color-*` override that shadows an inherited value.
    if (!vars[`--${key}`]) continue;
    const portalKey = `${PORTAL_VAR_PREFIX}color-${key}`;
    body.style.setProperty(portalKey, `var(${PORTAL_VAR_PREFIX}${key})`);
    portalVars.add(portalKey);
  }
}

function applyResolvedChromeTheme(target, { vars, fonts }) {
  writeVarsToTarget(target, vars);
  writeVarsForPortals(vars);

  // Fonts: the orbiter sets `document.body.style.fontFamily` directly, which the panel INHERITS — a
  // `--font-sans` token override can't beat an inherited `font-family`. So set the panel element's
  // actual `font-family` (its subtree then uses the user/default font), plus the tokens + @import.
  if (fonts?.body?.family) {
    target.style.setProperty('--font-sans', fonts.body.family);
    target.style.fontFamily = fonts.body.family;
    document.body.style.setProperty(`${PORTAL_VAR_PREFIX}font-sans`, fonts.body.family);
    portalVars.add(`${PORTAL_VAR_PREFIX}font-sans`);
  }
  if (fonts?.title?.family) {
    target.style.setProperty('--font-title', fonts.title.family);
    document.body.style.setProperty(`${PORTAL_VAR_PREFIX}font-title`, fonts.title.family);
    portalVars.add(`${PORTAL_VAR_PREFIX}font-title`);
  }
  ensureFontLink('body', fonts?.body?.importUrl || null);
  ensureFontLink('title', fonts?.title?.importUrl || null);
}

/**
 * Resolve the user's preset (or the library default) and write its library tokens onto `target`
 * (the shell panel element). Never throws.
 * @param {HTMLElement} target
 * @param {{ signal?: AbortSignal }} options
 */
// The actual settings + catalog fetch + preset resolution (runs at most once until invalidated).
async function resolveChromeTheme(signal) {
  const settings = await fetchUserSettings({ signal });
  const design = settings?.design || {};
  const mode = settings?.general?.themeMode === 'light' ? 'light' : 'dark';
  const themeCandidates = getSettingsThemeCandidates(design?.theme);
  const manualFonts = design?.fonts || undefined;
  const baseUrl = getHerbariumBase() || undefined;
  const catalog = await loadThemeCatalog({ baseUrl, version: THEME_CATALOG_VERSION, signal });
  return (
    themeCandidates
      .map((themeId) => resolvePreset(catalog, themeId, mode, manualFonts))
      .find((candidate) => candidate.preset) || resolvePreset(catalog, DEFAULT_THEME_PRESET_ID, mode)
  );
}

// Returns the cached resolved theme, the in-flight resolve, or starts (and caches) a new one.
// A `resetStudioChromeThemeCache()` (e.g. auth lands) bumps `resolveGen`; an in-flight resolve from a
// PRIOR generation must NOT write its now-stale result into the cache (this replaces the old `applySeq`
// latest-wins guard — without it a slow pre-auth DEFAULT could land after the user-preset resolve).
function ensureChromeResolved(signal) {
  if (resolvedChrome) return Promise.resolve(resolvedChrome);
  if (!resolveInFlight) {
    const gen = resolveGen;
    resolveInFlight = resolveChromeTheme(signal)
      .then((resolved) => {
        if (gen === resolveGen) {
          resolvedChrome = resolved;
          resolveInFlight = null;
          savePersistedChrome(resolved); // refresh the cold-load fast-start cache
        }
        return resolved;
      })
      .catch((err) => {
        if (gen === resolveGen) resolveInFlight = null; // allow a retry on the next apply/refresh
        throw err;
      });
  }
  return resolveInFlight;
}

/**
 * Kick off the one-time resolve EARLY (at shell mount) so the cache is warm before the first surface
 * (panel/sheet/bar) applies — eliminating the initial flash. Safe to call repeatedly (no-op once warm).
 */
export function prewarmStudioChromeTheme({ signal } = {}) {
  if (typeof document === 'undefined') return;
  ensureChromeResolved(signal).catch(() => {});
}

/**
 * Resolve the user's preset (or the library default) and write its library tokens onto `target`.
 * Applies SYNCHRONOUSLY from cache when warm (no flash on a remounting sheet); otherwise resolves once
 * (shared across all concurrent targets) and applies. Never throws.
 * @param {HTMLElement} target
 * @param {{ signal?: AbortSignal }} options
 */
export async function applyStudioChromeTheme(target, { signal } = {}) {
  if (!target || typeof document === 'undefined') return;
  if (resolvedChrome) {
    applyResolvedChromeTheme(target, resolvedChrome); // warm cache → instant, no network
    return;
  }
  // Cold start with a persisted theme: paint it SYNCHRONOUSLY (no flash), then still resolve fresh in
  // the background and re-apply if the target is still mounted — so a stale persist self-corrects.
  if (persistedChrome) {
    applyResolvedChromeTheme(target, persistedChrome);
    // Background refresh. Capture the generation NOW: if resetStudioChromeThemeCache() (e.g. auth lands)
    // bumps it before this resolves, this resolve is STALE — skip the re-apply so a slow pre-auth/default
    // resolve can't clobber a newer post-reset apply (the apply that StudioShell.onAuth kicks off).
    const gen = resolveGen;
    ensureChromeResolved(signal)
      .then((resolved) => {
        if (gen === resolveGen && target.isConnected) applyResolvedChromeTheme(target, resolved);
      })
      .catch(() => {});
    return;
  }
  try {
    // Same latest-wins guard as the persisted branch above: a resolve started BEFORE a reset (e.g. the
    // pre-auth one) must not paint after the post-reset resolve has already landed — it would write back
    // the stale token set (and re-enable the portal bridge the newer resolve deliberately left off).
    const gen = resolveGen;
    const resolved = await ensureChromeResolved(signal);
    if (gen === resolveGen) applyResolvedChromeTheme(target, resolved);
  } catch {
    // Chrome theming is decorative. If settings/catalog are unavailable, keep the surface usable and
    // let the next auth/settings change retry via refreshStudioChromeTheme().
  }
}

/**
 * Drop the cached resolved theme so the NEXT apply re-resolves from scratch. Call when the resolution
 * inputs change — the auth token lands (pre-auth DEFAULT must become the user's preset), logout, or a
 * settings save. Callers then re-apply to their live targets. Also used by tests for isolation.
 */
export function resetStudioChromeThemeCache() {
  resolveGen += 1; // invalidate any in-flight resolve so its stale result can't repopulate the cache
  resolvedChrome = null;
  resolveInFlight = null;
  // Drop the in-memory fast-start too so post-reset applies AWAIT a fresh resolve instead of painting
  // the now-suspect last value. The localStorage copy is intentionally left intact: the cold-load
  // instant paint already fired before any reset, and it stays available for the next reload (the next
  // successful resolve overwrites it via savePersistedChrome).
  persistedChrome = null;
}

export function clearStudioChromeTheme(target) {
  if (target) {
    clearTargetVars(target);
  }
  clearPortalVars();
}
