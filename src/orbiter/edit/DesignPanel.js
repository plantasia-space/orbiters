import { fetchOrbitersFonts } from '../../api/orbiterFonts.js';
import { getT } from '../../i18n/index.js';
import { ThemePresetController } from './ThemePresetController.js';

let designClipboard = null;

function normalizeFontKey(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

export class DesignPanel {
  constructor({ design, getTranslation } = {}) {
    this.getTranslation = typeof getTranslation === 'function' ? getTranslation : getT;
    this.design = design || {};
    this.themePreset = new ThemePresetController({
      design: this.design,
      getTranslation: this.getTranslation
    });

    this.folder = null;
    this.controllers = {};
    this.isApplyingPreset = false;

    this.fontCatalog = null;
    /** In-flight fonts fetch, so concurrent callers share one request (see _loadFontCatalogNormalized). */
    this.fontCatalogPromise = null;
    this.fontSelectorState = { font: null };
    this.fontController = null;
    this.fontOptions = null;
  }

  setDesignReference(design) {
    if (!design) return;
    this.design = design;
    this.themePreset.setDesignReference(design);
  }

  async build(gui, { onDesignChange } = {}) {
    if (!gui) return;
    const t = this.getTranslation();
    const folder = gui.addFolder(t('editPanel.design.folderTitle'));
    this.folder = folder;

    const notifyChange = () => {
      onDesignChange?.();
    };

    const handleThemePresetApplied = () => {
      this._ensureFontForDesign();
      this.syncControllers();
      notifyChange();
    };

    await this.themePreset.attachToFolder(folder, {
      onPresetApplied: handleThemePresetApplied,
      onPresetApplying: (isApplying) => {
        this.isApplyingPreset = Boolean(isApplying);
      },
    });
    this._injectCopyPasteControls(folder, notifyChange);

    const handleColorChange = () => {
      if (this.isApplyingPreset) return;
      this.themePreset.handleManualColorChange();
      notifyChange();
    };

    const designState = this.design;
    const colorPrimaryController = folder
      .addColor(designState, 'colorPrimary')
      .name(t('editPanel.design.colorPrimary'))
      .onChange(handleColorChange);
    const colorSecondaryController = folder
      .addColor(designState, 'colorSecondary')
      .name(t('editPanel.design.colorSecondary'))
      .onChange(handleColorChange);
    const roundedCornersController = folder
      .add(designState, 'roundedCorners', 0, 64, 1)
      .name(t('editPanel.design.roundedCorners'))
      .onChange(notifyChange);
    const frameBorderWidthController = folder
      .add(designState, 'frameBorderWidth', 0, 12, 0.5)
      .name(t('editPanel.design.frameBorderWidth'))
      .onChange(notifyChange);

    this.controllers = {
      colorPrimary: colorPrimaryController,
      colorSecondary: colorSecondaryController,
      roundedCorners: roundedCornersController,
      frameBorderWidth: frameBorderWidthController,
    };

    await this._injectFontSelector(folder, notifyChange);

    const ringEnabledController = folder
      .add(designState, 'ringEnabled')
      .name('Ring Enabled')
      .onChange(notifyChange);
    const ringColorController = folder
      .addColor(designState, 'ringColor')
      .name('Ring Color')
      .onChange(handleColorChange);
    const ringAmplitudeController = folder
      .add(designState, 'ringAmplitudeMultiplier', 0, 10, 0.1)
      .name('Ring Amplitude')
      .onChange(notifyChange);
    const ringRadiusController = folder
      .add(designState, 'ringRadiusMultiplier', 0, 5, 0.05)
      .name('Ring Radius')
      .onChange(notifyChange);

    this.controllers.ringEnabled = ringEnabledController;
    this.controllers.ringColor = ringColorController;
    this.controllers.ringAmplitudeMultiplier = ringAmplitudeController;
    this.controllers.ringRadiusMultiplier = ringRadiusController;

    folder.open();
  }

  _normalizeFontCatalog(payload) {
    if (Array.isArray(payload)) {
      return payload.map((item) => ({
        id: item.id || item.family || item.label,
        label: item.label || item.family || item.id,
        family: item.family || item.label || item.id,
        importUrl: item.importUrl || item.url || null,
        weights: Array.isArray(item.weights) ? item.weights : [],
        description: item.description || '',
        category: item.category || null,
      }));
    }

    const versions = payload?.versions || {};
    const preferredKey = payload?.latestVersion || payload?.version;
    const versionData = (preferredKey && versions[preferredKey]) || Object.values(versions)[0] || null;

    const items = versionData?.orbiterFonts?.items
      || payload?.orbiterFonts?.items
      || payload?.items
      || [];

    return items.map((item) => ({
      id: item.id || item.family || item.label,
      label: item.label || item.family || item.id,
      family: item.family || item.label || item.id,
      importUrl: item.importUrl || item.url || null,
      weights: Array.isArray(item.weights) ? item.weights : [],
      description: item.description || '',
      category: item.category || null,
    }));
  }

  /**
   * The fonts catalog, fetched once. SINGLE-FLIGHT: the in-flight promise is cached, not just its
   * result, so concurrent callers share ONE request. The mobile edit sheet mounts both folders at
   * once (they slide horizontally), so two callers can ask before the first fetch resolves — caching
   * only the result would fire the request twice. Mirrors ThemePresetController.ensureCatalog.
   */
  async _loadFontCatalogNormalized() {
    if (Array.isArray(this.fontCatalog) && this.fontCatalog.length) {
      return this.fontCatalog;
    }
    if (this.fontCatalogPromise) {
      return this.fontCatalogPromise;
    }

    this.fontCatalogPromise = (async () => {
      let payload = null;
      try {
        payload = await fetchOrbitersFonts();
      } catch (err) {
        console.warn('[DesignPanel] Failed to load fonts catalog:', err);
        this.fontCatalog = [];
        return this.fontCatalog;
      }

      this.fontCatalog = this._normalizeFontCatalog(payload);
      return this.fontCatalog;
    })();

    try {
      return await this.fontCatalogPromise;
    } finally {
      // Drop the in-flight handle either way: on success `fontCatalog` is the cache; on failure the
      // next open is free to retry (a failed fetch must not be remembered as "loaded").
      this.fontCatalogPromise = null;
    }
  }

  _ensureFontForDesign() {
    if (!Array.isArray(this.fontCatalog) || !this.fontCatalog.length) {
      return;
    }

    const fonts = this.fontCatalog;
    let match = null;
    const currentId = this.design.fontId ? String(this.design.fontId) : null;
    if (currentId) {
      match = fonts.find((f) => String(f.id) === currentId) || null;
    }

    if (!match) {
      const desiredFamilyRaw = String(this.design.fontFamily || this.design.fontId || '').trim();
      const desiredFamily = desiredFamilyRaw.toLowerCase();
      if (desiredFamily) {
        const desiredKey = normalizeFontKey(desiredFamilyRaw);
        match =
          fonts.find((f) => normalizeFontKey(f.family || '') === desiredKey) ||
          fonts.find((f) => normalizeFontKey((f.family || '').split(',')[0]) === desiredKey) ||
          fonts.find((f) => normalizeFontKey(f.label || '') === desiredKey) ||
          fonts.find((f) => normalizeFontKey(f.id || '') === desiredKey) ||
          fonts.find((f) => String(f.family || '').trim().toLowerCase() === desiredFamily) ||
          fonts.find((f) => String((f.family || '').split(',')[0]).trim().toLowerCase() === desiredFamily) ||
          fonts.find((f) => String(f.label || '').trim().toLowerCase() === desiredFamily) ||
          fonts.find((f) => String(f.id || '').trim().toLowerCase() === desiredFamily) ||
          null;
      }
    }

    if (!match) return;

    if (this.design.fontId !== match.id) {
      this.design.fontId = match.id;
    }
    const resolvedFamily = match.family || match.label || match.id;
    if (!this.design.fontFamily || this.design.fontFamily !== resolvedFamily) {
      this.design.fontFamily = resolvedFamily;
    }
    const resolvedLabel = match.label || match.family || match.id;
    if (this.design.fontLabel !== resolvedLabel) {
      this.design.fontLabel = resolvedLabel;
    }
    const resolvedImport = match.importUrl || null;
    if (this.design.fontImportUrl !== resolvedImport) {
      this.design.fontImportUrl = resolvedImport;
    }
  }

  _resolveInitialFont(fonts = []) {
    if (!Array.isArray(fonts) || !fonts.length) return null;

    if (this.design.fontId) {
      const byId = fonts.find((f) => f.id === this.design.fontId);
      if (byId) return byId;
    }

    const wanted = String(this.design.fontFamily || '').trim().replace(/;$/, '').toLowerCase();
    if (wanted) {
      const byFamily = fonts.find((f) => String(f.family || '').trim().replace(/;$/, '').toLowerCase() === wanted);
      if (byFamily) return byFamily;
    }

    return fonts[0];
  }

  _applyFontSelection(fontId, fonts) {
    if (!fontId || !Array.isArray(fonts)) return false;
    const selected = fonts.find((f) => f.id === fontId) || fonts[0];
    if (!selected) return false;

    const prev = {
      id: this.design.fontId,
      family: this.design.fontFamily,
      importUrl: this.design.fontImportUrl,
    };

    this.design.fontId = selected.id;
    this.design.fontFamily = selected.family || selected.label || selected.id;
    this.design.fontImportUrl = selected.importUrl || null;
    this.design.fontLabel = selected.label || selected.id;

    this.themePreset.setDesignReference(this.design);

    return (
      prev.id !== this.design.fontId ||
      prev.family !== this.design.fontFamily ||
      prev.importUrl !== this.design.fontImportUrl
    );
  }

  async _injectFontSelector(folder, onChange) {
    const fonts = await this._loadFontCatalogNormalized();
    if (!Array.isArray(fonts) || !fonts.length || !folder) return;

    this._ensureFontForDesign();

    const options = fonts.reduce((acc, f) => {
      const label = f.label || f.family || f.id;
      acc[label] = f.id;
      return acc;
    }, {});
    this.fontOptions = options;

    const initial = this._resolveInitialFont(fonts);
    const fallbackFontId = Object.values(options)[0];
    this.fontSelectorState = {
      font: initial?.id || fallbackFontId,
    };
    const changedInitial = this._applyFontSelection(this.fontSelectorState.font, fonts);
    if (changedInitial) onChange?.();

    const t = this.getTranslation();
    this.fontController = folder
      .add(this.fontSelectorState, 'font', options)
      .name(t('editPanel.design.fontFamily'))
      .onChange((id) => {
        const changed = this._applyFontSelection(id, fonts);
        if (changed) onChange?.();
      });
  }

  syncControllers() {
    this._ensureFontForDesign();
    if (this.controllers.colorPrimary) {
      this.controllers.colorPrimary.updateDisplay?.();
    }
    if (this.controllers.colorSecondary) {
      this.controllers.colorSecondary.updateDisplay?.();
    }
    if (this.controllers.ringColor) {
      this.controllers.ringColor.updateDisplay?.();
    }
    if (this.controllers.roundedCorners) {
      this.controllers.roundedCorners.updateDisplay?.();
    }
    if (this.controllers.frameBorderWidth) {
      this.controllers.frameBorderWidth.updateDisplay?.();
    }
    if (this.controllers.ringAmplitudeMultiplier) {
      this.controllers.ringAmplitudeMultiplier.updateDisplay?.();
    }
    if (this.controllers.ringRadiusMultiplier) {
      this.controllers.ringRadiusMultiplier.updateDisplay?.();
    }
    if (this.controllers.ringEnabled) {
      this.controllers.ringEnabled.updateDisplay?.();
    }

    this.themePreset?.syncControllerDisplay();

    if (this.fontSelectorState) {
      const availableIds = this.fontOptions ? Object.values(this.fontOptions) : null;
      if (!availableIds || availableIds.includes(this.design.fontId)) {
        if (this.design.fontId) {
          this.fontSelectorState.font = this.design.fontId;
        }
      }
    }

    if (this.fontController) {
      if (typeof this.fontController.updateDisplay === 'function') {
        this.fontController.updateDisplay();
      } else if (typeof this.fontController.setValue === 'function' && this.fontSelectorState?.font) {
        this.fontController.setValue(this.fontSelectorState.font);
      }
    }
  }

  syncFromDesign() {
    this.setDesignReference(this.design);
    this.themePreset?.syncFromDesign();
    this.syncControllers();
  }

  _injectCopyPasteControls(folder, notifyChange) {
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.justifyContent = 'flex-end';
    container.style.gap = '12px';
    container.style.fontSize = '11px';
    container.style.margin = '6px 0 8px';

    const createLink = (label) => {
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = label;
      link.style.cursor = 'pointer';
      link.style.textDecoration = 'underline';
      link.style.color = 'inherit';
      link.style.opacity = '0.8';
      link.addEventListener('mouseenter', () => {
        link.style.opacity = '1';
      });
      link.addEventListener('mouseleave', () => {
        link.style.opacity = '0.8';
      });
      return link;
    };

    const copyLink = createLink('Copy');
    copyLink.addEventListener('click', (event) => {
      event.preventDefault();
      designClipboard = this._captureDesignSnapshot();
    });

    const pasteLink = createLink('Paste');
    pasteLink.addEventListener('click', (event) => {
      event.preventDefault();
      if (!designClipboard) return;
      const applied = this._applyDesignSnapshot(designClipboard);
      if (applied) {
        notifyChange?.();
      }
    });

    container.append(copyLink, pasteLink);

    const target = folder?.domElement;
    if (target) {
      // Try to find the folder title element (usually .title or .dg .title)
      const titleEl = target.querySelector('.title') || target.querySelector('.dg .title');
      if (titleEl && titleEl.parentNode) {
        // Insert after the title element
        if (titleEl.nextSibling) {
          titleEl.parentNode.insertBefore(container, titleEl.nextSibling);
        } else {
          titleEl.parentNode.appendChild(container);
        }
      } else {
        // Fallback: insert as first child
        target.insertBefore(container, target.firstChild);
      }
    }
  }

  _captureDesignSnapshot() {
    return {
      colorPrimary: this.design.colorPrimary,
      colorSecondary: this.design.colorSecondary,
      colorC: this.design.colorC,
      roundedCorners: this.design.roundedCorners,
      frameBorderWidth: this.design.frameBorderWidth,
      ringColor: this.design.ringColor,
      ringAmplitudeMultiplier: this.design.ringAmplitudeMultiplier,
      ringRadiusMultiplier: this.design.ringRadiusMultiplier,
      ringEnabled: this.design.ringEnabled,
      fontFamily: this.design.fontFamily,
      fontId: this.design.fontId,
      fontImportUrl: this.design.fontImportUrl,
      fontLabel: this.design.fontLabel,
      themeId: this.design.themeId,
      themeLabel: this.design.themeLabel,
      themeVariant: this.design.themeVariant,
    };
  }

  _applyDesignSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return false;
    }

    let changed = false;

    const assignIfDifferent = (key, value) => {
      if (this.design[key] !== value) {
        this.design[key] = value;
        changed = true;
      }
    };

    assignIfDifferent('colorPrimary', snapshot.colorPrimary);
    assignIfDifferent('colorSecondary', snapshot.colorSecondary);
    // Snapshots taken before Color C existed carry no colorC — keep the current one then.
    assignIfDifferent('colorC', snapshot.colorC ?? this.design.colorC);
    assignIfDifferent('roundedCorners', snapshot.roundedCorners);
    assignIfDifferent('frameBorderWidth', snapshot.frameBorderWidth);
    assignIfDifferent('ringColor', snapshot.ringColor);
    assignIfDifferent('ringAmplitudeMultiplier', snapshot.ringAmplitudeMultiplier);
    assignIfDifferent('ringRadiusMultiplier', snapshot.ringRadiusMultiplier);
    assignIfDifferent('ringEnabled', snapshot.ringEnabled ?? true);
    assignIfDifferent('fontFamily', snapshot.fontFamily);
    assignIfDifferent('fontId', snapshot.fontId);
    assignIfDifferent('fontImportUrl', snapshot.fontImportUrl);
    assignIfDifferent('fontLabel', snapshot.fontLabel);
    assignIfDifferent('themeId', snapshot.themeId);
    assignIfDifferent('themeLabel', snapshot.themeLabel);
    assignIfDifferent('themeVariant', snapshot.themeVariant ?? null);

    if (!changed) {
      return false;
    }

    this.themePreset?.setDesignReference(this.design);
    this.themePreset?.syncFromDesign();
    this._ensureFontForDesign();
    this.syncControllers();
    return true;
  }
}
