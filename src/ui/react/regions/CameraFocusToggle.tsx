/**
 * @file src/ui/react/regions/CameraFocusToggle.tsx
 * @description What this voice's camera orbits — the world, or its first moon.
 *
 * The last cell of the bottom-left VIEW rail, under the dimension numerals: what you are looking
 * AT, as against the panel stack opposite, which is what you play WITH. It shares that column's
 * square cell, so the four buttons read as one grid (see `orbitersUI.css`).
 *
 * Everything about the travel itself is the scene's: `world/cameraFocus.js` holds only the choice,
 * and `configureCameraAutomation` reads it every frame and owns the movement.
 */
import { useEffect, useState } from 'react';
import { Moon } from 'lucide-react';
import { Icon } from 'plantasia.space-design/icons';
import { useEngineVoiceId } from '../../../react/engine/EngineContext';
import { getT } from '../../../i18n/index.js';
import { voiceRegistry } from '../../../voice/VoiceRegistry.js';
import {
  getCameraFocus,
  setCameraFocus,
  subscribeCameraFocus,
} from '../../../world/cameraFocus.js';

export function CameraFocusToggle() {
  // A shared-realm tile knows its own voice; single-orbiter renders with none, and
  // there the active voice IS this one. The camera rig always binds a real voice id,
  // so the focus must be written under that same id, never under a null key.
  const tileVoiceId = useEngineVoiceId();
  const voiceId: string | null = tileVoiceId ?? voiceRegistry.getActive()?.id ?? null;
  const [focus, setFocus] = useState(() => (voiceId ? getCameraFocus(voiceId) : 'world'));

  useEffect(() => {
    if (!voiceId) return undefined;
    setFocus(getCameraFocus(voiceId));
    return subscribeCameraFocus((changedVoiceId: string) => {
      if (changedVoiceId === voiceId) setFocus(getCameraFocus(voiceId));
    });
  }, [voiceId]);

  const onMoon = focus === 'moon';
  // The button shows WHERE IT TAKES YOU, not where you are — the play/pause rule. Orbiting the
  // moon, it offers you the world back; orbiting the world, it offers you the moon.
  //
  // So it is a plain button, not a toggle: `aria-pressed` would announce "Orbit the world,
  // pressed", which says the state and the action in one breath and contradicts itself. The name
  // changes with the destination, exactly as play/pause does, and that IS the whole message.
  const label = getT()(onMoon ? 'camera.orbitWorld' : 'camera.orbitMoon');

  return (
    <button
      type="button"
      className="orbiters-react-ui__camera-focus-btn"
      data-ui-interactive
      aria-label={label}
      title={label}
      disabled={!voiceId}
      onClick={() => voiceId && setCameraFocus(voiceId, onMoon ? 'world' : 'moon')}
    >
      {onMoon ? <Icon name="entangled-world" /> : <Moon aria-hidden="true" />}
    </button>
  );
}

export default CameraFocusToggle;
