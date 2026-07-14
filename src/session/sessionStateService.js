import SessionResolutionService from './sessionResolutionService.js';
import { sessionDescriptorSignature, sanitizeId } from './sessionDescriptor.js';

const DEFAULT_EVENT_TARGET =
  typeof window !== 'undefined' && window ? window : (typeof globalThis !== 'undefined' ? globalThis : null);

function dispatchEventSafe(target, name, detail) {
  if (!target || typeof target.dispatchEvent !== 'function') return;
  try {
    target.dispatchEvent(new CustomEvent(name, { detail }));
  } catch (error) {
    console.warn('[SessionStateService] Failed to dispatch event', { name, error });
  }
}

export class SessionStateService {
  /**
   * @param {Object} options
   * @param {SessionResolutionService} [options.resolutionService]
   * @param {Function} [options.updateOrbiterSession]
   * @param {EventTarget} [options.eventTarget]
   */
  constructor({ resolutionService, updateOrbiterSession, eventTarget } = {}) {
    this.resolutionService =
      resolutionService instanceof SessionResolutionService
        ? resolutionService
        : new SessionResolutionService();
    this.updateOrbiterSession =
      typeof updateOrbiterSession === 'function' ? updateOrbiterSession : null;
    this.eventTarget = eventTarget ?? DEFAULT_EVENT_TARGET;

    this.state = {
      status: 'idle',
      lastError: null,
      lastSignature: null,
      cached: false,
    };
    this.pendingPromise = null;
  }

  normalizeDescriptor(descriptor = {}) {
    return {
      trackId: sanitizeId(descriptor.trackId),
      trackVersion: sanitizeId(descriptor.trackVersion),
      orbiterId: sanitizeId(descriptor.orbiterId),
      orbiterVersion: sanitizeId(descriptor.orbiterVersion),
      entangledWorldId: sanitizeId(descriptor.entangledWorldId),
      entangledWorldVersion: sanitizeId(descriptor.entangledWorldVersion),
    };
  }

  getStatus() {
    return { ...this.state };
  }

  getLastResolution() {
    return this.resolutionService?.getLastResult?.() ?? null;
  }

  hasSignature(signature) {
    return this.resolutionService?.hasSignature?.(signature) ?? false;
  }

  clearCache() {
    this.resolutionService?.clearCache?.();
    this.state = {
      status: 'idle',
      lastError: null,
      lastSignature: null,
      cached: false,
    };
  }

  _setStatus(status, { descriptor, cached = false, error = null, source = null } = {}) {
    this.state = {
      status,
      lastError: error,
      lastSignature: descriptor ? sessionDescriptorSignature(descriptor) : this.state.lastSignature,
      cached,
    };

    if (!this.updateOrbiterSession) return;

    const patchSource = source || 'session-service';

    switch (status) {
      case 'loading':
        this.updateOrbiterSession({ status: 'loading' }, { source: patchSource });
        break;
      case 'resolved':
        this.updateOrbiterSession({ status: 'resolved' }, { source: patchSource });
        break;
      case 'error':
        this.updateOrbiterSession(
          {
            status: 'error',
            errors: error
              ? [
                  {
                    message: error.message || 'Session resolution failed',
                    source: patchSource,
                  },
                ]
              : [],
          },
          { source: patchSource }
        );
        break;
      default:
        break;
    }
  }

  _emit(name, detail) {
    dispatchEventSafe(this.eventTarget, name, detail);
  }

  async loadSession({ descriptor = {}, hydratedBlobs = {}, source = 'unknown' } = {}) {
    const normalized = this.normalizeDescriptor(descriptor);
    const signature = sessionDescriptorSignature(normalized);
    const cached = this.hasSignature(signature);

    if (!cached) {
      this._setStatus('loading', { descriptor: normalized, cached: false, source });
      this._emit('orbiters:session-loading', {
        descriptor: normalized,
        source,
      });
    } else {
      this._emit('orbiters:session-cache-hit', {
        descriptor: normalized,
        source,
      });
    }

    const promise = (async () => {
      try {
        const resolution = await this.resolutionService.resolve({
          descriptor: normalized,
          hydratedBlobs,
          source,
        });

        if (!resolution || resolution.ok === false) {
          const error =
            resolution?.error ||
            new Error('Failed to resolve session entities (unknown resolution error).');
          this._setStatus('error', { descriptor: normalized, error, cached, source });
          this._emit('orbiters:session-error', {
            descriptor: normalized,
            source,
            error,
            cached,
            debug: resolution?.debug ?? null,
          });
          throw error;
        }

        this._setStatus('resolved', { descriptor: normalized, cached, source });
        this._emit('orbiters:session-ready', {
          descriptor: normalized,
          source,
          cached,
          resolution,
        });
        return resolution;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this._setStatus('error', { descriptor: normalized, error: normalizedError, cached, source });
        this._emit('orbiters:session-error', {
          descriptor: normalized,
          source,
          error: normalizedError,
          cached,
        });
        throw normalizedError;
      } finally {
        this.pendingPromise = null;
      }
    })();

    this.pendingPromise = promise;
    return promise;
  }
}

export default SessionStateService;
