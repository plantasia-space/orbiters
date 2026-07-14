/**
 * @file src/ui/react/studio/entityMeta.ts
 * @description One canonical descriptor per collection entity kind for the arrange UI — the display label,
 * the count-row noun, and the design-lib icon name. Both the card (`StationTrackCard`: badge label + glyph)
 * and the drawer (`CardDrawer`: count row) read from HERE, so a new entity type is added once and the
 * label / icon / count noun can never silently drift apart across parallel switches.
 */
export interface EntityMeta {
  /** Title-cased badge label (no all-caps). */
  label: string;
  /** Lowercase singular noun for the count row ("3 audios"). */
  noun: string;
  /** The design-lib `Icon name` for the entity glyph. */
  icon: string;
  /** The design-lib entity-frame class for the cover image (entity-frames.css, shipped in the
   *  lib's precompiled styles.css) — each core entity reads by the SHAPE of its frame across the
   *  whole platform: track = square, orbiter = hexagon, world = circle. The same classes the
   *  site's mini-cards use. Null = no signature shape (the default rounded tile). */
  frameClass: string | null;
  /** The design-lib entity accent token (`--ps-entity-*`, tokens.css) — one accent hue per entity
   *  type, the same hue the site uses (e.g. the four-corner card borders). Tints the type badge. */
  colorVar: string;
}

const TRACK: EntityMeta = { label: 'Audio', noun: 'audio', icon: 'track', frameClass: 'track-square-frame', colorVar: '--ps-entity-track' };
const ORBITER: EntityMeta = { label: 'Orbiter', noun: 'orbiter', icon: 'orbiter', frameClass: 'hexagon-mask', colorVar: '--ps-entity-orbiter' };
const WORLD: EntityMeta = { label: 'World', noun: 'world', icon: 'entangled-world', frameClass: 'user-square-frame', colorVar: '--ps-entity-world' };
const ITEM: EntityMeta = { label: 'Item', noun: 'card', icon: 'collection', frameClass: null, colorVar: '--ps-entity-collection' };

/** Resolve a raw `entityType` string to its canonical descriptor (unknown → a generic "Item" / "card"). */
export function entityMeta(entityType: string | null | undefined): EntityMeta {
  switch (entityType) {
    case 'track':
      return TRACK;
    case 'orbiter':
      return ORBITER;
    case 'world':
    case 'entangled-world':
      return WORLD;
    default:
      return ITEM;
  }
}
