# The data sync

How the dashboard's data is built, why it works the way it does, and how to run it. The code is the reference for the details; this explains the design and points to it. Everything named here lives in `app/scripts/pipeline/` unless a path says otherwise.

![The sync](https://f005.backblazeb2.com/file/dashboard-pr-screenshots/pr-588-sync-rewrite/01-sync-after.png)

The diagram's source is [`diagrams/sync.excalidraw`](diagrams/sync.excalidraw) (open it at excalidraw.com; `diagrams/gen.py` regenerates it).

## Contents

1. [What a sync is](#what-a-sync-is)
2. [Inputs](#inputs)
3. [The four core tables](#the-four-core-tables)
4. [The counting rule](#the-counting-rule)
5. [Matching: which CoL species an assessed species is](#matching-which-col-species-an-assessed-species-is)
6. [The Not Evaluated list](#the-not-evaluated-list)
7. [What the app reads](#what-the-app-reads)
8. [Checks](#checks)
9. [Running it each month](#running-it-each-month)
10. [Decisions and known limits](#decisions-and-known-limits)

## What a sync is

A sync is one immutable set of data files, named by the time it was uploaded (`syncs/2026-11-04T16-18-27Z/` in the `dashboard-data` R2 bucket). Production reads whichever sync `app/latest-sync.txt` names on `main`. Building and uploading a sync changes nothing anyone sees; merging the one-line `latest-sync.txt` change is what goes live, and reverting it goes back.

A sync is built from three inputs and nothing else, monthly, on a local machine (it reads a 255 GiB GBIF mirror, which is why it doesn't run in CI). `npm run sync` takes about five minutes once the inputs are on disk.

The design has one idea: **every number comes from four tables, by one rule.** The old sync answered "how many GBIF records does this species have?" separately for each place the number appeared (per-species API counts, per-group facet files, lumped-species fetches, the Not Evaluated overlay), with two independent matching chains deciding which GBIF taxon a species was. They disagreed, and each disagreement was a bug. Now the question has one answer, computed once.

## Inputs

Each is cached under `~/.cache/redlist-dashboard/` and fetched again only when its version moves.

| Input | What it gives | Version | Code |
|---|---|---|---|
| **Catalogue of Life XR** | every name usage: accepted species, synonyms, infraspecifics, BOLD BINs, with lineage | the release GBIF *indexes* (asked of GBIF), not the newest, so every GBIF key resolves | `inputs/col.ts` |
| **CoL curated checklist** | what catalogueoflife.org shows; used to *demote* XR species the curators treat as synonyms | newest release | `inputs/col.ts` |
| **IUCN Red List Postgres** | every global assessment, taxonomy, synonyms, credits | the database named by `DB_NAME` | `build-assessments.ts` |
| **GBIF monthly snapshot** | every occurrence record, as parquet, keyed by CoL id | newest mirrored date under `~/Data/gbif/` | `build-occurrences.ts` |
| iNaturalist taxonomy | one preferred English common name per species | the calendar month | `inputs/inat.ts` |

Two inputs are guarded:

- **The Red List database is a colleague's.** The session is opened with `default_transaction_read_only=on` and attached `READ_ONLY`, and the build asks Postgres to confirm read-only before it reads anything; if Postgres says otherwise it stops.
- **A snapshot is only exact if it is complete.** From 2025-07 to 2026-10 every GBIF mirror silently lacked one file in twenty ([gbif/occurrence#609](https://github.com/gbif/occurrence/issues/609)). The build refuses a snapshot whose file numbering has gaps, or whose parquet footers don't add up to the `totalRecords` of the GBIF download it was made from.

Since October 2026 GBIF indexes records against the CoL XR, so **a GBIF taxon key is a CoL id**. That is what makes one taxonomy possible: matching an assessed species to CoL also decides its GBIF records.

## The four core tables

In `~/.cache/redlist-dashboard/build/core/`. Nothing else is a source of truth; everything the app reads is a query over these.

| Table | One row per | Built by |
|---|---|---|
| `taxa` | CoL usage (8.0M) | `build-taxa.ts` |
| `assessments` | global assessment of a current species (all years) | `build-assessments.ts` |
| `occurrence_counts` | usage × year × georeferenced × record type, with a count | `build-occurrences.ts` |
| `assessment_link` | assessed species × CoL species it is (primary, plus covered rows) | `build-link.ts` |

**`taxa`** is the XR with three things worked out per usage:

- **`species_id`**, the accepted species this usage's GBIF records count towards. A synonym → its accepted species; a subspecies, variety or BOLD BIN → the species above it (up to two levels, for a variety under a subspecies). Misapplied names count towards nothing: they are someone else's concept. This follows the XR, which is what GBIF indexes, so totals match gbif.org.
- **`demoted`**, an XR species the curated checklist treats as a synonym or infraspecific (*Pycnonotus tricolor*). The XR over-splits; the checklist is curated. A species the checklist simply lacks is *not* demoted: silence never removes a species, only contradiction does.
- **`taxon_group`**, one of IUCN's 28 Table 1a groups from CoL's lineage (`taxon-groups.ts`). Used only for species IUCN hasn't assessed; assessed species keep IUCN's own group, so Table 1a's totals stay exact. A usage takes its species' group, so a synonym can't land in a different group from the species it counts towards.

**`assessments`** keeps lists as lists (countries, threats, habitats). Dates are dates: the old fetcher converted Postgres's timezone-less timestamps with `toISOString()` on a London machine, so every date in British Summer Time slipped back a day (104,891 species).

**`occurrence_counts`** is the whole snapshot (3.9 billion records) reduced to 4.1M usages' counts by year, by whether the record is georeferenced, and by basis of record. *Georeferenced* means what GBIF's API means by `hasCoordinate=true&hasGeospatialIssue=false`; the snapshot has no `hasGeospatialIssue` column, so it is recomputed from each record's issues using GBIF's own set (`GBIF_GEOSPATIAL_ISSUES` in `app/src/lib/gbif.ts`, checked per code against the live API). A companion table holds the same by country.

**`assessment_link`** is the subject of [Matching](#matching-which-col-species-an-assessed-species-is).

## The counting rule

`counts.ts`, 62 lines. Every GBIF number on the dashboard is this rule with a different filter (georeferenced or all records, since the assessment year, by country, by group).

> A species counts the records of every usage whose `species_id` is that species (its own name, its synonyms, its subspecies, their BINs), **minus usages a separately assessed species owns**, keeping only the record types its kingdom counts.

**Record types.** Animals count observations of living organisms (human, machine, material samples and the like), not preserved specimens: a museum skin says the species was there once, not that it is now. Plants, fungi and algae also count preserved specimens, because a herbarium sheet is often the only georeferenced record a species has. The kingdom is the *species'*, not the usage's: some plant synonyms in CoL carry no kingdom, and would otherwise lose their herbarium records.

**Ownership** is what "minus" means. Most assessed species simply own their CoL species and everything under it. The exceptions come from IUCN and CoL drawing species boundaries differently:

- **A split.** IUCN assesses *Zosterops simplex* separately; CoL files it as *Z. japonicus simplex*, a subspecies. Under the plain rule its records count for *Z. japonicus*. Instead *Z. simplex* owns that subspecies and what's under it, and *Z. japonicus* counts everything else. (The old sync counted them for both: *Z. japonicus* showed 870,598 records including *Z. simplex*'s. Now 298,292 and 572,306.)
- **A lump.** IUCN assesses *Rubus fruticosus*; CoL treats the name as a synonym, filed under three different species. *R. fruticosus* owns the three synonym usages bearing its name, and only those: it can't claim the accepted species' records, since CoL says those are other plants.

A usage has at most one owner, and is counted once. The sync checks this on every run (see [Checks](#checks)).

### Worked examples

From sync `2026-11-04T16-18-27Z`. Counts are georeferenced records.

| Species | What CoL does | Counted | Total |
|---|---|---|---:|
| *Quercus robur* | accepted, same name | its species, all usages under it | 1,548,346 |
| *Zosterops japonicus* | accepted; a split sits under it | its species, minus *Z. simplex*'s 572,306 | 298,292 |
| *Zosterops simplex* | a subspecies of *Z. japonicus* (and a synonym under it) | that subspecies and everything under it | 572,306 |
| *Hylatomus pileatus* | holds the Pileated Woodpecker twice: *H. pileatus* (156) and *Dryocopus pileatus* (5.2M) | both halves (a covered duplicate) | 5,229,882 |
| *Accipiter cooperii* | holds Cooper's hawk twice: *A. cooperii* (86k) and *Astur cooperii* (4.0M) | both halves | 4,066,164 |
| *Fringilla polatzeki* | a synonym filed under the subspecies *F. teydea polatzeki* | its own usages only, not *F. teydea*'s 7,000+ | 715 |
| *Rubus fruticosus* | a synonym under three different species | its three same-name synonym usages | 120,505 |

To follow any species yourself, see [Tracing a species](#tracing-a-species).

## Matching: which CoL species an assessed species is

`build-link.ts`. The hardest part, and the most likely place for a wrong number: a species matched to the wrong CoL species shows someone else's records.

Each assessed species is matched once, by name. Passes run in priority order and the first hit wins; all of them skip species the curated checklist has demoted.

| Pass | Matches when | Species |
|---|---|---:|
| `accepted` | its own name is an accepted CoL species (homonyms: the closest lineage, by family, class, phylum, kingdom, then lowest id) | 162,869 |
| `synonym` | its own name is a CoL synonym | 11,389 |
| `checklist_synonym` | its own name is an XR species the checklist demotes; follow the checklist to its accepted species | 255 |
| `provisional` | its own name is provisionally accepted in CoL, exactly or as a variant. Exact ranks above an ambiguous synonym of the same name (*Cipangopaludina chinensis* is both) | 184 |
| `ambiguous_synonym` | its own name is a CoL "ambiguous synonym" (CoL unsure which species it means); links, but only ever counts records filed under that name | 144 |
| `accepted_variant`, `synonym_variant` | the same, on the name normalised for Latin endings: *Ochotona pallasii* / *pallasi*, *Sminthopsis fuliginosa* / *fuliginosus* | 592 |
| `iucn_synonym` | one of IUCN's own synonyms for it is a CoL name | 109 |
| `orthographic_variant` | a respelling inside the name (*Colostygia puengeleri* / *pungeleri*), accepted only when the author citations agree too (`sameAuthors`) | 128 |
| unmatched | nothing | 239 |

Variants of a species' own name outrank IUCN's synonyms: *Sminthopsis fuliginosa* is CoL's *S. fuliginosus*, not the *S. aitkeni* that one of its IUCN synonyms points to. A normalised name that offers more than one CoL species is refused rather than guessed.

**No match crosses a phylum.** Old genus names are homonyms across kingdoms (*Hepatus* was a fish genus and is a crab genus; *Limnophila* is a plant and a crane fly), so a shared name or epithet proves nothing on its own. Every pass, and every covered row, is checked against the assessed species' kingdom and phylum; the one place IUCN and CoL name a phylum differently (brown algae: Heterokontophyta / Ochrophyta) is mapped. Where either side has no lineage, there is nothing to check.

**Verdicts.** Reaching a CoL species isn't the same as being it. Each match gets a verdict from `decideKey` in `app/scripts/species-key.ts`:

- **own**: the target is this species, under this name or a rename. It counts the target's records (minus anything others own). That includes a CoL synonym CoL itself marks as a respelling of its accepted name, with the same author citation (*Meandrina danae* / *danai*): the Red List's own citation can be mistyped, CoL's pair can't disagree with itself.
- **lumped**: CoL folds it into another species, but its own name led there, so its own usage (and anything under it) is its records. Where CoL files the synonym under an infraspecific (*Fringilla polatzeki* → *F. teydea polatzeki*), its records start at that infraspecific. Never at a nominate one (*Rosa villosa* subsp. *villosa*): that is the accepted species' core.
- **refused**: reached only through another name, onto another species. It links (so the dashboard can show the CoL name) but counts nothing.

**Covered rows.** Some organisms sit under more than one accepted CoL species. Each extra one becomes a *covered* link row, which keeps it off the Not Evaluated list and, where the evidence is direct, counts its records too:

- One of IUCN's synonyms *is* that accepted name and it is the same organism (*Hylatomus* / *Dryocopus pileatus*). Under another genus, the author citations must agree too: *Himantopus leucocephalus* Gould is the pied stilt, not the banded stilt *Cladorhynchus leucocephalus* (Vieillot) that names it. Reached only through a CoL synonym, it stays uncounted: that two-hop route once took *Chiococca alba* to the snowberry.
- The identical name (a hybrid sign aside) held twice in one class or under one author citation (*Andoa berthelotiana*, *Utricularia* × *ochroleuca*): `same_name_twin`.
- The same epithet stem and the same dated author citation in one family under another genus (*Charadrius nivosus* / *Anarhynchus nivosus*, both Cassin, 1858): `duplicate_concept`.
- For a lumped species, every same-genus synonym usage carrying its exact name (*Rubus fruticosus*): `same_name_synonym`.
- For a checklist demotion, the demoted XR species itself, since that is where GBIF files the records (*Cathormion umbellatum* → *Albizia umbellata*): `checklist_demoted`.

**One owner per usage.** If two assessed species claim the same usage, it goes to one, by: primary row before covered, *own* before *lumped*, stronger pass, then lower SIS id. The loser's primary row becomes `duplicate` and counts nothing (21 species).

`assessment_link` records the verdict, method and a sentence of reason on every row, so any species' link can be explained from the table alone.

## The Not Evaluated list

`ne.parquet`, built in `build-read-models.ts`. A CoL species is on it when all of these hold:

- accepted in the XR and not demoted by the checklist
- in a curated Base source (not the XR's tail of single fossil papers), and not extinct
- not domesticated or human (`NE_EXCLUDED` in `taxon-groups.ts`: one list of 17; the build fails if CoL ever stops accepting one of them, since its wild sibling would then absorb its records)
- **no assessed species links to it**, by any row: primary, covered, even refused
- GBIF has records for it under the counting rule (usages an assessed species owns don't count)

It is keyed by `col_id`, which is also its GBIF key. 866,822 species in this sync.

## What the app reads

`build/data/`, the same layout as `app/data/`. Built from the core tables by `build-read-models.ts`, then the existing builders run against it (`PIPELINE_DATA_DIR`): the taxa summaries, CoL revisions, synonym index and search index.

| File | What |
|---|---|
| `assessed.parquet` | one row per assessed species: latest assessment, GBIF key and counts, latest credits. Lists stay `;`-joined so the app's filter SQL is unchanged. |
| `assessments.parquet` | published history, one per year, latest first; unpublished drafts left out |
| `ne.parquet` | the Not Evaluated list (replaces `unassessed.parquet` and its synthetic ids) |
| `species/` | the CoL universe, partitioned by group |
| `taxa.parquet` / `backbone.parquet`, `assessment_link.parquet`, `species_link.parquet` | the core tables, and the link in the old shape for the CoL-differences code |
| `taxa-summary.json` and friends, `col-revisions.json`, `synonym-index.parquet`, `name-index.parquet` | from the existing builders |
| `sync.json` | every input version and check result |

An assessed species' GBIF key is its counted usage with the most records, an *own* row before a *lumped* one. That is how *Hylatomus pileatus* links to *Dryocopus pileatus*'s page rather than its own 156 records. "Outdated" (assessed more than ten years ago) is measured from the sync date, not today's, so a page's numbers don't drift between syncs.

## Checks

Three layers, from strict to advisory.

**1. Invariants, which stop the build.** Things that are true of any correct sync:
- the Red List session is read-only; the snapshot is complete
- every domesticated-species name is an accepted CoL species
- each assessed species has one current taxon record
- **each GBIF usage counts towards at most one species, once** (`checkEachUsageCountedOnce` in `build-read-models.ts`). A violation means some number is inflated.

**2. Matching fixtures, which stop the build.** `fixtures/matching.ts` holds 50 named cases, each a species that once showed the wrong number or a rule written because of one, with what should be true of it: which CoL species it links to, which name its GBIF key has, a floor or ceiling on its records, whether given species are on the NE list. `check-fixtures.ts` checks them against the built files. Expectations are by name, not CoL id, because CoL renumbers about 2% of ids each release. Reading this file next to `build-link.ts` is the quickest way to see what each matching rule is for.

**3. The comparison, which is for review.** `compare.ts` reduces the new sync and the one production serves to the same fact tables, diffs every field, and gives each difference a reason from `compare/reasons.ts` or marks it unexplained. The report lands in `build/compare/report.md`; unexplained differences don't stop the sync, they are what you read before publishing.

A reason is only as good as its bound. The rules come in three strengths:

- **Bounded**: they check the size of the change against what the reason predicts. `snapshot_vs_api` (within 5% or 5 records), `separately_assessed_split_not_double_counted` and `duplicate_concept_summed` (the new count must equal the old one plus or minus the records moved, within noise), the date and credit rules (the exact record they predict).
- **Sign-only**: `outdated_as_of_a_later_sync_date` (outdated may only rise), `duplicate_concepts_no_longer_not_evaluated` (NE counts may only fall).
- **Catch-alls**: `gbif_stats_from_the_ne_list`, `follows_the_new_links`, `common_name_from_inaturalist_or_col`. Read these as "not checked here": per-group GBIF figures, CoL-revision flags and NE common names are covered by the invariants and by the per-species checks they derive from, not by the comparison.

A rule that explains a change without bounding it can hide a bug, and this is how the first review of the rewrite found most of its bugs. `lumped_counts_from_its_infraspecific` once covered any change to a lumped species' counts, and so explained *Zosterops simplex*'s count doubling to 1.14M; it now requires the baseline's count to equal the records on its old key alone. `no_longer_linked` once explained every species joining the NE list; it now covers only species the baseline linked. Tightening the two surfaced a counting bug, a prod bug (`ambiguous_synonym_no_longer_hides`: *Vicia cracca*, 871k records, kept off the NE list by an ambiguous synonym) and, in the unexplained remainder, the respelling, provisional-name, twin, demotion and cross-phylum cases above.

When reading the unexplained list, sort by size and look at **falls** first: a number dropping below production's is where a matching regression shows.

## Running it each month

GBIF publishes a snapshot on the 1st of each month ([registry](https://registry.opendata.aws/gbif/)).

```bash
# 1. Mirror the new snapshot (~255 GiB, public, no account; hours, depending on the connection)
uvx --from awscli aws s3 sync s3://gbif-open-data-eu-central-1/occurrence/<date>/ ~/Data/gbif/<date>/ --no-sign-request

# 2. Build and check (about five minutes once inputs are cached)
cd app && npm run sync

# 3. Read ~/.cache/redlist-dashboard/build/compare/report.md

# 4. Publish: copies the build into app/data, uploads to a new syncs/<timestamp>/, bumps latest-sync.txt
npm run sync:publish

# 5. Open the data PR with the git add line it prints. Merging it is what goes live.
```

Needs: the Red List Postgres reachable (see `DB_*` in `app/.env.local`, and the README), and R2 credentials (the comparison downloads production's sync once; publishing uploads).

**What to look for in the report.** The table at the top gives differences and unexplained per kind. The first sync's unexplained differences were mostly NE country lists, which move with each snapshot; per-group assessed totals don't change unless IUCN published. Look closely at:
- unexplained count changes larger than a few percent on well-known species
- link changes (`link_col_id`), since each one moves a species' records
- species leaving or joining the NE list in bulk

**When CoL moves.** A new XR (GBIF re-indexes a few times a year) renumbers about 2% of ids and moves names between species, so expect a few thousand link and count differences that month. The fixtures are by name for this reason. The sync takes the XR GBIF indexes *now*, but a snapshot is keyed by the XR GBIF indexed when it was *made*: between GBIF moving and the next snapshot (COL26.10 XR went live just after the 1 November 2026 snapshot) the two disagree, and `build-occurrences` stops if more than 0.1% of the snapshot's records have keys the taxonomy doesn't hold. Wait for the next snapshot, or set `COL_XR_DATASET` to the snapshot's XR.

**When IUCN publishes.** Point `DB_NAME` at the new database. Expect new species, new categories and count changes from moved assessment years.

**Rolling back.** Revert the data PR's `latest-sync.txt` change; the previous sync is still in R2 (the bucket is object-locked, nothing is ever deleted). One exception: syncs from before the rewrite lack `ne.parquet`, so going back past it means reverting the code too.

### Running parts

Each builder runs on its own: `npx tsx scripts/pipeline/build-taxa.ts` (or `build-assessments`, `build-occurrences`, `build-link`, `build-read-models`, `check-fixtures`). `npm run sync -- --skip-compare` skips the comparison. `npm run sync:compare -- --candidate ~/.cache/redlist-dashboard/build/data --report-only` reruns only the comparison. `PIPELINE_BUILD_DIR` builds somewhere else; `GBIF_SNAPSHOT=<date>` pins a snapshot.

### Tracing a species

The core tables are plain parquet; DuckDB reads them directly.

```sql
-- in duckdb, from ~/.cache/redlist-dashboard/build/core
SET VARIABLE sp = 'Zosterops simplex';

-- its link rows: what it is in CoL, and why
SELECT l.role, l.verdict, l.method, c.scientific_name AS col_species, u.scientific_name AS records_start_at, l.counted, l.reason
FROM 'assessment_link.parquet' l
JOIN 'assessments.parquet' a ON a.sis_taxon_id = l.sis_taxon_id AND a.is_latest
LEFT JOIN 'taxa.parquet' c ON c.col_id = l.col_id
LEFT JOIN 'taxa.parquet' u ON u.col_id = l.usage_id
WHERE a.scientific_name = getvariable('sp');

-- the usages around its CoL name, and their records
SELECT t.col_id, t.scientific_name, t.rank, t.status, p.scientific_name AS parent, sum(o.n) FILTER (o.georef) AS georef
FROM 'taxa.parquet' t LEFT JOIN 'taxa.parquet' p ON p.col_id = t.parent_id
LEFT JOIN 'occurrence_counts.parquet' o ON o.usage_key = t.col_id
WHERE t.scientific_name ILIKE 'Zosterops%simplex%' GROUP BY ALL;

-- what its count is made of
SELECT * FROM 'count_components.parquet' WHERE sis = (
  SELECT sis_taxon_id FROM 'assessments.parquet' WHERE is_latest AND scientific_name = getvariable('sp'));
```

## Decisions and known limits

Choices made on purpose, which a reader might otherwise take for bugs:

- **IUCN's group for assessed species, CoL's for the rest.** Table 1a stays exact; NE species are grouped by CoL lineage.
- **IUCN's synonyms keep CoL species off the NE list.** If IUCN lists a name as a synonym of an assessed species and CoL accepts it, it isn't Not Evaluated as far as the Red List is concerned, even when the records aren't counted (5,674 refused covered rows; *Rubus plicatus* and *R. vestitus* sit under the *R. fruticosus* aggregate).
- **Preserved specimens count only outside Animalia.** Several animals once listed as "known bugs" (*Stenocranius raddei*, *Hylomyscus anselli*) have only museum specimens, so zero is right.
- **Outdated is as of the sync date.**
- **The XR, not the curated checklist, decides `species_id`**, because that is what GBIF indexes. The checklist only demotes.

Known limits:

- 239 assessed species match no CoL name (`method = 'unmatched'` in `assessment_link`), so they have no GBIF counts.
- Ownership walks three levels below a lumped species' root. The deepest case in the current release is three; a deeper one would go uncounted.
- BOLD BINs filed under a genus or family stay unresolved, as GBIF leaves them.
- NE country lists come from the snapshot, so they differ a little from gbif.org's live counts.
- The `iucn_synonym` pass (109 species) and `decideKey`'s genus-transfer rule accept a shared epithet under another genus without comparing authors; the covered rows now do. Whether the primary pass should too is open.
- The pipeline has no unit tests of its own. It is checked against real data instead (the invariants and fixtures above, on every run); a small synthetic CoL + GBIF fixture would let the counting and ownership SQL be tested in seconds.
- The XR lags the curated checklist (COL26.6 XR against COL26.10 in November 2026): GBIF re-indexes a few times a year, and the sync follows GBIF.

Follow-ups:

- IUCN families on CoL species, so the reptile GRA family counts (#587) can include CoL's splits.
- Real list columns in `assessed.parquet`, which needs the app's filter SQL to change.
- A reminder when a new GBIF snapshot appears.
