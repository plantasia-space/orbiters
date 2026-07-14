/**
 * @file audioAssetSource.js
 * @description Resolves logical audio asset identity and adds a lightweight
 *              browser-side cache for prebuffer playback.
 */

import { resolveApiBase } from '../../api/httpClient.js';

const AUDIO_CACHE_NAME = 'orbiters-audio-assets-v1';
const AUDIO_CACHE_URL_PREFIX = '/__orbiters/audio-cache__';
const AUDIO_PROXY_UNAVAILABLE_PREFIX = 'orbiters:audio-proxy-unavailable:';
const AUDIO_PROXY_UNAVAILABLE_TTL_MS = 5 * 60 * 1000;

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function normalizeAssetFormatPreference(value) {
  return String(value || '').toLowerCase() === 'pcm' ? 'pcm' : 'mp3';
}

function normalizeId(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function buildLogicalCacheIdentity({ trackId, releaseVersion, variant, assetFormat }) {
  if (!trackId || !releaseVersion || !variant) {
    return null;
  }

  return [
    'track',
    trackId,
    'version',
    releaseVersion,
    'variant',
    variant,
    'format',
    assetFormat,
  ].join(':');
}

function buildLogicalCacheRequestUrl(identityKey) {
  if (!identityKey) return null;
  try {
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://localhost';
    const url = new URL(AUDIO_CACHE_URL_PREFIX, origin);
    url.searchParams.set('key', identityKey);
    return url.toString();
  } catch {
    return null;
  }
}

function getAudioProxyUnavailableStorageKey(stableUrl) {
  return `${AUDIO_PROXY_UNAVAILABLE_PREFIX}${stableUrl}`;
}

function readStableAudioUrlUnavailableRecord(stableUrl) {
  if (!stableUrl || typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getAudioProxyUnavailableStorageKey(stableUrl));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const referenceTime = Number(parsed?.disabledAt ?? parsed?.lastFailureAt);
    if (!Number.isFinite(referenceTime) || referenceTime <= 0) {
      window.localStorage.removeItem(getAudioProxyUnavailableStorageKey(stableUrl));
      return null;
    }
    if ((Date.now() - referenceTime) > AUDIO_PROXY_UNAVAILABLE_TTL_MS) {
      window.localStorage.removeItem(getAudioProxyUnavailableStorageKey(stableUrl));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isStableAudioUrlTemporarilyUnavailable(stableUrl) {
  const record = readStableAudioUrlUnavailableRecord(stableUrl);
  return Boolean(record?.disabledAt);
}

function writeStableAudioUrlRecord(stableUrl, payload) {
  if (!stableUrl || typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(
      getAudioProxyUnavailableStorageKey(stableUrl),
      JSON.stringify(payload),
    );
  } catch {
    // Ignore storage write failures.
  }
}

function clearStableAudioUrlTemporarilyUnavailable(stableUrl) {
  if (!stableUrl || typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.removeItem(getAudioProxyUnavailableStorageKey(stableUrl));
  } catch {
    // Ignore storage write failures.
  }
}

function resolveVariantCandidate(trackData, assetFormatPreference = 'mp3') {
  const normalizedPreference = normalizeAssetFormatPreference(assetFormatPreference);
  const compressedUrl = normalizeId(trackData?.audioFileMP3URL);
  const losslessUrl = normalizeId(trackData?.audioFileWAVURL || trackData?.audioFilePCMURL);
  const compressedAsset = compressedUrl || normalizeId(trackData?.audioFileMP3Key);
  const losslessAsset = losslessUrl || normalizeId(trackData?.audioFileWAVKey || trackData?.audioFilePCMKey);

  if (normalizedPreference === 'pcm') {
    if (losslessAsset) {
      return { url: losslessUrl, variant: 'lossless', assetFormat: 'pcm' };
    }
    if (compressedAsset) {
      return { url: compressedUrl, variant: 'compressed', assetFormat: 'mp3' };
    }
  }

  if (compressedAsset) {
    return { url: compressedUrl, variant: 'compressed', assetFormat: 'mp3' };
  }

  if (losslessAsset) {
    return { url: losslessUrl, variant: 'lossless', assetFormat: 'pcm' };
  }

  return {
    url: null,
    variant: normalizedPreference === 'pcm' ? 'lossless' : 'compressed',
    assetFormat: normalizedPreference,
  };
}

function buildStableAudioUrl({ trackId, releaseVersion, variant }) {
  const base = resolveApiBase();
  // The /tracks/:id/audio proxy only serves PUBLISHED releases (version >= 1). Draft
  // previews carry version 0, which the proxy rejects with 400 — skip the
  // proxy for them so playback falls back to the BE presigned URL instead.
  const numericVersion = Number.parseInt(releaseVersion, 10);
  if (!base || !trackId || !variant || !Number.isInteger(numericVersion) || numericVersion < 1) {
    return null;
  }

  try {
    const url = new URL(`${String(base).replace(/\/+$/, '')}/tracks/${encodeURIComponent(trackId)}/audio`);
    url.searchParams.set('v', String(numericVersion));
    url.searchParams.set('variant', variant);
    return url.toString();
  } catch {
    return null;
  }
}

async function readArrayBufferFromResponse(response, onProgress = null) {
  const startedAt = nowMs();
  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;

  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    if (onProgress) {
      onProgress(total || arrayBuffer.byteLength, total || arrayBuffer.byteLength, 0);
    }
    const endedAt = nowMs();
    return {
      arrayBuffer,
      loadedBytes: total > 0 ? total : arrayBuffer.byteLength,
      elapsedSeconds: Math.max(0.001, (endedAt - startedAt) / 1000),
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastTime = startedAt;
  let lastLoaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    loaded += value.length;

    const currentTime = nowMs();
    const timeDelta = (currentTime - lastTime) / 1000;
    const bytesDelta = loaded - lastLoaded;
    const speed = timeDelta > 0 ? bytesDelta / timeDelta : 0;

    if (onProgress) {
      onProgress(loaded, total, speed);
    }

    if (timeDelta >= 0.5) {
      lastTime = currentTime;
      lastLoaded = loaded;
    }
  }

  const arrayBuffer = new Uint8Array(loaded);
  let position = 0;
  for (const chunk of chunks) {
    arrayBuffer.set(chunk, position);
    position += chunk.length;
  }

  const endedAt = nowMs();
  return {
    arrayBuffer: arrayBuffer.buffer,
    loadedBytes: loaded,
    elapsedSeconds: Math.max(0.001, (endedAt - startedAt) / 1000),
  };
}

async function fetchArrayBufferFromUrl(url, { onProgress = null } = {}) {
  const response = await fetch(url, {
    credentials: url && isStableAudioUrl(url) ? 'include' : 'same-origin',
  });
  if (!response.ok) {
    const error = new Error(`Failed to fetch audio: ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.url = response.url || url;
    throw error;
  }
  const cacheResponse = response.clone();
  const result = await readArrayBufferFromResponse(response, onProgress);
  if (url && isStableAudioUrl(url)) {
    clearStableAudioUrlTemporarilyUnavailable(url);
  }
  return {
    ...result,
    cacheResponse,
    resolvedUrl: response.url || url,
  };
}

function isStableAudioUrl(url) {
  if (!url) return false;
  const apiBase = resolveApiBase();
  if (!apiBase) return false;
  const normalizedBase = String(apiBase).replace(/\/+$/, '');
  return String(url).startsWith(`${normalizedBase}/tracks/`) && String(url).includes('/audio?');
}

function shouldDisableStableAudioProxyForSession(error) {
  if (error?.name === 'AbortError') {
    return false;
  }
  const status = Number(error?.status);
  return status === 404 || status === 405 || status === 410 || status === 501;
}

export function registerStableAudioProxyFailure(audioSource, error) {
  const stableUrl = audioSource?.stableUrl || null;
  if (!stableUrl) return false;

  if (shouldDisableStableAudioProxyForSession(error)) {
    writeStableAudioUrlRecord(stableUrl, {
      disabledAt: Date.now(),
      status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
      noStatusFailures: 0,
      lastFailureAt: Date.now(),
    });
    return true;
  }

  const status = Number(error?.status);
  if (!Number.isFinite(status) || status <= 0) {
    const existing = readStableAudioUrlUnavailableRecord(stableUrl);
    const nextNoStatusFailures = Number(existing?.noStatusFailures) + 1 || 1;
    if (nextNoStatusFailures >= 2) {
      writeStableAudioUrlRecord(stableUrl, {
        disabledAt: Date.now(),
        status: null,
        noStatusFailures: nextNoStatusFailures,
        lastFailureAt: Date.now(),
      });
      return true;
    }
    writeStableAudioUrlRecord(stableUrl, {
      disabledAt: null,
      status: null,
      noStatusFailures: nextNoStatusFailures,
      lastFailureAt: Date.now(),
    });
  }

  return false;
}

async function openLogicalAudioCache() {
  if (typeof caches === 'undefined' || typeof caches.open !== 'function') {
    return null;
  }
  return caches.open(AUDIO_CACHE_NAME);
}

async function readFromLogicalAudioCache(cacheRequestUrl, onProgress = null) {
  if (!cacheRequestUrl) return null;
  const cache = await openLogicalAudioCache();
  if (!cache) return null;
  const cachedResponse = await cache.match(cacheRequestUrl);
  if (!cachedResponse || !cachedResponse.ok) {
    return null;
  }

  const result = await readArrayBufferFromResponse(cachedResponse, onProgress);
  return {
    ...result,
    resolvedUrl: cacheRequestUrl,
    fromLogicalCache: true,
  };
}

async function writeToLogicalAudioCache(cacheRequestUrl, response) {
  if (!cacheRequestUrl || !response?.ok || response.status === 206) {
    return false;
  }

  const cache = await openLogicalAudioCache();
  if (!cache) return false;

  await cache.put(cacheRequestUrl, response.clone());
  return true;
}

export function resolvePlaybackAudioSource(trackData, { assetFormatPreference = 'mp3' } = {}) {
  const candidate = resolveVariantCandidate(trackData, assetFormatPreference);
  const trackId = normalizeId(trackData?.trackId);
  const releaseVersion = normalizeId(trackData?.version);
  const logicalIdentityKey = buildLogicalCacheIdentity({
    trackId,
    releaseVersion,
    variant: candidate.variant,
    assetFormat: candidate.assetFormat,
  });
  const identityKey = logicalIdentityKey || candidate.url;
  const stableUrl = buildStableAudioUrl({
    trackId,
    releaseVersion,
    variant: candidate.variant,
  });
  const stableUrlAvailable = stableUrl && !isStableAudioUrlTemporarilyUnavailable(stableUrl);
  const preferredUrl = stableUrlAvailable ? stableUrl : (candidate.url || null);

  return {
    url: preferredUrl,
    fallbackUrl: stableUrlAvailable && candidate.url ? candidate.url : null,
    originalUrl: candidate.url || null,
    stableUrl: stableUrlAvailable ? stableUrl : null,
    variant: candidate.variant,
    assetFormat: candidate.assetFormat,
    trackId,
    releaseVersion,
    identityKey,
    logicalCacheRequestUrl: buildLogicalCacheRequestUrl(logicalIdentityKey),
  };
}

export async function fetchPrebufferAudioSource(audioSource, { onProgress = null } = {}) {
  if (!audioSource?.url) {
    throw new Error('No audio source URL available.');
  }

  const logicalCacheRequestUrl = audioSource.logicalCacheRequestUrl || null;
  if (logicalCacheRequestUrl) {
    try {
      const cached = await readFromLogicalAudioCache(logicalCacheRequestUrl, onProgress);
      if (cached) {
        return cached;
      }
    } catch (error) {
      console.warn('[AudioAssetSource] Failed to read logical audio cache.', error);
    }
  }

  const candidateUrls = [...new Set([audioSource.url, audioSource.fallbackUrl].filter(Boolean))];
  let lastError = null;

  for (const candidateUrl of candidateUrls) {
    try {
      const result = await fetchArrayBufferFromUrl(candidateUrl, { onProgress });
      if (logicalCacheRequestUrl && candidateUrl === audioSource.originalUrl) {
        try {
          await writeToLogicalAudioCache(logicalCacheRequestUrl, result.cacheResponse);
        } catch (error) {
          console.warn('[AudioAssetSource] Failed to write logical audio cache.', error);
        }
      }
      return result;
    } catch (error) {
      if (candidateUrl === audioSource.stableUrl) {
        registerStableAudioProxyFailure(audioSource, error);
      }
      lastError = error;
    }
  }

  throw lastError || new Error('Failed to fetch audio source.');
}
