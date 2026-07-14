/**
 * MIDI-learn Learn/Delete context menu positioning — `computeContextMenuPosition`.
 *
 * Regression guard for the bug where clicking a learnable control near the BOTTOM of the viewport
 * opened the menu downward off the bottom edge, so "Delete" was clipped and unreachable. The menu
 * must open downward when there's room, flip UP when there isn't, and clamp both axes to the
 * viewport. Pure function → tested without a layout engine.
 */
import { describe, it, expect } from 'vitest';
import { computeContextMenuPosition } from '../../src/input/midi/contextMenuPosition.js';

const VIEWPORT = { innerWidth: 1000, innerHeight: 800 }; // margin defaults to 8
const MENU = { width: 150, height: 90 };

describe('computeContextMenuPosition', () => {
  it('opens downward from the anchor when there is room below', () => {
    const anchor = { left: 100, top: 100, bottom: 120 };
    expect(computeContextMenuPosition(anchor, MENU, VIEWPORT)).toEqual({ top: 120, left: 100 });
  });

  it('flips UP (opens above the control) when there is no room below — the bug', () => {
    const anchor = { left: 100, top: 760, bottom: 780 }; // near the bottom edge
    // 780 + 90 = 870 > 800 - 8 → flip: top = 760 - 90 = 670 (fully on screen, Delete reachable)
    expect(computeContextMenuPosition(anchor, MENU, VIEWPORT)).toEqual({ top: 670, left: 100 });
  });

  it('clamps to the right edge when the anchor is far right', () => {
    const anchor = { left: 900, top: 100, bottom: 120 };
    // 900 + 150 = 1050 > 1000 - 8 → left = 1000 - 150 - 8 = 842
    expect(computeContextMenuPosition(anchor, MENU, VIEWPORT)).toEqual({ top: 120, left: 842 });
  });

  it('clamps to the left edge when the anchor is off-screen left', () => {
    const anchor = { left: -20, top: 100, bottom: 120 };
    expect(computeContextMenuPosition(anchor, MENU, VIEWPORT)).toEqual({ top: 120, left: 8 });
  });

  it('falls back to a bottom-clamped position when there is no room above OR below', () => {
    const shortViewport = { innerWidth: 1000, innerHeight: 100 };
    const anchor = { left: 100, top: 80, bottom: 95 };
    // flip would give 80 - 90 = -10 (< margin) → clamp: max(8, 100 - 90 - 8) = max(8, 2) = 8
    expect(computeContextMenuPosition(anchor, MENU, shortViewport)).toEqual({ top: 8, left: 100 });
  });
});
