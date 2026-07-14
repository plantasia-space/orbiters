import { Constants } from '../config/Constants.js';
import { getT } from '../i18n/index.js';
import { getLoginPromptHiddenFromUrl } from '../utils/urlParams.js';
import { requestLoginPrompt, dismissLoginPrompt } from './react/loginPromptBridge';

/**
 * @file loginPrompt.js
 * @description Login-nudge entry for the auth/settings/MIDI flows. Tier-1 migration: the prompt is now
 * the React `LoginPrompt` region (rendered in the HeaderBar). This file is just the imperative bridge —
 * it computes the href/label and forwards to the React sink. No DOM, no positioning, no listeners.
 */

function sanitizeBaseUrl(base) {
  if (!base || typeof base !== 'string') return '';
  return base.replace(/\/+$/, '');
}

export function getLoginHref(customHref = null) {
  if (typeof customHref === 'string' && customHref.trim().length) {
    return customHref.trim();
  }

  const candidates = [
    Constants?.ROOT_BASE,
    typeof window !== 'undefined' ? window.ROOT_BASE : undefined,
    typeof window !== 'undefined' ? window.__ROOT_BASE__ : undefined,
    typeof window !== 'undefined' ? window.location?.origin : undefined,
  ];

  const base = candidates.find((value) => typeof value === 'string' && value.trim().length) || '';
  return `${sanitizeBaseUrl(base)}/auth/login`;
}

export function ensureLoginPrompt({ text = null, href = null } = {}) {
  if (getLoginPromptHiddenFromUrl()) {
    dismissLoginPrompt();
    return null;
  }

  const t = getT();
  const resolvedText =
    typeof text === 'string' && text.trim().length ? text : t('login.cta');

  // Buffered: if the auth flow fires before the React shell mounts, the request is replayed
  // when the LoginPrompt region registers its sink.
  requestLoginPrompt({
    text: resolvedText,
    href: getLoginHref(href),
    ariaLabel: t('login.ariaLabel'),
  });
  return null;
}

export function removeLoginPrompt() {
  dismissLoginPrompt();
}
