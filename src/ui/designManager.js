/**
 * Utilities for applying UI design settings across the Orbiters experience.
 * Centralizes font/link management so the entrypoint stays lean.
 */

let designFontLinkEl = null;

/**
 * Ensures a single <link rel="stylesheet"> is attached for the design font URL.
 * Passing a falsy url removes the existing link.
 * @param {string|null} url - Stylesheet URL to apply, or null/empty to remove.
 * @returns {void}
 */
function ensureDesignFontLink(url) {
  if (typeof document === "undefined") return;
  if (!url) {
    if (designFontLinkEl && designFontLinkEl.parentElement) {
      designFontLinkEl.parentElement.removeChild(designFontLinkEl);
    }
    designFontLinkEl = null;
    return;
  }

  if (!designFontLinkEl) {
    designFontLinkEl = document.createElement("link");
    designFontLinkEl.rel = "stylesheet";
    designFontLinkEl.className = "orbiters-font-import";
    designFontLinkEl.crossOrigin = "anonymous";
    document.head.appendChild(designFontLinkEl);
  }

  if (designFontLinkEl.href !== url) {
    designFontLinkEl.href = url;
  }
}

/**
 * Applies UI design variables (corner radius, border width, font family)
 * and injects/removes the design font link as needed.
 * @param {Object} [design={}] - Design settings.
 * @param {number} [design.roundedCorners]
 * @param {number} [design.frameBorderWidth]
 * @param {string} [design.fontFamily]
 * @param {string|null} [design.fontImportUrl]
 * @returns {void}
 */
function applyDesignSettings(design = {}, themeRoot = null) {
  if (typeof document === "undefined" || !design) return;
  // The per-tile orbiter theme. Single-orbiter passes no themeRoot → the vars land on
  // documentElement and cascade to everything (byte-identical). A multi-orbiter voice passes its cell,
  // so `--color1/2/3` (read by `.orbiters-react-ui` in that cell) are scoped to THAT tile — each
  // planet+UI shows its own world's accent instead of every tile sharing the last voice's colors.
  const root = themeRoot || document.documentElement;
  const isDocumentRoot = root === document.documentElement;

  if (design.colorPrimary) {
    root.style.setProperty("--color1", design.colorPrimary);
  }
  if (design.colorSecondary) {
    root.style.setProperty("--color2", design.colorSecondary);
  }
  // Color C — the orbiter's selected/active "success" highlight. The play UI's
  // `--success` aliases this (orbitersUI.css), so the active dimension / SYNC / loop track it.
  if (design.colorC) {
    root.style.setProperty("--color3", design.colorC);
  }
  if (Number.isFinite(design.roundedCorners)) {
    root.style.setProperty(
      "--orbiters-rounded-corners",
      `${design.roundedCorners}px`,
    );
  }
  if (Number.isFinite(design.frameBorderWidth)) {
    root.style.setProperty(
      "--orbiters-frame-border-width",
      `${design.frameBorderWidth}px`,
    );
  }
  if (design.fontFamily) {
    root.style.setProperty("--orbiters-font-family", design.fontFamily);
    // The page-wide body font is global chrome; only the document-level (single-orbiter) theme owns it.
    // A per-tile theme sets the var on its own root and lets `.orbiters-react-ui` pick it up locally.
    if (isDocumentRoot) {
      document.body.style.fontFamily = `var(--orbiters-font-family, ${design.fontFamily})`;
    }
  }

  ensureDesignFontLink(design.fontImportUrl);

  try {
    const event = new CustomEvent("orbiters:design-updated", {
      detail: { design },
    });
    document.dispatchEvent(event);
  } catch (_) {}
}

/**
 * Derives design defaults from combined track/orbiter metadata with fallback.
 * @param {Object} combined
 * @param {Object} [fallbackDesign={}]
 * @returns {Object} Derived design defaults.
 */
function deriveDesignDefaultsFromCombined(combined, fallbackDesign = {}) {
  const base = { ...fallbackDesign };
  const orbiterColors =
    combined?.orbiter?.orbiterColors ||
    combined?.track?.orbiterColors ||
    base.orbiterColors ||
    {};
  if (orbiterColors.color1) base.colorPrimary = orbiterColors.color1;
  if (orbiterColors.color2) base.colorSecondary = orbiterColors.color2;
  if (orbiterColors.color3) base.colorC = orbiterColors.color3;

  const designMeta =
    combined?.orbiter?.orbiterDesign ||
    combined?.orbiter?.metadata?.orbiterDesign ||
    combined?.track?.metadata?.orbiterDesign ||
    combined?.track?.orbiterDesign ||
    {};
  if (designMeta.fontFamily) base.fontFamily = designMeta.fontFamily;
  if (designMeta.fontId !== undefined) base.fontId = designMeta.fontId;
  if (designMeta.fontImportUrl !== undefined)
    base.fontImportUrl = designMeta.fontImportUrl;
  if (Number.isFinite(designMeta.roundedCorners))
    base.roundedCorners = designMeta.roundedCorners;
  if (Number.isFinite(designMeta.frameBorderWidth))
    base.frameBorderWidth = designMeta.frameBorderWidth;
  return base;
}

export { applyDesignSettings, deriveDesignDefaultsFromCombined };
