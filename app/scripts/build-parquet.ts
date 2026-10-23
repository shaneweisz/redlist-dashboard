/**
 * build-parquet (#261): build the DuckDB read substrate from the per-group
 * Red List + GBIF CSVs + history. Three lineage-sorted parquets (split by the
 * assessed-vs-unassessed scale/schema asymmetry — assessed is bounded ~172k,
 * unassessed balloons under CoL):
 *
 *  - assessed.parquet     = Red List assessed species, enriched with GBIF
 *      occurrence counts summed across ALL their mapping links (canonical-
 *      preferred representative key). Rich schema; columns match SpeciesRow.
 *      Includes denormalized latest_assessors/latest_reviewers/latest_facilitators (history seq 0)
 *      and assessment_count (count of history rows) so the species list needs
 *      no history join (full history is lazy).
 *  - unassessed.parquet   = GBIF species not linked to any assessment (minus
 *      domesticated), category 'NE'. Lean schema — taxonomy + occurrence count
 *      only (no assessment-only columns, no obs-after-assessment-year).
 *  - assessments.parquet  = flattened assessment history (one row per past
 *      assessment, seq-ordered) for the species detail panel.
 *
 * The canonical species read substrate: powers the species list, lazy history,
 * and cross-taxa search. Sorted by lineage so
 * DuckDB row-group min/max prunes any taxonomic filter.
 *
 *   npx tsx scripts/build-parquet.ts
 */
import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR, REDLIST_DIR, GBIF_DIR, CSV_QUOTING, writeCsv } from "./utils";
import { GBIF_ALL_ONLY_DIR } from "./fetch-gbif-species";
import { EXCLUDED_DOMESTICATED_GBIF_KEYS } from "../src/lib/data/taxonomy-constants";
import { chooseRepresentative, type Verdict } from "./species-key";

export async function run(): Promise<void> {
  const redlistGlob = path.join(REDLIST_DIR, "*.csv");
  const gbifGlob = path.join(GBIF_DIR, "*.csv");
  const mappingCsv = path.join(DATA_DIR, "mapping.csv");
  const historyDir = path.join(REDLIST_DIR, "history");
  const assessmentsOut = path.join(DATA_DIR, "assessments.parquet");
  const assessedOut = path.join(DATA_DIR, "assessed.parquet");
  const unassessedOut = path.join(DATA_DIR, "unassessed.parquet");
  const domesticated = [...EXCLUDED_DOMESTICATED_GBIF_KEYS].map((k) => `'${k}'`).join(",");

  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();

  // GBIF rows, one per species key.
  //
  // A species can be fetched by two groups at once, because IUCN's own group
  // definitions overlap where CoL has reorganised a lineage: "corals" is defined
  // to include Alcyonacea, which CoL retired and replaced with the class
  // Octocorallia, while "other invertebrates" separately names two of the orders
  // now inside that class. Soft corals therefore arrive from both.
  //
  // Left alone that produces two rows per species, and since the unassessed id is
  // derived from the key, two rows with the same identity — which is what the
  // uniqueness assertion at the end of this file catches. One row per key is kept,
  // preferring the more specific group (the one whose file lists fewer species,
  // i.e. the narrower definition), then the group name, so the choice is stable
  // across runs rather than depending on file order.
  // The all-records columns are absent from CSVs a sync wrote before they existed,
  // and naming a column no file has is a binder error rather than a NULL — so a
  // rebuild from older per-group files (a partial sync, or build-parquet run on
  // its own) would fail outright instead of simply lacking the new counts.
  const csvHasColumn = (dir: string, column: string) =>
    fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.endsWith(".csv")).some((f) =>
      fs.readFileSync(path.join(dir, f), "utf-8").split("\n", 1)[0].split(",").includes(column));
  const gbifHasAll = csvHasColumn(GBIF_DIR, "total_count_all");

  await conn.run(`
    CREATE TEMP TABLE gbif_rows AS
      SELECT
        CAST(gbif_species_key AS VARCHAR)        AS gbif_species_key,
        scientific_name, common_name,
        taxon_group_table1a                      AS taxon_group,
        lower(class_name) AS class_name, lower(order_name) AS order_name, lower(family) AS family,
        CAST(total_count AS BIGINT)              AS total_count,
        CAST(count_after_assessment_year AS BIGINT) AS count_after,
        ${gbifHasAll ? "CAST(total_count_all AS BIGINT)" : "CAST(NULL AS BIGINT)"} AS total_count_all,
        ${gbifHasAll ? "CAST(count_after_assessment_year_all AS BIGINT)" : "CAST(NULL AS BIGINT)"} AS count_after_all,
        countries
      FROM read_csv_auto('${gbifGlob}', union_by_name=true, ${CSV_QUOTING});
  `);

  // Group sizes are measured here, before the directly-counted rows are folded
  // in below, because this is the number that stands for "how narrow is this
  // group's definition". Those rows are distributed unevenly across groups — a
  // group with many lumped species would look broader than it is and lose the
  // tie-break above to a group that is genuinely wider.
  await conn.run(`
    CREATE TEMP TABLE group_sizes AS
      SELECT taxon_group, count(*) AS n FROM gbif_rows GROUP BY 1;
  `);

  // Species with records but none georeferenced (see GBIF_ALL_ONLY_DIR). Folded in
  // after group sizes are measured, for the same reason as the directly-counted
  // rows below, and with no georeferenced count: NULL, not the 0 in the file,
  // because a 0 reads as "has GBIF data, none of it usable" to everything that
  // counts coverage, and these species do not have georeferenced data at all.
  const allOnlyGlob = path.join(GBIF_ALL_ONLY_DIR, "*.csv");
  if (csvHasColumn(GBIF_ALL_ONLY_DIR, "total_count_all")) {
    await conn.run(`
      INSERT INTO gbif_rows
        SELECT
          CAST(gbif_species_key AS VARCHAR), scientific_name, common_name, taxon_group_table1a,
          lower(class_name), lower(order_name), lower(family),
          NULL, NULL,
          CAST(total_count_all AS BIGINT), CAST(count_after_assessment_year_all AS BIGINT),
          countries
        FROM read_csv_auto('${allOnlyGlob}', union_by_name=true, ${CSV_QUOTING},
                           types={'countries': 'VARCHAR', 'common_name': 'VARCHAR'})
        WHERE CAST(gbif_species_key AS VARCHAR) NOT IN (SELECT gbif_species_key FROM gbif_rows);
    `);
    const n = (await conn.runAndReadAll(`SELECT count(*) c FROM gbif_rows WHERE total_count IS NULL`)).getRowObjects()[0].c;
    console.log(`  species with no georeferenced records folded in: ${Number(n).toLocaleString()}`);
  }

  // Species whose key the facet enumeration cannot emit — synonyms kept after a
  // lump was refused, and taxa CoL ranks below species. Counted directly by
  // fetch-lumped-own-counts into its own file, and folded in here. The facet rows
  // win on conflict: where both have an opinion, the enumeration is the better
  // source.
  const lumpedCsv = path.join(DATA_DIR, "lumped-own-counts.csv");
  if (fs.existsSync(lumpedCsv)) {
    // A file from before the all-records columns existed has neither (see csvHasColumn).
    const lumpedHasAll = fs.readFileSync(lumpedCsv, "utf-8").split("\n", 1)[0].split(",").includes("total_count_all");
    const countRows = async () =>
      Number((await conn.runAndReadAll(`SELECT count(*) c FROM gbif_rows`)).getRowObjects()[0].c);
    const before = await countRows();
    await conn.run(`
      INSERT INTO gbif_rows
        SELECT
          CAST(l.gbif_species_key AS VARCHAR),
          -- Name and lineage are blank because nothing reads them for these rows:
          -- the browsable-species export is the only consumer of those columns and
          -- it excludes every key here, each one belonging to an assessed species.
          '' AS scientific_name, '' AS common_name,
          l.taxon_group_table1a,
          '' AS class_name, '' AS order_name, '' AS family,
          CAST(l.total_count AS BIGINT),
          CAST(l.count_after_assessment_year AS BIGINT),
          ${lumpedHasAll ? "CAST(l.total_count_all AS BIGINT)" : "NULL"},
          ${lumpedHasAll ? "CAST(l.count_after_assessment_year_all AS BIGINT)" : "NULL"},
          '' AS countries
        FROM read_csv_auto('${lumpedCsv}', ${CSV_QUOTING}) l
        WHERE l.gbif_species_key NOT IN (SELECT gbif_species_key FROM gbif_rows);
    `);
    // Rows actually inserted, not rows in the file — the WHERE clause drops any
    // key the facets already emitted, so reporting the file's length would
    // overstate what this contributed.
    const added = (await countRows()) - before;
    console.log(`  directly-counted species folded in: ${added.toLocaleString()}`);
  }
  await conn.run(`
    CREATE TEMP TABLE gbif_all AS
      SELECT * EXCLUDE (rn) FROM (
        SELECT r.*, ROW_NUMBER() OVER (
                 PARTITION BY r.gbif_species_key
                 ORDER BY s.n ASC, r.taxon_group ASC
               ) AS rn
        FROM gbif_rows r JOIN group_sizes s USING (taxon_group)
      ) WHERE rn = 1;
  `);

  // A species' key comes from mapping.csv, except for the ones CoL lumps: their
  // row there has an empty gbif_species_key by design (the resolution to another
  // species was refused), and the key they actually own is recorded by
  // fetch-lumped-own-counts. Both sources feed this table.
  //
  // Only the lumped file, never mapping.csv's unfetched_key column. That column
  // also holds keys reached through a Red List synonym, which CoL assigns to a
  // *different* species — attributing those is precisely the harm this migration
  // exists to stop. The lumped file has already applied that filter.
  await conn.run(`
    CREATE TEMP TABLE map AS
      SELECT CAST(sis_taxon_id AS BIGINT) AS sis_taxon_id,
             CAST(gbif_species_key AS VARCHAR) AS gbif_species_key,
             verdict
      FROM read_csv_auto('${mappingCsv}', ${CSV_QUOTING})
      WHERE gbif_species_key IS NOT NULL
      ${fs.existsSync(lumpedCsv) ? `
      UNION
      SELECT CAST(sis_taxon_id AS BIGINT), CAST(gbif_species_key AS VARCHAR), 'lumped'
      FROM read_csv_auto('${lumpedCsv}', ${CSV_QUOTING})` : ""};
  `);

  // sis_taxon_id → its Red List group (one per species). Used to restrict GBIF
  // enrichment to the species' OWN group, matching species-store's per-group
  // gbifMap lookup (cross-group linked keys are not counted).
  await conn.run(`
    CREATE TEMP TABLE rl AS
      SELECT DISTINCT CAST(sis_taxon_id AS BIGINT) AS sis_taxon_id, taxon_group_table1a AS taxon_group
      FROM read_csv_auto('${redlistGlob}', union_by_name=true, ${CSV_QUOTING});
  `);

  // Per-assessment GBIF enrichment: one species, one key, one set of counts.
  //
  // Joined on the key alone. It used to also require the GBIF row to sit in the
  // species' own Table 1a group, which was a reasonable guard while keys could
  // repeat across group files — but gbif_all now holds one row per key, so the
  // condition only has the power to reject. It did: IUCN files one octocoral
  // under "other invertebrates" while its key lands in the corals file, and that
  // species lost its occurrence data for no better reason than which group
  // fetched it first.
  //
  // This used to SUM counts across every linked GBIF row, which quietly turned a
  // species with more than one link into the union of several taxa. Combined with
  // a synonym link it is how assessed species came to display totals that were
  // not theirs — a species' own record count plus a congener's. Whatever the
  // representative key is, the numbers shown must be that key's numbers, so the
  // count a user sees and the search the link opens describe the same taxon.
  //
  // Which of a species' keys represents it is decided by species-key.ts, which
  // is where that question is decided for the whole pipeline. This block used to
  // decide it again here, in SQL, re-deriving authorship and epithet comparisons
  // that the matching phase had already made — and the two rules disagreed. The
  // SQL version handed five species another accepted species' records, among them
  // Pseudophilautus abundus (EN), which showed P. procax's 21 instead of its own
  // 1: congeners described in one paper share an author string verbatim, so
  // authorship could not tell a genus transfer from a different frog.
  //
  // Nothing is re-derived now. Each candidate arrives with the verdict matching
  // gave it, and chooseRepresentative sorts them: a key that is this species'
  // own beats one kept from a refused lump, then more records wins, then the key
  // itself so runs are reproducible.
  //
  // "More records wins" matters because CoL sometimes carries one organism as two
  // accepted usages in different genera and GBIF splits the records between them.
  // The Red List uses the older genus, so the obvious choice picks the emptier:
  // Hylatomus pileatus held 156 records, Dryocopus pileatus 5,371,684. Ranking by
  // count is only safe because the verdict has already established these are the
  // same bird — it is not deciding that here.
  const candidates = new Map<number, Array<{ key: string; count: number; verdict: Verdict }>>();
  for (const row of (await conn.runAndReadAll(`
        SELECT m.sis_taxon_id, m.gbif_species_key, m.verdict, g.total_count
        FROM map m JOIN gbif_all g ON g.gbif_species_key = m.gbif_species_key`)).getRowObjects()) {
    const id = Number(row.sis_taxon_id);
    const list = candidates.get(id) ?? [];
    list.push({
      key: String(row.gbif_species_key),
      count: Number(row.total_count ?? 0),
      verdict: (row.verdict as Verdict) || "own",
    });
    candidates.set(id, list);
  }
  const chosenRows: Array<{ sis_taxon_id: number; gbif_species_key: string }> = [];
  for (const [id, list] of candidates) {
    const best = chooseRepresentative(list);
    if (best) chosenRows.push({ sis_taxon_id: id, gbif_species_key: best.key });
  }
  const chosenCsv = path.join(DATA_DIR, "_chosen-link.csv");
  writeCsv(chosenRows, ["sis_taxon_id", "gbif_species_key"], chosenCsv);
  await conn.run(`
    CREATE TEMP TABLE chosen_link AS
      SELECT CAST(sis_taxon_id AS BIGINT) AS sis_taxon_id,
             CAST(gbif_species_key AS VARCHAR) AS gbif_species_key
      FROM read_csv_auto('${chosenCsv}', ${CSV_QUOTING});
  `);
  fs.rmSync(chosenCsv, { force: true });
  await conn.run(`
    CREATE TEMP TABLE enrich AS
      SELECT
        c.sis_taxon_id,
        g.total_count  AS gbif_occurrence_count,
        g.count_after  AS gbif_observations_after_assessment_year,
        g.total_count_all AS gbif_occurrence_count_all,
        g.count_after_all AS gbif_observations_after_assessment_year_all,
        c.gbif_species_key
      FROM chosen_link c
      JOIN gbif_all g ON g.gbif_species_key = c.gbif_species_key;
  `);

  // History, loaded first so the latest credits (assessors/reviewers/facilitators/
  // contributors/institutions) can be denormalized
  // into assessed.parquet below. Flatten the map-shaped history/*.json into rows
  // (one per past assessment), preserving array order via `seq` (index 0 =
  // latest) so the lazy per-species history query can rebuild it in order.
  const ndjson = path.join(DATA_DIR, "_assessments.ndjson");
  const ws = fs.createWriteStream(ndjson);
  if (fs.existsSync(historyDir)) {
    for (const file of fs.readdirSync(historyDir).filter((f) => f.endsWith(".json"))) {
      const data = JSON.parse(fs.readFileSync(path.join(historyDir, file), "utf-8")) as
        // criteria is optional on the parsed shape (not just the type) — history
        // files regenerated before it was added to fetchAssessmentHistory won't
        // have the key at all; `x.criteria ?? null` below handles that at runtime.
        // facilitators/contributors/institutions are optional on the parsed shape
        // for the same reason as criteria: history files written before each was
        // added to fetchAssessmentHistory have no such key at all.
        Record<string, Array<{ id: number; year: string; category: string; date: string | null; criteria?: string | null; assessors: string | null; reviewers: string | null; facilitators?: string | null; contributors?: string | null; institutions?: string | null }>>;
      for (const [sis, arr] of Object.entries(data)) {
        arr.forEach((x, seq) => ws.write(JSON.stringify({ sis_taxon_id: Number(sis), seq, id: x.id, year: x.year, category: x.category, date: x.date, criteria: x.criteria ?? null, assessors: x.assessors, reviewers: x.reviewers, facilitators: x.facilitators ?? null, contributors: x.contributors ?? null, institutions: x.institutions ?? null }) + "\n"));
        // (this NDJSON is a scratch file read straight back by read_json below,
        // so nulls here cost nothing — unlike the history/*.json artifact, which
        // ships in a serverless function; see fetchAssessmentHistory.)
      }
    }
  }
  await new Promise<void>((res) => ws.end(res));
  // Explicit column types (not read_json_auto's sampled inference): criteria is
  // null on most pre-2001 assessments, and auto-inference over a column that's
  // sometimes null/sometimes string can land on JSON type instead of VARCHAR —
  // casting a JSON-typed value to VARCHAR then serializes it (embedding literal
  // quotes in the string) rather than unwrapping it.
  await conn.run(`
    CREATE TEMP TABLE hist AS
      SELECT sis_taxon_id, seq, id, "year", category, "date", criteria, assessors, reviewers, facilitators, contributors, institutions
      FROM read_json('${ndjson}', format='newline_delimited', columns={
        sis_taxon_id: 'BIGINT', seq: 'INTEGER', id: 'BIGINT', "year": 'VARCHAR',
        category: 'VARCHAR', "date": 'VARCHAR', criteria: 'VARCHAR',
        assessors: 'VARCHAR', reviewers: 'VARCHAR', facilitators: 'VARCHAR',
        contributors: 'VARCHAR', institutions: 'VARCHAR'
      });
  `);
  fs.unlinkSync(ndjson);
  // Latest (seq 0 = most recent) credits per species. Denormalized into
  // assessed.parquet so the species list needs NO history join — the list view's
  // credit filters read these scalars; the full history array is fetched lazily
  // (getAssessmentHistory) only when a detail panel opens.
  await conn.run(`
    CREATE TEMP TABLE latest_assess AS
      SELECT sis_taxon_id, assessors AS latest_assessors, reviewers AS latest_reviewers,
             facilitators AS latest_facilitators, contributors AS latest_contributors,
             institutions AS latest_institutions
      FROM hist WHERE seq = 0;
  `);

  // Number of assessments per species (#423 item 1) — one row in hist per past
  // assessment (already deduplicated to one per year by fetchAssessmentHistory),
  // so a plain count is exactly "how many times has this species been assessed."
  // Denormalized into assessed.parquet like latest_assess above, so the species
  // list needs no join at query time.
  await conn.run(`
    CREATE TEMP TABLE assess_count AS
      SELECT sis_taxon_id, count(*) AS assessment_count
      FROM hist GROUP BY sis_taxon_id;
  `);

  // Assessed (IUCN Red List) — the hot, bounded, rich dataset.
  await conn.run(`
    COPY (
      SELECT
        CAST(r.sis_taxon_id AS BIGINT)   AS id,
        r.scientific_name, r.common_name,
        r.taxon_group_table1a            AS taxon_group,
        lower(r.class_name) AS class_name, lower(r.order_name) AS order_name, lower(r.family) AS family,
        r.iucn_category,
        CAST(r.assessment_id AS BIGINT)  AS assessment_id,
        -- keep as raw strings (read_csv may infer DATE/INT) to match the CSV path
        CAST(r.assessment_date AS VARCHAR) AS assessment_date,
        CAST(r.year_published AS VARCHAR)  AS year_published,
        r.countries,
        e.gbif_species_key,
        e.gbif_occurrence_count,
        e.gbif_observations_after_assessment_year,
        e.gbif_occurrence_count_all,
        e.gbif_observations_after_assessment_year_all,
        -- arrays kept as raw ';'-joined strings (query layer splits, matching
        -- loadRedlistForGroup); booleans as 'true'.
        nullif(r.population_trend, '')    AS population_trend,
        r.systems, r.growth_forms,
        nullif(r.movement_pattern, '')    AS movement_pattern,
        coalesce(CAST(r.possibly_extinct AS VARCHAR), '') = 'true'             AS possibly_extinct,
        coalesce(CAST(r.possibly_extinct_in_the_wild AS VARCHAR), '') = 'true' AS possibly_extinct_in_the_wild,
        nullif(r.criteria, '')            AS criteria,
        r.threat_codes, r.habitat_codes,
        la.latest_assessors, la.latest_reviewers, la.latest_facilitators,
        la.latest_contributors, la.latest_institutions,
        coalesce(ac.assessment_count, 1)  AS assessment_count
      FROM read_csv_auto('${redlistGlob}', union_by_name=true, ${CSV_QUOTING}) r
      LEFT JOIN enrich e ON e.sis_taxon_id = r.sis_taxon_id
      LEFT JOIN latest_assess la ON la.sis_taxon_id = r.sis_taxon_id
      LEFT JOIN assess_count ac ON ac.sis_taxon_id = r.sis_taxon_id
      ORDER BY class_name, order_name, family, scientific_name
    ) TO '${assessedOut}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `);

  // Common names for unassessed species.
  //
  // GBIF's v2 match returns no vernacular field, so these come from Catalogue of
  // Life's own vernacular file (build-backbone). Without it every one of the
  // ~669k GBIF species rows carries an empty common name, and the ~88.5k that
  // have one stop being findable by it — which is what happened, unnoticed,
  // because nothing measured name coverage.
  //
  // Written by build-backbone, which this migration moved to phase 4, ahead of
  // this phase at 9 — so in a normal sync it is present. The empty-table fallback
  // is kept for partial runs of build-parquet on a machine that has never built a
  // backbone, where an absent file should mean "no common names", not a crash.
  const vernacularParquet = path.join(DATA_DIR, "species-vernaculars.parquet");
  if (fs.existsSync(vernacularParquet)) {
    await conn.run(`CREATE TEMP TABLE species_vernaculars AS SELECT * FROM '${vernacularParquet}';`);
    const vn = (await conn.runAndReadAll(`SELECT count(*) c FROM species_vernaculars`)).getRowObjects()[0].c;
    console.log(`  species common names available: ${Number(vn).toLocaleString()}`);
  } else {
    await conn.run(`CREATE TEMP TABLE species_vernaculars (col_id VARCHAR, vernacular_name VARCHAR);`);
    console.warn(`  ${vernacularParquet} not found — unassessed species will have no common names this run.`);
  }

  // Unassessed (GBIF species with no IUCN assessment) — cold, huge under CoL,
  // lean schema (no assessment-only columns).
  await conn.run(`
    CREATE TEMP TABLE assessed_names AS
      SELECT DISTINCT r.scientific_name, r.taxon_group_table1a AS taxon_group
      FROM read_csv_auto('${redlistGlob}', union_by_name=true, ${CSV_QUOTING}) r;
  `);
  await conn.run(`
    COPY (
      SELECT
        -- Synthetic negative id; assessed rows use the positive sis_taxon_id.
        -- Was the negated GBIF key, which alphanumeric CoL keys cannot provide.
        -- Hashed rather than sequential because the dashboard persists pinned
        -- species by abs(id), so the id has to survive a resync that adds or
        -- removes species; masked to 2^53 so it stays exactly representable once
        -- the query layer turns it into a JS number. The assertion below rechecks
        -- uniqueness on every build rather than assuming it.
        -(hash(g.gbif_species_key) % 9007199254740992)::BIGINT AS id,
        g.scientific_name,
        coalesce(nullif(g.common_name, ''), v.vernacular_name, '') AS common_name,
        g.taxon_group, g.class_name, g.order_name, g.family,
        'NE'                             AS iucn_category,
        g.countries,
        g.gbif_species_key,
        g.total_count                    AS gbif_occurrence_count,
        g.total_count_all                AS gbif_occurrence_count_all
      FROM gbif_all g
      LEFT JOIN species_vernaculars v ON v.col_id = g.gbif_species_key
      WHERE g.gbif_species_key NOT IN (SELECT DISTINCT gbif_species_key FROM map)
        AND g.gbif_species_key NOT IN (${domesticated})
        -- ...and not a second usage of a species that IS assessed.
        --
        -- Catalogue of Life carries some taxa twice, once accepted and once
        -- 'provisionally accepted', under the same name in the same genus. The
        -- assessed row takes the accepted key, and the other one then arrives
        -- here and is published as a browsable species — so Miniopterus
        -- schreibersii, a VU bat, was listed simultaneously as Not Evaluated,
        -- with 27,596 records under the twin and 24,530 under itself. Columba
        -- livia came back the same way, through the very list written to keep it
        -- out. Matching on name within the group is enough: a genuine homonym in
        -- another kingdom is in another taxon group.
        AND NOT EXISTS (
          SELECT 1 FROM assessed_names a
          WHERE a.scientific_name = g.scientific_name AND a.taxon_group = g.taxon_group
        )
      ORDER BY class_name, order_name, family, scientific_name
    ) TO '${unassessedOut}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `);

  // Assessments (history) — persist the flattened rows (built above) sorted by
  // sis_taxon_id so a single-species lazy lookup prunes to one row group.
  await conn.run(`
    COPY (
      SELECT sis_taxon_id, seq, id, "year", category, "date", criteria, assessors, reviewers, facilitators, contributors, institutions
      FROM hist
      ORDER BY sis_taxon_id, seq
    ) TO '${assessmentsOut}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `);

  const q = async (sql: string) => (await (await conn.run(sql)).getRowObjects());
  const a = (await q(`
    SELECT count(*) n,
           count(*) FILTER (gbif_occurrence_count IS NOT NULL) with_obs,
           count(*) FILTER (gbif_observations_after_assessment_year IS NOT NULL) with_caa,
           count(*) FILTER (gbif_occurrence_count_all IS NOT NULL) with_obs_all
    FROM '${assessedOut}'`))[0];
  const ne = (await q(`SELECT count(*) n FROM '${unassessedOut}'`))[0];
  console.log(`Wrote ${assessedOut}: ${a.n} assessed (with occurrence_count ${a.with_obs}, with count-after ${a.with_caa}, with any record at all ${a.with_obs_all})`);
  console.log(`Wrote ${unassessedOut}: ${ne.n} unassessed (NE)`);
  const h = (await q(`SELECT count(*) nrows, count(DISTINCT sis_taxon_id) species FROM '${assessmentsOut}'`))[0];
  console.log(`Wrote ${assessmentsOut}: ${h.nrows} assessment events across ${h.species} species`);
  const shared = (await q(
    `SELECT count(*) c FROM (SELECT gbif_species_key FROM gbif_rows GROUP BY 1 HAVING count(DISTINCT taxon_group) > 1)`
  ))[0].c;
  console.log(`  species fetched by more than one group (assigned to the narrower): ${shared}`);

  // The unassessed id is a hash, so uniqueness is checked rather than assumed.
  const idDup = (await q(`SELECT count(*) c FROM (SELECT id FROM '${unassessedOut}' GROUP BY 1 HAVING count(*)>1)`))[0].c;
  if (Number(idDup) > 0) {
    throw new Error(`build-parquet: ${idDup} colliding synthetic ids in ${unassessedOut} — two unassessed species would share a row identity.`);
  }

  // Records since assessment are a subset of the total, so one exceeding the other
  // is arithmetically impossible for a single taxon and means counts from
  // different taxa have been combined — 43 species were in that state after the
  // previous attempt, from querying a taxon and its own parent.
  //
  // A handful of cases are expected regardless, and are not that: GBIF's
  // speciesKey facet returns approximate counts on very large queries, so a total
  // taken from a whole-order facet can come back slightly under a count taken
  // from a small year-bucketed one. Uroxys rugatus reads 2 against a true 28 for
  // exactly this reason. The threshold separates that noise from a systematic
  // fault; the count is always reported.
  const IMPOSSIBLE_TOLERANCE = 20;
  // Checked for both counts, plus the one relation between them: every record can
  // never be fewer than the georeferenced ones. The sync scripts enforce that last
  // one outright, so any breach here means the two columns have come from
  // different keys.
  const impossible = Number((await q(
    `SELECT count(*) c FROM '${assessedOut}'
     WHERE gbif_observations_after_assessment_year > gbif_occurrence_count
        OR gbif_observations_after_assessment_year_all > gbif_occurrence_count_all
        OR gbif_occurrence_count > gbif_occurrence_count_all
        OR gbif_observations_after_assessment_year > gbif_observations_after_assessment_year_all`
  ))[0].c);
  if (impossible > 0) {
    console.log(`  species with a count above one that contains it (facet approximation): ${impossible}`);
  }
  if (impossible > IMPOSSIBLE_TOLERANCE) {
    throw new Error(
      `build-parquet: ${impossible} species have a count above one that contains it (records since ` +
      `assessment above the total, or georeferenced above all records), ` +
      `above the ${IMPOSSIBLE_TOLERANCE} expected from facet approximation. That many means counts ` +
      `from different taxa are being combined.`
    );
  }
}

const isDirectRun = process.argv[1]?.endsWith("build-parquet.ts") || process.argv[1]?.endsWith("build-parquet.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
}
