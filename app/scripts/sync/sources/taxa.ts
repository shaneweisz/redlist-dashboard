/**
 * taxa: one row per Catalogue of Life XR usage (accepted names, synonyms,
 * infraspecifics, BOLD BINs). Every list of species is a filter over it.
 *
 * Built from: the CoL XR (NameUsage.tsv, Reference.tsv), the NameUsage.tsv and
 * Base source ids of the curated release that XR was built from,
 * seeds/domesticated-and-humans.tsv.
 *
 * Columns:
 *   col_id, parent_id, status, rank, scientific_name, authorship   from the XR
 *   kingdom … genus      lowercased lineage (the XR ships it denormalised)
 *   described_year       author year, else basionym year, else the year of the
 *                        name's cited reference
 *   extinct              CoL's tri-state fossil flag
 *   in_base              sourced from a curated Base GSD, not the XR's tail of
 *                        single fossil papers
 *   in_checklist, checklist_status, checklist_parent_id, checklist_name
 *                        the usage as the curated release (catalogueoflife.org)
 *                        has it
 *   demoted              an XR accepted species the curated release treats as a
 *                        synonym or infraspecific (none, against the XR's own release)
 *   species_id           the accepted species this usage's GBIF records count
 *                        towards: itself, a synonym's accepted species, or an
 *                        infraspecific's or BIN's species. NULL above species
 *                        rank and for misapplied names.
 *   taxon_group          the Table 1a group, from CoL's lineage (taxon-groups.ts)
 *   ne_excluded          why the species is never Not Evaluated (domesticated,
 *                        human), else NULL
 *
 * Decisions:
 *   - species_id follows the XR, which is what GBIF indexes, so totals match
 *     gbif.org. The curated release only demotes: curated silence never removes
 *     a species (macroalgae, whose source isn't in the curated release), only
 *     curated contradiction does. Read against the release its XR was built
 *     from, it demotes nothing (COL26.6 XR); a newer one demoted 8,738 species,
 *     which was CoL's later taxonomy, not an XR error.
 *   - A misapplied name is someone else's concept and counts towards nothing.
 *   - A usage takes its species' group, so a synonym can't land in another group
 *     than the species it counts towards.
 *
 * Checks: every name in seeds/domesticated-and-humans.tsv is still an accepted species (if
 * CoL lumped a domestic form into its wild sibling, the wild species would
 * absorb its records).
 */

import * as fs from "fs";
import { type DuckDBConnection } from "@duckdb/node-api";
import { TAXON_GROUP_CASE } from "./taxon-groups";
import { readSeed } from "../seeds/seeds";
import { output } from "../paths";
import { lit, openDuckDB } from "../sql";

const INFRASPECIFIC = "('subspecies','variety','form','subvariety','subform','natio','aberration','infraspecific name','infrasubspecific name')";
/**
 * Ranks that count towards the species above them. 'unranked' is mostly BOLD
 * BINs (887k usages in COL26.6 XR); GBIF matches DNA-barcode records to them and
 * credits the parent species, so a BIN under a species counts towards it. One
 * under a genus or family stays unresolved, as GBIF leaves it.
 */
const BELOW_SPECIES = INFRASPECIFIC.replace("(", "('unranked',");

const tsv = (p: string) => `read_csv(${lit(p)}, delim='\t', header=true, quote='', ignore_errors=true, all_varchar=true)`;
/** The XR writes a subgenus parenthetical in some names; the binomial is what everything joins on. */
const CANONICAL = (col: string) => `trim(regexp_replace(regexp_replace(${col}, '\\([^)]*\\)', '', 'g'), '\\s+', ' ', 'g'))`;

export interface TaxaInputs {
  nameUsage: string;
  reference?: string;
  checklistNameUsage?: string;
  baseSourceIds: string[];
  /** name → kind; defaults to seeds/domesticated-and-humans.tsv, tests pass their own. */
  neExcluded?: Record<string, string>;
}

/** XR species the curated release demotes (taxa.demoted). */
export async function demotedCount(taxaFile: string): Promise<number> {
  const conn = await openDuckDB();
  const [r] = (await conn.runAndReadAll(`SELECT count(*) FILTER (demoted)::INTEGER AS n FROM read_parquet(${lit(taxaFile)})`)).getRowObjects();
  return Number(r.n);
}

export async function buildTaxa(inputs: TaxaInputs, taxaFile: string): Promise<void> {
  const conn = await openDuckDB();
  const out = output(taxaFile);

  await conn.run(`CREATE OR REPLACE TEMP TABLE base_src AS SELECT unnest([${inputs.baseSourceIds.map(lit).join(", ")}]::VARCHAR[]) AS id`);

  await conn.run(`CREATE OR REPLACE TEMP TABLE checklist AS ${inputs.checklistNameUsage
    ? `SELECT "col:ID" AS col_id, "col:status" AS status, "col:rank" AS rank, "col:parentID" AS parent_id,
              ${CANONICAL(`"col:scientificName"`)} AS scientific_name
       FROM ${tsv(inputs.checklistNameUsage)} WHERE "col:ID" IS NOT NULL`
    : `SELECT NULL::VARCHAR col_id, NULL::VARCHAR status, NULL::VARCHAR rank, NULL::VARCHAR parent_id, NULL::VARCHAR scientific_name WHERE false`}`);

  await conn.run(`CREATE OR REPLACE TEMP TABLE nu AS
    SELECT "col:ID" AS col_id, "col:parentID" AS parent_id, "col:status" AS status, "col:rank" AS rank,
           ${CANONICAL(`"col:scientificName"`)} AS scientific_name, "col:authorship" AS authorship,
           TRY_CAST("col:combinationAuthorshipYear" AS INTEGER) AS combination_year,
           TRY_CAST("col:basionymAuthorshipYear" AS INTEGER) AS basionym_year,
           "col:nameReferenceID" AS name_reference_id,
           lower("col:kingdom") AS kingdom, lower("col:phylum") AS phylum, lower("col:class") AS class_name,
           lower("col:order") AS order_name, lower("col:family") AS family, lower("col:genus") AS genus,
           "col:sourceID" AS source_id,
           CASE WHEN lower("col:extinct") = 'true' THEN TRUE WHEN lower("col:extinct") = 'false' THEN FALSE END AS extinct
    FROM ${tsv(inputs.nameUsage)} WHERE "col:ID" IS NOT NULL`);

  // Publication year of each reference: col:issued, else the LAST plausible
  // 4-digit year in the citation (the year trails volume, page and plate
  // numbers), with DOIs and URLs stripped first since their digits trail too
  // (#295, Calandrinia villaroelii's "phytotaxa.1543"). 1753 is the start of
  // botanical nomenclature; nothing earlier is a real description year.
  const minYear = 1753;
  const maxYear = new Date().getUTCFullYear() + 1;
  await conn.run(`CREATE OR REPLACE TEMP TABLE ref AS ${inputs.reference && fs.existsSync(inputs.reference)
    ? `SELECT rid, ryr FROM (
         SELECT "col:ID" AS rid, coalesce(
           TRY_CAST(regexp_extract("col:issued", '(\\d{4})', 1) AS INTEGER),
           list_last(list_filter(list_transform(regexp_extract_all(
             regexp_replace("col:citation", 'https?://\\S+|10\\.\\d{4,9}/\\S+', ' ', 'g'), '\\d{4}'),
             lambda x: TRY_CAST(x AS INTEGER)), lambda y: y >= ${minYear} AND y <= ${maxYear}))) AS ryr
         FROM ${tsv(inputs.reference)}) WHERE rid IS NOT NULL AND ryr BETWEEN ${minYear} AND ${maxYear}`
    : `SELECT NULL::VARCHAR rid, NULL::INTEGER ryr WHERE false`}`);

  // species_id in two hops: a synonym to its accepted usage, then an
  // infraspecific or BIN to the species above it (twice, for a variety under a
  // subspecies or a BIN under a subspecies). Ambiguous synonyms follow CoL's parent like GBIF does;
  // misapplied names are someone else's concept and count towards nothing.
  await conn.run(`CREATE OR REPLACE TEMP TABLE resolved AS
    WITH acc AS (
      SELECT n.col_id,
             CASE WHEN n.status ILIKE '%synonym%' THEN n.parent_id
                  WHEN n.status ILIKE 'misapplied' THEN NULL
                  ELSE n.col_id END AS acc_id
      FROM nu n)
    SELECT acc.col_id,
           CASE WHEN a.rank = 'species' THEN a.col_id
                WHEN a.rank IN ${BELOW_SPECIES} AND p1.rank = 'species' THEN p1.col_id
                WHEN a.rank IN ${BELOW_SPECIES} AND p1.rank IN ${BELOW_SPECIES} AND p2.rank = 'species' THEN p2.col_id
           END AS species_id
    FROM acc
    LEFT JOIN nu a ON a.col_id = acc.acc_id AND a.status NOT ILIKE '%synonym%'
    LEFT JOIN nu p1 ON p1.col_id = a.parent_id
    LEFT JOIN nu p2 ON p2.col_id = p1.parent_id`);

  const excluded = Object.entries(inputs.neExcluded ?? Object.fromEntries(readSeed("domesticated-and-humans.tsv").map((r) => [r.name, r.kind]))).map(([n, why]) => `(${lit(n)}, ${lit(why)})`).join(", ");
  await conn.run(`CREATE OR REPLACE TEMP TABLE ne_excluded(name VARCHAR, why VARCHAR); INSERT INTO ne_excluded VALUES ${excluded}`);

  await conn.run(`COPY (
    WITH grp AS (
      SELECT col_id, ${TAXON_GROUP_CASE} AS taxon_group FROM nu)
    SELECT n.col_id, n.parent_id, n.status, n.rank, n.scientific_name, n.authorship,
           n.kingdom, n.phylum, n.class_name, n.order_name, n.family, n.genus,
           CASE WHEN coalesce(n.combination_year, n.basionym_year, r.ryr) BETWEEN ${minYear} AND ${maxYear}
                THEN coalesce(n.combination_year, n.basionym_year, r.ryr) END AS described_year,
           n.extinct,
           n.source_id IN (SELECT id FROM base_src) AS in_base,
           cl.col_id IS NOT NULL AS in_checklist,
           cl.status AS checklist_status,
           -- Strictly 'synonym': an ambiguous synonym is CoL saying the name's
           -- application is uncertain (Pararge xiphia), so it names no parent.
           CASE WHEN lower(cl.status) = 'synonym' THEN cl.parent_id END AS checklist_parent_id,
           -- Only where the release spells it differently (Witheringia stramoniifolia /
           -- stramonifolia), so text shown beside a link to the release is the release's.
           CASE WHEN cl.scientific_name <> n.scientific_name THEN cl.scientific_name END AS checklist_name,
           -- coalesce: a usage the release doesn't have isn't demoted. Curated
           -- silence never removes a species (macroalgae, whose GSD isn't in the
           -- curated assembly), only curated contradiction does.
           coalesce(n.rank = 'species' AND n.status = 'accepted' AND (
              lower(cl.status) LIKE '%synonym%' OR lower(cl.status) = 'misapplied'
              OR (lower(cl.status) IN ('accepted', 'provisionally accepted') AND lower(cl.rank) IN ${INFRASPECIFIC})), false) AS demoted,
           rs.species_id,
           -- A usage takes its species' group, so a synonym can't land in another
           -- group than the species it counts towards; above species rank, its own.
           coalesce(gs.taxon_group, g.taxon_group) AS taxon_group,
           CASE WHEN n.rank = 'species' AND n.status = 'accepted' THEN x.why END AS ne_excluded
    FROM nu n
    LEFT JOIN ref r ON r.rid = n.name_reference_id
    LEFT JOIN checklist cl ON cl.col_id = n.col_id
    LEFT JOIN resolved rs ON rs.col_id = n.col_id
    LEFT JOIN grp g ON g.col_id = n.col_id
    LEFT JOIN grp gs ON gs.col_id = rs.species_id
    LEFT JOIN ne_excluded x ON x.name = lower(n.scientific_name)
    ORDER BY taxon_group, n.class_name, n.order_name, n.family, n.scientific_name, n.col_id
  ) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)`);

  // Every excluded name must still be an accepted species. If CoL lumps a
  // domestic form into its wild sibling, the wild species absorbs its records.
  const missing = (await conn.runAndReadAll(`
    SELECT x.name FROM ne_excluded x
    WHERE NOT EXISTS (SELECT 1 FROM read_parquet(${lit(out)}) t
                      WHERE lower(t.scientific_name) = x.name AND t.rank = 'species' AND t.status = 'accepted')
    ORDER BY 1`)).getRowObjects().map((r) => String(r.name));
  if (missing.length > 0) {
    throw new Error(`taxa: excluded names not accepted species in this release: ${missing.join(", ")}. ` +
      "Check whether CoL lumped them into their wild siblings before changing seeds/domesticated-and-humans.tsv.");
  }
  await report(conn, out);
}

async function report(conn: DuckDBConnection, out: string): Promise<void> {
  const [s] = (await conn.runAndReadAll(`SELECT count(*) AS usages,
      count(*) FILTER (rank = 'species' AND status = 'accepted') AS species,
      count(*) FILTER (rank = 'species' AND status = 'accepted' AND NOT demoted AND in_base AND extinct IS NOT TRUE) AS universe,
      count(*) FILTER (demoted) AS demoted,
      count(*) FILTER (status ILIKE '%synonym%' AND rank = 'species' AND species_id IS NULL) AS orphan_synonyms,
      count(*) FILTER (rank IN ${INFRASPECIFIC} AND species_id IS NULL) AS orphan_infra
    FROM read_parquet(${lit(out)})`)).getRowObjects();
  console.log(`Wrote ${out}: ${Number(s.usages).toLocaleString()} usages, ${Number(s.species).toLocaleString()} accepted species, ` +
    `${Number(s.universe).toLocaleString()} in the extant Base universe, ${Number(s.demoted).toLocaleString()} demoted by the checklist`);
  console.log(`  unresolved: ${Number(s.orphan_synonyms).toLocaleString()} species-rank synonyms and ` +
    `${Number(s.orphan_infra).toLocaleString()} infraspecifics with no species_id`);
}
