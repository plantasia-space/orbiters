/**
 * @file sessionBridge.js
 * @description Wrappers for session resolution and updates via iframe communication.
 * @version 1.0.0
 * @author 𝐵𝓇𝓊𝓃𝒶 𝒢𝓊𝒶𝓇𝓃𝒾𝑒𝓇𝒾
 * @license MIT
 * @date 2025-01-11
 */

import { resolveOrbiterSession, updateOrbiterSession } from '../../utils/iFrameParams.js';

// ============================================================================
// Session Bridge Utilities
// ============================================================================

/**
 * Safely resolves the orbiter session without breaking on errors.
 * @param {Object} resolution - The resolution data
 * @param {Object} options - Additional options
 */
export function safeResolveSession(resolution, options) {
    if (typeof window === 'undefined') return;
    try {
        const mergedOptions = {
            emitPreview: false,
            notifyHost: false,
            ...options,
        };
        resolveOrbiterSession(resolution, mergedOptions);
    } catch (error) {
        // Silent fail - session resolution is optional
    }
}

/**
 * Safely updates the orbiter session without breaking on errors.
 * @param {Object} patch - The update patch
 * @param {Object} options - Additional options
 */
export function safeUpdateSession(patch, options) {
    if (typeof window === 'undefined') return;
    try {
        const mergedOptions = {
            emitPreview: false,
            notifyHost: false,
            ...options,
        };
        updateOrbiterSession(patch, mergedOptions);
    } catch (error) {
        // Silent fail - session updates are optional
    }
}
