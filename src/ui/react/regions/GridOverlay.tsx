/**
 * @file src/ui/react/regions/GridOverlay.tsx
 * @description A debug overlay that makes the layout grid VISIBLE — one labelled, tinted box per
 * named grid area. Each box is a DIRECT child of the `.orbiters-react-ui` grid placed by
 * `grid-area`, so it lines up exactly with the real region in that cell (same grid, same tracks).
 *
 * Gated by `?grid=1` (read once from the URL) and off by default. Purely presentational:
 * `aria-hidden` + `pointer-events: none` (in CSS) so it never intercepts canvas drags.
 *
 * The area names mirror `grid-template-areas` on `.orbiters-react-ui` (orbitersUI.css). `info`
 * spans the left + center columns (so a wide readout can't force the left lane wide); the canvas
 * shows through wherever a region doesn't paint.
 */

// Keep in sync with `grid-template-areas` in orbitersUI.css.
const GRID_AREAS = ['header', 'info', 'right', 'dim', 'xyz'] as const;

/** Read the `?grid=1` flag once (module load) — it can't change without a reload. */
function gridOverlayEnabled(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('grid') === '1';
  } catch {
    return false;
  }
}

export function GridOverlay() {
  if (!gridOverlayEnabled()) return null;
  return (
    <>
      {GRID_AREAS.map((area) => (
        <div
          key={area}
          className="orbiters-react-ui__grid-cell"
          style={{ gridArea: area }}
          aria-hidden="true"
        >
          {area}
        </div>
      ))}
    </>
  );
}
