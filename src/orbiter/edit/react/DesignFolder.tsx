/**
 * The Studio "Panel" (design) content for the active dimension, in the two-column row layout
 * (labels left / controls right; see rows.tsx). Controlled + presentational: renders `design` + the
 * theme/font catalogs and fires callbacks; all mutation goes through the bridge in ReactEditPanel
 * (single source of truth). Closes gaps from the earlier floating panel: theme presets, font selector, and copy/paste.
 */
import { Button } from 'plantasia.space-design/react';
import { Copy, ClipboardPaste } from 'lucide-react';
import { SelectRow, SliderRow, ColorRow, ToggleRow, type SelectOption } from './rows';

export interface OrbiterDesign {
  colorPrimary: string;
  colorSecondary: string;
  colorC: string;
  roundedCorners: number;
  frameBorderWidth: number;
  ringEnabled: boolean;
  ringColor: string;
  ringAmplitudeMultiplier: number;
  ringRadiusMultiplier: number;
}

export interface DesignFolderProps {
  design: OrbiterDesign;
  // Labels are passed in so the real wiring can supply i18n (t('editPanel.design.*')); the harness
  // passes plain English.
  labels?: Partial<Record<keyof OrbiterDesign, string>>;
  onChange: (patch: Partial<OrbiterDesign>) => void;
  // Supplied by ReactEditPanel from the bridge (catalogs are async; absent until loaded).
  themeLabel?: string;
  themeOptions?: SelectOption[];
  themeValue?: string;
  onThemeChange?: (id: string) => void;
  fontLabel?: string;
  fontOptions?: SelectOption[];
  fontValue?: string;
  onFontChange?: (id: string) => void;
  onCopy?: () => void;
  onPaste?: () => void;
  canPaste?: boolean;
}

const DEFAULT_LABELS: Record<keyof OrbiterDesign, string> = {
  colorPrimary: 'Primary',
  colorSecondary: 'Secondary',
  colorC: 'Selected',
  roundedCorners: 'Rounded Corners',
  frameBorderWidth: 'Frame Border Width',
  ringEnabled: 'Ring Enabled',
  ringColor: 'Ring Color',
  ringAmplitudeMultiplier: 'Ring Amplitude',
  ringRadiusMultiplier: 'Ring Radius',
};

export function DesignFolder({
  design, labels, onChange,
  themeLabel, themeOptions, themeValue, onThemeChange,
  fontLabel, fontOptions, fontValue, onFontChange,
  onCopy, onPaste, canPaste,
}: DesignFolderProps) {
  const label = (key: keyof OrbiterDesign) => labels?.[key] ?? DEFAULT_LABELS[key];
  return (
    <div className="flex flex-col orb-studio__design">
      {/* Copy / Paste — icon-only buttons, right-aligned, no label; sits at the top of the Panel
          content (directly under the Panel/Engine toggle). */}
      {(onCopy || onPaste) && (
        <div className="flex justify-end gap-2 pb-2">
          {onCopy && (
            <Button variant="outline" size="icon" onClick={onCopy} aria-label="Copy" title="Copy">
              <Copy className="size-4" />
            </Button>
          )}
          {onPaste && (
            <Button variant="outline" size="icon" onClick={onPaste} disabled={!canPaste} aria-label="Paste" title="Paste">
              <ClipboardPaste className="size-4" />
            </Button>
          )}
        </div>
      )}
      {themeOptions && themeOptions.length > 0 && onThemeChange && (
        <SelectRow label={themeLabel ?? 'Theme'} value={themeValue ?? ''} options={themeOptions} onChange={onThemeChange} placeholder="Custom" />
      )}
      <ColorRow label={label('colorPrimary')} value={design.colorPrimary} onChange={(c) => onChange({ colorPrimary: c })} />
      <ColorRow label={label('colorSecondary')} value={design.colorSecondary} onChange={(c) => onChange({ colorSecondary: c })} />
      <ColorRow label={label('colorC')} value={design.colorC} onChange={(c) => onChange({ colorC: c })} />
      <SliderRow label={label('roundedCorners')} value={design.roundedCorners} min={0} max={64} step={1} onChange={(v) => onChange({ roundedCorners: v })} />
      <SliderRow label={label('frameBorderWidth')} value={design.frameBorderWidth} min={0} max={12} step={0.5} onChange={(v) => onChange({ frameBorderWidth: v })} />
      {fontOptions && fontOptions.length > 0 && onFontChange && (
        <SelectRow label={fontLabel ?? 'Font'} value={fontValue ?? ''} options={fontOptions} onChange={onFontChange} placeholder="Default" />
      )}
      <ToggleRow label={label('ringEnabled')} checked={design.ringEnabled} onChange={(v) => onChange({ ringEnabled: v })} />
      <ColorRow label={label('ringColor')} value={design.ringColor} onChange={(c) => onChange({ ringColor: c })} />
      <SliderRow label={label('ringAmplitudeMultiplier')} value={design.ringAmplitudeMultiplier} min={0} max={10} step={0.1} onChange={(v) => onChange({ ringAmplitudeMultiplier: v })} />
      <SliderRow label={label('ringRadiusMultiplier')} value={design.ringRadiusMultiplier} min={0} max={5} step={0.05} onChange={(v) => onChange({ ringRadiusMultiplier: v })} />
    </div>
  );
}
