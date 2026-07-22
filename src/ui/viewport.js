import {
    computeNavViewportState,
    isMobileState,
} from '../config/breakpoints.js';

/**
 * Helpers to keep renderer, camera, and parent iframe sizing in sync.
 */

function applyNavViewportState(width, height) {
    if (typeof document === 'undefined') return null;

    const state = computeNavViewportState(width, height);
    const shell = isMobileState(state) ? 'mobile' : 'desktop';
    const root = document.documentElement;
    const body = document.body;
    const previousState = root?.dataset?.navViewportState || body?.dataset?.navViewportState || null;
    const previousShell = root?.dataset?.navShell || body?.dataset?.navShell || null;
    const previousHeightClass = root?.dataset?.navHeightState || body?.dataset?.navHeightState || null;

    const heightClass = height < 720 ? 'short' : 'tall';

    if (root) {
        root.dataset.navViewportState = state;
        root.dataset.navShell = shell;
        root.dataset.navHeightState = heightClass;
    }

    if (body) {
        body.dataset.navViewportState = state;
        body.dataset.navShell = shell;
        body.dataset.navHeightState = heightClass;
    }

    if (
        typeof window !== 'undefined' &&
        (previousState !== state || previousShell !== shell || previousHeightClass !== heightClass)
    ) {
        window.dispatchEvent(
            new CustomEvent('orbiters:nav-viewport-state-changed', {
                detail: {
                    state,
                    shell,
                    heightState: heightClass,
                    width: Number(width) || 0,
                    height: Number(height) || 0,
                },
            }),
        );
    }

    return state;
}

/**
 * Posts renderer dimensions to the parent frame when running inside an iframe.
 * @param {import('three').WebGLRenderer} renderer
 * @param {string|null} [trackId=null]
 */
function sendWorldSize(renderer, trackId = null) {
    if (typeof window === 'undefined') return;
    if (window.self === window.top) {
        return;
    }

    const mainContainer = renderer?.domElement || document.body;
    const rect = mainContainer.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);

    window.parent.postMessage(
        {
            type: 'world-size',
            trackId,
            width,
            height
        },
        '*'
    );
}
/**
 * Frame the orbiter into the left region WITHOUT shrinking the canvas — the scene stays full-width so
 * the live 3D (starfield) renders BEHIND the frosted Studio panel (the semi-transparent look), while a
 * camera view-offset shifts the orbiter left by half the panel inset so it sits centered in the visible
 * left region, aligned with the play UI. `insetRight === 0` (play mode) clears the offset. ONE source of
 * the offset formula, shared by both resize owners (this handler + `WorldSceneController.#applySize`).
 * @param {import('three').PerspectiveCamera} camera
 * @param {number} insetRight - right-edge inset reserved by the panel, in px
 * @param {number} frameWidth - the rendered frame width (full viewport width)
 * @param {number} frameHeight - the rendered frame height
 */
function applyCameraInsetOffset(camera, insetRight, frameWidth, frameHeight) {
    if (!camera) return;
    if (insetRight > 0) {
        camera.setViewOffset(frameWidth, frameHeight, insetRight / 2, 0, frameWidth, frameHeight);
    } else if (camera.view && camera.view.enabled) {
        camera.clearViewOffset();
    }
}

function getCssRootVarPx(varName, fallback = 220) {
    if (typeof window === 'undefined') return fallback;
    const val = getComputedStyle(document.documentElement).getPropertyValue(varName);
    const px = parseInt(val, 10);
    return isNaN(px) ? fallback : px;
}
/**
 * Binds resize/orientation listeners that keep the renderer and camera aligned with the viewport.
 * Returns a disposer to remove the bindings if needed.
 * @param {Object} params
 * @param {import('three').WebGLRenderer} params.renderer
 * @param {import('three').Camera} params.camera
 * @param {Function} [params.getTrackId]
 * @returns {Function} disposer
 */
function bindViewportHandlers({ renderer, camera, getTrackId, maxDevicePixelRatio = 2, getViewportInset }) {
    if (typeof window === 'undefined') {
        return () => {};
    }

    const MIN_SIZE = getCssRootVarPx('--orbiters-min-size', 220);

    const handleViewportResize = () => {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        applyNavViewportState(viewportWidth, viewportHeight);

        // Keep the canvas FULL-WIDTH (the scene renders behind the frosted Studio panel) and shift the
        // orbiter into the left region via a camera view-offset. `getViewportInset` is the single
        // source of the panel inset (the controller's `viewportInsetRight`); 0 in play mode = no offset.
        const insetRight = (typeof getViewportInset === 'function' ? Number(getViewportInset()) : 0) || 0;
        // Size to the CANVAS BOX, not the window. The stylesheet owns that box, and in edit mode it is
        // smaller than the window (`.ratio-frame` gives the open sheet its room back). Deriving it here
        // a second way — from `innerHeight` minus a reserve — would drift: percentage heights resolve
        // against the layout viewport while `innerHeight` is the dynamic one, so on a phone the two
        // disagree by the browser chrome and the drawing buffer ends up a different shape than the box
        // it is painted into. One box, read once, shared with the scene controller.
        const box = renderer?.domElement;
        const frameWidth = Math.max(box?.clientWidth || viewportWidth, MIN_SIZE);
        const frameHeight = Math.max(box?.clientHeight || viewportHeight, MIN_SIZE);

        // `false` = leave the canvas BOX to CSS (it is the input here, so writing it back would be a
        // feedback loop). Embed/multi paths never reach this handler — they run on the shared
        // compositor, which sizes with `false` too and styles its own canvases inline.
        renderer.setSize(frameWidth, frameHeight, false);
        camera.aspect = frameWidth / frameHeight;
        applyCameraInsetOffset(camera, insetRight, frameWidth, frameHeight);
        camera.updateProjectionMatrix();
        const profileMax =
            renderer?.userData?.performanceProfile?.maxDevicePixelRatio ?? maxDevicePixelRatio;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, profileMax));

        if (renderer) {
            const trackId = typeof getTrackId === 'function' ? getTrackId() : null;
            sendWorldSize(renderer, trackId);
        }
    };

    window.addEventListener('resize', handleViewportResize);
    window.addEventListener('orientationchange', handleViewportResize);
    handleViewportResize();

    return () => {
        window.removeEventListener('resize', handleViewportResize);
        window.removeEventListener('orientationchange', handleViewportResize);
    };
}

export { applyNavViewportState, applyCameraInsetOffset, bindViewportHandlers, sendWorldSize };
