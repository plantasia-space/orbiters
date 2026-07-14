/**
 * @file src/input/midi/ScopedMidiMap.js
 * @description Store of persisted MIDI bindings, keyed by scope key (`orbiter:<id>`,
 * `collection:<id>` — see scopeKey.js).
 *
 * A MIDI mapping is `CC → parameter target`, owned by the persistence slice's identity — not by
 * keyboard focus and not by a single voice instance. This store holds those bindings keyed
 * by scopeKey, so:
 *   - the SAME orbiter loaded into N tiles shares ONE mapping set (map it once, every tile
 *     of that orbiter hydrates from here);
 *   - DIFFERENT slices that happen to share a leaf component key (e.g. `x.knob`) keep
 *     INDEPENDENT mappings and never cross-hydrate;
 *   - shell actions (collection studio) persist under their collection's slice with the
 *     exact same machinery as orbiter-owned parameter bindings.
 *
 * This began as the ORBITER-OWNED tier from `decisions/0001-A2-build-plan.md` (amended
 * 2026-06-29) with orbiterId keys; the key generalized to scopeKey when the collection
 * studio's shell actions gained persistence. It is deliberately a small, self-contained
 * data structure — NOT bolted into the larger `MidiMappingRegistry` — so the routing
 * subsystem keeps its unit-test surface.
 *
 * Channels are stored RUNTIME-normalized (0-based), matching `MIDIController`'s inbound
 * comparisons. The backend payload uses 1-based channels; `loadSlice` converts.
 *
 * WRITE EPOCHS: every local mutation (`setBinding`/`deleteBinding`) advances the slice's
 * epoch. A fetch snapshots `epoch(key)` when it STARTS; when the response lands, the
 * caller applies it only if the epoch is unchanged (`loadSlice(key, source, epochAtStart)`).
 * A learn that raced the fetch therefore survives — the stale response is discarded
 * instead of clobbering the just-learned binding (the in-flight save delivers it to the
 * server; local state is authoritative for that slice).
 *
 * @typedef {{ channel: number, cc: number }} MidiBinding
 * @typedef {(scopeKey: string, paramKey: string) => void} ChangeListener
 */
export class ScopedMidiMap {
  /** @type {Map<string, Map<string, MidiBinding>>} scopeKey → (paramKey → binding) */
  #bySlice = new Map();
  /** @type {Set<ChangeListener>} */
  #listeners = new Set();
  /** @type {Set<string>} scopeKeys `loadSlice` has populated — even when the backend returned
   *  zero bindings. Distinct from `#bySlice` holding an entry: `bindingsFor` creates an empty
   *  slice on demand for ANY lookup (learn, hydrate, …), so an empty `Map` there doesn't mean
   *  "already fetched". A caller deciding whether to (re-)fetch must check `hasLoaded`, not the
   *  slice's size — otherwise a genuinely-empty slice is refetched every time it's checked. */
  #loadedKeys = new Set();
  /** @type {Map<string, number>} scopeKey → write epoch (bumped on every local mutation). */
  #epochs = new Map();

  /**
   * The slice's current write epoch (0 when never written). Snapshot this before starting
   * a fetch; pass it back to `loadSlice` so a response that raced a local write is dropped.
   * @param {string|null|undefined} scopeKey
   * @returns {number}
   */
  epoch(scopeKey) {
    return (scopeKey && this.#epochs.get(scopeKey)) || 0;
  }

  /**
   * The mutable bindings map for a slice, created on demand. Hydration both READS this
   * (the candidate set for a widget) and may MIGRATE legacy keys within it, so it must be the
   * live instance, not a copy. Returns null for a falsy scopeKey (nothing to scope to).
   * @param {string|null|undefined} scopeKey
   * @returns {Map<string, MidiBinding>|null}
   */
  bindingsFor(scopeKey) {
    if (!scopeKey) {
      return null;
    }
    let map = this.#bySlice.get(scopeKey);
    if (!map) {
      map = new Map();
      this.#bySlice.set(scopeKey, map);
    }
    return map;
  }

  /**
   * Replace ONE slice's bindings from the backend payload
   * (`{ [paramId]: { cc, channel(1-based) } }`).
   * Bulk load — does NOT emit (the caller hydrates registered widgets once after loading all
   * present slices, so boot does not trigger a per-binding re-hydrate storm). Only this
   * slice is cleared; sibling slices already loaded stay intact.
   *
   * When `epochAtFetchStart` is provided and the slice was written locally since the fetch
   * began, the response is STALE and is discarded (returns false) — the local write wins.
   * @param {string|null|undefined} scopeKey
   * @param {Record<string, { cc:number, channel:number }>|null|undefined} source
   * @param {number} [epochAtFetchStart] the slice's epoch when the fetch started
   * @returns {boolean} whether the payload was applied
   */
  loadSlice(scopeKey, source, epochAtFetchStart) {
    if (!scopeKey) {
      return false;
    }
    if (epochAtFetchStart !== undefined && this.epoch(scopeKey) !== epochAtFetchStart) {
      return false;
    }
    const map = this.bindingsFor(scopeKey);
    map.clear();
    this.#loadedKeys.add(scopeKey);
    if (source && typeof source === 'object') {
      Object.entries(source).forEach(([paramId, binding]) => {
        if (!binding || typeof binding !== 'object') {
          return;
        }
        const cc = Number(binding.cc);
        if (!Number.isFinite(cc)) {
          return;
        }
        const channelRaw = Number(binding.channel);
        const channel = Number.isFinite(channelRaw) ? Math.max(0, channelRaw - 1) : 0;
        map.set(paramId, { channel, cc });
      });
    }
    return true;
  }

  /**
   * Record (or overwrite) a learned binding for a slice and notify listeners — the live
   * propagation path: map a control on one tile and every same-slice sibling re-hydrates.
   * Channel is RUNTIME 0-based here (the in-memory learn path already normalized it).
   * Advances the slice's write epoch FIRST, so an in-flight fetch that raced this write
   * lands stale and is discarded.
   * @param {string|null|undefined} scopeKey
   * @param {string|null|undefined} paramKey scoped key (`layered:<componentKey>|<stack>|<dimension>`) or bare paramId
   * @param {{ channel:number, cc:number }} binding
   */
  setBinding(scopeKey, paramKey, { channel, cc } = {}) {
    if (!scopeKey || !paramKey) {
      return;
    }
    const ch = Number(channel);
    const c = Number(cc);
    if (!Number.isFinite(ch) || !Number.isFinite(c)) {
      return;
    }
    this.#bumpEpoch(scopeKey);
    this.bindingsFor(scopeKey).set(paramKey, { channel: ch, cc: c });
    this.#emit(scopeKey, paramKey);
  }

  /**
   * Remove a binding for a slice and notify listeners (unmap propagation: every same-slice
   * sibling drops it). Emits even when the key was absent so late/uneven siblings reconcile.
   * Advances the write epoch like `setBinding` — an unmap must also beat a stale fetch.
   * @param {string|null|undefined} scopeKey
   * @param {string|null|undefined} paramKey
   * @returns {boolean} whether a binding was actually removed
   */
  deleteBinding(scopeKey, paramKey) {
    if (!scopeKey || !paramKey) {
      return false;
    }
    this.#bumpEpoch(scopeKey);
    const map = this.#bySlice.get(scopeKey);
    const removed = map ? map.delete(paramKey) : false;
    this.#emit(scopeKey, paramKey);
    return removed;
  }

  /**
   * Whether `loadSlice` has already populated this slice — including a genuinely-empty
   * result. Callers use this (not `bindingsFor(key).size`) to decide whether a fetch is still
   * needed, since a fetched-and-empty slice and a never-fetched one otherwise look identical.
   * @param {string|null|undefined} scopeKey
   * @returns {boolean}
   */
  hasLoaded(scopeKey) {
    return Boolean(scopeKey) && this.#loadedKeys.has(scopeKey);
  }

  /** @returns {boolean} whether ANY slice holds at least one binding. */
  hasAny() {
    for (const map of this.#bySlice.values()) {
      if (map.size) {
        return true;
      }
    }
    return false;
  }

  /**
   * Subscribe to per-slice binding changes (learn / unmap). The listener receives the
   * scopeKey that changed and the affected paramKey, so a consumer can re-hydrate just that
   * slice's matching widgets.
   * @param {ChangeListener} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Drop every slice's bindings (full teardown). Does not emit. Epochs survive on purpose —
   *  a fetch started before a teardown must still lose to any later local write. */
  clear() {
    this.#bySlice.clear();
    this.#loadedKeys.clear();
  }

  /** @param {string} scopeKey */
  #bumpEpoch(scopeKey) {
    this.#epochs.set(scopeKey, this.epoch(scopeKey) + 1);
  }

  /**
   * @param {string} scopeKey
   * @param {string} paramKey
   */
  #emit(scopeKey, paramKey) {
    this.#listeners.forEach((listener) => {
      try {
        listener(scopeKey, paramKey);
      } catch (error) {
        console.error('[ScopedMidiMap] change listener failed:', error);
      }
    });
  }
}
