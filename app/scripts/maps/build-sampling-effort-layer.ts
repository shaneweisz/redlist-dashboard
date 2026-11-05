/**
 * build-sampling-effort-layer: GBIF sampling effort → a Web Mercator PNG
 *
 * Renders El-Gabbas's global sampling-effort raster as a single map overlay.
 * The layer answers the question a record map cannot: whether a blank area is
 * empty because the species isn't there, or because nobody has looked. That is
 * the caveat behind Red List Guidelines §4.10.8 — a record-based AOO is a lower
 * bound — and this is the only thing that makes it visible.
 *
 * Data: https://osf.io/qdwfe/ (all groups, cumulative). Cite El-Gabbas, A.
 * (2026) "A global, taxon-stratified, high-resolution sampling-effort dataset
 * from GBIF for bias-aware ecological modelling", Diversity and Distributions.
 * The README grants use of "the code, pre-computed raster products, or derived
 * outputs" on condition of that citation, which the map attribution carries.
 *
 * Why a pre-rendered PNG rather than reading the GeoTIFF in the browser: the
 * source is ZSTD-compressed, which browsers can't decode without a wasm
 * dependency, and OSF serves no CORS header. Both point the same way — convert
 * once here, serve a plain image.
 *
 * Usage:
 *   npx tsx scripts/maps/build-sampling-effort-layer.ts                 # n_obs at 10km
 *   npx tsx scripts/maps/build-sampling-effort-layer.ts n_sp 5          # species, 5km
 *   npx tsx scripts/maps/build-sampling-effort-layer.ts --out /tmp/x.png
 */

import * as zlib from "zlib";
import { deflateSync } from "zlib";

// Node has had zstd since 22.15; the @types/node pinned here hasn't caught up.
const { zstdDecompressSync } = zlib as unknown as {
  zstdDecompressSync: (buf: Buffer) => Buffer;
};
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";

/**
 * One OSF component per taxonomic group, plus the all-groups one.
 *
 * The published dataset is taxon-stratified: `qdwfe` is only its all-groups
 * component, and nine siblings hold the same products per group. Which matters
 * scientifically — all-groups effort is dominated by birds and casual
 * observation, so a cell can be heavily worked for vertebrates and never
 * botanised. Judging whether a plant's range gap is real wants the plant
 * surface, not the average of everything.
 */
const GROUP_NODES: Record<string, string> = {
  all: "qdwfe",
  amphibia: "g3bxc",
  arachnida: "wzt42",
  aves: "3u8x7",
  fungi: "as68b",
  insecta: "58ze7",
  mammalia: "m2tvk",
  mollusca: "k9pdu",
  reptilia: "hkyvs",
  tracheophyta: "2j98g",
};


/** The all-groups products, which sit flat at the root of their component. */
const ALL_GROUP_FILES: Record<string, Record<number, string>> = {
  n_obs: { 1: "n_obs_1.tif", 5: "n_obs_5.tif", 10: "n_obs_10.tif", 20: "n_obs_20.tif" },
  n_sp: { 1: "n_sp_1.tif", 5: "n_sp_5.tif", 10: "n_sp_10.tif", 20: "n_sp_20.tif" },
};

interface Raster {
  width: number;
  height: number;
  /** Row-major, already cropped to width × height. */
  values: Uint32Array;
}

/**
 * Reads the tiled, ZSTD-compressed GeoTIFF these products ship as.
 *
 * Deliberately narrow: it handles this one layout (classic little-endian TIFF,
 * single uint32 band, 256×256 tiles) and throws on anything else rather than
 * pretending to be a GeoTIFF library.
 */
function readGeoTiff(buf: Buffer): Raster {
  if (buf.readUInt16LE(0) !== 0x4949 || buf.readUInt16LE(2) !== 42) {
    throw new Error("not a classic little-endian TIFF");
  }
  const ifd = buf.readUInt32LE(4);
  const count = buf.readUInt16LE(ifd);
  const tags = new Map<number, { type: number; count: number; valueOffset: number }>();
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    tags.set(buf.readUInt16LE(e), {
      type: buf.readUInt16LE(e + 2),
      count: buf.readUInt32LE(e + 4),
      valueOffset: e + 8,
    });
  }
  const scalar = (tag: number): number => {
    const t = tags.get(tag);
    if (!t) throw new Error(`missing TIFF tag ${tag}`);
    return t.type === 3 ? buf.readUInt16LE(t.valueOffset) : buf.readUInt32LE(t.valueOffset);
  };
  const array = (tag: number): number[] => {
    const t = tags.get(tag);
    if (!t) throw new Error(`missing TIFF tag ${tag}`);
    const size = (t.type === 3 ? 2 : 4) * t.count;
    const at = size > 4 ? buf.readUInt32LE(t.valueOffset) : t.valueOffset;
    const out: number[] = [];
    for (let i = 0; i < t.count; i++) {
      out.push(t.type === 3 ? buf.readUInt16LE(at + i * 2) : buf.readUInt32LE(at + i * 4));
    }
    return out;
  };

  const width = scalar(256);
  const height = scalar(257);
  if (scalar(258) !== 32 || scalar(277) !== 1) throw new Error("expected a single 32-bit band");
  if (scalar(259) !== 50000) throw new Error(`expected ZSTD compression, got ${scalar(259)}`);
  const tileWidth = scalar(322);
  const tileHeight = scalar(323);
  const offsets = array(324);
  const byteCounts = array(325);

  const across = Math.ceil(width / tileWidth);
  const values = new Uint32Array(width * height);
  for (let t = 0; t < offsets.length; t++) {
    if (byteCounts[t] === 0) continue;
    const tile = new Uint32Array(
      zstdDecompressSync(buf.subarray(offsets[t], offsets[t] + byteCounts[t])).buffer
    );
    const x0 = (t % across) * tileWidth;
    const y0 = Math.floor(t / across) * tileHeight;
    for (let ty = 0; ty < tileHeight; ty++) {
      const y = y0 + ty;
      // Tiles are padded out past the image edge; that padding isn't data.
      if (y >= height) break;
      for (let tx = 0; tx < tileWidth; tx++) {
        const x = x0 + tx;
        if (x >= width) break;
        values[y * width + x] = tile[ty * tileWidth + tx];
      }
    }
  }
  return { width, height, values };
}

/**
 * Viridis, sampled. Perceptually uniform and colour-blind safe, and — the
 * reason it's used for this kind of surface everywhere — it reads as a
 * quantity rather than as a category, which is what separates it from the
 * habitat and ecosystem layers.
 */

/**
 * Warps the plate carrée source into Web Mercator and colours it.
 *
 * The warp is necessary rather than fussy: MapLibre lays an image source
 * linearly across its four corners *in Mercator space*, so handing it an
 * equirectangular image puts everything above the tropics in the wrong place.
 *
 * Zero is drawn fully transparent. There is no nodata in this raster — ocean
 * and unsurveyed land are both plain zero — so painting zero would blanket the
 * world, and leaving it clear is also the more honest reading: colour means
 * somebody looked.
 */
/**
 * Warps the source into Web Mercator and writes the counts themselves.
 *
 * The pixels carry data, not colour: a cell's record count goes into RGB as a
 * plain 24-bit integer, and alpha marks whether there is a count at all. The
 * largest cell in the global raster holds 5,725,330 records against a ceiling
 * of 16,777,215, so every value survives exactly — no log, no clamping, no
 * palette baked into the file.
 *
 * That is what lets the map say "1,240 records in this cell" rather than only
 * showing an orange square, and it makes the colour ramp and its normalisation
 * a style decision instead of a rebuild — this layer had already been rendered
 * three times over nothing but scaling and colour choices.
 *
 * The technique is the one lib/mapping/elevation.ts already reads terrain with:
 * browsers decode PNG natively, so the values come back off a canvas with no
 * decoder to ship.
 */
/** GDAL_NODATA in the published rasters; uint32 max, not a count. */
const NODATA = 4294967295;

function encodeValues(source: Raster, size: number): { rgba: Uint8Array; max: number } {
  let max = 0;
  for (const v of source.values) if (v > max) max = v;
  const rgba = new Uint8Array(size * size * 4);

  const latAt = (row: number) => {
    const merc = 1 - (2 * row) / size;
    return (Math.atan(Math.sinh(Math.PI * merc)) * 180) / Math.PI;
  };
  const srcRow = (lat: number) =>
    Math.min(source.height, Math.max(0, Math.round(((90 - lat) / 180) * source.height)));

  for (let y = 0; y < size; y++) {
    // Every source row this output row covers. Point-sampling skipped cells
    // near the equator and repeated them near the poles, which showed up as
    // speckle.
    for (let x = 0; x < size; x++) {
      // The source cell containing this pixel's centre, not the mean of every
      // cell it touches.
      //
      // Averaging was added to kill speckle at 2048, where a pixel covered
      // several source cells. At 4096 a pixel is barely wider than a cell, so
      // it straddles two — and a mean of two counts is not a count. Over Bogotá
      // it read 6,709: the average of a city cell holding 12,553 and the
      // hillside beside it holding 864, reported as the number of records in
      // the hillside. Nearest keeps the figure a real count of a real cell,
      // which is what the panel claims it is and what a link to GBIF can be
      // checked against.
      const sy = Math.min(source.height - 1, srcRow(latAt(y + 0.5)));
      const sx = Math.min(source.width - 1, Math.floor(((x + 0.5) / size) * source.width));
      const value = source.values[sy * source.width + sx];
      if (!Number.isFinite(value) || value <= 0 || value === NODATA) continue;

      const o = (y * size + x) * 4;
      rgba[o] = (value >> 16) & 0xff;
      rgba[o + 1] = (value >> 8) & 0xff;
      rgba[o + 2] = value & 0xff;
      // Alpha is presence, not opacity — the client decides how to draw it.
      rgba[o + 3] = 255;
    }
  }
  return { rgba, max };
}

/** Minimal PNG encoder — a truecolour-with-alpha image is four chunks. */
function encodePng(rgba: Uint8Array, size: number): Buffer {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE: Int32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) | 0;
}

/**
 * A fetch that backs off rather than giving up.
 *
 * A group total is the sum of its descendants, which for birds means 42 files
 * from one host, and OSF starts refusing part-way through — returning an HTML
 * error page where JSON was expected. Retrying with a growing pause is both
 * what recovers the build and the polite thing to do to a free archive: the
 * alternative is hammering it and calling the result a failure.
 */
async function politeFetch(url: string, attempt = 0): Promise<Response> {
  const response = await fetch(url);
  if (response.ok) return response;
  if (attempt >= 5) throw new Error(`OSF returned ${response.status} for ${url}`);
  const wait = 2000 * 2 ** attempt;
  console.log(`    OSF said ${response.status}; waiting ${wait / 1000}s…`);
  await new Promise((r) => setTimeout(r, wait));
  return politeFetch(url, attempt + 1);
}

/** A courtesy gap between requests, so a 42-file group isn't a burst. */
const PAUSE_MS = 350;
const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));

/** The OSF listing pages; a folder can hold hundreds of files. */
async function listFiles(url: string) {
  const out: { name: string; kind: string; download: string; folderUrl: string }[] = [];
  let next: string | null = url;
  while (next) {
    const page = (await (await politeFetch(next)).json()) as {
      data?: { attributes: { name: string; kind: string }; links: { download?: string };
               relationships?: { files?: { links: { related: { href: string } } } } }[];
      links?: { next?: string | null };
    };
    for (const f of page.data ?? []) {
      out.push({
        name: f.attributes.name,
        kind: f.attributes.kind,
        download: f.links.download ?? "",
        folderUrl: f.relationships?.files?.links.related.href ?? "",
      });
    }
    next = page.links?.next ?? null;
  }
  return out;
}

async function findInFolder(url: string, name: string): Promise<string> {
  const entry = (await listFiles(url)).find((f) => f.name === name);
  if (!entry) throw new Error(`${name} not found on OSF`);
  return entry.download;
}

async function findFolder(url: string, name: string): Promise<string> {
  const entry = (await listFiles(url)).find((f) => f.name === name && f.kind === "folder");
  if (!entry) throw new Error(`folder ${name} not found on OSF`);
  return `${entry.folderUrl}?page[size]=100`;
}

async function main() {
  // Flags take a value, so both have to come out before what's left can be read
  // positionally — dropping only the "--name" left its value to be mistaken for
  // the metric, and `--out x.png` was read as a request for a metric called
  // "x.png".
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags.set(argv[i], argv[++i] ?? "");
    else positional.push(argv[i]);
  }
  const group = flags.get("--group") ?? "all";
  const metric = positional[0] ?? "n_obs";
  const resolution = Number(positional[1] ?? 10);
  // 4096 across the world is 9.8 km per pixel at the equator, which is what a
  // 10 km source actually carries. The old 2048 threw away half of it.
  const size = Number(flags.get("--size") ?? 4096);
  const out = flags.get("--out") ?? `sampling-effort-${group}-${metric}-${resolution}km.png`;

  const node = GROUP_NODES[group];
  if (!node) throw new Error(`unknown group "${group}" — one of ${Object.keys(GROUP_NODES).join(", ")}`);

  let download: string;
  if (group === "all") {
    const name = ALL_GROUP_FILES[metric]?.[resolution];
    if (!name) throw new Error(`no all-groups product for ${metric} at ${resolution}km`);
    console.log(`Finding ${name} on OSF component ${node}…`);
    download = await findInFolder(`https://api.osf.io/v2/nodes/${node}/files/osfstorage/?page[size]=100`, name);
  } else {
    // A group has no raster of its own: the published components hold one file
    // per descendant clade and year, and the author's own accessor builds a
    // group total by combining the descendants' totals. Record counts add, so
    // summing them is the same surface.
    const folder = `res_${resolution}_${metric}`;
    console.log(`Finding ${folder} on OSF component ${node}…`);
    const folderUrl = await findFolder(`https://api.osf.io/v2/nodes/${node}/files/osfstorage/?page[size]=100`, folder);
    const parts = (await listFiles(folderUrl)).filter((f) =>
      f.name.endsWith(`_total_res_${resolution}.tif`)
    );
    if (parts.length === 0) throw new Error(`no descendant totals in ${folder}`);
    console.log(`  summing ${parts.length} descendant totals`);

    let summed: Raster | null = null;
    for (const part of parts) {
      const bytes = Buffer.from(await (await politeFetch(part.download)).arrayBuffer());
      await pause();
      const raster = readGeoTiff(bytes);
      if (!summed) {
        summed = raster;
      } else {
        if (raster.width !== summed.width || raster.height !== summed.height) {
          throw new Error(`${part.name} is ${raster.width}×${raster.height}, expected ${summed.width}×${summed.height}`);
        }
        for (let i = 0; i < summed.values.length; i++) summed.values[i] += raster.values[i];
      }
      process.stdout.write(`    ${part.name.padEnd(48)}\r`);
    }
    console.log(`  summed ${parts.length} rasters${" ".repeat(40)}`);
    return await finish(summed!, size, out);
  }

  console.log(`Downloading ${download}…`);
  const buf = Buffer.from(await (await politeFetch(download)).arrayBuffer());
  console.log(`  ${(buf.length / 1e6).toFixed(2)} MB`);

  const raster = readGeoTiff(buf);
  await finish(raster, size, out);
}

async function finish(raster: Raster, size: number, out: string) {
  console.log(`Decoded ${raster.width} × ${raster.height}`);
  const { rgba, max } = encodeValues(raster, size);
  const png = encodePng(rgba, size);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`Wrote ${out} — ${size} × ${size}, ${(png.length / 1e6).toFixed(2)} MB, max ${max.toLocaleString()} per cell`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
