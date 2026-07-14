// @vitest-environment jsdom
/**
 * The mobile studio sheet mounts BOTH modes (Engine / Panel) at once so it can slide between them
 * horizontally. That must NOT duplicate the panel's state: the bridge subscription, the engine-lock
 * listener, the async catalogs and the per-publish bridge rebuilds all belong to ONE owner above the
 * two bodies (`EditPanelStateProvider`), with the bodies as pure presentation off its snapshot.
 *
 * These tests mount the provider with TWO consumers — the two sheet modes — and pin that contract:
 * one of everything, no matter how many bodies are mounted.
 */
import React, { useEffect } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { EditPanelStateProvider, useEditPanelState } from '../../src/orbiter/edit/react/editPanelState';
import { setEditBridge, notifyEditBridge } from '../../src/orbiter/edit/react/editBridgeStore';
import { resolveEngine } from '../../src/sync/trackSettingsCommit.js';
import notifications from '../../src/core/AppNotifications.js';

// The engine (lock state + the buffered unlock) is the panel's only non-bridge dependency.
vi.mock('../../src/sync/trackSettingsCommit.js', () => ({ resolveEngine: vi.fn(() => null) }));
// The unlock failure toast — asserted nowhere here, just kept off the real notification stack.
vi.mock('../../src/core/AppNotifications.js', () => ({ default: { showToast: vi.fn() } }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const LOCK_EVENT = 'orbiters:speed-control-lock';

/** A minimal stand-in for the vanilla OrbitersEditPanel — counts what the panel state asks of it. */
function makeBridge() {
  return {
    design: { colorPrimary: '#fff', colorSecondary: '#000', colorC: '#111', fontId: 'f1' },
    activeDimensionId: 'd1',
    moduleRangeManager: {
      getDomain: () => ({ min: 0, max: 1 }),
      getUnits: () => null,
      createDefaultRange: () => ({ min: 0, max: 1, equilibrium: 0.5 }),
    },
    dimensionCatalog: { buildModuleOptions: vi.fn(() => ({ None: 'none' })) },
    rackManager: { handleModuleSelectionChange: vi.fn(), handleRangeChange: vi.fn() },
    _dimensionDefinitions: vi.fn(() => [{ id: 'd1', label: 'One' }, { id: 'd2', label: 'Two' }]),
    _ensureRackState: vi.fn(() => ({ dimensionId: 'd1', modules: [{ effectId: null, moduleId: null }] })),
    _handleActiveDimensionChange: vi.fn(),
    applyDesignChange: vi.fn(),
    readVisualFeedback: () => false,
    applyVisualFeedbackChange: vi.fn(),
    t: (key) => key,
    designPanel: {
      _captureDesignSnapshot: vi.fn(() => ({ colorPrimary: '#abc' })),
      _applyDesignSnapshot: vi.fn(() => true),
      _loadFontCatalogNormalized: vi.fn(() => Promise.resolve([{ id: 'f1', label: 'Font One' }])),
      _applyFontSelection: vi.fn(() => true),
      themePreset: {
        ensureCatalog: vi.fn(() => Promise.resolve([{ id: 't1', label: 'Theme One' }])),
        buildOptions: () => ({ 'Theme One': 't1' }),
        applyThemeSelection: vi.fn(() => true),
        resolveSelectionId: () => 't1',
      },
    },
  };
}

let bridge;
let root;
let container;
/** The snapshot each mounted "mode" sees, by index — the two sheet bodies read the SAME state. */
let seen;
/** How many times a body has MOUNTED — a publish must re-render the bodies, never remount them. */
let mounts;

/** Stands in for a mounted sheet mode: a consumer of the shared state, like the real (presentational) body. */
function ModeBody({ index }) {
  seen[index] = useEditPanelState();
  useEffect(() => { mounts += 1; }, []);
  return null;
}

/** Mount the provider with `count` sheet modes under it (mobile mounts 2 so it can slide; desktop 1). */
function mountModes(count) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const bodies = Array.from({ length: count }, (_, i) => React.createElement(ModeBody, { key: i, index: i }));
  act(() => {
    root.render(React.createElement(EditPanelStateProvider, null, ...bodies));
  });
}

/** Both mobile sheet modes, mounted at once — the shape this whole file is about. */
function mountBothModes() {
  mountModes(2);
}

beforeEach(() => {
  seen = [];
  mounts = 0;
  bridge = makeBridge();
  resolveEngine.mockReturnValue(null); // no engine unless a test provides one
  notifications.showToast.mockClear();
  vi.spyOn(document, 'addEventListener');
  setEditBridge(bridge);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  root = null;
  setEditBridge(null);
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('EditPanelStateProvider — one owner for the two mounted sheet modes', () => {
  it('registers ONE engine-lock listener for two mounted modes', () => {
    mountBothModes();
    const lockListeners = document.addEventListener.mock.calls.filter(([type]) => type === LOCK_EVENT);
    expect(lockListeners).toHaveLength(1);
  });

  it('loads the theme + font catalogs once, not once per mode', () => {
    mountBothModes();
    expect(bridge.designPanel.themePreset.ensureCatalog).toHaveBeenCalledTimes(1);
    expect(bridge.designPanel._loadFontCatalogNormalized).toHaveBeenCalledTimes(1);
  });

  it('costs the same bridge work with two modes mounted as with one', () => {
    // The point of the whole exercise: a publish (every knob commit / external push) must not do the
    // effect-catalog + rack rebuild once PER mounted mode. Measured as parity against the desktop
    // one-body mount rather than an absolute count — React itself may render the provider an extra
    // time on the first store change after mount, and that is true with zero bodies mounted too.
    const workPerPublish = (modeCount) => {
      bridge = makeBridge();
      setEditBridge(bridge);
      mountModes(modeCount);
      bridge.dimensionCatalog.buildModuleOptions.mockClear();
      bridge._ensureRackState.mockClear();

      act(() => notifyEditBridge());

      const work = {
        moduleOptions: bridge.dimensionCatalog.buildModuleOptions.mock.calls.length,
        rackReads: bridge._ensureRackState.mock.calls.length,
      };
      act(() => root.unmount());
      root = null;
      return work;
    };

    const oneMode = workPerPublish(1);
    const twoModes = workPerPublish(2);

    expect(twoModes).toEqual(oneMode);
    expect(oneMode.moduleOptions).toBeGreaterThan(0); // guard: we are actually measuring something
  });

  it('gives both modes the SAME snapshot (one derivation, shared)', () => {
    mountBothModes();
    expect(seen[0]).toBe(seen[1]);
  });

  it('enables Paste in BOTH modes as soon as one copies (the clipboard is shared state)', () => {
    mountBothModes();
    expect(seen[0].canPaste).toBe(false);
    expect(seen[1].canPaste).toBe(false);

    act(() => seen[0].onCopy()); // copy from the mode the user is looking at

    // The other mode is mounted but inert — it must still see the clipboard fill.
    expect(seen[0].canPaste).toBe(true);
    expect(seen[1].canPaste).toBe(true);
  });

  it('pastes the captured snapshot through the bridge', () => {
    mountBothModes();
    act(() => seen[0].onCopy());
    act(() => seen[1].onPaste()); // paste from the OTHER mode — same clipboard

    expect(bridge.designPanel._applyDesignSnapshot).toHaveBeenCalledWith({ colorPrimary: '#abc' });
    expect(bridge.applyDesignChange).toHaveBeenCalled();
  });

  it('serves no state until the bridge is published (edit mode boots after the shell)', () => {
    setEditBridge(null);
    mountBothModes();
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBeNull();
  });

  /** Start an unlock on the mounted orbiter that never settles until the returned `settle` is called. */
  function startUnlockThatHangs() {
    let settle;
    const engine = {
      requestBufferedReload: () => new Promise((resolve) => { settle = resolve; }),
      isBufferedReloadPending: () => false,
      getPlaybackStrategyInfo: () => ({ engineFeaturesBlocked: true }),
    };
    resolveEngine.mockReturnValue(engine);
    act(() => { document.dispatchEvent(new Event(LOCK_EVENT)); });
    act(() => seen[0].engineLock.onUnlock());
    return () => settle;
  }

  it('starts clean on a new orbiter published DIRECTLY over the old one', async () => {
    mountBothModes();
    const getSettle = startUnlockThatHangs(); // the user hits Load, then leaves before it lands
    expect(seen[0].engineLock.pending).toBe(true);

    // Orbiter B publishes straight over A — no intervening null (the swap path that a plain unmount
    // would NOT catch).
    const bridgeB = makeBridge();
    act(() => setEditBridge(bridgeB));

    expect(seen[0].engineLock.pending).toBe(false);
    expect(seen[0].engineLock.failed).toBe(false);
    expect(seen[0].themeOptions).toEqual([]); // B's own catalogs, not A's, while B's load is in flight
    expect(bridgeB.designPanel.themePreset.ensureCatalog).toHaveBeenCalledTimes(1);

    // A's abandoned reload settling must not write into B's panel, nor toast at B's user.
    await act(async () => { getSettle()(false); await Promise.resolve(); });
    expect(seen[0].engineLock.pending).toBe(false);
    expect(seen[0].engineLock.failed).toBe(false);
    expect(notifications.showToast).not.toHaveBeenCalled();
  });

  it('starts clean when edit mode is left and re-entered (bridge cleared, then republished)', async () => {
    mountBothModes();
    const getSettle = startUnlockThatHangs();
    expect(seen[0].engineLock.pending).toBe(true);

    const bridgeB = makeBridge();
    act(() => setEditBridge(null)); // dispose
    act(() => setEditBridge(bridgeB));

    expect(seen[0].engineLock.pending).toBe(false);
    expect(bridgeB.designPanel.themePreset.ensureCatalog).toHaveBeenCalledTimes(1);

    await act(async () => { getSettle()(false); await Promise.resolve(); });
    expect(seen[0].engineLock.pending).toBe(false);
    expect(notifications.showToast).not.toHaveBeenCalled();
  });

  it('reloads the catalogs when the SAME panel is republished (leave + re-enter edit mode)', async () => {
    // `_registerStudioBridge()` disposes and republishes the same panel instance, so the bridge OBJECT is
    // unchanged across the swap. The per-bridge state is still reset — so whatever refills it must key on
    // the publication, not on object identity, or the Theme/Font selects would empty and never come back.
    mountBothModes();
    await act(async () => { await Promise.resolve(); }); // let the first catalog load settle
    expect(seen[0].themeOptions).toHaveLength(1);
    bridge.designPanel.themePreset.ensureCatalog.mockClear();

    // ONE tick, as `_registerStudioBridge()` does it: React batches, so it never renders the null in
    // between — it just sees the same bridge object it already had. Only the epoch tells it apart.
    act(() => {
      setEditBridge(null);     // dispose()
      setEditBridge(bridge);   // …and republish THE SAME object
    });

    expect(bridge.designPanel.themePreset.ensureCatalog).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
    expect(seen[0].themeOptions).toHaveLength(1); // back, not stuck empty
  });

  it('does NOT remount the studio below it — a publish must not reset the shell (mode, drawer, scroll)', () => {
    // The provider wraps the whole studio shell. If it discarded its subtree to reset per-bridge state,
    // every publish would slam the sheet shut and forget which mode was open. Publishing (and notifying)
    // must leave the children mounted.
    mountBothModes();
    expect(mounts).toBe(2); // the two sheet modes, mounted once each

    act(() => notifyEditBridge());
    act(() => setEditBridge(makeBridge()));
    act(() => setEditBridge(null));
    act(() => setEditBridge(makeBridge()));

    expect(mounts).toBe(2); // still the same two mounted bodies — nothing was torn down
  });

  it('carries the design clipboard across an orbiter swap (copy here, paste there)', () => {
    mountBothModes();
    act(() => seen[0].onCopy());

    const bridgeB = makeBridge();
    act(() => setEditBridge(null));
    act(() => setEditBridge(bridgeB));

    expect(seen[0].canPaste).toBe(true);
    act(() => seen[0].onPaste());
    expect(bridgeB.designPanel._applyDesignSnapshot).toHaveBeenCalledWith({ colorPrimary: '#abc' });
  });

  it('drops the engine-lock listener when the studio unmounts', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    mountBothModes();
    act(() => root.unmount());
    root = null;
    expect(remove.mock.calls.filter(([type]) => type === LOCK_EVENT)).toHaveLength(1);
  });
});
