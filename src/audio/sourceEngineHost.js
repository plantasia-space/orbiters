/**
 * @file audio/sourceEngineHost.js
 * @description The adapter's host for SOURCE-LEVEL engines — engines rendered
 *              either beside the dry player or inside its shared-PCM worklet
 *              (the granular engine is the first family at this seam).
 *              One engine per family id per voice — hard rule.
 *
 *              The host owns everything an engine family used to have to know
 *              about the audio graph: raw-context resolution, native source
 *              reads or worklet controls, graph connection, refcounted lifetime,
 *              and lifetime observation.
 *              A control module just acquires with a build function; visual
 *              layers observe lifetime through `peek`/`observe` and must never
 *              extend an engine's refcount.
 *
 *              One instance per AudioEngineAdapter (constructed with the
 *              adapter), so keying engines on adapter identity is structural,
 *              not a WeakMap subtlety.
 */

/**
 * @param {object} io - The hosting adapter's graph surface, as functions so
 *        every read is live (the mix bus and buffer exist only after init).
 * @param {() => BaseAudioContext|null} io.getContext raw context for engine DSP.
 * @param {() => AudioNode|null} io.getMixBus where engine output joins the dry signal.
 * @param {(outputNode: object, mixBus: object) => void} io.connect the graph edge (Tone.connect).
 * @param {() => AudioBuffer|null} io.getBuffer decoded source buffer (null while streaming).
 * @param {() => number} io.getPositionMs live playhead position.
 * @param {() => boolean} io.isPlaying live transport state.
 * @param {(level: number) => void} io.setDryLevel dry-leg level (0–1) for the wet/dry crossfade.
 * @param {() => object|null} [io.getWorkletSurface] source-worklet controls, when available.
 * @returns {{
 *   acquire(id: string, build: Function): { engine: object, release(): void }|null,
 *   rebind(): void,
 *   peek(id: string): object|null,
 *   observe(cb: (id: string, engine: object|null) => void): () => void,
 * }}
 */
export function createSourceEngineHost({
  getContext,
  getMixBus,
  connect,
  getBuffer,
  getPositionMs,
  isPlaying,
  setDryLevel,
  getWorkletSurface = () => null,
}) {
  const enginesById = new Map();
  const observers = new Set();

  function notifyObservers(id, engine) {
    observers.forEach((observer) => {
      try {
        observer(id, engine);
      } catch (_) {
        // An observer (the visual seam) must never break the audio path.
      }
    });
  }

  return {
    /**
     * Acquire the voice's engine for a family — the first acquire builds it,
     * later ones attach to the same instance, and the last release disposes it.
     * @param {string} id - The engine family (e.g. the granular engine's id).
     * @param {(io: {
     *   context: BaseAudioContext,
     *   getBuffer: Function, getPositionMs: Function, isPlaying: Function,
     *   onDryLevelChange: Function,
     * }) => object|null} build - Builds the engine from the host's construction
     *        surface on first acquire. Must return an engine exposing an
     *        `outputNode` for native rendering (or null for worklet rendering)
     *        and `dispose()`.
     * @returns {{ engine: object, release(): void }|null} null when the engine cannot be built.
     */
    acquire(id, build) {
      if (!id) return null;
      // Gate on the raw context for EVERY acquire, not just the building one —
      // attaching to an existing engine with no live context must fail the
      // same way building one does.
      const context = getContext() ?? null;
      if (!context) return null;

      let entry = enginesById.get(id) ?? null;
      if (!entry) {
        const worklet = getWorkletSurface();
        const mixBus = getMixBus() ?? null;
        if (!worklet && !mixBus) return null;
        const engine = build?.({
          context,
          getBuffer,
          getPositionMs,
          isPlaying,
          onDryLevelChange: setDryLevel,
          worklet,
        }) ?? null;
        if (!engine) return null;
        // An engine exposing a native output leg needs the bus edge NOW, even
        // when a worklet renders today: the backend can swap under a live
        // engine (see rebind), and rebind re-routes params — it never builds
        // graph edges. Refusing here beats hosting an engine whose native
        // mode would be silently unreachable.
        if (engine.outputNode) {
          if (!mixBus) {
            try { engine.dispose?.(); } catch (_) {}
            return null;
          }
          try {
            connect(engine.outputNode, mixBus);
          } catch (error) {
            console.warn(`[SourceEngineHost] Failed to connect the "${id}" engine output to the source bus.`, error);
            try {
              engine.dispose?.();
            } catch (_) {}
            return null;
          }
        }
        entry = { engine, refs: 0 };
        enginesById.set(id, entry);
        notifyObservers(id, engine);
      }

      entry.refs += 1;
      let released = false;
      return {
        engine: entry.engine,
        release: () => {
          if (released) return;
          released = true;
          entry.refs -= 1;
          if (entry.refs <= 0) {
            enginesById.delete(id);
            try {
              entry.engine.dispose?.();
            } catch (_) {}
            notifyObservers(id, null);
          }
        },
      };
    },

    /**
     * Rebind every hosted engine to the voice's CURRENT backend surface. The
     * adapter calls this after each playback swap (streaming ⇄ buffered):
     * engines outlive the backend they were built beside, and one still bound
     * to the old renderer stays silent forever — including for control
     * modules attached after the swap.
     */
    rebind() {
      const worklet = getWorkletSurface();
      enginesById.forEach((entry) => {
        try {
          entry.engine.setWorklet?.(worklet);
        } catch (_) {
          // A failed rebind must never break the playback swap itself.
        }
      });
    },

    /**
     * The family's live engine, if one exists right now — the already-exists
     * case at observer-registration time. Does not create or refcount.
     * @param {string} id
     * @returns {object|null}
     */
    peek(id) {
      return enginesById.get(id)?.engine ?? null;
    },

    /**
     * Engine-lifetime observer: `cb(id, engine)` fires when the first acquire
     * CREATES a family's engine, `cb(id, null)` when the last release disposes
     * it. For an engine that already exists at registration time, read `peek`
     * — no create event is replayed.
     * @param {(id: string, engine: object|null) => void} cb
     * @returns {() => void} unsubscribe.
     */
    observe(cb) {
      if (typeof cb !== 'function') return () => {};
      observers.add(cb);
      return () => observers.delete(cb);
    },
  };
}
