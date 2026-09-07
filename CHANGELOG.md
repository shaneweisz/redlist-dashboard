# Changelog

All notable changes to the IUCN Red List Assessments Dashboard.

## [Unreleased]

- Dropped the coloured dot beside the Assessors / Reviewers / Facilitators / Contributors / Institutions picker in the credits filter chart — the select already names the credit type, and the chart's own bars carry the colour
- The ⚑ taxonomic-difference marker in the species table now appears only while the **Taxonomic differences from Catalogue of Life** card is actually filtering — pick ⚑ / Clean or one of the reason bars and the flagged rows are marked; with no CoL filter on, no row carries a flag. It answers a question the reader has to have asked, and on the unfiltered table it was answering it unprompted, putting a caveat about a second checklist beside names in a list that is otherwise about assessments. The card's counts, the filter itself and the flag's tooltip are unchanged. This also drops the unreleased `colScope` ("10+ yrs old only" / "Any age") option on that card — how old an assessment is no longer has any bearing on the flag
- Added **Suggested Facilitators** and merged the Suggested Assessors and Suggested Reviewers tabs into a single **Suggested Experts** tab with an Assessors / Reviewers / Facilitators toggle, matching the filter chart's. Facilitators are the individuals behind an organisational assessor — every bird assessment is credited to "BirdLife International", so for those groups it's the only credit line that names a person, and the ranking now reaches them. The credit line you pick is remembered between sessions, and links naming the old tabs (`?tab=assessors`, `?tab=reviewers`) still open the merged tab on the role they asked for
- Added genus to the search bar and to `taxa=`. Typing a genus now offers "Browse *Panthera*" alongside the family/order/class suggestions and lands on the genus node in the taxa table (All Species → Mammals → Carnivora → Felidae → Panthera), the same place drilling down the tree reaches; `?taxa=panthera` — in the dashboard, /browse and MCP — resolves too, where before it matched nothing and came back empty. The genus tier is capped at one suggestion whenever a higher rank also matches, so "urs" still leads with Ursidae and "chi" with Chiroptera rather than a run of short genus names
- Reworked Suggested Assessors and Suggested Reviewers around the species' own lineage, with a granularity picker: the two count columns now re-scope between the whole taxon group, the species' class, order, family and genus, so you can go from "who assesses mammals in Southern Africa" to "who has actually worked on a vlei rat" in one click. The tab opens on the finest level that still has enough people to compare, ranks with nothing recorded for the species are left out, and clicking a row opens the dashboard filtered to that person at the level on screen. This also fixes both tabs coming up empty for any drilled-in taxon — live taxonomic drilldown had made the selection an id the static taxonomy tree has no node for, and the old query treated it as a taxon-group name and matched nothing; scope now comes from the species rather than the selection, so where you drilled in from no longer affects the answer. "Last Assessment" now reports when that person last worked on a species in scope, rather than the species' own latest assessment date
- Fitted the Years Since Assessed card's header onto one row — the Needs Updating button and the Range/Year selector were wrapping below the title. The selector now draws its own chevron instead of the browser's (a native select reserves width for the platform arrow that padding can't reclaim), and both controls sit slightly tighter
- Added a scope option to the Threats chart, defaulting to **Threatened only** (CR, EN, VU). IUCN's feedback is that threat coding on non-threatened assessments isn't reliable, so the bars, drill-down pills and percentages now count threatened species by default, and picking a threat filters to threatened species too — the bar's count is exactly what clicking it selects. "All species" in the card's dropdown restores the old behaviour (and is what /browse and MCP dashboard links carry, so those keep reproducing the species set they were generated from)
- Slimmed the species detail panel's Red List tab down to the assessment narratives and renamed it **IUCN Red List Assessments**. The Habitats / Threats / Conservation Actions code lists and the EOO/AOO/population/elevation parameter strip are gone, and the narratives are capped at 200 words in total (not per section — the text stops where the budget runs out) with a link to read the rest — the IUCN Red List page the tab already links to is the place for the full assessment
- Fixed HTML entities showing through as literal text in assessment narratives — *Sorbus lancastriensis*' population section read "known&#160;from 46 sites"
- Added Shift+drag range selection to the filter charts — drag across Conservation Status, Years Since Assessed, Year of Latest Assessment, GBIF Records, Year Described, Number of Assessments or the Assessors/Reviewers/Facilitators chart to select every bar swept over, holding Cmd/Ctrl to add to the existing selection rather than replace it. The Year view's from/to number inputs are gone — a drag across the bars does the same job in one gesture (the `minAssessmentYear`/`maxAssessmentYear` URL params still work for shared links, /browse and MCP)
- Fixed GBIF counts for plants and fungi excluding preserved specimens. Herbarium and fungarium sheets are the primary — often the only — georeferenced record of a plant or fungus, so counting field observations alone showed *Parkinsonia peruviana* (CR) as having 1 record when it has 31. The sync now counts preserved specimens for Plantae, Fungi and Chromista, matching what the occurrence map has defaulted to for those kingdoms all along; animals are unchanged
- Fixed a species search sticking to the taxa table. After searching a species, clicking a different taxa or sub-group row kept `search=` and `species=` in the URL, so the group you clicked came up narrowed to that one species, with its detail panel still open below and the searched name still in the filter box. A taxa/sub-group click now drops the species drill-down with it, and **All Species** returns to the full landing table — every filter cleared, in one history entry, exactly as a fresh visit looks

## [v2.19.0] — 2026-07-24 – 2026-07-30 — Sign-in, Compare Mode & Filter Charts

- Added sign-in — GitHub, Google and Microsoft accounts via Supabase Auth, backed by a generic `user_roles` table so permissions aren't hardcoded per user. Signing in returns you to the page and query string you were on, and works across all the custom domains (Microsoft is wired up and working, but its button is hidden for now)
- Added a Compare mode — two dashboard panels side by side, each with its own filters and view mode, reachable from the View dropdown
- Added Criteria, Habitat and "Number of Assessments" filter charts, and unified all three hierarchical filters (Criteria, Threats, Habitat) on a single pattern: a bar chart at the top level that drills into pills, rather than a second nested bar chart. Criteria deliberately stays in A–E order rather than sorting by count, since that ordering is the standard one
- Added IUCN range map and Area of Habitat (AOH) layers to the species occurrence map, served as rasters from R2 and gated to admin accounts
- Reworked the taxa-view header controls and filter cards: the View selector moved into the taxa breadcrumb table itself (landing-only), "More Filters" became a full-width card row and now holds the Country map and Threats chart, and the taxon stat card shows the filtered count instead of a static total
- Reworked the Country view to lead with the map, revealing the table on click, and restored the landing map's full height
- Moved the header controls onto the title row and the iNaturalist photos below the map on mobile
- Zoomed the By Country map in one level by default
- Fixed GBIF occurrence links returning 0 records
- Fixed wrong species thumbnails for name-ambiguous iNaturalist matches, and cached the thumbnail proxy
- Fixed a country selection outside Country view silently re-scoping the taxa breadcrumb table's own numbers — only the species list below it is scoped now
- Fixed the weekly data sync still running DB-dependent phases under `--skip-redlist`

## [v2.18.0] — 2026-07-19 – 2026-07-23 — Native Range, Country View & Dynamic Taxon Browsing

- Added a Country view — a per-country landing page and a sortable country list alongside the existing world map
- Added trait data from EOL TraitBank to the Encyclopedia of Life tab
- Added an overall "load more" button and a date-range filter to the GBIF occurrence map
- Added a "Native range only" check to the GBIF occurrence map's Coordinate cleaning dropdown — hides occurrences reported outside a species' native countries, catching cultivated/naturalized botanical-garden specimens. Two selectable sources (POWO/WCVP default, or the Red List assessment's own locations), which can genuinely disagree on native range. POWO now covers the full WCVP checklist (~983k names, current and synonym), not just already-assessed species — served from a Parquet file queried via DuckDB rather than a JSON import, cutting the cold-start lookup from ~3s to ~200ms
- Added an "Overlays" dropdown to the GBIF occurrence map (Protected areas, POWO native range, IUCN native range) — shades which countries a source considers native, independent of the occurrence filter above; info icons link to the species' real POWO page and to Protected Planet
- Tightened the Basis of Record dropdown's layout (narrower) and made its counts, and Coordinate cleaning's, cross-filter consistently with the new native-range check; moved the "Loaded X of Y" summary onto the map itself (top-right)
- Made the taxonomic browser fully dynamic — every taxon now drills down live against the Catalogue of Life, replacing the hand-crafted described-species citations
- Showed ancestor breadcrumb rows when jumping straight to a taxon from search, so it's clear where in the tree you've landed
- Fixed the occurrence map re-fitting its zoom/bounds every time a filter checkbox was toggled — it now only re-fits on genuinely new data (new species, larger sample), not on filter changes
- Fixed a Not Evaluated count mismatch for Mammals, and stopped the Not Evaluated view being offered for All Species
- Fixed two weekly data-sync failures: a CoL checklist 404 during the monthly release rollover, and a stale file allowlist that broke the pointer-bump PR
- Refreshed the GBIF/CoL data sync, adding Red List assessment criteria

## [v2.17.0] — 2026-07-09 – 2026-07-18 — Coordinate Cleaning, SSC Groups & Red List 2026-1

- Added GBIF coordinate cleaning — a TypeScript port of R's CoordinateCleaner checks (country centroids, capitals, biodiversity institutions, sea and urban tests, and range-based checks), together with an overhaul of the occurrence map's filter UI built around it
- Added an SSC Specialist Groups view, piloted on IUCN's mammal Specialist Groups and then extended to all six taxa (reptiles, fishes, invertebrates, plants, fungi)
- Synced to IUCN Red List 2026-1, and dropped the `has_map` column since range maps are unavailable
- Added a "% Outdated" mode to the country map, switched its colouring to a linear gradient, and tidied its loading and Clear-all behaviour
- Renamed "Assessments by Year" to "Year of Latest Assessment" and gave it an Outdated toggle
- Defaulted unevaluated species to the Catalogue of Life tab when there's no occurrence data to show
- Added a weekly data-sync GitHub Action, so the GBIF/CoL refresh and its pointer-bump PR now happen on a schedule instead of by hand
- Fixed country-map name mismatches that were hiding data for ~40 territories, and folded Kosovo into Serbia as already done for Somaliland and Northern Cyprus
- Fixed crustaceans missing two SIS-assessed barnacle species

## [v2.16.0] — 2026-06-30 – 2026-07-07 — Shared Filters, Attribution & Taxon Browsing

- Added a shared filter registry so the dashboard URL, MCP tools, and /browse stay in sync
- Added a "Dash For Life" brand for dashforlife.org, then renamed it to "Dash for Life"
- Added a commercial-use disclaimer to the Red List attribution footer
- Renamed the red.cst.cam.ac.uk brand title to "Red List Dashboard", added the globe icon, and reordered footer data sources to lead with IUCN Red List (version 2025-2)
- Surfaced arbitrary-taxon browsing via search with a thin taxon header
- Clarified GBIF column headers and added IUCN criteria on category hover
- Refreshed GBIF/CoL data sync (first full resync in ~3 weeks)

## [v2.15.0] — 2026-06-22 – 2026-06-24 — Dash of Life Default Brand & Header Redesign

- Made Dash of Life the default brand with a globe favicon
- Redesigned the dashboard header with a title + subtitle layout; renamed "Risk Category" to "Conservation Status"
- Added a "Suggested Reviewers" tab for NE species, analogous to Suggested Assessors, and stripped affiliation labels so assessor/reviewer candidates aggregate correctly
- Added a "Threatened" shortcut to the risk category chart
- Added an endemics filter to the country map and a configurable page-size selector to species/CITES tables
- Fixed table overflow, mobile landing alignment, and expanded-detail viewport fit
- Reverse-proxied PostHog events through /ingest to beat ad blockers
- Added test coverage reporting to CI

## [v2.14.0] — 2026-06-18 – 2026-06-19 — CITES Map Polish, EOL Tab & Dash of Life Rebrand

- Added flow-count slider, volume-scaled flows, and a records table to the CITES trade map
- Added an Encyclopedia of Life (EOL) tab to the species detail panel
- Gave agent-facing MCP/browse results a verifiable dashboard_url and simplified taxa URL params to a single flat param
- Introduced "Dash of Life" as an alternate brand for dashoflife.org, with per-domain titles
- Reworked the Threats and Assessors/Reviewers charts (repositioned, side-by-side layout)

## [v2.13.0] — 2026-06-15 – 2026-06-17 — Search Speed & CITES Trade Overhaul

- Sped up cold-start search and stopped syncing the unused JSON search index
- Fixed a described-year mis-parse from DOI citations and added a pre-Linnaean floor
- Overhauled CITES trade data: full history since 1975, unit-aware commodities, clearer re-exports, and cross-filterable bar charts
- Fixed the CITES trade map to color countries by dominant trade role rather than mere importer/exporter presence

## [v2.12.0] — 2026-06-12 – 2026-06-15 — Catalogue of Life Integration & Agent Access

- Ingested the Catalogue of Life backbone: surfaced the full described-species universe in New Assessments with an IUCN↔CoL toggle
- Extended search and synonym resolution to cover the full CoL universe, including CoL-only and retired-name species
- Added a Protected Areas (WDPA) overlay toggle to the occurrence map
- Added a CoL described-year field, filter chart, and table column for Not Evaluated species
- Restored iNaturalist observations for species with no GBIF backbone match
- Demoted spurious Catalogue of Life Extended Release taxonomic over-splits via a curated-checklist overlay
- Split "Other Invertebrates" into phylum-based browse sub-groups
- Rebuilt the /browse endpoint and llms.txt, and added a remote MCP server (/api/mcp, now public) for agent data access

## [v2.11.0] — 2026-06-10 – 2026-06-11 — DuckDB/Parquet Read Layer Migration

- Removed the orphaned criteria-estimation feature and corrected README/env drift
- Restructured taxa groups to common-name IDs and split Insecta into 8 order-based groups, in prep for Catalogue of Life ingestion
- Migrated the species read layer onto DuckDB/Parquet on R2, enabling arbitrary-rank taxonomic filtering (e.g. by family)
- Cut v2 cold-start and history-join latency; lazy-loaded assessment history (−40% species-list payload)
- Moved cross-taxa search onto DuckDB, retiring the 95MB in-memory JSON search index
- Collapsed /api/v2 into /api/redlist and removed the dead CSV species path

## [v2.10.0] — 2026-05-04 – 2026-05-26 — Data Refreshes & R2 Migration

- Refreshed GBIF occurrence data (May 4 and May 18 syncs)
- Reduced default occurrence map sample size from 1000 to 300 for faster loads
- Separated CITES country reservations from actual appendix listing changes
- Migrated the data sync pipeline from committed CSVs to Cloudflare R2 storage, enabling the repo to go public

## [v2.9.0] — 2026-04-21 – 2026-04-30 — Filter & View Fixes

- Defaulted preserved-specimen occurrences on for plants and fungi, where herbarium records are core assessment evidence
- Made filter chart bars clickable across their whole row, not just the bar itself
- Fixed filters that narrowed results to one species from incorrectly triggering the single-species detail view

## [v2.8.0] — 2026-04-08 — Chart & Taxonomy Refinements

- Added a Range/Year toggle to the Years Since Assessed chart, with year-based filtering and URL sync
- Hid the CSV download button as a precaution against commercial bulk-downloading of Red List data
- Matched IUCN scientific-name synonyms during sync to fix recently-reclassified species showing as unassessed
- Removed colloquial taxonomy groupings (e.g. "Insectivores", "Whales & Dolphins") in favor of monophyletic clades with real described-species estimates

## [v2.7.0] — 2026-04-03 – 2026-04-06 — Map Colors & Linting

- Refined occurrence map color scale to continuous hue gradient
- Default to before/after assessment date coloring with 50km GPS uncertainty filter
- Added ESLint rules for unused imports/variables and fixed all lint errors
- Fixed filter chart flashing and years-since-assessed calculation

## [v2.6.0] — 2026-04-02 — MapLibre & Single Species View

- Migrated occurrence map from react-leaflet to MapLibre GL JS
- Added single-species info card with profile pic, assessors, and key metrics
- Lazy-load API tabs and warm-start search API on page load
- Narrowed dashboard layout and added before/after date toggle on map legend

## [v2.5.0] — 2026-03-27 – 2026-04-01 — Search & Map Improvements

- Added cross-taxa species search bar with client-side search index
- Added color-by-date view for GBIF occurrence map
- Increased default GBIF sample size from 300 to 1000
- Added footer data source attributions
- Fixed split view animations, tooltip clipping, and mobile skeleton layout

## [v2.4.0] — 2026-03-24 – 2026-03-27 — Mobile UX, Filters & New Fields

- Improved mobile dashboard UX with responsive viewport and fixed table/tab overflow
- Added CSV export for filtered species list
- Added 7 new Red List fields: systems, growth forms, movement patterns, possibly extinct, criteria, threats
- Added More Filters section with realm, threats, population trend, movement patterns, growth form, and range map
- Added region filter dropdown on country map
- Renamed Red List tab to IUCN Red List and reordered detail tabs
- Fixed invertebrate double-counting and region dropdown selection bug
- Updated 'Fungi' label to 'Fungi & Protists'

## [v2.3.0] — 2026-03-18 – 2026-03-23 — Taxonomy Tree & Suggested Assessors

- Redesigned taxonomy system: unified tree with recursive drill-down, icons, and precomputed summaries
- Added Suggested Assessors tab with ranked table filtered by selected taxa
- Redesigned species detail panel layout and combined assessed/outdated/unassessed columns
- Persisted view mode, species selection, and detail tab in URL params
- Added legal attribution notices and switched PostHog to cookieless tracking
- Scaled down desktop layout on mobile with single-column charts
- Fixed CITES errors for synonym species and null quotas, detail row width issues
- Excluded domesticated species from new assessments
- Added column dividers, footer with attribution, and Vercel Speed Insights

## [v2.2.0] — 2026-03-15 – 2026-03-18 — CI, Monitoring & Data Updates

- Added CI workflows: TypeScript type checking and test runner
- Added Sentry error monitoring, tracing, and logging
- Added top iNaturalist observers/identifiers chart below occurrence map
- Optimized GBIF country fetching with kingdom-level query strategy
- Unified Red List and New Assessments into single component
- Added unassessed species columns (# and %) to taxa summary
- Updated taxa filters for 2025-2 Red List database

## [v2.1.0] — 2026-03-13 – 2026-03-14 — Taxa Drilldown & New Assessments

- Added progressive drill-down subgroups in taxa summary table
- Added assessor/reviewer filter chart with search and toggle
- Added Wikipedia tab to species detail view
- Added world map zoom/pan controls and country search (50m TopoJSON)
- Added New Assessments view for browsing unassessed GBIF species
- Added PostHog analytics in cookieless mode
- Added Claude PR Assistant GitHub Action

## [v2.0.0] — 2026-03-06 – 2026-03-12 — Data Pipeline & Static Files

- Built end-to-end data sync pipeline (fetch Red List → GBIF match → new counts → load)
- Explored Supabase migration, then reverted to static per-taxon CSV files
- Added per-taxon assessment history with assessors and reviewers
- Added diff-based sync with dry-run JSONL logging
- Prefetch all species data on page load for instant taxa switching
- Removed all Supabase dependencies

## [v1.9.0] — 2026-03-01 – 2026-03-05 — Assessment Assistant & Rich Maps

- Added Assessment Assistant section with criteria subtabs
- Added AOO method selector (GBIF Records / EOO×Prevalence)
- Added dynamic cross-filtering between all four charts
- Redesigned occurrence map: full-width with horizontal filter bar
- Added basemap toggle, animated time slider, marker shapes, and hover tooltips
- Added split map view comparing occurrences before/after assessment date
- Added Vercel Web Analytics
- Added Cache-Control headers on all API routes

## [v1.8.0] — 2026-02-27 – 2026-02-28 — Assessment Tools & Testing

- Added test suite with 64 unit tests (Vitest)
- Added threat prioritization scoring across 3 dimensions
- Added advanced GBIF occurrence filters: uncertainty, year range, dedup, sample size
- Added observation signal analysis with effort normalization
- Added IUCN Criterion B parameter estimation (EOO/AOO from GBIF data)
- Added interactive map for Criterion B sense-checking
- Enhanced CITES tab with interactive filters and line chart

## [v1.7.0] — 2026-02-26 — Dashboard Overhaul

- Added GBIF summary columns to taxa summary table
- Added 2x2 chart grid layout with filter hints
- Added focus toggle for column visibility
- Removed countries dropdown and starred import/export
- Fixed slow filter chart loading (10s → instant)
- Added default sort by newGbif column

## [v1.6.0] — 2026-02-17 – 2026-02-19 — CITES Integration

- Added CITES trade data tab in species detail view
- Added trade flows map with curved arcs and click-to-filter
- Added trade summary with country names, quantities, and importers
- Added CITES suspension overlay and dark mode support
- Added IUCN Red List citation footer
- Switched to local Geist fonts for offline builds

## [v1.5.0] — 2026-02-15 — Sorting & NE Fixes

- Added sortable "New GBIF" column (observations since last assessment)
- Improved OpenAlex search with name variants
- Unified table layout for NE and assessed species
- Fixed NE species endpoint for "all" taxon view

## [v1.4.0] — 2026-02-12 – 2026-02-13 — Redesigned Main Page

- Redesigned to single-page layout with multi-select taxa filtering
- Added iNaturalist audio observation support
- Added category breakdown bar column in taxa summary
- Added URL param sync for shareable/bookmarkable links
- Added hover interaction between iNat thumbnails and occurrence map
- Supported Cmd/Ctrl+Click for multi-select taxa filtering

## [v1.3.0] — 2026-02-09 – 2026-02-11 — Tabbed Species Detail

- Added tabbed view for species details (GBIF + iNaturalist / Literature)
- Added Red List Assessments tab with key metrics (EOO, AOO, population)
- Integrated IUCN Red List API for full assessment history
- Added stacked/tabbed layout toggle
- Renamed dashboard to "IUCN Red List Dashboard"

## [v1.2.0] — 2026-02-08 — Unified Dashboard

- Merged GBIF features into Red List tab and removed separate GBIF tab
- Added common name search functionality
- Added Not Evaluated (NE) species toggle with on-demand loading
- Added observation type checkboxes with paginated iNat photos
- Removed experiments, flora explorer, and downloader code

## [v1.1.0] — 2026-02-04 – 2026-02-07 — Performance & Mobile

- Added SWR caching and parallel fetches for performance
- Made Red List dashboard mobile-responsive
- Added sticky columns with horizontal scroll
- Added auto-zoom for GBIF occurrence maps to fit data bounding box

## [v1.0.0] — 2026-01-22 – 2026-01-27 — Major Redesign

- Redesigned TaxaSummary with clickable All Species row
- Added literature section with collapsible abstracts (OpenAlex)
- Added favourite/starred species with drag-and-drop reordering
- Added country filter dropdown with map visualization
- Added export/import for starred species
- Excluded preserved specimens from GBIF counts

## [v0.6.0] — 2025-12-15 — Polish & Match Status

- Added GBIF match status indicator with instant hover tooltip
- Renamed project to "Red List Dashboard"
- Various UX improvements to tooltips and column headers

## [v0.5.0] — 2025-12-10 – 2025-12-12 — Rich Species Detail

- Added iNaturalist observation image preview on hover
- Added multi-select filters for category, year, and country
- Added GBIF occurrence breakdown with clickable links
- Added species image column and occurrence map expansion
- Added inline GBIF breakdown and iNat photos in expanded rows

## [v0.4.0] — 2025-12-08 – 2025-12-09 — Red List Dashboard

- Added IUCN Red List statistics tab with species browser
- Added multi-taxa support (Birds, Mammals, Reptiles, Fishes, etc.)
- Added dark/light mode toggle
- Added taxa summary table with % assessed/outdated metrics
- Added combined taxa support (Fishes, Invertebrates, Fungi)

## [v0.3.0] — 2025-12-04 — World Map & Redesign

- Added interactive world map for country-based species exploration
- Added occurrence heatmap with cream-to-red color scale
- Redesigned homepage with side-by-side map and distribution
- Added navigation header

## [v0.2.0] — 2025-12-02 — Species Classifier & Experiments

- Added species classifier module with Tessera cache
- Added experiment page comparing similarity vs classifier methods
- Added location-based predictions with pre-trained models
- Added local prediction heatmaps with uncertainty estimation

## [v0.1.0] — 2025-11-28 — Initial Release

- GBIF plant species data explorer
- Distribution visualizations and charts
- Species search, images, and common names
- Global/Cambridge region toggle with occurrence maps
