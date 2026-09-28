# Changelog

All notable changes to the IUCN Red List Assessments Dashboard.

## [Unreleased]

- Added a **GPS uncertainty** toggle to the occurrence map's tools, under "Measure a distance", drawing each record's stated `coordinateUncertaintyInMeters` as a dashed circle on the ground at its true scale. The figure was already in the record panel and in a filter, which is enough to read one record at a time and no use for the question it's actually asked for: forest elephants apparently swimming in the ocean off Gabon, whose records carry a 35 km radius that reaches the coast from well inland. Off by default — a few thousand overlapping rings is noise when you're reading a distribution, and the whole answer when you're weighing a single point. Under the toggle it says how many of the drawn records state a radius at all, because a point with no ring isn't a precise one, it's one whose precision nobody recorded; a radius over 500 km gets no ring and is counted there instead, since a circle spanning a continent is a shape over the whole map rather than a fact about one record

## [v2.24.0] — 2026-09-10 – 2026-09-16 — Realm View, Near Me & Occurrence Sampling

- Added a **Realm view** — a fourth View option beside By Country, with a three-bar Terrestrial / Freshwater / Marine chart over the same taxa table Country view scopes, so picking a realm narrows the tree in place instead of sending you to More Filters. The bars are the selector as well as the comparison: length answers "how much of the Red List is marine" at a glance, where three separate numbers leave the reader to do the division. It writes the ordinary `systems` filter rather than a view-private one, so the narrowing survives leaving the view and composes with a country — `?country=ID&realm=Marine` is marine species *in* Indonesia, not the union. The described-species and observation columns are hidden here, because realm is recorded on the *assessment*: species not yet assessed have no realm even in principle. A species assessed in two realms counts in both, so the shares sum to more than 100%
- Added a filter box to the SSC groups view — 92 specialist groups is more than anyone scrolls through to check one, and "sponge" now finds the Sponge Specialist Group. Filtering happens before the render, so each section's subtotals describe exactly the rows on screen rather than quietly totalling the unfiltered set
- Added a "Breakdown look wrong? Suggest a correction" link under the Catalogue of Life source line in the # Described Species popover. It opens GitHub's new-issue form with the breakdown already written out as a table under **Currently** and a blank **We believe it should be** section to fill in — a prefilled link rather than an API call, so there's no token and nothing to spam, and the reporter edits and submits it on GitHub themselves
- Added **/near-me** — threatened species near a place, without picking a species first. The nearby-species search from v2.23.0 could only be reached from inside one species' occurrence map: you had to know a species, open its map, find a record and right-click it. That's the right doorway for an assessor working a taxon and the wrong one for the question most people arrive with, which names a place and no species at all. Reached from the View selector as "Near a Location (map)", it opens on an empty map and searches nothing until the button is pressed — the point comes from place search, a click on the map, a pasted coordinate pair or the browser's own location, the radius toggles between 1 / 2 / 5 / 10 / 25 / 50 / 100 km or by dragging the ring on the ground, and three scopes (Threatened, Assessed, All species) ride in the URL alongside `?lat=&lng=&r=`, so a search can be sent to someone
- Added searching inside a **protected area** rather than a circle: clicking the WDPA overlay lists every designation at that point and offers "find threatened species in here" for each, sending GBIF the real boundary. Three things stand between a WDPA boundary and a query GBIF accepts, and all three fail confusingly — GBIF reads a clockwise exterior ring as the entire rest of the planet without complaining (34,183 records one way against 1,195,439 the other) and Esri writes WDPA that way round; the limit is URL length, ~3,860 bytes, not vertex count; and simplification cheerfully produces self-intersections and holes outside their shell that GBIF refuses. Simplification is validity-aware, and the geometry drawn on the map is the exact geometry that was sent
- Reworked the occurrence viewer's sample into **one budget of 300 records, trusted ones first**. The route paged the flagged and unflagged sets under separate limits, so a "300-record sample" was two queries and up to 600 records; they're one list under one limit now, so a species with thousands of good records never spends its sample on a suspect one and a species with a handful still gets its budget filled. Two things had to be fixed for that ordering to hold: `GBIF_GEOSPATIAL_ISSUES` held two codes that don't actually make `hasGeospatialIssue` true — `GEODETIC_DATUM_INVALID` and `COORDINATE_REPROJECTION_SUSPICIOUS`, checked against the live API per code rather than read off the docs — so nine of the cheetah's records came back from the *trusted* query and were then painted amber and hidden by a check nobody aimed at them; and the flagged-record count now retries like every other GBIF query, since swallowing a throttled request as zero said the fur seal had no flagged records at all, which is a wrong answer that looks exactly like a right one
- Simplified the occurrence map's counts line to the records the map can actually draw — "Loaded 300 of 8,916 GBIF records with coordinates" — and moved the paging of coordinate-less records into the record list's own footer, which is the only place those records are ever read
- Removed PostHog session recording, and the entire consent apparatus that existed only to support it: the prompt, the toggle, the API endpoint and the Supabase table. Replay was the one thing in the app that stored an identifier on the device and tied what happened on screen to an account. Anonymous, cookieless analytics are unchanged
- Fixed the "Tree cover loss by dominant driver" overlay drawing nothing in production. Its tile URL was two template literals joined with `+`, and Turbopack's minifier folds that whole expression into one string — dropping the middle segment as it does so. The bug existed only in the production bundle; dev and the test suite both passed. Its layer order and legend bounds were wrong too, and are fixed here
- Fixed the weekly sync failing on a bare 404 when Catalogue of Life names a new release days before its ColDP archive has been built — the fetch steps back a release instead of failing the run
- Fixed `search_result_selected` and `search_no_results` recording the base URL in PostHog. Both fire before the SPA writes the new URL, so the auto-captured `$current_url` never carried the search term
- Refreshed the GBIF/CoL data sync

## [v2.23.0] — 2026-09-05 – 2026-09-09 — Nearby Species, Narrative Search & Literature Timeline

- Added **nearby threatened species** — *what else is threatened around here, and what did its assessors decide was threatening it?* — asked of a record, of any point on the map (right-click, or a held finger on a phone), or of where you're standing. It lists the CR, EN and VU species GBIF holds records for inside a radius, opening at 10 km, with what their assessments blame beside them. A threat is rarely private to a taxon: the plantation, the dam or the road that put the neighbours on the list is very often the same pressure acting on the species being written up — a prompt to go and check a pressure you hadn't written down, not a finding
- Each nearby search takes a tab of its own, named for where it was asked, with its own radius and its own drawn neighbours, because the comparison people arrive with is *this record* against *that proposed site a valley away*. Every question stays pinned on the map, four at once before the oldest makes way, and open searches ride into the fullscreen map and back in a `near=` param. Taxon, category and threat filters sit in the panel header, each taking several answers and each built from what actually came back, with counts, so a filter is never offered that would empty the table. Threats are **named** rather than coded — *Agriculture*, *Pollution*, *Climate change* — rolled up to the twelve top-level categories with the sub-codes that rolled into each on hover. A row opens that species' assessment (threats first, then rationale, range, habitat, use & trade and actions) and draws its records on the map in its own colour
- Added **narrative search** — a search across what the assessors actually wrote, the other half of the ask the nearby-species work answered spatially. A view of its own from the home page's View selector, the way Comparison Mode is, answering *who mentions this, across everything* in sentences rather than rows. It searches all 175,910 current global assessments — ~470 MB of prose the sync had never touched — over a purpose-built term index, published once per Red List release rather than once per weekly sync, since the prose changes when the Red List publishes twice a year and a sync runs fifty times
- Reworked the Literature tab into **one chronological timeline**, newest first, ten to a page, with a dotted line at the last assessment date. It was two lists behind a Pre-assessment / Post-assessment toggle, so answering the question the tab exists for — what has appeared since we last looked? — meant switching modes and holding both halves in your head; the split is now a position in the list rather than a mode you have to be in. It also merges six sources instead of OpenAlex alone: OpenAlex, Zenodo, the Red List assessment's own reference list, the Biodiversity Heritage Library, CORE and Google Books — between them reaching NGO and project reports, theses, scanned protologues and 19th-century floras, and printed field guides and Red Data Books. Each row names the sources it was merged from
- Opened the occurrence map on every basis of record but living and fossil specimens, with no coordinate cleaning applied, for **every kingdom**. The defaults used to split by kingdom: plants and fungi opened with everything and no cleaning, while everything else opened with preserved specimens, literature citations and bare "occurrence" records off, plus three cleaning filters already trimming points. A museum skin, a herbarium sheet and a literature record are evidence of where a species was regardless of its kingdom, and a default that quietly drops them hides the very evidence an assessment gets written from. The two that stay off are the ones that say where an individual *ended up* rather than where the species lives. The cleaning checks are plausibility heuristics with real false-positive rates, so the map opens on everything GBIF holds and trimming is opt-in from there
- Linked Sentry issues to PostHog people, so an error report carries the session it came from — deliberately, rather than recording the browser console, which `posthog-js` offers only as an all-or-nothing boolean that would have swept up every `.catch(console.error)` on endpoints carrying real assessors' and reviewers' names
- Added consent-gated PostHog session recording for signed-in users, stored in a Supabase table rather than `localStorage` so it follows the account and stays demonstrable after the fact (removed again in v2.24.0)
- Fixed the stuck "Loading species-level detail…" tooltip on every live-drilldown row's # Described Species popover. It was not slowness: the endpoint had been returning 500 since 2026-08-27, and the UI hid that behind a spinner that never resolved. The query asked `backbone.parquet` for the CoL-rename columns that production's backbone — and every local checkout — doesn't carry yet
- Fixed clicking a different taxa row keeping the previous species' `search=` and `species=` params, so the group you clicked came up filtered down to a species that isn't even in it, with that species' detail panel still open below and the searched name still in the filter box
- Fixed the Country filter chart's List mode nearly doubling the card's height and pushing the row below it down the page, and ellipsing its three numeric headers into `# Needs U…` beside `% Needs …`. The list now renders into the box the map would have occupied and pages at whatever that box actually holds

## [v2.22.0] — 2026-08-31 – 2026-09-03 — Occurrence Mapping Tool, Suggested Experts & Search Speed

- Added a **mapping tool for assessors** at `/mapping/<gbif key>` — the map beside the record list on a page of its own, where GBIF's records get turned into an IUCN point file. An assessment has to say where a species has been found and GBIF's records are the raw material, but a dot on a map can't be read, corrected or vouched for: this is the page where the judgements get made (this one is a duplicate, this one is cultivated, this locality means *here*), against the evidence they're made from. It's built around plants — Kew's POWO for native range, herbarium sheets counted as records — but it's keyed on a GBIF species key, so nothing in it is plant-only. Three tabbed lists (GBIF's records, an imported point file's own rows, and the records you've set aside, that tab leading with the reason and carrying the way back), all 77 Darwin Core fields behind a column picker that shows, hides and reorders them, and your sort order remembered
- **Records the occurrence map could never show are now fetched.** `/api/occurrences` had always asked GBIF for `hasCoordinate=true&hasGeospatialIssue=false`, so records with no coordinates and records GBIF flags were never requested at all. For a well-collected species that's a rounding error; for a poorly-collected one it's most of what's known. *Dioscorea biplicata* has 58 GBIF records — 27 clean, 1 flagged and **30 with no coordinates** — and the viewer showed 27. The 30 are herbarium sheets whose locality text was never georeferenced, one of them putting the species outside both countries on file
- Added a record panel that stays open where you put it and resizes from any of eight edges, with the record's marks in its header: a flag for the cleaning checks it trips or the native range it falls outside — named for the source that called it, since POWO and IUCN are different lists of countries and can disagree — a star for a type specimen, and a camera where the publisher attached a photograph, which opens the sheet beside the panel. Long localities are truncated with the whole string in a hover bubble you can reach and select text out of, since what's in it is what you paste into a georeferencing note, and a button opens it in Google Translate — the label is written in the language of whoever collected the specimen
- Added **Suggested Facilitators** and merged the Suggested Assessors and Suggested Reviewers tabs into a single **Suggested Experts** tab with an Assessors / Reviewers / Facilitators toggle, matching the filter chart's. Facilitators are the individuals behind an organisational assessor — every bird assessment is credited to "BirdLife International", so for those groups it's the only credit line that names a person, and the ranking now reaches them. The credit line you pick is remembered between sessions, and links naming the old tabs (`?tab=assessors`, `?tab=reviewers`) still open the merged tab on the role they asked for
- Reworked Suggested Assessors and Suggested Reviewers around the species' own lineage, with a granularity picker: the two count columns now re-scope between the whole taxon group, the species' class, order, family and genus, so you can go from "who assesses mammals in Southern Africa" to "who has actually worked on a vlei rat" in one click. The tab opens on the finest level that still has enough people to compare, ranks with nothing recorded for the species are left out, and clicking a row opens the dashboard filtered to that person at the level on screen. This also fixes both tabs coming up empty for any drilled-in taxon — live taxonomic drilldown had made the selection an id the static taxonomy tree has no node for, and the old query treated it as a taxon-group name and matched nothing; scope now comes from the species rather than the selection, so where you drilled in from no longer affects the answer. "Last Assessment" now reports when that person last worked on a species in scope, rather than the species' own latest assessment date
- Added facilitators as a third credit line on the species detail panel's IUCN Red List Assessments tab, beside assessors and reviewers. The per-assessment history the tab already loads had carried them all along; they were never passed into the panel
- Added **contributors and institutions** filters, completing the five SIS credit types — assessors, reviewers, contributors, facilitators and institutions. The credit chart's three-way segmented toggle becomes a dropdown, since five modes no longer fit beside the search box, and both new credits appear as removable pills above the table and on the assessments tab. Institutions need their own parser: the assessor parser splits on `", "`, which turns "Royal Botanic Gardens, Kew" into two institutions that don't exist, while the credit line is an ordinary English list where the comma really does separate. The chart also now builds only the credit type on screen instead of all of them eagerly, so five types cost *less* than the three it used to
- Added genus to the search bar and to `taxa=`. Typing a genus now offers "Browse *Panthera*" alongside the family/order/class suggestions and lands on the genus node in the taxa table (All Species → Mammals → Carnivora → Felidae → Panthera), the same place drilling down the tree reaches; `?taxa=panthera` — in the dashboard, /browse and MCP — resolves too, where before it matched nothing and came back empty. The genus tier is capped at one suggestion whenever a higher rank also matches, so "urs" still leads with Ursidae and "chi" with Chiroptera rather than a run of short genus names
- Added a scope option to the Threats chart, defaulting to **Threatened only** (CR, EN, VU). IUCN's feedback is that threat coding on non-threatened assessments isn't reliable, so the bars, drill-down pills and percentages now count threatened species by default, and picking a threat filters to threatened species too — the bar's count is exactly what clicking it selects. "All species" in the card's dropdown restores the old behaviour (and is what /browse and MCP dashboard links carry, so those keep reproducing the species set they were generated from)
- **Made the search bar fast.** Any uncached query took ~2.2s, and the first no-match on a fresh container 13.7s, both measured against production. None of it was cold start and none of it was the client: DuckDB was re-reading ~25 MB of Parquet name columns on every keystroke, because the species Parquets are written in browse order, so no name predicate can prune a row group however it's phrased. The search index is now built once per container rather than once per keystroke, and a new name-sorted index lets a prefix prune instead of scan — about a megabyte read per query. Taxon suggestions get the same treatment, which also fixed them being nondeterministic: the genus `×` exists in both mosses and flowering plants, and two identical searches could offer to browse it in different taxa
- Fitted the Years Since Assessed card's header onto one row — the Needs Updating button and the Range/Year selector were wrapping below the title. The selector now draws its own chevron instead of the browser's (a native select reserves width for the platform arrow that padding can't reclaim), and both controls sit slightly tighter
- Collapsed the new-assessments view's Year Described and GBIF Records charts to a single-value card when one species is searched, the way the assessed view's charts already do, so a searched Not Evaluated species reads like a searched assessed one — Year Described showing the year itself rather than its bucket. Pending counts in the taxa table now show the spinner the row already uses instead of pulsing skeleton blocks, and the species table's headers match the taxa summary table above it, so the page reads as one system
- Relabelled the years chart's outdated shortcut to "10+ yrs old" and matched the Needs Updating column's qualifier to it. The threshold itself is unchanged
- Made the ⚑ Catalogue of Life difference marker **opt-in** — it now appears only while the Taxonomic differences card is actually filtering. It answers a question the reader has to have asked, and on the unfiltered table it was answering it unprompted, putting a caveat about a second checklist beside names in a list that's otherwise about assessments
- Hid the Wikipedia tab from the species detail panel, behind the same flag pattern as the Encyclopedia of Life tab. `?tab=wikipedia` links fall back to the GBIF tab rather than stranding on a tab with no button in the bar

## [v2.21.0] — 2026-08-20 – 2026-08-28 — Credit Filters, Chart Drag-Select & Catalogue of Life Differences

- Added a **Facilitator filter** alongside Assessors and Reviewers. BirdLife International is the credited assessor on all 11,185 bird assessments, so the assessor filter can't pick out the work of any one person on their team — the individual's name goes in as a Facilitator. Requested by BirdLife's Red List Team, who hit exactly this wall using the dashboard, and worth well beyond them: facilitator coverage is 100% on birds, 99.4% on amphibians and 90.5% on corals
- Added multi-select regions, a secondary sort, year-range inputs and remembered view toggles — the rest of BirdLife's filter asks. The region control was a native single-value select, so "North *and* South America at once" was genuinely impossible; it's now a checkbox popover that unions the ticked regions' countries into the same selection an individual country click writes, and two whole regions read as two pills instead of the nineteen country pills they expand to. Shift or Cmd/Ctrl+click a second column header to sort within the first. `minAssessmentYear`/`maxAssessmentYear` already existed as URL-only params and now have from/to inputs in the Year view. The Range/Year toggle, the credit chart tab and the country card's Map/List persist to `localStorage` — strictly display state, since filters stay in the URL and an explicit URL value always wins, so a shared link renders the same for whoever opens it
- Added Shift+drag range selection to the filter charts — drag across Conservation Status, Years Since Assessed, Year of Latest Assessment, GBIF Records, Year Described, Number of Assessments or the Assessors/Reviewers/Facilitators chart to select every bar swept over, holding Cmd/Ctrl to add to the existing selection rather than replace it
- Added a **Taxonomic differences from Catalogue of Life** card to the main dashboard. The SSC group view already answered "which assessed species have no clean 1:1 CoL match, and why", but that diagnostic is computed per breakdown name, so it only existed for the static tree's nodes — the primary dashboard, which filters an arbitrary species set, had no way to see or filter on it. Two independent signals feed the card: species with no clean 1:1 match, and species CoL has carved *out* of an assessed one, which carried no flag at all before because their own match is clean
- Added a fifth signal to that card: **species Catalogue of Life accepts under a different name**. The original four bars were all *scope* signals — split, lumped, rank, no match — and never said the most literal taxonomic difference of all. It's measured against CoL's curated release rather than inferred from a failed match, which is exactly why nothing already on the card caught 7,915 of them, and it's the one an assessor can act on most directly: *CoL accepts* **Sibirenauta elongata**; *this assessment is filed under* **Aplexa elongata**
- Slimmed the species detail panel's Red List tab down to the assessment narratives and renamed it **IUCN Red List Assessments**. The Habitats / Threats / Conservation Actions code lists and the EOO/AOO/population/elevation parameter strip are gone, and the narratives are capped at 200 words in total (not per section — the text stops where the budget runs out) with a link to read the rest — the IUCN Red List page the tab already links to is the place for the full assessment
- Renamed the user-facing "Outdated" wording for 10+ year old assessments to **"Needs Updating"**, across the dashboard, the agent-facing /browse and llms.txt surfaces, and the README. "Outdated" reads as a judgement on the assessment; "needs updating" describes the action it implies
- Fixed HTML entities showing through as literal text in assessment narratives — *Sorbus lancastriensis*' population section read "known&#160;from 46 sites". The old decoder unescaped five hand-picked named entities and no numeric ones, and `&#160;` is most of what the IUCN API actually emits
- Fixed six classes of country problem on the world map, all found chasing "should French Guiana be South America rather than Europe?" — it should, and both region tables already said so; the map was the only thing that disagreed. Nine territories were drawn inside another country's shape and attributed to it (16,000+ assessed species, five of them shown as Europe), four countries sat in no IUCN region at all so no region filter reached them, country search couldn't reach any country without a shape (~2,700 assessed species), and nine countries displayed the shape file's abbreviation as their name
- Fixed two Red List names that Catalogue of Life spells differently being reported as having no CoL match at all: *Ochotona pallasii* against CoL's *Ochotona pallasi*, one letter apart on the `-ii`/`-i` patronymic, and *Sminthopsis fuliginosa* against *fuliginosus*, an `-a`/`-us` gender-agreement variant. The second cost twice over — the assessment went unmatched *and* its accepted species kept counting as an unassessed CoL species
- Fixed 124 of the 369 unmatched Red List names being asserted as "CoL holds no record of this name, at any status, in any release" while the species' own `gbif_species_key` held the CoL id. Since GBIF's occurrence index is built on Catalogue of Life, that key *is* a col_id — *Colostygia puengeleri* had been matched to CoL's *Colostygia pungeleri* all along. Names CoL genuinely has no record of, like *Agrotis sabine*, stay unmatched; the key is a corroborating signal, never a shortcut on its own

## [v2.20.0] — 2026-07-31 – 2026-08-17 — Catalogue of Life Pipeline Migration & Search Fixes

- **Migrated the GBIF pipeline onto the Catalogue of Life.** GBIF relaunched gbif.org on 18 June 2026 with the Catalogue of Life Extended Release as its default taxonomy; the GBIF Backbone this pipeline was built on was last updated in 2023 and will not be updated again. The migration also surfaced a live data-integrity defect, which turned out to be the more important half: where a taxonomy treats one assessed species as a synonym of another, the first claims the second's key and the second is left with **nothing** — there are no shared keys, because the conflict is resolved by starving the loser, and which one starves depended on Red List row order rather than on taxonomy. 2,350 assessed species were affected, 129 of them Critically Endangered, each showing no GBIF occurrence data at all
- Fixed GBIF counts for plants and fungi excluding preserved specimens. Herbarium and fungarium sheets are the primary — often the only — georeferenced record of a plant or fungus, so counting field observations alone showed *Parkinsonia peruviana* (CR) as having 1 record when it has 31. The sync now counts preserved specimens for Plantae, Fungi and Chromista, matching what the occurrence map has defaulted to for those kingdoms all along; animals are unchanged
- Fixed a name GBIF can only place once it's told who published it. *Colostygia puengeleri* (EN) is spelled *pungeleri* in Catalogue of Life; asked for the name, GBIF answers with the genus and the moth shows no occurrence data. The authorship has to be its own request parameter — inside the name string it does nothing, despite the endpoint documenting that the name "may include the authorship and year"
- Fixed searching for a not-evaluated insect going nowhere. *Pararge aegeria* landed on `taxa=invertebrates`, which has ~1.3M not-evaluated species — far over the view's cap, so it could only render the drill-down prompt, and the species never appeared. The same lookup silently mis-resolved two more groups onto Specialist Groups: an NE ladybird opened the Dung Beetle SG and found 0 species
- Made every search result land on the species' own **family** rather than the bare top-level taxon, so the taxa table renders its whole lineage. *Panthera leo* now opens on All Species → Mammals → Carnivora → Felidae, where it used to open on All Species → Mammals
- Fixed Not Evaluated species selected from the search bar never opening their detail panel. A row was identified by a number whose sign carried its meaning — positive a SIS taxon id, negative a hash of the CoL id — and the negative case had *two different hash functions* behind it, so one species had two different ids depending on which query produced the row. Row keys are strings now, namespaced by the identity the species actually has. The bug was total for the ~1.8M NE species and silent for everything else, which is why it stayed invisible
- Added percentages to every filter chart's bar labels and drill-down pills, rounded to the nearest integer. Where an assessment can list several values — criteria, habitats, assessors, reviewers — the denominator is the in-view species that *have* that data, so those percentages are expected to sum to more than 100%
- Shortened the taxa URL token to what isn't recoverable elsewhere: `?taxa=pl-flowering_plants~order:dioscoreales~family:dioscoreaceae` is now `?taxa=flowering_plants~dioscoreales~dioscoreaceae`
- Fixed breakdown narrowing silently dropping on live-drilldown rows — clicking a row in a dynamic node's # Described Species popover landed on the full node list instead of the row you clicked, with no error, just more species than you asked for. `bd=<nodeId>:<rank>:<name>` was split left to right, and a live-drilldown node id is itself `mammals~order:rodentia`
- Removed the auto-scroll that fired whenever the focused taxon changed. The row's own selection state and breadcrumb already carry which taxon you're looking at, so the jump was unnecessary and jarring when clicking rows further down the page
- Hid the Encyclopedia of Life tab from the species detail panel, behind a flag that restores it, and took EoL off the footer's data-source list — with the tab hidden no EoL data is shown anywhere, so crediting it would be inaccurate. `?tab=eol` links fall back to the GBIF tab rather than stranding on a tab with no button in the bar
- Refreshed the GBIF/CoL data sync twice

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
