/**
 * @file src/input/midi/contextMenuPosition.js
 * @description Pure positioning for the MIDI-learn Learn/Delete context menu. Kept free of any app
 * imports so it can be unit-tested without a layout engine or the app entry point.
 */

/**
 * Place the Learn/Delete menu so it always stays fully on screen. Opens downward from the anchor
 * control by default, but flips to open ABOVE it when there isn't room below (so a control near the
 * bottom edge doesn't push "Delete" off the bottom and out of reach), and clamps both axes to the
 * viewport.
 *
 * @param {{left:number, bottom:number, top:number}} anchorRect - the control's getBoundingClientRect
 * @param {{width:number, height:number}} menuRect - the menu's measured size
 * @param {{innerWidth:number, innerHeight:number, margin?:number}} viewport
 * @returns {{top:number, left:number}} integer page coordinates for the menu
 */
export function computeContextMenuPosition(anchorRect, menuRect, { innerWidth, innerHeight, margin = 8 } = {}) {
  let top = anchorRect.bottom;
  // Not enough room below → flip up and open above the control.
  if (anchorRect.bottom + menuRect.height > innerHeight - margin) {
    top = anchorRect.top - menuRect.height;
  }
  // No room above either (very short viewport) → clamp to the bottom of the viewport.
  if (top < margin) {
    top = Math.max(margin, innerHeight - menuRect.height - margin);
  }
  let left = anchorRect.left;
  if (left + menuRect.width > innerWidth - margin) {
    left = innerWidth - menuRect.width - margin;
  }
  if (left < margin) {
    left = margin;
  }
  return { top: Math.round(top), left: Math.round(left) };
}
