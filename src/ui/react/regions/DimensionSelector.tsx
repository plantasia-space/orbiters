/**
 * @file src/ui/react/regions/DimensionSelector.tsx
 * @description The dimension selector region (strategy §5, reuse-map build order #4).
 *
 * Drives the `dims` EngineContext surface. Moved (Bruna's device feedback 2026-06-17) OUT
 * of the header — where it crowded the mobile top bar and had no room to expand in MIDI-learn mode
 * — into the bottom-left VIEW rail, where it now sits above the camera's world/moon button as one
 * column of identical cells (see `orbitersUI.css`). Buttons (not tabs/dropdown): they are ALWAYS
 * visible, so each is a stable per-dimension MIDI-learn target (no collapsed-menu transience).
 *
 * Each dimension is a TALLY — one stroke, two, three. They were roman numerals, and numerals could
 * never hold a column of icons: type sets its own width, so "III" out-measured every mark near it
 * and the column would not balance at any size. A tally is drawn on the same grid as any other icon,
 * and it still counts, which was the numerals' only real job.
 *
 * Reads the dimension list + active id from `dims`, switches via `dims.setActive` (which runs the
 * full OrbitersEditMode hydration, keeping React + the legacy chrome in sync), and re-renders on
 * `orbiters:dimension-changed` (`dims.subscribe`) so a WAC-chrome switch reflects here too.
 *
 * Renders nothing when no dimension provider is wired (non-edit modes → empty list).
 */
import { Tally1, Tally2, Tally3, Tally4, Tally5 } from 'lucide-react';
import { useEngineDims } from '../../../react/engine/EngineContext';
import { useEngineSubscription } from '../../../react/engine/useEngineSubscription';
import { useTriggerGroup } from '../../../react/parameters';

/** The legacy per-dimension MIDI key (`dimension-<sanitized-id>`), matching
 *  ButtonGroup.sanitizeDimensionKey so a React button inherits the legacy mapping. */
function dimensionComponentId(dimensionId: string): string {
  const slug =
    String(dimensionId ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default';
  return `dimension-${slug}`;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
/** Compact roman label for the Nth dimension button (I / II / III …). Falls back to the number. */
function romanLabel(index: number): string {
  return ROMAN[index] ?? String(index + 1);
}

/**
 * Tally marks for the Nth dimension — one stroke, two, three.
 *
 * They replace the roman numerals, which were TYPE in a column of ICONS: every numeral set its own
 * width, so "III" out-measured the camera's mark below it and the column never balanced, whatever
 * the type size. A tally is drawn on the same grid as any other icon, so the four cells finally
 * read as one set. It also still counts, which is the whole job — one dimension, one more stroke.
 * Beyond the fifth (no tally exists for it) the numeral comes back rather than nothing.
 */
const TALLY = [Tally1, Tally2, Tally3, Tally4, Tally5];

export function DimensionSelector() {
  const dims = useEngineDims();

  // Re-read active/list whenever ANYTHING switches dimension (React or WAC chrome).
  // `dims.setActive` dispatches `orbiters:dimension-changed`, so a React-driven switch re-renders
  // through this same subscription — no separate force needed.
  useEngineSubscription(dims);

  const options = dims.list();
  // MIDI-learn: one GLOBAL momentary trigger per dimension under the legacy `dimension-<id>` key
  // (so a learned CC inherits the legacy mapping; switching is idempotent so a residual legacy
  // double-fire is harmless). The buttons are always rendered, so each is a stable learn target.
  const getMidiProps = useTriggerGroup(
    options.map((o) => ({ componentId: dimensionComponentId(o.id), onTrigger: () => dims.setActive(o.id), scope: 'GLOBAL' as const })),
  );

  if (options.length === 0) {
    return null;
  }

  const active = dims.active() ?? options[0]?.id ?? '';

  // Drawn from the BOTTOM up: I nearest the foot of the column, III at the top. The column is
  // read from where the hand rests, and the first dimension should be the first thing under it —
  // so the DOM order (I, II, III) is reversed for painting, and only for painting. The numeral a
  // button carries still comes from its own index, so III stays III wherever it is drawn.
  const painted = [...options].reverse();

  return (
    <div
      className="orbiters-react-ui__dimension-selector"
      data-ui-interactive
      data-ui-react-region="dimension-selector"
    >
      {painted.map((o) => {
        const i = options.indexOf(o);
        const Tally = TALLY[i];
        return (
          <button
            key={o.id}
            type="button"
            {...getMidiProps(dimensionComponentId(o.id))}
            className="orbiters-react-ui__dim-btn"
            data-active={o.id === active || undefined}
            aria-pressed={o.id === active}
            aria-label={o.label}
            title={o.label}
            onClick={() => dims.setActive(o.id)}
          >
            {Tally ? <Tally aria-hidden="true" /> : romanLabel(i)}
          </button>
        );
      })}
    </div>
  );
}
