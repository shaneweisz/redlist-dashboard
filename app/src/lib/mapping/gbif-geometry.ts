/**
 * Turning a protected area's boundary into something GBIF will accept.
 *
 * GBIF's occurrence search takes a `geometry=` parameter in WKT, which is what
 * lets "what is threatened *inside this national park*" be asked at all rather
 * than approximated with a circle. Two things stand between a WDPA boundary and
 * a working query, and both fail silently or confusingly:
 *
 * **Winding order decides which side of the line you get.** GBIF reads a
 * polygon's exterior ring as counter-clockwise. Hand it a clockwise ring and it
 * does not complain — it answers about the entire rest of the planet. Measured:
 * a box around the Cape Peninsula returned 34,183 records counter-clockwise and
 * 1,195,439 records clockwise. The WDPA geometry arrives from ArcGIS in Esri's
 * convention, which is the opposite one (clockwise encloses, counter-clockwise
 * cuts a hole), so every ring has to be turned round on the way out.
 *
 * **The limit is the URL, not the vertex count.** GBIF rejects a request whose
 * URL runs past about 4 KB — a Tomcat-level 400 with an HTML body, or, a little
 * further out, a connection error before any response at all. Binary-searched
 * against a synthetic circle: a 3,853-byte URL answered 200 and a 3,874-byte one
 * was refused, and padding an unrelated parameter crossed the same line, which
 * is what shows it is length and not geometry. So the budget below is measured
 * on the encoded URL, and a boundary is simplified until it fits.
 *
 * What "fits" costs: a small reserve goes over whole, and a big serial site
 * (the Cape Floral Region's 126 parcels, 10,108 vertices, 190 KB of WKT) does
 * not and cannot. Rather than refuse it, the boundary is simplified, and if
 * that is still not enough its smallest parcels are dropped — and what came
 * back says so, so the UI can tell the reader the edges it searched were not
 * quite the edges on the map.
 */

/**
 * Bytes of encoded URL a geometry query may occupy.
 *
 * Under the ~3,860 measured ceiling with room for the rest of the query string
 * — `checklistKey`, the category filters, the facet parameters — which together
 * run to a couple of hundred bytes, and for GBIF moving the line.
 */
export const GBIF_URL_BUDGET = 3400;

/** Coordinate precision in the WKT. Five decimals is a bit over a metre. */
const PRECISION = 5;

/**
 * Tolerances tried in turn, in degrees. The first that fits the budget wins, so
 * a boundary is never simplified more than it has to be — 0 means "as supplied"
 * and is always tried first.
 *
 * The ladder stops at 0.005°, a little over 500 m, and the ceiling is a
 * correctness limit rather than a taste one. Past it, neighbouring parcels of
 * the same site are pushed far enough out of shape to overlap each other, and
 * GBIF rejects a MULTIPOLYGON whose parts intersect exactly as it rejects a
 * ring that crosses itself. A site too big to fit at 500 m loses its smallest
 * parcels instead, which is a loss the caller can describe honestly; a boundary
 * bulldozed by 5 km is one nobody can.
 */
const TOLERANCES = [0, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005];

export interface GbifGeometry {
  /** WKT, wound the way GBIF reads it, and inside the URL budget. */
  wkt: string;
  /** The boundary this WKT describes, for drawing what was actually searched. */
  geometry: GeoJSON.MultiPolygon;
  /** True when the boundary searched is not the boundary supplied. */
  simplified: boolean;
  /** Parcels searched, and parcels the site actually has. */
  polygons: number;
  sourcePolygons: number;
  /** Vertices searched, and vertices the site actually has. */
  vertices: number;
  sourceVertices: number;
}

/** Twice the signed area of a closed ring. Positive is counter-clockwise. */
function signedArea(ring: GeoJSON.Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum;
}

/** The ring, turned round if it isn't already wound the way asked for. */
function wind(ring: GeoJSON.Position[], counterClockwise: boolean): GeoJSON.Position[] {
  const ccw = signedArea(ring) > 0;
  return ccw === counterClockwise ? ring : [...ring].reverse();
}

/** Ramer–Douglas–Peucker over an open chain of points. */
function rdp(points: GeoJSON.Position[], epsilon: number): GeoJSON.Position[] {
  if (points.length < 3) return points;
  const [first, last] = [points[0], points[points.length - 1]];
  const [dx, dy] = [last[0] - first[0], last[1] - first[1]];
  const length = Math.hypot(dx, dy);
  let farthest = 0;
  let worst = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const distance =
      length === 0
        ? Math.hypot(x - first[0], y - first[1])
        : Math.abs(dy * x - dx * y + last[0] * first[1] - last[1] * first[0]) / length;
    if (distance > worst) {
      worst = distance;
      farthest = i;
    }
  }
  if (worst <= epsilon) return [first, last];
  return [
    ...rdp(points.slice(0, farthest + 1), epsilon).slice(0, -1),
    ...rdp(points.slice(farthest), epsilon),
  ];
}

/** The ring at the precision the WKT will carry, with repeats collapsed. */
function roundRing(ring: GeoJSON.Position[]): GeoJSON.Position[] {
  const out: GeoJSON.Position[] = [];
  for (const [x, y] of ring) {
    const point: GeoJSON.Position = [+x.toFixed(PRECISION), +y.toFixed(PRECISION)];
    const last = out[out.length - 1];
    // Rounding is not a formatting step that happens later: two vertices a
    // centimetre apart become the same point in the WKT, and a zero-length
    // segment is what GBIF reports as "too few distinct points". So the ring is
    // rounded here, before it is measured or checked.
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  if (out.length < 2) return out;
  const [first, last] = [out[0], out[out.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([...first]);
  return out;
}

/** Which side of ab c falls on: -1, 0 or 1. */
const side = (a: GeoJSON.Position, b: GeoJSON.Position, c: GeoJSON.Position) =>
  Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));

/** Whether c lies within the bounding box of ab. */
const inBox = (a: GeoJSON.Position, b: GeoJSON.Position, c: GeoJSON.Position) =>
  Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);

/**
 * Whether two segments cross, counting a touch as a crossing.
 *
 * The collinear case has to be handled separately, and it is not a theoretical
 * nicety: simplification routinely leaves two stretches of a boundary lying
 * along the same line, and every orientation test then answers zero, so the
 * sign comparison alone sees nothing. GBIF sees it — "Self-intersection at or
 * near point (18.41034, -33.92014)" on a ring this function had already passed.
 */
function segmentsCross(
  a: GeoJSON.Position, b: GeoJSON.Position,
  c: GeoJSON.Position, d: GeoJSON.Position
): boolean {
  const [d1, d2, d3, d4] = [side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)];
  if (d1 !== d2 && d3 !== d4) return true;
  // All four collinear: they overlap if either segment's endpoint lies within
  // the other's extent.
  if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
    return inBox(a, b, c) || inBox(a, b, d) || inBox(c, d, a) || inBox(c, d, b);
  }
  return false;
}

/**
 * Whether a closed ring touches or crosses itself.
 *
 * Worth the quadratic cost, because this is exactly what Douglas–Peucker does
 * wrong: it moves each vertex towards a chord independently, and on a concave
 * outline two stretches simplified towards each other can end up on the wrong
 * sides. GBIF refuses the result outright — "Invalid geometry: Self-intersection
 * at or near point (18.40490, -33.99612)" for a Table Mountain parcel — so a
 * ring that fails here is not a cosmetic problem, it is a query that returns
 * nothing but an error.
 */
function isSimpleRing(ring: GeoJSON.Position[]): boolean {
  const open = ring.slice(0, -1);
  const n = open.length;
  if (n < 3) return false;
  // A vertex repeated away from its neighbours pinches the ring shut, which
  // GBIF reads as a self-intersection too.
  const seen = new Set<string>();
  for (const [x, y] of open) {
    const key = `${x},${y}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      // Segment n-1 and segment 0 share a vertex; they are neighbours, not a
      // crossing.
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(open[i], open[(i + 1) % n], open[j], open[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Whether two closed rings touch or cross each other. */
function ringsCross(a: GeoJSON.Position[], b: GeoJSON.Position[]): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

/** Whether a point falls inside a closed ring, by ray casting. */
function contains(ring: GeoJSON.Position[], [x, y]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Above this many vertices a ring is not checked for validity.
 *
 * The check is quadratic, and the budget only ever admits on the order of a
 * hundred vertices — so a ring this size is certain to be rejected for length a
 * moment later, and paying millions of segment comparisons to find out it is
 * also self-intersecting buys nothing. It is a cost guard on the *check*, and
 * deliberately not a limit on what may be simplified: a ring with four thousand
 * vertices is exactly the one that needs simplifying, and an earlier version
 * that discarded those outright returned nothing at all for every large site.
 */
const MAX_CHECKED_VERTICES = 1200;

/** Whether a ring is small enough to be worth checking, and valid if so. */
const usable = (ring: GeoJSON.Position[]) =>
  ring.length > MAX_CHECKED_VERTICES || isSimpleRing(ring);

/**
 * One closed ring, simplified as far as it can be while staying valid.
 *
 * Two things make this more than a call to Douglas–Peucker.
 *
 * Run naively, RDP destroys a *closed* ring: its baseline is the line between
 * the first and last points, and on a closed ring those are the same point, so
 * every vertex measures as zero distance from a zero-length line and the ring
 * collapses to two points. The fix is the standard one — cut the ring at the
 * vertex farthest from its start and simplify the two chains between those
 * anchors, so there is a real baseline at each step.
 *
 * And RDP can leave a ring crossing itself, which GBIF rejects. So the
 * tolerance asked for is a ceiling rather than an instruction: it is halved
 * until the result is simple, and a ring that will not simplify cleanly is
 * returned as it came. That is the right way round — the source rings are
 * valid (checked against GBIF parcel by parcel), so falling back towards them
 * always terminates somewhere GBIF will accept, at worst costing bytes.
 */
function simplifyRing(ring: GeoJSON.Position[], epsilon: number): GeoJSON.Position[] | null {
  const source = roundRing(ring);
  if (source.length < 4) return null;
  if (epsilon === 0) return usable(source) ? source : null;

  const open = source.slice(0, -1);
  let anchor = 0;
  let worst = -1;
  for (let i = 1; i < open.length; i++) {
    const d = (open[i][0] - open[0][0]) ** 2 + (open[i][1] - open[0][1]) ** 2;
    if (d > worst) {
      worst = d;
      anchor = i;
    }
  }

  for (let e = epsilon; e > 1e-7; e /= 2) {
    const head = rdp(open.slice(0, anchor + 1), e);
    const tail = rdp([...open.slice(anchor), open[0]], e);
    const candidate = roundRing([...head.slice(0, -1), ...tail]);
    // Three distinct corners plus the repeat that closes it. Anything less is
    // a line or a point, and a sliver parcel simplified into one is better
    // dropped than sent to GBIF as a degenerate ring.
    if (candidate.length >= 4 && usable(candidate)) return candidate;
  }
  return usable(source) ? source : null;
}

function ringWkt(ring: GeoJSON.Position[]): string {
  return `(${ring.map(([x, y]) => `${x} ${y}`).join(",")})`;
}

function polygonWkt(polygon: GeoJSON.Position[][]): string {
  return `(${polygon.map(ringWkt).join(",")})`;
}

/** WKT for a set of polygons, as the one type GBIF should read it as. */
function toWkt(polygons: GeoJSON.Position[][][]): string {
  return polygons.length === 1
    ? `POLYGON${polygonWkt(polygons[0])}`
    : `MULTIPOLYGON(${polygons.map(polygonWkt).join(",")})`;
}

const countVertices = (polygons: GeoJSON.Position[][][]) =>
  polygons.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);

/**
 * A boundary's polygons, wound for GBIF and simplified enough to be asked.
 *
 * `esriWinding` says the source uses Esri's convention — clockwise encloses —
 * which is what `esriRingsToMultiPolygon` preserves. It only decides which ring
 * of each polygon is treated as the exterior; the output is always wound the
 * way GBIF reads it.
 */
export function geometryForGbif(
  multiPolygon: GeoJSON.MultiPolygon,
  {
    budget = GBIF_URL_BUDGET,
    baseUrlBytes = 0,
    focus,
  }: {
    budget?: number;
    baseUrlBytes?: number;
    /**
     * The point the site was picked at, as [lng, lat].
     *
     * Only matters when the whole site won't fit: then the parcel containing
     * this point is searched first and the rest fill in around it. A serial
     * site is one name over scattered ground — the Cape Floral Region is 126
     * separate blocks — and "the part you were pointing at" is a far better
     * answer to a click than "the largest block, which is 90 km away".
     */
    focus?: [number, number];
  } = {}
): GbifGeometry | null {
  const source = multiPolygon.coordinates.filter((p) => p.length > 0 && p[0].length >= 4);
  if (source.length === 0) return null;
  const sourceVertices = countVertices(source);
  const allowance = budget - baseUrlBytes;

  /** Rewound and simplified at one tolerance, largest parcel first. */
  const at = (epsilon: number): GeoJSON.Position[][][] =>
    source
      .map((polygon) => {
        const rings: GeoJSON.Position[][] = [];
        for (const [i, ring] of polygon.entries()) {
          const simplified = simplifyRing(ring, epsilon);
          // A hole that simplifies away is simply not cut out any more; an
          // exterior that does takes its parcel with it.
          if (!simplified) {
            if (i === 0) return null;
            continue;
          }
          // A hole is only a hole while it stays inside its parcel and clear of
          // the other holes. Simplified independently it can do three different
          // invalid things: straddle the outline it was cut from, run into a
          // neighbouring hole, or — where the exterior shrank past it — end up
          // wholly outside the shell, which GBIF reports in those words ("Hole
          // lies outside shell at or near point (18.41178, -33.91758)") and
          // which no crossing test catches, because nothing crosses anything.
          // Dropping the hole merely searches a little more ground than the
          // site encloses; keeping it fails the whole query.
          if (i > 0) {
            if (rings.some((kept) => ringsCross(kept, simplified))) continue;
            if (!contains(rings[0], simplified[0] as [number, number])) continue;
          }
          rings.push(wind(simplified, i === 0));
        }
        return rings.length ? rings : null;
      })
      .filter((p): p is GeoJSON.Position[][] => p !== null)
      .sort((a, b) => Math.abs(signedArea(b[0])) - Math.abs(signedArea(a[0])));

  /** The parcels of `polygons` that don't run into one another, in order. */
  const disjoint = (polygons: GeoJSON.Position[][][]): GeoJSON.Position[][][] => {
    const out: GeoJSON.Position[][][] = [];
    for (const polygon of polygons) {
      if (out.every((kept) => !ringsCross(kept[0], polygon[0]))) out.push(polygon);
    }
    return out;
  };

  const fits = (polygons: GeoJSON.Position[][][]) =>
    encodeURIComponent(toWkt(polygons)).length <= allowance;

  const answer = (polygons: GeoJSON.Position[][][], epsilon: number): GbifGeometry => ({
    wkt: toWkt(polygons),
    geometry: { type: "MultiPolygon", coordinates: polygons },
    // Dropped parcels count as simplification as much as moved vertices do:
    // either way the ground searched is not the ground the site covers.
    simplified: epsilon > 0 || polygons.length < source.length,
    polygons: polygons.length,
    sourcePolygons: source.length,
    vertices: countVertices(polygons),
    sourceVertices,
  });

  for (const epsilon of TOLERANCES) {
    const polygons = disjoint(at(epsilon));
    if (polygons.length && fits(polygons)) return answer(polygons, epsilon);
  }

  // Simplifying as hard as we are willing to still doesn't fit — a serial site
  // of scattered parcels, where the vertices are in the *count* of parcels
  // rather than in any one outline. Take the biggest parcels that will fit and
  // report how many were left behind; a search of the three largest blocks of a
  // reserve, labelled as such, beats no search at all.
  const coarsest = disjoint(at(TOLERANCES[TOLERANCES.length - 1]));
  const ordered = focus
    ? [...coarsest].sort((a, b) => Number(contains(b[0], focus)) - Number(contains(a[0], focus)))
    : coarsest;
  const kept: GeoJSON.Position[][][] = [];
  for (const polygon of ordered) {
    // Skipped rather than stopped at: one parcel too detailed to fit is not a
    // reason to abandon the rest of the site. Stopping at the first misfit gave
    // up entirely on any site whose *largest* parcel was the awkward one, which
    // is the common case — the biggest block of a reserve is usually also the
    // most intricately drawn.
    if (!fits([...kept, polygon])) continue;
    kept.push(polygon);
  }
  if (kept.length === 0) return null;
  return answer(kept, TOLERANCES[TOLERANCES.length - 1]);
}

/** A WKT string that is plausibly a polygon this app produced. */
export function isPolygonWkt(value: string): boolean {
  return /^(POLYGON|MULTIPOLYGON)\s*\(/i.test(value.trim());
}
