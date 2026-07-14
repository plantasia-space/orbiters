/**
 * @file src/ui/react/studio/CardDrawer.tsx
 * @description The arrange drawer for the multi-stage Orbiter Studio — a bottom, resizable rail of the
 * collection's entries as draggable cards. A FAITHFUL PORT of root's mixed-collection `card-drawer.tsx`:
 * the same resizable rail (default 320 / min 152 / max 512), the same `cardHeight`-driven compact/reduced
 * card tiers, the same scroll arrows + end drop-zone. The RAIL CONTAINER is bespoke in root too (a fixed-
 * overlay `Drawer`/`Sheet` can't be an in-flow resizable rail that reflows the stages). Each card is the
 * ported `StationTrackCard` inside a draggable wrapper; the parent (`MultiStageStudio`) owns the pointer
 * drag (activation distance, overlay, stage/card hit-test, drop). Custom positioning/sizing is inline
 * `style`, because orbiters ships the design-lib's PRE-COMPILED Tailwind (`styles.css`) and has no Tailwind
 * pass of its own — so arbitrary utility classes would not exist.
 *
 * Visibility is controlled by the parent (the nav's "Cards" toggle); the drawer stays MOUNTED when closed
 * (collapsed to 0 height) so its resized height survives a toggle. Shown to EVERYONE who can view.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Layers, ShipWheel } from 'lucide-react';
import { Button } from 'plantasia.space-design/react';
import { Icon } from 'plantasia.space-design/icons';
import { StationTrackCard, type StationCardEntry } from './StationTrackCard';
import { entityMeta } from './entityMeta';
import { getT } from '../../../i18n/index.js';
// The app-wide control-tooltips system (the same flag the orbiter More menu toggles): the drawer
// offers a redundant toggle — assistance close at hand, whatever surface the user is on.
import { refreshControlTooltips, toggleControlTooltips } from '../../controlTooltips.js';
import { useTooltipsEnabled } from '../regions/useControlTooltips';

/** Run a toolbar toggle, then rebuild the control tooltips: the system resolves a tooltip's text
 *  when it builds the instance, so a state flip that rewrites the button's aria-label must rebuild
 *  for the next hover to tell the NEW state (the rebuild also retires the currently-open tooltip).
 *  setTimeout (not requestAnimationFrame) so the refresh runs after React commits the new label
 *  even in a hidden/backgrounded tab, where rAF can be deferred indefinitely. */
function toggleThenRefreshTooltips(toggle: () => void): void {
  toggle();
  setTimeout(() => refreshControlTooltips(), 0);
}

// Root's drawer sizing (card-drawer.tsx). The card height is derived from the drawer height, and drives
// the compact/reduced tiers — so the prominent square-art card appears as the drawer is dragged taller.
const DEFAULT_HEIGHT = 320;
const DESKTOP_MAX_HEIGHT = 512;
const MIN_CARD_HEIGHT = 88;
const DRAWER_CHROME_HEIGHT = 64;
const MIN_HEIGHT = MIN_CARD_HEIGHT + DRAWER_CHROME_HEIGHT; // 152
const CARD_VERTICAL_CLEARANCE = 76; // count row + card padding subtracted from content height
const CLOSE_THRESHOLD = 96; // drag the handle this far below MIN to close
const COMPACT_CARD_BREAKPOINT = 285;
const REDUCED_CARD_BREAKPOINT = 190;
const CARD_WIDTH = 300;

/** A drawer card = the card's display fields (`StationCardEntry`) plus the stable per-entry `voiceId`. */
export interface DrawerEntry extends StationCardEntry {
  voiceId: string;
}

export interface CardDrawerProps {
  /** Open/closed is owned by the parent (the nav's "Cards" toggle). The drawer stays MOUNTED when closed
   *  (collapsed to 0 height) so its resized height survives a toggle. */
  open: boolean;
  /** Fix the drawer to this exact height and DROP the resize handle — used on mobile, where the drawer
   *  reflows the orbiter (shrinks the stage) instead of overlaying it, so it stays at one reduced height
   *  and is opened/closed only by the bar's Cards toggle. When omitted the drawer is resizable (desktop). */
  fixedHeight?: number;
  entries: DrawerEntry[];
  activeVoiceId?: string | null;
  /** The entry currently being dragged (its card dims) — null when idle. */
  draggingVoiceId?: string | null;
  /** Reorder drop hints while dragging: insert-before this card, or at the rail end. */
  dropBeforeVoiceId?: string | null;
  dropAtEnd?: boolean;
  onCardPointerDown: (entry: DrawerEntry, event: ReactPointerEvent) => void;
  /** Register each card's element (and the end zone) so the parent can hit-test reorder targets. */
  registerCardRef: (voiceId: string, node: HTMLElement | null) => void;
  registerEndRef: (node: HTMLElement | null) => void;
  /** Register the horizontal scroll container so the parent can drive the carousel scroll itself during a
   *  touch swipe (the cards are `touch-action: none`, so the rail no longer scrolls natively). */
  registerScrollRef: (node: HTMLElement | null) => void;
  /** Ref-callback for the drawer's OUTER container — the parent attaches `applyStudioChromeTheme`
   *  here so the drawer + its cards follow the USER chrome theme (the drawer is chrome, like the inspector).
   *  A React-19 ref callback that may return a cleanup. */
  containerRef?: (node: HTMLElement | null) => void | (() => void);
  /** Drag the resize handle far down to close — the parent owns the open/closed state. */
  onRequestClose: () => void;
  /** Cruise mode: tracks play one after another while engaged. Subtle, set-and-forget — lives in
   *  the header toolbar next to the count, not in the main bar. Absent = not offered. */
  cruise?: { enabled: boolean; onToggle: () => void } | null;
  /** "Load full sessions": while engaged, a drop replaces the deck with the card's original
   *  session instead of swapping only the card's own dimension. Absent = not offered. */
  loadDefaults?: { enabled: boolean; onToggle: () => void } | null;
  /** Entity filters (mixed collections only) — the header's LEFT toolbar: one square chip per card
   *  kind present, all on by default; turning one off hides that kind from the rail (view-only).
   *  Absent = no filters (homogeneous collection). */
  entityFilters?: Array<{
    key: string;
    icon: string;
    colorVar: string;
    label: string;
    enabled: boolean;
    onToggle: () => void;
  }> | null;
  /** Source (drawer) voiceIds with an in-flight drop/load — those cards show the orbit loader. */
  loadingSourceIds?: string[];
}

// Resizable-drawer clamp (desktop): between the minimum and the shorter of the 512px cap / the viewport.
function clampHeight(h: number): number {
  const viewportMax = typeof window === 'undefined' ? DESKTOP_MAX_HEIGHT : window.innerHeight - 48;
  return Math.min(Math.min(DESKTOP_MAX_HEIGHT, viewportMax), Math.max(MIN_HEIGHT, h));
}

/** The right-aligned drawer count. Entity-aware when the set is homogeneous ("3 audios"), else a generic
 *  "N cards" — a MIXED collection (tracks + orbiters) has no single noun, so it never says "N audios". */
function countLabel(entries: DrawerEntry[]): string {
  const nouns = new Set(entries.map((e) => entityMeta(e.entityType).noun));
  const noun = nouns.size === 1 ? [...nouns][0] : 'card'; // homogeneous → typed; mixed → generic
  const plural = entries.length === 1 ? noun : `${noun}s`;
  return `${entries.length} ${plural}`;
}

export function CardDrawer({
  open,
  fixedHeight,
  entries,
  activeVoiceId = null,
  draggingVoiceId = null,
  dropBeforeVoiceId = null,
  dropAtEnd = false,
  onCardPointerDown,
  registerCardRef,
  registerEndRef,
  registerScrollRef,
  containerRef,
  onRequestClose,
  cruise = null,
  loadDefaults = null,
  entityFilters = null,
  loadingSourceIds,
}: CardDrawerProps) {
  const t = getT();
  // The global control-tooltips flag — the drawer's toggle drives the SAME system the orbiter
  // More menu does, so either surface flips assistance for the whole app.
  const tooltipsOn = useTooltipsEnabled();
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ move?: (e: PointerEvent) => void; up?: () => void }>({});
  const hasActiveSelection = activeVoiceId !== null;
  const resizable = fixedHeight == null;
  // Fixed (mobile): one reduced height, no resize. Otherwise the resizable state height (desktop).
  const effectiveHeight = fixedHeight ?? height;

  // Card height (and thus its responsive tier) is derived from the drawer height — root's exact math.
  const contentHeight = Math.max(0, effectiveHeight - 12);
  const cardHeight = Math.max(MIN_CARD_HEIGHT, contentHeight - CARD_VERTICAL_CLEARANCE);
  const compact = cardHeight < COMPACT_CARD_BREAKPOINT;
  const reduced = cardHeight < REDUCED_CARD_BREAKPOINT;

  useEffect(
    () => () => {
      if (dragRef.current.move) document.removeEventListener('pointermove', dragRef.current.move);
      if (dragRef.current.up) document.removeEventListener('pointerup', dragRef.current.up);
      dragRef.current = {};
    },
    [],
  );

  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      let willClose = false;
      const onMove = (ev: PointerEvent) => {
        // Mobile (fixed height): the handle only CLOSES — drag the top border down past the threshold to
        // dismiss. There's no resize, so the drawer height never changes under the finger.
        if (!resizable) {
          willClose = ev.clientY - startY > CLOSE_THRESHOLD;
          return;
        }
        const next = startHeight + (startY - ev.clientY); // drag up grows
        if (next <= MIN_HEIGHT - CLOSE_THRESHOLD) {
          willClose = true;
          return;
        }
        willClose = false;
        setHeight(clampHeight(next));
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        dragRef.current = {};
        if (willClose) onRequestClose();
      };
      dragRef.current = { move: onMove, up: onUp };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [height, onRequestClose, resizable],
  );

  const scrollByAmount = useCallback((direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const delta = Math.max(220, Math.round(el.clientWidth * 0.72));
    el.scrollBy({ left: direction === 'left' ? -delta : delta, behavior: 'smooth' });
  }, []);

  return (
    <div ref={containerRef} style={{ ...drawerStyle, height: open ? effectiveHeight : 0 }} aria-hidden={!open}>
      {/* Top-border handle. Desktop (resizable): drag up/down to resize, far down to close. Mobile (fixed
          height): drag down to close — the same gesture, minus the resize (the Cards toggle also opens/closes).
          The grab bar is always here so the drawer can be dismissed by dragging its top border. */}
      <button
        type="button"
        onPointerDown={handleResizePointerDown}
        aria-label={resizable ? t('studio.resizeDrawer', { defaultValue: 'Resize drawer' }) : t('studio.closeCards', { defaultValue: 'Close cards' })}
        style={resizeHandleStyle}
      >
        <span style={{ width: 36, height: 3, borderRadius: 9999, background: 'color-mix(in oklab, var(--color-foreground, #ffffff) 30%, transparent)' }} />
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, padding: '0 16px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
          {/* LEFT toolbar — entity filters (mixed collections): square chips, one per card kind,
              tinted with the entity accent while shown; dimmed when that kind is hidden. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {entityFilters?.map((filter) => (
              <Button
                key={filter.key}
                variant="ghost"
                size="icon"
                onClick={() => toggleThenRefreshTooltips(filter.onToggle)}
                aria-pressed={filter.enabled}
                aria-label={t(filter.enabled ? 'studio.filters.shown' : 'studio.filters.hidden', {
                  label: t(`studio.filters.${filter.key}`, { defaultValue: filter.label }),
                })}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: filter.enabled
                    ? `color-mix(in oklab, var(${filter.colorVar}) 18%, transparent)`
                    : 'transparent',
                  boxShadow: filter.enabled
                    ? `0 0 0 1px color-mix(in oklab, var(${filter.colorVar}) 30%, transparent)`
                    : '0 0 0 1px color-mix(in oklab, var(--color-foreground, #ffffff) 15%, transparent)',
                  color: filter.enabled ? `var(${filter.colorVar})` : 'var(--color-foreground, #ffffff)',
                  opacity: filter.enabled ? 1 : 0.35,
                }}
              >
                <Icon name={filter.icon} style={{ width: 15, height: 15 }} aria-hidden />
              </Button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {cruise && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => toggleThenRefreshTooltips(cruise.onToggle)}
              aria-pressed={cruise.enabled}
              aria-label={t(cruise.enabled ? 'studio.cruiseOn' : 'studio.cruiseOff')}
              // Theme vars in the drawer chrome can resolve both states to the same
              // white — state reads through opacity + an engaged pill, not color vars.
              style={{
                width: 28,
                height: 28,
                borderRadius: 9999,
                background: cruise.enabled
                  ? 'color-mix(in oklab, var(--color-foreground, #ffffff) 18%, transparent)'
                  : 'transparent',
                color: 'var(--color-foreground, #ffffff)',
                opacity: cruise.enabled ? 1 : 0.35,
              }}
            >
              <ShipWheel style={{ width: 16, height: 16 }} />
            </Button>
          )}
          {loadDefaults && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => toggleThenRefreshTooltips(loadDefaults.onToggle)}
              aria-pressed={loadDefaults.enabled}
              aria-label={t(loadDefaults.enabled ? 'studio.fullSessionsOn' : 'studio.fullSessionsOff')}
              style={{
                width: 28,
                height: 28,
                borderRadius: 9999,
                background: loadDefaults.enabled
                  ? 'color-mix(in oklab, var(--color-foreground, #ffffff) 18%, transparent)'
                  : 'transparent',
                color: 'var(--color-foreground, #ffffff)',
                opacity: loadDefaults.enabled ? 1 : 0.35,
              }}
            >
              <Layers style={{ width: 16, height: 16 }} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => toggleThenRefreshTooltips(() => toggleControlTooltips())}
            aria-pressed={tooltipsOn}
            aria-label={t(tooltipsOn ? 'studio.tooltipsOn' : 'studio.tooltipsOff')}
            style={{
              width: 28,
              height: 28,
              borderRadius: 9999,
              background: tooltipsOn
                ? 'color-mix(in oklab, var(--color-foreground, #ffffff) 18%, transparent)'
                : 'transparent',
              color: 'var(--color-foreground, #ffffff)',
              opacity: tooltipsOn ? 1 : 0.35,
            }}
          >
            {/* The platform's tooltip glyph (the "i") — the same icon the orbiter More menu uses. */}
            <Icon name="tooltip" style={{ width: 16, height: 16 }} aria-hidden />
          </Button>
          <span style={{ fontSize: '0.875rem', color: 'var(--color-muted-foreground, rgba(255,255,255,0.6))' }}>{countLabel(entries)}</span>
          </div>
        </div>

        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {entries.length > 0 && (
            <>
              <Button variant="ghost" size="icon" onClick={() => scrollByAmount('left')} aria-label={t('studio.scrollLeft', { defaultValue: 'Scroll left' })} style={{ ...arrowStyle, left: 0 }}>
                <ChevronLeft />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => scrollByAmount('right')} aria-label={t('studio.scrollRight', { defaultValue: 'Scroll right' })} style={{ ...arrowStyle, right: 0 }}>
                <ChevronRight />
              </Button>
            </>
          )}

          <div
            ref={(node) => {
              scrollRef.current = node;
              registerScrollRef(node);
            }}
            style={railStyle}
          >
            {entries.map((entry) => {
              const isActive = entry.voiceId === activeVoiceId;
              const isDragging = entry.voiceId === draggingVoiceId;
              const isDropBefore = entry.voiceId === dropBeforeVoiceId;
              return (
                <div
                  key={entry.voiceId}
                  ref={(node: HTMLDivElement | null) => registerCardRef(entry.voiceId, node)}
                  onPointerDown={(e: ReactPointerEvent) => onCardPointerDown(entry, e)}
                  style={{
                    position: 'relative',
                    flexShrink: 0,
                    width: CARD_WIDTH,
                    height: cardHeight,
                    borderRadius: 28,
                    // Every card lifts out — even one that can't seed an empty stage swaps into an
                    // occupied one — so every card advertises the grab.
                    cursor: 'grab',
                    userSelect: 'none',
                    // touch-action:none so the browser never claims a card touch for a native scroll — that
                    // pan would fire pointercancel and drop a card mid-drag. The parent owns BOTH the carousel
                    // scroll (horizontal swipe) and the drag (vertical pull) via one pointer session.
                    touchAction: 'none',
                    // Reorder insert-before hint — an accent ring on the target card (root's ring-2). Follows
                    // the chrome accent (`--color-border-2`); the light literal is the cold-start fallback.
                    boxShadow: isDropBefore ? '0 0 0 2px var(--color-border-2, rgba(255,255,255,0.6))' : undefined,
                  }}
                >
                  <StationTrackCard
                    entry={entry}
                    dragging={isDragging}
                    compact={compact}
                    reduced={reduced}
                    active={isActive}
                    dimmed={!isDragging && hasActiveSelection && !isActive}
                    showSubtitle={!reduced}
                    loading={loadingSourceIds?.includes(entry.voiceId) ?? false}
                  />
                </div>
              );
            })}

            {entries.length > 0 && (
              <div
                ref={registerEndRef}
                aria-hidden="true"
                style={{
                  flex: '0 0 auto',
                  width: 40,
                  alignSelf: 'stretch',
                  borderRadius: 20,
                  border: `1px dashed ${dropAtEnd ? 'var(--color-border-2, rgba(255,255,255,0.55))' : 'transparent'}`,
                  background: dropAtEnd ? 'color-mix(in oklab, var(--color-foreground, #ffffff) 6%, transparent)' : 'transparent',
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// The drawer is chrome — the parent attaches `applyStudioChromeTheme` via `containerRef`, so these
// `--color-*` tokens resolve to the USER chrome theme (surface + ink + font follow settings). Before the
// preset resolves the enclosing `.dark` scope supplies the light-on-dark defaults, so the `var(--x, literal)`
// literals are just last-ditch fallbacks. The frosted surface uses color-mix so the backdrop-blur still
// reads through.
const drawerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'color-mix(in oklab, var(--color-background, #000000) 50%, transparent)',
  backdropFilter: 'blur(10px)',
  pointerEvents: 'auto',
  flexShrink: 0,
  color: 'var(--color-foreground, #ffffff)',
  transition: 'height 360ms cubic-bezier(0.22,1,0.36,1)',
};

const resizeHandleStyle: React.CSSProperties = {
  height: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'row-resize',
  touchAction: 'none',
  flexShrink: 0,
  border: 0,
  background: 'transparent',
};

const arrowStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  zIndex: 2,
  borderRadius: 9999,
  background: 'color-mix(in oklab, var(--color-background, #000000) 55%, transparent)',
  color: 'var(--color-foreground, #ffffff)',
  backdropFilter: 'blur(4px)',
};

const railStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 16,
  height: '100%',
  overflowX: 'auto',
  overflowY: 'hidden',
  scrollbarWidth: 'none',
  paddingBottom: 4,
  // The rail still scrolls via wheel / trackpad / the arrow buttons; touch scrolling is driven by the
  // parent's pointer session (cards are touch-action:none), so native touch panning is disabled here too
  // to keep one owner of the gesture.
  touchAction: 'none',
};
