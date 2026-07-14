import { voiceRegistry } from '../voice/VoiceRegistry.js';

const DEFAULT_SEEK_OFFSET_SECONDS = 10;

function resolveString(value) {
  return typeof value === 'string' && value.trim().length ? value.trim() : null;
}

function pickFirstString(candidates = []) {
  for (const candidate of candidates) {
    const resolved = resolveString(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function resolveArtistName(artist) {
  if (typeof artist === 'string') return artist.trim() || null;
  if (!artist || typeof artist !== 'object') return null;
  return pickFirstString([
    artist.displayName,
    artist.artisticName,
    artist.name,
    artist.username,
    artist.handle,
    artist.id,
  ]);
}

function resolveArtists(trackData = null) {
  const directArtists = Array.isArray(trackData?.artists) ? trackData.artists : [];
  const metadataArtists = Array.isArray(trackData?.metadata?.artists) ? trackData.metadata.artists : [];
  const all = [...directArtists, ...metadataArtists]
    .map((entry) => resolveArtistName(entry))
    .filter(Boolean);
  if (all.length) {
    return all.join(', ');
  }
  return pickFirstString([
    trackData?.metadata?.artist,
    trackData?.metadata?.ownerDisplayName,
    trackData?.metadata?.ownerUsername,
    trackData?.owner?.displayName,
    trackData?.owner?.username,
  ]);
}

function toAbsoluteUrl(value) {
  const source = resolveString(value);
  if (!source) return null;
  try {
    if (typeof window === 'undefined') {
      return source;
    }
    return new URL(source, window.location.href).href;
  } catch {
    return source;
  }
}

function normalizeArtworkList(candidates = []) {
  const seen = new Set();
  const artwork = [];
  const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];

  for (const entry of candidates) {
    if (!entry) continue;
    const src = toAbsoluteUrl(typeof entry === 'string' ? entry : entry.src);
    if (!src || seen.has(src)) continue;
    seen.add(src);

    const type = resolveString(entry?.type);
    for (const size of sizes) {
      artwork.push(type ? { src, sizes: size, type } : { src, sizes: size });
    }
  }

  return artwork;
}

function extractVariantUrls(imageSet) {
  if (!imageSet || typeof imageSet !== 'object') {
    return [];
  }
  return [
    imageSet.mid,
    imageSet.original,
    imageSet.small,
    imageSet.url,
    imageSet.src,
    imageSet.imageUrl,
    imageSet.imageURL,
    imageSet.thumbnailUrl,
    imageSet.thumbnailURL,
  ].filter(Boolean);
}

function resolveTrackCoverCandidates(trackData = null) {
  const squareCover =
    trackData?.images?.['square-cover'] ||
    trackData?.images?.squareCover ||
    trackData?.images?.cover ||
    null;

  return [
    trackData?.artworkURL,
    ...extractVariantUrls(squareCover),
  ];
}

function resolveArtistImageCandidates(trackData = null) {
  const artists = Array.isArray(trackData?.artists)
    ? trackData.artists
    : Array.isArray(trackData?.metadata?.artists)
      ? trackData.metadata.artists
      : [];

  const firstArtistWithImages = artists.find((artist) => artist?.images && typeof artist.images === 'object');
  if (!firstArtistWithImages) {
    return [];
  }

  return [
    firstArtistWithImages.images?.square?.mid,
    firstArtistWithImages.images?.square?.original,
    firstArtistWithImages.images?.square?.small,
    firstArtistWithImages.images?.landscape?.mid,
    firstArtistWithImages.images?.landscape?.original,
    firstArtistWithImages.images?.landscape?.small,
  ].filter(Boolean);
}

function resolveOwnerImageCandidates(trackData = null) {
  const ownerImages = trackData?.owner?.images;
  if (!ownerImages || typeof ownerImages !== 'object') {
    return [];
  }
  return [
    ownerImages.square?.mid,
    ownerImages.square?.original,
    ownerImages.square?.small,
    ownerImages.landscape?.mid,
    ownerImages.landscape?.original,
    ownerImages.landscape?.small,
  ].filter(Boolean);
}

function resolveArtwork(trackData = null) {
  const metadata = trackData?.metadata || {};
  const arrayImages = Array.isArray(trackData?.images)
    ? trackData.images
    : Array.isArray(metadata?.images)
      ? metadata.images
      : [];

  const imageCandidates = arrayImages.flatMap((image) => {
    if (typeof image === 'string') return [image];
    return extractVariantUrls(image);
  });

  const directCandidates = [
    ...resolveTrackCoverCandidates(trackData),
    ...imageCandidates,
    ...resolveArtistImageCandidates(trackData),
    ...resolveOwnerImageCandidates(trackData),
    metadata.artworkURL,
    metadata.artworkUrl,
    metadata.coverArtURL,
    metadata.coverArtUrl,
    metadata.coverURL,
    metadata.coverUrl,
    metadata.thumbnailURL,
    metadata.thumbnailUrl,
    metadata.imageURL,
    metadata.imageUrl,
    metadata.posterURL,
    metadata.posterUrl,
  ];

  return normalizeArtworkList(directCandidates);
}

function resolveTrackMetadata(trackData = null) {
  const metadata = trackData?.metadata || {};
  const title = pickFirstString([
    trackData?.trackName,
    metadata.trackName,
    metadata.title,
    metadata.name,
    trackData?.trackId,
    'Audio',
  ]);
  const artist = resolveArtists(trackData) || 'Entangled Worlds';
  const album = pickFirstString([
    metadata.albumTitle,
    metadata.album,
    metadata.releaseTitle,
    metadata.releaseName,
    trackData?.entangledWorld?.artName,
    trackData?.entangledWorld?.metadata?.artName,
  ]) || '';

  return {
    title,
    artist,
    album,
    artwork: resolveArtwork(trackData),
  };
}

function supportsMediaSession() {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export class MediaSessionController {
  constructor(audioEngine, { seekOffsetSeconds = DEFAULT_SEEK_OFFSET_SECONDS } = {}) {
    this.audioEngine = audioEngine;
    this.seekOffsetSeconds = Math.max(1, Number(seekOffsetSeconds) || DEFAULT_SEEK_OFFSET_SECONDS);
    this._stateUnsubscribe = null;
    this._positionTimer = null;
    this._boundSyncPosition = this.syncPositionState.bind(this);
  }

  init() {
    if (!supportsMediaSession()) {
      return;
    }

    this.updateMetadata();
    this.updatePlaybackState(this.audioEngine?.getPlaybackState?.() || 'stopped');
    this.syncPositionState();
    this._registerActionHandlers();

    if (typeof this.audioEngine?.addPlaybackStateListener === 'function') {
      this._stateUnsubscribe = this.audioEngine.addPlaybackStateListener((payload = {}) => {
        this.updatePlaybackState(payload.state);
      });
    }
  }

  dispose() {
    if (typeof this._stateUnsubscribe === 'function') {
      this._stateUnsubscribe();
      this._stateUnsubscribe = null;
    }
    this._stopPositionSync();
    if (!supportsMediaSession()) {
      return;
    }

    this._clearActionHandlers();

    try {
      navigator.mediaSession.metadata = null;
    } catch {}

    try {
      navigator.mediaSession.playbackState = 'none';
    } catch {}
  }

  updateMetadata() {
    if (!supportsMediaSession() || typeof MediaMetadata === 'undefined') {
      return;
    }

    const trackMetadata = resolveTrackMetadata(this.audioEngine?.trackData);
    try {
      navigator.mediaSession.metadata = new MediaMetadata(trackMetadata);
    } catch (error) {
      console.warn('[MediaSession] Failed to update metadata.', error);
    }
  }

  updatePlaybackState(state) {
    if (!supportsMediaSession()) {
      return;
    }

    const stableState = state === 'playing' ? 'playing' : state === 'paused' ? 'paused' : 'none';
    try {
      navigator.mediaSession.playbackState = stableState;
    } catch {}

    if (stableState === 'playing') {
      this._startPositionSync();
    } else {
      this._stopPositionSync();
      this.syncPositionState();
    }
  }

  syncPositionState() {
    if (!supportsMediaSession() || typeof navigator.mediaSession.setPositionState !== 'function') {
      return;
    }

    const durationMs = Number(this.audioEngine?.getDurationMs?.());
    const positionMs = Number(this.audioEngine?.getCurrentPositionMs?.());
    const playbackRate = Number(this.audioEngine?.getPlaybackRate?.());

    if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(positionMs) || positionMs < 0) {
      return;
    }

    const duration = durationMs / 1000;
    const position = Math.max(0, Math.min(positionMs / 1000, duration));
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;

    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate: rate, position });
    } catch {}
  }

  _startPositionSync() {
    if (this._positionTimer) return;
    this._positionTimer = setInterval(this._boundSyncPosition, 1000);
  }

  _stopPositionSync() {
    if (!this._positionTimer) return;
    clearInterval(this._positionTimer);
    this._positionTimer = null;
  }

  _registerActionHandlers() {
    const actionMap = {
      play: () => this._play(),
      pause: () => this._pause(),
      stop: () => this._stop(),
      seekbackward: (details = {}) => this._seekBy(-(details.seekOffset || this.seekOffsetSeconds)),
      seekforward: (details = {}) => this._seekBy(details.seekOffset || this.seekOffsetSeconds),
      previoustrack: () => this._seekBy(-this.seekOffsetSeconds),
      nexttrack: () => this._seekBy(this.seekOffsetSeconds),
      seekto: (details = {}) => this._seekTo(details.seekTime),
    };

    Object.entries(actionMap).forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    });
  }

  _clearActionHandlers() {
    const actions = [
      'play',
      'pause',
      'stop',
      'seekbackward',
      'seekforward',
      'previoustrack',
      'nexttrack',
      'seekto',
    ];
    actions.forEach((action) => {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {}
    });
  }

  async _play() {
    const transport = voiceRegistry.getActive()?.transportControl ?? null;
    if (transport?.play) {
      await transport.play();
      return;
    }
    await this.audioEngine?.play?.();
  }

  async _pause() {
    const transport = voiceRegistry.getActive()?.transportControl ?? null;
    if (transport?.pause) {
      await transport.pause();
      return;
    }
    await this.audioEngine?.pause?.();
  }

  async _stop() {
    const transport = voiceRegistry.getActive()?.transportControl ?? null;
    if (transport?.stop) {
      await transport.stop();
      return;
    }
    await this.audioEngine?.stop?.();
  }

  async _seekBy(offsetSeconds) {
    const currentMs = Number(this.audioEngine?.getCurrentPositionMs?.()) || 0;
    await this._seekTo((currentMs / 1000) + Number(offsetSeconds || 0));
  }

  async _seekTo(timeSeconds) {
    const seconds = Number(timeSeconds);
    if (!Number.isFinite(seconds)) {
      return;
    }
    const durationMs = Number(this.audioEngine?.getDurationMs?.()) || 0;
    const maxSeconds = durationMs > 0 ? durationMs / 1000 : seconds;
    const clampedSeconds = Math.max(0, Math.min(seconds, maxSeconds));
    await this.audioEngine?.seekToMilliseconds?.(clampedSeconds * 1000);
    this.syncPositionState();
  }
}
