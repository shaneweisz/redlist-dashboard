/**
 * iNaturalist's English common names, one row per species, cached per month in
 * ~/.cache/redlist-dashboard/inat-names-<YYYY-MM>/common-names.parquet:
 *   scientific_name, kingdom, preferred_name (the first listed), names (all of them)
 *
 * CoL lists several English names per species but never marks one preferred, so
 * a CoL-only pick is a guess (the shortest gave Adansonia digitata "Boabab").
 * iNaturalist curates one, and its weekly taxonomy export lists it first (7 of 8
 * sampled species agreed with its API; the eighth differs by region). The read
 * models use preferred_name after IUCN's own name; the search index uses all.
 *
 * Names are matched within a kingdom (inatKingdomSql), since one binomial can
 * name a plant and an animal; the ~83 iNaturalist repeats within a kingdom are
 * dropped rather than guessed between. The export carries no restrictive
 * licence, and the dashboard credits iNaturalist among its name sources.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DuckDBInstance } from "@duckdb/node-api";
import { CACHE_ROOT, cachedDir } from "../paths";

const EXPORT_URL = "https://www.inaturalist.org/taxa/inaturalist-taxonomy.dwca.zip";
const FILES = ["taxa.csv", "VernacularNames-english.csv"];

/** Our taxon_group → iNaturalist's kingdom, for matching names within a kingdom. */
export function inatKingdomSql(taxonGroupCol: string): string {
  return `CASE
    WHEN ${taxonGroupCol} IN ('flowering_plants','gymnosperms','ferns_and_allies','mosses','green_algae','red_algae') THEN 'Plantae'
    WHEN ${taxonGroupCol} = 'mushrooms' THEN 'Fungi'
    WHEN ${taxonGroupCol} = 'brown_algae' THEN 'Chromista'
    ELSE 'Animalia' END`;
}

/** This month's names, downloaded if they aren't cached yet. Returns the parquet's path. */
export async function ensureInatNames(month = new Date().toISOString().slice(0, 7)): Promise<string> {
  const dir = await cachedDir(path.join(CACHE_ROOT, `inat-names-${month}`), (d) => buildNames(path.join(d, "common-names.parquet")));
  return path.join(dir, "common-names.parquet");
}

async function buildNames(out: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inat-taxonomy-"));
  try {
    const zip = path.join(dir, "taxonomy.zip");
    console.log(`   downloading ${EXPORT_URL}`);
    execFileSync("curl", ["-sSfL", "--retry", "5", "--retry-delay", "10", "-o", zip, EXPORT_URL], { stdio: "inherit" });
    execFileSync("unzip", ["-o", "-q", zip, ...FILES, "-d", dir], { stdio: "inherit" });
    for (const f of FILES) {
      if (!fs.existsSync(path.join(dir, f))) throw new Error(`inat-names: ${f} missing from the export`);
    }

    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    // The CSVs quote with "…" and escape with "" (DuckDB's sniffer guesses wrong on taxa.csv's long URLs).
    const csv = (f: string) => `read_csv('${path.join(dir, f)}', all_varchar=true, header=true, delim=',', quote='"', escape='"')`;
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
    console.log(`   ${Number(n.n).toLocaleString()} species, ${Number(n.names).toLocaleString()} English names`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
