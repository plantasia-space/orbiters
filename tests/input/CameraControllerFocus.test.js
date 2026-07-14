// @vitest-environment jsdom
/**
 * Each voice's CameraController owns its ONE input surface (its cell in a shared realm, or the
 * app's fullscreen canvas single-orbiter). On pointerdown it FOCUSES its own voice (voiceRegistry.setActive);
 * a drag starts only on the BARE surface (e.target === the input element) and only while camera drive is
 * enabled (jamming). There is no cross-voice `_isActiveVoice` gate — input only ever arrives on a voice's
 * own surface, so a pointer event reaching this controller is, by construction, for this voice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../../src/input/CameraController.js';
import { voiceRegistry } from '../../src/voice/VoiceRegistry.js';

function fakeWorld() {
  return {
    renderer: { domElement: document.createElement('canvas') },
    controls: { target: new THREE.Vector3(0, 0, 0) },
    camera: { position: new THREE.Vector3(1, 2, 3) },
    addRenderCallback() {},
    removeRenderCallback() {},
  };
}

// pointerdown on a given target (defaults to the bare input surface the controller bound to)
function pointerDown(cc, { target = cc._inputEl, id = 1 } = {}) {
  cc._onPointerDown({ pointerType: 'mouse', pointerId: id, clientX: 10, clientY: 10, target });
}

describe('CameraController — per-voice input surface', () => {
  beforeEach(() => {
    voiceRegistry.clear();
    voiceRegistry.register('v1', { id: 'v1' });
    voiceRegistry.register('v2', { id: 'v2' });
  });

  it('focuses its own voice on pointerdown, even if another voice was active', () => {
    const cc = new CameraController(fakeWorld(), null, 'v2');
    voiceRegistry.setActive('v1');
    pointerDown(cc);
    expect(voiceRegistry.activeId).toBe('v2'); // pointerdown focused THIS voice
    expect(cc._pointerActive).toBe(true); // and started the drag (bare surface, drive on)
    cc.dispose();
  });

  it('a pointerdown on a control (not the bare surface) focuses but does NOT start a drag', () => {
    const cc = new CameraController(fakeWorld(), null, 'v2');
    voiceRegistry.setActive('v1');
    const control = document.createElement('button'); // a chrome control layered over the cell
    pointerDown(cc, { target: control });
    expect(voiceRegistry.activeId).toBe('v2'); // still focuses the tile
    expect(cc._pointerActive).toBe(false); // but no camera drag under the control
    expect(cc._pointers.size).toBe(0);
    cc.dispose();
  });

  it('the panel filter gates drive: disabled → focus only, no drag; re-enabled → drags again', () => {
    const cc = new CameraController(fakeWorld(), null, 'v2');
    cc.enablePointerParamDrive(false); // a non-jamming panel
    pointerDown(cc);
    expect(voiceRegistry.activeId).toBe('v2'); // focus still works in any panel
    expect(cc._pointerActive).toBe(false); // drive gated off
    cc.enablePointerParamDrive(true); // back to jamming
    pointerDown(cc);
    expect(cc._pointerActive).toBe(true);
    cc.dispose();
  });

  it('a null voiceId never writes focus (defensive guard) but still drives its own input', () => {
    const cc = new CameraController(fakeWorld(), null, null);
    voiceRegistry.setActive('v1');
    pointerDown(cc);
    expect(voiceRegistry.activeId).toBe('v1'); // null voiceId → never calls setActive
    expect(cc._pointerActive).toBe(true); // still handles its own drag
    cc.dispose();
  });

  it('real single-orbiter (voiceId = PRIMARY_VOICE_ID, registered) focuses + drags, no throw', () => {
    // Production single-orbiter builds the controller with the registered PRIMARY_VOICE_ID (not null),
    // so setActive fires on every pointerdown — a harmless no-op (already active, no subscribers).
    voiceRegistry.register('primary', { id: 'primary' });
    voiceRegistry.setActive('primary');
    const cc = new CameraController(fakeWorld(), null, 'primary');
    pointerDown(cc);
    expect(voiceRegistry.activeId).toBe('primary');
    expect(cc._pointerActive).toBe(true);
    cc.dispose();
  });
});
