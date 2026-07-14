/**
 * @file src/ui/react/studio/MultiStageStudio.tsx
 * @description The multi-stage Orbiter Studio layout (decisions/0004) — the React shell that
 * generalizes the single-orbiter Studio from ONE stage to 1–4 **resizable** stages over the shared realm,
 * with the collection **arrange UX**: a card drawer, drag-to-stage, reorder, and per-stage remove. It owns
 * REAL DOM stages whose rects the `ViewportCompositor` reads every frame (geometry for free — resizing a
 * stage re-frames its voice with no messaging, no reload). It stays voice-agnostic: it emits stage-index
 * intents (focus, subtype change, load/clear/reorder, persist) and the boot wiring (`createCollectionApp`)
 * maps them onto realm voices.
 *
 * Permission model: **viewing grants full interaction.** The drawer, drag-to-stage, rearrange, remove, and
 * reorder are available to EVERYONE (their handlers are always supplied). Persisting the arrangement is the
 * only edit-gated action, and (like root) it happens AUTOMATICALLY — there is no Save button. The count
 * switcher + resize are view controls.
 *
 * The UX mirrors root's mixed-collection (`bottom-bar` + `card-drawer` + `orbiter-grid`) but is built in
 * React (the app's UI direction) with a lightweight POINTER drag (orbiters has no dnd-kit; the same 8/16px
 * activation distances). The pure geometry lives in `multi/stageGeometry.js`; the pure arrangement math in
 * `multi/stageArrangement.js`. Active-stage corner chrome is NOT drawn here for a FILLED stage: each voice's
 * own React UI already renders its `FourCornerCard` focus frame when it is the active voice.
 *
 * Two React roots coexist per stage: THIS root renders the empty stage `content` div; the voice's own
 * `OrbitersUI` root (mounted by `makeOrbiterVoiceSession` into that div) fills it. This root never gives the
 * content div children, so the two never reconcile the same nodes — the same pattern the vanilla grid used.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, LayoutDashboard, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  BottomNavBar,
  Button,
  CornerButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FourCornerCard,
  useIsMobileNav,
} from 'plantasia.space-design/react';
import { Icon, IconProvider } from 'plantasia.space-design/icons';
import 'plantasia.space-design/styles.css';
import './MultiStageStudio.css';
// The collection shell is a SEPARATE React root (not under a mounted OrbitersUI), and collection
// mode STARTS EMPTY (no voice → orbitersUI.css not yet imported). Import it here so the `.orb-studio__
// portal-surface` chrome-token mapping (+ the `.multi-orbiter-cell` size-container rule) is present for the
// whole shell lifecycle — the portalled dock menus and the stage overlays read that mapping from mount.
import '../orbitersUI.css';
import { CardDrawer, type DrawerEntry } from './CardDrawer';
import { StationTrackCard, StationTrackCover, type StationCardEntry } from './StationTrackCard';
import { entityMeta } from './entityMeta';
import { useControlTooltipRegistration } from '../regions/useControlTooltips';
import { getT } from '../../../i18n/index.js';

// The filterable card kinds of a mixed collection, in drawer-filter order.
type EntityKind = 'track' | 'orbiter' | 'world';
const ENTITY_KINDS: EntityKind[] = ['track', 'orbiter', 'world'];

/** Classify a raw `entityType` into a filterable kind (null = unknown — never filtered out). */
function entityKindOf(entityType: string | null | undefined): EntityKind | null {
  switch (entityType) {
    case 'track':
      return 'track';
    case 'orbiter':
      return 'orbiter';
    case 'world':
    case 'entangled-world':
      return 'world';
    default:
      return null;
  }
}
import { getHerbariumBase } from '../../../utils/cdnAssets.js';
import {
  applyStudioChromeTheme,
  clearStudioChromeTheme,
  prewarmStudioChromeTheme,
  resetStudioChromeThemeCache,
} from '../../studioChromeTheme.js';

// The stage-count tab glyph — root's mixed-collection bottom bar uses the ringed-planet `OrbiterIcon`
// (the design-lib entity `Icon name="orbiter"`). A thin wrapper so it slots into the dock `CornerButton`'s
// `icon` slot. Sized to 18px to match the dock's lucide icons: CornerButton's `[&_svg]:size-[18px]` sizes a
// raw svg, but this `<Icon>` wraps its svg in a `size-4` span, so the span is set explicitly here. Bytes
// resolve from the Herbarium CDN via the `IconProvider` wrapping the studio tree.
const OrbiterGlyph = ({ className }: { className?: string }) => (
  <Icon name="orbiter" className={className} style={{ width: 18, height: 18 }} aria-hidden />
);

import {
  SLOT_LABELS,
  clampRatio,
  clampSubtype,
  defaultSubtype,
  dividersFor,
  slotStylesFor,
  snapRatio,
  LAYOUT_TRANSITION_MS,
} from '../../../multi/stageGeometry.js';

// The card rail is a horizontal carousel AND the place drag-to-load cards start, so the two gestures must
// coexist WITHOUT the browser reclaiming a touch mid-drag: a native pan-x scroll fires `pointercancel` and
// drops the card before it reaches a slot. So the cards are `touch-action: none` (see CardDrawer) — the
// browser never scrolls or cancels them — and WE own the whole gesture. On the first few px of travel we
// lock an axis: a mostly-HORIZONTAL move scrolls the rail (we drive `scrollLeft` to follow the finger); a
// mostly-VERTICAL touch — or any mouse/pen move — lifts the card out to a placeholder and, because nothing
// can cancel it, tracks the finger all the way to any slot. No long-press, no premature drop.
const DRAG_AXIS_LOCK_DISTANCE = 8;
// A double-tap / double-click on a card loads it into the ACTIVE orbiter — the reliable, device-independent
// load path that does not depend on the drag working (loading a track is the critical action; drag feel
// varies across touch hardware). Two taps on the same card within this window count as one.
const DOUBLE_TAP_MS = 320;
// Carousel fling: because we drive the rail scroll ourselves (cards are touch-action:none), a release has
// no native momentum — so we coast. On release we take the finger's scroll velocity (px/ms) and decay it
// each frame by FLING_FRICTION (per ~16ms, frame-rate independent), stopping below FLING_STOP_VELOCITY or
// at a scroll edge. Below FLING_MIN_VELOCITY a release is a gentle placement, not a flick — no coast.
const FLING_MIN_VELOCITY = 0.08; // px/ms — the flick threshold
const FLING_MAX_VELOCITY = 4; // px/ms — clamp spikes from a tiny-dt sample
const FLING_FRICTION = 0.94; // velocity retained per 16ms frame
const FLING_STOP_VELOCITY = 0.02; // px/ms — coast ends here
const FLING_VEL_SMOOTHING = 0.6; // EMA weight on the newest sample — damps a single end-of-swipe jitter
const FLING_SAMPLE_MAX_AGE = 60; // ms — if the last move is older than this at release, the finger had
                                 // stopped: don't fling (a held-then-lifted swipe should settle, not coast)

const SLOT_TRANSITION = `left ${LAYOUT_TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1), top ${LAYOUT_TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1), width ${LAYOUT_TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1), height ${LAYOUT_TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1)`;

// Mobile: a vertical stack (no resize) that is NOT user-scrollable — the scroll container is
// pointer-events:none so a swipe/drag reaches the orbiter's camera; the prev/next bar buttons move between
// orbiters via programmatic `scrollIntoView({behavior:'smooth', block:'start'})`, which gives the slide
// transition. Each stage is a FULL screen, so scrollIntoView lands exactly one orbiter per view. Ported
// from root's mobile branch (a persistent nav bar to page + toggle the cards).
const MOBILE_STAGE_HEIGHT = 'var(--viewport-max-height, 100dvh)';
// The mobile chrome IS the design-lib BottomNavBar (same component as desktop): portrait = a fixed bottom
// bar of height `--nav-mobile-bar-height`; landscape = the lib's fixed LEFT rail (w-16 = 64px), matching
// root. Stages + the drawer reserve that strip so nothing hides behind the bar.
const MOBILE_BAR_INSET = 'var(--nav-mobile-bar-height, 4rem)'; // portrait: the bottom bar's reserved strip
const MOBILE_RAIL_W = '4rem'; // landscape: the left rail's width — matches the lib rail's `w-16` (4rem)
                              // exactly regardless of root font-size (a px literal would drift under large-text)
// Mobile drawer is a FIXED reduced height (no resize): unlike desktop's resizable drawer, it REFLOWS the
// orbiter — the stage shrinks by this much while the drawer is open, so the cards and the full play area
// are both visible (never overlaid). Sized to the drawer's reduced card tier.
const MOBILE_DRAWER_H = 200; // px

export interface StudioLayoutState {
  subtype: number;
  splitY: number;
  splitXPrimary: number;
  splitXSecondary: number;
  focusedIndex: number;
}

export interface MultiStageStudioHandle {
  /** The stage `index`'s content element — the compositor's viewport cell + the voice's UI mount. */
  acquireCell: (index: number) => HTMLElement | null;
  /** Reflect the realm's focused voice onto the layout (Roman highlight). */
  setActiveIndex: (index: number) => void;
  /** Focus the stage and run the full view-navigation path (used by MIDI autofocus on mobile). */
  focusIndex: (index: number) => void;
}

export interface MultiStageStudioProps {
  /** How many front stages hold real content (fill front-to-back; the rest show an empty placeholder). */
  rosterLength: number;
  savedLayout?: Partial<StudioLayoutState> | null;
  onReady?: (handle: MultiStageStudioHandle) => void;
  onFocusStage?: (index: number, additive?: boolean, fromMidi?: boolean) => void;
  onSubtypeChange?: (next: number, prev: number) => void;
  /** Leave the collection Studio (the persistent nav's "Go back"). */
  onBack?: () => void;
  /** Cruise mode: the software loads and plays tracks one after another — Traktor-style. Absent =
   *  the control is not offered (normal playback never auto-advances). */
  cruise?: { enabled: boolean; onToggle: () => void } | null;
  /** "Load full sessions" (the drawer toolbar): when engaged, a drop replaces the deck with the
   *  card's ORIGINAL session instead of swapping only the card's own dimension. */
  loadDefaults?: { enabled: boolean; onToggle: () => void } | null;
  // Arrange UX. These are supplied to EVERYONE who can view (viewing grants full session-local
  // interaction); only Save (persist) is edit-gated.
  /** The collection's entries, listed in the drawer as draggable cards. */
  entries?: DrawerEntry[];
  /** The live per-stage occupant, keyed by the SOURCE (drawer) voiceId — so the drawer can mark the active
   *  card (a placement's realm voiceId is minted and would never match a card). Index = stage; null = empty. */
  stageVoiceIds?: (string | null)[];
  /** The live per-stage entry metadata, keyed by stage index, for per-tile artwork chrome. */
  stageEntries?: (StationCardEntry | null)[];
  /** Per-stage real orbiter id owning that stage's slot-focus MIDI target's persistence (index =
   *  stage, matching `stageVoiceIds`) — the mapping is orbiter-owned like every other MIDI
   *  mapping (the backend has no collection-scoped identity), so it lives with whichever real
   *  orbiter currently occupies THAT slot, never a shared collection-wide anchor. */
  focusMidiPersistenceIds?: (string | null)[];
  /** Source (drawer) voiceIds with an in-flight drop/load — those cards show the orbit loader
   *  until the target voice reports its load cycle finished. */
  loadingSourceIds?: string[];
  /** Drop a drawer entry onto stage `index` (replace whatever is there). */
  onLoadStage?: (index: number, entry: DrawerEntry) => void;
  /** Clear stage `index` (the per-stage remove control). */
  onClearStage?: (index: number) => void;
  /** Reorder the drawer list: move `sourceVoiceId` before `beforeVoiceId` (null = to the end). */
  onReorderEntries?: (sourceVoiceId: string, beforeVoiceId: string | null) => void;
  registerMidiTarget?: (binding: {
    id: string;
    element: HTMLElement;
    componentId: string;
    componentType: 'kick';
    scope: 'GLOBAL';
    /** The binding's persistence slice: the owning orbiter for track-focus targets, the
     *  collection for shell targets. */
    persistenceScope?: { scope: string; entityId: string } | null;
    onTrigger: () => void;
  }) => void;
  unregisterMidiTarget?: (id: string) => void;
  /** Non-null enables the shell MIDI targets (slot focus/add, pager, drawer), persisted under
   *  THIS collection — the studio's own actions, independent of what's loaded in any slot. */
  shellMidiCollectionId?: string | null;
}

const ratioOrDefault = (v: number | undefined) => (Number.isFinite(v) ? clampRatio(v as number) : 0.5);

type Ratio = 'y' | 'xPrimary' | 'xSecondary';

type PendingConfirmation = { kind: 'back' } | { kind: 'shrink'; next: number; dropped: number } | null;

/** Live `(orientation: landscape)` — reactive on rotate. Combined with `useIsMobileNav` for mobile-landscape. */
function useOrientationLandscape(): boolean {
  const [landscape, setLandscape] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(orientation: landscape)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(orientation: landscape)');
    const onChange = () => setLandscape(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return landscape;
}

export function MultiStageStudio({
  rosterLength,
  savedLayout = null,
  onReady,
  onFocusStage,
  onSubtypeChange,
  onBack,
  cruise = null,
  loadDefaults = null,
  entries,
  stageVoiceIds,
  stageEntries,
  focusMidiPersistenceIds,
  loadingSourceIds,
  onLoadStage,
  onClearStage,
  onReorderEntries,
  registerMidiTarget,
  unregisterMidiTarget,
  shellMidiCollectionId = null,
}: MultiStageStudioProps) {
  const t = getT();
  const [subtype, setSubtype] = useState(() => defaultSubtype(savedLayout, rosterLength));
  const [splitY, setSplitY] = useState(() => ratioOrDefault(savedLayout?.splitY));
  const [splitXPrimary, setSplitXPrimary] = useState(() => ratioOrDefault(savedLayout?.splitXPrimary));
  const [splitXSecondary, setSplitXSecondary] = useState(() => ratioOrDefault(savedLayout?.splitXSecondary));
  const [activeIndex, setActiveIndex] = useState(() => {
    const focused = Number.isFinite(savedLayout?.focusedIndex) ? (savedLayout!.focusedIndex as number) : 0;
    // Clamp into range: a malformed/legacy savedLayout could carry a focusedIndex past its stage count,
    // which the mobile pager (activeIndex ± 1) would otherwise strand on a non-existent stage.
    return Math.min(Math.max(0, focused), defaultSubtype(savedLayout, rosterLength) - 1);
  });
  const [resizing, setResizing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>(null);

  const gridRef = useRef<HTMLDivElement | null>(null);
  // The mobile vertical stage stack's scroll container (this component's own root). The pager scrolls IT
  // directly (below) rather than relying on `Element.scrollIntoView`, which resolves + smooth-scrolls this
  // fixed, pointer-events:none container unreliably on mobile engines.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Wire the whole studio chrome into the app-wide control-tooltips system (the flag the orbiter
  // More menu — and the drawer's own toggle — flips): every button under the studio root gets a
  // hover/tap helper from its aria-label, exactly like the orbiter play-UI controls. The studio is
  // its own React root, so it must register itself — the orbiter UI's registration can't see it.
  useControlTooltipRegistration(scrollContainerRef);
  const scrollRafRef = useRef<number | null>(null); // in-flight pager scroll-tween (cancel on retarget/unmount)
  const stageRefs = useRef<Map<number, HTMLElement>>(new Map());
  const prevSubtypeRef = useRef(subtype);
  const dragRef = useRef<{ move?: (e: PointerEvent) => void; up?: () => void }>({});

  // ── Chrome theme ─────────────────────────────────────────────────────────────────────────────────
  // The collection SHELL — dock (bottom bar) + card drawer/cards + the stage overlays (placeholders,
  // A/B/C/D badges, remove, artwork) — is CHROME: it follows the USER chrome theme from `/me/users/settings`,
  // exactly like the single-orbiter edit inspector (studioChromeTheme.js / StudioShell.tsx). It must NOT
  // touch the orbiter play UI inside each `.multi-orbiter-cell`, which keeps its own entity theme (the
  // `.orbiters-react-ui` bridge). So `applyStudioChromeTheme` writes the resolved preset tokens INLINE onto
  // the dock + drawer containers only (never a cell ancestor) and mirrors them onto <body> as
  // `--orb-studio-chrome-*`; the scattered stage overlays + portalled menus read that mirror via
  // `.orb-studio__portal-surface`. Resolve once up front (cache warm → applies synchronously, no flash).
  const chromeTargets = useRef<Set<HTMLElement>>(new Set());
  const chromeRef = useCallback((el: HTMLElement | null) => {
    if (!el) return undefined; // React 19 calls the returned cleanup on unmount, so this branch is inert
    chromeTargets.current.add(el);
    void applyStudioChromeTheme(el).catch(() => {});
    return () => {
      chromeTargets.current.delete(el);
      // `clearStudioChromeTheme` also clears the GLOBAL <body> portal mirror, so only run it once the LAST
      // chrome surface is gone — a dock/drawer swap on a breakpoint change must not strip the mirror from a
      // still-mounted sibling. An unmounting element takes its own inline vars with it, so nothing else needs
      // clearing on a non-last unmount.
      if (chromeTargets.current.size === 0) clearStudioChromeTheme(el);
    };
  }, []);
  useEffect(() => {
    prewarmStudioChromeTheme();
  }, []);
  // Embedded auth arrives AFTER mount (loaders.js dispatches `orbiters:auth-token`), so the first resolve
  // saw no settings and painted the DEFAULT preset — drop it, re-resolve the user's real preset once, and
  // re-apply to whichever chrome surfaces are currently mounted (dock + drawer).
  useEffect(() => {
    const onAuth = () => {
      resetStudioChromeThemeCache();
      chromeTargets.current.forEach((el) => void applyStudioChromeTheme(el).catch(() => {}));
    };
    document.addEventListener('orbiters:auth-token', onAuth);
    return () => document.removeEventListener('orbiters:auth-token', onAuth);
  }, []);

  // Stable ref callback per stage index — an inline `ref={el => …}` gets a new identity every render, so
  // React would detach+reattach it each time (briefly nulling the compositor's stored cell). Memoized
  // callbacks only fire on real mount/unmount.
  const stageRefCbs = useRef<Map<number, (el: HTMLElement | null) => void>>(new Map());
  const getStageRefCb = (index: number) => {
    let cb = stageRefCbs.current.get(index);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) stageRefs.current.set(index, el);
        else stageRefs.current.delete(index);
      };
      stageRefCbs.current.set(index, cb);
    }
    return cb;
  };

  // Stable per-index BLOCK refs (the scrollable mobile stage container) for prev/next scroll-into-view.
  const blockRefs = useRef<Map<number, HTMLElement>>(new Map());
  const blockRefCbs = useRef<Map<number, (el: HTMLElement | null) => void>>(new Map());
  const getBlockRefCb = (index: number) => {
    let cb = blockRefCbs.current.get(index);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) blockRefs.current.set(index, el);
        else blockRefs.current.delete(index);
      };
      blockRefCbs.current.set(index, cb);
    }
    return cb;
  };

  const isMobile = useIsMobileNav();
  const isLandscapeOrientation = useOrientationLandscape();
  const isLandscape = isMobile && isLandscapeOrientation;
  // The MIDI-learn target is the TRACK's own artwork, not the stage position — a
  // learned mapping means "select THIS track", so it's scoped to that track's own real orbiter (see
  // the registration effect below), never a slot letter. (The artwork element itself is now
  // hidden — see getFocusArtworkRefCb's render — but stays mounted as this ref target.)
  const focusArtworkRefs = useRef<Map<number, HTMLElement>>(new Map());
  const focusArtworkRefCbs = useRef<Map<number, (el: HTMLElement | null) => void>>(new Map());
  const getFocusArtworkRefCb = (index: number) => {
    let cb = focusArtworkRefCbs.current.get(index);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) focusArtworkRefs.current.set(index, el);
        else focusArtworkRefs.current.delete(index);
      };
      focusArtworkRefCbs.current.set(index, cb);
    }
    return cb;
  };

  const revealStage = (target: number | null) => {
    if (target == null) return;
    setActiveIndex(target);
    // Scroll the OWNED container to the target block (mobile pager = one full-screen stage per view). We
    // drive the container directly instead of `block.scrollIntoView({behavior:'smooth'})`: that walks the
    // ancestor chain to find a scroll port and mobile engines resolve/animate this fixed, pointer-events:
    // none container unreliably — so the selection changed but the view never moved.
    //
    // Animate the scroll OURSELVES (a small rAF tween), not with `behavior:'smooth'`. The browser-smooth
    // animation was silently dropped by mobile engines whenever the `setActiveIndex` re-render reflowed
    // mid-flight (why the slide worked only SOMETIMES; nudging the current-orbiter button "fixed" it —
    // `setActiveIndex(sameValue)` bails the re-render, so nothing aborted the scroll). We re-assert
    // `scrollTop` every frame, so a reflow can cost at most one janky frame, never the whole slide; each
    // step fires a scroll event so the compositor re-reads the cell rects and the planet slides with it.
    // Target = `offsetTop`: the block's stable absolute top within this container (its offsetParent, since
    // the root is `position:fixed`).
    const container = scrollContainerRef.current;
    const block = blockRefs.current.get(target);
    if (!container || !block) return;
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current); // retarget cleanly
    const from = container.scrollTop;
    const dist = block.offsetTop - from;
    if (dist === 0) return;
    const DURATION = 300;
    let startTs: number | null = null;
    const step = (ts: number) => {
      if (startTs == null) startTs = ts;
      const p = Math.min(1, (ts - startTs) / DURATION);
      container.scrollTop = from + dist * (1 - (1 - p) ** 3); // easeOutCubic
      scrollRafRef.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    scrollRafRef.current = requestAnimationFrame(step);
  };

  const navigateToStage = (target: number | null) => {
    if (target == null) return;
    onFocusStage?.(target);
    revealStage(target);
  };

  // A stable handle for the boot wiring. `setActiveIndex` is re-pointed each render so it always calls
  // the latest state setter without rebuilding the handle (the realm holds this reference for its life).
  const setActiveIndexRef = useRef(setActiveIndex);
  setActiveIndexRef.current = setActiveIndex;
  const handleRef = useRef<MultiStageStudioHandle>({
    acquireCell: (index: number) => stageRefs.current.get(index) ?? null,
    setActiveIndex: (index: number) => setActiveIndexRef.current(index),
    focusIndex: (index: number) => revealStage(index),
  });

  // Announce readiness ONCE the initial stages are committed (their refs are populated) so the realm can
  // boot and `acquireCell` finds real DOM — the follow-up-commit timing the portalled bar also needs.
  useEffect(() => {
    onReady?.(handleRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive the realm's roster when the visible stage count changes (after the new stage DOM is committed,
  // so a grow's added voices find their freshly-rendered stage). Never fires on mount (prev === subtype).
  useEffect(() => {
    const prev = prevSubtypeRef.current;
    if (prev !== subtype) {
      if (activeIndex >= subtype) setActiveIndex(subtype - 1); // keep focus in range on shrink
      onSubtypeChange?.(subtype, prev);
      prevSubtypeRef.current = subtype;
    }
  }, [subtype, activeIndex, onSubtypeChange]);

  // Remove any lingering resize-drag listeners / in-flight pager scroll-tween if the layout unmounts.
  useEffect(
    () => () => {
      if (dragRef.current.move) document.removeEventListener('pointermove', dragRef.current.move);
      if (dragRef.current.up) document.removeEventListener('pointerup', dragRef.current.up);
      dragRef.current = {};
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  const setRatio = useCallback((ratio: Ratio, value: number) => {
    if (ratio === 'y') setSplitY(value);
    else if (ratio === 'xPrimary') setSplitXPrimary(value);
    else setSplitXSecondary(value);
  }, []);

  const startDrag = (def: { ratio: Ratio; axis: 'x' | 'y' }) => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;
    const base = def.ratio === 'y' ? splitY : def.ratio === 'xPrimary' ? splitXPrimary : splitXSecondary;
    const start = def.axis === 'x' ? e.clientX : e.clientY;
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      const size = def.axis === 'x' ? grid.clientWidth : grid.clientHeight;
      if (!size) return;
      const cur = def.axis === 'x' ? ev.clientX : ev.clientY;
      setRatio(def.ratio, snapRatio(base + (cur - start) / size));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      dragRef.current = {};
      setResizing(false);
    };
    dragRef.current = { move: onMove, up: onUp };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // ── Arrange UX ────────────────────────────────────────────────────────────────────────────────
  // Available to EVERYONE who can view — the handlers are always supplied in collection mode. `canArrange`
  // is just a presence check for a bare (no-arrange) mount. Only Save (persist) is edit-gated.
  const allDrawerEntries = entries ?? [];
  // Entity filters (mixed collections only): the drawer's left toolbar hides card TYPES from the
  // rail — pure view state, decks and the persisted order are untouched. All types start visible;
  // a homogeneous collection offers no filters (nothing to narrow).
  const [visibleKinds, setVisibleKinds] = useState<Record<EntityKind, boolean>>({
    track: true,
    orbiter: true,
    world: true,
  });
  const presentKinds: EntityKind[] = ENTITY_KINDS.filter((kind) =>
    allDrawerEntries.some((e) => entityKindOf(e.entityType) === kind),
  );
  const mixedCollection = presentKinds.length >= 2;
  const drawerEntries = mixedCollection
    ? allDrawerEntries.filter((e) => {
        const kind = entityKindOf(e.entityType);
        return !kind || visibleKinds[kind];
      })
    : allDrawerEntries;
  const entityFilters = mixedCollection
    ? presentKinds.map((kind) => ({
        key: kind,
        icon: entityMeta(kind).icon,
        colorVar: entityMeta(kind).colorVar,
        label: entityMeta(kind).label,
        enabled: visibleKinds[kind],
        onToggle: () => setVisibleKinds((prev) => ({ ...prev, [kind]: !prev[kind] })),
      }))
    : null;
  const canArrange = Boolean(onLoadStage);
  // Show the drawer wherever arrange is available and the COLLECTION has cards — gated on the
  // unfiltered list, deliberately: filtering every kind out must leave the drawer (and its filter
  // chips) on screen with an empty rail, or there would be no way to turn the kinds back on. It
  // stays mounted when closed (collapsed to 0 height) so its resized height survives a
  // Cards-toggle. Desktop mounts it IN-FLOW (its height reflows the grid); mobile mounts it as a
  // FIXED overlay over the stage pager.
  const canShowDrawer = canArrange && allDrawerEntries.length > 0;
  const drawerMounted = !isMobile && canShowDrawer;
  // Reserve the drawer's strip only when it is actually on screen (mounted AND open) — otherwise a bare
  // mount, whose drawerOpen stays true with no Cards toggle to flip it, would strand dead space.
  const mobileDrawerShown = canShowDrawer && drawerOpen;

  // The box a mobile stage's content (the orbiter canvas OR the empty placeholder) may occupy: the visible
  // area MINUS the nav bar and — when the drawer is shown — the reduced drawer, so the orbiter shrinks to
  // make room (reflow, like desktop) and the placeholder never hides under the bar. Portrait: reserve the
  // bottom strip; landscape: reserve the left rail, and the drawer's height along the bottom. The
  // ViewportCompositor re-reads the stage rect each frame, so shrinking this box re-frames the voice.
  const mobileContentInset: CSSProperties = isLandscape
    ? { position: 'absolute', top: 0, right: 0, left: MOBILE_RAIL_W, bottom: mobileDrawerShown ? MOBILE_DRAWER_H : 0 }
    : {
        position: 'absolute',
        top: 0,
        right: 0,
        left: 0,
        bottom: mobileDrawerShown ? `calc(${MOBILE_BAR_INSET} + ${MOBILE_DRAWER_H}px)` : MOBILE_BAR_INSET,
      };

  // A lightweight pointer drag session (no dnd-kit): a card press past the activation distance starts a
  // drag; while dragging we hit-test the pointer against stage boxes (drop → load) and drawer cards
  // (drop → reorder). Refs hold the hit-test targets; a little state drives the overlay + drop hints.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const endRef = useRef<HTMLElement | null>(null);
  // The drawer's horizontal scroll container (registered by CardDrawer) — we scroll it ourselves during a
  // 'scroll' gesture, since the cards are `touch-action: none` and no longer scroll the rail natively.
  const railScrollRef = useRef<HTMLElement | null>(null);
  // In-flight carousel fling (rAF id), so a re-grab cancels the coast and unmount stops it.
  const scrollMomentumRef = useRef<number | null>(null);
  // Last card tap (voice + timestamp) for double-tap-to-load detection across two separate pointer sessions.
  const lastCardTapRef = useRef<{ voiceId: string; t: number } | null>(null);
  const cardDragRef = useRef<{
    entry: DrawerEntry;
    startX: number;
    startY: number;
    // 'pending' until the first move locks an axis, then 'scroll' (own the carousel) or 'drag' (lift the card).
    mode: 'pending' | 'scroll' | 'drag';
    isTouch: boolean;
    startScrollLeft: number; // the rail's scrollLeft when a 'scroll' gesture began (finger-follow origin)
    lastScrollX: number; // last pointer X during a scroll (for the release-velocity estimate)
    lastScrollT: number; // timestamp of that sample
    scrollVel: number; // scrollLeft velocity (px/ms) at the latest sample — seeds the fling
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    cancel: (e: PointerEvent) => void;
  } | null>(null);
  const [dragEntry, setDragEntry] = useState<DrawerEntry | null>(null);
  // The overlay position is driven IMPERATIVELY (a ref + direct style write) so a pointermove doesn't
  // re-render the whole studio each pixel — only the drop-hint state below changes, and only when the
  // pointer crosses a stage/card boundary (React bails out on an unchanged value).
  const dragPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [dropStage, setDropStage] = useState<number | null>(null);
  const [dropBeforeVoiceId, setDropBeforeVoiceId] = useState<string | null>(null);
  const [dropAtEnd, setDropAtEnd] = useState(false);
  // The drop target on release is read from refs (the pointerup closure would otherwise capture stale
  // state). Kept in sync with the drop-hint state every render, below.
  const dropBeforeRef = useRef<string | null>(null);
  const dropAtEndRef = useRef(false);
  dropBeforeRef.current = dropBeforeVoiceId;
  dropAtEndRef.current = dropAtEnd;

  const registerCardRef = useCallback((voiceId: string, node: HTMLElement | null) => {
    if (node) cardRefs.current.set(voiceId, node);
    else cardRefs.current.delete(voiceId);
  }, []);

  const clearDropHints = () => {
    setDropStage(null);
    setDropBeforeVoiceId(null);
    setDropAtEnd(false);
  };

  const pointInRect = (box: DOMRect | undefined, x: number, y: number): boolean =>
    !!box && x >= box.left && x < box.right && y >= box.top && y < box.bottom;

  // Which stage box (if any) contains the pointer — only front stages that can actually hold a voice.
  const stageIndexAtPoint = (x: number, y: number): number | null => {
    for (let i = 0; i < subtype; i++) {
      if (pointInRect(stageRefs.current.get(i)?.getBoundingClientRect(), x, y)) return i;
    }
    return null;
  };

  const onCardPointerDown = (entry: DrawerEntry, e: ReactPointerEvent) => {
    // A press ALWAYS stops any in-flight fling — grabbing the carousel arrests the coast (like catching a
    // spinning record). Hoisted above the guards so it fires even when a press wouldn't start a new session.
    if (scrollMomentumRef.current != null) {
      cancelAnimationFrame(scrollMomentumRef.current);
      scrollMomentumRef.current = null;
    }
    if (!canArrange || cardDragRef.current) return; // one drag at a time (ignore a second concurrent pointer)
    const isTouch = e.pointerType === 'touch';

    const teardown = () => {
      const session = cardDragRef.current;
      if (!session) return;
      document.removeEventListener('pointermove', session.move);
      document.removeEventListener('pointerup', session.up);
      document.removeEventListener('pointercancel', session.cancel);
      cardDragRef.current = null;
    };

    // Position the overlay + resolve the drop hint for a pointer location (called from pointermove once a
    // drag is armed).
    const applyDragMove = (x: number, y: number) => {
      dragPosRef.current = { x, y };
      if (overlayRef.current) {
        overlayRef.current.style.left = `${x + 12}px`;
        overlayRef.current.style.top = `${y + 12}px`;
      }
      const stage = stageIndexAtPoint(x, y);
      if (stage != null) {
        // Only a valid target shows the drop ring — a card that can't seed an empty stage (a world)
        // gets no highlight over one, so the affordance never promises a dead drop.
        setDropStage(isValidDropTarget(entry, stage) ? stage : null);
        setDropBeforeVoiceId(null);
        setDropAtEnd(false);
        return;
      }
      setDropStage(null);
      // Not over a stage → resolve a drawer reorder target (a card to insert before, or the end zone).
      let before: string | null = null;
      for (const [voiceId, node] of cardRefs.current) {
        if (voiceId === entry.voiceId) continue;
        if (pointInRect(node.getBoundingClientRect(), x, y)) {
          before = voiceId;
          break;
        }
      }
      const overEnd = !before && pointInRect(endRef.current?.getBoundingClientRect(), x, y);
      setDropBeforeVoiceId(before);
      setDropAtEnd(overEnd);
    };

    const onMove = (ev: PointerEvent) => {
      const session = cardDragRef.current;
      if (!session) return;
      const dx = ev.clientX - session.startX;
      const dy = ev.clientY - session.startY;

      // First real movement locks the axis: a touch that moves mostly sideways scrolls the carousel; a
      // vertical touch (or any mouse / pen move) lifts the card out. Below the lock distance we can't yet
      // tell a scroll from a grab, so wait. EVERY card lifts — even one that can't seed an empty stage
      // (a world): dropped on an occupied stage it swaps its own dimension of that live session.
      if (session.mode === 'pending') {
        if (Math.hypot(dx, dy) < DRAG_AXIS_LOCK_DISTANCE) return;
        if (session.isTouch && Math.abs(dx) > Math.abs(dy)) {
          session.mode = 'scroll';
          session.startScrollLeft = railScrollRef.current?.scrollLeft ?? 0;
          session.lastScrollX = ev.clientX;
          session.lastScrollT = ev.timeStamp;
        } else {
          session.mode = 'drag';
          setDragEntry(session.entry); // mounts the overlay; positioned from dragPosRef on first render
        }
      }

      if (session.mode === 'scroll') {
        // We own the carousel scroll (cards are touch-action:none) — follow the finger 1:1 from the origin.
        const el = railScrollRef.current;
        if (el) el.scrollLeft = session.startScrollLeft - dx;
        // Track the scrollLeft velocity (opposite the finger) so a release can coast (see onUp). Smooth it
        // with a light EMA so a single 1px jitter on the final sample can't flip the fling's direction.
        const dt = ev.timeStamp - session.lastScrollT;
        if (dt > 0) {
          const inst = -(ev.clientX - session.lastScrollX) / dt;
          session.scrollVel = FLING_VEL_SMOOTHING * inst + (1 - FLING_VEL_SMOOTHING) * session.scrollVel;
          session.lastScrollX = ev.clientX;
          session.lastScrollT = ev.timeStamp;
        }
        return;
      }

      ev.preventDefault(); // dragging: suppress text selection / any residual native gesture
      applyDragMove(ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      const session = cardDragRef.current;
      teardown();
      setDragEntry(null);
      if (session?.mode === 'drag') {
        lastCardTapRef.current = null; // a drag is not a tap — don't let it pair with a later tap
        const stage = stageIndexAtPoint(ev.clientX, ev.clientY);
        if (stage != null) {
          // Same validity rule as the drop hint — a release over an invalid stage does nothing (and
          // can't fall through to a reorder: the hints were cleared while hovering it).
          if (isValidDropTarget(session.entry, stage)) onLoadStage?.(stage, session.entry);
        } else if (dropAtEndRef.current) onReorderEntries?.(session.entry.voiceId, null);
        else if (dropBeforeRef.current) onReorderEntries?.(session.entry.voiceId, dropBeforeRef.current);
      } else if (session?.mode === 'pending') {
        // A tap (neither a drag nor a carousel scroll). A SECOND tap on the same card within the window
        // loads it into the active orbiter — the device-independent fallback for the critical load action.
        const now = ev.timeStamp;
        const prev = lastCardTapRef.current;
        if (prev && prev.voiceId === session.entry.voiceId && now - prev.t <= DOUBLE_TAP_MS) {
          lastCardTapRef.current = null;
          // Same rule as a drop on the active stage — so a double-tapped world card swaps the active
          // stage's world when one is playing there, and does nothing over an empty stage.
          if (isValidDropTarget(session.entry, activeIndex)) onLoadStage?.(activeIndex, session.entry);
        } else {
          lastCardTapRef.current = { voiceId: session.entry.voiceId, t: now };
        }
      } else {
        // A carousel scroll (or no gesture) is not a tap — don't let it bridge two taps into a false load.
        lastCardTapRef.current = null;
        // Fling: if the release carried enough speed, coast the rail with decaying velocity so the swipe
        // feels physical instead of stopping dead under the finger. A stale last sample means the finger had
        // paused before lifting → no coast (native momentum wouldn't fling a held-then-released swipe).
        const el = railScrollRef.current;
        const sampleFresh = session != null && ev.timeStamp - session.lastScrollT <= FLING_SAMPLE_MAX_AGE;
        let v = session?.mode === 'scroll' && sampleFresh ? session.scrollVel : 0;
        if (el && Math.abs(v) >= FLING_MIN_VELOCITY) {
          v = Math.max(-FLING_MAX_VELOCITY, Math.min(FLING_MAX_VELOCITY, v));
          let prevTs: number | null = null;
          const step = (ts: number) => {
            if (prevTs == null) {
              prevTs = ts;
              scrollMomentumRef.current = requestAnimationFrame(step);
              return;
            }
            const frame = ts - prevTs;
            prevTs = ts;
            const intended = el.scrollLeft + v * frame;
            el.scrollLeft = intended;
            const clampedAtEdge = Math.abs(el.scrollLeft - intended) > 1; // browser clamped → at an edge
            v *= FLING_FRICTION ** (frame / 16);
            if (clampedAtEdge || Math.abs(v) <= FLING_STOP_VELOCITY) {
              scrollMomentumRef.current = null;
              return;
            }
            scrollMomentumRef.current = requestAnimationFrame(step);
          };
          scrollMomentumRef.current = requestAnimationFrame(step);
        }
      }
      clearDropHints();
    };
    // A palm rejection / OS edge gesture can still fire pointercancel instead of pointerup. Without this the
    // session and its document listeners leak. (Cards are touch-action:none, so a rail scroll no longer
    // cancels a live drag — the bug that used to drop a card before it reached a slot.)
    const onCancel = () => {
      teardown();
      setDragEntry(null);
      clearDropHints();
    };
    cardDragRef.current = {
      entry,
      startX: e.clientX,
      startY: e.clientY,
      mode: 'pending',
      isTouch,
      startScrollLeft: 0,
      lastScrollX: e.clientX,
      lastScrollT: e.timeStamp,
      scrollVel: 0,
      move: onMove,
      up: onUp,
      cancel: onCancel,
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  // Tear down a card-drag session (and any in-flight fling) if the layout unmounts mid-gesture.
  useEffect(
    () => () => {
      const session = cardDragRef.current;
      if (session) {
        document.removeEventListener('pointermove', session.move);
        document.removeEventListener('pointerup', session.up);
        document.removeEventListener('pointercancel', session.cancel);
        cardDragRef.current = null;
      }
      if (scrollMomentumRef.current != null) {
        cancelAnimationFrame(scrollMomentumRef.current);
        scrollMomentumRef.current = null;
      }
    },
    [],
  );

  // ── Count switcher + Go back (with confirmation before a shrink drops loaded orbiters) ──────────
  const isStageFilled = (index: number) =>
    stageVoiceIds ? Boolean(stageVoiceIds[index]) : index < Math.min(subtype, rosterLength);

  // Where a card may land: an OCCUPIED stage accepts any card (the drop swaps only the card's own
  // dimension of the live session); an EMPTY stage only accepts a card that can boot it by itself.
  const isValidDropTarget = (entry: DrawerEntry, index: number) =>
    isStageFilled(index) || entry.bootable !== false;

  // Derived from (filled?, owning orbiter) per slot — NOT the `stageVoiceIds`/
  // `focusMidiPersistenceIds` array references, which are rebuilt on every collection edit
  // (reorder, an unrelated drag) even when occupancy is unchanged. Using this string as the
  // registration effect's dependency means register/unregister only fires when a slot's fill
  // state or owning orbiter actually changes — not on every unrelated state push.
  const focusRegistrationSignature = Array.from({ length: subtype }, (_, index) =>
    isStageFilled(index) ? `${index}:${focusMidiPersistenceIds?.[index] ?? ''}` : '',
  ).join('|');

  useEffect(() => {
    if (!registerMidiTarget || !unregisterMidiTarget) return undefined;
    const registered: string[] = [];
    for (let index = 0; index < subtype; index++) {
      if (!isStageFilled(index)) continue;
      const element = focusArtworkRefs.current.get(index);
      if (!element) continue;
      // The mapping is "select THIS TRACK" — scoped to that track's own real
      // orbiter under ONE fixed componentId, so it's the SAME learned mapping regardless of which
      // slot the track ends up in (re-registers with the fresh index whenever occupancy changes —
      // see `focusRegistrationSignature` — which is what makes the trigger follow the track rather
      // than a frozen position). `id` only needs to be unique per mounted DOM node this render; it
      // is never the persisted key.
      const persistenceOrbiterId = focusMidiPersistenceIds?.[index] ?? null;
      if (!persistenceOrbiterId) continue;
      const componentId = 'collection-focus-track';
      const id = `pm-collection-focus-track-${index}`;
      registerMidiTarget({
        id,
        element,
        componentId,
        componentType: 'kick',
        scope: 'GLOBAL',
        persistenceScope: { scope: 'orbiter', entityId: persistenceOrbiterId },
        onTrigger: () => onFocusStage?.(index, false, true),
      });
      registered.push(id);
    }
    return () => {
      registered.forEach((id) => unregisterMidiTarget(id));
    };
  }, [focusRegistrationSignature, onFocusStage, registerMidiTarget, subtype, unregisterMidiTarget]);

  // The filled stages in order — drives `hasActivePlayers` (the leave/shrink confirm). The mobile pager
  // itself steps activeIndex ± 1 through ALL stages so an empty stage is reachable to drop a card onto.
  const filledIndices: number[] = [];
  for (let i = 0; i < subtype; i++) if (isStageFilled(i)) filledIndices.push(i);
  const hasActivePlayers = filledIndices.length > 0;

  // The mobile pager steps through ALL stages relative to the focused one (not just filled) so an EMPTY
  // stage is reachable — that's how you page to a fresh stage to drop a card onto it after growing the
  // layout. `null` at the ends disables the arrow.
  const pagerPrevIndex = activeIndex > 0 ? activeIndex - 1 : null;
  const pagerNextIndex = activeIndex < subtype - 1 ? activeIndex + 1 : null;

  // ── Shell MIDI targets (collection scope) ────────────────────────────────────────────────────────
  // The studio's OWN actions — slot focus/add by POSITION (regardless of occupant), pager, drawer —
  // persisted under the collection, so a controller layout is learned once per collection and works
  // whatever is loaded. Pager + Cards targets are the REAL dock buttons (standard learn overlays,
  // tinted by scope); only the per-slot focus/add actions, which have no existing control, use the
  // learn-only chips rendered on each stage (zero-size outside `body.midi-learn-mode`). Trigger
  // callbacks read live state through a ref so registration never re-fires on focus/drawer churn.
  const shellAnchorRefs = useRef<Map<string, HTMLElement>>(new Map());
  const getShellAnchorRefCb = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) shellAnchorRefs.current.set(key, el);
      else shellAnchorRefs.current.delete(key);
      return undefined;
    },
    [],
  );
  const shellActionsRef = useRef({
    focus: (_i: number) => {},
    next: () => {},
    prev: () => {},
    drawer: () => {},
  });
  shellActionsRef.current = {
    focus: (i: number) => onFocusStage?.(i, false, true),
    next: () => navigateToStage(pagerNextIndex),
    prev: () => navigateToStage(pagerPrevIndex),
    drawer: () => setDrawerOpen((o) => !o),
  };

  useEffect(() => {
    if (!shellMidiCollectionId || !registerMidiTarget || !unregisterMidiTarget) return undefined;
    const persistenceScope = { scope: 'collection', entityId: shellMidiCollectionId };
    const registered: string[] = [];
    const register = (componentId: string, onTrigger: () => void) => {
      const element = shellAnchorRefs.current.get(componentId);
      if (!element) return;
      const id = `pm-${componentId}`;
      registerMidiTarget({
        id,
        element,
        componentId,
        componentType: 'kick',
        scope: 'GLOBAL',
        persistenceScope,
        onTrigger,
      });
      registered.push(id);
    };
    // One select target per POSITION. Additive multi-select from MIDI was dropped on purpose
    // (8 chips read as clutter); if it ever returns it should be a shift-style toggle, not a
    // second chip per slot.
    for (let index = 0; index < subtype; index++) {
      register(`collection-stage-focus-${index + 1}`, () => shellActionsRef.current.focus(index));
    }
    register('collection-stage-prev', () => shellActionsRef.current.prev());
    register('collection-stage-next', () => shellActionsRef.current.next());
    register('collection-drawer-toggle', () => shellActionsRef.current.drawer());
    return () => {
      registered.forEach((id) => unregisterMidiTarget(id));
    };
    // isMobile + canShowDrawer/canArrange swap WHICH dock buttons are mounted — re-register so
    // the targets rebind to the freshly mounted elements.
  }, [shellMidiCollectionId, subtype, registerMidiTarget, unregisterMidiTarget, isMobile, canShowDrawer, canArrange]);

  const requestSubtype = (next: number) => {
    const clamped = clampSubtype(next);
    if (clamped === subtype) return;
    // A shrink drops the loaded voices on the stages beyond the new count (index-based, no relocation —
    // survivors keep their audio). Confirm before dropping any; a grow / same commits directly.
    if (clamped < subtype) {
      let dropped = 0;
      for (let i = clamped; i < subtype; i++) if (isStageFilled(i)) dropped += 1;
      if (dropped > 0) {
        setPendingConfirmation({ kind: 'shrink', next: clamped, dropped });
        return;
      }
    }
    setSubtype(clamped);
  };

  const requestBack = () => {
    if (hasActivePlayers) setPendingConfirmation({ kind: 'back' });
    else onBack?.();
  };

  const confirmProceed = () => {
    const pending = pendingConfirmation;
    setPendingConfirmation(null);
    if (!pending) return;
    if (pending.kind === 'back') onBack?.();
    else setSubtype(pending.next);
  };

  const stageStyles = slotStylesFor(subtype, splitY, splitXPrimary, splitXSecondary);
  const dividers = dividersFor(subtype, splitY, splitXPrimary, splitXSecondary);

  // Shared dock controls used by BOTH the desktop and mobile bars (same model everywhere): a right-aligned
  // active-orbiter MONITOR, and the orbiter-count picker as a drop-up menu. Rendered inline (plain values,
  // not nested components) so they don't remount.

  // The active-orbiter monitor. Rendered as the LAST dock item, so it reads as the right-hand readout while
  // keeping the bar's even distribution (no forced left/right split). It shows the active slot's LETTER
  // always, and — when that slot has a track loaded — its album ARTWORK, so the loaded track is identifiable
  // at a glance (the per-stage artwork overlay was removed from the play area for space). Still tappable:
  // re-centres the pager on the active orbiter (a no-op nudge on desktop).
  const activeEntry = stageEntries?.[activeIndex];
  const activeFilled = isStageFilled(activeIndex);
  const activeLetter = String(SLOT_LABELS[activeIndex] ?? activeIndex + 1);
  const trackMonitor = (
    <CornerButton
      kind="kick"
      icon={
        activeFilled ? (
          <StationTrackCover
            image={activeEntry?.image}
            title={activeEntry?.title || 'Untitled'}
            size={20}
            radius={5}
            fallbackFontSize="0.6rem"
            entityType={activeEntry?.entityType}
          />
        ) : (
          <OrbiterGlyph />
        )
      }
      label={activeLetter}
      aria-label={
        activeFilled
          ? t('studio.dock.monitorLoaded', {
              letter: activeLetter,
              title: activeEntry?.title || t('studio.dock.monitorLoadedFallback'),
            })
          : t('studio.dock.monitorEmpty', { letter: activeLetter })
      }
      onClick={() => navigateToStage(activeIndex)}
    />
  );
  const layoutMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <CornerButton
          kind="kick"
          icon={<LayoutDashboard />}
          label={t('studio.dock.layout')}
          aria-label={t('studio.dock.layoutAria')}
          dropIndicator="up"
        />
      </DropdownMenuTrigger>
      {/* Portals to <body> (outside the studio's `dark` scope), so re-scope it dark to match the floating
          chrome; open ABOVE the bar. `.orb-studio__portal-surface` makes it read the USER chrome
          theme (body-mirrored `--orb-studio-chrome-*`), like the inspector's portalled menus. */}
      <DropdownMenuContent side="top" align="center" className="dark orb-studio__portal-surface">
        <DropdownMenuRadioGroup
          value={String(subtype)}
          onValueChange={(value) => {
            const next = Number(value);
            // Defer past the menu's close: a shrink opens the confirm AlertDialog, and two Radix modals
            // transitioning in the same tick can leave the body pointer-events lock stuck.
            requestAnimationFrame(() => requestSubtype(next));
          }}
        >
          {[1, 2, 3, 4].map((count) => (
            <DropdownMenuRadioItem key={count} value={String(count)}>
              {count === 1 ? t('studio.dock.orbiterCountOne') : t('studio.dock.orbiterCountMany', { count })}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {/* Exit lives here (not as its own heavy bar button): leaving the collection is a collection-level
            action, so it belongs in the collection menu. Defer past the menu close — like the count change,
            it may open the confirm AlertDialog, and two Radix modals in one tick can wedge the body lock. */}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => requestAnimationFrame(requestBack)}>{t('studio.dock.leaveCollection')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Desktop and mobile share the SAME element tree (root → wrapper → gridRef → per-index blocks → stage
  // cells); only styles + conditional chrome differ by `isMobile`. Keeping element identity across the
  // breakpoint means a rotate never remounts a stage cell (which would strand the compositor's stored
  // cell ref). Desktop = absolute resizable grid + dividers + nav bar; mobile = vertical scroll stack
  // with per-stage footer (Roman + prev/next), no resize.
  //
  // The whole tree is wrapped in `IconProvider` so the design-lib `<Icon>` (the nav's orbiter glyph, the
  // card type badges) resolves its bytes from the SAME Herbarium CDN base as the rest of the app — this
  // studio is a SEPARATE React root (`mountMultiStageStudio`), so it isn't under OrbitersUI's provider.
  return (
    <IconProvider baseUrl={getHerbariumBase() || undefined}>
    <div
      ref={scrollContainerRef}
      // `dark` scopes the design-library tokens to dark mode — the studio floats over the black 3D scene,
      // so its lib chrome (nav / drawer / dialog / cards) themes for a dark surface.
      className={`dark ${isMobile ? 'multi-stage-studio-scroll' : ''}`}
      style={
        isMobile
          ? {
              position: 'fixed',
              inset: 0,
              zIndex: 41,
              pointerEvents: 'none',
              overflowY: 'auto',
              overflowX: 'hidden',
            }
          : {
              position: 'fixed',
              inset: 0,
              zIndex: 41,
              pointerEvents: 'none',
              display: 'flex',
              flexDirection: 'column',
              // Reserve the fixed BottomNavBar's strip so the grid + drawer sit above it (the bar pins its
              // own surface to the viewport bottom; this keeps the shared stage tree intact — no remount).
              paddingBottom: 'var(--nav-mobile-bar-height, 4rem)',
            }
      }
    >
      <div style={isMobile ? { padding: 0 } : { position: 'relative', flex: 1, minHeight: 0, padding: 4 }}>
        <div
          ref={gridRef}
          style={
            isMobile
              ? { display: 'flex', flexDirection: 'column', gap: 0, minHeight: '100%' }
              : { position: 'relative', width: '100%', height: '100%', minHeight: 0 }
          }
        >
          {Array.from({ length: subtype }, (_, index) => {
            const isFilled = isStageFilled(index);
            const isDropTarget = dropStage === index;
            const s = stageStyles[index] ?? { left: '0', top: '0', width: '100%', height: '100%' };
            return (
              <div
                key={index}
                ref={getBlockRefCb(index)}
                style={
                  isMobile
                    ? {
                        position: 'relative',
                        width: '100%',
                        flexShrink: 0,
                        height: MOBILE_STAGE_HEIGHT,
                        overflow: 'hidden',
                      }
                    : {
                        position: 'absolute',
                        left: s.left,
                        top: s.top,
                        width: s.width,
                        height: s.height,
                        overflow: 'hidden',
                        minWidth: 0,
                        minHeight: 0,
                        pointerEvents: 'none',
                        transition: resizing ? 'none' : SLOT_TRANSITION,
                      }
                }
              >
                {/* Compositor cell + voice UI mount (kept childless by this root). Leaves footer room on mobile.
                    `multi-orbiter-cell` makes this stage the orbiter UI's size query container (orbitersUI.css),
                    exactly like the auto-grid tile cell — so the orbiter's container-relative responsive system
                    (continuous cq scaling + the discrete width/height breakpoints) keys off the STAGE box here.
                    Without it the orbiter chrome (header, knobs, waveform) falls back to viewport sizing and the
                    mobile compaction never fires, overflowing a phone-width stage. */}
                <div
                  ref={getStageRefCb(index)}
                  className="multi-orbiter-cell"
                  // pointerEvents:auto — the stage cell is this voice's own camera-input surface,
                  // so its CameraController receives planet drags directly and DOM hit-testing focuses the
                  // right stage on pointerdown (no realm-level geometry hit-test, no fall-through to the
                  // shared canvas). The orbiter chrome inside opts back to :none per #orbiters-react-ui-root.
                  style={
                    isMobile
                      ? { ...mobileContentInset, pointerEvents: 'auto' }
                      : { position: 'absolute', inset: 0, pointerEvents: 'auto' }
                  }
                />

                {/* Empty stage: the design-lib FourCornerCard corner-bracket frame around a Roman numeral +
                    a "drop / double-tap to load" hint (shown only when arrange is available). The frame highlights
                    (accent corners) when a dragged card is over it. On mobile it occupies the SAME reduced
                    box as the orbiter canvas (above the bar + open drawer), never the full screen. */}
                {!isFilled && (
                  <div
                    className="orb-studio__portal-surface"
                    style={
                      isMobile
                        ? { ...mobileContentInset, pointerEvents: 'none', padding: 20 }
                        : { position: 'absolute', inset: 0, pointerEvents: 'none', padding: 20 }
                    }
                  >
                    <FourCornerCard
                      cornerColors={isDropTarget ? 'var(--color-foreground, #ffffff)' : 'color-mix(in oklab, var(--color-foreground, #ffffff) 35%, transparent)'}
                      cornerWidth={24}
                      cornerHeight={22}
                      // The frame spans the WHOLE placeholder (its corners sit at the stage edges, inset
                      // only by the wrapper padding) so the entire stage reads as the drop target — not a
                      // small box floating in the middle.
                      style={{ width: '100%', height: '100%' }}
                      contentClassName="flex h-full flex-col items-center justify-center"
                    >
                      <span style={{ fontSize: '2rem', color: 'var(--color-muted-foreground, rgba(255,255,255,0.45))' }}>{SLOT_LABELS[index] ?? ''}</span>
                      {canArrange && (
                        <span style={{ marginTop: 6, fontSize: '0.9rem', color: 'var(--color-muted-foreground, rgba(255,255,255,0.45))' }}>{t('studio.stage.emptyHint')}</span>
                      )}
                    </FourCornerCard>
                  </div>
                )}

                {/* Shell MIDI anchor for THIS position (select the slot): a learn-only chip —
                    zero-size until body.midi-learn-mode, so it costs nothing and the overlay
                    layer ignores it outside learn mode. Sits BELOW the orbiter's transport row
                    (a second row), never over it — the transport buttons are learn targets too. */}
                {shellMidiCollectionId ? (
                  <div
                    className="orb-studio__midi-anchors orb-studio__portal-surface"
                    // 116px clears the transport row PLUS its learn-mode CH/CC badges at the
                    // tallest header scale (a full-screen stage measured ~103px to badge
                    // bottom); smaller stages have a compacter header, so the chip just gains
                    // margin there instead of colliding.
                    style={{ position: 'absolute', top: 116, left: '50%', transform: 'translateX(-50%)', zIndex: 6 }}
                  >
                    <span
                      ref={getShellAnchorRefCb(`collection-stage-focus-${index + 1}`)}
                      id={`pm-collection-stage-focus-${index + 1}`}
                      className="orb-studio__midi-anchor"
                    >
                      Select {SLOT_LABELS[index] ?? index + 1}
                    </span>
                  </div>
                ) : null}

                {/* Drag drop-target highlight over a FILLED stage under the pointer (the empty-stage frame
                    highlights itself, above). */}
                {isDropTarget && isFilled && (
                  <div
                    className="orb-studio__portal-surface"
                    style={{
                      position: 'absolute',
                      inset: 4,
                      borderRadius: 8,
                      border: '2px solid var(--color-border-2, rgba(255,255,255,0.85))',
                      background: 'color-mix(in oklab, var(--color-foreground, #ffffff) 6%, transparent)',
                      pointerEvents: 'none',
                      zIndex: 5,
                    }}
                  />
                )}

                {isFilled && stageEntries?.[index] ? (
                  <div
                    ref={getFocusArtworkRefCb(index)}
                    id={`pm-collection-focus-track-${index}`}
                    className="orb-studio__portal-surface"
                    style={{
                      position: 'absolute',
                      left: 12,
                      top: 12,
                      pointerEvents: 'none',
                      // Every stage size and corner tried (bottom-right, top-left, shrunk down)
                      // ended up overlapping some piece of the orbiter's own chrome (InteractionMenu,
                      // header transport, expanded track-info panel) at one screen size or another —
                      // there's no corner that's safe at every stage size. This is now HIDDEN everywhere
                      // and kept as an empty anchor only — it's still this track's MIDI-learn focus target
                      // (see the registration effect), which just needs the ref/id, not rendered artwork.
                      // The bottom-left A/B/C/D focus badge that used to render alongside it had the same
                      // overlap problem and was removed outright; onFocusStage is still reachable via
                      // other UI (drawer / bottom bar / MIDI), so no functionality is lost.
                      display: 'none',
                    }}
                    aria-hidden="true"
                  />
                ) : null}

                {/* Per-stage remove, top-right (clears the stage's voice back to a placeholder). Shown on
                    mobile too — each stage is a full screen there, so this is how you close the current
                    orbiter and free its slot. Available to anyone who can arrange. */}
                {isFilled && canArrange && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="orb-studio__portal-surface"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onClearStage?.(index)}
                    aria-label={t('studio.stage.removeFromStage', { number: index + 1 })}
                    style={{
                      // A phantom (ghost) control — no border, no surface; just the glyph. The lib ghost
                      // Button supplies the hover affordance. Pinned into the EXTREME top-right corner (tiny
                      // margin) so it clears the orbiter's own header ⋯ menu, which owns the inset top-right.
                      position: 'absolute',
                      right: 2,
                      top: 2,
                      width: 30,
                      height: 30,
                      color: 'var(--color-foreground, #ffffff)',
                      pointerEvents: 'auto',
                    }}
                  >
                    <X />
                  </Button>
                )}

                {/* Mobile chrome (pager nav + Cards toggle) is a SINGLE global BottomNavBar rendered once
                    below, not per-stage — see the mobile dock near the desktop one. */}
              </div>
            );
          })}

          {!isMobile &&
            dividers.map((d) => (
              <div
                key={`${d.ratio}-${d.axis}`}
                className="orb-studio__portal-surface"
                onPointerDown={startDrag(d)}
                style={{
                  position: 'absolute',
                  left: d.style.left,
                  top: d.style.top,
                  width: d.style.width,
                  height: d.style.height,
                  zIndex: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: d.axis === 'x' ? 'col-resize' : 'row-resize',
                  pointerEvents: 'auto',
                  touchAction: 'none',
                }}
              >
                <div
                  style={{
                    width: d.axis === 'x' ? 3 : 32,
                    height: d.axis === 'x' ? 32 : 3,
                    borderRadius: 9999,
                    background: resizing
                      ? 'color-mix(in oklab, var(--color-foreground, #ffffff) 28%, transparent)'
                      : 'color-mix(in oklab, var(--color-foreground, #ffffff) 22%, transparent)',
                    opacity: resizing ? 1 : 0.6,
                  }}
                />
              </div>
            ))}
        </div>
      </div>

      {/* MIDI-learn color legend (learn-mode only, like the chips): green targets save to the
          loaded track, blue ones to this collection. Pinned above the dock strip. */}
      {shellMidiCollectionId ? (
        <div
          className="orb-studio__midi-anchors orb-studio__portal-surface"
          style={{
            position: 'absolute',
            bottom: 'calc(var(--nav-mobile-bar-height, 4rem) + 12px)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 45,
          }}
        >
          <span className="orb-studio__midi-legend-entry" data-midi-scope="orbiter">
            Saved to track
          </span>
          <span className="orb-studio__midi-legend-entry" data-midi-scope="collection">
            Saved to collection
          </span>
        </div>
      ) : null}

      {/* Arrange drawer — DESKTOP (in-flow). Sits above the nav; its height eats into the grid area, so
          stages reflow (the compositor re-reads their rects each frame). */}
      {drawerMounted && (
        <CardDrawer
          cruise={cruise}
          loadDefaults={loadDefaults}
          entityFilters={entityFilters}
          open={drawerOpen}
          containerRef={chromeRef}
          entries={drawerEntries}
          activeVoiceId={stageVoiceIds?.[activeIndex] ?? null}
          draggingVoiceId={dragEntry?.voiceId ?? null}
          dropBeforeVoiceId={dropBeforeVoiceId}
          dropAtEnd={dropAtEnd}
          loadingSourceIds={loadingSourceIds}
          onCardPointerDown={onCardPointerDown}
          registerCardRef={registerCardRef}
          registerEndRef={(node) => {
            endRef.current = node;
          }}
          registerScrollRef={(node) => {
            railScrollRef.current = node;
          }}
          onRequestClose={() => setDrawerOpen(false)}
        />
      )}

      {/* Arrange drawer — MOBILE. A FIXED reduced-height rail (no resize) pinned above the nav: portrait
          along the bottom above the bar; landscape along the bottom to the RIGHT of the left rail. It does
          NOT overlay the orbiter — the stage box (`mobileContentInset`) shrinks by this drawer's height
          while it's open, so the cards and the full play area are both visible (the desktop reflow, adapted
          to the phone). pointer-events:none wrapper; the drawer re-enables its own. A drag STARTS on a card,
          so once armed the pointer stream is captured here and never reaches the camera. */}
      {isMobile && canShowDrawer && (
        <div
          style={{
            position: 'fixed',
            zIndex: 45,
            pointerEvents: 'none',
            ...(isLandscape
              ? { left: MOBILE_RAIL_W, right: 0, bottom: 0 }
              : { left: 0, right: 0, bottom: MOBILE_BAR_INSET }),
          }}
        >
          <CardDrawer
            cruise={cruise}
            loadDefaults={loadDefaults}
            entityFilters={entityFilters}
            open={drawerOpen}
            containerRef={chromeRef}
            fixedHeight={MOBILE_DRAWER_H}
            entries={drawerEntries}
            activeVoiceId={stageVoiceIds?.[activeIndex] ?? null}
            draggingVoiceId={dragEntry?.voiceId ?? null}
            dropBeforeVoiceId={dropBeforeVoiceId}
            dropAtEnd={dropAtEnd}
            loadingSourceIds={loadingSourceIds}
            onCardPointerDown={onCardPointerDown}
            registerCardRef={registerCardRef}
            registerEndRef={(node) => {
              endRef.current = node;
            }}
            registerScrollRef={(node) => {
              railScrollRef.current = node;
            }}
            onRequestClose={() => setDrawerOpen(false)}
          />
        </div>
      )}

      {/* Persistent bottom dock — the SAME model on mobile and desktop now: prev/next orbiter · Layout ·
          Cards on the LEFT, and the active-orbiter monitor pinned to the RIGHT. The only per-platform
          difference is the pager glyphs (mobile pages full-screen stages vertically → up/down; desktop
          selects across the grid → left/right) and the landscape RAIL orientation. Exit moved into the
          Layout menu ("Leave collection"), so the bar carries only orbiter controls. `multi-stage-studio-dock`
          overrides `--foreground` to white so the dock reads light-on-dark. */}
      {isMobile && (
        <BottomNavBar
          ref={chromeRef}
          orientation={isLandscape ? 'rail' : 'bottom'}
          surface="glass"
          className="multi-stage-studio-dock"
          style={{ pointerEvents: 'auto' }}
        >
          {/* The pager + Cards buttons ARE the shell MIDI targets (id + ref feed the
              registration effect) — in learn mode they get the standard overlay treatment,
              tinted per the collection scope, exactly like every other mappable control. */}
          <CornerButton
            kind="kick"
            id="pm-collection-stage-prev"
            ref={getShellAnchorRefCb('collection-stage-prev')}
            icon={<ArrowUp />}
            label={t('studio.dock.prev')}
            aria-label={t('studio.dock.prevAria')}
            disabled={pagerPrevIndex == null}
            onClick={() => navigateToStage(pagerPrevIndex)}
          />
          <CornerButton
            kind="kick"
            id="pm-collection-stage-next"
            ref={getShellAnchorRefCb('collection-stage-next')}
            icon={<ArrowDown />}
            label={t('studio.dock.next')}
            aria-label={t('studio.dock.nextAria')}
            disabled={pagerNextIndex == null}
            onClick={() => navigateToStage(pagerNextIndex)}
          />
          {layoutMenu}
          {canShowDrawer && (
            <CornerButton
              kind="toggle"
              id="pm-collection-drawer-toggle"
              ref={getShellAnchorRefCb('collection-drawer-toggle')}
              pressed={drawerOpen}
              icon={drawerOpen ? <ChevronDown /> : <ChevronUp />}
              label={t('studio.dock.cards')}
              aria-label={drawerOpen ? t('studio.dock.hideCards') : t('studio.dock.showCards')}
              onPressedChange={() => setDrawerOpen((o) => !o)}
            />
          )}
          {trackMonitor}
        </BottomNavBar>
      )}

      {!isMobile && (
        <BottomNavBar
          ref={chromeRef}
          orientation="bottom"
          surface="glass"
          className="multi-stage-studio-dock"
          style={{ pointerEvents: 'auto' }}
        >
          {/* Same shell-MIDI-target wiring as the mobile bar (only one bar mounts at a time,
              so the ids stay unique; an isMobile flip re-registers via the effect deps). */}
          <CornerButton
            kind="kick"
            id="pm-collection-stage-prev"
            ref={getShellAnchorRefCb('collection-stage-prev')}
            icon={<ArrowLeft />}
            label={t('studio.dock.prev')}
            aria-label={t('studio.dock.prevAria')}
            disabled={pagerPrevIndex == null}
            onClick={() => navigateToStage(pagerPrevIndex)}
          />
          <CornerButton
            kind="kick"
            id="pm-collection-stage-next"
            ref={getShellAnchorRefCb('collection-stage-next')}
            icon={<ArrowRight />}
            label={t('studio.dock.next')}
            aria-label={t('studio.dock.nextAria')}
            disabled={pagerNextIndex == null}
            onClick={() => navigateToStage(pagerNextIndex)}
          />
          {layoutMenu}
          {canArrange && (
            <CornerButton
              kind="toggle"
              id="pm-collection-drawer-toggle"
              ref={getShellAnchorRefCb('collection-drawer-toggle')}
              pressed={drawerOpen}
              // The chevron already flips to signal open/closed, so no separate dropIndicator caret.
              icon={drawerOpen ? <ChevronDown /> : <ChevronUp />}
              label={t('studio.dock.cards')}
              aria-label={drawerOpen ? t('studio.dock.hideCards') : t('studio.dock.showCards')}
              onPressedChange={() => setDrawerOpen((o) => !o)}
            />
          )}
          {trackMonitor}
        </BottomNavBar>
      )}

      {/* Drag overlay — a compact copy of the ported card following the pointer (root's DraggableCardOverlay
          renders the same StationTrackCard). The ref'd wrapper is positioned imperatively (onCardPointerDown). */}
      {dragEntry && (
        <div
          ref={overlayRef}
          className="orb-studio__portal-surface"
          style={{ position: 'fixed', zIndex: 60, pointerEvents: 'none', width: 260, height: 200, opacity: 0.95, left: dragPosRef.current.x + 12, top: dragPosRef.current.y + 12 }}
        >
          <StationTrackCard entry={dragEntry} compact showBadge />
        </div>
      )}

      {/* Confirmation dialog (design-lib AlertDialog) — a count-shrink that would drop loaded orbiters, or
          leaving the collection. */}
      <AlertDialog
        open={pendingConfirmation !== null}
        onOpenChange={(next) => {
          if (!next) setPendingConfirmation(null);
        }}
      >
        <AlertDialogContent className="dark orb-studio__portal-surface">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingConfirmation?.kind === 'back' ? t('studio.confirm.leaveTitle') : t('studio.confirm.shrinkTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingConfirmation?.kind === 'back'
                ? t('studio.confirm.leaveBody')
                : pendingConfirmation
                  ? pendingConfirmation.dropped === 1
                    ? t('studio.confirm.shrinkBodyOne')
                    : t('studio.confirm.shrinkBodyMany', { count: pendingConfirmation.dropped })
                  : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingConfirmation(null)}>{t('studio.confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmProceed}>{t('studio.confirm.continue')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </IconProvider>
  );
}

export interface MountedStudio {
  host: HTMLElement;
  root: Root;
  /** Resolves with the imperative handle once the initial stages are committed. */
  ready: Promise<MultiStageStudioHandle>;
  /** Merge new props and re-render (the component's own state — subtype, splits, drag — is preserved
   *  across re-renders). Used to push the live arrangement (`stageVoiceIds`, `entries`) from the realm. */
  update: (next: Partial<Omit<MultiStageStudioProps, 'onReady'>>) => void;
  dispose: () => void;
}

/** Mount the multi-stage Studio into a fresh full-screen host and return an imperative handle promise. */
export function mountMultiStageStudio(
  props: Omit<MultiStageStudioProps, 'onReady'>,
): MountedStudio {
  const host = document.createElement('div');
  host.id = 'multi-stage-studio-root';
  document.body.appendChild(host);
  const root = createRoot(host);

  let resolveReady: (handle: MultiStageStudioHandle) => void;
  const ready = new Promise<MultiStageStudioHandle>((resolve) => {
    resolveReady = resolve;
  });

  let current = { ...props };
  const render = () =>
    root.render(<MultiStageStudio {...current} onReady={(handle) => resolveReady(handle)} />);
  render();

  return {
    host,
    root,
    ready,
    update: (next) => {
      current = { ...current, ...next };
      render();
    },
    dispose: () => {
      root.unmount();
      host.remove();
    },
  };
}
