/**
 * build-common-names: the English common names CoL lists (its "vernacular
 * names"), joined to the sync's taxa.parquet, into three files:
 *
 *   data/…/vernacular-names.json   class/order/family/genus → one common name
 *                                  (the tree's labels, "Browse Adansonia (Baobabs)")
 *   core/species-common-names-col.parquet
 *                                  col_id → every English name; the search index
 *                                  makes each one findable
 *   core/species-fallback-display-name-col.parquet
 *                                  col_id → one name, which the read models show
 *                                  only when IUCN and iNaturalist have none
 *
 * Why every name for search: CoL lists 14 English names for Adansonia digitata
 * ("African baobab", "Baobab Tree", "Monkeybread", …), none marked preferred, and
 * keeping only the shortest gave "Boabab", a misspelling, so "baobab" found
 * nothing. 84k of the 222k species with English names have more than one.
 *
 * The fallback display name: CoL's preferred flag (which no English name carries
 * today); else the name sharing the most words
 * with the other species of its genus (a genus that calls its members "… baobab"
 * names this one "… baobab" too, and a one-off misspelling scores nothing); else
 * the shortest; else alphabetical.
 *
 * Usage:  npx tsx scripts/sync/outputs/build-common-names.ts   (the cached XR, the build's taxa.parquet)
 */
import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { syncPath } from "../../../src/lib/data/sync-layout";
import { loadEnvFiles } from "../../lib/utils";
import { ensureColInputs } from "../inputs/col";
import { CORE_DIR, OUT_DIR } from "../paths";

export async function buildCommonNames(
  conn: DuckDBConnection, opts: { vernacularTsv: string; taxa: string; coreDir: string; dataDir: string },
): Promise<void> {
  const { vernacularTsv, coreDir, dataDir } = opts;
  const usages = `SELECT col_id, rank, scientific_name FROM read_parquet('${opts.taxa}')`;

  // English names straight from the file.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE vern_raw AS
      SELECT "col:taxonID" AS col_id, "col:name" AS name,
             lower(coalesce("col:preferred", '')) = 'true' AS preferred
      FROM read_csv('${vernacularTsv}', delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true)
      WHERE "col:language" = 'eng' AND "col:name" IS NOT NULL AND trim("col:name") != '';
  `);

  // vernacular-names.json: per taxon, preferred then shortest then alphabetical; then per scientific name (a
  // synonym and its accepted name can share one), shortest then alphabetical; dropping
  // entries that are just the scientific name relisted ("Acacia" → "acacia", ~3.8% of
  // CoL's) and capitalizing the first letter (CoL's casing is inconsistent, ~31% lower).
  const rows = await (await conn.run(`
    SELECT name_lower, name FROM (
      SELECT lower(u.scientific_name) AS name_lower,
             upper(substr(v.name, 1, 1)) || substr(v.name, 2) AS name,
             ROW_NUMBER() OVER (PARTITION BY lower(u.scientific_name) ORDER BY length(v.name) ASC, v.name ASC) AS rn
      FROM (
        SELECT col_id, name FROM (
          SELECT col_id, name, ROW_NUMBER() OVER (PARTITION BY col_id ORDER BY preferred DESC, length(name) ASC, name ASC) AS rn
          FROM vern_raw
        ) WHERE rn = 1
      ) v
      JOIN (${usages}) u ON u.col_id = v.col_id
      WHERE u.rank IN ('class', 'order', 'family', 'genus') AND lower(v.name) != lower(u.scientific_name)
    ) WHERE rn = 1
  `)).getRowObjects();
  const vernacularMap: Record<string, string> = {};
  for (const r of rows) vernacularMap[String(r.name_lower)] = String(r.name);
  const namesOut = path.join(dataDir, syncPath("vernacular-names.json"));
  fs.mkdirSync(path.dirname(namesOut), { recursive: true });
  fs.writeFileSync(namesOut, JSON.stringify(vernacularMap, null, 0));
  console.log(`   vernacular-names.json: ${rows.length.toLocaleString()} class/order/family/genus names`);

  // Species: every English name, minus scientific-name echoes, first letter capitalized,
  // case-only duplicates collapsed (keeping the preferred/capitalized one).
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE vern_species AS
      SELECT col_id, name, preferred, genus FROM (
        SELECT v.col_id, upper(substr(trim(v.name), 1, 1)) || substr(trim(v.name), 2) AS name, v.preferred,
               split_part(u.scientific_name, ' ', 1) AS genus,
               ROW_NUMBER() OVER (PARTITION BY v.col_id, lower(trim(v.name)) ORDER BY v.preferred DESC, v.name) AS dup
        FROM vern_raw v JOIN (${usages}) u ON u.col_id = v.col_id
        WHERE u.rank = 'species' AND lower(trim(v.name)) != lower(u.scientific_name)
      ) WHERE dup = 1;
  `);

  // Score each name by how many words (4+ letters) it shares with the names of OTHER
  // species in its genus: genus_words counts the species using each word, so minus one
  // for the species itself.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE name_words AS
      SELECT DISTINCT col_id, name, genus, w AS word
      FROM vern_species, unnest(regexp_split_to_array(lower(name), '[^a-z]+')) AS t(w)
      WHERE length(w) >= 4;
    CREATE OR REPLACE TEMP TABLE genus_words AS
      SELECT genus, word, count(DISTINCT col_id) AS species FROM name_words GROUP BY genus, word;
    CREATE OR REPLACE TEMP TABLE vern_scored AS
      SELECT s.col_id, s.name, s.preferred, coalesce(sum(g.species - 1), 0) AS shared
      FROM vern_species s
      LEFT JOIN name_words nw ON nw.col_id = s.col_id AND nw.name = s.name
      LEFT JOIN genus_words g ON g.genus = nw.genus AND g.word = nw.word
      GROUP BY s.col_id, s.name, s.preferred;
  `);
  await conn.run(`
    COPY (
      SELECT col_id, name AS common_name FROM (
        SELECT col_id, name, ROW_NUMBER() OVER (
          PARTITION BY col_id ORDER BY preferred DESC, shared DESC, length(name), name) AS rn
        FROM vern_scored
      ) WHERE rn = 1 ORDER BY col_id
    ) TO '${path.join(coreDir, "species-fallback-display-name-col.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `);
  await conn.run(`
    COPY (SELECT col_id, name FROM vern_species ORDER BY col_id, name)
    TO '${path.join(coreDir, "species-common-names-col.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `);
  const n = (await (await conn.run(`SELECT count(DISTINCT col_id) AS sp, count(*) AS names FROM vern_species`)).getRowObjects())[0];
  console.log(`   ${Number(n.sp).toLocaleString()} species with a CoL common name, ${Number(n.names).toLocaleString()} names in all`);
}

const isDirectRun = process.argv[1]?.endsWith("outputs/build-common-names.ts");
if (isDirectRun) {
  loadEnvFiles();
  (async () => {
    const col = await ensureColInputs();
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    await buildCommonNames(conn, { vernacularTsv: col.vernacularNames, taxa: path.join(CORE_DIR, "taxa.parquet"), coreDir: CORE_DIR, dataDir: OUT_DIR });
  })().catch((e) => { console.error(e); process.exit(1); });
}
