# app/scripts

Everything here runs outside the web app, and each folder is one answer to *when does it run?* The app itself (`app/src/`) never imports from here; scripts import from `src/` where the two must agree, such as a row format the browser decodes.

| Folder | Runs | Where | Writes | Docs |
|---|---|---|---|---|
| [`sync/`](sync) | monthly, by hand (`npm run sync`) | your machine: needs the GBIF mirror, Docker, the Red List database | a new `syncs/<timestamp>/` in R2 | [docs/sync.md](../../docs/sync.md) |
| [`build/`](build) | every deploy (`prebuild`), and locally on `npm run build` | Vercel | `app/data/sync/` from R2, then static files in `app/public/prebuilt/<sync>/` | [docs/build.md](../../docs/build.md) |
| [`narratives/`](narratives) | each Red List release (twice a year) | your machine: the Red List database | `narratives/<release>/` in R2 | [README](../../README.md#narrative-search) |
| [`maps/`](maps) | when a map source changes | your machine | rasters and overlays in the maps bucket, reference data in `src/lib/` | each script's header |
| [`config/`](config) | by hand, when CoL moves | your machine | committed config in `src/config/` | the script's header |
| [`lib/`](lib) | (shared) | | | |
| [`ci/`](ci) | on every pull request | GitHub Actions | the coverage comment | |

Tests for all of them are in [`__tests__/`](__tests__).

## sync/

The monthly data release. `sync.ts` is the whole sync, read top to bottom: one section per stage, each builder given the tables it reads. Every builder's file starts with its table's description (what a row is, what it is built from, its columns, its decisions); [docs/sync.md](../../docs/sync.md#the-tables) collects them. `npm run sync -- --from <stage>` reruns from a stage on.

| | |
|---|---|
| `sync.ts` | the recipe: inputs, then the six stages, then `sync.json` |
| `paths.ts` | where the cache and the build live (`~/.cache/redlist-dashboard/`), and the name of every file a sync builds |
| `sql.ts` | `openDuckDB` and small SQL helpers |
| `publish.ts`, `upload-data-to-r2.ts` | copy a finished build into `app/data/sync/` and upload it as a new sync |
| **`inputs/`** | fetch and cache each input, by version |
| `col.ts`, `col-xr.ts`, `col-checklist.ts` | Catalogue of Life: the XR GBIF indexes, the curated checklist, Base sources |
| `inat-names.ts` | iNaturalist's English common names |
| `gbif-snapshot.ts` | the GBIF snapshot mirror: found, checked complete, reduced once to per-usage counts |
| `matcher.ts` | GBIF's name matcher (matching-ws), built and served in Docker |
| **`sources/`** | 1: each input as one clean table |
| `taxa.ts`, `taxon-groups.ts` | every CoL usage, with its species and Table 1a group |
| `assessments.ts` | every global assessment, from the Red List database (read-only) |
| `occurrences.ts` | GBIF records per usage, georeferenced or not, by date; and by country |
| `common-names.ts` | every common name CoL and iNaturalist give, and the one each would show |
| **`link/`** | 2: which CoL species each assessed species is |
| `matches.ts` | GBIF's matcher's answer for every Red List name |
| `accept-match.ts`, `decisions.ts` | when the matcher's answer is taken without review; people's decisions otherwise |
| `assessment-link.ts`, `species-key.ts`, `name-variants.ts` | the link table and its concept rules |
| **`count/`** | 3: whose records each GBIF usage's are |
| `usage-owners.ts` | `usage_owner`: the counting rule, as a table |
| `record-counts.ts` | each species' totals, in both record modes and since its assessment |
| **`lists/`** | 4: what the app reads, joins only: `assessed.ts`, `assessment-history.ts`, `species.ts`, `ne.ts`, `app-taxonomy.ts`, `vernacular-names.ts` |
| **`precomputed/`** | 5: the app's own queries, run ahead of time |
| `col-differences.ts`, `col-revisions.ts` | the CoL-differences card's tables and per-species flags |
| `summaries.ts` | per-group, per-country and per-tree-node totals |
| `search-index.ts`, `synonym-index.ts` | the search bar's indexes |
| `col-taxon-ids.ts` | the CoL id of every taxonomy-tree name (written into `src/config/`) |
| **`checks/`** | 6: what a build is held to before it is published |
| `check-fixtures.ts`, `fixtures/matching.ts` | 50 named matching cases |
| `compare.ts`, `compare/`, `baseline.ts` | the field-by-field comparison with the sync production serves |
| **`seeds/`** | every decision a person made, one TSV per kind, each row with its reason (`seeds.ts` lists them) |

## config/

`derive-gbif-taxon-keys.ts`: by hand, with `--write`, when CoL moves: the group root keys the country-stats route queries GBIF with (`src/config/gbif-taxon-keys.json`).

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

`utils.ts` (env loading, `DATA_DIR`, a JSONL logger the map uploaders use, a concurrency helper), `taxa.ts` (the 28 Table 1a group definitions), `r2.ts` (the one R2 client every script uses, and downloading a sync), `redlist-db.ts` (the Red List database, opened read-only, for the scripts outside the sync).
