/**
 * @file src/ui/react/regions/InfoPanel.tsx
 * @description The React Info panel (Phase 2, react-ui-go-live-roadmap §Phase 2). Rebuilds the
 * legacy slide-down info grid (`#collapseInfoMenu`, `visibility:collapse` under `?ui=react`) as a
 * React-owned region so React owns the overlay — the prerequisite for T8b deleting the legacy grid.
 *
 * Style (Bruna's device feedback): NOT a box — transparent text integrated at the TOP-LEFT, below
 * the header icons, in two columns (label · value), like the legacy readout. A centered card covered
 * the scene; this sits in it.
 *
 * Four views, chosen from the header Information menu:
 *   - MONITOR — the audio-engine label + live value for the SELECTED dimension's axes (x/y/z). This
 *     is NOT the x/y/z rotation (that's the knobs); it's the audio parameter each rotation drives,
 *     mapped into the effect's domain. The value reflects the REAL parameter state (the `monitor`
 *     surface maps ParameterManager's live normalized value, not a stale rack default), so it's
 *     correct from load. We show only the active dimension's axes, mirroring the legacy monitor.
 *   - TRACK / ENTANGLED-WORLD / ORBITER — static metadata rows (the `info` surface).
 *
 * Open/close + active view live in `infoPanelStore` (shared with the HeaderBar menu, its sibling).
 */
import { useEngineMonitor, useEngineInfo, useEngineDims } from '../../../react/engine/EngineContext';
import {
  useEngineSubscription,
  useEngineSnapshot,
} from '../../../react/engine/useEngineSubscription';
import { type InfoMode } from './infoPanelStore';
import { useInfoPanelStore } from './InfoPanelStoreContext';
import { getT } from '../../../i18n/index.js';

const AXIS_ORDER = ['x', 'y', 'z'] as const;

/** i18n key for each info view's display name (shared with the header Information menu). */
const MODE_LABEL_KEYS: Record<InfoMode, string> = {
  monitor: 'topBar.menu.engineMonitor',
  track: 'topBar.menu.track',
  'entangled-world': 'topBar.menu.entangledWorld',
  orbiter: 'topBar.menu.orbiter',
};

/** A label·value row shared by every view. */
interface Row {
  key: string;
  label: string;
  value: string;
}

/** Engine Monitor rows for the SELECTED dimension only: per axis/slot, the audio module label +
 *  its live value. Returns null when the monitor source isn't wired (audio not up yet).
 *
 *  The selected dimension comes from the `dims` surface (what the dimension selector itself reads),
 *  NOT the snapshot's `activeDimensionId` — that one comes off the audio engine's `_effectsMeta`,
 *  which lags the UI switch, so the monitor stayed stuck on dimension I. `dims.subscribe` forces a
 *  re-render on switch; the snapshot already carries every dimension's values, so we just re-select. */
function useMonitorRows(): Row[] | null {
  const monitor = useEngineMonitor();
  const dims = useEngineDims();
  useEngineSubscription(dims);
  const { dimensions } = useEngineSnapshot(monitor, () => monitor.getSnapshot());
  if (!dimensions.length) return null;
  const activeId = dims.active();
  const active = dimensions.find((d) => d.dimensionId === activeId) ?? dimensions[0];
  return AXIS_ORDER.flatMap((axis) =>
    (active.axes[axis] ?? []).map((r) => ({
      key: `${axis}${r.slot}`,
      label: `[${axis}${r.slot}] ${r.label ?? '—'}`,
      value: r.value === null ? '—' : r.formatted,
    })),
  );
}

/** Static metadata rows (Track / Entangled World / Orbiter). The orbiter view follows the active
 *  dimension, so the snapshot re-reads on dimension change (the `info` surface subscribes to it). */
function useTagRows(mode: InfoMode): Row[] {
  const info = useEngineInfo();
  const rows = useEngineSnapshot(info, () => info.getTags(mode), [mode]);
  return rows.map((r, i) => ({ key: `${r.label}-${i}`, label: r.label, value: r.value }));
}

function Rows({ rows, empty }: { rows: Row[]; empty: string }) {
  if (!rows.length) {
    return <p className="orbiters-react-ui__info-empty">{empty}</p>;
  }
  return (
    <dl className="orbiters-react-ui__info-rows">
      {rows.map((row) => (
        <div key={row.key} className="orbiters-react-ui__info-row">
          <dt className="orbiters-react-ui__info-row-label">{row.label}</dt>
          <dd className="orbiters-react-ui__info-row-value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MonitorView() {
  const rows = useMonitorRows();
  if (rows === null) {
    return <p className="orbiters-react-ui__info-empty">Engine monitor unavailable.</p>;
  }
  return <Rows rows={rows} empty="No effects loaded." />;
}

function InfoTagsView({ mode }: { mode: InfoMode }) {
  return <Rows rows={useTagRows(mode)} empty="No information available." />;
}

export function InfoPanel() {
  // Re-render when the header menu opens/switches/closes the panel. Per-voice store.
  const infoStore = useInfoPanelStore();
  useEngineSubscription(infoStore);
  const mode = infoStore.getMode();
  if (!mode) return null;

  return (
    <div
      className="orbiters-react-ui__info-panel"
      data-ui-interactive
      data-ui-react-region="info-panel"
      data-info-mode={mode}
      role="dialog"
      aria-label={`${getT()(MODE_LABEL_KEYS[mode])} information`}
    >
      {mode === 'monitor' ? <MonitorView /> : <InfoTagsView mode={mode} />}
    </div>
  );
}
