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

/**
 * Binds resize/orientation listeners for the things that follow the WINDOW: the nav viewport state
 * and the world-size message to the host. Renderer size and camera aspect are NOT bound here — they
 * follow the canvas BOX and belong to `WorldSceneController`.
 * Returns a disposer to remove the bindings if needed.
 * @param {Object} params
 * @param {import('three').WebGLRenderer} params.renderer
 * @param {Function} [params.getTrackId]
 * @returns {Function} disposer
 */
function bindViewportHandlers({ renderer, getTrackId }) {
    if (typeof window === 'undefined') {
        return () => {};
    }

    const handleViewportResize = () => {
        applyNavViewportState(window.innerWidth, window.innerHeight);

        // Sizing is NOT done here. `WorldSceneController` owns the renderer size and camera aspect: it
        // fits them to the canvas BOX, and watches that box with a ResizeObserver as well as this
        // event. A second owner here could only ever agree with it or contradict it — and it did
        // contradict it, clamping the render to a minimum the box is allowed to go below (edit mode's
        // sheet), so the drawing buffer was a different shape than the box it is painted into and the
        // orbiter rendered stretched. This handler keeps only what is its own: the nav viewport state
        // and telling the host how big the world is.
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
