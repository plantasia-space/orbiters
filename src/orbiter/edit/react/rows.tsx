/**
 * Thin Studio inspector rows: each is a shared-library `FieldRow` (label left in a fixed
 * column / control right) wrapping a shared-library control. The two-column GRID + label styling come
 * from the library (FieldRow), so there are no orbiters-local inline styles — only the per-control
 * binding (slider value display, colour hex parsing) lives here.
 */
import { useCallback, useState } from 'react';
import {
  FieldRow, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch, parseColorWithAlpha,
} from 'plantasia.space-design/react';
import { ValueSlider } from 'plantasia.space-design/react/arrow';

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectRow({
  label, value, options, onChange, placeholder,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const capturePortalContainer = useCallback((trigger: HTMLButtonElement | null) => {
    // Keep the listbox inside the surface that owns the resolved user-theme tokens. Portalling to
    // body requires reconstructing that token graph and breaks when a preset value references a
    // panel-scoped variable; both the desktop panel and mobile drawer already provide a safe portal
    // parent outside the scrolling inspector body.
    const next = trigger?.closest<HTMLElement>(
      '.orb-studio__panel, [data-slot="drawer-content"]',
    ) ?? null;
    setPortalContainer((current) => (current === next ? current : next));
  }, []);

  return (
    <FieldRow label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          ref={capturePortalContainer}
          className="w-full"
          aria-label={label}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent container={portalContainer}>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}

export function SliderRow({
  label, value, min, max, step, onChange, onCommit, format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  format?: (value: number) => string;
}) {
  // The shared-library `ValueSlider` owns the slider + editable-readout pairing and the on-screen
  // keypad wiring (tap the value box to type — desktop and mobile alike, the same keypad the play
  // UI uses). Both halves are bound to the same value and fire the same `onChange` (live) / commit,
  // so editing either path updates the design identically.
  return (
    <FieldRow label={label}>
      <ValueSlider
        label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        format={format}
        onValueChange={onChange}
        onValueCommit={onCommit ?? onChange}
      />
    </FieldRow>
  );
}

export function ColorRow({
  label, value, onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  // A bare native colour chip (the lib ColorControl is a label-above field — its caption would duplicate
  // the row label). Same swatch styling the lib ColorControl uses for its chip.
  const hex = parseColorWithAlpha(value).hex;
  return (
    <FieldRow label={label}>
      <input
        type="color"
        aria-label={label}
        value={hex}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-full cursor-pointer rounded-sm border bg-muted p-0.5"
      />
    </FieldRow>
  );
}

export function ToggleRow({
  label, checked, onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <FieldRow label={label}>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </FieldRow>
  );
}
