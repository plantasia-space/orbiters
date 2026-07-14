/**
 * Utilities for resolving Herbarium CDN asset URLs at runtime.
 * Supports both module (import.meta.env) and non-module contexts via globals.
 */
const ABSOLUTE_URL_PATTERN = /^[a-z]+:\/\//i;
const PROTOCOL_RELATIVE_PATTERN = /^\/\//;
const DEFAULT_SYMBOL_SEGMENT = 'assets/symbols/current/orbiters/';
const symbolFetchCache = new Map();

let cachedHerbariumBase;

function sanitizeBase(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

function readEnvBase() {
  try {
    return import.meta?.env?.VITE_PUBLIC_HERBARIUM_BASE || import.meta?.env?.VITE_HERBARIUM_BASE;
  } catch (_) {
    return undefined;
  }
}

/**
 * Returns the configured Herbarium CDN base URL.
 * Uses env vars when available and falls back to globals injected at runtime.
 */
export function getHerbariumBase() {
  if (typeof cachedHerbariumBase === 'string' && cachedHerbariumBase.length) {
    return cachedHerbariumBase;
  }

  const candidates = [
    readEnvBase(),
    typeof window !== 'undefined' ? window.VITE_PUBLIC_HERBARIUM_BASE : undefined,
    typeof window !== 'undefined' ? window.VITE_HERBARIUM_BASE : undefined,
    typeof window !== 'undefined' ? window.PUBLIC_HERBARIUM_BASE : undefined,
    typeof window !== 'undefined' ? window.HERBARIUM_BASE : undefined,
    typeof window !== 'undefined' ? window.__PUBLIC_HERBARIUM_BASE__ : undefined,
    typeof window !== 'undefined' ? window.__HERBARIUM_BASE__ : undefined,
  ];

  // Reject unsubstituted Vite tokens (e.g. "%VITE_HERBARIUM_BASE%") so a missing
  // build-time env var never resolves into a broken asset URL.
  const match = candidates.find(
    (value) => typeof value === 'string' && value.trim().length && !value.includes('%'),
  );
  if (match) {
    cachedHerbariumBase = sanitizeBase(match);
    return cachedHerbariumBase;
  }
  return '';
}

function normalizeAssetPath(path, { stripAssets = true } = {}) {
  if (!path || typeof path !== 'string') return '';
  let normalized = path.trim().replace(/^\.?\//, '');
  if (stripAssets) {
    normalized = normalized.replace(/^assets\//, '');
  }
  return normalized;
}

/**
 * Resolves a path (relative or absolute) to a Herbarium CDN asset URL.
 * Falls back to the original path if it is already absolute.
 */
export function resolveHerbariumAsset(path = '') {
  if (!path) {
    return getHerbariumBase();
  }

  if (ABSOLUTE_URL_PATTERN.test(path)) {
    return path;
  }

  if (PROTOCOL_RELATIVE_PATTERN.test(path)) {
    const protocol =
      typeof window !== 'undefined' && window.location?.protocol
        ? window.location.protocol
        : 'https:';
    return `${protocol}${path}`;
  }

  const normalized = normalizeAssetPath(path);
  if (!normalized) {
    return path;
  }

  const assetPath = normalized.startsWith('assets/')
    ? normalized
    : `assets/${normalized}`;

  const base = getHerbariumBase();
  if (!base) {
    return `/${assetPath}`;
  }

  try {
    return new URL(assetPath, `${base}/`).toString();
  } catch (error) {
    console.warn('[cdnAssets] Failed to resolve asset URL, falling back to relative path.', {
      error,
      assetPath,
      base,
    });
    return `/${assetPath}`;
  }
}

/**
 * Resolves an icon path (accepting variants like `/assets/icons/foo.svg`) to the CDN.
 */
export function resolveHerbariumSymbol(path = '') {
  if (!path) {
    return resolveHerbariumAsset(DEFAULT_SYMBOL_SEGMENT);
  }

  if (ABSOLUTE_URL_PATTERN.test(path) || PROTOCOL_RELATIVE_PATTERN.test(path)) {
    return resolveHerbariumAsset(path);
  }

  const normalized = normalizeAssetPath(path, { stripAssets: false });

  // Already targeting symbols folder
  if (/^assets\/symbols\//i.test(normalized) || /^symbols\//i.test(normalized)) {
    const sanitized = normalized.replace(/^symbols\//i, 'assets/symbols/');
    return resolveHerbariumAsset(sanitized);
  }

  // Legacy icon references
  const basename = normalized
    .replace(/^assets\/icons\//i, '')
    .replace(/^icons\//i, '')
    .split('/')
    .pop();

  const symbolPath = `${DEFAULT_SYMBOL_SEGMENT}${basename}`;
  return resolveHerbariumAsset(symbolPath);
}

export const resolveHerbariumIcon = resolveHerbariumSymbol;

export function setHerbariumBase(base) {
  cachedHerbariumBase = sanitizeBase(base);
  if (typeof window !== 'undefined') {
    window.__PUBLIC_HERBARIUM_BASE__ = window.VITE_PUBLIC_HERBARIUM_BASE = cachedHerbariumBase;
    window.__HERBARIUM_BASE__ = window.VITE_HERBARIUM_BASE = cachedHerbariumBase;
  }
  return cachedHerbariumBase;
}

// The symbol endpoint serves static icons only — anything executable in the payload is
// hostile (or a compromised endpoint) and gets stripped before the SVG touches the DOM.
// Elements that can run script, pull external content, or animate an attribute into a
// javascript: URL have no place in an icon.
const BLOCKED_SVG_ELEMENTS = new Set([
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'style',
  'set', 'animate', 'animatetransform', 'animatemotion',
]);

/**
 * Parses fetched Herbarium SVG text into a detached, sanitized <svg> element:
 * script-capable/external-content/animation elements are dropped, and each surviving
 * element loses its `on*` handlers, any href-family attribute pointing outside the
 * document, and URL-bearing inline CSS. Throws when the payload is not an SVG document.
 * @param {string} content raw SVG markup
 * @param {string} [sourceUrl] used in the error message only
 * @returns {SVGElement}
 */
export function parseHerbariumSvg(content, sourceUrl = '') {
  const svgDoc = new DOMParser().parseFromString(content, 'image/svg+xml');
  const svgElement = svgDoc.documentElement;
  if (!svgElement || svgElement.tagName.toLowerCase() !== 'svg') {
    throw new Error(`Invalid SVG content fetched from: ${sourceUrl}`);
  }
  for (const el of [svgElement, ...svgElement.querySelectorAll('*')]) {
    if (BLOCKED_SVG_ELEMENTS.has(el.localName?.toLowerCase() ?? '')) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      // Match href by localName so a custom namespace prefix (e.g. `x:href` bound to
      // the XLink namespace) can't smuggle a link past a literal-name check.
      const isHref = (attr.localName || attr.name).toLowerCase() === 'href';
      const value = attr.value.trim();
      const hasUrlCss = name === 'style' && /url\s*\(|@import|expression\s*\(/i.test(value);
      if (name.startsWith('on') || hasUrlCss || (isHref && !value.startsWith('#'))) {
        // Namespace-safe removal — removeAttribute(qualifiedName) is unreliable for
        // prefixed attributes across engines.
        el.removeAttributeNode(attr);
      }
    }
  }
  return svgElement;
}

/**
 * Fetches a Herbarium symbol and memoizes the response text.
 * Returns an object with the resolved URL and SVG content.
 */
export function fetchHerbariumSymbol(path = '') {
  const resolvedUrl = resolveHerbariumSymbol(path);
  if (!resolvedUrl) {
    return Promise.reject(new Error('[cdnAssets] Unable to resolve Herbarium symbol URL.'));
  }

  if (!symbolFetchCache.has(resolvedUrl)) {
    const fetchPromise = fetch(resolvedUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load SVG: ${resolvedUrl} (${response.status})`);
        }
        return response.text();
      })
      .then((content) => ({ url: resolvedUrl, content }))
      .catch((error) => {
        symbolFetchCache.delete(resolvedUrl);
        throw error;
      });

    symbolFetchCache.set(resolvedUrl, fetchPromise);
  }

  return symbolFetchCache.get(resolvedUrl);
}
