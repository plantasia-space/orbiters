/**
 * @file src/ui/react/studio/StationTrackCard.tsx
 * @description The arrange-drawer entry card — a FAITHFUL PORT of root's
 * `plantasia.space-root/src/components/mixed-collection/station-track-card.tsx`. Same structure: a frosted
 * rounded-28px panel with a prominent square cover, an official star, a centered type badge, and an
 * active-underline marker, with the same responsive `compact`/`reduced` tiers driven by the card's height.
 *
 * Root builds it with Tailwind utility classes; orbiters has NO Tailwind pass (it ships the design-lib's
 * PRE-COMPILED `styles.css`), so root's arbitrary utilities (`rounded-[28px]`, `bg-background/80`,
 * `backdrop-blur-md`, `text-muted-foreground`, `bg-primary/10`, …) do not exist here. This port therefore
 * translates root's classes to INLINE STYLES verbatim (same radii, spacing, sizes, opacities), and uses the
 * design-lib `Badge` + entity `Icon` for the type badge (identical to root). Its colors now read
 * the resolved USER chrome-theme `--color-*` tokens (the card is chrome, matching the edit-mode inspector),
 * carried by whichever wrapper renders it (card-drawer / drag-overlay / stage-artwork); before the preset
 * resolves the enclosing `.dark` scope supplies the light-on-dark defaults, so the literals are just
 * last-ditch `var(--x, …)` fallbacks. The card is display-only; the drag wiring lives on the wrapper in
 * `CardDrawer`.
 */
import { Badge, OfficialMark } from 'plantasia.space-design/react';
import { Icon } from 'plantasia.space-design/icons';
import { entityMeta } from './entityMeta';
import { getT } from '../../../i18n/index.js';
// The orbit spinner (`voice-load-overlay__spinner`/`__dot` + its keyframes) — the same loader the
// per-tile boot overlay shows, reused at card scale for the in-flight load indicator. Declared
// here too so the card never depends on another module having loaded the stylesheet first.
import '../../../multi/voiceLoadOverlay.css';

// The card is chrome — it follows the USER chrome theme, like the edit-mode inspector. It is
// ALWAYS rendered under a container carrying that theme (the card-drawer / drag-overlay / stage-artwork
// wrappers apply `applyStudioChromeTheme` or `.orb-studio__portal-surface`), so these read the resolved
// design-lib `--color-*` tokens. Before the preset resolves (or if settings are unavailable) the enclosing
// `.dark` scope already supplies the light-on-dark token set (`.dark { --foreground:#fff; --card:#000; … }`
// in the lib), so the card looks right without chrome; the `var(--x, literal)` literal is only a last-ditch
// fallback for a token neither the preset nor `.dark` defines. Root's active accent is `--color-border-2`;
// the official star stays a fixed brand-warm gold (a semantic mark, not chrome).
const FOREGROUND = 'var(--color-foreground, #ffffff)';
const MUTED = 'var(--color-muted-foreground, rgba(255,255,255,0.62))';
// A SOFTER muted tier than MUTED (the old literals were 0.5 vs 0.62). `--color-muted-foreground` is opaque,
// so knock it back with color-mix to keep MUTED_SOFT visibly lighter than MUTED once chrome resolves.
const MUTED_SOFT = 'color-mix(in oklab, var(--color-muted-foreground, rgba(255,255,255,0.5)) 80%, transparent)';
// The frosted panel — root's `bg-background/80 backdrop-blur-md`. Follows the chrome `--color-card` at 80%
// (color-mix keeps the frost so the backdrop-blur reads); the black fallback matches the prior dark look.
const PANEL_BG = 'color-mix(in oklab, var(--color-card, #000000) 80%, transparent)';
// The active-underline marker — root's `bg-[var(--color-border-2)]/80` (the dark accent). Follows chrome.
const ACTIVE_ACCENT = 'var(--color-border-2, rgba(255,255,255,0.85))';

export interface StationCardEntry {
  title?: string | null;
  subtitle?: string | null;
  image?: string | null;
  entityType?: string | null;
  isOfficial?: boolean | null;
  /** False when the entry can't seed an EMPTY stage by itself (a world — no audio to mix — or an
   *  orbiter whose release carries no reference track). Still fully draggable: dropped on an
   *  occupied stage it swaps its own dimension of that live session, and the caption says so. */
  bootable?: boolean;
}

export interface StationTrackCardProps {
  entry: StationCardEntry;
  dragging?: boolean;
  compact?: boolean;
  reduced?: boolean;
  showSubtitle?: boolean;
  showBadge?: boolean;
  active?: boolean;
  dimmed?: boolean;
  /** True while this card's drop/load is in flight — the cover shows the orbit loader so the
   *  user sees the request working (a swap can take seconds with no other feedback). */
  loading?: boolean;
}

/** A `-webkit-line-clamp` block, inline (no Tailwind `line-clamp-N` in orbiters). */
function clamp(lines: number): React.CSSProperties {
  return {
    display: '-webkit-box',
    WebkitLineClamp: lines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };
}

export function StationTrackCover({
  image,
  title,
  size,
  radius,
  fallbackFontSize,
  fill = false,
  entityType = null,
  loading = false,
}: {
  image?: string | null;
  title: string;
  size?: number;
  radius: number;
  fallbackFontSize: string;
  fill?: boolean;
  /** Shapes the cover with the entity's signature design-lib frame (see `entityMeta.frameClass`):
   *  track = square, orbiter = hexagon, world = circle. Omit for the default rounded tile. */
  entityType?: string | null;
  /** Dim the cover and show the orbit loader over it (an in-flight drop/load). */
  loading?: boolean;
}) {
  const fallbackInitial = title.charAt(0).toUpperCase() || 'T';
  // The signature shape identifies the entity type at a glance — same frame classes the site's
  // mini-cards use, from the design-lib's entity-frames.css (in the precompiled styles.css this
  // studio already imports). An imageless WORLD keeps the default rounded tile: the circle class
  // forces a transparent background, which would erase the lettered fallback.
  const frameClass = (() => {
    const cls = entityMeta(entityType).frameClass;
    return cls === 'user-square-frame' && !image ? null : cls;
  })();
  // A shaped frame owns its own presentation (radius / background / hover) — inline values would
  // override the class. The hexagon keeps the tinted background (the clip shapes it, and the
  // lettered fallback needs it); a clip-path frame would clip a box shadow away, so only the
  // square track frame keeps the depth shadow.
  const isClipShape = frameClass === 'hexagon-mask' || frameClass === 'user-square-frame';
  const box: React.CSSProperties = fill
    ? { position: 'relative', width: '100%', aspectRatio: '1 / 1', maxWidth: 240 }
    : { position: 'relative', width: size, height: size, flexShrink: 0 };
  return (
    <div
      className={frameClass ?? undefined}
      style={{
        ...box,
        overflow: 'hidden',
        ...(frameClass ? {} : { borderRadius: radius }),
        ...(frameClass === 'track-square-frame' || frameClass === 'user-square-frame'
          ? {}
          : { background: 'color-mix(in oklab, var(--color-foreground, #ffffff) 8%, transparent)' }),
        ...(isClipShape ? {} : { boxShadow: '0 10px 24px rgba(0,0,0,0.18)' }),
      }}
    >
      {image ? (
        <img
          src={image}
          alt={title}
          draggable={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            // The mini-card world trick: world posters are PORTRAIT, so the square cover crops them
            // vertically — and the subject sits in the upper band, not the vertical middle, so a
            // plain center crop cuts it. The site's mini-cards nudge the crop with a fixed
            // `object-position: center -10px` on their 96px covers; `center 25%` is that same
            // framing expressed proportionally (at 96px it lands on the identical -10px), so it
            // holds at every cover size here — and is a no-op on a square image.
            ...(frameClass === 'user-square-frame' ? { objectPosition: 'center 25%' } : {}),
          }}
        />
      ) : (
        <div
          style={{
            display: 'flex',
            width: '100%',
            height: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: fallbackFontSize,
            fontWeight: 600,
            color: MUTED_SOFT,
          }}
        >
          {fallbackInitial}
        </div>
      )}
      {/* In-flight load — the same orbit spinner the per-tile boot overlay uses, scaled by the
          cover (the spinner classes are percentage-sized). Sits INSIDE the cover so the entity
          frame clips it to the signature shape. */}
      {loading ? (
        <div
          aria-label="Loading"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.45)',
          }}
        >
          <div className="voice-load-overlay__spinner" style={{ width: '38%' }}>
            <div className="voice-load-overlay__dot" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StationTrackCard({
  entry,
  dragging = false,
  compact = false,
  reduced = false,
  showSubtitle = true,
  showBadge = true,
  active = false,
  dimmed = false,
  loading = false,
}: StationTrackCardProps) {
  const title = entry.title || 'Untitled';
  const subtitle = showSubtitle ? entry.subtitle ?? null : null;
  const meta = entityMeta(entry.entityType);
  const swapOnly = entry.bootable === false;
  // Official mark — the design-lib's shared OfficialMark (a green leaf chip; a leaf, not a star:
  // stars mean bookmarks on this platform), rendered INLINE with the title. Hidden on the reduced
  // tier, like the badge.
  const officialMark = entry.isOfficial ? (
    <OfficialMark label={getT()('studio.official', { defaultValue: 'Official release' })} />
  ) : null;

  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        width: '100%',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 28,
        background: PANEL_BG,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: '0 20px 44px rgba(0,0,0,0.42), 0 8px 22px rgba(0,0,0,0.28)',
        transition: 'transform 150ms ease-out, opacity 150ms ease-out',
        transform: dragging ? 'scale(0.985)' : undefined,
        opacity: dragging ? 0.7 : dimmed ? 0.94 : 1,
        color: FOREGROUND,
      }}
    >
      <div
        style={{
          display: 'flex',
          height: '100%',
          flexDirection: 'column',
          padding: reduced ? '16px' : '16px 20px 20px',
          justifyContent: reduced || compact ? 'center' : undefined,
        }}
      >
        {/* Content: cover + title (+ subtitle). Layout switches by tier, matching root. */}
        <div
          style={{
            display: 'flex',
            minHeight: 0,
            flex: 1,
            ...(reduced
              ? { alignItems: 'center', gap: 12 }
              : compact
                ? { alignItems: 'center', justifyContent: 'center' }
                : { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }),
          }}
        >
          {reduced ? (
            <>
              <StationTrackCover image={entry.image} title={title} size={64} radius={16} fallbackFontSize="1.5rem" entityType={entry.entityType} loading={loading} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <h3 style={{ ...clamp(2), margin: 0, fontSize: '0.875rem', fontWeight: 600, lineHeight: 1.35, color: FOREGROUND }}>
                  {title}
                </h3>
              </div>
            </>
          ) : compact ? (
            <div style={{ display: 'flex', width: '100%', maxWidth: 320, alignItems: 'center', gap: 16 }}>
              <StationTrackCover image={entry.image} title={title} size={80} radius={18} fallbackFontSize="1.75rem" entityType={entry.entityType} loading={loading} />
              <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, lineHeight: 1.35, color: FOREGROUND }}>
                  <span style={{ display: 'inline-flex', width: '100%', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    {officialMark}
                    <span style={{ ...clamp(2), minWidth: 0, flex: 1 }}>{title}</span>
                  </span>
                </h3>
                {subtitle ? (
                  <p style={{ ...clamp(3), margin: '8px 0 0', fontSize: '0.875rem', lineHeight: 1.5, color: MUTED }}>{subtitle}</p>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <StationTrackCover image={entry.image} title={title} radius={22} fallbackFontSize="2.25rem" fill entityType={entry.entityType} loading={loading} />
              <div style={{ marginTop: 20, width: '100%', maxWidth: 260 }}>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, lineHeight: 1.35, color: FOREGROUND }}>
                  <span style={{ display: 'inline-flex', width: '100%', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    {officialMark}
                    <span style={{ ...clamp(3), minWidth: 0 }}>{title}</span>
                  </span>
                </h3>
                {subtitle ? (
                  <p style={{ ...clamp(3), margin: '8px 0 0', fontSize: '0.875rem', lineHeight: 1.5, color: MUTED }}>{subtitle}</p>
                ) : null}
              </div>
            </>
          )}
        </div>

        {/* Centered type badge (hidden on the reduced tier) — root's outline pill with the entity
            glyph, tinted with the entity's design-lib accent hue (`--ps-entity-*`, the same hue
            the site's four-corner card borders use) so the type reads by color as well as shape. */}
        {!reduced && showBadge ? (
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Badge
              variant="outline"
              style={{
                borderColor: 'transparent',
                borderRadius: 9999,
                padding: '4px 12px',
                fontSize: 11,
                boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                background: active
                  ? `color-mix(in oklab, var(${meta.colorVar}) 30%, transparent)`
                  : `color-mix(in oklab, var(${meta.colorVar}) 16%, transparent)`,
                color: `var(${meta.colorVar})`,
              }}
            >
              <Icon name={meta.icon} style={{ height: 14, width: 14 }} aria-hidden />
              <span>{meta.label}</span>
            </Badge>
          </div>
        ) : null}

        {/* Swap-only notice — this entry can't start a stage by itself (a world has no audio to mix;
            an orbiter may lack its reference track) but swaps into a live one. Hidden on the reduced
            tier like the badge. */}
        {!reduced && swapOnly ? (
          <p style={{ margin: '8px 0 0', textAlign: 'center', fontSize: '0.75rem', color: MUTED_SOFT }}>
            Drop onto a playing orbiter
          </p>
        ) : null}

        {/* Active-underline marker — root's `h-[2px] w-12` accent bar under the badge. */}
        <div
          style={{
            margin: '12px auto 0',
            height: 2,
            width: 48,
            borderRadius: 9999,
            transition: 'all 150ms',
            background: active ? ACTIVE_ACCENT : 'transparent',
            opacity: active ? 1 : 0,
          }}
        />
      </div>
    </div>
  );
}
