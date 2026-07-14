import { resolvePublicUrl } from 'entangled-worlds-orbiters-shared/config';
import { updateDefaultLights } from 'entangled-worlds-orbiters-shared/core';
import { MoonsManager } from 'entangled-worlds-orbiters-shared/moons';

function toHexInt(hex) {
  if (typeof hex === 'number') return hex >>> 0;
  if (typeof hex !== 'string') return undefined;
  const clean = hex.trim().replace(/^#/, '');
  if (!clean) return undefined;
  const parsed = Number.parseInt(clean, 16);
  return Number.isFinite(parsed) ? (parsed >>> 0) : undefined;
}

function resolveAssetUrl(path) {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) {
    return trimmed;
  }
  return resolvePublicUrl(trimmed);
}

function extractPreview(metadata = {}) {
  return (
    metadata.entangledWorldPreview ||
    metadata.preview ||
    metadata?.step_two?.entangled_world_preview ||
    {}
  );
}

function resolveTextureUrl(world, preview = {}) {
  const assets = world?.assets || {};
  const metadata = world?.metadata || {};
  const sphere = preview.sphere || metadata.sphere || {};
  const worldTexture = metadata.worldTexture || metadata.texture || {};
  const previewWorldTexture = preview.worldTexture || {};

  const candidates = [
    worldTexture.url,
    worldTexture.textureUrl,
    worldTexture.textureURL,
    metadata.selectedTextureURL,
    metadata.textureURL,
    metadata.textureUrl,
    metadata.texture?.url,
    assets.selectedTextureURL,
    assets.selectedTextureUncompressedURL,
    previewWorldTexture.url,
    previewWorldTexture.textureUrl,
    previewWorldTexture.textureURL,
    assets.selectedTextureKey,
    worldTexture.selected,
    previewWorldTexture.selected,
    sphere.textureUrl,
    sphere.textureURL,
  ];

  for (const candidate of candidates) {
    const resolved = resolveAssetUrl(candidate);
    if (resolved) return resolved;
  }

  return null;
}

function applyLighting(scene, metadata = {}, preview = {}) {
  const lighting = preview.lighting || metadata.lighting || {};
  const ambient = lighting.ambientIntensity ?? lighting.ambient ?? 1;
  const diffuse = lighting.diffuseIntensity ?? lighting.diffuse ?? 1;
  const color = lighting.lightColor ?? lighting.color ?? '#ffffff';
  const direction = lighting.lightDirection ?? lighting.direction ?? { x: 1, y: 1, z: 1 };

  const safeDirection =
    direction && typeof direction === 'object'
      ? {
          x: Number.isFinite(direction.x) ? direction.x : 1,
          y: Number.isFinite(direction.y) ? direction.y : 1,
          z: Number.isFinite(direction.z) ? direction.z : 1,
        }
      : { x: 1, y: 1, z: 1 };

  // The lights belong to THIS voice's scene. Addressing them without it updated whichever scene was
  // ensured last, so in a multi-voice realm one voice's lighting landed on another's world.
  if (!scene) {
    console.warn('[OrbitersPlayMode] No scene — skipping lighting.');
    return;
  }
  updateDefaultLights(scene, {
    ambientIntensity: ambient,
    diffuseIntensity: diffuse,
    lightColor: color,
    lightDirection: safeDirection,
  });
}

function applyFlags(worldManager, metadata = {}, preview = {}) {
  const flags = {
    ...(metadata.flags || {}),
    ...(preview.flags || {}),
  };
  if (worldManager && typeof worldManager.setFlags === 'function' && Object.keys(flags).length) {
    worldManager.setFlags(flags);
  }
}

async function setupMoons({ world, preview, scene, moonsManager, renderer }) {
  if (!scene) return { moonsManager };

  let manager = moonsManager;
  if (!manager) {
    // Thread this voice's renderer so KTX2 moon textures bind to its context (shared 3.0: no
    // window-global fallback exists).
    manager = new MoonsManager(scene, { renderer });
  }

  const metadata = world?.metadata || {};
  const previewMoons = preview.moons || metadata.moons || {};

  let moonCount = 0;
  if (typeof previewMoons.count === 'number') {
    moonCount = previewMoons.count;
  } else if (typeof world?.moonAmount === 'number') {
    moonCount = world.moonAmount;
  } else if (typeof metadata.moonAmount === 'number') {
    moonCount = metadata.moonAmount;
  }

  const textureCandidate =
    previewMoons.textureKey ||
    previewMoons.textureUrl ||
    previewMoons.textureURL ||
    metadata?.moons?.textureKey ||
    metadata?.moons?.textureUrl ||
    metadata?.moons?.textureURL ||
    null;

  const resolvedTexture = resolveAssetUrl(textureCandidate);
  const moonColor =
    previewMoons.moonColor ||
    previewMoons.color ||
    metadata?.moons?.moonColor ||
    '#ffffff';

  const seed =
    world?.worldId ||
    metadata.worldId ||
    metadata.id ||
    'orbiters-world';

  const orbitRadius =
    previewMoons.orbitRadius ??
    metadata?.moons?.orbitRadius ??
    1.5;

  const options = {
    seed,
    orbitRadius,
    moonColor,
    useTexture: !!resolvedTexture,
  };
  if (resolvedTexture) {
    options.textureKey = resolvedTexture;
  }

  try {
    await manager.setAmount(moonCount, options);
  } catch (err) {
    console.warn('[OrbitersPlayMode] Failed to configure moons:', err);
  }

  return { moonsManager: manager };
}

export class OrbitersPlayMode {
  constructor({ worldManager, scene, onWorldHydrated } = {}) {
    this.worldManager = worldManager;
    this.scene = scene;
    this.onWorldHydrated = onWorldHydrated;
    this.isActive = false;
    this.lastContext = null;
    this.moonsManager = null;
  }

  async refresh(context) {
    return this.activate(context);
  }

  async activate(context = {}) {
    this.isActive = true;
    this.lastContext = context;

    const world = context.trackData?.entangledWorld || context.entangledWorld;
    if (!world) {
      console.warn('[OrbitersPlayMode] Missing entangled world data – skipping shared renderer.');
      return false;
    }

    const metadata = world.metadata || {};
    const preview = extractPreview(metadata);

    applyLighting(this.scene || context.scene, metadata, preview);
    applyFlags(this.worldManager, metadata, preview);

    const textureUrl = resolveTextureUrl(world, preview);
    const graphicsPreference = context.graphicsPreference || 'high';

    const sphere = preview.sphere || metadata.sphere || {};
    const glow = preview.glow || metadata.glow || {};
    const clouds = preview.clouds || metadata.clouds || {};
    const cloudsTextureUrl = resolveAssetUrl(clouds.textureKey || clouds.textureUrl);

    const surfaceOptions = {
      sphereRadius: sphere.radius,
      sphereWidthSegments: sphere.widthSegments,
      sphereHeightSegments: sphere.heightSegments,
      materialRoughness: sphere.materialRoughness ?? sphere.roughness,
      materialMetalness: sphere.materialMetalness ?? sphere.metalness,
      glow: glow.enabled ?? true,
      glowScale: glow.scale,
      glowRimHex: toHexInt(glow.rim ?? glow.rimColor),
      glowFacingHex: toHexInt(glow.facing ?? glow.inner),
      glowBias: glow.bias,
      glowFresnelScale: glow.fresnelScale,
      glowPower: glow.power,
      cloudsEnabled: clouds.enabled ?? false,
      cloudsTextureUrl,
      cloudsColor: toHexInt(clouds.color),
      cloudsOpacity: clouds.opacity,
      cloudsSpeed: clouds.speed,
    };

    const runMoonsSetup = async () => {
      const result = await setupMoons({
        world,
        preview,
        renderer: this.worldManager?.renderer,
        scene: this.scene || context.scene,
        moonsManager: this.moonsManager,
      });
      this.moonsManager = result.moonsManager;
    };

    const runNormalMode = async () => {
      await this.worldManager.setMode(3, surfaceOptions);
      await runMoonsSetup();
      return 3;
    };

    const isRecoverableTextureError = (err) => {
      const message = `${err?.message || err || ''}`.toLowerCase();
      return (
        message.includes('missing ktx 2.0 identifier') ||
        message.includes('ktx2') ||
        message.includes('basisu') ||
        message.includes('texture') ||
        message.includes('image bitmap')
      );
    };

    let activeMode;

    if (!textureUrl) {
      console.warn('[OrbitersPlayMode] No texture URL in world data — rendering the plain sphere.');
      activeMode = await runNormalMode();
    } else {
      try {
        await this.worldManager.setMode(1, {
          textureUrl,
          ...surfaceOptions,
        });
        await runMoonsSetup();
        activeMode = 1;
      } catch (err) {
        if (isRecoverableTextureError(err)) {
          console.warn('[OrbitersPlayMode] Texture mode failed, using normal sphere fallback:', err);
          activeMode = await runNormalMode();
        } else {
          throw err;
        }
      }
    }

    if (typeof window !== 'undefined') {
      window.__orbitersWorldRenderState = {
        graphicsPreference,
        activeMode,
        textureUrl,
        glowEnabled: surfaceOptions.glow !== false,
        cloudsEnabled: Boolean(surfaceOptions.cloudsEnabled),
      };
    }

    this.onWorldHydrated?.({ ...context, mode: activeMode, textureUrl });
    return true;
  }

  async deactivate(context = null) {
    if (!this.isActive) return;
    this.isActive = false;
    this.worldManager?.disposeCurrent?.();

    const fallbackContext = context || this.lastContext || {};
    const scene = this.scene || fallbackContext.scene;
    if (scene && this.moonsManager?.group) {
      scene.remove(this.moonsManager.group);
    }
    if (this.moonsManager) {
      await this.moonsManager.setAmount(0);
    }
  }

  setActiveDimension() {
    return false;
  }
}

export default OrbitersPlayMode;
