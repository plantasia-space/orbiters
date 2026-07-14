/**
 * The Orbiter Studio edit panel BODY — presentation only.
 *
 * LAYOUT: dimension TABS (I / II / III) across the top, then a Panel/Engine view toggle
 * (circle-gauge / cog), then the content for the selected dimension + view — Panel → DesignFolder,
 * Engine → RackFolder (X/Y/Z). The leaf folders are reused from the earlier floating-panel build;
 * only the top-level shell is the new shape.
 *
 * All bridge state lives in `editPanelState` (one subscription, one snapshot, above this body): the
 * mobile studio mounts BOTH sheet modes so they can slide horizontally, and only the DRAWING may be
 * duplicated for that — not the subscriptions, the catalogs, or the per-publish rebuilds. This body
 * reads the shared snapshot and renders it.
 */
import { Tabs, TabsList, TabsTrigger } from 'plantasia.space-design/react';
// Single import point for the library's self-contained styles — importing here styles every control.
import 'plantasia.space-design/styles.css';
import { Cog, CircleGauge } from 'lucide-react';
import { DesignFolder } from './DesignFolder';
import { RackFolder } from './RackFolder';
import { useEditPanelState } from './editPanelState';

// Compact roman labels for the dimension tabs (I / II / III …), matching the play-UI DimensionSelector.
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

export type PanelMode = 'panel' | 'engine';

/**
 * The Panel/Engine view modes — the ONE source for their order, icon, and i18n label key. Both the
 * desktop in-panel toggle (below) AND the mobile shell bottom bar (StudioShell) render from this, so
 * they can't drift (one owner, per the orbiters engineering rules).
 */
export const PANEL_MODES: ReadonlyArray<{
  key: PanelMode;
  Icon: typeof CircleGauge;
  labelKey: string;
}> = [
  // Engine first: it is the primary editing surface; Panel (design/chrome) is secondary.
  { key: 'engine', Icon: Cog, labelKey: 'editPanel.folders.engine' },
  { key: 'panel', Icon: CircleGauge, labelKey: 'editPanel.design.folderTitle' },
];

export interface ReactEditPanelProps {
  /** Panel vs Engine view — OWNED by StudioShell (desktop in-panel toggle + mobile bar share it). */
  mode: PanelMode;
  onModeChange: (mode: PanelMode) => void;
  /** Desktop renders the in-panel Panel/Engine toggle; mobile hides it (the bottom bar is the toggle). */
  showModeToggle: boolean;
}

export function ReactEditPanel({ mode, onModeChange, showModeToggle }: ReactEditPanelProps) {
  const state = useEditPanelState();
  // Nothing to draw until the vanilla edit panel publishes its bridge (edit mode boots after the shell).
  if (!state) return null;
  const { t, dimensions, activeDimension } = state;

  return (
    <div className="flex flex-col gap-3">
      {/* Dimension tabs — I / II / III across the top, one per dimension. Same segmented rail as the
          Panel/Engine toggle below (filled active item + brand corner brackets), just with the roman
          numeral centered instead of an icon-over-label. */}
      <Tabs variant="segmented" value={activeDimension} onValueChange={state.onDimension}>
        <TabsList className="w-full" style={{ gap: 2 }}>
          {dimensions.map((d, i) => (
            <TabsTrigger
              key={d.id}
              value={d.id}
              className="flex-1 items-center justify-center font-medium"
              style={{ paddingInline: 4, paddingBlock: 6, fontSize: 15 }}
            >
              {ROMAN[i] ?? String(i + 1)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Panel / Engine view toggle — desktop only (mobile uses the shell's bottom bar). Segmented
          icon-over-label rail, matching the EW edit-mode folder nav (icon size-5 over a 10px label,
          active item gets the brand corner brackets). */}
      {showModeToggle && (
        <Tabs variant="segmented" value={mode} onValueChange={(v) => { if (v) onModeChange(v as PanelMode); }}>
          <TabsList className="w-full" style={{ gap: 2 }}>
            {PANEL_MODES.map(({ key, Icon, labelKey }) => {
              const label = t(labelKey);
              return (
                <TabsTrigger
                  key={key}
                  value={key}
                  aria-label={label}
                  className="flex-1 flex-col items-center font-medium"
                  style={{ gap: 4, paddingInline: 4, paddingBlock: 6, fontSize: 10 }}
                >
                  <Icon className="size-5" />
                  {label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      )}

      {/* Content for the selected dimension + selected view. */}
      {mode === 'panel' ? (
        <DesignFolder
          design={state.design}
          labels={state.designLabels}
          themeLabel={t('editPanel.design.themePreset')}
          fontLabel={t('editPanel.design.fontFamily')}
          onChange={state.onDesign}
          themeOptions={state.themeOptions}
          themeValue={state.themeValue}
          onThemeChange={state.onThemeChange}
          fontOptions={state.fontOptions}
          fontValue={state.fontValue}
          onFontChange={state.onFontChange}
          onCopy={state.onCopy}
          onPaste={state.onPaste}
          canPaste={state.canPaste}
        />
      ) : (
        <RackFolder
          axes={state.axes}
          dimensionId={activeDimension}
          moduleOptions={state.moduleOptions}
          onModuleChange={state.onModuleChange}
          onRangeChange={state.onRangeChange}
          onVisualFeedbackChange={state.onVisualFeedbackChange}
          engineLock={state.engineLock}
        />
      )}
    </div>
  );
}
