# Red List Dashboard

A web application for exploring **IUCN Red List assessment coverage and prioritization**, integrated with GBIF occurrence records, CITES trade data and the Catalogue of Life. Designed to identify species that may need reassessment based on new evidence — and, increasingly, to be a general-purpose window onto biodiversity data, including described species that haven't been assessed for the Red List yet.

The same app is served under several brands, chosen by hostname (`src/config/brand.ts`):

| Host | Brand |
|------|-------|
| `dashforlife.org` | **Dash for Life** (default — also used for previews and localhost) |
| `dashoflife.org` | **Dash of Life** |
| `red.cst.cam.ac.uk` | **Red List Dashboard** |
| `red-list-dashboard.vercel.app` | **Red List Dashboard** |

## Core Purpose

The dashboard answers questions like:
- Which species haven't been reassessed in 10+ years?
- Have new observations accumulated since the last assessment?
- Where are the knowledge gaps across taxonomic groups?
- Which described species haven't been assessed for the Red List yet?

## Features

### Taxa summary and drill-down
The landing table shows every taxonomic group with species counts, assessment coverage, percentages of assessments needing updating, described-species totals from the Catalogue of Life, and GBIF occurrence totals. Click a row to drill into that group and down through the taxonomic tree. Includes a Red List vs GBIF focus-mode toggle and column visibility controls.

### Filter charts
Clickable charts cross-filter the species table and each other:

- **Conservation Status** — EX/EW/CR/EN/VU/NT/LC/DD
- **Years Since Assessed** — highlights species not reassessed in 10+ years ("Needs Updating")
- **Year of Latest Assessment** and **Number of Assessments**
- **Country** — world map with species/GBIF toggle, an endemics filter, and multi-select regions
- **GBIF Observations** — distribution by observation-count range
- **Year Described** — from the Catalogue of Life
- **Criteria** — the IUCN criteria under which species were listed
- **Habitat**, **Systems**, **Threats** — from the assessment record. Threats are scoped to threatened species (CR/EN/VU) by default, since IUCN's guidance is that threat coding on non-threatened assessments isn't reliable enough to chart
- **Credits** — all five SIS credit types: assessors, reviewers, contributors, facilitators and institutions. Facilitators matter most for birds, where every assessment is credited to "BirdLife International" and the facilitator line is the only one that names a person
- **Taxonomic differences from Catalogue of Life** — assessed species CoL has split, lumped, placed at a different rank, accepts under a different name, or holds no clean 1:1 match for

Charts support multi-select (Cmd/Ctrl+click), Shift+drag to sweep a range of bars, and cross-filter with the search bar. Filter state lives in the URL through a shared filter registry, so a filtered view is linkable and the MCP tools resolve to the same view the UI shows.

### Species table
- Search by scientific name, including synonyms — an old name resolves to the currently accepted species — or by genus, family, order or class to browse that node
- Sortable by assessment date (default, oldest first), category, total GBIF records, or % new GBIF
- Secondary sort on a second column (Shift or Cmd/Ctrl+click its header), with total GBIF descending as the final tiebreaker
- Links to IUCN assessment pages and GBIF occurrence search
- Pin species to the top with drag-to-reorder
- Configurable page size

### Expandable species rows
Click any species row for a tabbed (or stacked) detail view:
- **GBIF Map** — occurrence points on a MapLibre GL map, plus an iNaturalist photo gallery
- **Literature** — one chronological table of everything published about the species,
  newest first and paginated, with a dotted line marking the last assessment date.
  Merged and deduplicated across OpenAlex, Zenodo, the assessment's own reference
  list, and Biodiversity Heritage Library / CORE / Google Books when their API
  keys are configured. Rows the assessment cited are tagged as such
- **IUCN Red List Assessments** — the assessment narratives (a 200-word preview, with a link out for the rest) and the assessors, reviewers and facilitators credited on each
- **CITES** — trade status, suspensions, quotas, and a trade-flow map with history since 1975

The **Encyclopedia of Life** and **Wikipedia** tabs are hidden behind `SHOW_EOL_TAB` / `SHOW_WIKIPEDIA_TAB` flags in `RedListView.tsx`. Their panels and routes stay in the tree, and `?tab=eol` / `?tab=wikipedia` links fall back to the GBIF tab rather than stranding on a tab with no button in the bar.

### Occurrence map filtering
The GBIF map is more than a scatter of points:
- **Coordinate cleaning** — a port of R's CoordinateCleaner tests (country centroids, capitals, biodiversity institutions, sea/urban, and range-based checks) to flag implausible records
- **Native range only** — hides occurrences outside a species' native countries, catching cultivated and naturalized specimens. Two selectable sources: POWO/WCVP (default) or the Red List assessment's own locations, which can genuinely disagree
- **Basis of record** — human observations (incl. an iNaturalist subset), preserved and fossil specimens, machine observations, material samples and citations. The map opens on every type except living and fossil specimens — the two that say where an individual *ended up* rather than where the species lives — and with no coordinate cleaning applied, since the checks are plausibility heuristics with real false-positive rates and trimming is better opt-in
- **Overlays** — protected areas, POWO native range, IUCN native range, tree cover loss by dominant driver

Records **with no coordinates** and records **GBIF flags** are fetched too, rather than excluded at the API. The map can't draw the first and marks the second, but both appear in the record list: for a poorly-collected species they can be most of what's known. A sample is one budget of 300 records with the trusted ones returned first.

### Mapping tool
`/mapping/<gbif key>` is the map beside the record list on a page of its own, for the work of turning GBIF's records into an IUCN point file: all 77 Darwin Core fields behind a column picker, three tabbed lists (GBIF's records, an imported point file's rows, and the records set aside with the reason why), a resizable record panel, and the two numbers criterion B turns on. Built around plants — POWO for native range, herbarium sheets counted as records — but keyed on a GBIF species key, so nothing in it is plant-only.

### Nearby threatened species
From a record, a right-click anywhere on the occurrence map, or the locate control: the CR/EN/VU species GBIF holds records for inside a radius, with what their assessments blame beside them. Several searches can be open at once, each a tab named for where it was asked and each pinned on the map.

**`/mapping`** (formerly `/near-me`, which redirects; `/mapping/<species key>` is the species map) asks the same question of a place rather than a species, reached from the View selector. It carries the occurrence map's overlays, toolbar and callouts — the two share `useMapOverlays` and `components/mapping/overlays/` — and a click anywhere opens a callout with what the overlays say about the spot and **Show nearby threatened species**; a protected area named there offers to search **inside its boundary** instead, sending GBIF the real outline. The point can also come from a place search or the browser's location; the radius runs 1–100 km or is dragged on the ground; and three scopes (Threatened, Assessed, All species) ride in the URL alongside `?lat=&lng=&r=`.

### Narrative search
A view of its own that searches what the assessors actually wrote — all 175,910 current global assessments, ~470 MB of prose — over a purpose-built term index. Published once per Red List release under `narratives/<release>/` in the `dashboard-data` bucket rather than once per weekly sync, since the prose only changes when the Red List publishes.

### Realm view
A three-bar Terrestrial / Freshwater / Marine chart over the same taxa table Country view scopes, so a realm narrows the tree in place. It writes the ordinary `systems` filter, so the narrowing survives leaving the view and composes with a country (`?country=ID&realm=Marine` is marine species *in* Indonesia). Realm is recorded on the assessment, so species not yet assessed have no realm even in principle — the described-species and observation columns are hidden here for that reason.

### Range maps and Area of Habitat
IUCN range maps and Area of Habitat (AOH) rasters can be overlaid on the species occurrence map, served from the `dashboard-maps` R2 bucket via `/api/species/[key]/range-map` and `/api/species/[key]/aoh`. Both are **gated to `admin` accounts** — the routes return 403 otherwise. Rasters are uploaded out of band with `scripts/upload-range-maps.ts` and `scripts/upload-aoh-maps.ts`.

### Country view
A per-country landing page and country list, combining live DuckDB queries with a precomputed all-species country aggregate — assessment coverage, endemics, and occurrence totals for a single country.

### Compare view
`/compare` renders two independent dashboard panels side by side, each with its own filters and view mode and both synced to the URL — so two filtered views can be compared directly, and the comparison shared as a link.

### Agent access (MCP)
An MCP server at `/api/mcp` (`@modelcontextprotocol/sdk` + `mcp-handler`) exposes the dashboard's data to agents. Results carry a verifiable `dashboard_url` that resolves to the equivalent UI view.

### Accounts
Sign-in is handled by Supabase Auth with OAuth providers (GitHub, Google, and Microsoft/Entra). Roles are stored in a `user_roles` table and checked server-side (`src/lib/auth/roles.ts`); `admin` is currently the only role, and it gates the range map and AOH layers below. Schema lives in `app/supabase/migrations/`.

### Dark mode
Light, dark, and system theme modes.

---

## Architecture

```
Frontend:  Next.js 16 + React 19 + Tailwind CSS 4
Maps:      MapLibre GL (react-map-gl) + react-simple-maps
Charts:    Recharts
Query:     DuckDB (@duckdb/node-api) over Parquet, inside API routes
Auth:      Supabase (@supabase/ssr)
Agents:    MCP server at /api/mcp
Telemetry: Sentry, PostHog (proxied via /ingest), Vercel Analytics
Hosting:   Vercel

Data Flow:
┌────────────────────┐  scripts/sync.ts    ┌──────────────────┐  httpfs / prebuild  ┌────────────────┐
│  IUCN Red List DB  │────────────────────▶│  CSVs + parquets │────────────────────▶│  app/data/     │──▶ API Routes ──▶ UI
│  GBIF API          │  (offline pipeline) │  in private R2   │  (DuckDB at runtime │  (local copy)  │
│  Catalogue of Life │                     │                  │   / build-time)     │                │
└────────────────────┘                     └──────────────────┘                     └────────────────┘
                          version pinned by app/latest-sync.txt (git-tracked)

Live external APIs:
  GBIF REST API     → occurrence points, record breakdowns, iNaturalist photos
  Species+ API      → CITES listings, trade data
  OpenAlex          → scientific literature (primary literature source)
  Zenodo            → conservation grey literature, reports, theses
  IUCN Red List API → assessment detail, and the assessment's reference list
  BHL / CORE /      → historical scans, repository theses and reports,
  Google Books        printed floras (each optional — enabled by its own key)
  EOL TraitBank     → trait data for the EOL tab (hidden behind a flag)
  Photon / OSM      → place search on the occurrence map and /mapping
```

## How the Data Works

### Red List data
- **Source**: the IUCN Red List Postgres database, pulled into per-taxon CSV files by the sync pipeline
- **Coverage**: 28 taxonomic groups across vertebrates, invertebrates, plants, fungi, and algae
- **Version**: Red List 2026-1
- **Fields**: species name, IUCN category (CR/EN/VU/etc.), assessment date, historical assessments, population trend, range countries, criteria, habitats, threats

### GBIF integration
The key innovation — linking assessment data to real-world observations:

1. **Species matching**: each IUCN species is matched to GBIF via their species-matching API (exact, fuzzy, and variant matches). Results stored in `data/mapping.csv`.
2. **Observation counts**: **Total GBIF** (all geo-referenced records), **New GBIF** (records added after the assessment year), and **% New GBIF**. Which record types count depends on the kingdom: animals count observations in the wild, while plants and fungi also count preserved specimens, since a herbarium or fungarium sheet is often the only georeferenced record a species has.
3. **Record-type breakdown**: human observations (incl. iNaturalist), preserved specimens, machine observations.
4. **Quality filters**: only geo-referenced records without coordinate issues.

Match quality is surfaced in the UI, since it affects how far to trust a count:
- **EXACT** — reliable match
- **FUZZY/VARIANT** — name variations matched
- **HIGHERRANK** — matched to genus/family only (counts may include other species)
- **NONE** — species not found in GBIF

### Catalogue of Life
CoL supplies the described-species universe behind the new-assessments view — the species CoL knows about that haven't been assessed for the Red List yet — plus the synonym index that makes searching an outdated name work.

## Data Sync Pipeline

The `scripts/` directory contains a pipeline for refreshing all static data files:

```bash
npx tsx scripts/sync.ts                  # Full sync, all taxa
npx tsx scripts/sync.ts mammalia aves    # Specific taxa only
npx tsx scripts/sync.ts --skip-redlist   # Skip every DB-dependent phase (no IUCN DB access needed)
```

**Pipeline phases.** The Catalogue of Life backbone is built **first**, because the GBIF phases below it resolve taxa against CoL keys — GBIF's own backbone was retired in favour of the CoL Extended Release in June 2026.

1. `fetch-redlist-species` — Red List database → per-taxon CSVs in `data/redlist/`. The only phase needing IUCN Postgres access; skipped by `--skip-redlist`

Phases 2–4 build the **Catalogue of Life backbone** (full sync only) — the described-species universe behind the new-assessments view, which surfaces species CoL knows about that haven't been assessed for the Red List yet:

2. `fetch-col-xr` — CoL eXtended Release ColDP archive → `NameUsage.tsv` + `Reference.tsv` (downloaded to a temp dir, not `data/`)
3. `fetch-col-checklist` — curated CoL Checklist ColDP archive → a demotion overlay (col_ids the checklist's editorial reconciliation demotes to synonym/infraspecific, correcting XR's over-splitting). CoL names a new release days before its ColDP archive is built, so this steps back a release on a 404 rather than failing the run
4. `build-backbone` — `NameUsage.tsv` (minus the checklist's demotions) → `backbone.parquet` (tree + synonyms) + `species/` (accepted-species universe, partitioned; tagged `extinct`/`in_base`) + vernaculars

4b. `derive-gbif-taxon-keys` — Red List groups + `backbone.parquet` → `src/config/gbif-taxon-keys.json`. Pins each group to the GBIF *index* of the CoL release being built against, rather than whatever GBIF currently considers newest. **Committed to git**

Phases 5–8 pull from GBIF, keyed on what phases 2–4 produced:

5. `fetch-gbif-species` — GBIF facets + backbone → per-taxon CSVs in `data/gbif/`
6. `match-redlist-species-to-gbif` — GBIF Match API → `data/mapping.csv`. Retries a name GBIF can't place below genus with IUCN's authorship as its own parameter, and refuses to let one assessed species claim another's key
7. `fetch-gbif-country-data` — GBIF API → per-species country occurrence counts
8. `fetch-gbif-new-counts` — GBIF API → updates GBIF CSVs with temporal splits

8b. `fetch-lumped-own-counts` — GBIF API → counts for keys the facets can't emit

Phases 9–12 build the read layer:

9. `build-parquet` — CSVs → `assessed.parquet` / `unassessed.parquet` (the DuckDB read layer)
10. `build-matching` — reconciles IUCN/GBIF species to CoL → `species_link.parquet` (`{sis_taxon_id, gbif_species_key} → col_id`, via accepted-name + CoL/IUCN synonym matching, including the orthographic and gender-agreement variants CoL spells differently)
11. `build-synonym-index` — CoL synonyms → their accepted species, so search for an old/synonym name still finds the current one

11b. `build-search-index` — the two name-sorted indexes the search bar reads. `name-index.parquet`: every name the fast path can match (scientific name, common name, epithet, and each word of a multi-word common name), so a typeahead prefix prunes to a row group instead of scanning `assessed`/`unassessed` whole. `rank-index.parquet`: the class/order/family/genus names behind "Browse Felidae →", one row per name. Needs `species_link.parquet` (phase 10) for the `col_id`s it bakes in, which is why it runs here rather than beside `build-parquet`

12. `build-col-taxon-ids` — resolves every taxon name referenced in `taxonomy-tree.ts`'s filters against `backbone.parquet` → `src/config/col-taxon-ids.json` (each name's CoL taxon id, so the dashboard can link a name straight to its CoL page). Small and derived from committed source, so — unlike the other outputs here — it's **committed to git**, not published to R2. Re-run standalone (`npx tsx scripts/build-col-taxon-ids.ts`) whenever a node's filter changes, without needing a full sync

Phase 13 and its siblings run **last**, since they aggregate everything above:

13. `build-taxa-summary` — aggregates per-taxon CSVs + the CoL backbone (`species/`, `species_link.parquet`) → `data/taxa-summary.json`, `data/table1a-children-summaries.json`/`data/ssc-group-children-summaries.json` (split from a single `node-children-summaries.json` — the old combined name, kept here as a pointer for anyone searching it), and the precomputed `data/country-stats.json` / `data/realm-stats.json` the Country and Realm views read, including per-group `col_described`/`col_ne` counts

13a. `build-col-revisions` — the "possible taxonomic revision" flag, unscoped over every assessed species → `data/col-revisions.json` (`sis_taxon_id → flag`). Several signals share the file: the same "why does this species have no clean 1:1 CoL match" diagnostic Phase 13 computes per SSC group, the species CoL has likely split *out* of an assessed one (`split_candidates`, inverted), and the species CoL accepts under a different name. Feeds the dashboard's **Taxonomic differences from Catalogue of Life** filter chart and the per-row ⚑ flag. Small (~580 KB) and CI-relevant, so it's **committed to git** alongside `taxa-summary.json`, and published to R2 with the rest of the sync

13b. `check-sync-regressions` — diffs per-group numbers against the live sync, so a bad refresh is caught before it's uploaded

14. `upload-range-maps` — IUCN DB → `dashboard-maps` R2, skipping what's already there; skipped by `--skip-redlist`
15. `upload-aoh-maps` — STAR GeoTIFFs → `dashboard-maps` R2, same; skipped by `--skip-redlist`, since it depends on local STAR pipeline output

**The assessment narratives are not sync data.** They change when the Red List publishes, twice a year, where a sync runs weekly — so `npm run build-narratives` and `npm run upload-narratives-to-r2` publish them separately, under `narratives/<release>/`, pointed at by the `NARRATIVE_RELEASE` constant the way `latest-sync.txt` points at a sync.

**Publishing a refresh.** `app/data/` lives in a private R2 bucket; the active version is pinned via `app/latest-sync.txt`. To publish a fresh sync:

```bash
npx tsx scripts/sync.ts                # regenerate app/data/ locally
npm run diff-data-vs-r2                # spot-check what changed vs the live pinned sync
npm run upload-data-to-r2              # upload to R2, bump app/latest-sync.txt
git add app/latest-sync.txt && git commit -m "Bump data sync to <ts>"
git push                               # open PR; merging flips production
```

Production only switches to the new sync once the pointer-bump PR merges to main and Vercel redeploys.

**Most of this is automated.** The `weekly-sync` workflow runs the whole pipeline under `--skip-redlist` every Sunday at 20:00 UTC and opens the pointer-bump PR itself, so the manual flow above is mainly for local work and one-off resyncs. Phases 1, 14 and 15 are skipped there — phase 1 is the only one needing IUCN Postgres access, and the Red List data stays on its own manual ~6-month cadence, while 14 and 15 need raster inputs that exist on one machine.

## Getting Started

```bash
cd app
npm install
npm run fetch-data-from-r2   # populates app/data/ from private R2 (requires R2 creds in .env.local)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The Red List CSVs live in a private R2 bucket rather than in the repo, so the first step downloads them locally (~240MB). `npm run build` runs the same fetch automatically as `prebuild`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Production build (auto-runs `fetch-data-from-r2` first) |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm test` | Run tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with a coverage report (scoped to the `src` logic layer; HTML report in `coverage/`) |
| `npm run fetch-data-from-r2` | Download the sync pinned in `app/latest-sync.txt` from R2 into `app/data/` |
| `npm run upload-data-to-r2` | Upload current `app/data/` to R2 as a new timestamped sync and bump `app/latest-sync.txt` |
| `npm run diff-data-vs-r2` | Diff local `app/data/` against the currently-pinned R2 sync |
| `npm run build-narratives` | Build the four narrative-search parquets from the IUCN database (needs phase-1 DB access) |
| `npm run upload-narratives-to-r2` | Publish those parquets under `narratives/<NARRATIVE_RELEASE>/` in R2 |
| `npm run fetch-duckdb-ext` | Pre-fetch the DuckDB `httpfs` extension, for environments that can't download it at runtime |

Other pipeline scripts are run directly with `npx tsx` — see `app/scripts/`, including `fetch-wcvp-native-range.ts` (POWO native ranges), `fetch-coordinate-cleaning-refdata.ts` (CoordinateCleaner reference data), and `upload-range-maps.ts` / `upload-aoh-maps.ts` (raster uploads).

## Environment Variables

Create `app/.env.local`. The R2 credentials are the only ones needed just to run the app locally against a pinned sync; the rest enable individual features.

```
# Cloudflare R2 — required for fetch-data-from-r2 / prebuild
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_access_key
R2_DATA_BUCKET_NAME=dashboard-data
R2_MAPS_BUCKET_NAME=dashboard-maps      # range map / AOH rasters

# Live external APIs — runtime, for the assessment-detail, CITES and EOL tabs
RED_LIST_API_KEY=your_iucn_api_key
SPECIES_PLUS_API_KEY=your_cites_species_plus_api_key
EOL_TOKEN=your_eol_jwt_token

# Literature tab — each optional, and each adds one source to the timeline
BHL_API_KEY=your_biodiversity_heritage_library_key
CORE_API_KEY=your_core_key
GOOGLE_BOOKS_API_KEY=your_google_books_key

# Supabase — sign-in and roles
SUPABASE_URL=your_supabase_project_url
SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key

# Analytics (optional, public). Events are reverse-proxied through /ingest.
NEXT_PUBLIC_POSTHOG_KEY=your_posthog_key

# IUCN Red List Postgres — needed only to run phase 1 of the sync pipeline
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_db_name
DB_USER=your_db_user
DB_PASSWORD=your_db_password
```

`app/.env.example` carries the same list with fuller commentary on each.

## Repo Automation

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `test` | Pull requests and pushes to `main` | Tests with coverage, lint, and typecheck |
| `weekly-sync` | Sundays 20:00 UTC | Runs the sync under `--skip-redlist`, uploads to R2, opens the pointer-bump PR |
| `supabase-migrations` | Push to `main` touching `app/supabase/migrations/` | Applies new migrations to the Supabase project |
| `claude` | `@claude` mention | Runs Claude Code on an issue or PR comment |

Contributor conventions (PR descriptions, UI verification, worktrees, screenshot hosting) are in [CLAUDE.md](CLAUDE.md).

## Tech Stack

- **Next.js 16** / **React 19** / **TypeScript 5** — app framework
- **Tailwind CSS 4** — styling
- **DuckDB** (`@duckdb/node-api`) — Parquet query layer behind the API routes
- **Recharts** — charts
- **MapLibre GL** (react-map-gl) / **react-simple-maps** — maps
- **Supabase** — auth and roles
- **MCP** (`@modelcontextprotocol/sdk`, `mcp-handler`) — agent access
- **Zod** — schema validation
- **Vitest** — testing
- **Sentry** / **PostHog** / **Vercel Analytics** — monitoring and analytics
- **Vercel** — hosting and deployment
