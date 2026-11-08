/**
 * common_names: one row per English common name a source gives a taxon, and
 * per taxon the one name of each source that is shown.
 *
 * Built from: the CoL XR's VernacularName.tsv (with taxa, for each usage's rank
 * and name), and iNaturalist's taxonomy (inputs/inat-names.ts).
 *
 * Columns:
 *   source           'col' | 'inat'
 *   kind             'name': any of its names (search finds a species by each);
 *                    'display': the one name this source would show for it
 *   col_id           the CoL usage (CoL names only)
 *   rank             the usage's rank (CoL names only)
 *   scientific_name  the name it is a common name for; iNaturalist's names join
 *                    on it, within kingdom
 *   kingdom          iNaturalist's kingdom (iNaturalist names only)
 *   name             first letter capitalised
 *
 * Which source's display name is shown is decided where a list is built: an
 * assessed species shows IUCN's name, else iNaturalist's; a Not Evaluated
 * species iNaturalist's, else CoL's (dbt/models/lists/assessed.sql, ne.sql).
 *
 * Decisions:
 *   - A name that is just the scientific name relisted ("Acacia") is dropped.
 *   - Every CoL name is kept for search: CoL lists 14 English names for
 *     Adansonia digitata and marks none preferred, and keeping only the shortest
 *     gave "Boabab", a misspelling, so "baobab" found nothing.
 *   - CoL's display name for a species: its preferred flag (no English name
 *     carries one today); else the name sharing the most words with the names of
 *     other species in its genus (a genus that calls its members "… baobab"
 *     names this one "… baobab" too, and a one-off misspelling scores nothing);
 *     else the shortest; else alphabetical.
 *   - CoL's display name for a class, order, family or genus: preferred, else
 *     the shortest, else alphabetical. One per scientific name, since the tree
 *     labels by name: where usages share one (a synonym and its accepted name,
 *     homonyms), the shortest of their names, then alphabetical.
 *   - iNaturalist's display name is the first it lists; a scientific name
 *     iNaturalist repeats within a kingdom is ambiguous and gets no names.
 */
import { lit, openDuckDB } from "../sql";
import { output, parquet } from "../paths";

export async function buildCommonNames(
  inputs: { colVernacularNames: string; taxa: string; inatNames: string },
  commonNamesFile: string,
): Promise<void> {
  const conn = await openDuckDB();
  const usages = `SELECT col_id, rank, scientific_name FROM ${parquet(inputs.taxa)}`;

  await conn.run(`
    CREATE OR REPLACE TEMP TABLE vern_raw AS
      SELECT "col:taxonID" AS col_id, "col:name" AS name,
             lower(coalesce("col:preferred", '')) = 'true' AS preferred
      FROM read_csv(${lit(inputs.colVernacularNames)}, delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true)
      WHERE "col:language" = 'eng' AND "col:name" IS NOT NULL AND trim("col:name") != '';
  `);

  // A class, order, family or genus: one name per usage, then one per scientific
  // name (the tree labels by name), each choice made on the names as CoL writes them.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE higher_display AS
      SELECT v.col_id, u.rank, u.scientific_name, upper(substr(v.name, 1, 1)) || substr(v.name, 2) AS name
      FROM (
        SELECT col_id, name FROM (
          SELECT col_id, name, ROW_NUMBER() OVER (PARTITION BY col_id ORDER BY preferred DESC, length(name) ASC, name ASC) AS rn
          FROM vern_raw
        ) WHERE rn = 1
      ) v
      JOIN (${usages}) u ON u.col_id = v.col_id
      WHERE u.rank IN ('class', 'order', 'family', 'genus') AND lower(v.name) != lower(u.scientific_name)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY lower(u.scientific_name) ORDER BY length(v.name) ASC, v.name ASC) = 1`);

  // A species: every name, case-only duplicates collapsed (keeping the preferred one).
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE vern_species AS
      SELECT col_id, scientific_name, name, preferred, genus FROM (
        SELECT v.col_id, u.scientific_name, upper(substr(trim(v.name), 1, 1)) || substr(trim(v.name), 2) AS name, v.preferred,
               split_part(u.scientific_name, ' ', 1) AS genus,
               ROW_NUMBER() OVER (PARTITION BY v.col_id, lower(trim(v.name)) ORDER BY v.preferred DESC, v.name) AS dup
        FROM vern_raw v JOIN (${usages}) u ON u.col_id = v.col_id
        WHERE u.rank = 'species' AND lower(trim(v.name)) != lower(u.scientific_name)
      ) WHERE dup = 1;
  `);

  // Score each species name by how many words (4+ letters) it shares with the
  // names of OTHER species in its genus: genus_words counts the species using
  // each word, so minus one for the species itself.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE name_words AS
      SELECT DISTINCT col_id, name, genus, w AS word
      FROM vern_species, unnest(regexp_split_to_array(lower(name), '[^a-z]+')) AS t(w)
      WHERE length(w) >= 4;
    CREATE OR REPLACE TEMP TABLE genus_words AS
      SELECT genus, word, count(DISTINCT col_id) AS species FROM name_words GROUP BY genus, word;
    CREATE OR REPLACE TEMP TABLE species_display AS
      SELECT col_id, scientific_name, name FROM (
        SELECT s.col_id, s.scientific_name, s.name, ROW_NUMBER() OVER (
          PARTITION BY s.col_id ORDER BY s.preferred DESC, coalesce(sum(g.species - 1), 0) DESC, length(s.name), s.name) AS rn
        FROM vern_species s
        LEFT JOIN name_words nw ON nw.col_id = s.col_id AND nw.name = s.name
        LEFT JOIN genus_words g ON g.genus = nw.genus AND g.word = nw.word
        GROUP BY s.col_id, s.scientific_name, s.name, s.preferred
      ) WHERE rn = 1;
  `);

  await conn.run(`COPY (
    SELECT 'col' AS source, 'name' AS kind, col_id, 'species' AS rank, scientific_name, NULL::VARCHAR AS kingdom, name FROM vern_species
    UNION ALL
    SELECT 'col', 'display', col_id, 'species', scientific_name, NULL, name FROM species_display
    UNION ALL
    SELECT 'col', 'display', col_id, rank, scientific_name, NULL, name FROM higher_display
    UNION ALL
    SELECT 'inat', 'name', NULL, 'species', scientific_name, kingdom, unnest(names) FROM ${parquet(inputs.inatNames)}
    UNION ALL
    SELECT 'inat', 'display', NULL, 'species', scientific_name, kingdom, preferred_name FROM ${parquet(inputs.inatNames)}
    ORDER BY source, kind, col_id, scientific_name, name
  ) TO ${lit(output(commonNamesFile))} (FORMAT parquet, COMPRESSION zstd)`);

  const [n] = (await conn.runAndReadAll(`SELECT source, count(DISTINCT coalesce(col_id, scientific_name || kingdom)) AS taxa, count(*) AS names
    FROM ${parquet(commonNamesFile)} WHERE kind = 'name' GROUP BY source ORDER BY source`)).getRowObjects();
  console.log(`   ${Number(n.taxa).toLocaleString()} CoL species with a common name, ${Number(n.names).toLocaleString()} names`);
}
