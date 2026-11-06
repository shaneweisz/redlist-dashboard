# app/scripts

Everything here runs outside the web app, and each folder is one answer to *when does it run?* The app itself (`app/src/`) never imports from here; scripts import from `src/` where the two must agree, such as a row format the browser decodes.

| Folder | Runs | Where | Writes | Docs |
|---|---|---|---|---|
| [`sync/`](sync) | monthly, by hand (`npm run sync`) | your machine: needs the GBIF mirror, Docker, the Red List database | a new `syncs/<timestamp>/` in R2 | [docs/sync.md](../../docs/sync.md) |
| [`build/`](build) | every deploy (`prebuild`), and locally on `npm run build` | Vercel | `app/data/sync/` from R2, then static files in `app/public/prebuilt/<sync>/` | [docs/build.md](../../docs/build.md) |
| [`narratives/`](narratives) | each Red List release (twice a year) | your machine: the Red List database | `narratives/<release>/` in R2 | [README](../../README.md#narrative-search) |
| [`maps/`](maps) | when a map source changes | your machine | rasters and overlays in the maps bucket, reference data in `src/lib/` | each script's header |
| [`lib/`](lib) | (shared) | | | |
| [`ci/`](ci) | on every pull request | GitHub Actions | the coverage comment | |

Tests for all of them are in [`__tests__/`](__tests__).

## sync/

The monthly data release. `sync.ts` runs the steps in order; each also runs alone with `npx tsx`.

| | |
|---|---|
| `sync.ts` | the driver: inputs → core → outputs → checks, then `sync.json` |
| `publish.ts`, `upload-data-to-r2.ts` | copy a finished build into `app/data/sync/` and upload it as a new sync |
| `paths.ts` | where the cache and the build live (`~/.cache/redlist-dashboard/`) |
| **`inputs/`** | what a sync is built from, each cached by version |
| `col.ts`, `col-xr.ts`, `col-checklist.ts` | Catalogue of Life: the XR GBIF indexes, the curated checklist, Base sources |
| `inat-names.ts` | iNaturalist's English common names |
| `matcher.ts` | GBIF's name matcher (matching-ws), built and served in Docker |
| **`core/`** | the four source-of-truth tables, and the rules that make them |
| `build-taxa.ts`, `build-assessments.ts`, `build-occurrences.ts` | CoL usages, Red List assessments, GBIF record counts |
| `build-matches.ts`, `accept-match.ts`, `decisions.ts`, `decisions.tsv`, `build-link.ts` | which CoL species each assessed species is |
| `counts.ts` | the counting rule |
| `species-key.ts`, `name-variants.ts`, `taxon-groups.ts` | the concept rules, name spellings, Table 1a groups |
| **`outputs/`** | what the app reads, built from the core tables |
| `build-read-models.ts` | `assessed`, `ne`, `species/` and the other parquets |
| `build-taxa-summary.ts`, `build-col-revisions.ts`, `build-synonym-index.ts`, `build-search-index.ts`, `build-col-taxon-ids.ts`, `build-vernaculars.ts` | summaries, the CoL-revision flag, the search and synonym indexes, CoL ids for the taxonomy tree, common names; all called by `sync.ts` |
| `derive-gbif-taxon-keys.ts` | by hand, with `--write`, when CoL moves: the group root keys the country-stats route queries GBIF with (`src/config/gbif-taxon-keys.json`) |
| **`checks/`** | what a build is held to before it is published |
| `check-fixtures.ts`, `fixtures/matching.ts` | 50 named matching cases |
| `compare.ts`, `compare/`, `baseline.ts` | the field-by-field comparison with the sync production serves |

## build/

Run in this order by `prebuild` (`app/package.json`):

| | |
|---|---|
| `fetch-data-from-r2.ts` | downloads the sync `app/latest-sync.txt` names into `app/data/sync/` |
| `fetch-duckdb-ext.ts` | vendors DuckDB's `httpfs` extension for Vercel's runtime |
| `build-species-lists.ts`, `build-search-shards.ts`, `build-tree-children.ts` | pre-built species lists, search dropdown and taxonomy tree in `app/public/prebuilt/<sync>/` |
| `check-species-lists.ts`, `check-search-shards.ts`, `check-tree-children.ts` | by hand: prove each pre-built file answers like the live route it replaces |

## narratives/

`build-narratives.ts` reads every assessment's narrative text from the Red List database into four search parquets in `app/data/narratives/`; `upload-narratives-to-r2.ts` publishes them under `narratives/<release>/`. Run once per Red List release.

## maps/

Run by hand when their source changes: `upload-range-maps.ts` and `upload-aoh-maps.ts` (range maps and Area of Habitat rasters), `build-sampling-effort-layer.ts`, `build-ecoregions-layer.ts` and `upload-overlays-to-r2.ts` (map overlays), `fetch-coordinate-cleaning-refdata.ts` and `fetch-wcvp-native-range.ts` (reference data committed under `src/lib/`).

## lib/

`utils.ts` (env loading, `DATA_DIR`, logging), `taxa.ts` (the Red List group definitions scripts share), `r2.ts` (listing and downloading a sync).
