/**
 * build-vernaculars: Catalogue of Life English common names → the three vernacular files.
 *
 *   vernacular-names.json             lowercased class/order/family/genus name → one common
 *                                     name (tree labels, and "Browse Adansonia (Baobabs)").
 *   species-vernaculars.parquet       col_id → ONE display common name per species
 *                                     (build-parquet puts it on unassessed rows).
 *   species-vernacular-names.parquet  col_id → EVERY English common name of the species
 *                                     (build-search-index makes each one searchable).
 *
 * Called by build-backbone in a sync (with its NameUsage table), and runnable on its own
 * against a sync's backbone.parquet — so the names can be rebuilt from the same CoL
 * release without re-running the whole backbone:
 *
 *   npx tsx scripts/sync/outputs/build-vernaculars.ts <VernacularName.tsv> [dataDir]
 *
 * Why every name, not one: CoL lists 14 English names for Adansonia digitata ("African
 * baobab", "Baobab Tree", "Monkeybread", …), none flagged preferred, and the old rule
 * kept only the shortest — "Boabab", a misspelling — so "baobab" found nothing. 84k of the
 * 222k species with English names have more than one.
 *
 * Display-name rule (one per species): CoL's preferred flag; else the name sharing the
 * most words with the OTHER species of its genus (so a genus that calls its members
 * "… baobab" names this one "… baobab" too, and a one-off misspelling scores nothing);
 * else the shortest; else alphabetical, for determinism.
 */
import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

/**
 * @param usages a SQL relation with col_id, rank, scientific_name for every name usage
 *   (build-backbone's NameUsage table, or a sync's backbone.parquet).
 */
export async function buildVernaculars(conn: DuckDBConnection, opts: { vernacularTsv: string; outDir: string; usages: string }): Promise<void> {
  const { vernacularTsv, outDir, usages } = opts;

  // English names straight from the file, as the old single-pick code read them.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE vern_raw AS
      SELECT "col:taxonID" AS col_id, "col:name" AS name,
             lower(coalesce("col:preferred", '')) = 'true' AS preferred
      FROM read_csv('${vernacularTsv}', delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true)
      WHERE "col:language" = 'eng' AND "col:name" IS NOT NULL AND trim("col:name") != '';
  `);

  // vernacular-names.json — the existing rule, kept exactly so tree labels don't move:
  // per taxon, preferred then shortest then alphabetical; then per scientific name (a
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
  fs.writeFileSync(path.join(outDir, "vernacular-names.json"), JSON.stringify(vernacularMap, null, 0));
  console.log(`Wrote vernacular-names.json: ${rows.length.toLocaleString()} class/order/family/genus common names`);

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
      SELECT col_id, name AS vernacular_name FROM (
        SELECT col_id, name, ROW_NUMBER() OVER (
          PARTITION BY col_id ORDER BY preferred DESC, shared DESC, length(name), name) AS rn
        FROM vern_scored
      ) WHERE rn = 1 ORDER BY col_id
    ) TO '${path.join(outDir, "species-vernaculars.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `);
  await conn.run(`
    COPY (SELECT col_id, name FROM vern_species ORDER BY col_id, name)
    TO '${path.join(outDir, "species-vernacular-names.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `);
  const n = (await (await conn.run(`SELECT count(DISTINCT col_id) AS sp, count(*) AS names FROM vern_species`)).getRowObjects())[0];
  console.log(`Wrote species-vernaculars.parquet (${Number(n.sp).toLocaleString()} display names) + ` +
    `species-vernacular-names.parquet (${Number(n.names).toLocaleString()} names)`);
}

const isDirectRun = process.argv[1]?.endsWith("outputs/build-vernaculars.ts");
if (isDirectRun) {
  const [tsv, dir = path.join(__dirname, "..", "..", "..", "data")] = process.argv.slice(2);
  if (!tsv || !fs.existsSync(tsv)) {
    console.error("usage: npx tsx scripts/sync/outputs/build-vernaculars.ts <VernacularName.tsv> [dataDir]");
    process.exit(1);
  }
  (async () => {
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    await buildVernaculars(conn, {
      vernacularTsv: tsv,
      outDir: dir,
      usages: `SELECT col_id, rank, scientific_name FROM read_parquet('${path.join(dir, "backbone.parquet")}')`,
    });
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
