# The data sync

How the dashboard's data is built, why it works the way it does, and how to run it. The code is the reference for the details; this explains the design and points to it. What happens after a sync, on every deploy, is in [build.md](build.md).

![The sync](https://f005.backblazeb2.com/file/dashboard-pr-screenshots/pr-612-sync-stages/01-sync-overview.png)

The diagram is generated: `python3 -I docs/diagrams/sync_overview.py <out.dot>`, then `neato -n2 -Tpng`. [The tables](#the-tables) below it give every table's columns.

## Contents

1. [What a sync is](#what-a-sync-is)
2. [The stages](#the-stages)
3. [The tables](#the-tables)
4. [Inputs](#inputs)
5. [The counting rule](#the-counting-rule)
6. [Matching: which CoL species an assessed species is](#matching-which-col-species-an-assessed-species-is)
7. [The Not Evaluated list](#the-not-evaluated-list)
8. [What the app reads](#what-the-app-reads)
9. [Checks](#checks)
10. [Running it each month](#running-it-each-month)
11. [Decisions and known limits](#decisions-and-known-limits)

## What a sync is

A sync is one immutable set of data files, named by the time it was uploaded (`syncs/2026-11-04T16-18-27Z/` in the `dashboard-data` R2 bucket). Production reads whichever sync `app/latest-sync.txt` names on `main`. Building and uploading a sync changes nothing anyone sees; merging the one-line `latest-sync.txt` change is what goes live, and reverting it goes back.

A sync is built from the inputs below and nothing else, monthly, on a local machine (it reads a 255 GiB GBIF mirror, which is why it doesn't run in CI). `npm run sync` takes about five minutes once the inputs are on disk; a new XR adds about 15 minutes, once, to index it for the matcher.

The design has one idea: **every number comes from four tables, by one rule.** The old sync answered "how many GBIF records does this species have?" separately for each place the number appeared (per-species API counts, per-group facet files, lumped-species fetches, the Not Evaluated overlay), with two independent matching chains deciding which GBIF taxon a species was. They disagreed, and each disagreement was a bug. Now the question has one answer, computed once.

## The stages

The sync answers four questions: what species exist (the Catalogue of Life), what IUCN has assessed (the Red List), which CoL species each assessed species is (**link**), and how many GBIF records each species has (**count**). Only link and count make judgements. Every other stage reshapes data, so if a number looks wrong, the cause is in `link/`, in `dbt/models/count/`, or in a seed.

`app/scripts/sync/sync.ts` is the whole sync, read top to bottom: one section per stage, and in each a call per table, given the tables it reads. Each builder writes one table (or a few files of one kind), and the top of its file says what a row is, what it is built from, what each column means, and the decisions it makes. [The tables](#the-tables) collects those headers.

Count and lists are SQL models run by [dbt](#dbt), one `.sql` file per table under `dbt/models/`, with the same header. There a model's `ref()`s and `source()`s are what it reads, and dbt runs them in that order.

| Stage | Folder | What it does |
|---|---|---|
| inputs | `inputs/` | fetch and cache each input: CoL, iNaturalist names, the GBIF snapshot (reduced once to per-usage counts), the matcher |
| 1 sources | `sources/` | each input as one clean table: `taxa`, `assessments`, `occurrences`, `occurrence_countries`, `common_names`, and the SSC Specialist Groups' remits (`specialist_group_remits`, `rank_aliases`) |
| 2 link | `link/` | which CoL species each assessed species is: `matches`, then `assessment_link` |
| 3 count | `dbt/models/count/` | whose records each GBIF usage's are: `usage_owner`, then each species' totals in `record_counts` |
| 4 lists | `dbt/models/lists/` | what the app reads, joins only: `assessed`, `assessments` history, `species/`, `ne`, the app's `taxa` and `assessment_link`, the tree's labels, and `specialist_group_species`: which Specialist Groups each species is in |
| 5 precomputed | `precomputed/` | the app's own queries, run ahead of time: the CoL-differences tables and flags, the summaries, the search indexes |
| 6 checks | `checks/` | the fixtures and data tests (either stops the sync), then the comparison with production |

Two more folders hold what the stages apply:

- **`seeds/`**: every decision a person made, one file per kind and one row per decision, each with its reason: `decisions.tsv` (which CoL name a hard-to-match species is), `ne-excluded.tsv` (domestic forms and humans), `forced-latest.tsv`, and the taxonomy tree's CoL homonyms and equivalents. `seeds/seeds.ts` describes each.
- **`checks/fixtures/`**: the named cases the matching must keep getting right.

Stages meet at a single table: `assessment_link` out of link, `usage_owner` out of count. Their columns are each stage's contract with the rest, so the inside of a stage can be rewritten (the link is due to be) without touching the others.

### dbt

The SQL stages run as a [dbt](https://docs.getdbt.com/) project in `dbt/`: `dbt-oss`, dbt v2's Apache-licensed distribution, with DuckDB built in, pinned in `dbt/pyproject.toml` and run through [uv](https://docs.astral.sh/uv/), which installs it on first use. `dbt.ts` is the glue:

- **`runDbt`** runs `dbt build` on the build: every model, then its tests, in dependency order. A failing test stops the sync, and dbt skips whatever depends on the model it tested.
- dbt reads the tables the sources and link stages wrote as **sources** (`dbt/models/sources.yml`), and builds each model as a table in one DuckDB file, `core/sync.duckdb`.
- **`exportDbtTables`** then writes the files everything after it reads, from those tables: the app's lists, and the count tables for the precomputed stage. How a file is sorted or partitioned is decided there, not in the models, so a model says only what its rows are.

Shared SQL lives in `dbt/macros/`. A data test is a line in a model's `.yml` (`unique`, `not_null`) and checks the build's own rows. A unit test (`unit_tests:` in a `.yml`) gives a model a few input rows and the rows it must return, one per rule, so a rule is pinned down without real data: `specialist_group_rules` is the example. `runDbt` runs the unit tests after the models, since dbt reads their column types from the tables upstream; the count/lists vitest suites run them in CI. Run dbt by hand from `app/scripts/sync/dbt`, against a build:

```bash
export SYNC_BUILD_DIR=~/.cache/redlist-dashboard/build SYNC_DATE=$(date +%F) SYNC_DUCKDB_TMP=~/.cache/redlist-dashboard/duckdb-tmp
uv run dbt build --profiles-dir . --select record_counts+    # a model and everything downstream of it
uv run dbt show --profiles-dir . --inline "select * from {{ ref('assessed') }} where id = 15951"
```

The precomputed stage and the link are still TypeScript. Which Specialist Groups a species is in is a table now (`specialist_group_species`), which the summaries count from; next the app's live views read it too, after which the precomputed stage moves here.

`publish.ts` uploads the result. Every builder opens DuckDB through `sql.ts`'s `openDuckDB` (spilling to `~/.cache/redlist-dashboard/duckdb-tmp/`) on its own connection, so no builder reads another's temporary tables. `paths.ts` names every file a sync builds.

## The tables

In the order `sync.ts` builds them. `core/` is `~/.cache/redlist-dashboard/build/core/`, working tables that aren't published; everything else is under `build/data/`, the published sync. Every table is a query over the ones before it; nothing else is a source of truth.

<!-- tables:start -->
<!-- Generated by `python3 -I docs/diagrams/sync_tables.py <build dir>` from each builder's header and the build's files. Edit the headers, not this section. -->

### Sources

#### `sources/taxa.ts`

```text
taxa: one row per Catalogue of Life XR usage (accepted names, synonyms,
infraspecifics, BOLD BINs). Every list of species is a filter over it.

Built from: the CoL XR (NameUsage.tsv, Reference.tsv), the curated
checklist's NameUsage.tsv, the curated Base source ids, seeds/ne-excluded.tsv.

Decisions:
  - species_id follows the XR, which is what GBIF indexes, so totals match
    gbif.org. The checklist only demotes: curated silence never removes a
    species (macroalgae, whose source isn't in the curated release), only
    curated contradiction does.
  - A misapplied name is someone else's concept and counts towards nothing.
  - A usage takes its species' group, so a synonym can't land in another group
    than the species it counts towards.

Checks: every name in seeds/ne-excluded.tsv is still an accepted species (if
CoL lumped a domestic form into its wild sibling, the wild species would
absorb its records).
```

`core/taxa.parquet` · 7,991,756 rows · 159 MB

| column | type | |
|---|---|---|
| `col_id` | text | from the XR |
| `parent_id` | text | from the XR |
| `status` | text | from the XR |
| `rank` | text | from the XR |
| `scientific_name` | text | from the XR |
| `authorship` | text | from the XR |
| `kingdom` | text | lowercased lineage (the XR ships it denormalised) |
| `phylum` | text | lowercased lineage (the XR ships it denormalised) |
| `class_name` | text | lowercased lineage (the XR ships it denormalised) |
| `order_name` | text | lowercased lineage (the XR ships it denormalised) |
| `family` | text | lowercased lineage (the XR ships it denormalised) |
| `genus` | text | lowercased lineage (the XR ships it denormalised) |
| `described_year` | integer | author year, else basionym year, else the year of the name's cited reference |
| `extinct` | boolean | CoL's tri-state fossil flag |
| `in_base` | boolean | sourced from a curated Base GSD, not the XR's tail of single fossil papers |
| `in_checklist` | boolean | the usage as the curated release (catalogueoflife.org) has it |
| `checklist_status` | text | the usage as the curated release (catalogueoflife.org) has it |
| `checklist_parent_id` | text | the usage as the curated release (catalogueoflife.org) has it |
| `checklist_name` | text | the usage as the curated release (catalogueoflife.org) has it |
| `demoted` | boolean | an XR accepted species the curated release treats as a synonym or infraspecific (Pycnonotus tricolor) |
| `species_id` | text | the accepted species this usage's GBIF records count towards: itself, a synonym's accepted species, or an infraspecific's or BIN's species. NULL above species rank and for misapplied names. |
| `taxon_group` | text | the Table 1a group, from CoL's lineage (taxon-groups.ts) |
| `ne_excluded` | text | why the species is never Not Evaluated (domesticated, human), else NULL |

#### `sources/assessments.ts`

```text
assessments: one row per global assessment of a species IUCN currently
recognises, every year, read from the Red List Postgres database.

Built from: the Red List database named by DB_NAME, opened read-only;
seeds/forced-latest.tsv.

Decisions:
  - Global assessments only, not suppressed, of the species' current taxon
    record (not a subspecies or subpopulation).
  - is_latest is the database's latest flag, plus seeds/forced-latest.tsv;
    one per species, the most recently dated.
  - taxon_group is the Table 1a group from IUCN's own lineage
    (scripts/lib/taxa.ts), so Table 1a's totals stay exact.
  - Countries are native, extant and country-level. Lists stay lists.
  - Dates are dates, never converted through a timezone.
  - An IUCN synonym claimed by more than one current species is dropped: it
    can't say which species it means.

Checks: the session is read-only (the database is a colleague's); each
species has one current taxon record; each falls in exactly one Table 1a group.
```

`core/assessments.parquet` · 337,659 rows · 12 MB

| column | type | |
|---|---|---|
| `sis_taxon_id` | integer | the species (IUCN's SIS taxon id) |
| `assessment_id` | integer | the assessment |
| `is_latest` | boolean | the species' latest assessment (one per species) |
| `year_published` | text |  |
| `assessment_date` | date |  |
| `category` | text |  |
| `criteria` | text |  |
| `possibly_extinct` | boolean |  |
| `possibly_extinct_in_the_wild` | boolean |  |
| `population_trend` | text |  |
| `countries` | list of text | native, extant, country-level ISO codes |
| `systems` | list of text | lists; a habitat is code:season:suitability:major |
| `growth_forms` | list of text | lists; a habitat is code:season:suitability:major |
| `movement_pattern` | text |  |
| `threat_codes` | list of text | lists; a habitat is code:season:suitability:major |
| `habitat_codes` | list of text | lists; a habitat is code:season:suitability:major |
| `assessors` | text | the credits, as IUCN prints them |
| `reviewers` | text | the credits, as IUCN prints them |
| `facilitators` | text | the credits, as IUCN prints them |
| `contributors` | text | the credits, as IUCN prints them |
| `institutions` | text | the credits, as IUCN prints them |
| `scientific_name` | text | the species' current taxon record, on each of its rows |
| `authority` | text | the species' current taxon record, on each of its rows |
| `common_name` | text | the species' current taxon record, on each of its rows |
| `kingdom_name` | text | IUCN's lineage, lowercase |
| `phylum_name` | text | IUCN's lineage, lowercase |
| `class_name` | text | IUCN's lineage, lowercase |
| `order_name` | text | IUCN's lineage, lowercase |
| `family` | text | IUCN's lineage, lowercase |
| `taxon_group` | text | the Table 1a group, from IUCN's lineage |
| `synonyms` | list of {name, status} | IUCN's synonyms: [{name, status}] |

#### `sources/occurrences.ts`

```text
occurrences: one row per usage × georeferenced × date, at whatever precision
the records are dated to, with how many GBIF records there are.
occurrence_countries: one row per usage × country × georeferenced.

Built from: the GBIF snapshot, reduced once per snapshot
(inputs/gbif-snapshot.ts); taxa, to check the keys.

country is its countrycode, which GBIF fills from the coordinates or from
what the publisher wrote.

Decisions:
  - Every record type counts (specimens, observations, fossils, literature),
    for every kingdom, as on gbif.org; nothing here filters by it.
  - One table at the finest date each record has, rather than a yearly table
    and a dated one: every count is a sum over it, and a since-assessment
    count can start the day after the assessment.

Checks: no more records than the snapshot holds; at most 0.1% of records
have keys taxa doesn't hold (a snapshot keyed by another XR than taxa).
```

`core/occurrences.parquet` · 329,547,176 rows · 927 MB

| column | type | |
|---|---|---|
| `usage_key` | text | the record's taxonkey: the CoL usage its name matched (a species, a synonym, a subspecies, a BIN); a taxa.col_id |
| `year` | integer | NULL for an undated record |
| `month` | integer | NULL for a record dated only to the year (or undated) |
| `event_date` | date | NULL for a record dated only to the month (or coarser) |
| `georef` | boolean | has coordinates and none of GBIF's geospatial issues (the API's hasCoordinate=true&hasGeospatialIssue=false) |
| `n` | integer | records |

`core/occurrence_countries.parquet` · 15,477,898 rows · 41 MB

| column | type | |
|---|---|---|
| `usage_key` | text | the record's taxonkey: the CoL usage its name matched (a species, a synonym, a subspecies, a BIN); a taxa.col_id |
| `countrycode` | text |  |
| `georef` | boolean | has coordinates and none of GBIF's geospatial issues (the API's hasCoordinate=true&hasGeospatialIssue=false) |
| `n` | integer | records |

#### `sources/common-names.ts`

```text
common_names: one row per English common name a source gives a taxon, and
per taxon the one name of each source that is shown.

Built from: the CoL XR's VernacularName.tsv (with taxa, for each usage's rank
and name), and iNaturalist's taxonomy (inputs/inat-names.ts).

Which source's display name is shown is decided where a list is built: an
assessed species shows IUCN's name, else iNaturalist's; a Not Evaluated
species iNaturalist's, else CoL's (dbt/models/lists/assessed.sql, ne.sql).

Decisions:
  - A name that is just the scientific name relisted ("Acacia") is dropped.
  - Every CoL name is kept for search: CoL lists 14 English names for
    Adansonia digitata and marks none preferred, and keeping only the shortest
    gave "Boabab", a misspelling, so "baobab" found nothing.
  - CoL's display name for a species: its preferred flag (no English name
    carries one today); else the name sharing the most words with the names of
    other species in its genus (a genus that calls its members "… baobab"
    names this one "… baobab" too, and a one-off misspelling scores nothing);
    else the shortest; else alphabetical.
  - CoL's display name for a class, order, family or genus: preferred, else
    the shortest, else alphabetical. One per scientific name, since the tree
    labels by name: where usages share one (a synonym and its accepted name,
    homonyms), the shortest of their names, then alphabetical.
  - iNaturalist's display name is the first it lists; a scientific name
    iNaturalist repeats within a kingdom is ambiguous and gets no names.
```

`core/common_names.parquet` · 932,473 rows · 14 MB

| column | type | |
|---|---|---|
| `source` | text | 'col' \| 'inat' |
| `kind` | text | 'name': any of its names (search finds a species by each); 'display': the one name this source would show for it |
| `col_id` | text | the CoL usage (CoL names only) |
| `rank` | text | the usage's rank (CoL names only) |
| `scientific_name` | text | the name it is a common name for; iNaturalist's names join on it, within kingdom |
| `kingdom` | text | iNaturalist's kingdom (iNaturalist names only) |
| `name` | text | first letter capitalised |

#### `sources/specialist-groups.ts`

```text
specialist_group_remits, rank_aliases: the SSC Specialist Groups' remits, as
tables the SQL stages can read. The groups themselves stay in
src/config/taxonomy-tree.ts (the "By SSC Specialist Group" layout's sections
and their groups), where the app renders them.

Only Specialist Groups have rules. Every other row of the app's tree is an
IUCN group, or a named list of them (Invertebrates, Plants, Fungi), and a
species' IUCN group is its taxon_group.

specialist_group_remits: one row per Specialist Group.

rank_aliases: one row per class or order name IUCN and CoL spell differently
(taxonomy-sql.ts says why each is there).
```

`core/specialist_group_remits.parquet` · 92 rows · 24 kB

| column | type | |
|---|---|---|
| `group_id` | text | the group, and its section (Mammal Specialist Groups, …) |
| `section_id` | text | the group, and its section (Mammal Specialist Groups, …) |
| `taxon_groups` | list of text | the IUCN groups its species come from |
| `class_in` | list of text |  |
| `class_out` | list of text |  |
| `order_in` | list of text |  |
| `order_out` | list of text |  |
| `family_in` | list of text |  |
| `family_out` | list of text |  |
| `genus_in` | list of text | its remit's include and exclude lists, lowercased (taxonomy-tree.ts's SpeciesFilter); empty means no rule |
| `genus_out` | list of text | its remit's include and exclude lists, lowercased (taxonomy-tree.ts's SpeciesFilter); empty means no rule |
| `name_in` | list of text | its remit's include and exclude lists, lowercased (taxonomy-tree.ts's SpeciesFilter); empty means no rule |
| `name_out` | list of text | its remit's include and exclude lists, lowercased (taxonomy-tree.ts's SpeciesFilter); empty means no rule |
| `extra_names` | list of text | species it holds whatever the rules above say |
| `override_names` | list of text | CoL names only it holds (col-described-overrides.ts: CoL lumps Bison into Bos, so the Bison SG names them) |
| `catch_all` | boolean | its section's "Other" group: it excludes classes, and leaves out what its class- or order-scoped siblings hold |
| `claims` | boolean | a group the catch-all leaves out (it names classes or orders) |

`core/rank_aliases.parquet` · 40 rows · 1 kB

| column | type | |
|---|---|---|
| `rank` | text | 'class' or 'order' |
| `name` | text | a remit naming `name` also holds species filed under `alias` |
| `alias` | text | a remit naming `name` also holds species filed under `alias` |

### Link

#### `link/matches.ts`

```text
matches: one row per assessed species, with GBIF's matcher's answer for its
Red List name.

Built from: assessments (each species' latest name, authority and lineage),
and matching-ws, GBIF's own name matcher, run locally against the XR
(inputs/matcher.ts).

Decisions:
  - Each name is asked as GBIF sees one on a record: the name, its authority,
    and IUCN's kingdom, phylum, class, order and family as hints. The matcher
    is the one GBIF files records with, so a name matched here is where GBIF
    put that name's records.
  - Nothing here decides anything; assessment-link.ts does.
  - Answers are cached by query, matcher version and XR under
    ~/.cache/redlist-dashboard/matching/<xr>-<version>/, so a month in which
    neither the Red List nor the XR moves asks nothing.
```

`core/matches.parquet` · 175,909 rows · 6 MB

| column | type | |
|---|---|---|
| `sis_taxon_id` | integer |  |
| `usage_id` | text | the CoL usage the name matched (status: ACCEPTED, SYNONYM, AMBIGUOUS_SYNONYM, PROVISIONALLY_ACCEPTED, MISAPPLIED, ...) |
| `usage_name` | text | the CoL usage the name matched (status: ACCEPTED, SYNONYM, AMBIGUOUS_SYNONYM, PROVISIONALLY_ACCEPTED, MISAPPLIED, ...) |
| `usage_authorship` | text | the CoL usage the name matched (status: ACCEPTED, SYNONYM, AMBIGUOUS_SYNONYM, PROVISIONALLY_ACCEPTED, MISAPPLIED, ...) |
| `usage_rank` | text | the CoL usage the name matched (status: ACCEPTED, SYNONYM, AMBIGUOUS_SYNONYM, PROVISIONALLY_ACCEPTED, MISAPPLIED, ...) |
| `usage_status` | text | the CoL usage the name matched (status: ACCEPTED, SYNONYM, AMBIGUOUS_SYNONYM, PROVISIONALLY_ACCEPTED, MISAPPLIED, ...) |
| `match_type` | text | exact, variant, fuzzy, higher rank, none |
| `confidence` | integer | 0-100 |
| `alternatives` | list of {usage_id, name, authorship, rank, status, confidence, match_type} | the other usages the matcher weighed: [{usage_id, name, authorship, rank, status, confidence, match_type}] |

#### `link/assessment-link.ts`

```text
assessment_link: which CoL species each assessed species is. One primary row
per assessed species, plus covered rows for other CoL species that are the
same organism. Its columns are the link's contract with the rest of the sync:
whatever builds it, the count stage and the lists read only these.

Built from: taxa, assessments, matches, link/decisions.tsv.

Also writes match-queue.tsv: the species waiting for a person.

Decisions, in two steps kept apart so each can be explained on its own:

1. Name: which CoL usage the Red List name is.
     a decision in decisions.tsv, if there is one and it still resolves;
     else GBIF's matcher's answer (matches.ts), when accept-match.ts takes it
     without review;
     else nothing yet: the species is queued and counts no records until
     someone decides.

2. Concept: what that usage makes the species.
     - An accepted CoL species is the species (own). One the curated
       checklist demotes is followed to the checklist's species.
     - A synonym of a species the Red List treats the same way is the
       species too, renamed (own); one CoL folds into another species
       keeps only the records filed under its own name (lumped), or
       nothing if that species is assessed separately (refused). See
       species-key.ts' decideKey.
     - An ambiguous synonym, a name CoL can't place, keeps only its own records.
     - CoL holding one organism twice: both count (twins, covered rows below).
     - Never across phyla.
     - Every usage counts for one assessed species at most.
```

`core/assessment_link.parquet` · 187,358 rows · 3 MB

| column | type | |
|---|---|---|
| `sis_taxon_id` | integer |  |
| `role` | text | primary (the species itself) \| covered (another CoL species the same organism sits under) |
| `col_id` | text | the CoL species it is |
| `usage_id` | text | where its records start: the species for own, its own usage for lumped, NULL when nothing counts |
| `verdict` | text | own \| lumped \| refused \| none \| duplicate |
| `method` | text | what kind of usage the name is (accepted, synonym, checklist_synonym, provisional, ambiguous_synonym, or the covered row's rule) |
| `basis` | text | matcher \| decision \| rule |
| `decided_by` | text | who made the decision, for basis = decision |
| `reason` | text | one sentence on why |
| `counted` | boolean | whether the row's records count |

### Count

#### `dbt/models/count/usage_owner.sql`

```text
usage_owner: one row per CoL usage whose GBIF records count for a species,
naming that species. This table is the counting rule: every GBIF number on
the dashboard is a sum of occurrences joined to it.

Built from: taxa, assessment_link.

Decisions, in order (the first that applies decides):
  1. A lumped species owns its own usage and everything under it (three levels
     down: the deepest case in the current release is three). Roots can nest:
     Zosterops simplex owns both the subspecies Z. japonicus simplex and the
     synonym Z. simplex filed under it, so a usage goes to the nearest root
     claiming it, and of two lumped species reaching it, the one whose own
     name it is.
  2. Otherwise a usage counts for its species (taxa.species_id): its own name,
     its synonyms, its subspecies, their BINs. If an assessed species' counted
     "own" link row is that species, for the assessed species.
  3. Otherwise, if no link row names that species at all, for the species
     itself, unassessed. A species linked only by rows that don't count
     (refused, duplicate) counts for no one.

Checks: each usage has at most one owner. A violation means a number
somewhere is inflated, so the sync stops.
```

`core/usage_owner.parquet` · 6,209,402 rows · 33 MB

| column | type | |
|---|---|---|
| `usage_key` | text | a taxa.col_id; the occurrences' usage_key |
| `sis_taxon_id` | integer | the assessed species its records count for, else NULL |
| `link_usage_id` | text | the assessment_link row it counts through (that row's usage_id), for an assessed species |
| `col_id` | text | the unassessed CoL species its records count for, else NULL |

#### `dbt/models/count/record_counts.sql`

```text
record_counts: one row per species with GBIF records, assessed or not, with
its counts in both record modes.

Built from: usage_owner, occurrences, assessment_link (each row's verdict),
assessments (the latest assessment's date).

Decisions:
  - Every count is occurrences summed over the usages usage_owner gives the
    species.
  - The GBIF key is the counted usage with the most records, an own row's
    before a lumped one's, so Hylatomus pileatus links to Dryocopus pileatus'
    5M records rather than its own 156: CoL holds that bird twice, and both
    halves count.
  - Since the assessment means from the day after its date to the sync date.
    Later years count whatever their precision. In the assessment's own year a
    record counts if it is dated to a later day, or only to a later month; one
    dated only to that year, or only to the assessment's month, can't be placed
    either side and is left out.
  - No window for an undated assessment, or one dated on or after the sync
    date: nothing can postdate it yet.
```

`core/record_counts.parquet` · 1,741,683 rows · 9 MB

| column | type | |
|---|---|---|
| `sis_taxon_id` | integer | the assessed species, else NULL |
| `col_id` | text | the unassessed CoL species, else NULL |
| `gbif_species_key` | text | the usage the species' GBIF page is (assessed species) |
| `georef` | integer | records with coordinates and no geospatial issue |
| `all_records` | integer | every record |
| `georef_since` | integer | the same, since the latest assessment (assessed species; NULL when there is no window) |
| `all_since` | integer | the same, since the latest assessment (assessed species; NULL when there is no window) |

### Lists

#### `dbt/models/lists/assessed.sql`

```text
lists/assessed: one row per assessed species: its latest assessment, its GBIF
key and counts, its latest credits.

Built from: assessments (latest), record_counts, lists/assessments (how many
years it was assessed in), common_names.

Decisions:
  - Common name: IUCN's, else iNaturalist's.
  - A species with no GBIF records counts 0, and still has a since-assessment
    window (0) unless its assessment has none.
```

`lists/assessed.parquet` · 175,909 rows · 9 MB

| column | type | |
|---|---|---|
| `id` | integer | the SIS taxon id |
| `scientific_name` | text |  |
| `common_name` | text |  |
| `taxon_group` | text |  |
| `class_name` | text |  |
| `order_name` | text |  |
| `family` | text |  |
| `iucn_category` | text |  |
| `assessment_id` | integer |  |
| `assessment_date` | text |  |
| `year_published` | text |  |
| `countries` | text | lists, ';'-joined (the app's filter SQL reads them so) |
| `gbif_species_key` | text | see record_counts |
| `gbif_georeferenced_records_count` | integer |  |
| `gbif_all_records_count` | integer |  |
| `gbif_georeferenced_records_since_assessment` | integer |  |
| `gbif_all_records_since_assessment` | integer |  |
| `population_trend` | text |  |
| `systems` | text | lists, ';'-joined (the app's filter SQL reads them so) |
| `growth_forms` | text | lists, ';'-joined (the app's filter SQL reads them so) |
| `movement_pattern` | text |  |
| `possibly_extinct` | boolean |  |
| `possibly_extinct_in_the_wild` | boolean |  |
| `criteria` | text |  |
| `threat_codes` | text | lists, ';'-joined (the app's filter SQL reads them so) |
| `habitat_codes` | text | lists, ';'-joined (the app's filter SQL reads them so) |
| `latest_assessors` | text |  |
| `latest_reviewers` | text |  |
| `latest_facilitators` | text |  |
| `latest_contributors` | text |  |
| `latest_institutions` | text |  |
| `assessment_count` | integer | years with a published assessment |

#### `dbt/models/lists/assessment_history.sql`

```text
lists/assessments: one row per assessed species per year it was published
in, latest first. The species page's assessment history.

Built from: assessments.

Decisions:
  - Published assessments only: an unpublished draft has no year_published.
  - One per year: the species' latest assessment if it is in that year (an old
    assessment republished the same year has a higher id but isn't the one the
    category comes from), else the most recently dated.
```

`lists/assessments.parquet` · 318,758 rows · 4 MB

| column | type | |
|---|---|---|
| `sis_taxon_id` | integer |  |
| `seq` | integer | 0 for the latest, then 1, 2, … going back |
| `id` | integer | the assessment id |
| `year` | text | year published |
| `category` | text |  |
| `date` | text |  |
| `criteria` | text |  |
| `assessors` | text |  |
| `reviewers` | text |  |
| `facilitators` | text |  |
| `contributors` | text |  |
| `institutions` | text |  |

#### `dbt/models/lists/species.sql`

```text
lists/species/: one row per accepted CoL species the curated checklist keeps,
with its lineage, partitioned by taxon_group. The universe every "described"
and Not Evaluated count, list and search tier is drawn from.

Built from: taxa, assessment_link, assessments (latest categories).

Decisions:
  - described: in a curated Base source, extant (or extinct and assessed EX
    or EW, which IUCN agrees with), and not excluded (seeds/ne-excluded.tsv).
    This is the one definition: every reader filters on it, so no two counts
    can disagree about which species exist.
  - Accepted in the XR and not demoted by the checklist.
```

`lists/species` · 2,345,724 rows · 38 MB

| column | type | |
|---|---|---|
| `col_id` | text |  |
| `scientific_name` | text |  |
| `authorship` | text |  |
| `described_year` | integer |  |
| `kingdom` | text |  |
| `phylum` | text |  |
| `class_name` | text |  |
| `order_name` | text |  |
| `family` | text |  |
| `genus` | text |  |
| `extinct` | boolean |  |
| `in_base` | boolean |  |
| `described` | boolean | the dashboard's universe (below) |
| `taxon_group` | text | the partition |

#### `dbt/models/lists/ne.sql`

```text
lists/ne: one row per Not Evaluated species GBIF has records for, keyed by
col_id, which is also its GBIF key. Looked up by that key (the map's
tooltips, nearby species, search), which species/'s partitions can't prune.

Built from: species/, assessment_link, record_counts, occurrence_countries
with usage_owner, common_names.

Decisions:
  - Not Evaluated: described (species/), linked by no assessment_link row of
    any kind (primary, covered, even refused), and with GBIF records.
  - Common name: iNaturalist's, else CoL's.
```

`lists/ne.parquet` · 1,317,012 rows · 36 MB

| column | type | |
|---|---|---|
| `id` | text | the CoL id, three times: the app reads each name in a different place |
| `col_id` | text | the CoL id, three times: the app reads each name in a different place |
| `scientific_name` | text |  |
| `common_name` | text |  |
| `taxon_group` | text |  |
| `class_name` | text |  |
| `order_name` | text |  |
| `family` | text |  |
| `iucn_category` | text | 'NE' |
| `countries` | text | GBIF countries of its georeferenced records |
| `gbif_all_records_countries` | text | … of all its records |
| `gbif_species_key` | text | the CoL id, three times: the app reads each name in a different place |
| `gbif_georeferenced_records_count` | integer |  |
| `gbif_all_records_count` | integer |  |

#### `dbt/models/lists/app_taxa.sql`

```text
taxonomy/taxa and taxonomy/assessment_link: the taxonomy and the links as the
app reads them.

Built from: taxa, assessment_link.

taxonomy/taxa: one row per CoL usage (the synonyms lookup needs them all),
with only the columns a reader uses (col_id, parent_id, status, rank,
scientific_name, authorship, in_checklist, checklist_parent_id,
checklist_name), sorted by col_id so a lookup by id skips row groups. Lineage,
the universe flags and groups are on species/.

taxonomy/assessment_link: assessment_link as built (see link/assessment-link.ts).
```

`taxonomy/taxa.parquet` · 7,991,756 rows · 127 MB

| column | type | |
|---|---|---|
| `col_id` | text |  |
| `parent_id` | text |  |
| `status` | text |  |
| `rank` | text |  |
| `scientific_name` | text |  |
| `authorship` | text |  |
| `in_checklist` | boolean |  |
| `checklist_parent_id` | text |  |
| `checklist_name` | text |  |

`taxonomy/assessment_link.parquet` · 187,358 rows · 3 MB

| column | type | |
|---|---|---|
| `sis_taxon_id` | integer |  |
| `role` | text |  |
| `col_id` | text |  |
| `usage_id` | text |  |
| `verdict` | text |  |
| `method` | text |  |
| `basis` | text |  |
| `decided_by` | text |  |
| `reason` | text |  |
| `counted` | boolean |  |

#### `dbt/models/lists/vernacular_names.sql`

```text
taxonomy/vernacular-names.json: one common name per class, order, family and
genus name, for the taxonomy tree's labels ("Browse Adansonia (Baobabs)").

Built from: common_names (CoL's display names above species rank).

Shape: { "<lowercased scientific name>": "<common name>" }

One name per scientific name, chosen in sources/common-names.ts. dbt keeps
the pairs as a table; the export step writes them as one JSON object.
```

`taxonomy/vernacular-names.json` · 482 kB

#### `dbt/models/lists/specialist_group_species.sql`

```text
specialist_group_species: one row per species and SSC Specialist Group whose
remit holds it, assessed (IUCN's names) or not (CoL's). Every count the "By
SSC Specialist Group" layout shows is a count of a group's rows here.

Built from: specialist_group_remits and rank_aliases (sources/specialist-groups.ts),
assessed, species/.

Decisions:
  - A species is in a group when it is in one of the group's IUCN groups and
    its remit holds: each include list names its class, order, family, genus
    or name, and no exclude list does. Names are compared lowercased, a
    missing one as ''.
  - Class and order names match through rank_aliases, since IUCN and CoL file
    some species differently: a remit naming Pinales holds CoL's Cupressales too.
  - A species with no order matches an order rule by its class (GBIF's
    taxonomy files a few so).
  - extra_names are held whatever the rules say. override_names (CoL's names
    for the bison) are held by their group only, and left out of every other.
  - A section's catch-all ("Other Mammals") holds what its remit matches less
    what a sibling naming classes or orders holds, so groups never share a
    species. The same for assessed and CoL species, and the same override for
    both: before this table, CoL counts skipped the first and assessed counts
    the second.
```

`core/specialist_group_species.parquet` · 2,361,449 rows · 6 MB

| column | type | |
|---|---|---|
| `sis_taxon_id` | integer | the assessed species, else NULL |
| `col_id` | text | the CoL species (species/), else NULL |
| `group_id` | text | the Specialist Group |

### Precomputed

#### `precomputed/col-differences.ts`

```text
The CoL-differences card's tables, precomputed because each is a full scan
and self-join of taxa (8M rows) that the app's live breakdown would otherwise
redo after every cold start. The queries are the app's own
(src/lib/data/col-breakdown.ts), and the app loads the files exactly as
loadColDifferences does here.

Built from: taxonomy/taxa, lists/assessed, assessment_link.

  taxonomy/col-split-candidates: one row per Not Evaluated species CoL likely
    split from an assessed one (an infraspecific name, now a synonym, that
    resolves to it). ne_col_id, parent_id, parent_name, parent_category, rn
    (1 for the likeliest parent).
  taxonomy/col-synonym-assessed: one row per Not Evaluated species that an
    assessed species names as its synonym. ne_col_id, assessed_id,
    assessed_name, assessed_category.
  taxonomy/col-to-assessed: one row per CoL species and assessed species linked
    to it. col_id, assessed_id, assessed_name.

Decisions: a split is a heuristic (CoL keeps the old infraspecific name as a
synonym when it promotes one), so the card words it as likely, never as fact.
```

`taxonomy/col-split-candidates.parquet` · 5,665 rows · 133 kB

| column | type | |
|---|---|---|
| `ne_col_id` | text |  |
| `parent_id` | integer |  |
| `parent_name` | text |  |
| `parent_category` | text |  |
| `rn` | integer |  |

`taxonomy/col-synonym-assessed.parquet` · 1,212 rows · 34 kB

| column | type | |
|---|---|---|
| `ne_col_id` | text |  |
| `assessed_id` | integer |  |
| `assessed_name` | text |  |
| `assessed_category` | text |  |

`taxonomy/col-to-assessed.parquet` · 172,677 rows · 4 MB

| column | type | |
|---|---|---|
| `col_id` | text |  |
| `assessed_id` | integer |  |
| `assessed_name` | text |  |

#### `precomputed/col-revisions.ts`

```text
taxonomy/col-revisions.json: per assessed species, the "possible taxonomic
revision" flag the dashboard shows, and why.

Built from: species/, assessment_link, lists/assessed, taxonomy/taxa, and the
CoL-differences tables (col-differences.ts).

The SSC-group view already flags, per group, which IUCN-assessed species have
no clean 1:1 Catalogue of Life match and why (summaries.ts →
colBreakdown[].noMatchDetails). That diagnostic is computed per breakdown
*name*, so it only exists for the static tree's official/SSC nodes — the
primary assessed dashboard, which filters an arbitrary species set, has no
such lookup.

This runs the SAME diagnostic (computeNoMatchDetails, shared with
summaries.ts via lib/data/col-breakdown) exactly once, unscoped — over
every assessed species in every taxon group — and writes a flat sis_taxon_id
→ flag map the dashboard can load in one request.

It also carries the SECOND, independent revision signal: the species CoL has
likely split OUT of an assessed one. That reuses split_candidates (the same
temp table the SSC view's "Likely split from" note is built from) inverted —
assessed parent → the Not Evaluated names carved off it — scoped to exactly
the NE universe the group view counts. A species can carry both signals; only
~151 of ~9.7k do.

Scope note: unscoped, "classified_elsewhere" (CoL puts this name under a
different class/order/family than the *node* being viewed) can't arise —
there's no node to disagree with — so the global flag carries the seven
reasons that are properties of the species itself.
```

`taxonomy/col-revisions.json` · 2 MB

#### `precomputed/summaries.ts`

```text
The summary table's numbers, precomputed so the landing page and the static
tree need no query:

  summaries/taxa-summary.json: one row per Table 1a group: assessed, by
    category, outdated, GBIF totals in both record modes, CoL described / NE.
  summaries/country-stats.json: per country, assessed species and outdated.
  summaries/table1a-children-summaries.json, ssc-group-children-summaries.json:
    for every static tree node with children, one summary per child, with its
    CoL breakdown (split on the "ssc-" id prefix: Table 1a's rows and the SSC
    Specialist Groups are unrelated sources).

Every other level of the tree is answered live (live-taxa-children.ts).

Built from: lists/assessed, lists/ne, lists/species, assessment_link,
taxonomy/taxa, specialist_group_species and the CoL-differences tables; the
taxonomy tree (src/config/taxonomy-tree.ts).

Decisions:
  - Assessed species count in IUCN's group, so Table 1a stays exact; Not
    Evaluated species in their CoL group.
  - A child's species: an IUCN group's are those of its taxon_group; a
    Specialist Group's are its rows in specialist_group_species
    (dbt/models/lists/), which the sync's checks confirm agree with the app's
    live filter (childFilterSql in taxonomy-sql.ts), so these numbers are the
    ones the live views compute.
  - Outdated: assessed more than ten years before the sync, or undated.
  - "all" isn't summarised: its children mix the top-level taxa with the SSC
    wrappers, and nothing reads them as one list.

Checks (warnings only): an IUCN class or order with no CoL species under its
name, which reads as "0% assessed" until an alias is added.
```

`summaries/taxa-summary.json` · 17 kB

`summaries/country-stats.json` · 14 kB

`summaries/table1a-children-summaries.json` · 7 kB

`summaries/ssc-group-children-summaries.json` · 2 MB

#### `precomputed/search-index.ts`

```text
search/name-index and search/rank-index: the two name-sorted indexes the search bar reads, one over
species names and one over higher-rank taxon names, so a typeahead prefix query
reads a row group or two instead of scanning the species lists (which are sorted
for browsing, by class, order and family).

Sorted by name_lo, so

  WHERE name_lo >= 'panth' AND name_lo < 'panth' || chr(1114111)

touches one row group. ROW_GROUP_SIZE is tuned for that read: 20k rows puts
about a megabyte in a group, so a prefix query reads about a megabyte (measured
locally at 9-13 ms) and needs no warm container to be fast.

One row per SEARCHABLE NAME, not per species — a species contributes its scientific
name, its common name, and its epithet, so "panthera", "lion" and "leo" all reach
Panthera leo by prefix. name_kind carries which, because the dropdown's ranking is
defined in those terms (exact common name > common-name prefix > scientific prefix).

Rows carry the whole SearchResult payload, including the col_id the NE list keys on,
so a hit needs no join back to the species parquets and no link lookup.

Covers the fast path only (assessed ∪ GBIF-observed). The CoL-only and synonym tiers
are reached solely when nothing here matches, and they already have their own answer:
synonym-index.parquet is name-sorted, and species-duckdb primes both at warm-up.

The second output, rank-index.parquet, is the same idea for the "Browse Felidae →"
suggestions: the DISTINCT class/order/family/genus names, pre-aggregated to ONE ROW
PER NAME and sorted, so suggestTaxa is a pruned range read rather than eight DISTINCT
scans of both parquets. Pre-aggregating here rather than at query time is also what
makes the answer deterministic — see the comment on the struct min below.

Built from: lists/assessed, lists/ne, assessment_link, common_names (every
CoL and iNaturalist name), vernacular-names.json.
```

`search/name-index.parquet` · 3,796,772 rows · 168 MB

| column | type | |
|---|---|---|
| `name_lo` | text |  |
| `matched_name` | text |  |
| `name_kind` | integer |  |
| `rank_name` | text |  |
| `id` | integer |  |
| `scientific_name` | text |  |
| `common_name` | text |  |
| `taxon_group` | text |  |
| `category` | text |  |
| `gbif_species_key` | text |  |
| `gbif_georeferenced_records_count` | integer |  |
| `assessment_id` | integer |  |
| `assessment_date` | text |  |
| `countries` | text |  |
| `class_name` | text |  |
| `order_name` | text |  |
| `family` | text |  |
| `assessed` | boolean |  |
| `col_id` | text |  |

`search/rank-index.parquet` · 179,378 rows · 3 MB

| column | type | |
|---|---|---|
| `name` | text |  |
| `rp` | integer |  |
| `taxon_group` | text |  |
| `class_name` | text |  |
| `order_name` | text |  |
| `family` | text |  |
| `taxon` | text |  |
| `common` | text |  |

#### `precomputed/synonym-index.ts`

```text
search/synonym-index: one row per CoL synonym of a described species, sorted
by name, so a search for an old name finds the current species.

taxa.parquet has ~3.8M synonyms (status='synonym', parent_id → the accepted taxon).
We keep only those whose accepted name is a described species (species/: described), and carry whether that accepted species is IUCN-assessed (sis_id via
assessment_link) + its category — so a synonym hit routes to reassessments (assessed) or
new-assessments/leaf-node (NE), exactly like a direct hit.

Sorted by synonym_name_lower so searchSpecies' prefix-range query prunes to ~1 row group
(fast even cold).

Built from: taxonomy/taxa, species/, assessment_link, lists/assessed.
```

`search/synonym-index.parquet` · 2,300,401 rows · 82 MB

| column | type | |
|---|---|---|
| `synonym_name` | text |  |
| `synonym_name_lower` | text |  |
| `accepted_name` | text |  |
| `accepted_col_id` | text |  |
| `taxon_group` | text |  |
| `sis_id` | integer |  |
| `category` | text |  |

#### `precomputed/col-taxon-ids.ts`

```text
src/config/col-taxon-ids.json: every taxon name the taxonomy tree mentions,
with its Catalogue of Life id, so the "# Described Species" tooltip can link
each name to its CoL page. src/config/col-taxon-aliases.json: the names the
tree spells differently from CoL, with CoL's name.

Written into the repo, not published with the sync: the app's client code
imports them at build time, and CI type-checks with no sync data.

Built from: taxonomy/taxa; the taxonomy tree and its CoL overrides.

Decisions:
  - A name links only to an exact accepted match at its expected rank; one
    that doesn't resolve is left as plain text rather than linked to a guess.
  - Homonyms are settled by the other names in the same tree node, or by
    seeds/tree-homonyms.tsv where that doesn't, each with its reason.
  - A name CoL files under another name or rank follows CoL's synonym records,
    or seeds/tree-col-equivalents.tsv where they can't, each with its reason.
```

<!-- tables:end -->

## Inputs

Each is cached under `~/.cache/redlist-dashboard/` and fetched again only when its version moves.

| Input | What it gives | Version | Code |
|---|---|---|---|
| **Catalogue of Life XR** | every name usage: accepted species, synonyms, infraspecifics, BOLD BINs, with lineage | the release GBIF *indexes* (asked of GBIF), not the newest, so every GBIF key resolves | `inputs/col-xr.ts` |
| **CoL curated checklist** | what catalogueoflife.org shows; used to *demote* XR species the curators treat as synonyms | newest release whose export ChecklistBank has built (up to three back) | `inputs/col-checklist.ts` |
| **IUCN Red List Postgres** | every global assessment, taxonomy, synonyms, credits | the database named by `DB_NAME` | `sources/assessments.ts` |
| **GBIF monthly snapshot** | every occurrence record, as parquet, keyed by CoL id | newest mirrored date under `~/Data/gbif/` | `inputs/gbif-snapshot.ts` |
| iNaturalist taxonomy | one preferred English common name per species | the calendar month | `inputs/inat-names.ts` |
| GBIF's name matcher | matching-ws, run locally in Docker against the XR | pinned release (v1.0.12), index built once per XR | `inputs/matcher.ts` |

Two inputs are guarded:

- **The Red List database is a colleague's.** The session is opened with `default_transaction_read_only=on` and attached `READ_ONLY`, and the build asks Postgres to confirm read-only before it reads anything; if Postgres says otherwise it stops.
- **A snapshot is only exact if it is complete.** From 2025-07 to 2026-10 every GBIF mirror silently lacked one file in twenty ([gbif/occurrence#609](https://github.com/gbif/occurrence/issues/609)). The build refuses a snapshot whose file numbering has gaps, or whose parquet footers don't add up to the `totalRecords` of the GBIF download it was made from.

Since October 2026 GBIF indexes records against the CoL XR, so **a GBIF taxon key is a CoL id**. That is what makes one taxonomy possible: matching an assessed species to CoL also decides its GBIF records.

## The counting rule

`dbt/models/count/`. The rule is a table: `usage_owner` names, for every CoL usage whose records count, the one species they count for. Every GBIF number on the dashboard is `occurrences` joined to it, with a different filter: georeferenced or all records, since the assessment date, by country, by group. `record_counts` holds each species' totals.

**Two record modes.** Every count is published twice, and the dashboard's Georeferenced / All records toggle (`records=all` in the URL, `src/lib/gbif-records.ts`) picks one for every number on the page at once:

| | Georeferenced | All records (default) |
|---|---|---|
| Counts | records with coordinates and no geospatial issue | every record, with or without coordinates |
| Species columns | `gbif_georeferenced_records_count`, `gbif_georeferenced_records_since_assessment` | `gbif_all_records_count`, `gbif_all_records_since_assessment` |
| NE countries | `countries` | `gbif_all_records_countries` |
| Group totals (`taxa-summary.json`) | `gbif.georeferenced` | `gbif.all` |

A species with no records in a mode reads 0 there. The since-assessment count is NULL only when there is no window: an undated assessment, or one dated after the sync.

> A species counts the records of every usage whose `species_id` is that species (its own name, its synonyms, its subspecies, their BINs), **minus usages a separately assessed species owns**.

**Record types.** Both modes count every record type, the same for every kingdom: *all records* is every record (the number gbif.org shows), *georeferenced* is the ones with coordinates and no geospatial issue. Until 2026-11-06 the rule was per kingdom and left out zoo and garden, fossil and literature records, and for animals museum specimens too, so 16,801 assessed animals showed no records at all. The occurrence map applies its own record-type defaults.

**Ownership** is what "minus" means. Most assessed species simply own their CoL species and everything under it. The exceptions come from IUCN and CoL drawing species boundaries differently:

- **A split.** IUCN assesses *Zosterops simplex* separately; CoL files it as *Z. japonicus simplex*, a subspecies. Under the plain rule its records count for *Z. japonicus*. Instead *Z. simplex* owns that subspecies and what's under it, and *Z. japonicus* counts everything else. (The old sync counted them for both: *Z. japonicus* showed 870,598 records including *Z. simplex*'s. Now 298,292 and 572,306.)
- **A lump.** IUCN assesses *Rubus fruticosus*; CoL treats the name as a synonym, filed under three different species. *R. fruticosus* owns the three synonym usages bearing its name, and only those: it can't claim the accepted species' records, since CoL says those are other plants.

A usage has at most one owner, and is counted once: `usage_owner` is built from every claim on a usage and refuses to write if any usage has two (see [Checks](#checks)).

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

`link/`: `matches.ts`, `accept-match.ts`, `decisions.ts` (with `seeds/decisions.tsv`) and `assessment-link.ts`. The hardest part, and the most likely place for a wrong number: a species matched to the wrong CoL species shows someone else's records.

Matching is two questions, answered separately so each can be explained on its own:

1. **Name: which CoL name is the Red List name?** Answered by GBIF's own matcher, and by people where the matcher's answer isn't certain.
2. **Concept: what does that make the species?** Answered by a few rules, each a sentence long.

### 1. The name

Every assessed species' name is sent to **[matching-ws](https://github.com/gbif/matching-ws)**, the service GBIF interprets occurrence records with, with its authority and IUCN's kingdom, phylum, class, order and family as hints. It runs locally in Docker (`inputs/matcher.ts`), pinned to the matching-ws release GBIF's hosted service reports (v1.0.12) and built from the exact XR the sync uses, so a name matched here lands where GBIF filed that name's records. The index takes about 15 minutes to build, once per XR; all 175,909 names take about a minute, and answers are cached by query, release and matcher version, so an unchanged month asks nothing.

The answer is taken without review (`accept-match.ts`) when:

> the name is found exactly, as a species, with full confidence (99 or more), it leads to an accepted CoL species, and no other CoL name spelled the same way leads to a different species, unless the author citation picks one.

A same-spelled name with the match's own author citation isn't a rival: that is CoL holding the name twice, and the twin rule below counts both. Except when the match is a synonym and its twin an accepted species: CoL is then saying both that the name is a species and that it is another one (*Sipyloidea brevicerci*), so a person decides. Names the Red List itself marks as unsettled (aff., cf., sp., `[...]` in the name; ined., auct., non, sensu in the authority) always go to a person: the matcher read *Heliotropium* aff. *wagneri* "[non Vierh.]" as *H. wagneri* Vierh.

Everything else is a case for **`decisions.tsv`**: one row per species, naming the CoL name (and authorship, to tell homonyms apart) the Red List name is, who decided, whether a person has reviewed it, and the evidence. It is keyed by SIS id and names, not CoL ids, which move between releases: each sync re-applies a decision while its names still resolve, and asks again when they don't (or when the Red List renames the species). A decision always beats the matcher. Undecided species link to nothing and count no records until someone decides.

The queue of species waiting for a person is written each sync to `build/match-queue.tsv`, with the reason and the matcher's suggestion. Statuses: *undecided* (counts nothing yet), *proposed* (a decision applies, but no person has checked it), *stale* (a decision no longer resolves).

| COL26.6 XR, Red List 2026-1 | Species |
|---|---:|
| taken from the matcher | 173,627 |
| from `decisions.tsv` (2,016 rows, none reviewed yet) | 2,016 |
| undecided, so unlinked | 266 |

The first `decisions.tsv` carries the answers of the hand-written matching passes it replaced (`by = heuristic`, `reviewed = no`), for the species the matcher's answer doesn't settle: spelling variants (*Ochotona pallasii* / *pallasi*), homonyms, provisional names, matches through IUCN's synonyms. So it moved almost nothing on the day it landed (against the old passes: 28 species that had no records now count the usage GBIF files their name under, *Piptadenia flava* 0 → 1,117; 54 refused links dropped, which counted nothing; no species lost records). Each row is a review item, and a reviewed row replaces it.

The 266 undecided are mostly names the Red List marks as unsettled (145) and names CoL doesn't hold below genus (71); the old passes left them unmatched too.

### 2. The concept

What the chosen CoL usage makes the species. `assessment_link.method` says what kind of usage it is (`accepted`, `synonym`, `checklist_synonym`, `provisional`, `ambiguous_synonym`) and `basis` how it was chosen (`matcher`, `decision`).

- **An accepted species is the species.** One the curated checklist demotes (an XR over-split) is followed to the checklist's accepted species.
- **A synonym is the species renamed, or a lump.** Each gets a verdict from `decideKey` in `app/scripts/sync/link/species-key.ts`:
  - **own**: the target is this species, under this name or a rename. It counts the target's records (minus anything others own). That includes a CoL synonym CoL itself marks as a respelling of its accepted name, with the same author citation (*Meandrina danae* / *danai*).
  - **lumped**: CoL folds it into another species, so its own usage (and anything under it) is its records. Where CoL files the synonym under an infraspecific (*Fringilla polatzeki* → *F. teydea polatzeki*), its records start at that infraspecific. Never at a nominate one (*Rosa villosa* subsp. *villosa*): that is the accepted species' core.
  - **refused**: CoL folds it into a species the Red List assesses separately. It counts nothing.
- **An ambiguous synonym** (CoL unsure which species the name means) only ever counts records filed under that name.
- **No link crosses a phylum.** Old genus names are homonyms across kingdoms (*Hepatus* was a fish genus and is a crab genus), so every row, however made, is checked against the assessed species' kingdom and phylum; brown algae (Heterokontophyta / Ochrophyta) are mapped. Where either side has no lineage there is nothing to check.

**Covered rows.** Some organisms sit under more than one accepted CoL species. Each extra one becomes a *covered* link row, which keeps it off the Not Evaluated list and, where the evidence is direct, counts its records too:

- One of IUCN's synonyms *is* that accepted name and it is the same organism (*Hylatomus* / *Dryocopus pileatus*). Under another genus, the author citations must agree too: *Himantopus leucocephalus* Gould is the pied stilt, not the banded stilt *Cladorhynchus leucocephalus* (Vieillot) that names it. Reached only through a CoL synonym, it stays uncounted: that two-hop route once took *Chiococca alba* to the snowberry.
- The identical name (a hybrid sign aside) held twice in one class or under one author citation (*Andoa berthelotiana*, *Utricularia* × *ochroleuca*): `same_name_twin`.
- The same epithet stem and the same dated author citation in one family under another genus (*Charadrius nivosus* / *Anarhynchus nivosus*, both Cassin, 1858): `duplicate_concept`.
- For a lumped species, every synonym usage carrying its exact name (*Rubus fruticosus*): `same_name_synonym`.
- For a checklist demotion, the demoted XR species itself, since that is where GBIF files the records (*Cathormion umbellatum* → *Albizia umbellata*): `checklist_demoted`.

**One owner per usage.** If two assessed species claim the same usage, it goes to one, by: primary row before covered, *own* before *lumped*, the matcher before a decision, the more direct kind of name, then lower SIS id. The loser's primary row becomes `duplicate` and counts nothing.

`assessment_link` records the verdict, method, basis, who decided and a sentence of reason on every row, so any species' link can be explained from the table alone.

## The Not Evaluated list

`lists/ne.parquet`, built by `dbt/models/lists/ne.sql`. A CoL species is on it when all of these hold:

- it is *described* (`species/`'s `described`, the one definition every count and list uses): accepted in the XR and not demoted by the checklist, in a curated Base source (not the XR's tail of single fossil papers), not extinct, and not domesticated or human (`seeds/ne-excluded.tsv`: 17 names; the build fails if CoL ever stops accepting one of them, since its wild sibling would then absorb its records)
- **no assessed species links to it**, by any row: primary, covered, even refused
- GBIF has records for it under the counting rule (usages an assessed species owns don't count)

It is keyed by `col_id`, which is also its GBIF key. 866,822 species in this sync.

## What the app reads

`build/data/`, which is exactly what gets uploaded to `syncs/<timestamp>/` and what `app/data/sync/` holds after a fetch: the same tree in all three places. Each full run starts it empty, so no file outlives the code that wrote it. The lists stage writes the lists and the app's taxonomy from the working tables; the precomputed stage builds the rest from those published files, with the app's own queries. What reads each published file is in [app.md](app.md); each file's columns are in [The tables](#the-tables).

Two files go into the repo instead, because the app's client code imports them at build time and CI type-checks with no sync data: `src/config/col-release.json` (the CoL releases the sync was built from) and `src/config/col-taxon-ids.json` (with `col-taxon-aliases.json`: the CoL id of every name the taxonomy tree mentions). That is why a data PR after a CoL release move touches `src/config/` too.

Files are grouped by what they are for. [`src/lib/data/sync-layout.ts`](../app/src/lib/data/sync-layout.ts) is the one list of them: everything reads a file by its name (`syncPath("assessed.parquet")` is `lists/assessed.parquet`), so a file moves by moving its line there.

| Folder | Files | What |
|---|---|---|
| `lists/` | `assessed.parquet` | one row per assessed species: latest assessment, GBIF key and counts, latest credits. Lists stay `;`-joined so the app's filter SQL is unchanged |
| | `assessments.parquet` | published history, one per year, latest first; unpublished drafts left out |
| | `ne.parquet` | the Not Evaluated species GBIF has records for, keyed by their GBIF key (a CoL id): counts, countries, common name |
| | `species/` | every accepted CoL species, partitioned by group, with `described` (the universe every described and Not Evaluated count, list and search tier filters on) |
| `taxonomy/` | `taxa.parquet` | every CoL usage, with only the 9 columns the app reads (the full table stays in `build/core/`), sorted by `col_id` |
| | `assessment_link.parquet` | the link core table: which CoL species each assessed species is (`role` primary or covered), read by the app, the summaries and the comparison |
| | `col-revisions.json`, the three `col-*` parquets | the CoL-differences card: each species' flag, and the precomputed tables its breakdowns join |
| | `vernacular-names.json` | common names for the tree's class, order, family and genus labels |
| `search/` | `name-index.parquet`, `rank-index.parquet`, `synonym-index.parquet` | the search bar |
| `summaries/` | `taxa-summary.json`, the two children summaries, `country-stats.json` | per-group and per-country totals |
| | `sync.json` | every input version and check result |
| | `sync.log` | everything the run printed: each step, its timings and counts, the data tests and the comparison summary. Written as the sync runs, so a failed run leaves one in `build/data/` too |

Every published file has a reader. `ne.parquet` and `species/` look like they could be one file, but they answer different questions: `species/` is the universe, read by group (its partitions); `ne.parquet` is looked up by GBIF key (the map's tooltips, nearby species, the search index), which `species/` can't prune.

Not sync data, and siblings of `app/data/sync/`: `app/data/narratives/` (per Red List release, from `narratives/<release>/` in R2 or built locally) and `app/data/overlays/` (map layers, from the maps bucket or built locally).

An assessed species' GBIF key is its counted usage with the most records, an *own* row before a *lumped* one. That is how *Hylatomus pileatus* links to *Dryocopus pileatus*'s page rather than its own 156 records. "Outdated" (assessed more than ten years ago) is measured from the sync date, not today's, so a page's numbers don't drift between syncs.

## Checks

Four layers, from strict to advisory.

**1. Invariants, which stop the build.** Things that are true of any correct sync:
- the Red List session is read-only; the snapshot is complete
- every domesticated-species name is an accepted CoL species
- each assessed species has one current taxon record
- **each GBIF usage counts towards at most one species, once** (the `unique` test on `usage_owner.usage_key`; dbt builds nothing downstream if it fails). A violation means some number is inflated.
- **specialist_group_species agrees with the app's live filter** (`checks/specialist-groups.ts`): the same species in every Specialist Group, assessed and CoL. The summaries count from the table, the live views (the country-scoped summary, a group's species list) still from `taxonomy-sql.ts`, so a disagreement would show one number in the summary and another once scoped. The check goes once the app reads the table too.
- the occurrence table holds exactly the snapshot's records, and at most 0.1% of them have keys `taxa` doesn't hold

**2. Matching fixtures, which stop the build.** `checks/fixtures/matching.ts` holds 50 named cases, each a species that once showed the wrong number or a rule written because of one, with what should be true of it: which CoL species it links to, which name its GBIF key has, a floor or ceiling on its records, whether given species are on the NE list. `check-fixtures.ts` checks them against the built files. Expectations are by name, not CoL id, because CoL renumbers about 2% of ids each release. Reading this file next to `link/assessment-link.ts` is the quickest way to see what each matching rule is for.

**3. The data tests, which stop the build.** A few tests check a sync's output against the code: the assessed totals per group against IUCN's Table 1a, the taxonomy tree's precomputed summaries against its config, every country with data against the country names. CI has no data, so they skip there; the sync runs them against its own build (`DATA_TESTS` in `sync.ts`), and `sync:publish` refuses a build they failed. `npm test` runs them too wherever `app/data/` has been fetched. When the Red List publishes, `validate-table1a.test.ts` fails until its expected totals are updated to the new Table 1a: that is its job.

**4. The comparison, which is for review.** `compare.ts` reduces the new sync and the one production serves to the same fact tables, diffs every field, and gives each difference a reason from `compare/reasons.ts` or marks it unexplained. The report lands in `build/compare/report.md`; unexplained differences don't stop the sync, they are what you read before publishing.

A reason is only as good as its bound: a rule that explains a change without bounding it can hide a bug. There are two, and both are bounded:

- `newer_gbif_snapshot`: the syncs counted different snapshots, and a GBIF figure rose, or fell by no more than 5%.
- `outdated_as_of_a_later_sync_date`: outdated may only rise.

Everything else is unexplained until a rule says why, so a new Red List or CoL release shows up in full the first time. Add a rule when a change is understood, with the evidence in its commit message, and bound it by what the change predicts. The rewrite's acceptance review ran on 38 such rules (the history of `compare/reasons.ts` before November 2026); tightening two of them is what surfaced *Zosterops simplex*'s doubled count and *Vicia cracca* missing from the NE list.

When reading the unexplained list, sort by size and look at **falls** first: a number dropping below production's is where a matching regression shows.

## Running it each month

GBIF publishes a snapshot on the 1st of each month ([registry](https://registry.opendata.aws/gbif/)).

```bash
# 1. Mirror the new snapshot (~255 GiB, public, no account; hours, depending on the connection)
uvx --from awscli aws s3 sync s3://gbif-open-data-eu-central-1/occurrence/<date>/ ~/Data/gbif/<date>/ --no-sign-request

# 2. Build and check (about five minutes once inputs are cached)
cd app && npm run sync

# 3. Read ~/.cache/redlist-dashboard/build/compare/report.md, and build/match-queue.tsv for species waiting on a decision

# 4. Publish: copies the build into app/data/sync, uploads it to a new syncs/<timestamp>/, bumps latest-sync.txt
npm run sync:publish

# 5. Open the data PR with the git add line it prints. Merging it is what goes live.
```

Needs: Docker (for the matcher), uv (`brew install uv`, for dbt), the Red List Postgres reachable (see `DB_*` in `app/.env.local`, and the README), and R2 credentials (the comparison downloads production's sync once; publishing uploads).

**What to look for in the report.** The table at the top gives differences and unexplained per kind. The first sync's unexplained differences were mostly NE country lists, which move with each snapshot; per-group assessed totals don't change unless IUCN published. Look closely at:
- unexplained count changes larger than a few percent on well-known species
- link changes (`link_col_id`), since each one moves a species' records
- species leaving or joining the NE list in bulk

**When CoL moves.** A new XR (GBIF re-indexes a few times a year) renumbers about 2% of ids and moves names between species, so expect a few thousand link and count differences that month. The fixtures are by name for this reason. The sync takes the XR GBIF indexes *now*, but a snapshot is keyed by the XR GBIF indexed when it was *made*: between GBIF moving and the next snapshot (COL26.10 XR went live just after the 1 November 2026 snapshot) the two disagree, and the occurrences builder stops if more than 0.1% of the snapshot's records have keys the taxonomy doesn't hold. Wait for the next snapshot, or set `COL_XR_DATASET` to the snapshot's XR.

**When IUCN publishes.** Point `DB_NAME` at the new database, and update `validate-table1a.test.ts` to the new Table 1a. Expect new species, new categories and count changes from moved assessment years, and a longer matching queue: new species go through the matcher, and a renamed species' decision is asked again.

**When both move in one month,** see one change at a time: build the new snapshot and XR on the old Red List into its own folder, then the new Red List against it.

```bash
PIPELINE_BUILD_DIR=~/.cache/redlist-dashboard/build-col npm run sync                        # snapshot + XR, against production
DB_NAME=<new> npm run sync -- --baseline ~/.cache/redlist-dashboard/build-col/data           # + Red List, against that
```

Each comparison then explains one source's changes. Publish the second (or both, in order).

**Rolling back.** Revert the data PR's `latest-sync.txt` change; the previous sync is still in R2 (the bucket is object-locked, nothing is ever deleted). One exception: syncs from before the rewrite lack `ne.parquet`, so going back past it means reverting the code too.

### Running parts

`npm run sync -- --from <stage>` reruns from that stage on (`link`, `count`, `lists`, `precomputed` or `checks`), reusing the build's earlier tables, which is how to try a change to one stage in a minute or two instead of the whole sync. The inputs are always checked, which costs nothing once they're cached. `npx tsx scripts/sync/inputs/col.ts` fetches the CoL inputs alone; `npx tsx scripts/sync/inputs/matcher.ts` builds and starts the matcher alone, which then stays running between syncs as `redlist-matcher-<xr>` on port 8190 (`MATCHER_PORT`). `npm run sync -- --skip-compare` skips the comparison; `-- --baseline <data dir>` compares against that directory instead of production's sync. `npm run sync:compare -- --candidate ~/.cache/redlist-dashboard/build/data --report-only` reruns only the comparison. `PIPELINE_BUILD_DIR` builds somewhere else; `GBIF_SNAPSHOT=<date>` pins a snapshot.

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

-- the usages around its CoL name, their records, and whom each usage's records count for
SELECT t.col_id, t.scientific_name, t.rank, t.status, p.scientific_name AS parent,
       sum(o.n) FILTER (o.georef) AS georef, any_value(w.sis_taxon_id) AS counts_for_sis, any_value(w.col_id) AS counts_for_unassessed
FROM 'taxa.parquet' t LEFT JOIN 'taxa.parquet' p ON p.col_id = t.parent_id
LEFT JOIN 'occurrences.parquet' o ON o.usage_key = t.col_id
LEFT JOIN 'usage_owner.parquet' w ON w.usage_key = t.col_id
WHERE t.scientific_name ILIKE 'Zosterops%simplex%' GROUP BY ALL;

-- what its count is made of: each usage it owns, the link row it counts through, and its records
SELECT w.link_usage_id, u.scientific_name AS usage, u.rank, u.status, sum(o.n) FILTER (o.georef) AS georef, sum(o.n) AS all_records
FROM 'usage_owner.parquet' w JOIN 'taxa.parquet' u ON u.col_id = w.usage_key
LEFT JOIN 'occurrences.parquet' o ON o.usage_key = w.usage_key
WHERE w.sis_taxon_id = (SELECT sis_taxon_id FROM 'assessments.parquet' WHERE is_latest AND scientific_name = getvariable('sp'))
GROUP BY ALL ORDER BY georef DESC NULLS LAST;
```

## Decisions and known limits

Choices made on purpose, which a reader might otherwise take for bugs:

- **IUCN's group for assessed species, CoL's for the rest.** Table 1a stays exact; NE species are grouped by CoL lineage.
- **IUCN's synonyms keep CoL species off the NE list.** If IUCN lists a name as a synonym of an assessed species and CoL accepts it, it isn't Not Evaluated as far as the Red List is concerned, even when the records aren't counted (5,674 refused covered rows; *Rubus plicatus* and *R. vestitus* sit under the *R. fruticosus* aggregate).
- **Every record type counts, for every kingdom.** Museum specimens, fossils and literature records are in both the all-records and georeferenced totals, as on gbif.org; the occurrence map applies its own filters.
- **Outdated is as of the sync date.**
- **The XR, not the curated checklist, decides `species_id`**, because that is what GBIF indexes. The checklist only demotes.
- **Every decision a person made is a seed**, a row in a file under `seeds/` with its reason, not a constant in code, so the list of human judgements the sync applies can be read in one place.

Known limits:

- 266 assessed species link to no CoL name yet (`method = 'unmatched'` in `assessment_link`, listed in `build/match-queue.tsv`), so they have no GBIF counts.
- 2,016 decisions are the old passes' answers, unreviewed. The queue says why each needed a person (709 spelling variants, 635 homonyms, 251 with no species match, 218 provisional names, 149 lower confidence, ...).
- Ownership walks three levels below a lumped species' root. The deepest case in the current release is three; a deeper one would go uncounted.
- BOLD BINs filed under a genus or family stay unresolved, as GBIF leaves them.
- NE country lists come from the snapshot, so they differ a little from gbif.org's live counts.
- `decideKey`'s genus-transfer rule accepts a shared epithet under another genus without comparing authors; the covered rows do. Whether it should too is open.
- The acceptance rule, the decisions file and the counting rule have unit tests on small synthetic tables (`pipeline-accept-match.test.ts`, `pipeline-decisions.test.ts`, `pipeline-usage-owners.test.ts`, `pipeline-record-counts.test.ts`); the link's concept rules are checked against real data only (the fixtures above, on every run).
- The XR lags the curated checklist (COL26.6 XR against COL26.10 in November 2026): GBIF re-indexes a few times a year, and the sync follows GBIF.

Follow-ups:

- Review `seeds/decisions.tsv`: agents to draft each queued species' decision with its evidence, people to accept or correct them in a PR.

- IUCN families on CoL species, so the reptile GRA family counts (#587) can include CoL's splits.
- Real list columns in `assessed.parquet`, which needs the app's filter SQL to change.
- A reminder when a new GBIF snapshot appears.
