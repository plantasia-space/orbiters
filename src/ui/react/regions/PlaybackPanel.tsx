/**
 * @file src/ui/react/regions/PlaybackPanel.tsx
 * @description The Playback region (strategy §5) — the orbiter audio waveform +
 * loop/grid/snap/size/BPM chrome, shown when the PLAYBACK interaction panel is active.
 *
 * The whole panel is ONE design-lib React timeline kit composition ({@link KitWaveformPanel}):
 * canvas waveform + playhead + scrub/seek + zoom + loop region + the loop chrome wired to the
 * engine via the `waveformData` facade. (This replaced the imperative Peaks.js view with the
 * kit; this region is now just its host.)
 *
 * Mounted lazily on first activation — the waveform JSON isn't fetched until the Playback panel is
 * opened — and the kit owns the single playhead RAF while it is mounted.
 */
import { useActivePanel } from './useActivePanel';
import { KitWaveformPanel } from './KitWaveformPanel';

export function PlaybackPanel() {
  const active = useActivePanel()?.action === 'playback';

  return (
    <div
      className={`orbiters-react-ui__playback${active ? ' is-active' : ''}`}
      data-ui-interactive
      data-ui-react-region="playback"
      aria-hidden={!active}
    >
      {active ? <KitWaveformPanel /> : null}
    </div>
  );
}
