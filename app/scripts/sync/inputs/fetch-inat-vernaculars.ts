/**
 * fetch-inat-vernaculars: iNaturalist's English common names → data/inat-vernaculars.parquet.
 *
 * Catalogue of Life lists several English names per species but never says which one is
 * preferred (not one of its ~399k English names carries col:preferred), so any CoL-only
 * pick is a guess — the shortest gave Adansonia digitata "Boabab", a misspelling.
 * iNaturalist curates one preferred English name per species, and its taxonomy export
 * (a weekly ~80MB Darwin Core Archive) lists that name first among each taxon's English
 * names — checked against the iNaturalist API: 7 of 8 sampled species agree, the eighth
 * differing by region (Pieris rapae: "Cabbage White" vs "Small White").
 *
 * Output, one row per species (kingdom + scientific name):
 *   scientific_name, kingdom, preferred_name (first-listed English name), names (all English)
 * build-parquet takes preferred_name as the display name (after IUCN's, for assessed
 * species); build-search-index makes every name searchable.
 *
 * Matched to our species by scientific name within a kingdom (lib: inatKingdomSql) — the
 * same binomial can name a plant and an animal. The ~83 names iNaturalist repeats WITHIN a
 * kingdom are dropped rather than guessed between.
 *
 * Licence: the export carries no restrictive licence; its metadata notes that taxonomic
 * information generally isn't subject to intellectual-property restrictions. The dashboard
 * credits iNaturalist where it lists its common-name sources.
 *
 * Usage: npx tsx scripts/sync/inputs/fetch-inat-vernaculars.ts [--from <dir with taxa.csv + VernacularNames-english.csv>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DuckDBInstance } from "@duckdb/node-api";
import { DATA_DIR, loadEnvFiles } from "../../lib/utils";

const EXPORT_URL = "https://www.inaturalist.org/taxa/inaturalist-taxonomy.dwca.zip";
const FILES = ["taxa.csv", "VernacularNames-english.csv", "eml.xml"];

/** Our taxon_group → iNaturalist's kingdom, for matching names within a kingdom. */
export function inatKingdomSql(taxonGroupCol: string): string {
  return `CASE
    WHEN ${taxonGroupCol} IN ('flowering_plants','gymnosperms','ferns_and_allies','mosses','green_algae','red_algae') THEN 'Plantae'
    WHEN ${taxonGroupCol} = 'mushrooms' THEN 'Fungi'
    WHEN ${taxonGroupCol} = 'brown_algae' THEN 'Chromista'
    ELSE 'Animalia' END`;
}

export async function run(opts: { from?: string; dataDir?: string } = {}): Promise<void> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  let dir = opts.from;
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inat-taxonomy-"));
    const zip = path.join(dir, "taxonomy.zip");
    console.log(`fetch-inat-vernaculars: downloading ${EXPORT_URL}…`);
    execFileSync("curl", ["-sSfL", "--retry", "5", "--retry-delay", "10", "-o", zip, EXPORT_URL], { stdio: "inherit" });
    execFileSync("unzip", ["-o", "-q", zip, ...FILES, "-d", dir], { stdio: "inherit" });
  }
  for (const f of FILES.slice(0, 2)) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`fetch-inat-vernaculars: ${f} missing in ${dir}`);
  }

  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  // The export's CSVs quote with "…" and escape with "" (DuckDB's sniffer guesses wrong
  // on taxa.csv's long URL fields, so say so explicitly).
  const csv = (f: string) => `read_csv('${path.join(dir!, f)}', all_varchar=true, header=true, delim=',', quote='"', escape='"')`;
  const out = path.join(dataDir, "inat-vernaculars.parquet");
  await conn.run(`
    COPY (
      WITH sp AS (
        SELECT id, scientificName AS scientific_name, kingdom
        FROM ${csv("taxa.csv")} WHERE taxonRank = 'species' AND kingdom IS NOT NULL
      ),
      unique_sp AS (  -- a name iNaturalist repeats within one kingdom is ambiguous: skip it
        SELECT * FROM sp WHERE (scientific_name, kingdom) IN (
          SELECT scientific_name, kingdom FROM sp GROUP BY ALL HAVING count(*) = 1)
      ),
      vn AS (  -- file order is preserved (rn), so "first listed" is well-defined
        SELECT id, trim(vernacularName) AS name, row_number() OVER () AS rn
        FROM ${csv("VernacularNames-english.csv")}
        WHERE nullif(trim(vernacularName), '') IS NOT NULL
      )
      SELECT s.scientific_name, s.kingdom,
             upper(substr(first(v.name ORDER BY v.rn), 1, 1)) || substr(first(v.name ORDER BY v.rn), 2) AS preferred_name,
             list(DISTINCT v.name) AS names
      FROM unique_sp s JOIN vn v ON v.id = s.id
      -- Drop names that are just the scientific name relisted.
      WHERE lower(v.name) <> lower(s.scientific_name)
      GROUP BY s.scientific_name, s.kingdom
      ORDER BY s.kingdom, s.scientific_name
    ) TO '${out}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  const n = (await conn.runAndReadAll(`SELECT count(*) AS n, sum(len(names)) AS names FROM read_parquet('${out}')`)).getRowObjects()[0];
  console.log(`Wrote ${out}: ${Number(n.n).toLocaleString()} species, ${Number(n.names).toLocaleString()} English names`);
}

const isDirectRun = process.argv[1]?.endsWith("inputs/fetch-inat-vernaculars.ts");
if (isDirectRun) {
  loadEnvFiles();
  const i = process.argv.indexOf("--from");
  run({ from: i > 0 ? process.argv[i + 1] : undefined }).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
