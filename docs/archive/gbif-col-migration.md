# Migrating the GBIF pipeline to Catalogue of Life

Design notes for moving off the frozen GBIF Backbone.

Two earlier attempts (#441, #444) were closed unmerged. Both shipped silently
wrong data, and both times the cause was an assumption in the design rather than
a bug in the code — so this document records the assumptions explicitly, including
the ones that turned out to be false.

## Why this is necessary

GBIF relaunched gbif.org on 18 June 2026 with the **Catalogue of Life Extended
Release (COL XR)** as its default taxonomy. The **GBIF Backbone** this pipeline
was built on was last updated in 2023 and will not be updated again.

The two use different key spaces — backbone keys are integers (`2434814`), CoL
keys are alphanumeric (`43MJ7`). A key from one resolves to nothing in the other,
and **GBIF answers that with an empty result set rather than an error**. That is
the single most important fact about this migration: every failure mode here is
silent. Nothing throws. Counts become 0, or a species quietly disappears.

The immediate breakage (occurrence links returning 0 records) was fixed in #442
by naming the backbone checklist explicitly, and holds as long as GBIF hosts the
backbone. This is the longer-term move.

## The thing that makes this hard: release skew

The pipeline downloads a CoL archive and builds `backbone.parquet` from it. The
natural assumption is that this local copy and GBIF's occurrence index describe
the same taxonomy. They do not, and the gap is structural rather than
transitional:

**GBIF promotes each CoL release to production 17–26 days after CoL publishes
it.** The pattern is consistent back to October 2025. So "download the newest
release" reliably lands you one release ahead of the one GBIF's occurrence index
is keyed by.

That would be harmless if usage ids were stable. They are not: **CoL renumbers
usage ids for names whose authorship changes**, roughly 2.3% of names per
release. Being one release ahead therefore makes a slice of GBIF's own occurrence
keys unresolvable against the local copy — silently, as empty results.

*Mantis religiosa* is the worked example. `3XWJS` is accepted in COL26.7 and a
*synonym* in COL26.6, where `VFYZZ` is accepted instead. All five of the top
Mantodea keys GBIF's facets emit resolve in 26.6 and 404 in 26.7. #441 resolved
keys locally against 26.7 and cut Mantodea from 1,110 species to 97.

### Finding the release GBIF actually indexes

`api.gbif.org/v2/species/match/metadata?checklistKey=xcol` reports it:

```json
{ "mainIndex": { "clbDatasetKey": "315557", "datasetAlias": "COL26.6 XR" } }
```

**The dataset record's top-level `doi` is not this signal.** It advertised 26.7's
DOI while the index served 26.6, and trusting it is what hid the skew — an
earlier draft of this document used the matching DOIs to argue a skew was
impossible.

## Principles

### P1. Pin the local copy to the release GBIF indexes; re-resolve when it moves

`fetch-col-xr` resolves the dataset in this order: `COL_XR_DATASET` env override →
GBIF's `clbDatasetKey` → newest, with a warning. The chosen release is recorded in
`src/config/col-release.json` and committed.

That id is also the re-resolution trigger. When it has not moved, the sync skips
re-downloading 3.4 GB to rebuild an identical backbone. When it moves, CoL has
renumbered usages, every stored key is suspect, and the backbone and all GBIF
phases rebuild. There is no notification for a GBIF reindex; this id is the only
signal, so the sync compares it every run.

An earlier version of this document argued the opposite — that no published
signal exists, so GBIF must be asked about every key individually. That was
wrong, and expensive: it cost ~680,000 API calls per sync. With the release
pinned, key resolution is a local DuckDB join. `other_insects` resolves
14,577/14,577 in 7 seconds.

### P2. Always pass classification context when matching names

`scientificName=Agelaius phoeniceus` alone returns **HIGHERRANK / Animalia** — a
species with 21M occurrence records, unmatched. Adding `kingdom=Animalia&class=Aves`
returns **EXACT, `5TQD6`**.

The Red List CSVs carry kingdom/class/order/family for every species. Passing
them resolves ambiguity and is harmless when there is none. Name matching still
goes through GBIF's v2 match API — unlike key resolution, it is not a lookup, and
GBIF's matcher handles spelling variants a local join cannot (*Pica nutalli* →
*Pica nuttallii*).

### P3. Never attribute one species' records to another

CoL synonymises taxa the Red List treats as separate species. Inheriting the
accepted taxon's occurrence counts puts a common species' data under a threatened
one — #441 did this to 102 CR/EN/VU species, e.g. *Pararge xiphia* (NT, Madeira
endemic) displaying 3,469,074 of *Pararge aegeria*'s records.

Wrong data is worse than missing data on a conservation dashboard.

So a synonym resolution is followed only when it is a **nomenclatural** change —
the same organism under a different name — not a **taxonomic** one. The signal is
**authorship**: a rename carries it unchanged, a lump does not.

| Red List name | CoL accepted | authorship | follow? |
|---|---|---|---|
| *Pica nutalli* | *Pica nuttallii* | `(Audubon, 1837)` both | yes |
| *Aquarana catesbeianus* | *Aquarana catesbeiana* | unchanged | yes |
| *Acacia koaia* | *Acacia koa* | Hillebr. vs A.Gray | **no** |
| *Malus sieversii* | *Malus domestica* | (Ledeb.) M.Roem. vs (Suckow) Borkh. | **no** |
| *Sus bucculentus* | *Sus scrofa* | differs | **no** |

An earlier design used edit distance between epithets instead. It is a proxy for
the question rather than an answer to it: *Acacia koaia* → *Acacia koa* is one
character and two different species. Authorship is only unavailable on one side
occasionally; the epithet comparison remains as the fallback.

### P4. Refusing a lump is not the same as having no records

A species CoL folds into another still has records identified under **its own
name**, held against its own usage, and those are legitimately its own. Blanking
it outright trades a wrong number for no number when a right number exists:

| species | shown pre-migration | its own |
|---|---|---|
| *Malus sieversii* (VU) | 146,340 | 8,135 |
| *Thymallus aeliani* (EN) | 73,641 | 11 |
| *Epilobium numidicum* (CR) | 295,698 | 0 |

These keys can never come from the facet enumeration, which only emits accepted
usages — a synonym's own key is absent from it by construction. `fetch-lumped-own-counts`
queries them directly and writes `data/lumped-own-counts.csv`.

Two rules learned building it. Only take the count when the match came from the
species' **own** name: a match reached through a Red List synonym landed on a
usage CoL assigns to a different species (*Catapodium borgesii*, a VU Azores
endemic, onto *Catapodium marinum*, a widespread European grass — 19,901 records
is not a number to hand an island endemic on that basis). And write the file
whole each run rather than appending into the per-taxon CSVs: appending made the
phase depend on run history, so tightening the rule had no effect on species a
looser rule had already added.

### P5. Coverage must be derived and asserted, not hand-ported

#441 carried the backbone's per-rank key lists across 1:1. Two failure modes
followed, neither of which raised anything:

- **Gaps.** CoL splits the backbone's Perciformes into orders that did not exist
  before (*Trachurus murphyi* is Carangiformes now), and raises octocorals to a
  class outside Anthozoa. Fishes lost 4,879 species; corals lost 44.9% of their
  occurrences, including *Paragorgia arborea* (NT) losing 2.36M records.
- **Overlaps.** Gnetidae sits *inside* Pinopsida in CoL, so listing both
  double-counted: 43 species ended up with more records since assessment than in
  total, which is impossible.

`scripts/derive-gbif-taxon-keys.ts` derives the keys from the Red List group
definitions instead, and asserts at build time that every class/order the Red List
assigns to a group is reachable from that group's keys (catches the coral gap),
and that no key in a group is an ancestor of another (catches the Gnetidae
overlap).

### P6. Nothing silent

Every count that can quietly become zero gets a guard:

- Unresolved keys are counted per taxon; below a resolution floor the sync fails
  rather than writing a truncated file. Zero keys requested is an error, not a
  pass — that is the shape of a dead group root key.
- A sampled check that stored keys still resolve in the pinned release, which
  fails the sync if GBIF has reindexed underneath us.
- `check-sync-regressions` diffs per-group numbers against the **live** sync
  (read from `origin/main`'s `latest-sync.txt`, not the working tree) and reports
  every material move. It covers `unassessed.parquet` as well as `assessed` —
  three quarters of the rows, and the entire browsing experience, previously had
  no guard at all. Each metric is judged against its own scale: brown algae has
  18 assessed species and 6,381 browsable ones.
- Zero is a value, not an absence. Writing 0-record rows for species with no
  resolvable records once made coverage read 99.7%, produced entirely by
  recording 60,601 absences as if they were measurements. Only rows with records
  are written.
- `checklistKey` is named on every request, so no result depends on which default
  GBIF is serving that week.

## Sync ordering

The Catalogue of Life phases now run **before** the GBIF phases, because key
resolution is a join against `backbone.parquet`. Previously the GBIF phases ran
first, when they talked only to the API.

## Open question: keeping the pin fresh

The weekly sync compares GBIF's `clbDatasetKey` to the pinned one and rebuilds
when they differ. That is the right trigger, but it means a GBIF reindex turns one
weekly run into a full 3.4 GB rebuild plus a complete re-resolution. That is by
design — the alternative is stale keys — but it is worth knowing that roughly once
a month the sync is much longer than usual.
