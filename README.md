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
A view of its own that searches what the assessors actually wrote — all 175,910 current global assessments, ~470 MB of prose — over a purpose-built term index. Published once per Red List release under `narratives/<release>/` in the `dashboard-data` bucket rather than once per monthly sync, since the prose only changes when the Red List publishes.

### Realm view
A three-bar Terrestrial / Freshwater / Marine chart over the same taxa table Country view scopes, so a realm narrows the tree in place. It writes the ordinary `systems` filter, so the narrowing survives leaving the view and composes with a country (`?country=ID&realm=Marine` is marine species *in* Indonesia). Realm is recorded on the assessment, so species not yet assessed have no realm even in principle — the described-species and observation columns are hidden here for that reason.

### Range maps and Area of Habitat
IUCN range maps and Area of Habitat (AOH) rasters can be overlaid on the species occurrence map, served from the `dashboard-maps` R2 bucket via `/api/species/[key]/range-map` and `/api/species/[key]/aoh`. Both are **gated to `admin` accounts** — the routes return 403 otherwise. Rasters are uploaded out of band with `scripts/maps/upload-range-maps.ts` and `scripts/maps/upload-aoh-maps.ts`.

### Country view
A per-country landing page and country list, combining live DuckDB queries with a precomputed all-species country aggregate — assessment coverage, endemics, and occurrence totals for a single country.

### Compare view
`/compare` renders two independent dashboard panels side by side, each with its own filters and view mode and both synced to the URL — so two filtered views can be compared directly, and the comparison shared as a link.

### Agent access (MCP)
An MCP server at `/api/mcp` (`@modelcontextprotocol/server` + `mcp-handler`) exposes the dashboard's data to agents. Results carry a verifiable `dashboard_url` that resolves to the equivalent UI view.

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
┌────────────────────┐  npm run sync       ┌──────────────────┐  httpfs / prebuild  ┌────────────────┐
│  IUCN Red List DB  │────────────────────▶│  parquets + JSON │────────────────────▶│  app/data/     │──▶ API Routes ──▶ UI
│  GBIF snapshot     │  (monthly, local)   │  in private R2   │  (DuckDB at runtime │  (local copy)  │
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
- **Source**: the IUCN Red List Postgres database, read (read-only) straight into `assessments.parquet` by the sync
- **Coverage**: 28 taxonomic groups across vertebrates, invertebrates, plants, fungi, and algae
- **Version**: Red List 2026-1
- **Fields**: species name, IUCN category (CR/EN/VU/etc.), assessment date, historical assessments, population trend, range countries, criteria, habitats, threats

### GBIF integration
The key innovation — linking assessment data to real-world observations:

1. **One taxonomy**: GBIF indexes its records against the Catalogue of Life eXtended Release, so a GBIF key *is* a CoL id. Each assessed species is matched once, to CoL (`assessment_link.parquet`), by GBIF's own name matcher where its answer is certain and by a reviewed decisions file (`app/scripts/sync/core/decisions.tsv`) where it isn't, and its GBIF records follow from that.
2. **Observation counts**: from GBIF's monthly snapshot, not the API. A species counts every record filed under its own name, its synonyms, its subspecies and their DNA-barcode BINs, minus any usage another assessed species owns (a split IUCN assesses that CoL files as a subspecies, for instance). **Total GBIF** (georeferenced records), **New GBIF** (records after the assessment year), and the all-records count behind the toggle. Which record types count depends on the kingdom: animals count observations in the wild, while plants and fungi also count preserved specimens, since a herbarium or fungarium sheet is often the only georeferenced record a species has.
3. **Record-type breakdown**: human observations (incl. iNaturalist), preserved specimens, machine observations.
4. **Quality filters**: georeferenced means coordinates without a GBIF geospatial issue (the codes GBIF's own `hasGeospatialIssue` acts on, checked against the API).

### Catalogue of Life
CoL supplies the described-species universe behind the new-assessments view — the species CoL knows about that haven't been assessed for the Red List yet — plus the synonym index that makes searching an outdated name work.

## How data reaches the dashboard

Four ways, and each has its own folder in [`app/scripts/`](app/scripts/README.md):

| | When | Where | What it does | Docs |
|---|---|---|---|---|
| **Sync** | monthly, by hand | your machine | builds every number (counts, links, the Not Evaluated list) from the Red List database, a GBIF snapshot and Catalogue of Life, and uploads it to R2 as a new `syncs/<timestamp>/` | [docs/sync.md](docs/sync.md) |
| **Build** | every deploy | Vercel | downloads the sync `app/latest-sync.txt` names and packages it for the deployed code: species lists, search and tree as static files. Never changes a number | [docs/build.md](docs/build.md) |
| **Occasional publishes** | when their source changes | your machine | narratives (each Red List release), range maps and AOH rasters, map overlays, reference data | [app/scripts/README.md](app/scripts/README.md) |
| **Live** | each request | Vercel | GBIF occurrence points, CITES, literature, the Red List API (see Architecture) | |

A sync goes live only when its one-line `app/latest-sync.txt` change merges to `main`; uploading one changes nothing anyone sees. Reverting that line goes back.

### Running a sync

The sync runs **monthly, locally**, once GBIF publishes a new snapshot. It needs Docker (GBIF's matcher runs locally), reads three inputs and builds everything the dashboard shows from four tables, by one counting rule. The diagram's editable source is [`docs/diagrams/sync.excalidraw`](docs/diagrams/sync.excalidraw) (open it at excalidraw.com; `docs/diagrams/gen.py` regenerates it).

```bash
# 1. Mirror the new GBIF snapshot (~255 GiB, public, no account)
uvx --from awscli aws s3 sync s3://gbif-open-data-eu-central-1/occurrence/<date>/ ~/Data/gbif/<date>/ --no-sign-request

# 2. Build and check (about five minutes from cached inputs)
cd app && npm run sync

# 3. Read build/compare/report.md (and build/match-queue.tsv, the species waiting on a decision), then publish
npm run sync:publish        # copies the build into app/data, uploads to R2, bumps app/latest-sync.txt
```

`npm run sync:publish` prints the `git add` line for the data PR. The inputs, the four core tables, the counting rule, matching, the checks, and what to look for each month are in [`docs/sync.md`](docs/sync.md).

## Getting Started

```bash
cd app
npm install
npm run fetch-data-from-r2   # populates app/data/ from private R2 (requires R2 creds in .env.local)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The data lives in a private R2 bucket rather than in the repo, so the first step downloads it locally. `npm run build` runs the same fetch automatically as `prebuild`.

## Scripts

| Command | Kind | Description |
|---------|------|-------------|
| `npm run dev` | app | Start the development server |
| `npm run build` | build | Production build: runs `prebuild` (fetch the sync, pre-build static files), then `next build` |
| `npm run start` | app | Start the production server |
| `npm run lint` / `npm test` / `npm run test:watch` | app | ESLint; Vitest, once or watching |
| `npm run test:coverage` | app | Tests with a coverage report (scoped to the `src` logic layer; HTML in `coverage/`) |
| `npm run fetch-data-from-r2` | build | Download the sync pinned in `app/latest-sync.txt` into `app/data/` |
| `npm run fetch-duckdb-ext` | build | Pre-fetch DuckDB's `httpfs` extension for Vercel's runtime |
| `npm run build-species-lists` / `build-search-shards` / `build-tree-children` | build | The pre-built static files (each runs in `prebuild`) |
| `npm run sync` | sync | Build and check a data release from the inputs |
| `npm run sync:publish` | sync | Copy the build into `app/data/`, upload it, bump `app/latest-sync.txt` |
| `npm run sync:compare` | sync | Compare a data directory with the sync production serves |
| `npm run upload-data-to-r2` | sync | Upload `app/data/` as a new timestamped sync (`sync:publish` runs it) |
| `npm run build-narratives` / `upload-narratives-to-r2` | publish | The narrative-search parquets, once per Red List release |

Everything else runs with `npx tsx scripts/<folder>/<script>.ts`; [`app/scripts/README.md`](app/scripts/README.md) lists every script by folder.

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

# IUCN Red List Postgres — read by the sync (read-only) and build-narratives
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
- **MCP** (`@modelcontextprotocol/server`, `mcp-handler`) — agent access
- **Zod** — schema validation
- **Vitest** — testing
- **Sentry** / **PostHog** / **Vercel Analytics** — monitoring and analytics
- **Vercel** — hosting and deployment
