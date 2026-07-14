/**
 * The Studio "Engine" content (per-axis rack / module range controls).
 * Orbiters-exclusive (the shared library has no rack equivalent — lib-0.5.0-adoption.md keeps it local).
 * An X/Y/Z segmented Tabs rail (same pattern as the dimension + Panel/Engine rails) shows ONE axis at a
 * time; each axis renders a `ModulePicker` (icon-button Popover+Command combobox, full selected name) and
 * Min · Equil · Max as big arrow `Knob`+`Param` controls (value carries the module's unit of measurement).
 *
 * Mirrors RackPanelManager.js: 3 axes (x/y/z), MAX_MODULES=1 so ONE module slot per axis today.
 * Per slot: a module selector + min/max/equilibrium ranges bounded by the selected module's
 * manifest domain, continuous within it (see `RACK_STEP` — the vanilla rack's grid does not survive
 * the move to a knob). The seam splits live drag from commit, exactly like the
 * vanilla (`handleRangeChange(axis, index, key, value, {shouldBroadcast})` — false during a drag,
 * true on release) and `handleModuleSelectionChange(axis, index, moduleKey)`. Presentational +
 * location-agnostic: no app state, no window.__* globals, no singleton-constraint logic (that stays
 * in OrbitersEditPanel) — it only renders and fires the seam.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  EntitySearchCombobox,
  Tabs, TabsList, TabsTrigger,
  type EntitySearchResult,
} from 'plantasia.space-design/react';
import { Knob, ValueParam } from 'plantasia.space-design/react/arrow';
import { Lock, SlidersHorizontal } from 'lucide-react';
import { applyStudioChromeTheme, clearStudioChromeTheme } from '../../../ui/studioChromeTheme.js';
import { ToggleRow } from './rows';

export const AXES = ['x', 'y', 'z'] as const;
export type Axis = (typeof AXES)[number];

export type RangeKey = 'min' | 'max' | 'equilibrium';

export interface ModuleDomain {
  min: number;
  max: number;
}

/** A module catalog entry. `value` is 'none' or the composite 'effectId::moduleId'. */
export interface RackModuleOption {
  value: string;
  label: string;
  domain?: ModuleDomain | null;
}

export interface RackRange {
  min: number | null;
  max: number | null;
  equilibrium: number | null;
}

export interface RackSlot {
  moduleKey: string;          // 'none' | 'effectId::moduleId'
  range: RackRange;
  domain: ModuleDomain | null; // bounds for the range knobs; null when no module selected
  units?: string | null;       // unit of measurement from the module manifest (e.g. '%', 'Hz'); null = unitless
  defaults?: RackRange | null; // module's DESIGNED min/equil/max — the knob double-click reset target
}

export interface AxisRack {
  axis: Axis;
  slot: RackSlot;             // one slot today (MAX_MODULES=1)
  // Does this module answer in the world? A visual choice only — the sound is the same either
  // way, and turning it off means the module's visual is never built (not built and hidden).
  // NULL when the module has no visual bound to it: there is nothing to switch, so no switch.
  visualFeedback: boolean | null;
}

/** Voice-level engine-feature lock: modules needing a buffered engine while the track streams.
 *  Presentational — state, the unlock call, and the translated labels all come from the wiring layer. */
export interface RackEngineLock {
  blocked: boolean;        // engine-requiring modules are configured but can't run (streaming)
  pending: boolean;        // buffered reload in flight
  failed: boolean;         // last reload attempt failed
  onUnlock: () => void;
  labels: { notice: string; load: string; loading: string; retry: string };
}

export interface RackFolderProps {
  axes: AxisRack[];                  // [x, y, z]
  /** Which dimension these racks belong to. Part of a knob's identity: the same axis and module on the
   *  next dimension is a DIFFERENT control, and must not inherit an uncommitted draft from this one. */
  dimensionId: string;
  moduleOptions: RackModuleOption[]; // shared catalog incl. the 'none' entry
  onModuleChange: (axis: Axis, index: number, moduleKey: string) => void;
  onRangeChange: (
    axis: Axis,
    index: number,
    key: RangeKey,
    value: number,
    opts: { shouldBroadcast: boolean },
  ) => void;
  onVisualFeedbackChange: (axis: Axis, enabled: boolean) => void;
  engineLock?: RackEngineLock | null;
}

// Order Bruna asked for: Min · Equilibrium · Max (the equilibrium sits between its bounds).
const RANGE_KEYS: { key: RangeKey; label: string }[] = [
  { key: 'min', label: 'Min' },
  { key: 'equilibrium', label: 'Equil' },
  { key: 'max', label: 'Max' },
];

/**
 * NO snap grid: the ranges are continuous.
 *
 * The vanilla rack stepped by a hundredth of the domain, and that does not survive the move to a knob.
 * Most modules run -100..100, so it was a step of TWO: odd values were simply unreachable, typing 45 in
 * the box landed on 46, and every pointer move jumped a visible notch. lil-gui got away with it because
 * its slider spread the domain across the whole track width; a knob turns the domain in ~160px, where a
 * 1/100 grid is a jump per pixel.
 *
 * A *finer* range-relative grid is not the answer either — it just moves the misalignment around (a
 * 20..20000 Hz module would snap the designed 800 Hz to 799.22). The library says so itself, in the
 * keypad: "the parameter's real step when known… NOT a range-relative step like (max-min)/N — that
 * misaligns the grid". These ranges have no natural step, so they get none.
 *
 * Zero is the library's "continuous" value everywhere it lands: the knob and box skip snapping, typed
 * and reset values stay exact, and keyboard/wheel fall back to a sensible (max-min)/100 per press.
 */
const RACK_STEP = 0;

/** Decimals in the readout. No step to take them from, so they come from how wide the domain is. */
function rackPrecision(domain: ModuleDomain): number {
  const span = Math.abs(domain.max - domain.min);
  if (span >= 1000) return 0;  // 20..20000 Hz — a tenth of a Hz is noise
  if (span >= 10) return 1;    // -100..100 % — one decimal is the finest that reads
  return 2;                    // 0..1 mixes and the like
}

/** Body-level portal target for the combobox popover. The detached node escapes the mobile drawer's
 *  transform, but must be a real chrome-theme target: copying the panel through CSS aliases leaves
 *  preset-relative tokens unresolved on mobile. */
function useChromePortalContainer(): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.createElement('div');
    el.className = 'dark orb-studio__module-portal';
    document.body.appendChild(el);
    const syncVisualViewport = () => {
      el.style.setProperty(
        '--orb-studio-visual-viewport-height',
        `${window.visualViewport?.height ?? window.innerHeight}px`,
      );
    };
    syncVisualViewport();
    window.visualViewport?.addEventListener('resize', syncVisualViewport);
    void applyStudioChromeTheme(el);
    const refreshTheme = () => void applyStudioChromeTheme(el);
    document.addEventListener('orbiters:auth-token', refreshTheme);
    setContainer(el);
    return () => {
      window.visualViewport?.removeEventListener('resize', syncVisualViewport);
      document.removeEventListener('orbiters:auth-token', refreshTheme);
      clearStudioChromeTheme(el);
      el.remove();
    };
  }, []);
  return container;
}

/** A module catalog entry as a combobox result row. Modules have no imagery, so the image frame is
 *  hidden; the meta line is not used (labels are self-explanatory). */
function toSearchResult(option: RackModuleOption): EntitySearchResult {
  return { id: option.value, title: option.label };
}

/** Module picker — the library single-select combobox (full-width trigger with the selected name,
 *  filterable list). Replaces the old icon-button + Popover pair, whose tiny trigger and popover
 *  positioning misbehaved inside the mobile bottom drawer. */
function ModulePicker({ axis, value, options, onSelect }: {
  axis: Axis;
  value: string;
  options: RackModuleOption[];
  onSelect: (moduleKey: string) => void;
}) {
  // A saved rack can reference a module missing from the catalog (renamed/retired) — keep showing
  // the raw key in the trigger instead of a misleading empty placeholder, like the legacy picker did.
  const selected = options.find((o) => o.value === value)
    ?? (value && value !== 'none' ? { value, label: value } : null);
  const portalContainer = useChromePortalContainer();
  // The 'none' entry stays in the list (it's how the vanilla rack clears a slot), and the
  // combobox's clear button maps to it too.
  const search = useMemo(() => {
    return async (query: string) => {
      const q = query.trim().toLowerCase();
      // Zero-query lists the full catalog as the "suggested" group; a query
      // filters it (the combobox renders the two groups distinctly).
      if (!q) return { suggested: options.map(toSearchResult) };
      const matches = options.filter((o) => o.label.toLowerCase().includes(q));
      return { results: matches.map(toSearchResult) };
    };
  }, [options]);
  return (
    <div className="orb-studio__module-pick">
      <EntitySearchCombobox
        search={search}
        icon={SlidersHorizontal}
        showImage={false}
        showPreview={false}
        debounceMs={0}
        value={selected && selected.value !== 'none' ? toSearchResult(selected) : null}
        onValueChange={(result) => onSelect(result?.id ?? 'none')}
        popoverContentProps={{
          // Drop UP: the trigger sits at the top of the mobile bottom drawer, so opening
          // downward covers the knobs; collisions still flip it when there's no room above.
          side: 'top',
          ...(portalContainer ? { container: portalContainer } : {}),
        }}
        labels={{
          trigger: `Select module (${axis.toUpperCase()})…`,
          searchPlaceholder: 'Filter modules…',
          empty: 'No module found.',
          suggestedHeading: 'Modules',
          resultsHeading: 'Matches',
          clear: 'Clear module',
        }}
      />
    </div>
  );
}

/** One range — a big Knob with its label above and value (with unit) below. Live drag vs commit splits
 *  exactly like before (shouldBroadcast). The value box is the shared pre-wired `ValueParam`, so tapping
 *  it opens the on-screen keypad (desktop and mobile alike).
 *
 *  ONE DRAFT drives both halves. The library `Knob` and `ValueParam` are CONTROLLED — they draw the
 *  `value` they are handed and keep nothing of their own — and the panel deliberately does not re-render
 *  mid-gesture (rebuilding the effect catalog on every pointer move was what made dragging crawl). With
 *  the bridge value as their only source they therefore sat FROZEN for the whole drag and jumped once on
 *  release. So the gesture drives this draft, and the draft draws both controls; the bridge value only
 *  re-seeds it between gestures. It is the same shape the library's own `ValueSlider` uses internally,
 *  and what `useParameter` does for the play-mode knobs. */
function RangeKnob({ axis, rangeKey, label, slot, onRangeChange }: {
  axis: Axis;
  rangeKey: RangeKey;
  label: string;
  slot: RackSlot;
  onRangeChange: RackFolderProps['onRangeChange'];
}) {
  const domain = slot.domain!;
  const { units } = slot;
  const precision = rackPrecision(domain);
  const value = slot.range[rangeKey] ?? domain.min;
  // Double-click resets the knob to the module's DESIGNED value for this range key (falls back to the
  // domain edge if the manifest defines none).
  const reset = slot.defaults?.[rangeKey] ?? (rangeKey === 'max' ? domain.max : domain.min);

  const [draft, setDraft] = useState(value);
  // Re-seed from the bridge whenever it moves on its own (commit, an external push). Mid gesture the
  // bridge value is already the one we just wrote, so this never fights the finger.
  //
  // This alone does NOT carry the knob from one slot to another: the caller mounts a fresh RangeKnob per
  // dimension + axis + module (see its `key`), because "same number, different slot" is invisible here —
  // an uncommitted draft on X's min would otherwise be shown for Y's min, and the next touch would write it.
  useEffect(() => { setDraft(value); }, [value]);

  // What is stored is what is shown. The controls are continuous, so a drag can land on -59.4372 while
  // the box (one decimal here) reads -59.4 — the readout would then quietly disagree with the value.
  // Rounding to the displayed precision at the seam keeps them the same number; the grid it implies
  // (0.1 on -100..100, 1 Hz on 20..20000) is far finer than a pixel of knob travel, so it costs nothing
  // to the feel. It is what the library's own value box does with its drag, for the same reason.
  const atDisplayedPrecision = (v: number) => Number(v.toFixed(precision));

  const live = (v: number) => {
    const next = atDisplayedPrecision(v);
    setDraft(next);
    onRangeChange(axis, 0, rangeKey, next, { shouldBroadcast: false });
  };
  const commit = (v: number) => {
    const next = atDisplayedPrecision(v);
    setDraft(next);
    onRangeChange(axis, 0, rangeKey, next, { shouldBroadcast: true });
  };
  // Append the module's unit of measurement (e.g. '20 Hz', '50 %') to the value readout.
  const format = (v: number) => {
    const n = v.toFixed(precision);
    return units ? `${n} ${units}` : n;
  };
  return (
    <div className="orb-studio__axis-range">
      <span className="orb-studio__axis-range-label">{label}</span>
      <Knob
        value={draft} defaultValue={reset ?? undefined} min={domain.min} max={domain.max} step={RACK_STEP}
        showLabel={false}
        onValueChange={live} onValueCommit={commit} aria-label={`${label} ${axis.toUpperCase()}`}
      />
      <ValueParam
        label={`${label} ${axis.toUpperCase()}`}
        value={draft} min={domain.min} max={domain.max} step={RACK_STEP} precision={precision}
        // The box resets to the same DESIGNED value the knob does — without this it would reset to the
        // domain floor instead (a 20..20000 Hz equilibrium designed at 800 would land on 20).
        defaultValue={reset ?? undefined}
        format={format}
        onValueChange={live} onValueCommit={commit}
      />
    </div>
  );
}

/**
 * Engine content — an X / Y / Z segmented rail (same pattern as the dimension + Panel/Engine rails) that
 * shows ONE axis at a time, so each axis gets room: the module's full name, big knobs, clear labels and
 * generous spacing instead of a cramped 3-across grid.
 */
export function RackFolder({
  axes, dimensionId, moduleOptions, onModuleChange, onRangeChange, onVisualFeedbackChange,
  engineLock = null,
}: RackFolderProps) {
  const [activeAxis, setActiveAxis] = useState<Axis>(axes[0]?.axis ?? 'x');
  const current = axes.find((a) => a.axis === activeAxis) ?? axes[0];
  if (!current) return null;
  const { axis, slot, visualFeedback } = current;
  return (
    <div className="orb-studio__engine">
      {/* Voice-level notice: engine-requiring modules configured while the track streams. The
          full-track load is ALWAYS offered — unlocking is the user's explicit choice, whatever the
          device; a failed load reverts to streaming and reports. Modules stay pickable (they persist
          and wake on capable devices) — only their runtime is locked here. */}
      {engineLock?.blocked ? (
        <div className="orb-studio__engine-lock text-xs text-muted-foreground flex items-center gap-2">
          <Lock size={14} strokeWidth={1.5} aria-hidden />
          <span className="flex-1">{engineLock.labels.notice}</span>
          <Button size="sm" variant="outline" onClick={engineLock.onUnlock} disabled={engineLock.pending}>
            {engineLock.pending
              ? engineLock.labels.loading
              : engineLock.failed
                ? engineLock.labels.retry
                : engineLock.labels.load}
          </Button>
        </div>
      ) : null}
      {/* X / Y / Z axis rail — one axis shown at a time. */}
      <Tabs variant="segmented" value={axis} onValueChange={(v) => { if (v) setActiveAxis(v as Axis); }}>
        <TabsList className="w-full" style={{ gap: 2 }}>
          {axes.map((a) => (
            <TabsTrigger
              key={a.axis}
              value={a.axis}
              className="flex-1 items-center justify-center font-medium"
              style={{ paddingInline: 4, paddingBlock: 6, fontSize: 15 }}
            >
              {a.axis.toUpperCase()}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Module — icon-button combobox + the full selected name. */}
      <ModulePicker
        axis={axis}
        value={slot.moduleKey}
        options={moduleOptions}
        onSelect={(v) => onModuleChange(axis, 0, v)}
      />

      {/* Min · Equil · Max — big knobs, generous spacing — then the module's visual switch. Both
          belong to the SELECTED module: an empty slot has nothing to range and nothing to answer
          with, so it shows the hint alone. */}
      {slot.domain ? (
        <>
          <div className="orb-studio__axis-ranges">
            {RANGE_KEYS.map(({ key, label }) => (
              // Keyed by the WHOLE SLOT, not just the range key: each knob holds an uncommitted draft,
              // and the dimension tabs + axis rail swap the slot under the same three elements. Keyed on
              // the range key alone, an in-flight min on X would be reused for Y (or for the same axis on
              // the next dimension) — and since the re-seed can only notice a different NUMBER, an
              // identical value on the other side would leave the old draft on screen and write it back
              // on the next touch. A different slot gets a different knob.
              <RangeKnob
                key={`${dimensionId}:${axis}:${slot.moduleKey}:${key}`}
                axis={axis} rangeKey={key} label={label} slot={slot} onRangeChange={onRangeChange}
              />
            ))}
          </div>
          {/* Does this module answer in the world? One switch per module — the sound is untouched
              either way, and a module switched off builds no visual at all when the orbiter loads.
              Shown only for the modules that HAVE a visual; the rest have nothing to switch. */}
          {visualFeedback !== null ? (
            <ToggleRow
              label="Visual feedback"
              checked={visualFeedback}
              onChange={(enabled) => onVisualFeedbackChange(axis, enabled)}
            />
          ) : null}
        </>
      ) : (
        <p className="orb-studio__axis-empty text-xs text-muted-foreground">Pick a module to set its range.</p>
      )}
    </div>
  );
}
