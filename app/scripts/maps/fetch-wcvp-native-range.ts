/**
 * fetch-wcvp-native-range: build a per-species native-country lookup from Kew's
 * World Checklist of Vascular Plants (WCVP), for the "POWO" native-range source
 * option in OccurrenceMapRow.tsx (issue #82) — alongside the existing Red List
 * assessment-location-based source (`s.countries`).
 *
 * Source data: https://sftp.kew.org/pub/data-repositories/WCVP/wcvp.zip (CC-BY,
 * Govaerts et al. 2021, Sci Data 8:215) — `wcvp_names.csv` (taxon name -> accepted
 * name resolution) and `wcvp_distribution.csv` (accepted name -> native/introduced/
 * extinct TDWG WGSRPD level-3 area codes). Both pipe-delimited, no real quoting
 * (some author-name fields contain literal apostrophes, so `quote=''` is required
 * or DuckDB misparses them as unterminated quotes).
 *
 * TDWG level-3 area codes (e.g. "FRA", "COS") are matched to ISO 3166-1 alpha-2
 * country codes via the original Brummitt Ed.2 WGSRPD table
 * (tdwg/wgsrpd, 109-488-1-ED/2nd Edition/tblLevel3.txt, `*`-delimited, Latin-1
 * encoded) — chosen over rWCVP's own `wgsrpd_mapping` crosswalk (Gallagher et al.
 * 2020) because that one only exists as an R `.rda` binary with no plain-text
 * source in the package repo. 41 of 369 L3 codes (11%) have no ISO code in the
 * official table — a mix of genuine multi-country composites (Baltic States,
 * Transcaucasus, ...) and a handful of single-country gaps that look like data-entry
 * omissions (Austria, Belgium, France, Italy, Spain, Ukraine, ...), confirmed by
 * cross-checking that OTHER L3 codes for the same country (e.g. Russia's four other
 * L3 subdivisions) do have an ISO code filled in. WGSRPD_OVERRIDES below patches
 * the confident cases (single country, or an unambiguous small multi-country set)
 * and leaves the rest unmapped — matching this codebase's existing "don't flag what
 * we can't determine" convention (see isOutsideReportedCountry/isOutsideNativeRange).
 *
 * Covers the FULL WCVP checklist, not just species already in our own Red List
 * database — every species-rank name (Accepted or Synonym; ~1.05M rows) gets an
 * entry keyed by that exact name string, resolved to its accepted taxon's native
 * range via accepted_plant_name_id. Deliberately NOT scoped to our own assessed
 * species: this dashboard also shows a GBIF occurrence map for Not-Evaluated (NE)
 * species browsed from the Catalogue-of-Life-backed universe, which aren't in
 * assessed.parquet at all — scoping to our own species list would silently give
 * those zero POWO coverage even though WCVP has the data. A species (assessed or
 * NE) with no match (different spelling, taxonomic disagreement, or genuinely
 * absent from WCVP) simply gets no POWO option — the UI falls back to the Red
 * List source where available.
 *
 * Output is a Parquet file (not JSON) queried directly by DuckDB in
 * /api/wcvp-native-range at request time — a plain JSON import would force
 * parsing the entire ~49MB file into a JS object on every cold start just to
 * answer a single-name lookup (measured ~3s, and that parse blocks Node's
 * single-threaded event loop for its whole duration). Parquet lets DuckDB read
 * only the rows it needs.
 *
 * Also carries `powo_id` — the matched name's ACCEPTED taxon's own id (not the
 * matched name's own, which may be a synonym with a different id) — used to
 * link out to the taxon's real POWO page for reference/verification:
 * https://powo.science.kew.org/taxon/urn:lsid:ipni.org:names:{powo_id}
 *
 * Usage (re-run occasionally; WCVP ships periodic updates):
 *   npx tsx scripts/maps/fetch-wcvp-native-range.ts [path-to-already-downloaded-wcvp.zip]
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { DuckDBInstance } from "@duckdb/node-api";

const WCVP_ZIP_URL = "https://sftp.kew.org/pub/data-repositories/WCVP/wcvp.zip";
const TDWG_LEVEL3_URL =
  "https://raw.githubusercontent.com/tdwg/wgsrpd/master/109-488-1-ED/2nd%20Edition/tblLevel3.txt";
const OUT_DIR = path.join(__dirname, "..", "..", "src", "lib", "native-range-refdata");
const OUT_PATH = path.join(OUT_DIR, "wcvp-native-countries.parquet");
const WORK_DIR = path.join(__dirname, "..", "..", ".wcvp-tmp");

// Patches for TDWG WGSRPD level-3 codes with no ISO code in the official Ed.2
// table (see file header) — only the confident single- or unambiguous-multi-country
// cases; genuine multi-country composites with no clean split (Leeward Is., Gulf
// States, New Guinea, Borneo, ...) are deliberately left unmapped. Also overrides
// 4 codes that DO have an "ISO code" filled in but it's not a real current ISO
// 3166-1 alpha-2 (so it would never match GBIF's own countryCode field): GRB's
// "UK" (real code GB), and 3 pre-1990s composite/dissolved states the table never
// updated after they split — CZE "CS" (Czechoslovakia -> Czechia+Slovakia), YUG
// "YU" (Yugoslavia -> its 6 successor states), NLA "AN" (Netherlands Antilles ->
// its 3 successor territories).
const WGSRPD_OVERRIDES: Record<string, string[]> = {
  AUT: ["AT"], BGM: ["BE"], FRA: ["FR"], ITA: ["IT"], SPA: ["ES"], UKR: ["UA"],
  MOR: ["MA"], HAI: ["HT"], IRE: ["IE"], COM: ["KM"], SOL: ["SB"], SAM: ["WS"],
  MLY: ["MY"], LIN: ["KI"], CHS: ["CN"], AND: ["IN"], SIC: ["IT"], HAW: ["US"],
  NFL: ["CA"], RUS: ["RU"], PAL: ["PS"], KOR: ["KR", "KP"], LBS: ["LB", "SY"],
  BLT: ["EE", "LV", "LT"], TCS: ["GE", "AM", "AZ"],
  GRB: ["GB"], CZE: ["CZ", "SK"], YUG: ["BA", "HR", "ME", "MK", "RS", "SI"],
  NLA: ["CW", "SX", "BQ"],
};

function download(url: string, destPath: string) {
  execSync(`curl -sL --max-time 300 -o "${destPath}" "${url}"`, { stdio: "inherit" });
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const preDownloaded = process.argv[2];
  const zipPath = path.join(WORK_DIR, "wcvp.zip");
  if (preDownloaded) {
    fs.copyFileSync(preDownloaded, zipPath);
  } else {
    console.log(`Downloading ${WCVP_ZIP_URL} ...`);
    download(WCVP_ZIP_URL, zipPath);
  }
  console.log("Unzipping...");
  execSync(`unzip -o -q "${zipPath}" -d "${WORK_DIR}"`, { stdio: "inherit" });

  const level3Path = path.join(WORK_DIR, "tblLevel3.txt");
  console.log(`Downloading ${TDWG_LEVEL3_URL} ...`);
  download(TDWG_LEVEL3_URL, level3Path);

  // tblLevel3.txt is Latin-1 encoded (breaks on diacritics like "Føroyar" if read as UTF-8)
  const level3Raw = fs.readFileSync(level3Path).toString("latin1");
  // (l3code, iso) pairs — one-to-many for composite codes split by WGSRPD_OVERRIDES.
  const crosswalkRows: [string, string][] = [];
  for (const line of level3Raw.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [l3code, , , isoCode] = line.split("*");
    if (!l3code) continue;
    const isoCodes = WGSRPD_OVERRIDES[l3code] ?? (isoCode?.trim() ? [isoCode.trim().toUpperCase()] : null);
    if (!isoCodes) continue;
    for (const iso of isoCodes) crosswalkRows.push([l3code, iso]);
  }
  const distinctL3 = new Set(crosswalkRows.map((r) => r[0]));
  console.log(`TDWG level-3 crosswalk: ${distinctL3.size}/369 codes resolved to a country`);

  const namesPath = path.join(WORK_DIR, "wcvp_names.csv");
  const distPath = path.join(WORK_DIR, "wcvp_distribution.csv");

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  await conn.run(`CREATE TABLE crosswalk (l3code VARCHAR, iso VARCHAR)`);
  const values = crosswalkRows.map(([l3, iso]) => `(${sqlString(l3)}, ${sqlString(iso)})`).join(",");
  await conn.run(`INSERT INTO crosswalk VALUES ${values}`);

  console.log("Computing native countries per accepted taxon...");
  await conn.run(`
    CREATE TABLE id_countries AS
    SELECT d.plant_name_id, list_sort(list(DISTINCT x.iso)) AS countries
    FROM read_csv(${sqlString(distPath)}, delim=chr(124), header=true, quote='') d
    JOIN crosswalk x ON x.l3code = d.area_code_l3
    WHERE d.introduced = 0 AND d.extinct = 0 AND (d.location_doubtful = 0 OR d.location_doubtful IS NULL)
    GROUP BY d.plant_name_id
  `);

  console.log("Resolving each accepted taxon's own POWO id (for the info-link)...");
  await conn.run(`
    CREATE TABLE accepted_powo_id AS
    SELECT plant_name_id, powo_id
    FROM read_csv(${sqlString(namesPath)}, delim=chr(124), header=true, quote='')
    WHERE taxon_status = 'Accepted' AND powo_id IS NOT NULL
  `);

  // Every species-rank name in the full checklist (Accepted or Synonym), resolved
  // to its accepted taxon's id — covers current names AND older/synonym names a
  // Red List assessment (assessed or NE) might still use. Streamed straight to
  // Parquet rather than materialized in JS (see file header for why). powo_id is
  // the ACCEPTED taxon's own id (not the matched name's, which may be a synonym
  // with a different id) — it's what the countries themselves describe, and what
  // the info-link should point to (https://powo.science.kew.org/taxon/urn:lsid:ipni.org:names:{powo_id}).
  console.log("Matching full WCVP species-rank name list and writing Parquet...");
  await conn.run(`
    COPY (
      SELECT n.taxon_name AS name, ic.countries, p.powo_id
      FROM (
        SELECT taxon_name, COALESCE(accepted_plant_name_id, plant_name_id) AS resolved_id
        FROM read_csv(${sqlString(namesPath)}, delim=chr(124), header=true, quote='')
        WHERE taxon_name IS NOT NULL AND taxon_rank = 'Species'
      ) n
      JOIN id_countries ic ON ic.plant_name_id = n.resolved_id
      LEFT JOIN accepted_powo_id p ON p.plant_name_id = n.resolved_id
    ) TO ${sqlString(OUT_PATH)} (FORMAT PARQUET)
  `);

  const countResult = await conn.runAndReadAll(`SELECT count(*) c FROM read_parquet(${sqlString(OUT_PATH)})`);
  const count = Number(countResult.getRowObjects()[0].c);
  console.log(`Wrote ${count} names to ${OUT_PATH}`);

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
