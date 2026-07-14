export const CAPTURE_ASPECTS = Object.freeze([
  Object.freeze({ id: '16:9', width: 1920, height: 1080 }),
  Object.freeze({ id: '1:1', width: 1080, height: 1080 }),
  Object.freeze({ id: '9:16', width: 1080, height: 1920 }),
  Object.freeze({ id: '4:5', width: 1080, height: 1350 }),
]);

const STORAGE_KEYS = Object.freeze({
  aspect: 'orbiters:capture-aspect',
});

function readStorage(key) {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // noop
  }
}

export function normalizeCaptureAspect(value) {
  return CAPTURE_ASPECTS.some((format) => format.id === value) ? value : CAPTURE_ASPECTS[0].id;
}

export function getCaptureAspect() {
  return normalizeCaptureAspect(readStorage(STORAGE_KEYS.aspect));
}

export function getCaptureFormatMeta(aspectId = null) {
  const resolvedAspect = normalizeCaptureAspect(aspectId || getCaptureAspect());
  return CAPTURE_ASPECTS.find((format) => format.id === resolvedAspect) || CAPTURE_ASPECTS[0];
}

export function setCaptureAspect(aspect) {
  const nextAspect = normalizeCaptureAspect(aspect);
  writeStorage(STORAGE_KEYS.aspect, nextAspect);
  return nextAspect;
}
