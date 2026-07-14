/**
 * @file src/voice/VoiceRegistry.js
 * @description The keystone single source of "which orbiter voices exist and which one is
 * focused". For multi-orbiter views (hybrid collection, feed), N orbiters run in ONE iframe; this
 * registry is a realm-scoped module singleton (`voiceRegistry`, exported below) that holds one
 * VoiceContext per orbiter keyed by id and tracks the single active (focused) voice. The
 * `MultiOrbiterAudioHost` registers ITS voices into this same realm registry when that boot lands.
 *
 * It replaces — it does NOT mirror — the old single-orbiter globals (`window.audioEngine`,
 * `currentOrbiter`, `Constants.TRACK_ID/TRACK_DATA`, the manager singletons). The A2 migration moves
 * each consumer onto this registry ATOMICALLY (old global deleted in the same change, no compatibility
 * bridge left behind), so the old way and the new way never live side by side.
 *
 * Two-tier consumption (see `decisions/0001-A2-build-plan.md`):
 *  - PER-VOICE state (audio graph, identity, visuals) → `get(id)` — each voice owns its own instances.
 *  - ACTIVE-VOICE single-focus surfaces (media keys, keyboard, MIDI-learn, camera, the engine monitor)
 *    → `getActive()` — genuinely one-at-a-time on one screen.
 *  - Realm-global state (the sync adapter, the shared clock, the keyed content caches) is NOT here by
 *    design — it is legitimately shared across voices.
 *
 * A "VoiceContext" is the per-orbiter runtime record the caller stores. The registry does not
 * constrain it at runtime; the typedef documents the fields migrated onto it so far (each A2 step
 * adds the field it moves off `window.*`). Fields are typed loosely (`*`) because each holds an
 * imperative singleton the consumers shape-guard at the read site.
 *
 * @typedef {Object} VoiceContext
 * @property {string} id the stable voice key (orbiter id; single-orbiter boot uses PRIMARY_VOICE_ID).
 * @property {*} [parameterManager] the voice's ParameterManager.
 * @property {*} [worldController] the WorldSceneController.
 * @property {*} [worldMode] the OrbiterModeController (mode/dimension owner).
 * @property {*} [panelManager] the voice's PanelManager (registered per voice; the
 *   single-focus surfaces resolve it via `getVoice().panelManager`).
 * @property {EventTarget} [eventBus] the voice's session event channel (per-voice so
 *   panel/world signals don't cross-talk between tiles; single-orbiter uses `window`).
 * @property {*} [dataManager] the DataManager (owns the live track id + config).
 * @property {*} [transportControl] the TransportControl.
 * @property {*} [audioEngine] the AudioEngineAdapter (filled after its async init).
 * @property {*} [cosmicLFOManager] the per-axis CosmicLFO manager (`{ x, y, z }`).
 * @property {*} [engineCommands] raw per-voice engine command surface used by the multi-focus
 *   broadcaster. These are manager-facing commands, not the React broadcasting wrappers.
 * @property {*} [cameraController] the CameraController (built lazily on first camera-panel use).
 * @property {*} [oscilloscope] the voice's RingOscilloscope (the canvas ring viz; A2 step 8c — was a
 *   module singleton, now one per voice, attached to the voice's scene).
 * @property {Document|Element|null} [rootEl] the voice's DOM root (`document` for single-orbiter; a
 *   per-voice subtree under A3) — voice-scoped element lookups resolve within it.
 * @property {boolean} [monitorVisible] whether this voice's Engine Monitor is shown (A2 step 8b — was a
 *   module-level flag; absent ⇒ visible by default, matching boot).
 * @property {string|null} [lastActiveDimensionId] the dimension id the Engine Monitor last cleared for,
 *   used to clear the display once on change (A2 step 8b — was a module-level flag).
 */
export class VoiceRegistry {
  #voices = new Map();
  #activeId = null;
  // Cached snapshot of `#voices.values()`, rebuilt only on register/unregister, so hot readers (the
  // 60fps render frame iterating voices) allocate nothing per frame.
  #voiceList = [];
  // Multi-focus: the SELECTION set (ids), and its cached array. `#activeId` above stays the
  // PRIMARY of the selection — every single-at-a-time surface (keyboard target, media keys, theme
  // mirror, the letter-slot highlight) keeps reading `activeId`/`getActive()` unchanged. The set is the
  // superset: in single-focus it is exactly `{activeId}` (so `isSelected` === active equality, and
  // every existing consumer behaves identically); shift-click grows it. INVARIANT: whenever voices
  // exist, the set is non-empty and contains `#activeId`.
  #selectedIds = new Set();
  #selectedList = [];
  // Subscribers notified when the FOCUSED (active) voice changes. Used to follow the focused tile:
  // the React focus marker shows corner brackets on the active tile. (Body-portalled menus
  // used to theme via a realm-level documentElement mirror keyed off this same subscription — that's
  // retired; each voice now themes its own portal container via `PortalContainerProvider`, focus-
  // independent.) In single-orbiter the only subscriber is the marker's effect, which no-ops (its
  // voiceId is null → no marker) and never fires after mount (active never changes), so behavior
  // stays byte-identical. Active changes are user-driven (a tile pointerdown) — rare, so cheap.
  #activeListeners = new Set();
  // Subscribers notified when the SELECTION set changes (shift-click add/remove, or a plain
  // click collapsing back to single). The React focus marker uses this to show brackets on EVERY
  // selected tile (not just the primary). Fired alongside the active-change notification.
  #selectionListeners = new Set();
  // Subscribers notified when the ROSTER changes (a voice registers/unregisters), so consumers
  // that mirror "which orbiters exist" stay live as orbiters open/close — e.g. the mobile sensor client's
  // A/B/C/D slots. Distinct from active/selection change, which do NOT fire on a non-first register.
  #voicesListeners = new Set();
  // Subscribers notified when a voice's AUDIO ENGINE is assigned (registration is two-phase: identity
  // now, the engine once its async init completes — and a rebuilt engine re-assigns). Engine-lifetime
  // consumers (the granular visual bridge) bind here, not at register time.
  #engineListeners = new Set();
  // The collection/studio STAGE order (stage index → voiceId | null), the desktop's canonical
  // A/B/C/D assignment. `null` when the layout is not slotted (e.g. `?multi` grid). The mobile A/B/C/D
  // slots must match this so slot B on the phone drives the same orbiter labelled B on the desktop.
  #slotOrder = null;

  /**
   * Register (or replace) a voice. The FIRST voice registered becomes active, so single-orbiter mode
   * — which registers exactly one voice — has a correct active voice with no extra wiring.
   * @param {string} id orbiter id (the stable key).
   * @param {VoiceContext} context the VoiceContext record.
   * @returns {VoiceContext} the stored context.
   */
  register(id, context) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('VoiceRegistry.register: id must be a non-empty string');
    }
    this.#voices.set(id, context);
    this.#voiceList = [...this.#voices.values()];
    if (this.#activeId === null) {
      this.#activeId = id;
      this.#selectedIds = new Set([id]);
      this.#selectedList = [id];
      this.#notifyActiveChange();
      this.#notifySelectionChange();
    }
    this.#notifyVoicesChange(); // Roster grew — mirror to the mobile A/B/C/D slots
    return context;
  }

  /**
   * Remove a voice. If it was the active one, the active pointer falls back to the first remaining
   * voice (or null when none remain) — there is never a dangling active id.
   * @param {string} id
   * @returns {boolean} true if a voice was removed.
   */
  unregister(id) {
    const existed = this.#voices.delete(id);
    let activeChanged = false;
    let selectionChanged = false;
    if (this.#selectedIds.delete(id)) selectionChanged = true;
    if (this.#activeId === id) {
      // Primary fell out: prefer a still-selected sibling, else the first remaining voice, else null.
      const nextSelected = this.#selectedIds.values().next();
      const nextVoice = this.#voices.keys().next();
      this.#activeId = !nextSelected.done
        ? nextSelected.value
        : nextVoice.done
          ? null
          : nextVoice.value;
      activeChanged = true;
    }
    // Re-establish the invariant (voices exist ⇒ selection non-empty and contains the primary). If the
    // set emptied but a primary remains, collapse selection to just the primary.
    if (this.#activeId !== null && !this.#selectedIds.has(this.#activeId)) {
      this.#selectedIds.add(this.#activeId);
      selectionChanged = true;
    }
    if (existed) this.#voiceList = [...this.#voices.values()];
    if (selectionChanged) this.#selectedList = [...this.#selectedIds];
    if (activeChanged) this.#notifyActiveChange();
    if (selectionChanged) this.#notifySelectionChange();
    if (existed) this.#notifyVoicesChange(); // Roster shrank — mirror to the mobile A/B/C/D slots
    return existed;
  }

  /** @param {string} id @returns {VoiceContext | null} the voice's context, or null. */
  get(id) {
    return this.#voices.get(id) ?? null;
  }

  /** @param {string} id @returns {boolean} */
  has(id) {
    return this.#voices.has(id);
  }

  /**
   * @returns {VoiceContext[]} the registered contexts (registration order). This is the registry's
   * CACHED list, rebuilt only on register/unregister — treat it as READ-ONLY (do not mutate) so hot
   * callers like the render frame allocate nothing per frame.
   */
  all() {
    return this.#voiceList;
  }

  /** @returns {number} how many voices are registered. */
  get size() {
    return this.#voices.size;
  }

  /** @returns {string | null} the active (focused) voice id. */
  get activeId() {
    return this.#activeId;
  }

  /**
   * Focus a voice (drives the single-at-a-time surfaces). Must be a registered id.
   * @param {string} id
   * @returns {VoiceContext} the now-active context.
   */
  setActive(id) {
    if (!this.#voices.has(id)) {
      throw new Error(`VoiceRegistry.setActive: no voice registered for "${id}"`);
    }
    this.#activeId = id;
    // A plain focus COLLAPSES any multi-selection back to this single tile — this is the "single-click
    // returns to single-focus" path. In single-focus this is a no-op set rebuild.
    const wasMulti = this.#selectedIds.size > 1 || !this.#selectedIds.has(id);
    this.#selectedIds = new Set([id]);
    this.#selectedList = [id];
    // Notify on EVERY explicit selection (even a re-select of the already-active tile): selection is
    // a user pointerdown, and downstream subscribers (the focus marker) key off it directly.
    this.#notifyActiveChange();
    if (wasMulti) this.#notifySelectionChange();
    return this.#voices.get(id);
  }

  /**
   * Multi-focus: toggle a voice's membership in the selection (shift-click). Adding a voice
   * makes it the new PRIMARY (so the letter highlight follows the last-touched tile); removing the
   * primary hands primary to another selected voice. Shift-toggling the only selected
   * voice is a no-op (there is always at least one focused voice). Must be a registered id.
   * @param {string} id
   * @returns {VoiceContext} the voice's context.
   */
  toggleSelection(id) {
    if (!this.#voices.has(id)) {
      throw new Error(`VoiceRegistry.toggleSelection: no voice registered for "${id}"`);
    }
    let activeChanged = false;
    if (this.#selectedIds.has(id)) {
      if (this.#selectedIds.size === 1) return this.#voices.get(id); // keep the sole focus
      this.#selectedIds.delete(id);
      if (this.#activeId === id) {
        this.#activeId = this.#selectedIds.values().next().value;
        activeChanged = true;
      }
    } else {
      this.#selectedIds.add(id);
      this.#activeId = id; // the newly added tile becomes primary
      activeChanged = true;
    }
    this.#selectedList = [...this.#selectedIds];
    if (activeChanged) this.#notifyActiveChange();
    this.#notifySelectionChange();
    return this.#voices.get(id);
  }

  /** @param {string} id @returns {boolean} whether the voice is in the current selection. */
  isSelected(id) {
    return this.#selectedIds.has(id);
  }

  /**
   * @returns {string[]} the selected voice ids (the CACHED array — rebuilt only on selection change;
   * treat as READ-ONLY). In single-focus this is `[activeId]`.
   */
  getSelection() {
    return this.#selectedList;
  }

  /**
   * Add a voice to the selection WITHOUT changing the primary. Unlike {@link toggleSelection} (a user
   * shift-click, which repoints the primary to the newly-added tile), this is for PROGRAMMATIC growth —
   * a layout grow that extends a full selection onto the new stages must not steal focus from the tile
   * the user was on. Idempotent; only notifies selection listeners (never active-change). Must be a
   * registered id.
   * @param {string} id
   * @returns {VoiceContext} the voice's context.
   */
  addToSelection(id) {
    if (!this.#voices.has(id)) {
      throw new Error(`VoiceRegistry.addToSelection: no voice registered for "${id}"`);
    }
    if (!this.#selectedIds.has(id)) {
      this.#selectedIds.add(id);
      this.#selectedList = [...this.#selectedIds];
      this.#notifySelectionChange();
    }
    return this.#voices.get(id);
  }

  /**
   * @returns {string[]} the voices a focus-scoped action should target. Multi-selection returns the
   * selected ids; single-focus returns the active id. Empty registry returns [].
   */
  getFocusTargets() {
    if (this.#selectedIds.size > 1) return this.#selectedList;
    return this.#activeId === null ? [] : [this.#activeId];
  }

  /** @returns {number} how many voices are selected (≥1 while any voice exists). */
  get selectionSize() {
    return this.#selectedIds.size;
  }

  /**
   * Subscribe to SELECTION-set changes. The callback receives the selected-id array. Returns
   * an unsubscribe. The React focus marker uses this to bracket every selected tile.
   * @param {(selectedIds: string[]) => void} listener
   * @returns {() => void} unsubscribe
   */
  onSelectionChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#selectionListeners.add(listener);
    return () => {
      this.#selectionListeners.delete(listener);
    };
  }

  #notifySelectionChange() {
    if (this.#selectionListeners.size === 0) return;
    for (const listener of this.#selectionListeners) {
      try {
        listener(this.#selectedList);
      } catch (error) {
        console.warn('[voiceRegistry] selection-change listener failed', error);
      }
    }
  }

  /**
   * Subscribe to FOCUSED-voice changes. The callback receives the active voice id (or null
   * when none remain). Returns an unsubscribe. Used to follow the focused tile: the multi-orbiter shell
   * for portal theming, and the React focus marker (corner brackets). Single-orbiter never subscribes.
   * @param {(activeId: string | null) => void} listener
   * @returns {() => void} unsubscribe
   */
  onActiveChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#activeListeners.add(listener);
    return () => {
      this.#activeListeners.delete(listener);
    };
  }

  #notifyActiveChange() {
    if (this.#activeListeners.size === 0) return;
    for (const listener of this.#activeListeners) {
      try {
        listener(this.#activeId);
      } catch (error) {
        console.warn('[voiceRegistry] active-change listener failed', error);
      }
    }
  }

  /**
   * Subscribe to ROSTER changes — fired on every register/unregister (a voice opening or
   * closing), unlike active/selection change. The callback receives the current voice list. Returns an
   * unsubscribe. Used by the mobile sensor client bridge to keep its A/B/C/D orbiter slots in sync.
   * @param {(voices: VoiceContext[]) => void} listener
   * @returns {() => void} unsubscribe
   */
  onVoicesChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#voicesListeners.add(listener);
    return () => {
      this.#voicesListeners.delete(listener);
    };
  }

  #notifyVoicesChange() {
    if (this.#voicesListeners.size === 0) return;
    for (const listener of this.#voicesListeners) {
      try {
        listener(this.#voiceList);
      } catch (error) {
        console.warn('[voiceRegistry] voices-change listener failed', error);
      }
    }
  }

  /**
   * Publish the collection/studio STAGE order (stage index → voiceId | null) — the desktop's
   * canonical A/B/C/D assignment. The mobile A/B/C/D picker reads this so its slot letters match the
   * desktop's. Pass `null` to clear (non-slotted layouts). Fires a roster-change so consumers re-read.
   * @param {Array<string|null>|null} order
   */
  setSlotOrder(order) {
    this.#slotOrder = Array.isArray(order) ? order.slice() : null;
    this.#notifyVoicesChange();
  }

  /** @returns {Array<string|null>|null} the stage order (stage index → voiceId), or null when unslotted. */
  getSlotOrder() {
    return this.#slotOrder;
  }

  /**
   * The one write path for a voice's audio engine — registration is two-phase (identity at boot,
   * the engine once its async init completes), and the assignment moment is load-bearing: it is
   * where the adapter identity is settled on the entry, so engine-lifetime observers
   * ({@link onAudioEngineAssigned}) fire here. A rebuilt engine (fresh adapter) re-assigns and
   * re-notifies. Must be a registered id.
   * @param {string} id
   * @param {*} engine the voice's AudioEngineAdapter.
   * @returns {VoiceContext} the voice's context.
   */
  assignAudioEngine(id, engine) {
    const context = this.#voices.get(id);
    if (!context) {
      throw new Error(`VoiceRegistry.assignAudioEngine: no voice registered for "${id}"`);
    }
    context.audioEngine = engine;
    if (this.#engineListeners.size > 0) {
      for (const listener of this.#engineListeners) {
        try {
          listener(context);
        } catch (error) {
          console.warn('[voiceRegistry] engine-assigned listener failed', error);
        }
      }
    }
    return context;
  }

  /**
   * Subscribe to audio-engine assignment ({@link assignAudioEngine}). The callback receives the
   * voice's context (its `audioEngine` already set) — fired for EVERY voice's assignment, so a
   * per-voice consumer filters by `context.id`. Returns an unsubscribe.
   * @param {(context: VoiceContext) => void} listener
   * @returns {() => void} unsubscribe
   */
  onAudioEngineAssigned(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#engineListeners.add(listener);
    return () => {
      this.#engineListeners.delete(listener);
    };
  }

  /** @returns {VoiceContext | null} the active voice's context, or null when there are no voices. */
  getActive() {
    return this.#activeId === null ? null : (this.#voices.get(this.#activeId) ?? null);
  }

  /** Drop every voice (e.g. on full teardown). */
  clear() {
    this.#voices.clear();
    this.#activeId = null;
    this.#voiceList = [];
    this.#selectedIds.clear();
    this.#selectedList = [];
    this.#slotOrder = null;
  }
}

/**
 * The realm's single voice registry. There is exactly ONE per browsing context — it HOLDS every
 * voice (keyed by id), so it is itself a module singleton: the realm-global replacement for the old
 * per-concept `window.*` engine slots (`window.audioEngine`, `window.__orbitersWorldMode`, …) that
 * collided when more than one orbiter shared a realm. The single-orbiter boot registers exactly one
 * voice into it, and every reader (keyboard, media, monitor, the React engine context) resolves the
 * focused voice via `getActive()` — one registry, one active-voice notion. The multi-orbiter
 * composition owner (`MultiOrbiterAudioHost`, A3) will register ITS voices into this same realm
 * registry when that boot path lands.
 */
export const voiceRegistry = new VoiceRegistry();

/**
 * The id the single-orbiter boot registers its one voice under. The key is bookkeeping only in
 * single-orbiter mode — there is exactly one, always-active voice, and every reader resolves it via
 * `voiceRegistry.getActive()`, not `get(id)`. The multi-orbiter boot (A3) registers each voice under
 * its real orbiter id from the host roster.
 */
export const PRIMARY_VOICE_ID = 'primary';
