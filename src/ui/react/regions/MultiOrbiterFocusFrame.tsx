/**
 * @file src/ui/react/regions/MultiOrbiterFocusFrame.tsx
 * @description The focused-tile marker for the multi-orbiter view: the design-kit FourCornerCard's
 * brand corner brackets at the tile edges — corners only, not a full ring — shown on the focused tile(s).
 *
 * Each tile mounts its own orbiter UI bound to its voice; this reads the tile's `voiceId` from the
 * engine context and subscribes to the realm's SELECTION set, rendering the frame whenever THIS tile is
 * selected. In single-focus the selection is exactly the one active tile, so this is identical
 * to the old active-only behaviour. When several tiles are shift-selected, the PRIMARY tile draws solid
 * accent corners and the other selected tiles draw dimmer corners, so the multi-focus state reads clearly.
 * Single-orbiter has no `voiceId` (one always-focused orbiter) so it never renders a frame.
 * Pointer-transparent, so it never blocks interaction with the tile.
 */
import { useEffect, useState } from 'react';
import { FourCornerCard } from 'plantasia.space-design/react';
import { useEngine } from '../../../react/engine/EngineContext';
import { voiceRegistry } from '../../../voice/VoiceRegistry.js';

export function MultiOrbiterFocusFrame() {
  const { voiceId } = useEngine();
  const [activeId, setActiveId] = useState(() => voiceRegistry.activeId);
  const [selected, setSelected] = useState<boolean>(() =>
    voiceId != null && voiceRegistry.isSelected(voiceId),
  );
  // Follow the realm's focused voice (primary) AND the selection set; unsubscribe on cleanup.
  useEffect(() => {
    // Re-seed from current truth on (re)subscribe — this also fixes the case where the SAME component
    // instance is reused for a different voiceId (rearrange/reconcile): without this the frame would keep
    // the previous voice's state until the next selection change.
    setActiveId(voiceRegistry.activeId);
    setSelected(voiceId != null && voiceRegistry.isSelected(voiceId));
    const offActive = voiceRegistry.onActiveChange(setActiveId);
    const offSelection = voiceRegistry.onSelectionChange(() =>
      setSelected(voiceId != null && voiceRegistry.isSelected(voiceId)),
    );
    return () => {
      offActive();
      offSelection();
    };
  }, [voiceId]);

  if (voiceId == null || !selected) return null;

  const isPrimary = activeId === voiceId;
  // Primary keeps the full-strength accent; secondary-selected tiles are dimmed so the primary (the tile
  // whose knobs echo out, and the theme/keyboard target) stays visually distinct within the selection.
  const cornerColors = isPrimary
    ? 'var(--color1, #ffffff)'
    : 'color-mix(in srgb, var(--color1, #ffffff) 55%, transparent)';

  return (
    <div
      className="orbiters-react-ui__focus-frame"
      data-focus-role={isPrimary ? 'primary' : 'selected'}
      aria-hidden="true"
    >
      {/* Corners only — no content; the card fills the tile (its `-card` box is 100%×100%) so the
          brackets, which are absolute to that box, land at the tile edges. */}
      <FourCornerCard className="orbiters-react-ui__focus-frame-card" cornerColors={cornerColors}>
        <></>
      </FourCornerCard>
    </div>
  );
}
