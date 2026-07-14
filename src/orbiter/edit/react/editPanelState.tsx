/**
 * The Orbiter Studio edit panel's STATE OWNER — one subscription, one snapshot, above the panel bodies.
 *
 * The mobile studio mounts BOTH sheet modes (Engine / Panel) at once so they can slide horizontally.
 * With the state inside the panel body that meant two of everything: two edit-bridge subscriptions, two
 * `orbiters:speed-control-lock` listeners, two catalog effects — and, on every bridge publish, two full
 * rebuilds of the effect catalog + rack axes, the inert mode included, on the live knob-drag path.
 *
 * So the state lives here instead: this provider holds the ONE bridge subscription and derives the ONE
 * snapshot both bodies render from (`ReactEditPanel` is presentational — it reads this and draws). Only
 * presentation is duplicated for the slide, which is all the slide needs. It also sits ABOVE the shell's
 * `mode`, so switching modes no longer re-reads the bridge at all.
 *
 * The React controls are an alternative event source into the SAME handlers the lil-gui controls call
 * (no logic duplicated): dimension → `_handleActiveDimensionChange`, design → `applyDesignChange`,
 * rack → `rackManager.handleModuleSelectionChange/handleRangeChange` — so onDesignChange / onStacksChange
 * / onRackChange / onAnyChange (and thus the autosave) fire identically. `refresh` is the edit-bridge
 * notify, so external pushes (setDesign / updateStacksConfig) reflect immediately.
 */
import {
  createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode,
} from 'react';
import type { SelectOption } from './rows';
import type { OrbiterDesign } from './DesignFolder';
import type { AxisRack, RackModuleOption, Axis, RangeKey, RackEngineLock } from './RackFolder';
import {
  getEditBridge, getEditBridgeVersion, getEditBridgeEpoch, subscribeEditBridge, notifyEditBridge,
} from './editBridgeStore';
import { effectVisualGroupOf } from '../../../visual/effectVisualPolicy.js';
import { resolveEngine } from '../../../sync/trackSettingsCommit.js';
import notifications from '../../../core/AppNotifications.js';

const AXES: Axis[] = ['x', 'y', 'z'];
// Radix Select needs a non-empty string value; the catalog's "none" dimension has a null id.
const NULL_DIMENSION = '__none__';
const fromDimValue = (value: string): string | null => (value === NULL_DIMENSION ? null : value);

const CUSTOM_THEME_VALUE = '__custom__';

/** Build SelectRow options from `themePreset.buildOptions` (which returns a `{ label: value }` map). */
function toOptions(map: Record<string, string>): SelectOption[] {
  return Object.entries(map).map(([label, value]) => ({ value, label }));
}

interface ModuleState {
  effectId: string | null;
  moduleId: string | null;
  range?: { min: number | null; max: number | null; equilibrium: number | null };
}

/**
 * The slice of OrbitersEditPanel this panel reads from and drives. Declared structurally so
 * the .tsx stays strict-typed against the untyped .js panel (which is passed in as `this`).
 */
export interface EditPanelBridge {
  design: OrbiterDesign & Record<string, unknown>;
  activeDimensionId: string | null;
  moduleRangeManager: {
    getDomain(effectId: string | null, moduleId: string | null): { min: number; max: number } | null;
    getUnits(effectId: string | null, moduleId: string | null): string | null;
    createDefaultRange(
      effectId: string | null,
      moduleId: string | null,
    ): { min: number | null; max: number | null; equilibrium: number | null };
  };
  dimensionCatalog: {
    buildModuleOptions(dimensionId: string | null, opts?: Record<string, unknown>): Record<string, string>;
  };
  rackManager: {
    handleModuleSelectionChange(axis: string, index: number, moduleKey: string): void;
    handleRangeChange(
      axis: string,
      index: number,
      key: string,
      value: number,
      opts: { shouldBroadcast: boolean },
    ): void;
  };
  _dimensionDefinitions(): Array<{ id: string | null; label: string }>;
  _ensureRackState(axis: string): { dimensionId: string | null; modules: ModuleState[] };
  _handleActiveDimensionChange(id: string | null): void;
  applyDesignChange(patch?: Partial<OrbiterDesign>): void;
  // Whether the module on this axis of the active dimension answers in the world. The panel owns
  // the read AND the write (it is the one that knows the voice and the dimension being edited).
  readVisualFeedback(axis: string): boolean;
  applyVisualFeedbackChange(axis: string, enabled: boolean): void;
  // The i18next `t` (OrbitersEditPanel.t, re-read on language change → panel re-renders via notify).
  t(key: string, opts?: Record<string, unknown>): string;
  // The DesignPanel sub-object (constructor-created, so present in studio mode). These are the
  // pure-logic design ops reused for copy/paste + font + theme; we call applyDesignChange() after to emit.
  designPanel: {
    _captureDesignSnapshot(): Record<string, unknown>;
    _applyDesignSnapshot(snapshot: Record<string, unknown>): boolean;
    _loadFontCatalogNormalized(): Promise<Array<{ id: string; label?: string; family?: string }>>;
    _applyFontSelection(fontId: string, fonts: Array<{ id: string }>): boolean;
    themePreset: {
      ensureCatalog(): Promise<Array<{ id: string; label?: string }>>;
      buildOptions(presets: Array<{ id: string; label?: string }>): Record<string, string>;
      applyThemeSelection(themeId: string, opts?: { skipControllerSync?: boolean }): boolean;
      resolveSelectionId(): string;
    };
  };
}

function readDesign(design: EditPanelBridge['design']): OrbiterDesign {
  const ringColor = typeof design.ringColor === 'string' && design.ringColor.trim()
    ? design.ringColor
    : design.colorSecondary;
  return {
    colorPrimary: design.colorPrimary,
    colorSecondary: design.colorSecondary,
    colorC: design.colorC,
    roundedCorners: design.roundedCorners,
    frameBorderWidth: design.frameBorderWidth,
    ringEnabled: design.ringEnabled,
    ringColor,
    ringAmplitudeMultiplier: design.ringAmplitudeMultiplier,
    ringRadiusMultiplier: design.ringRadiusMultiplier,
  };
}

function readAxes(bridge: EditPanelBridge): AxisRack[] {
  return AXES.map((axis) => {
    const rackState = bridge._ensureRackState(axis);
    const moduleState = rackState.modules[0] ?? { effectId: null, moduleId: null };
    const moduleKey = moduleState.effectId && moduleState.moduleId
      ? `${moduleState.effectId}::${moduleState.moduleId}`
      : 'none';
    const domain = bridge.moduleRangeManager.getDomain(moduleState.effectId, moduleState.moduleId);
    const units = bridge.moduleRangeManager.getUnits(moduleState.effectId, moduleState.moduleId);
    // The module's DESIGNED defaults (initialRange / valueRange.equilibrium / midpoint) — used as the
    // knob double-click reset target, so resetting ties to the design, not the domain min.
    const defaults = bridge.moduleRangeManager.createDefaultRange(moduleState.effectId, moduleState.moduleId);
    // Only a module that actually answers in the world gets a switch. The others have no
    // visual bound yet (and the filters never will), so offering one would promise something
    // the code doesn't do — as each new effect visual lands, its switch appears with it.
    const hasVisual = effectVisualGroupOf(moduleState.effectId) !== null;
    return {
      axis,
      visualFeedback: hasVisual ? bridge.readVisualFeedback(axis) : null,
      slot: {
        moduleKey,
        domain: domain ?? null,
        units: units ?? null,
        defaults,
        range: {
          min: moduleState.range?.min ?? null,
          max: moduleState.range?.max ?? null,
          equilibrium: moduleState.range?.equilibrium ?? null,
        },
      },
    };
  });
}

// MAX_MODULES=1 today, and per-slot exclusions only span other slots on the SAME axis — so with one
// slot per axis the option set is identical across axes for the active dimension. One shared list is
// therefore correct now. (Singleton "(in use)" label decorations are cosmetic and deferred.)
function readModuleOptions(bridge: EditPanelBridge): RackModuleOption[] {
  const map = bridge.dimensionCatalog.buildModuleOptions(bridge.activeDimensionId);
  return Object.entries(map).map(([label, value]) => ({ value, label }));
}

/** Everything the panel bodies render from — derived once per bridge publish, shared by both modes. */
export interface EditPanelState {
  t: EditPanelBridge['t'];
  design: OrbiterDesign;
  designLabels: {
    colorPrimary: string;
    colorSecondary: string;
    colorC: string;
    roundedCorners: string;
    frameBorderWidth: string;
  };
  dimensions: Array<{ id: string; label: string }>;
  activeDimension: string;
  onDimension: (value: string) => void;
  onDesign: (patch: Partial<OrbiterDesign>) => void;
  moduleOptions: RackModuleOption[];
  axes: AxisRack[];
  onModuleChange: (axis: Axis, index: number, moduleKey: string) => void;
  onRangeChange: (
    axis: Axis, index: number, key: RangeKey, value: number, opts: { shouldBroadcast: boolean },
  ) => void;
  onVisualFeedbackChange: (axis: Axis, enabled: boolean) => void;
  engineLock: RackEngineLock;
  themeOptions: SelectOption[];
  themeValue: string;
  onThemeChange: (id: string) => void;
  fontOptions: SelectOption[];
  fontValue: string;
  onFontChange: (id: string) => void;
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
}

// Null until the vanilla edit panel publishes its bridge (edit mode boots after the React shell).
const EditPanelStateContext = createContext<EditPanelState | null>(null);

/** The panel state, or null while the bridge is unpublished. */
export function useEditPanelState(): EditPanelState | null {
  return useContext(EditPanelStateContext);
}

/** The per-bridge state: everything here describes THIS orbiter, so a new bridge starts it over. */
interface BridgeState {
  engineBlocked: boolean;
  unlockPending: boolean;
  unlockFailed: boolean;
  themeOptions: SelectOption[];
  fontOptions: SelectOption[];
}

const EMPTY_BRIDGE_STATE: BridgeState = {
  engineBlocked: false,
  unlockPending: false,
  unlockFailed: false,
  themeOptions: [],
  fontOptions: [],
};

/**
 * The ONE owner of the panel state, above both mounted sheet modes.
 *
 * Everything it holds is per-BRIDGE (the engine lock and the theme/font catalogs all describe the orbiter
 * currently being edited), but the provider itself outlives any one bridge — so when a bridge is published
 * or cleared, the state starts over. It is held as a single box and reset in one assignment: an in-flight
 * unlock from the previous orbiter must not land on the next one's Load button, and its catalogs must not
 * be offered as if they were the new one's. (Keying a child on the epoch would do the same, but this
 * provider wraps the whole studio — remounting it on every publish would throw away the shell's own state:
 * which mode is open, the drawer, the scroll.)
 *
 * The design clipboard is deliberately NOT per-bridge: copying a design and pasting it into the next
 * orbiter you open is the point of it (it was a module-level box before, with the same reach).
 */
export function EditPanelStateProvider({ children }: { children: ReactNode }) {
  // Snapshot the version (bumps on publish + every external state push) so the state re-derives off the
  // live bridge even when the bridge object identity is unchanged. THE one subscription: it sits above
  // both sheet modes, so a publish does this work once, not once per mounted mode.
  useSyncExternalStore(subscribeEditBridge, getEditBridgeVersion, getEditBridgeVersion);
  const bridge = getEditBridge();
  // Which bridge this is. Unlike `version`, it moves ONLY when a bridge is published or cleared — a
  // knob commit (a plain notify) must not read as a new orbiter.
  const epoch = getEditBridgeEpoch();

  const [bridgeState, setBridgeState] = useState<BridgeState>(EMPTY_BRIDGE_STATE);
  // The full font objects: _applyFontSelection reads family / importUrl off them, not just the id.
  const fontsRef = useRef<Array<{ id: string }>>([]);
  const [stateEpoch, setStateEpoch] = useState(epoch);

  // The design clipboard: copy one dimension's design, paste it into another. Held as state (not a
  // module-level box) so BOTH mounted modes see Paste enable the moment you copy — the inert one would
  // otherwise keep a stale disabled button until something else happened to re-render it.
  const [clipboard, setClipboard] = useState<Record<string, unknown> | null>(null);

  // A new bridge (or none): drop the previous orbiter's state DURING the render that first sees it, so no
  // consumer ever draws the old orbiter's lock/catalogs against the new one. React re-runs this render
  // with the fresh state before committing anything.
  if (epoch !== stateEpoch) {
    setStateEpoch(epoch);
    setBridgeState(EMPTY_BRIDGE_STATE);
    fontsRef.current = [];
  }

  // Engine-feature lock: modules needing a buffered engine while the ACTIVE voice streams (long
  // track). The engine broadcasts every lock change on the speed-control-lock event; re-read the
  // engine's strategy info (the source of truth) rather than trusting the payload.
  // Keyed on the EPOCH, not the bridge object: re-entering edit mode disposes and republishes the SAME
  // panel instance (`_registerStudioBridge`), so an object-identity dep would not re-run — and the state
  // was just reset, leaving the lock unread and the catalogs (below) empty for good.
  useEffect(() => {
    if (!bridge) return undefined;
    const sync = () => {
      const blocked = resolveEngine()?.getPlaybackStrategyInfo?.()?.engineFeaturesBlocked === true;
      setBridgeState((prev) => (prev.engineBlocked === blocked ? prev : { ...prev, engineBlocked: blocked }));
    };
    sync();
    document.addEventListener('orbiters:speed-control-lock', sync);
    return () => document.removeEventListener('orbiters:speed-control-lock', sync);
  }, [bridge, epoch]);

  // Theme + font catalogs are async (HTTP, cached by the bridge). Load once per bridge; they stay empty
  // until resolved, or if the fetch fails (e.g. standalone without auth) — DesignFolder hides those
  // selects then.
  useEffect(() => {
    if (!bridge) return undefined;
    let alive = true;
    bridge.designPanel.themePreset.ensureCatalog()
      .then((presets) => {
        if (!alive) return;
        const options = toOptions(bridge.designPanel.themePreset.buildOptions(presets));
        setBridgeState((prev) => ({ ...prev, themeOptions: options }));
      })
      .catch(() => {});
    bridge.designPanel._loadFontCatalogNormalized()
      .then((fonts) => {
        if (!alive) return;
        fontsRef.current = fonts;
        const options = fonts.map((f) => ({ value: f.id, label: f.label ?? f.family ?? f.id }));
        setBridgeState((prev) => ({ ...prev, fontOptions: options }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [bridge, epoch]);

  // Nothing to serve until the vanilla edit panel publishes (edit mode boots after the React shell), and
  // nothing to keep once it disposes.
  if (!bridge) {
    return <EditPanelStateContext.Provider value={null}>{children}</EditPanelStateContext.Provider>;
  }

  const { engineBlocked, unlockPending, unlockFailed, themeOptions, fontOptions } = bridgeState;
  const refresh = notifyEditBridge;
  const { t } = bridge;

  const onEngineUnlock = () => {
    const engine = resolveEngine();
    if (!engine?.requestBufferedReload || engine.isBufferedReloadPending?.()) return;
    // The reload outlives the panel: if the user leaves edit mode (or opens another orbiter) while it
    // runs, its result belongs to an orbiter that is no longer on screen — neither the state nor the
    // toast may land on the one that is.
    const startedIn = epoch;
    const stillOurs = () => getEditBridgeEpoch() === startedIn;
    setBridgeState((prev) => ({ ...prev, unlockPending: true, unlockFailed: false }));
    // Must never end silent: a failed load reverts to streaming and RE-LOCKS
    // the modules (touch devices have no hover tooltip to explain dead
    // controls). Engine watchdogs guarantee settling; catch covers rejects.
    void engine.requestBufferedReload()
      .catch((error: unknown) => {
        console.warn('[EditPanel] Buffered unlock rejected:', error);
        return false;
      })
      .then((ok: boolean) => {
        if (!stillOurs()) return;
        if (!ok) {
          notifications.showToast(t('notifications.bufferedLoadFailed'), 'warning', 8000);
        }
        setBridgeState((prev) => ({ ...prev, unlockPending: false, unlockFailed: !ok }));
      });
  };

  // Dimension TABS: the real dimensions only (exclude the null "none"), labeled I / II / III by order.
  // The active dimension drives BOTH the Panel (design) and Engine (racks) content.
  const dimensions = bridge._dimensionDefinitions().filter(
    (d): d is { id: string; label: string } => d.id != null,
  );

  const state: EditPanelState = {
    t,
    design: readDesign(bridge.design),
    // i18n: reuse the existing editPanel.* keys (en/es) so labels match the legacy panel ("Color A/B",
    // "Theme Preset", "Font Family", …) and translate. Ring/copy/paste/axis/range labels are English in
    // the legacy lil-gui too, so they stay as the component defaults — no new keys needed.
    designLabels: {
      colorPrimary: t('editPanel.design.colorPrimary'),
      colorSecondary: t('editPanel.design.colorSecondary'),
      colorC: t('editPanel.design.colorC'),
      roundedCorners: t('editPanel.design.roundedCorners'),
      frameBorderWidth: t('editPanel.design.frameBorderWidth'),
    },
    dimensions,
    activeDimension: bridge.activeDimensionId ?? dimensions[0]?.id ?? '',
    onDimension: (value: string) => {
      if (!value) return;
      bridge._handleActiveDimensionChange(fromDimValue(value));
      refresh();
    },
    onDesign: (patch: Partial<OrbiterDesign>) => {
      bridge.applyDesignChange(patch);
      refresh();
    },
    moduleOptions: readModuleOptions(bridge),
    axes: readAxes(bridge),
    onModuleChange: (axis: Axis, index: number, moduleKey: string) => {
      bridge.rackManager.handleModuleSelectionChange(axis, index, moduleKey);
      refresh();
    },
    onRangeChange: (
      axis: Axis, index: number, key: RangeKey, value: number, opts: { shouldBroadcast: boolean },
    ) => {
      bridge.rackManager.handleRangeChange(axis, index, key, value, opts);
      // A live drag fires this on EVERY pointer-move (shouldBroadcast false). The full panel re-render
      // rebuilds the whole effect catalog (readModuleOptions + dimension definitions), which the value
      // change doesn't affect — so it only runs when the value COMMITS on release.
      //
      // This is only invisible because the control being dragged keeps its OWN draft and draws from that
      // (RangeKnob). It does not hold for a purely controlled control on the other end: that one would sit
      // frozen for the whole gesture and jump on release. Any new control wired here needs a draft too.
      if (opts.shouldBroadcast) refresh();
    },
    onVisualFeedbackChange: (axis: Axis, enabled: boolean) => {
      bridge.applyVisualFeedbackChange(axis, enabled);
      refresh();
    },
    engineLock: {
      blocked: engineBlocked,
      pending: unlockPending,
      failed: unlockFailed,
      onUnlock: onEngineUnlock,
      labels: {
        notice: t('editPanel.engine.lockedNotice'),
        load: t('editPanel.engine.lockedLoad'),
        loading: t('editPanel.engine.lockedLoading'),
        retry: t('editPanel.engine.lockedRetry'),
      },
    },
    themeOptions,
    themeValue: themeOptions.length
      ? bridge.designPanel.themePreset.resolveSelectionId()
      : CUSTOM_THEME_VALUE,
    onThemeChange: (id: string) => {
      if (bridge.designPanel.themePreset.applyThemeSelection(id, { skipControllerSync: true })) {
        bridge.applyDesignChange();
        refresh();
      }
    },
    fontOptions,
    fontValue: typeof bridge.design.fontId === 'string' ? bridge.design.fontId : '',
    onFontChange: (id: string) => {
      if (bridge.designPanel._applyFontSelection(id, fontsRef.current)) {
        bridge.applyDesignChange();
        refresh();
      }
    },
    onCopy: () => setClipboard(bridge.designPanel._captureDesignSnapshot()),
    onPaste: () => {
      if (clipboard && bridge.designPanel._applyDesignSnapshot(clipboard)) {
        bridge.applyDesignChange();
        refresh();
      }
    },
    canPaste: clipboard != null,
  };

  return <EditPanelStateContext.Provider value={state}>{children}</EditPanelStateContext.Provider>;
}
