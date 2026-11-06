# The data sync

How the dashboard's data is built, why it works the way it does, and how to run it. The code is the reference for the details; this explains the design and points to it. What happens after a sync, on every deploy, is in [build.md](build.md).

![The sync](https://f005.backblazeb2.com/file/dashboard-pr-screenshots/pr-588-sync-rewrite/01-sync-after.png)

The diagram's source is [`diagrams/sync.excalidraw`](diagrams/sync.excalidraw) (open it at excalidraw.com; `diagrams/gen.py` regenerates it).

## Contents

1. [What a sync is](#what-a-sync-is)
2. [Where the code is](#where-the-code-is)
3. [Inputs](#inputs)
4. [The four core tables](#the-four-core-tables)
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

## Where the code is

`app/scripts/sync/`, one folder per stage ([app/scripts/README.md](../app/scripts/README.md) lists every file):

| Folder | Stage |
|---|---|
| `inputs/` | fetch and cache the inputs, and run GBIF's matcher |
| `core/` | the four core tables, the counting rule, the matching and concept rules, `decisions.tsv` |
| `outputs/` | what the app reads, built from the core tables |
| `checks/` | the fixtures and the comparison with production |

`sync.ts` runs them in order, as nine numbered steps (the same numbers in its log, in `sync.log` and in the diagram below); `publish.ts` uploads the result. Every step opens DuckDB through `sql.ts`'s `openDuckDB`, which spills to `~/.cache/redlist-dashboard/duckdb-tmp/`, and each gets its own connection, so no step reads another's temporary tables.

## Inputs

Each is cached under `~/.cache/redlist-dashboard/` and fetched again only when its version moves.

| Input | What it gives | Version | Code |
|---|---|---|---|
| **Catalogue of Life XR** | every name usage: accepted species, synonyms, infraspecifics, BOLD BINs, with lineage | the release GBIF *indexes* (asked of GBIF), not the newest, so every GBIF key resolves | `inputs/col-xr.ts` |
| **CoL curated checklist** | what catalogueoflife.org shows; used to *demote* XR species the curators treat as synonyms | newest release whose export ChecklistBank has built (up to three back) | `inputs/col-checklist.ts` |
| **IUCN Red List Postgres** | every global assessment, taxonomy, synonyms, credits | the database named by `DB_NAME` | `build-assessments.ts` |
| **GBIF monthly snapshot** | every occurrence record, as parquet, keyed by CoL id | newest mirrored date under `~/Data/gbif/` | `build-occurrences.ts` |
| iNaturalist taxonomy | one preferred English common name per species | the calendar month | `inputs/inat-names.ts` |
| GBIF's name matcher | matching-ws, run locally in Docker against the XR | pinned release (v1.0.12), index built once per XR | `inputs/matcher.ts` |

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
| `occurrence_dates` | usage × year × month × day × georeferenced × record type, for records dated at least to the month | `build-occurrences.ts` |
| `assessment_link` | assessed species × CoL species it is (primary, plus covered rows) | `build-link.ts`, from the matcher's answers (`matches`, `build-matches.ts`) and `decisions.tsv` |

**`taxa`** is the XR with three things worked out per usage:

- **`species_id`**, the accepted species this usage's GBIF records count towards. A synonym → its accepted species; a subspecies, variety or BOLD BIN → the species above it (up to two levels, for a variety under a subspecies). Misapplied names count towards nothing: they are someone else's concept. This follows the XR, which is what GBIF indexes, so totals match gbif.org.
- **`demoted`**, an XR species the curated checklist treats as a synonym or infraspecific (*Pycnonotus tricolor*). The XR over-splits; the checklist is curated. A species the checklist simply lacks is *not* demoted: silence never removes a species, only contradiction does.
- **`taxon_group`**, one of IUCN's 28 Table 1a groups from CoL's lineage (`taxon-groups.ts`). Used only for species IUCN hasn't assessed; assessed species keep IUCN's own group, so Table 1a's totals stay exact. A usage takes its species' group, so a synonym can't land in a different group from the species it counts towards.

**`assessments`** keeps lists as lists (countries, threats, habitats). Dates are dates: the old fetcher converted Postgres's timezone-less timestamps with `toISOString()` on a London machine, so every date in British Summer Time slipped back a day (104,891 species).

**`occurrence_counts`** is the whole snapshot (3.9 billion records) reduced to 4.1M usages' counts by year, by whether the record is georeferenced, and by basis of record. *Georeferenced* means what GBIF's API means by `hasCoordinate=true&hasGeospatialIssue=false`; the snapshot has no `hasGeospatialIssue` column, so it is recomputed from each record's issues using GBIF's own set (`GBIF_GEOSPATIAL_ISSUES` in `app/src/lib/gbif.ts`, checked per code against the live API). A companion table holds the same by country.

**`occurrence_dates`** is the same with the record's month and, where it has one, its day (records dated at least to the month, 90% of them dated to the day). It exists for one number: records since an assessment start the day after the assessment date, so the assessment's own year has to be split at that date. Later years come from `occurrence_counts`, whatever their precision. In the assessment's own year a record counts if it is dated to a later day, or only to a later month; one dated only to that year, or only to the assessment's own month, can't be placed either side and is left out.

**`assessment_link`** is the subject of [Matching](#matching-which-col-species-an-assessed-species-is).

## The counting rule

`counts.ts`. Every GBIF number on the dashboard is this rule with a different filter: georeferenced or all records, since the assessment date, by country, by group.

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

`build-matches.ts`, `accept-match.ts`, `decisions.tsv` and `build-link.ts`. The hardest part, and the most likely place for a wrong number: a species matched to the wrong CoL species shows someone else's records.

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
- **A synonym is the species renamed, or a lump.** Each gets a verdict from `decideKey` in `app/scripts/sync/core/species-key.ts`:
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

`ne.parquet`, built in `build-read-models.ts`. A CoL species is on it when all of these hold:

- accepted in the XR and not demoted by the checklist
- in a curated Base source (not the XR's tail of single fossil papers), and not extinct
- not domesticated or human (`NE_EXCLUDED` in `taxon-groups.ts`: one list of 17; the build fails if CoL ever stops accepting one of them, since its wild sibling would then absorb its records)
- **no assessed species links to it**, by any row: primary, covered, even refused
- GBIF has records for it under the counting rule (usages an assessed species owns don't count)

It is keyed by `col_id`, which is also its GBIF key. 866,822 species in this sync.

## What the app reads

![The files in a sync](https://f005.backblazeb2.com/file/dashboard-pr-screenshots/pr-604-system-docs/01-sync-files-v3.png)

A sync step by step, in the order `sync.ts` runs them: every input and cache each step reads, and every file it writes, in `build/core/` (working, not published), `build/data/` (published) or elsewhere. What reads each published file is in [app.md](app.md). The source is [`diagrams/sync-files.excalidraw`](diagrams/sync-files.excalidraw) (`python3 -I diagrams/gen.py files <out>` regenerates it).

`build/data/`, which is exactly what gets uploaded to `syncs/<timestamp>/` and what `app/data/sync/` holds after a fetch: the same tree in all three places. Each run starts it empty, so no file outlives the code that wrote it. Built from the core tables by `outputs/build-read-models.ts`, then the other `outputs/` builders run against it in the same process. Intermediates only those builders read (the CoL and iNaturalist common-name tables) stay in `build/core/`.

Files are grouped by what they are for. [`src/lib/data/sync-layout.ts`](../app/src/lib/data/sync-layout.ts) is the one list of them: everything reads a file by its name (`syncPath("assessed.parquet")` is `lists/assessed.parquet`), so a file moves by moving its line there.

| Folder | Files | What |
|---|---|---|
| `lists/` | `assessed.parquet` | one row per assessed species: latest assessment, GBIF key and counts, latest credits. Lists stay `;`-joined so the app's filter SQL is unchanged |
| | `assessments.parquet` | published history, one per year, latest first; unpublished drafts left out |
| | `ne.parquet` | the Not Evaluated list |
| | `species/` | the CoL universe, partitioned by group |
| `taxonomy/` | `taxa.parquet` | the taxonomy core table, which the CoL-differences, synonym and species-listing code queries |
| | `species_link.parquet` | the links as the app reads them: one row per assessed species and covered row, with its GBIF key |
| | `assessment_link.parquet` | the link core table, published for the comparison and for tracing |
| | `col-revisions.json`, the three `col-*` parquets | the CoL-differences card: each species' flag, and the precomputed tables its breakdowns join |
| | `vernacular-names.json` | common names for the tree's class, order, family and genus labels |
| `search/` | `name-index.parquet`, `rank-index.parquet`, `synonym-index.parquet` | the search bar |
| `summaries/` | `taxa-summary.json`, the two children summaries, `country-stats.json`, `realm-stats.json` | per-group and per-place totals |
| | `sync.json` | every input version and check result |
| | `sync.log` | everything the run printed: each step, its timings and counts, the data tests and the comparison summary. Written as the sync runs, so a failed run leaves one in `build/data/` too |

Every published file has a reader, but three could be simpler (dashed in the diagram):

- **`taxa.parquet` is a third of a sync (152 of 447 MB)**, yet the app reads 5 of its 16 columns for two lookups by CoL id (a species' synonyms, and the CoL links in the differences popover). A slim copy with those columns, sorted by id, would be a fraction of the size, and cheaper to query over R2.
- **`species_link.parquet` is `assessment_link.parquet` in the old shape** the app read before the sync rewrite. Pointing its readers at `assessment_link` would drop the file and the reshaping.
- **`ne.parquet` is joined onto `species/` wherever it is read** (the Not Evaluated list, the build, the summaries). Its GBIF columns could live on the species rows.

Not sync data, and siblings of `app/data/sync/`: `app/data/narratives/` (per Red List release, from `narratives/<release>/` in R2 or built locally) and `app/data/overlays/` (map layers, from the maps bucket or built locally).

An assessed species' GBIF key is its counted usage with the most records, an *own* row before a *lumped* one. That is how *Hylatomus pileatus* links to *Dryocopus pileatus*'s page rather than its own 156 records. "Outdated" (assessed more than ten years ago) is measured from the sync date, not today's, so a page's numbers don't drift between syncs.

## Checks

Four layers, from strict to advisory.

**1. Invariants, which stop the build.** Things that are true of any correct sync:
- the Red List session is read-only; the snapshot is complete
- every domesticated-species name is an accepted CoL species
- each assessed species has one current taxon record
- **each GBIF usage counts towards at most one species, once** (`checkEachUsageCountedOnce` in `build-read-models.ts`). A violation means some number is inflated.

**2. Matching fixtures, which stop the build.** `fixtures/matching.ts` holds 50 named cases, each a species that once showed the wrong number or a rule written because of one, with what should be true of it: which CoL species it links to, which name its GBIF key has, a floor or ceiling on its records, whether given species are on the NE list. `check-fixtures.ts` checks them against the built files. Expectations are by name, not CoL id, because CoL renumbers about 2% of ids each release. Reading this file next to `build-link.ts` is the quickest way to see what each matching rule is for.

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

Needs: Docker (for the matcher), the Red List Postgres reachable (see `DB_*` in `app/.env.local`, and the README), and R2 credentials (the comparison downloads production's sync once; publishing uploads).

**What to look for in the report.** The table at the top gives differences and unexplained per kind. The first sync's unexplained differences were mostly NE country lists, which move with each snapshot; per-group assessed totals don't change unless IUCN published. Look closely at:
- unexplained count changes larger than a few percent on well-known species
- link changes (`link_col_id`), since each one moves a species' records
- species leaving or joining the NE list in bulk

**When CoL moves.** A new XR (GBIF re-indexes a few times a year) renumbers about 2% of ids and moves names between species, so expect a few thousand link and count differences that month. The fixtures are by name for this reason. The sync takes the XR GBIF indexes *now*, but a snapshot is keyed by the XR GBIF indexed when it was *made*: between GBIF moving and the next snapshot (COL26.10 XR went live just after the 1 November 2026 snapshot) the two disagree, and `build-occurrences` stops if more than 0.1% of the snapshot's records have keys the taxonomy doesn't hold. Wait for the next snapshot, or set `COL_XR_DATASET` to the snapshot's XR.

**When IUCN publishes.** Point `DB_NAME` at the new database, and update `validate-table1a.test.ts` to the new Table 1a. Expect new species, new categories and count changes from moved assessment years, and a longer matching queue: new species go through the matcher, and a renamed species' decision is asked again.

**When both move in one month,** see one change at a time: build the new snapshot and XR on the old Red List into its own folder, then the new Red List against it.

```bash
PIPELINE_BUILD_DIR=~/.cache/redlist-dashboard/build-col npm run sync                        # snapshot + XR, against production
DB_NAME=<new> npm run sync -- --baseline ~/.cache/redlist-dashboard/build-col/data           # + Red List, against that
```

Each comparison then explains one source's changes. Publish the second (or both, in order).

**Rolling back.** Revert the data PR's `latest-sync.txt` change; the previous sync is still in R2 (the bucket is object-locked, nothing is ever deleted). One exception: syncs from before the rewrite lack `ne.parquet`, so going back past it means reverting the code too.

### Running parts

Each step runs on its own, against the build: `npx tsx scripts/sync/core/build-taxa.ts` (likewise `core/build-assessments`, `core/build-occurrences`, `core/build-matches`, `core/build-link`, `outputs/build-common-names`, `outputs/build-read-models`, `outputs/build-search-index`, `checks/check-fixtures`). `npx tsx scripts/sync/inputs/col.ts` fetches the CoL inputs alone. `npx tsx scripts/sync/inputs/matcher.ts` builds and starts the matcher alone; it stays running between syncs as `redlist-matcher-<xr>` on port 8190 (`MATCHER_PORT`). `npm run sync -- --skip-compare` skips the comparison; `-- --baseline <data dir>` compares against that directory instead of production's sync. `npm run sync:compare -- --candidate ~/.cache/redlist-dashboard/build/data --report-only` reruns only the comparison. `PIPELINE_BUILD_DIR` builds somewhere else; `GBIF_SNAPSHOT=<date>` pins a snapshot.

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
- **Every record type counts, for every kingdom.** Museum specimens, fossils and literature records are in both the all-records and georeferenced totals, as on gbif.org; the occurrence map applies its own filters.
- **Outdated is as of the sync date.**
- **The XR, not the curated checklist, decides `species_id`**, because that is what GBIF indexes. The checklist only demotes.

Known limits:

- 266 assessed species link to no CoL name yet (`method = 'unmatched'` in `assessment_link`, listed in `build/match-queue.tsv`), so they have no GBIF counts.
- 2,016 decisions are the old passes' answers, unreviewed. The queue says why each needed a person (709 spelling variants, 635 homonyms, 251 with no species match, 218 provisional names, 149 lower confidence, ...).
- Ownership walks three levels below a lumped species' root. The deepest case in the current release is three; a deeper one would go uncounted.
- BOLD BINs filed under a genus or family stay unresolved, as GBIF leaves them.
- NE country lists come from the snapshot, so they differ a little from gbif.org's live counts.
- `decideKey`'s genus-transfer rule accepts a shared epithet under another genus without comparing authors; the covered rows do. Whether it should too is open.
- The acceptance rule and the decisions file have unit tests (`pipeline-accept-match.test.ts`, `pipeline-decisions.test.ts`); the counting and ownership SQL is checked against real data only (the invariants and fixtures above, on every run). A small synthetic CoL + GBIF fixture would let it be tested in seconds.
- The XR lags the curated checklist (COL26.6 XR against COL26.10 in November 2026): GBIF re-indexes a few times a year, and the sync follows GBIF.

Follow-ups:

- Review `decisions.tsv`: agents to draft each queued species' decision with its evidence, people to accept or correct them in a PR.

- IUCN families on CoL species, so the reptile GRA family counts (#587) can include CoL's splits.
- Real list columns in `assessed.parquet`, which needs the app's filter SQL to change.
- A reminder when a new GBIF snapshot appears.
