/**
 * build-backbone (#271, Phase 3): turn the Catalogue of Life eXtended Release
 * (XR) ColDP into the taxonomic-backbone parquets that replace the hand-curated
 * taxonomy tree. Two outputs:
 *
 *  - backbone.parquet   = the full CoL NameUsage (all ranks + synonyms): one row
 *      per usage with col_id, parent_id, status, rank, scientific_name,
 *      authorship. The tree edges (parent_id), synonym→accepted resolution, and
 *      arbitrary-rank nodes all derive from this. Lean (~9.4M rows), single file.
 *  - species/           = the accepted-species universe (~2.4M), Hive-partitioned
 *      for pruning. XR ships denormalized lineage, so each row carries kingdom…genus
 *      directly (no parent_id walk), plus a `described_year` (the species' description
 *      year, from the author-year columns with a Reference.tsv-year fallback). Partitioned by `part` (= phylum within Animalia,
 *      else kingdom) since Animalia is 1.8M / Arthropoda 1.35M — this isolates the
 *      giant clades. Lineage-sorted within each partition. Each row carries two flags
 *      that define the DISPLAYABLE EXTANT universe: `extinct` (CoL's col:extinct
 *      tri-state) and `in_base` (its source is a curated CoL Base GSD, not the XR
 *      paleo-paper tail). The read layer's universe = `in_base AND extinct IS NOT
 *      TRUE`, which tracks IUCN Table 1a "described" (= extant) counts.
 *
 * Curated-checklist demotion overlay: XR maximizes coverage but does NOT reconcile
 * conflicting source taxonomies, so it over-splits — surfacing contested splits as
 * accepted species that become spurious "Not Evaluated" rows (e.g. Pycnonotus
 * tricolor: accepted species in XR, but a synonym of the assessed P. barbatus in the
 * curated CoL Checklist). We correct this by dropping from species/ any col_id the
 * curated checklist DEMOTES (to synonym / infraspecific). The principle is
 * asymmetric: curated CONTRADICTION removes a species, but curated SILENCE never
 * does — so groups XR has and the checklist lacks (e.g. macroalgae, whose AlgaeBase
 * GSD isn't in the curated assembly) are preserved. col_ids are shared across both
 * datasets so the join is exact. The demotion set comes from fetch-col-checklist
 * (the simple 3LR ColDP); when absent (e.g. a partial run), no demotions are applied.
 *
 * Input: NameUsage.tsv from the XR ColDP archive (env COLDP_TSV, else
 * data/_coldp_xr.tsv). A companion fetch step downloads the export.zip
 * (api.checklistbank.org/dataset/313100/export.zip?format=ColDP&extended=true)
 * and extracts NameUsage.tsv; this script is the transform. XR ≈ ChecklistBank
 * dataset 313100 ("COL25.11 XR"), a swappable pinned dep. The demotion overlay reads
 * the curated checklist NameUsage (env COL_CHECKLIST_TSV / opts.demotionsTsv).
 *
 *   COLDP_TSV=/path/to/NameUsage.tsv npx tsx scripts/build-backbone.ts
 */
import * as fs from "fs";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadEnvFiles, DATA_DIR } from "./utils";

// The browsable species universe is status='accepted' ONLY. CoL also marks names
// 'provisionally accepted' — its uncertainty hedge, a grab-bag of dubious names
// and unflagged fossils. Including them overshoots IUCN Table 1a described counts
// (e.g. mammals 1.26× vs 1.05× accepted-only; Table 1a "described" = extant), so
// the universe excludes them. The backbone below still keeps EVERY usage
// (provisional + synonyms) for tree edges + synonym→accepted resolution.
const SPECIES_STATUS = "('accepted')";

// CoL Base release (ChecklistBank dataset key) whose ~165 source datasets are the
// curated "Global Species Databases" (GSDs). XR = Base GSDs + an extended tail of
// mostly individual paleontology papers, each its own source, that describe fossil
// species WITHOUT setting col:extinct — so the extinct flag alone can't catch them.
// We tag each species with in_base = (its sourceID is a Base GSD); the read layer's
// extant universe filters to in_base, dropping that unflagged-fossil tail. Source
// keys are global + version-stable, so a current Base release is a valid allowlist.
// "3LR" is ChecklistBank's rolling alias for the current release (unlike XR, which
// gets a new numeric key every cycle with no rolling alias — see fetch-col-xr.ts) —
// use it rather than a numeric key, which would freeze to that one release forever.
const COL_BASE_DATASET = process.env.COL_BASE_DATASET || "3LR";

// A curated-checklist usage "demotes" an XR-accepted species when the checklist does
// NOT recognize that col_id as an accepted species — i.e. it's a synonym (incl.
// ambiguous synonym), misapplied, or accepted only at an infraspecific rank. Such
// col_ids are dropped from the XR species universe (see the demotion overlay above).
// Written against the `checklist` temp table's plain column names, not the raw
// ColDP headers, since that table is now the single reader of the TSV.
const DEMOTED_PREDICATE = `
  lower(status) LIKE '%synonym%'
  OR lower(status) = 'misapplied'
  OR (lower(status) IN ('accepted', 'provisionally accepted')
      AND lower(rank) IN ('subspecies','variety','form','subvariety','subform','natio','aberration'))`;

// CoL lineage → IUCN Table 1a group, per Table 1a's footnote definitions (2025-2):
// crustaceans = note 6's 7 classes (Maxillopoda split into CoL's copepoda/thecostraca/
// hexanauplia/ichthyostraca); corals = Octocorallia + orders Antipatharia/Corallimorpharia/
// Scleractinia; mosses = note 8; ferns&allies = note 9 (CoL lumps most into polypodiopsida/
// lycopodiopsida); brown_algae = Phaeophyceae (the actual brown seaweeds, not all
// Ochrophytina which includes diatoms). Evaluated top-down: specific groups before the
// `animalia`/kingdom catch-alls. Anything outside the 28 groups → 'other' (not surfaced).
// Lineage columns are already lowercased in the subquery this is applied over.
const TAXON_GROUP_CASE = `
  CASE
    WHEN class_name = 'mammalia' THEN 'mammals'
    WHEN class_name = 'aves' THEN 'birds'
    WHEN class_name = 'reptilia' THEN 'reptiles'
    WHEN class_name = 'amphibia' THEN 'amphibians'
    WHEN class_name IN ('teleostei','elasmobranchii','holocephali','myxini','petromyzonti','chondrostei','cladistii','holostei','dipneusti','coelacanthi') THEN 'fishes'
    WHEN order_name = 'coleoptera' THEN 'beetles'
    WHEN order_name = 'lepidoptera' THEN 'butterflies_and_moths'
    WHEN order_name = 'diptera' THEN 'flies_and_mosquitoes'
    WHEN order_name = 'hymenoptera' THEN 'bees_wasps_and_ants'
    WHEN order_name = 'hemiptera' THEN 'true_bugs'
    WHEN order_name = 'orthoptera' THEN 'grasshoppers_crickets_locusts'
    WHEN order_name = 'odonata' THEN 'dragonflies_and_damselflies'
    WHEN class_name = 'insecta' THEN 'other_insects'
    WHEN class_name = 'arachnida' THEN 'arachnids'
    WHEN phylum = 'mollusca' THEN 'molluscs'
    WHEN class_name IN ('malacostraca','branchiopoda','ostracoda','copepoda','thecostraca','hexanauplia','ichthyostraca','remipedia','cephalocarida','mystacocarida','tantulocarida') THEN 'crustaceans'
    WHEN class_name = 'octocorallia' OR order_name IN ('scleractinia','antipatharia','corallimorpharia') THEN 'corals'
    WHEN phylum = 'onychophora' THEN 'velvet_worms'
    WHEN class_name = 'merostomata' THEN 'horseshoe_crabs'
    WHEN kingdom = 'animalia' THEN 'other_invertebrates'
    WHEN class_name IN ('magnoliopsida','liliopsida') THEN 'flowering_plants'
    WHEN class_name IN ('pinopsida','cycadopsida','ginkgoopsida','gnetopsida') THEN 'gymnosperms'
    WHEN class_name IN ('polypodiopsida','lycopodiopsida','isoetopsida','equisetopsida','marattiopsida','psilotopsida') THEN 'ferns_and_allies'
    WHEN phylum IN ('bryophyta','marchantiophyta','anthocerotophyta') THEN 'mosses'
    WHEN phylum IN ('chlorophyta','charophyta') THEN 'green_algae'
    WHEN phylum = 'rhodophyta' THEN 'red_algae'
    WHEN kingdom = 'fungi' THEN 'mushrooms'
    WHEN class_name = 'phaeophyceae' THEN 'brown_algae'
    ELSE 'other'
  END`;

/**
 * Every column the COPY below writes into backbone.parquet. Declared here, beside
 * the query that produces them, so the sync's staleness check (below) can't drift
 * from what a rebuild actually yields.
 */
export const BACKBONE_COLUMNS = [
  "col_id", "parent_id", "status", "rank", "scientific_name", "authorship",
  "in_checklist", "checklist_parent_id", "checklist_name",
];

/**
 * Does the backbone already on disk have every column a rebuild would write?
 *
 * The sync otherwise decides to skip the (expensive, 3.4GB-download) rebuild purely
 * from the release pins — which say which CoL release the data came from, not which
 * version of this script wrote it. Adding a column here while both pins hold steady
 * therefore produces a backbone that is current by every check the sync makes and
 * still missing a column the read layer queries, failing those queries outright.
 * A parquet DESCRIBE reads footer metadata only (no scan), so asking the file itself
 * costs nothing and closes that gap.
 */
export async function backboneHasCurrentColumns(backbonePath: string): Promise<boolean> {
  try {
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    const rows = await (await conn.run(`DESCRIBE SELECT * FROM read_parquet('${backbonePath}') LIMIT 0`)).getRowObjects();
    const cols = new Set(rows.map((r) => String(r.column_name)));
    return BACKBONE_COLUMNS.every((c) => cols.has(c));
  } catch {
    // Unreadable is not "current" — a rebuild is the right answer either way.
    return false;
  }
}

async function fetchBaseSourceIds(): Promise<string[]> {
  const res = await fetch(`https://api.checklistbank.org/dataset/${COL_BASE_DATASET}/source`);
  if (!res.ok) throw new Error(`Base source list fetch failed (${COL_BASE_DATASET}): ${res.status}`);
  const arr = (await res.json()) as Array<{ key: number }>;
  const ids = arr.map((s) => String(s.key)).filter(Boolean);
  if (ids.length === 0) throw new Error(`Base ${COL_BASE_DATASET} returned no sources`);
  return ids;
}

export async function run(
  opts: { tsv?: string; referenceTsv?: string; vernacularTsv?: string; outDir?: string; baseSourceIds?: string[]; demotionsTsv?: string; demotedColIds?: string[] } = {},
): Promise<void> {
  const tsv = opts.tsv || process.env.COLDP_TSV || path.join(DATA_DIR, "_coldp_xr.tsv");
  if (!fs.existsSync(tsv)) {
    throw new Error(`ColDP TSV not found: ${tsv}. Set COLDP_TSV or run the XR fetch step.`);
  }
  // Reference.tsv (cited publications) sits beside NameUsage.tsv in the fetch dir.
  // It supplies described years for botanical/fungal names via nameReferenceID (see
  // the species/ COPY below). Optional: if absent, described_year falls back to the
  // zoological author-year columns alone (animals stay ~99%, plants/fungi go null).
  const referenceTsv = opts.referenceTsv || process.env.COLDP_REFERENCE_TSV || path.join(path.dirname(tsv), "Reference.tsv");
  const hasReferences = fs.existsSync(referenceTsv);
  if (!hasReferences) {
    console.warn(`build-backbone: Reference.tsv not found (${referenceTsv}); described_year will use author-year columns only (botanical/fungal years will be null).`);
  }
  // VernacularName.tsv (taxonID → common name) sits beside NameUsage.tsv too. Powers
  // order/family/genus/class-level common names in the dynamic taxonomic drilldown
  // (dynamic-taxon.ts) — see the vernacular-names.json write below. Optional: if
  // absent, dynamic nodes just fall back to their capitalized scientific name, same
  // as before this existed.
  const vernacularTsv = opts.vernacularTsv || process.env.COLDP_VERNACULAR_TSV || path.join(path.dirname(tsv), "VernacularName.tsv");
  const hasVernacularNames = fs.existsSync(vernacularTsv);
  if (!hasVernacularNames) {
    console.warn(`build-backbone: VernacularName.tsv not found (${vernacularTsv}); vernacular-names.json will not be (re)written.`);
  }
  const demotionsTsv = opts.demotionsTsv || process.env.COL_CHECKLIST_TSV;
  const outDir = opts.outDir || DATA_DIR;
  const backboneOut = path.join(outDir, "backbone.parquet");
  const speciesDir = path.join(outDir, "species");
  fs.mkdirSync(outDir, { recursive: true });

  const baseSourceIds = opts.baseSourceIds ?? (await fetchBaseSourceIds());

  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  // The Base-GSD source allowlist as a temp table for the in_base tag below.
  await conn.run(`CREATE TEMP TABLE base_src(id VARCHAR);`);
  await conn.run(`INSERT INTO base_src VALUES ${baseSourceIds.map((i) => `('${i.replace(/'/g, "''")}')`).join(",")};`);

  // Curated-checklist demotion denylist (col_ids the curated checklist demotes — see
  // header). Injected directly (tests), else read from the checklist NameUsage, else
  // empty (no demotions). col_ids are shared with XR, so this is an exact anti-join
  // for usages both carry — the release also holds ~94.7k the XR does not, which
  // an anti-join simply never reaches.
  await conn.run(`CREATE TEMP TABLE demoted(col_id VARCHAR);`);
  // Always present, so the backbone projection can join unconditionally. Left
  // empty when the checklist isn't available (a partial run, or the injected
  // demotedColIds test path): in_checklist is then false for every row, which
  // reads as "we cannot confirm this is in the curated release" — the safe
  // direction, since every consumer uses it to WITHHOLD a claim.
  await conn.run(`CREATE TEMP TABLE checklist(col_id VARCHAR, status VARCHAR, rank VARCHAR, parent_id VARCHAR, scientific_name VARCHAR);`);
  if (opts.demotedColIds) {
    if (opts.demotedColIds.length) {
      await conn.run(`INSERT INTO demoted VALUES ${opts.demotedColIds.map((i) => `('${i.replace(/'/g, "''")}')`).join(",")};`);
    }
  } else if (demotionsTsv) {
    if (!fs.existsSync(demotionsTsv)) throw new Error(`Checklist demotions TSV not found: ${demotionsTsv}`);
    // One read of the 1.8 GB checklist TSV, two consumers: the demotion denylist
    // below, and the in_checklist/checklist_parent_id columns on backbone.parquet.
    // It used to be read once per consumer.
    await conn.run(`
      INSERT INTO checklist
        SELECT "col:ID" AS col_id, "col:status" AS status, "col:rank" AS rank,
               "col:parentID" AS parent_id,
               -- Same normalisation the XR names get below, so the two are
               -- comparable and the stored value is display-ready.
               trim(regexp_replace(regexp_replace("col:scientificName", '\\([^)]*\\)', '', 'g'), '\\s+', ' ', 'g')) AS scientific_name
        FROM read_csv('${demotionsTsv}', delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true)
        WHERE "col:ID" IS NOT NULL;`);
    await conn.run(`
      INSERT INTO demoted
      SELECT DISTINCT col_id FROM checklist
      WHERE ${DEMOTED_PREDICATE};`);
  }

  // Load the full NameUsage once. all_varchar avoids type-sniffing surprises on
  // the ~9.4M-row / ~70-col ColDP TSV; we only need a handful of columns. The
  // denormalized lineage (col:kingdom…col:genus) and col:extinct are standard
  // ColDP; we no longer read the ChecklistBank-only clb:taxGroup augmentation.
  await conn.run(`
    CREATE TEMP TABLE nu AS
      SELECT
        "col:ID" AS col_id, "col:parentID" AS parent_id, "col:status" AS status,
        "col:rank" AS rank,
        -- Normalize to the canonical binomial: XR writes a subgenus parenthetical
        -- in some names ("Diclidurus (Diclidurus) albus"). Strip it so names match
        -- our plain-binomial Red List/GBIF data (the NE-union dedup + build-matching
        -- both join on name) and display cleanly.
        trim(regexp_replace(regexp_replace("col:scientificName", '\\([^)]*\\)', '', 'g'), '\\s+', ' ', 'g')) AS scientific_name,
        "col:authorship" AS authorship,
        -- Described year: zoological author citations carry the year (ICZN), so the
        -- structured col:combinationAuthorshipYear / col:basionymAuthorshipYear cover
        -- ~99% of animals. Botanical/fungal citations (ICN) omit it, so those fall
        -- back to the cited publication's year via name_reference_id → ref (below).
        TRY_CAST("col:combinationAuthorshipYear" AS INTEGER) AS combination_year,
        TRY_CAST("col:basionymAuthorshipYear" AS INTEGER) AS basionym_year,
        "col:nameReferenceID" AS name_reference_id,
        "col:kingdom" AS kingdom, "col:phylum" AS phylum, "col:class" AS class_name,
        "col:order" AS order_name, "col:family" AS family, "col:genus" AS genus,
        "col:sourceID" AS source_id,
        -- CoL flags a species fossil via col:extinct ('true'/'false'/empty). Kept
        -- as a tri-state boolean (true=fossil, false=extant, null=unflagged): the
        -- species universe filters out true so per-group totals track IUCN Table 1a
        -- (described = extant). The extinct flag is sparse (many fossils are null),
        -- so in_base (below) catches the rest.
        CASE WHEN lower("col:extinct") = 'true' THEN TRUE
             WHEN lower("col:extinct") = 'false' THEN FALSE END AS extinct
      FROM read_csv('${tsv}', delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true);
  `);

  // backbone.parquet — the lean tree + synonyms (all ranks, all statuses).
  await conn.run(`
    COPY (
      SELECT nu.col_id, nu.parent_id, nu.status, nu.rank, nu.scientific_name, nu.authorship,
             -- Is this usage in CoL's CURRENT curated release? The XR carries
             -- everything, reconciled or not; only the release is what a reader
             -- sees on catalogueoflife.org. Claims sourced from XR-only records
             -- send people to a page that doesn't corroborate them, which is how
             -- Stenocranius raddei and Hylomyscus anselli were both misreported.
             cl.col_id IS NOT NULL AS in_checklist,
             -- For usages the RELEASE files as a synonym, the release's own
             -- accepted parent. Not the XR's: the two can disagree, and the claim
             -- we make is about the release, so the edge must come from it.
             --
             -- Strictly 'synonym', NOT LIKE '%synonym%': that also caught
             -- 'ambiguous synonym', which is CoL saying the name's application is
             -- UNCERTAIN. Naming an accepted species from one asserts exactly what
             -- the status disclaims — Pararge xiphia, an ambiguous synonym of
             -- Pararge megera, was reported as a definite rename. 135,881 rows
             -- took a parent from an ambiguous synonym.
             CASE WHEN lower(cl.status) = 'synonym' THEN cl.parent_id END AS checklist_parent_id,
             -- The release's own spelling, stored ONLY where it differs from the
             -- XR's — so it is null for all but a handful of rows and costs
             -- almost nothing. Whatever text we show alongside a link to the
             -- release has to be the text on that page: Witheringia
             -- stramoniifolia (XR) and stramonifolia (release) are the same
             -- species one letter apart, and displaying the wrong one is a milder
             -- form of the mismatch that made Stenocranius raddei confusing.
             CASE WHEN cl.scientific_name IS NOT NULL
                       AND cl.scientific_name <> nu.scientific_name
                  THEN cl.scientific_name END AS checklist_name
      FROM nu LEFT JOIN checklist cl ON cl.col_id = nu.col_id
    )
    TO '${backboneOut}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `);

  // vernacular-names.json — lowercased scientific name -> one common name, for
  // class/order/family/genus ranks only (species already get a common name from
  // our own Red List/GBIF data — see species-store.ts — so those ranks are
  // deliberately excluded here to avoid a second, potentially-conflicting source).
  // A taxon can have several vernacular names (e.g. Anseriformes: "Ducks",
  // "Geese", "Swans", "Waterfowl", "Screamers") — pick one per col:taxonID via
  // ROW_NUMBER, preferring col:preferred=true, else the shortest name (a decent
  // proxy for "the primary/most generic" one), alphabetical as a final tiebreak
  // for determinism. Multiple col_ids can share the same scientific_name (e.g. a
  // synonym and its accepted name) — collapse to one row per name the same way.
  // Two data-quality fixes applied at the final SELECT (checked against real
  // 2026-07-21 CoL XR data): (1) ~3.8% of entries are just the scientific name
  // itself relisted as its own "vernacular name" (e.g. "Acacia" -> "acacia") —
  // pure noise, filtered out; (2) CoL's own casing is inconsistent (~31% start
  // lowercase, e.g. "rodentia" -> "rodents") — the first letter is capitalized
  // for a more consistent display (this DuckDB build has no initcap(); a plain
  // first-letter capitalization is enough to stop a name from looking like a
  // typo without mangling multi-word phrases DuckDB has no easy word-boundary
  // function for).
  const vernacularOut = path.join(outDir, "vernacular-names.json");
  if (hasVernacularNames) {
    await conn.run(`
      CREATE TEMP TABLE vern_best AS
        SELECT col_id, name FROM (
          SELECT "col:taxonID" AS col_id, "col:name" AS name,
                 ROW_NUMBER() OVER (
                   PARTITION BY "col:taxonID"
                   ORDER BY (lower(coalesce("col:preferred", '')) = 'true') DESC, length("col:name") ASC, "col:name" ASC
                 ) AS rn
          FROM read_csv('${vernacularTsv}', delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true)
          WHERE "col:language" = 'eng' AND "col:name" IS NOT NULL AND trim("col:name") != ''
        ) WHERE rn = 1;
    `);
    const rows = (await (await conn.run(`
      SELECT name_lower, name FROM (
        SELECT lower(n.scientific_name) AS name_lower,
               upper(substr(v.name, 1, 1)) || substr(v.name, 2) AS name,
               ROW_NUMBER() OVER (PARTITION BY lower(n.scientific_name) ORDER BY length(v.name) ASC, v.name ASC) AS rn
        FROM vern_best v
        JOIN nu n ON n.col_id = v.col_id
        WHERE n.rank IN ('class', 'order', 'family', 'genus')
          -- Some CoL vernacular entries are just the scientific name itself
          -- (e.g. "Acacia" -> "acacia") — pure noise, not an actual common name.
          AND lower(v.name) != lower(n.scientific_name)
      ) WHERE rn = 1;
    `)).getRowObjects());
    const vernacularMap: Record<string, string> = {};
    for (const r of rows) vernacularMap[String(r.name_lower)] = String(r.name);
    fs.writeFileSync(vernacularOut, JSON.stringify(vernacularMap, null, 0));
    console.log(`Wrote ${vernacularOut}: ${Object.keys(vernacularMap).length.toLocaleString()} class/order/family/genus common names`);

    // species-vernaculars.parquet — col_id -> common name at species rank.
    //
    // Common names for GBIF species used to come from the GBIF species API, one
    // request per species. Its replacement (v2 match) returns no vernacular field
    // at all, and dropping that source silently emptied the common name of all
    // 668,970 unassessed species — making ~88.5k of them unfindable by the only
    // name most people know them by.
    //
    // Best-effort by construction: this is keyed by Catalogue of Life ids from
    // the published export, and GBIF's index carries some usages that export does
    // not, so a few species will not match. A name for most of them beats a name
    // for none.
    const speciesVernacularOut = path.join(outDir, "species-vernaculars.parquet");
    await conn.run(`
      COPY (
        SELECT v.col_id,
               upper(substr(v.name, 1, 1)) || substr(v.name, 2) AS vernacular_name
        FROM vern_best v
        JOIN nu n ON n.col_id = v.col_id
        WHERE n.rank = 'species'
          AND lower(v.name) != lower(n.scientific_name)
      ) TO '${speciesVernacularOut}' (FORMAT PARQUET, COMPRESSION ZSTD);
    `);
    const speciesVernCount = (await (await conn.run(
      `SELECT count(*) AS n FROM '${speciesVernacularOut}'`
    )).getRowObjects())[0].n;
    console.log(`Wrote ${speciesVernacularOut}: ${Number(speciesVernCount).toLocaleString()} species common names`);
  }

  // Plausible-publication-year window. Upper bound: next calendar year (tolerates
  // early-release dates; also drops 4-digit plate/figure numbers above it). Lower bound:
  // 1753 — Linnaeus's Species Plantarum, the start of valid botanical nomenclature (zoology
  // dates from 1758, but 1753 is the safe universal floor: it excludes no validly-published
  // name). Any earlier year is necessarily a mis-parse (a volume/DOI/figure number that
  // slipped through), so we null it rather than surface a pre-Linnaean "described year".
  const maxYear = new Date().getUTCFullYear() + 1;
  const minYear = 1753;

  // ref — reference_id → publication year. Preferred from the structured col:issued
  // (a CSL date: bare year, "1875-03", "[1875]", or a range — take the first 4-digit
  // run); but col:issued is unpopulated for most botanical/fungal references, so fall
  // back to the year in the free-text col:citation ("… Sp. Pl. 2: 753. 1753.").
  // CRITICAL: take the LAST in-range 4-digit token, not the first. The publication
  // year always trails the volume/page/PLATE numbers in a citation, and those can be
  // 4 digits too ("Icon. Pl. 21: t. 2038a (1890)" → must yield 1890, not the plate
  // 2038). So we collect every 4-digit run, keep the ones in [minYear, maxYear] (drops
  // plate numbers like 2038), and take the last — the trailing year. But first strip any
  // DOI/URL: those usually trail the real year and carry in-range 4-digit runs (#295:
  // Calandrinia villaroelii's "…/phytotaxa.1543…" → was picked as 1543), so they'd win
  // "take the last". Empty table when Reference.tsv is absent (join below is a no-op).
  await conn.run(`
    CREATE TEMP TABLE ref AS
      SELECT rid, ryr FROM (
        ${hasReferences ? `
        SELECT "col:ID" AS rid,
               coalesce(
                 TRY_CAST(regexp_extract("col:issued", '(\\d{4})', 1) AS INTEGER),
                 list_last(list_filter(
                   list_transform(
                     regexp_extract_all(
                       regexp_replace("col:citation", 'https?://\\S+|10\\.\\d{4,9}/\\S+', ' ', 'g'),
                       '\\d{4}'),
                     x -> TRY_CAST(x AS INTEGER)),
                   y -> y >= ${minYear} AND y <= ${maxYear}
                 ))
               ) AS ryr
        FROM read_csv('${referenceTsv}', delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true)
        ` : `SELECT NULL::VARCHAR AS rid, NULL::INTEGER AS ryr`}
      ) WHERE rid IS NOT NULL AND ryr BETWEEN ${minYear} AND ${maxYear};
  `);

  // species/ — accepted species only, lineage from XR's denormalized columns,
  // partitioned by `taxon_group` (the IUCN Table 1a group) so the read layer filters
  // species/ with the SAME predicate it uses for assessed/unassessed (taxon_group),
  // and the partition prunes to the group(s). taxon_group is derived from the lineage
  // per Table 1a's footnote definitions (TAXON_GROUP_CASE); species outside the 28
  // groups (microbes, viruses, unplaced) fall to 'other' and aren't surfaced.
  // described_year = the species' description year, coalesced from (1) the current
  // combination's author year, (2) the basionym's author year (zoological new
  // combinations cite the original year in parens), (3) the year of the name's cited
  // reference (the protologue — col:issued, else parsed from col:citation; covers the
  // botanical/fungal names that omit the author year). Bounded to a sane window to drop
  // mis-parses. Coverage: animals ~99%, fungi ~99%, higher plants ~98%; the rest stay
  // null (no author year and no datable reference — ~0.1% of the universe).
  fs.rmSync(speciesDir, { recursive: true, force: true });
  await conn.run(`
    COPY (
      SELECT col_id, scientific_name, authorship, described_year, kingdom, phylum, class_name, order_name, family, genus,
             extinct, in_base, ${TAXON_GROUP_CASE} AS taxon_group
      FROM (
        SELECT n.col_id, n.scientific_name, n.authorship,
               CASE WHEN coalesce(n.combination_year, n.basionym_year, r.ryr) BETWEEN ${minYear} AND ${maxYear}
                    THEN coalesce(n.combination_year, n.basionym_year, r.ryr) END AS described_year,
               lower(n.kingdom) AS kingdom, lower(n.phylum) AS phylum, lower(n.class_name) AS class_name,
               lower(n.order_name) AS order_name, lower(n.family) AS family, lower(n.genus) AS genus,
               n.extinct, (n.source_id IN (SELECT id FROM base_src)) AS in_base
        FROM nu n
        LEFT JOIN ref r ON r.rid = n.name_reference_id
        WHERE n.rank = 'species' AND n.status IN ${SPECIES_STATUS}
          -- Drop XR over-splits the curated checklist demotes (e.g. Pycnonotus tricolor).
          AND n.col_id NOT IN (SELECT col_id FROM demoted)

      )
      ORDER BY taxon_group, class_name, order_name, family, scientific_name
    ) TO '${speciesDir}' (FORMAT PARQUET, PARTITION_BY (taxon_group), COMPRESSION ZSTD, ROW_GROUP_SIZE 20000, OVERWRITE_OR_IGNORE);
  `);

  // ── verification ───────────────────────────────────────────────────────────
  const q = async (sql: string) => (await (await conn.run(sql)).getRowObjects());
  const bb = (await q(`SELECT count(*) n, count(*) FILTER (status='accepted') acc,
                              count(*) FILTER (status='provisionally accepted') prov,
                              count(*) FILTER (status LIKE '%synonym%') syn FROM '${backboneOut}'`))[0];
  console.log(`Wrote ${backboneOut}: ${Number(bb.n).toLocaleString()} usages (${Number(bb.acc).toLocaleString()} accepted, ${Number(bb.prov).toLocaleString()} provisionally accepted, ${Number(bb.syn).toLocaleString()} synonyms)`);
  const sp = (await q(`SELECT count(*) n, count(DISTINCT taxon_group) AS ngroups,
                              count(*) FILTER (extinct IS TRUE) AS fossil,
                              count(*) FILTER (NOT in_base) AS non_base,
                              count(*) FILTER (in_base AND extinct IS NOT TRUE) AS universe,
                              count(*) FILTER (taxon_group = 'other') AS other
                       FROM '${speciesDir}/**/*.parquet'`))[0];
  const demotedN = Number((await q(`SELECT count(*) n FROM demoted`))[0].n);
  console.log(`Wrote ${speciesDir}/: ${Number(sp.n).toLocaleString()} accepted species across ${Number(sp.ngroups)} taxon_group partitions (${baseSourceIds.length} Base GSD sources; ${demotedN.toLocaleString()} curated-checklist demotions applied)`);
  console.log(`  extant universe (in_base AND NOT fossil): ${Number(sp.universe).toLocaleString()} — drops ${Number(sp.fossil).toLocaleString()} flagged fossils + ${Number(sp.non_base).toLocaleString()} non-Base; ${Number(sp.other).toLocaleString()} outside the 28 groups ('other')`);
  const dy = (await q(`SELECT count(*) FILTER (in_base AND extinct IS NOT TRUE) AS universe,
                              count(*) FILTER (in_base AND extinct IS NOT TRUE AND described_year IS NOT NULL) AS with_year
                       FROM '${speciesDir}/**/*.parquet'`))[0];
  const dyPct = Number(dy.universe) ? ((Number(dy.with_year) / Number(dy.universe)) * 100).toFixed(1) : "0";
  console.log(`  described_year populated for ${Number(dy.with_year).toLocaleString()} / ${Number(dy.universe).toLocaleString()} (${dyPct}%) of the extant universe`);
  const parts = await q(`SELECT taxon_group, count(*) FILTER (in_base AND extinct IS NOT TRUE) n FROM '${speciesDir}/**/*.parquet' GROUP BY taxon_group ORDER BY n DESC LIMIT 6`);
  console.log("  largest groups (extant universe):", parts.map((r) => `${r.taxon_group}=${Number(r.n).toLocaleString()}`).join(", "));
}

const isDirectRun = process.argv[1]?.endsWith("build-backbone.ts") || process.argv[1]?.endsWith("build-backbone.js");
if (isDirectRun) {
  loadEnvFiles();
  run().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
}
