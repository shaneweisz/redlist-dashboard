/**
 * The occurrence map's dots, grouped by the CoL name GBIF files each under.
 *
 * A species' count can take records under several CoL names: a split's other
 * species, a synonym, a misspelling CoL keeps (docs/specs/matching.md). Drawn
 * alike, the map can't say which dots are which, and a split that doubles a
 * range looks like the species' own. So each name gets a marker shape, and the
 * legend says what each is and why it counts.
 *
 * Groups:
 *   - a CoL species, with its subspecies (filed under its accepted name);
 *   - a synonym or other non-accepted name, on its own: where the Red List and
 *     CoL disagree, the name a record was filed under is the evidence.
 * Colour keeps its meaning (the record's date); shape is the name.
 *
 * Shapes, in order (ggplot2's order, and the research behind it: a shape is told
 * from a circle by its points, so the most pointed comes first): circle,
 * triangle, square, star, inverted triangle. No diamond, which imported point
 * files already draw, and no hexagon, which at a 5px dot is a circle. Each has
 * a circle's area, so no name looks more prominent than another. Five is about
 * as many as a reader can hold; a sixth name and beyond share a plus, as
 * "other names".
 */

/** The CoL filing the occurrence route reads from each record (route.ts, colFiling). */
export interface ColFiling {
  colUsageKey?: string | null;
  colUsageName?: string | null;
  colStatus?: string | null;
  colSpeciesKey?: string | null;
  colSpeciesName?: string | null;
  colPath?: string[] | null;
}

/** A taxon the count claims, as the route's metadata gives it (occurrence-taxa.ts). */
export interface CountedTaxon {
  key: string;
  relation: "is" | "split into" | "part of";
  speciesKey: string;
}

export const SHAPES = ["circle", "triangle", "square", "star", "triangle-down"] as const;
/** The marker every name past the fifth shares. */
export const OTHER_SHAPE = "plus";
export type Shape = (typeof SHAPES)[number] | typeof OTHER_SHAPE;
/** Every shape the map draws, for its images. */
export const ALL_SHAPES: readonly Shape[] = [...SHAPES, OTHER_SHAPE];

export interface TaxonGroup {
  key: string;
  /** The name the records are filed under. */
  name: string;
  /** "species": a CoL species, with its subspecies; "synonym": a name CoL doesn't accept. */
  kind: "species" | "synonym" | "unfiled";
  /** For a synonym, the CoL species it leads to. */
  speciesName: string | null;
  /** How the count takes it; null when no claimed taxon explains it. */
  relation: CountedRelationOrNull;
  /** The claimed taxon's key, for its total (route metadata taxonTotals). */
  taxonKey: string | null;
  shape: Shape;
  /** Past the fifth name: shares the plus, and the legend folds it into "other names". */
  other: boolean;
  /** Records loaded in the group. */
  loaded: number;
  /** The species' own name: the group the matcher's answer is. */
  primary: boolean;
}
type CountedRelationOrNull = CountedTaxon["relation"] | null;

const ACCEPTED = new Set(["ACCEPTED", "PROVISIONALLY_ACCEPTED", "DOUBTFUL"]);

/** The group a record belongs to, by its filing alone. */
export function groupKeyOf(f: ColFiling): string {
  if (!f.colUsageKey) return "unfiled";
  if (f.colStatus && !ACCEPTED.has(f.colStatus)) return `name:${f.colUsageKey}`;
  return `species:${f.colSpeciesKey ?? f.colUsageKey}`;
}

/**
 * The groups among `records`, the species' own first, then by the CoL species
 * they lead to (the most records first), each species before its synonyms.
 * Five shapes; a sixth group and beyond share the plus.
 */
export function taxonGroups(records: ColFiling[], counted: CountedTaxon[]): TaxonGroup[] {
  const partOf = new Map(counted.filter((t) => t.relation === "part of").map((t) => [t.key, t]));
  const whole = new Map(counted.filter((t) => t.relation !== "part of").map((t) => [t.speciesKey, t]));
  const primaryKey = counted[0]
    ? counted[0].relation === "part of" ? `name:${counted[0].key}` : `species:${counted[0].speciesKey}`
    : null;

  const groups = new Map<string, Omit<TaxonGroup, "shape" | "other"> & { speciesKey: string | null }>();
  for (const f of records) {
    const key = groupKeyOf(f);
    let g = groups.get(key);
    if (!g) {
      const synonym = key.startsWith("name:");
      // A part-of record claims its own name; anything else is taken through
      // the CoL species it leads to.
      const claim = synonym && f.colUsageKey ? partOf.get(f.colUsageKey) ?? partOfAbove(f, partOf) : undefined;
      const viaSpecies = f.colSpeciesKey ? whole.get(f.colSpeciesKey) : undefined;
      const taxon = claim ?? viaSpecies ?? (key === "unfiled" ? undefined : partOfAbove(f, partOf));
      g = {
        key,
        name: key === "unfiled" ? "Not filed in CoL" : synonym ? f.colUsageName ?? "?" : f.colSpeciesName ?? f.colUsageName ?? "?",
        kind: key === "unfiled" ? "unfiled" : synonym ? "synonym" : "species",
        speciesName: synonym ? f.colSpeciesName ?? null : null,
        relation: taxon?.relation ?? null,
        // A taxon's total is for the whole claimed taxon: its species row for a
        // whole species, its own row for a part-of name.
        taxonKey: taxon && (synonym ? taxon.relation === "part of" && taxon.key === f.colUsageKey : true) ? taxon.key : null,
        loaded: 0,
        primary: key === primaryKey,
        speciesKey: f.colSpeciesKey ?? null,
      };
      groups.set(key, g);
    }
    g.loaded++;
  }

  // The species each group leads to, ranked: the primary group's first, then
  // by records loaded.
  const bySpecies = new Map<string, number>();
  for (const g of groups.values()) bySpecies.set(g.speciesKey ?? g.key, (bySpecies.get(g.speciesKey ?? g.key) ?? 0) + g.loaded);
  const primary = primaryKey ? groups.get(primaryKey) : undefined;
  const rank = (g: { speciesKey: string | null; key: string; primary: boolean; kind: string; loaded: number }) => [
    g.primary ? 0 : 1,
    primary && (g.speciesKey ?? g.key) === (primary.speciesKey ?? primary.key) ? 0 : 1,
    -(bySpecies.get(g.speciesKey ?? g.key) ?? 0),
    g.speciesKey ?? g.key,
    g.kind === "species" ? 0 : 1,
    -g.loaded,
  ] as const;
  const sorted = [...groups.values()].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
    return 0;
  });
  return sorted.map(({ speciesKey: _s, ...g }, i) => ({ ...g, shape: SHAPES[i] ?? OTHER_SHAPE, other: i >= SHAPES.length }));
}

/** A part-of claim on a record filed beneath the claimed name (a subspecies under a synonym). */
function partOfAbove(f: ColFiling, partOf: Map<string, CountedTaxon>): CountedTaxon | undefined {
  for (const k of f.colPath ?? []) {
    const t = partOf.get(k);
    if (t) return t;
  }
  return undefined;
}

/** A CoL species drawn for context (occurrence-taxa.ts ContextTaxon): why it is there. */
export interface ContextTaxon {
  key: string;
  why: "rest" | "split";
}

export interface ContextGroup {
  /** The CoL species' key. */
  key: string;
  name: string;
  why: ContextTaxon["why"];
  shape: Shape;
  loaded: number;
}

/**
 * The context's records by the CoL species each leads to, the most records
 * first, a shape each (hollow on the map: none of them count). A record whose
 * species isn't one asked for (a re-filed id) goes to the first.
 */
export function contextGroups(records: ColFiling[], context: ContextTaxon[]): ContextGroup[] {
  const why = new Map(context.map((c) => [c.key, c.why]));
  const groups = new Map<string, ContextGroup>();
  for (const f of records) {
    const key = f.colSpeciesKey ?? f.colUsageKey ?? "?";
    let g = groups.get(key);
    if (!g) {
      g = { key, name: f.colSpeciesName ?? f.colUsageName ?? "?", why: why.get(key) ?? context[0]?.why ?? "rest", shape: "circle", loaded: 0 };
      groups.set(key, g);
    }
    g.loaded++;
  }
  return [...groups.values()]
    .sort((a, b) => b.loaded - a.loaded || a.name.localeCompare(b.name))
    .map((g, i) => ({ ...g, shape: SHAPES[i] ?? OTHER_SHAPE }));
}

/** What the legend and the record panel say about a context species. */
export function contextNote(why: ContextTaxon["why"], speciesName: string | null | undefined): string {
  const of = speciesName ? ` ${speciesName}` : " this species";
  return why === "split"
    ? `A CoL species split from${of}. It needs its own assessment.`
    : `Filed by CoL under the same species as${of}, but not under its name.`;
}

/** Is a record one the count claims? For the context layer, which shows only the others. */
export function isClaimed(f: ColFiling, counted: CountedTaxon[]): boolean {
  const keys = new Set(counted.map((t) => t.key));
  if (f.colUsageKey && keys.has(f.colUsageKey)) return true;
  if (f.colSpeciesKey && counted.some((t) => t.relation !== "part of" && t.speciesKey === f.colSpeciesKey)) return true;
  return (f.colPath ?? []).some((k) => keys.has(k) && counted.some((t) => t.key === k && t.relation === "part of"));
}

/** What the legend says about a group, after its name. */
export function groupNote(g: TaxonGroup): string {
  if (g.kind === "unfiled") return "no CoL name on the record";
  const of = g.speciesName ? ` of ${g.speciesName}` : "";
  if (g.kind === "synonym") {
    if (g.relation === "part of") return `synonym${of}; only these count`;
    return g.relation ? `synonym${of}, counted` : `synonym${of}`;
  }
  if (g.relation === "split into") return "CoL species split from it, counted";
  return g.primary ? "CoL species" : g.relation ? "CoL species, counted" : "CoL species";
}

// ─── Marker images ───────────────────────────────────────────────────────────

/** The image ids the symbol layer draws: `occ-shape-<shape>`, and `occ-shape-hollow-<shape>` for context. */
export const SHAPE_IMAGE_PREFIX = "occ-shape-";
export const HOLLOW_IMAGE_PREFIX = "occ-shape-hollow-";
/** A hollow shape's outline width, in pixels. */
const HOLLOW_WIDTH = 1.4;
/** The shape's half-width, in image pixels: icon-size = radius / SHAPE_RADIUS. A dot's own radius, so icon-size stays near 1: scaled down, MapLibre widens an SDF's antialiasing into a haze. */
export const SHAPE_RADIUS = 5;
const SDF_RADIUS = 8;

/** A polygon's area (shoelace). */
function polygonArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
}

/**
 * A shape's outline, as a polygon around 0 with the unit circle's area, π
 * (circle: none). Centred on its centroid, so a triangle sits where a circle
 * would.
 */
export function shapePolygon(shape: Shape): [number, number][] | null {
  const ring = (n: number, start: number, radius: (i: number) => number = () => 1) =>
    Array.from({ length: n }, (_, i) => {
      const a = start + (i * 2 * Math.PI) / n;
      return [radius(i) * Math.cos(a), radius(i) * Math.sin(a)] as [number, number];
    });
  // Screen y runs down: a point up is at negative y.
  const raw: [number, number][] | null = (() => {
    switch (shape) {
      case "circle": return null;
      case "triangle": return ring(3, -Math.PI / 2);
      case "triangle-down": return ring(3, Math.PI / 2);
      case "square": return ring(4, Math.PI / 4);
      case "star": return ring(10, -Math.PI / 2, (i) => (i % 2 ? 0.5 : 1));
      case "plus": {
        const w = 0.36;
        return [[-w, -1], [w, -1], [w, -w], [1, -w], [1, w], [w, w], [w, 1], [-w, 1], [-w, w], [-1, w], [-1, -w], [-w, -w]];
      }
    }
  })();
  if (!raw) return null;
  const k = Math.sqrt(Math.PI / polygonArea(raw));
  return raw.map(([x, y]) => [x * k, y * k]);
}

/** How far a shape reaches from its centre, in units of the circle's radius. */
function extent(shape: Shape): number {
  const poly = shapePolygon(shape);
  return poly ? Math.max(...poly.map(([x, y]) => Math.hypot(x, y))) : 1;
}

/** Signed distance from (x, y) to a polygon: negative inside. */
function polygonDistance(x: number, y: number, poly: [number, number][]): number {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    const dx = xj - xi, dy = yj - yi;
    const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / (dx * dx + dy * dy)));
    d = Math.min(d, Math.hypot(x - (xi + t * dx), y - (yi + t * dy)));
  }
  return inside ? -d : d;
}

/**
 * A shape as a signed distance field, the form MapLibre tints (`icon-color`)
 * and outlines (`icon-halo-*`) per feature: the same encoding as its glyphs
 * (TinySDF's radius 8, cutoff 0.25), so a halo of N pixels is N pixels.
 */
export function shapeSdf(shape: Shape, hollow = false): { width: number; height: number; data: Uint8Array } {
  const SIZE = 2 * Math.ceil(SHAPE_RADIUS * extent(shape) + SDF_RADIUS + 2);
  const data = new Uint8Array(SIZE * SIZE * 4);
  const poly = shapePolygon(shape);
  const c = SIZE / 2;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const x = (px + 0.5 - c) / SHAPE_RADIUS, y = (py + 0.5 - c) / SHAPE_RADIUS;
      const edge = (poly ? polygonDistance(x, y, poly) : Math.hypot(x, y) - 1) * SHAPE_RADIUS;
      // Hollow: the outline alone, a band either side of the edge.
      const d = hollow ? Math.abs(edge) - HOLLOW_WIDTH / 2 : edge;
      const a = Math.round(255 - 255 * (d / SDF_RADIUS + 0.25));
      data[(py * SIZE + px) * 4 + 3] = Math.max(0, Math.min(255, a));
    }
  }
  return { width: SIZE, height: SIZE, data };
}

/** The legend's box: a viewBox of ±LEGEND_BOX, the circle's radius 4. */
export const LEGEND_BOX = 7;

/** The SVG path of a shape around 0, the circle's radius 4, for the legend. */
export function shapeSvgPath(shape: Shape): string {
  const poly = shapePolygon(shape);
  if (!poly) return "M0 -4a4 4 0 1 1 0 8a4 4 0 1 1 0-8z";
  return poly.map(([x, y], i) => `${i ? "L" : "M"}${(x * 4).toFixed(2)} ${(y * 4).toFixed(2)}`).join("") + "Z";
}
