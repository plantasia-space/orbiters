/**
 * @file src/multi/index.js
 * @description Public package entry for the multi-voice runtime (`orbiters/multi`). A host app
 * imports this to run ONE shared realm — one AudioContext + one WebGLRenderer/canvas/render loop —
 * and render N orbiter voices into DOM cells the host owns (e.g. feed cards as compositor cells).
 *
 * This module is the package's ONLY public boundary: hosts import `orbiters/multi`, never deep
 * paths into `src/`. The deployed orbiters app composes these same modules directly (Main.js), so
 * there is no fork and the single-orbiter path is untouched.
 *
 * Host contract:
 * - Client-only: dynamic-import this module in the browser. Importing evaluates the full app
 *   graph, so the host bundler must transpile this package's raw ESM/TS/JSX + CSS imports
 *   (Next: `transpilePackages`).
 * - Await `initI18n()` once before the first voice mounts chrome.
 * - Config is injected via the same host globals the app page uses — `window.API_BASE`,
 *   `window.API_VERSION` (httpClient.js) and the CDN globals (utils/cdnAssets.js). No Vite env
 *   is required outside this repo's own build.
 * - Styles: React chrome carries its own CSS imports (design-lib styles + region sheets). The
 *   app's page-global stylesheet (src/css/style.css — html/body backgrounds, resets) is
 *   deliberately NOT imported here: a host owns its own page.
 * - Static assets resolve against the HOST origin and are not shipped in this package: the host
 *   must serve the chrome webfonts (`/assets/fonts/…`, plus the Orbit title font, see
 *   index.html) and the KTX2 transcoder (`/basis/…` — the shared world loader hardcodes
 *   `setTranscoderPath('/basis/')`).
 */
export { createMultiOrbiterApp, MAX_CONCURRENT_VOICE_BOOTS } from './createMultiOrbiterApp.js';
export { createViewportCompositor } from './renderHost.js';
export { makeOrbiterVoiceSession, VOICE_LOAD_TIMEOUT_MS } from './makeOrbiterVoiceSession.js';
export { makeAudioVoiceSession } from './makeAudioVoiceSession.js';
export { voiceRegistry } from '../voice/VoiceRegistry.js';
export { initI18n } from '../i18n/index.js';
