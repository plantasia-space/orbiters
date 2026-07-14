/**
 * @file src/i18n/index.js
 * @description Lightweight wrapper around i18next: initialization, language resolution/persistence,
 * and the `getT()` accessor the UI uses to translate at render time.
 */
import i18next from 'i18next';
import enTranslations from './locales/en.json';
import esTranslations from './locales/es.json';

const SUPPORTED_LANGUAGES = ['en', 'es'];

/**
 * Normalizes a browser or URL language hint to one of the supported language codes.
 * @param {string} lang
 * @returns {'en'|'es'}
 */
function normalizeLanguageCode(lang) {
  if (!lang || typeof lang !== 'string') {
    return 'en';
  }
  const lower = lang.toLowerCase();
  if (lower.startsWith('es')) {
    return 'es';
  }
  return 'en';
}

/**
 * Determines which language should be loaded by inspecting URL params first, then browser locale.
 * @returns {'en'|'es'}
 */
function resolveInitialLanguage() {
  const browserLang = typeof navigator !== 'undefined'
    ? normalizeLanguageCode(navigator.language || navigator.languages?.[0])
    : 'en';

  const urlParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const urlLang = normalizeLanguageCode(urlParams.get('lang') || urlParams.get('language'));

  if (SUPPORTED_LANGUAGES.includes(urlLang)) {
    return urlLang;
  }

  return browserLang;
}

/**
 * Initializes i18next with bundled resources and sets the `<html lang>` attribute.
 * @returns {Promise<typeof i18next.t>}
 */
export async function initI18n() {
  const initialLanguage = resolveInitialLanguage();

  await i18next.init({
    lng: initialLanguage,
    fallbackLng: 'en',
    debug: false,
    resources: {
      en: { translation: enTranslations },
      es: { translation: esTranslations },
    },
    interpolation: {
      escapeValue: false,
    },
  });

  if (typeof document !== 'undefined') {
    document.documentElement.lang = i18next.language;
  }

  return i18next.t;
}

/**
 * @returns {'en'|'es'} Currently active language code.
 */
export function getCurrentLanguage() {
  return i18next.language || 'en';
}

/**
 * Updates the active language (if supported), syncs DOM state, and dispatches a global event.
 * @param {'en'|'es'} lang
 */
export async function changeLanguage(lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    return;
  }

  await i18next.changeLanguage(lang);

  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
  }

  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.set('lang', lang);
    window.history.replaceState({}, '', url);

    window.dispatchEvent(new CustomEvent('languageChanged', {
      detail: { language: lang },
    }));
  }
}

/**
 * @returns {typeof i18next.t} Shortcut to the i18next translate function.
 */
export function getT() {
  return i18next.t;
}

// NOTE: the old `applyTranslations()` DOM-walker + `applyElementTranslations()` were
// removed. They translated the vanilla UI's `data-i18n-key` / `data-i18n-attr-*` nodes, but the
// React migration replaced that DOM entirely — no `data-i18n` nodes remain. React regions
// now read translations directly via `getT()` at render time, so the walker was dead code.

export default i18next;
