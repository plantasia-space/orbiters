import { resolveApiBase } from './httpClient.js';

async function fetchJson(url, { method = 'GET', body, signal } = {}) {
    const headers = new Headers({ Accept: 'application/json' });
    const options = {
        method,
        headers,
        credentials: 'include',
        signal,
    };

    if (body !== undefined) {
        headers.set('Content-Type', 'application/json');
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (contentType.includes('application/json')) {
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }
    }

    return { response, payload };
}

export async function fetchPlaybackSessionById(sessionId, { signal } = {}) {
    const sanitized = typeof sessionId === 'string' ? sessionId.trim() : sessionId;
    if (!sanitized) {
        return {
            ok: false,
            status: null,
            error: new Error('sessionId is required'),
            source: 'api',
        };
    }

    const apiBase = resolveApiBase();
    if (!apiBase) {
        return {
            ok: false,
            status: null,
            error: new Error('API base not configured'),
            source: 'api',
        };
    }

    const url = `${apiBase}/playback/session/${encodeURIComponent(sanitized)}`;

    try {
        const { response, payload } = await fetchJson(url, { signal });
        return {
            ok: response.ok,
            status: response.status,
            session: payload,
            source: 'api',
        };
    } catch (error) {
        return {
            ok: false,
            status: null,
            error,
            source: 'api',
        };
    }
}
