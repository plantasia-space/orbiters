/**
 * @file src/ui/monitorHydration.js
 * Throttled hydration of the monitor info panel.
 *
 * The cosmic LFO pushes axis values at ~30 Hz; repopulating the monitor placeholders on
 * every tick is wasteful on mobile, so this coalesces calls to at most one flush per
 * `intervalMs` (a trailing-edge timer flushes the last manager seen). The throttle interval
 * is driven by the active graphics profile (`uiMonitorThrottleMs`) and re-set per session
 * bootstrap. Extracted from Main.js so the boot state has a single owner.
 *
 * @param {number} [initialIntervalMs=0] starting throttle interval; 0 = flush synchronously.
 * @returns {{ setIntervalMs: (ms: number) => void, hydrate: (manager: unknown) => void }}
 */
export function createMonitorHydration(initialIntervalMs = 0) {
    const state = {
        intervalMs: Math.max(0, Number(initialIntervalMs) || 0),
        lastFlush: 0,
        timerId: null,
        pendingManager: null,
    };

    const getNow = () =>
        typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();

    const performHydration = (manager) => {
        if (!manager || typeof manager.populatePlaceholders !== 'function') return;
        try {
            manager.populatePlaceholders('monitorInfo');
        } catch (error) {
            console.warn('[Main] Failed to populate monitor placeholders.', error);
        }
    };

    /** Update the throttle interval; flush any pending manager when throttling is disabled. */
    const setIntervalMs = (intervalMs) => {
        const parsed = Number(intervalMs);
        state.intervalMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

        if (state.intervalMs === 0 && state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
            if (state.pendingManager) {
                const target = state.pendingManager;
                state.pendingManager = null;
                state.lastFlush = getNow();
                performHydration(target);
            }
        }
    };

    /** Hydrate the monitor now if past the interval, else schedule a trailing flush. */
    const hydrate = (manager) => {
        const interval = state.intervalMs;
        if (interval <= 0) {
            performHydration(manager);
            return;
        }

        const now = getNow();
        const elapsed = now - state.lastFlush;

        if (elapsed >= interval) {
            state.lastFlush = now;
            performHydration(manager);
            return;
        }

        state.pendingManager = manager;
        if (state.timerId != null) {
            return;
        }

        const delay = Math.max(0, interval - elapsed);
        state.timerId = setTimeout(() => {
            state.timerId = null;
            const target = state.pendingManager;
            state.pendingManager = null;
            if (!target) {
                return;
            }
            state.lastFlush = getNow();
            performHydration(target);
        }, delay);
    };

    return { setIntervalMs, hydrate };
}
