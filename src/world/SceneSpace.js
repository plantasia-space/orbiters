import * as THREE from 'three';

/**
 * Loads a cubemap texture dynamically based on screen resolution.
 * Uses high-res textures for desktops and low-res textures for mobile.
 * @returns {THREE.CubeTexture} The loaded cubemap texture.
 */
function loadCubemap() {
    const loader = new THREE.CubeTextureLoader();

    // ✅ Define texture sets for different resolutions
    const isMobile = window.innerWidth <= 768; // Adjust threshold if needed
    const resolutionPath = isMobile
        ? 'https://mw-storage.fra1.cdn.digitaloceanspaces.com/default/skybox/01_skycube_low'
        : 'https://mw-storage.fra1.cdn.digitaloceanspaces.com/default/skybox/01_skycube';

    //console.log(`[SKYBOX] Loading ${isMobile ? 'LOW' : 'HIGH'} resolution cubemap.`);

    // Load cubemap with dynamically chosen resolution
    const cubemap = loader.load([
        `${resolutionPath}/right.png`,  // Right (+X)
        `${resolutionPath}/left.png`,   // Left (-X)
        `${resolutionPath}/top.png`,    // Top (+Y)
        `${resolutionPath}/bottom.png`, // Bottom (-Y)
        `${resolutionPath}/front.png`,  // Front (+Z)
        `${resolutionPath}/back.png`    // Back (-Z)
    ]);

    // ✅ Enhance Texture Quality
    cubemap.magFilter = THREE.LinearFilter;
    cubemap.minFilter = THREE.LinearMipMapLinearFilter;
    cubemap.generateMipmaps = true;
    cubemap.anisotropy = 16; // Improve texture sharpness

    return cubemap;
}

/**
 * Initializes the space scene by setting the dynamically loaded cubemap skybox.
 * @param {THREE.Scene} scene - The Three.js scene.
 */
export function initSpaceScene(scene) {
    scene.background = loadCubemap();
}