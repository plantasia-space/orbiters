// @vitest-environment jsdom
/**
 * The production canvas adapters: they MODULATE the world's real elements
 * (instanced moons, cloud shell, fresnel glow) from captured base state,
 * restore that base on reset, and re-query by name — throttled — when a world
 * or mode change rebuilds the element.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createWorldCloudShellCanvas,
  createWorldGlowCanvas,
  createWorldMoonsCanvas,
} from '../../src/visual/worldCanvasAdapters.js';

function buildMoonsScene() {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.name = 'moonsGroup';
  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.1, 4, 3),
    new THREE.MeshStandardMaterial(),
    2,
  );
  const dummy = new THREE.Object3D();
  dummy.position.set(-1.5, 0.05, 0.4);
  dummy.updateMatrix();
  mesh.setMatrixAt(0, dummy.matrix);
  dummy.position.set(1.5, -0.05, -0.4);
  dummy.updateMatrix();
  mesh.setMatrixAt(1, dummy.matrix);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  mesh.setColorAt(1, new THREE.Color(1, 1, 1));
  group.add(mesh);
  scene.add(group);
  return { scene, group, mesh };
}

describe('world moons canvas', () => {
  it('captures base instances, drives per-side blink and orbit factor, keeps the moons\' SIZE, and restores on reset', () => {
    const { scene, mesh } = buildMoonsScene();
    const canvas = createWorldMoonsCanvas({ scene });

    canvas.sync(0);
    expect(canvas.exists()).toBe(true);

    canvas.drive({ blinkL: 1, blinkR: 0, radiusFactor: 2 });
    const matrices = mesh.instanceMatrix.array;
    // Left moon (instance 0): translation pushed out in the orbit plane, height kept.
    expect(matrices[12]).toBeCloseTo(-3, 5);
    expect(matrices[13]).toBeCloseTo(0.05, 5);
    expect(matrices[14]).toBeCloseTo(0.8, 5);
    // The echo answers in LIGHT ONLY — the moon's scale block is left exactly as
    // built. Driving size off the meter made the moons twitch on every repeat.
    expect(matrices[0]).toBeCloseTo(1, 5);
    // Right moon (instance 1): same size, pushed translation.
    expect(matrices[16]).toBeCloseTo(1, 5);
    expect(matrices[16 + 12]).toBeCloseTo(3, 5);
    // Blink boosts the left tint only (1 + blink·1.4).
    const colors = mesh.instanceColor.array;
    expect(colors[0]).toBeCloseTo(2.4, 5);
    expect(colors[3]).toBeCloseTo(1, 5);

    canvas.reset();
    expect(mesh.instanceMatrix.array[12]).toBeCloseTo(-1.5, 5);
    expect(mesh.instanceColor.array[0]).toBeCloseTo(1, 5);
  });

  it('skips buffer rewrites when drive values repeat', () => {
    const { scene, mesh } = buildMoonsScene();
    const canvas = createWorldMoonsCanvas({ scene });
    canvas.sync(0);
    const values = { blinkL: 0.5, blinkR: 0.5, radiusFactor: 1.2 };
    canvas.drive(values);
    const uploadedVersion = mesh.instanceMatrix.version;
    canvas.drive({ ...values });
    // Identical values → no second buffer upload.
    expect(mesh.instanceMatrix.version).toBe(uploadedVersion);
  });

  it('re-queries (throttled) when the world rebuild detaches the moons, and re-captures the new mesh', () => {
    const { scene, group } = buildMoonsScene();
    const canvas = createWorldMoonsCanvas({ scene });
    canvas.sync(0);
    expect(canvas.exists()).toBe(true);

    scene.remove(group);
    canvas.sync(0.5); // detach noticed immediately; re-query still throttled
    expect(canvas.exists()).toBe(false);

    const rebuilt = buildMoonsScene();
    scene.add(rebuilt.group);
    canvas.sync(0.6); // within the throttle window — not yet re-acquired
    expect(canvas.exists()).toBe(false);
    canvas.sync(2); // past the window — re-acquired and re-captured
    expect(canvas.exists()).toBe(true);
    canvas.drive({ blinkL: 0, blinkR: 0, radiusFactor: 2 });
    expect(rebuilt.mesh.instanceMatrix.array[12]).toBeCloseTo(-3, 5);
  });

  it('reports no moons for a world without them', () => {
    const canvas = createWorldMoonsCanvas({ scene: new THREE.Scene() });
    canvas.sync(0);
    expect(canvas.exists()).toBe(false);
    expect(() => canvas.drive({ blinkL: 1, blinkR: 1, radiusFactor: 1 })).not.toThrow();
    expect(() => canvas.reset()).not.toThrow();
  });
});

describe('world cloud shell canvas', () => {
  it('boosts opacity FROM the world baseline (clamped) and restores it on reset', () => {
    const scene = new THREE.Scene();
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 8, 6),
      new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.6 }),
    );
    shell.name = 'worldCloudShell';
    shell.scale.setScalar(1.001);
    scene.add(shell);

    const canvas = createWorldCloudShellCanvas({ scene });
    canvas.sync(0);
    expect(canvas.exists()).toBe(true);

    canvas.drive({ opacityBoost: 0.3, scaleFactor: 1.1 });
    expect(shell.material.opacity).toBeCloseTo(0.9, 5);
    expect(shell.scale.x).toBeCloseTo(1.001 * 1.1, 5);

    canvas.drive({ opacityBoost: 0.9, scaleFactor: 1 });
    expect(shell.material.opacity).toBe(1); // clamped

    canvas.reset();
    expect(shell.material.opacity).toBeCloseTo(0.6, 5);
    expect(shell.scale.x).toBeCloseTo(1.001, 5);
  });
});

describe('world glow canvas', () => {
  it('swells the fresnel rim from its captured base and restores it (either glow name)', () => {
    ['worldTextureGlow', 'worldNormalGlow'].forEach((name) => {
      const scene = new THREE.Scene();
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 6),
        new THREE.ShaderMaterial({ uniforms: { fresnelScale: { value: 1.5 } } }),
      );
      glow.name = name;
      scene.add(glow);

      const canvas = createWorldGlowCanvas({ scene });
      canvas.sync(0);
      expect(canvas.exists()).toBe(true);

      canvas.drive({ strength: 0.5, decayNorm: 0.5 });
      expect(glow.material.uniforms.fresnelScale.value).toBeCloseTo(1.5 * 2.2, 5); // base · (1 + 0.5·2.4)

      canvas.reset();
      expect(glow.material.uniforms.fresnelScale.value).toBeCloseTo(1.5, 5);
    });
  });

  it('reports no glow when the world render mode has none', () => {
    const canvas = createWorldGlowCanvas({ scene: new THREE.Scene() });
    canvas.sync(0);
    expect(canvas.exists()).toBe(false);
    expect(() => canvas.drive({ strength: 1, decayNorm: 1 })).not.toThrow();
  });
});
