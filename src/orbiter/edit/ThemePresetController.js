import { fetchOrbitersThemes } from '../../api/orbiterThemes.js';
import { getT } from '../../i18n/index.js';

export const CUSTOM_THEME_VALUE = '__custom__';

function normalizeColorValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeColorForComparison(value) {
  const normalized = normalizeColorValue(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeFontValue(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (min === undefined && max === undefined) return numeric;
  const lower = Number.isFinite(min) ? min : -Infinity;
  const upper = Number.isFinite(max) ? max : Infinity;
  return Math.min(upper, Math.max(lower, numeric));
}

function capitalize(label = '') {
  if (!label) return '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function extractItemsFromPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  const versions = payload?.versions || null;
  if (versions && typeof versions === 'object') {
    const preferredKey = payload?.latestVersion || payload?.version;
    const versionData =
      (preferredKey && versions[preferredKey]) || Object.values(versions)[0] || null;
    if (versionData) {
      const nested = extractItemsFromPayload(versionData);
      if (nested.length) return nested;
    }
  }

  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.themes)) return payload.themes;
  if (Array.isArray(payload.presets)) return payload.presets;

  if (payload.items && typeof payload.items === 'object') {
    return Object.entries(payload.items).map(([key, value]) => ({
      id: value?.id || key,
      ...value,
    }));
  }

  if (payload.index && typeof payload.index === 'object') {
    return Object.entries(payload.index).map(([key, value]) => ({
      id: value?.id || key,
      ...value,
    }));
  }

  if (typeof payload === 'object') {
    return Object.entries(payload)
      .filter(([, value]) => value && typeof value === 'object')
      .map(([key, value]) => ({
        id: value?.id || key,
        ...value,
      }));
  }

  return [];
}

function normalizeThemeItems(items = []) {
  const normalized = [];

  const coerceNumber = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  // Corner radius: the per-mode `radius` token (rem/px) is the single source of truth.
  // Convert it to a px number for the orbiter design; fall back to the legacy preset-level
  // roundedCorners only for pre-0.7.4 catalogs that predate the radius token.
  const radiusTokenToPx = (token, legacy) => {
    if (typeof token === 'string') {
      const n = parseFloat(token);
      if (Number.isFinite(n)) return Math.round(/rem\s*$/.test(token) ? n * 16 : n);
    }
    return coerceNumber(legacy);
  };

  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const baseId = String(
      item.id ||
      item.themeId ||
      item.slug ||
      item.name ||
      item.label ||
      `theme-${index}`
    );
    const baseLabel = String(item.label || item.name || item.title || baseId);
    // Descriptors from before opaque uids existed store the name-slug as themeId; the slug now rides as `item.slug`
    // so those legacy refs still resolve (findThemeById falls back to `legacyId`). New saves use
    // the opaque `id` (uid). Drop this once user/orbiter records are backfilled to the uid.
    const legacySlug = item.slug && String(item.slug) !== baseId ? String(item.slug) : null;
    const description = item.description || item.summary || null;
    const baseRoundedCorners = coerceNumber(item.roundedCorners);
    const baseFrameBorderWidth = coerceNumber(item.frameBorderWidth);
    const baseFontFamily = normalizeFontValue(item.fontFamily || item.font);
    const baseFontId = normalizeFontValue(item.fontId || null);
    const baseFontLabel = item.fontLabel || null;
    const baseFontImportUrl = item.fontImportUrl || null;

    const styles = item.styles && typeof item.styles === 'object' ? item.styles : null;
    if (styles) {
      Object.entries(styles).forEach(([variantKey, variantValue]) => {
        if (!variantValue || typeof variantValue !== 'object') return;
        const primary =
          normalizeColorValue(
            variantValue.primary ??
            variantValue.colorPrimary ??
            variantValue.color1 ??
            variantValue.light ??
            variantValue.primaryHex
          );
        const secondary =
          normalizeColorValue(
            variantValue.secondary ??
            variantValue.colorSecondary ??
            variantValue.color2 ??
            variantValue.dark ??
            variantValue.secondaryHex
          );
        if (!primary || !secondary) return;

        const variantId = `${baseId}::${variantKey.toLowerCase()}`;
        const label = `${baseLabel} (${capitalize(variantKey)})`;
        const variantRounded = coerceNumber(variantValue.roundedCorners);
        const variantFrame = coerceNumber(variantValue.frameBorderWidth);
        const variantFontFamily = normalizeFontValue(
          variantValue.fontFamily ?? variantValue.font ?? baseFontFamily,
        );
        const variantFontId = normalizeFontValue(variantValue.fontId ?? baseFontId);
        const variantFontLabel = variantValue.fontLabel ?? baseFontLabel ?? label;
        const variantFontImportUrl = variantValue.fontImportUrl ?? baseFontImportUrl;

        const accent = normalizeColorValue(
          variantValue.accent ??
          variantValue.accentColor ??
          variantValue.highlight ??
          null
        );
        const accentNormalized = normalizeColorForComparison(accent);

        normalized.push({
          id: variantId,
          baseId,
          legacyId: legacySlug ? `${legacySlug}::${variantKey.toLowerCase()}` : null,
          variant: variantKey.toLowerCase(),
          label,
          description,
          colorPrimary: primary,
          colorSecondary: secondary,
          colorPrimaryNormalized: normalizeColorForComparison(primary),
          colorSecondaryNormalized: normalizeColorForComparison(secondary),
          roundedCorners: radiusTokenToPx(variantValue.radius, variantRounded ?? baseRoundedCorners),
          frameBorderWidth: variantFrame ?? baseFrameBorderWidth,
          fontFamily: variantFontFamily ?? null,
          fontId: variantFontId ?? null,
          fontLabel: variantFontLabel ?? null,
          fontImportUrl: variantFontImportUrl ?? null,
          accentColor: accent ?? null,
          accentColorNormalized: accentNormalized,
        });
      });
      return;
    }

    const primary =
      normalizeColorValue(
        item.colorPrimary ??
        item.primary ??
        item.primaryColor ??
        item.color1 ??
        item.light ??
        item.primaryHex ??
        null
      );
    const secondary =
      normalizeColorValue(
        item.colorSecondary ??
        item.secondary ??
        item.secondaryColor ??
        item.color2 ??
        item.dark ??
        item.secondaryHex ??
        null
      );
    if (!primary || !secondary) return;
    const accent = normalizeColorValue(
      item.accent ??
      item.accentColor ??
      item.highlight ??
      null
    );
    const accentNormalized = normalizeColorForComparison(accent);

    normalized.push({
      id: baseId,
      baseId,
      legacyId: legacySlug,
      variant: null,
      label: baseLabel,
      description,
      colorPrimary: primary,
      colorSecondary: secondary,
      colorPrimaryNormalized: normalizeColorForComparison(primary),
      colorSecondaryNormalized: normalizeColorForComparison(secondary),
      roundedCorners: baseRoundedCorners,
      frameBorderWidth: baseFrameBorderWidth,
      fontFamily: baseFontFamily,
      fontId: baseFontId,
      fontLabel: baseFontLabel ?? baseLabel,
      fontImportUrl: baseFontImportUrl,
      accentColor: accent ?? null,
      accentColorNormalized: accentNormalized,
    });
  });

  const deduped = [];
  const seen = new Set();
  normalized.forEach((theme) => {
    const key = `${theme.id}::${theme.colorPrimaryNormalized}::${theme.colorSecondaryNormalized}::${theme.accentColorNormalized ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(theme);
  });

  return deduped;
}

async function loadThemeCatalog() {
  let payload = null;
  try {
    payload = await fetchOrbitersThemes();
  } catch (err) {
    console.warn('[ThemePresetController] Failed to load theme presets:', err);
    return [];
  }

  const items = extractItemsFromPayload(payload);
  return normalizeThemeItems(items);
}

export class ThemePresetController {
  constructor({ design, getTranslation } = {}) {
    this.design = design || {};
    this.getTranslation = typeof getTranslation === 'function' ? getTranslation : getT;
    this.catalog = null;
    this.catalogPromise = null;
    this.options = null;
    this.controller = null;
    this.state = { theme: CUSTOM_THEME_VALUE };
    this.onPresetApplied = null;
    this.onPresetApplying = null;
  }

  setDesignReference(design) {
    if (design) {
      this.design = design;
    }
  }

  async ensureCatalog() {
    if (Array.isArray(this.catalog)) {
      return this.catalog;
    }
    if (!this.catalogPromise) {
      this.catalogPromise = loadThemeCatalog().then((themes) => {
        this.catalog = themes;
        return themes;
      });
    }
    return this.catalogPromise;
  }

  buildOptions(themes = []) {
    const t = this.getTranslation();
    const customLabel = t('editPanel.design.customTheme');
    if (!Array.isArray(themes) || !themes.length) {
      return { [customLabel]: CUSTOM_THEME_VALUE };
    }

    const sorted = [...themes].sort((a, b) => a.label.localeCompare(b.label));
    const options = { [customLabel]: CUSTOM_THEME_VALUE };
    sorted.forEach((theme) => {
      options[theme.label || theme.id] = theme.id;
    });
    return options;
  }

  findThemeById(themeId) {
    if (!themeId || !Array.isArray(this.catalog)) return null;
    // Match the opaque uid first; fall back to the legacy name-slug for descriptors from before opaque uids existed.
    return this.catalog.find((theme) => theme.id === themeId || theme.legacyId === themeId) || null;
  }

  findMatchingThemeByColors() {
    if (!Array.isArray(this.catalog) || !this.catalog.length) return null;
    const primary = normalizeColorForComparison(this.design?.colorPrimary);
    const secondary = normalizeColorForComparison(this.design?.colorSecondary);
    if (!primary && !secondary) return null;
    return (
      this.catalog.find((theme) => {
        const primaryMatches = !primary || theme.colorPrimaryNormalized === primary;
        const secondaryMatches = !secondary || theme.colorSecondaryNormalized === secondary;
        return primaryMatches && secondaryMatches;
      }) || null
    );
  }

  resolveSelectionId() {
    const label = this.design?.themeLabel;
    const customLabel = this.getTranslation()('editPanel.design.customTheme').toLowerCase();
    if (label && (label.toLowerCase() === 'custom' || label.toLowerCase() === customLabel)) {
      return CUSTOM_THEME_VALUE;
    }
    const explicitId = this.design?.themeId;
    if (explicitId) {
      // Catalog not loaded yet → best effort, echo the saved id.
      if (!this.catalog) return explicitId;
      // Map the saved id to the catalog's CANONICAL id (the opaque uid the Select options are keyed
      // by in `buildOptions`). `findThemeById` also resolves a legacy name-slug (from before opaque uids existed) via
      // `legacyId`, so a saved `themeId` like `ps-default::dark` returns its uid here instead of being
      // echoed verbatim — the verbatim slug matched no uid-keyed option, leaving the trigger blank.
      const found = this.findThemeById(explicitId);
      if (found) return found.id;
    }
    const match = this.findMatchingThemeByColors();
    return match ? match.id : CUSTOM_THEME_VALUE;
  }

  setCustomThemeLabel() {
    const previousId = this.design.themeId ?? null;
    const previousLabel = this.design.themeLabel ?? null;
    this.design.themeId = null;
    this.design.themeLabel = 'Custom';
    if (this.design.themeVariant !== null) {
      this.design.themeVariant = null;
    }
    return previousId !== null || (previousLabel || '').toLowerCase() !== 'custom';
  }

  _notifyPresetApplying(isApplying) {
    if (typeof this.onPresetApplying === 'function') {
      try {
        this.onPresetApplying(Boolean(isApplying));
      } catch (_) {}
    }
  }

  applyThemeSelection(themeId, { skipControllerSync = false } = {}) {
    const isPreset = Boolean(themeId && themeId !== CUSTOM_THEME_VALUE);
    if (isPreset) {
      this._notifyPresetApplying(true);
    }

    let changed = false;

    if (!themeId || themeId === CUSTOM_THEME_VALUE) {
      const changed = this.setCustomThemeLabel();
      this.state.theme = CUSTOM_THEME_VALUE;
      if (!skipControllerSync) {
        this.syncControllerDisplay();
      }
      this._notifyPresetApplying(false);
      return changed;
    }

    const selected = this.findThemeById(themeId);
    if (!selected) {
      const resetChanged = this.setCustomThemeLabel();
      if (!skipControllerSync) {
        this.syncControllerDisplay();
      }
      this._notifyPresetApplying(false);
      return resetChanged;
    }

    const prev = {
      primary: this.design.colorPrimary,
      secondary: this.design.colorSecondary,
      themeId: this.design.themeId,
      themeLabel: this.design.themeLabel,
      ringColor: this.design.ringColor,
      roundedCorners: this.design.roundedCorners,
      frameBorderWidth: this.design.frameBorderWidth,
      fontFamily: this.design.fontFamily,
      fontId: this.design.fontId,
      fontImportUrl: this.design.fontImportUrl,
      fontLabel: this.design.fontLabel,
    };

    this.design.colorPrimary = selected.colorPrimary || this.design.colorPrimary;
    this.design.colorSecondary = selected.colorSecondary || this.design.colorSecondary;
    this.design.themeId = selected.id;
    this.design.themeLabel = selected.label || selected.id;
    if (Number.isFinite(selected.roundedCorners)) {
      const clampedRounded = clampNumber(selected.roundedCorners, 0, 64);
      if (clampedRounded !== null) {
        this.design.roundedCorners = clampedRounded;
      }
    }
    if (Number.isFinite(selected.frameBorderWidth)) {
      const clampedBorder = clampNumber(selected.frameBorderWidth, 0, 12);
      if (clampedBorder !== null) {
        this.design.frameBorderWidth = clampedBorder;
      }
    }
    if (selected.fontFamily) {
      this.design.fontFamily = selected.fontFamily;
    }
    if (Object.prototype.hasOwnProperty.call(selected, 'fontId')) {
      this.design.fontId = selected.fontId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(selected, 'fontImportUrl')) {
      this.design.fontImportUrl = selected.fontImportUrl ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(selected, 'fontLabel')) {
      this.design.fontLabel = selected.fontLabel ?? (selected.fontFamily || null);
    }
    if (selected.variant) {
      this.design.themeVariant = selected.variant;
    } else {
      this.design.themeVariant = null;
    }
    if (selected.accentColor) {
      this.design.ringColor = selected.accentColor;
    }

    if (!skipControllerSync) {
      this.state.theme = selected.id;
      this.syncControllerDisplay();
    }

    changed = (
      prev.primary !== this.design.colorPrimary ||
      prev.secondary !== this.design.colorSecondary ||
      prev.themeId !== this.design.themeId ||
      prev.themeLabel !== this.design.themeLabel ||
      prev.ringColor !== this.design.ringColor ||
      prev.roundedCorners !== this.design.roundedCorners ||
      prev.frameBorderWidth !== this.design.frameBorderWidth ||
      prev.fontFamily !== this.design.fontFamily ||
      prev.fontId !== this.design.fontId ||
      prev.fontImportUrl !== this.design.fontImportUrl ||
      prev.fontLabel !== this.design.fontLabel
    );

    this._notifyPresetApplying(false);

    return changed;
  }

  handleManualColorChange() {
    const changed = this.setCustomThemeLabel();
    this.state.theme = CUSTOM_THEME_VALUE;
    this.syncControllerDisplay();
    return changed;
  }

  syncControllerDisplay() {
    const nextValue = this.resolveSelectionId();
    if (this.state.theme !== nextValue) {
      this.state.theme = nextValue;
    }
    if (this.controller) {
      if (typeof this.controller.updateDisplay === 'function') {
        this.controller.updateDisplay();
      } else if (
        typeof this.controller.setValue === 'function' &&
        this.controller.object?.hasOwnProperty(this.controller.property)
      ) {
        this.controller.setValue(this.state.theme);
      }
    }
  }

  syncFromDesign() {
    this.syncControllerDisplay();
  }

  async attachToFolder(folder, { onPresetApplied, onPresetApplying } = {}) {
    if (!folder) return;
    this.onPresetApplied = typeof onPresetApplied === 'function' ? onPresetApplied : null;
    this.onPresetApplying = typeof onPresetApplying === 'function' ? onPresetApplying : null;
    const themes = await this.ensureCatalog();
    this.options = this.buildOptions(themes);
    const initialId = this.resolveSelectionId();
    this.state.theme = initialId;

    const t = this.getTranslation();
    const controller = folder
      .add(this.state, 'theme', this.options)
      .name(t('editPanel.design.themePreset'))
      .onChange((id) => {
        const changed = this.applyThemeSelection(id, { skipControllerSync: true });
        this.state.theme = this.resolveSelectionId();
        if (this.controller && typeof this.controller.updateDisplay === 'function') {
          this.controller.updateDisplay();
        }
        if (changed) {
          this.onPresetApplied?.();
        }
      });

    this.controller = controller;

    // Ensure the display reflects the resolved selection
    this.syncControllerDisplay();

    // Apply initial selection without re-syncing display (already done)
    const changedInitial = this.applyThemeSelection(initialId, { skipControllerSync: true });
    if (changedInitial) {
      this.onPresetApplied?.();
    }
  }
}
