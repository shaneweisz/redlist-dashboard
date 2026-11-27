# Changelog

All notable changes to the IUCN Red List Assessments Dashboard.

## [Unreleased]

## [v2.29.0] — 2026-11-17 – 2026-11-27 — Triage Sidebar, GBIF Matching Spec & Literature Counts

- Moved **Reassessment Triage** into a sidebar of its own on wide screens (1400px and up). A slim rail beside the page opens into a sticky, full-height column next to the charts and species table, and it is on the home summary too, sized to the summary table's card. The page never shifts while the rail is collapsed, and every visit starts collapsed, with nothing saved in the browser. Below 1400px the chart stays as the last card in More Filters. **Awaiting 1st Assessment** gets its own **First Assessment Triage**: years since the species was described against total GBIF records, one colour because every dot is NE, so the top right reads "described long ago, plenty of records, still never assessed". Species with no year described can't be placed, so they are counted under the title (9,708 of 317,479 plants). The reassessment chart gains a dashed "Needs updating (10+ yrs)" line at the threshold the summary table uses, and plainer axis labels ("Years since last assessed"; "GBIF records: [New since assessment ▾] [all records ▾]"). Its legend filters by category, driving the page's Conservation Status selection. ⌘/Ctrl-drag adds a box and ⌘/Ctrl-click adds or removes a dot, and a "↓ table" link scrolls to the selection. Hovering a summary-table row or a legend entry previews which dots clicking it would show. On home, anything that filters moves the page to All Species, and clicking a dot opens that species in its own group. The selection rides in the URL (`tbox=`, `tadd=`/`tdel=`, plus the y axis as `ty=`/`tyn=`, since a box only means something on the axis it was drawn on). It is worked out from the boxes rather than stored as a species list, so a shared link keeps its meaning across a resync. A selection now resets the species table to page 1. Before, page 41 of 606 became an empty page 41 of 107. Leaving home for All Species used to freeze the page for about 5.8s, and now takes under a second
- Reworked **GBIF matching** around a written spec, `docs/specs/matching.md`, with a plain-language summary of what the dashboard counts. GBIF's matcher gives the CoL name where GBIF files a Red List species' records, and the rules alone decide what counts: there are no hand overrides of any kind. A match the rules are unsure of is flagged (⚑), not hidden, so a count still shows. A new **GBIF matching reconciliation** card in More Filters (`match=`) has a bar per kind of match and per doubt, under the question "Is the GBIF count the right records?", beside the CoL card, which now uses its own violet ≠. Once a bar is selected, every count that isn't one plain name gets a marker. Its tooltip lays out the Red List name and authority, the CoL records involved, and how many of the species' records each holds, linked to those records on GBIF. Two independent AI taxonomic reviewers answer for species in doubt, run outside the sync. They only flag: a review never moves a count, and the tooltip shows what each would count instead, with a link to its transcript (`/ai-review/<key>`). Where the Red List lumps what CoL splits, the count now takes the whole split, so 2,284 species rise by 8.8M records in all (*Butorides striata* +3.1M, as it includes *B. virescens*) and 408 fall by 130k. 2,739 species join the Not Evaluated list, among them *Pararge aegeria*, whose 3.5M records used to count for no one
- Added **Literature counts** to the Not Evaluated species table: **OpenAlex** and **BHL** columns under a Literature heading beside GBIF Records, each sortable. The assessed table is unchanged for now; the sync already counts papers published since each assessment, for a later version. OpenAlex counts papers whose title or abstract names the species; the Biodiversity Heritage Library counts the articles, or whole scanned volumes where BHL hasn't split out articles, whose pages its own name-finding confirmed the species on. The two are never summed: the same article is often in both, and a volume is not a paper. A name counts for whichever species owns it by the same rule GBIF records use, so a synonym CoL lists credits its species, and a name two species both hold credits neither. An OpenAlex number opens OpenAlex on exactly the works it counted (the newest 100 where there are more), rather than a search for the name, which no query can make agree: the count includes synonyms and abbreviated genera, and leaves out works a search would find. A paper OpenAlex holds as several records (a repository copy, a preprint and its journal version) counts once. A BHL number opens BHL's page for the name. Species GBIF has no records for yet get a count too: often the recent descriptions, which is where a paper count says most. The Literature tab in a Not Evaluated species' panel says what the table counts beside its own live list, since their totals differ. The CSV export gains OpenAlex Works and BHL Works columns. Counted in the monthly sync from a local, reduced copy of the OpenAlex works snapshot (read once per quarterly release, `npm run sync:openalex`) and BHL's monthly export. A bare name in a paper means the species CoL accepts under it, even where CoL also files another author's same-name synonym under a different species: that synonym used to make the name look ambiguous, which left *Pinus sylvestris* at 74 OpenAlex works rather than 18,202
- Reworked the **occurrence map** to load every CoL taxon a species' count includes, not just its one GBIF key. Where CoL splits a Red List species, the map showed only part of it: *Butorides striata* counts 3.4M records but drew only *B. striata*'s 287k. The record-type counts, the gbif.org occurrence link and nearby species now ask for the same taxa. In nearby species, *B. striata* now appears on the Mexican coast, where only *B. virescens* occurs. The iNaturalist photos stay on the one key, since a split's other species is another bird. Each dot gets a marker shape for the CoL name GBIF files it under, and a "Filed in CoL under" legend, shown only when there is more than one name, gives each name its shape, what it is, how many dots are drawn of GBIF's total, and a checkbox to hide it. Shapes are sized between equal area and equal reach, so a triangle doesn't look bigger than a circle. An optional context layer, off by default, draws in hollow grey what the count leaves out. That is the rest of the CoL species a name is only part of (the rest of *Pararge aegeria* beside *P. xiphioides*), or species CoL split from this one that are on the NE list (*G. giraffa*, *G. tippelskirchi* and *G. reticulata* beside *Giraffa camelopardalis*). Context records open the record panel with a "Not counted" note and only "Open on GBIF", and never enter the record list or the point file. The record panel gains a "Filed as" row for records filed under a synonym or subspecies
- The **Awaiting 1st Assessment** count's tooltip now says it is counted according to the taxonomy of the Catalogue of Life's June 2026 XR release (the month in words, from the release in use), rather than that it "could differ" under another
- Column tooltips now say which release each count is as of: GBIF's Total and the GBIF Records chart ("Counts as of GBIF's 1 November 2026 snapshot"), and the Not Evaluated table's OpenAlex (snapshot day; records with the same title counted once) and BHL (export month)
- Moved the **Country map and Assessors chart** out of More Filters and back onto the main page in the assessed view, as a row directly below Conservation Status / Years Since Assessed / GBIF Records. More Filters' "N active" badge no longer counts their selections, and it lists Realm / Movement / Trend before Assessment Criteria / Number of Assessments
- Made the **credit chart open on Facilitators for Birds**, because every bird assessment credits "BirdLife International" as its assessor, which made Assessors a single bar. Only the default swaps: an explicit Reviewers, Contributors or Institutions choice survives moving in and out of Birds. A bird species' Suggested Experts tab defaults to Facilitators too
- Made maps **show the world once** when zoomed out, edge to edge, instead of repeating continents two or three times sideways, with the minimum zoom recalculated to fit the map's width
- Fixed the assessed view's Country card loading skeleton sitting about 40px shorter than the Assessors chart beside it
- Changed the site's page description to "A dashboard for conservation of threatened species", matching the header subtitle
- Bumped Next.js from 16.4.4 to 16.4.6 (security and bug fixes)

## [v2.28.0] — 2026-11-07 – 2026-11-12 — Reassessment Triage, One CoL Release & Stricter Species Linking

- Added the **Reassessment Triage** scatter to More Filters, beside the Taxonomic differences from Catalogue of Life card. It puts one dot per assessed species, with years since its latest assessment across and its GBIF records up, so you can see in one place which species are overdue *and* have new evidence to reassess with. Until now that took the Years Since Assessed and GBIF Records charts plus a sort. The y-axis title is the picker ("[New ▾] GBIF records ([all ▾])"): Total and New use a log scale, and % New a linear 0–100% scale. Dots are coloured by Red List category, with threatened ones drawn on top. Both axes take their extent from the whole taxon, so a filter never rescales the chart and filtered views can be compared directly. Dragging a box filters the whole page through a new `priority` filter axis, and a tight box around one dot selects exactly that species. Hovering a dot shows its name, category, how long ago it was assessed and its Total / New / % new records. Clicking a dot turns the table to that species' row. The scatter draws on a canvas because All species is about 175k dots. It is hidden in the Awaiting 1st Assessment view and for a single species. The box selection is not yet saved in the URL (it is from v2.29.0)
- Made **years since assessment exact to the day everywhere**. A calendar-anniversary `yearsSince()` replaces the 365.25-day average year in the Years Since Assessed chart and its filter, the table's "(10y ago)", the scatter, and the server-side "Needs Updating" counts. The rule is unchanged: exactly 10 years ago today is not outdated, and the day before is
- Made each sync use **one Catalogue of Life release**: the XR that the GBIF snapshot is filed under, plus that XR's own curated release, never a newer one. Mixing releases had wrongly "demoted" species. Read against its own XR, the curated release demotes nothing, and the sync now stops if a demotion ever appears. As a result, the Not Evaluated list grew by 16,450 species (1,854,233 → 1,870,683): about 7,000 that a newer curated release had demoted, and groups like ScaleNet's scale insects, termites and webspinners that had failed the source check. The page footer now names each release: Red List 2026-1, GBIF snapshot of 1 November 2026, COL26.6 XR. Following CoL's newest release was tried and abandoned, because mapping older snapshot records onto it misfiled them without any sign (meadow foxtail's 581k records landed on *Alopecurus arundinaceus*). The cost is a taxonomy up to a few months behind CoL's newest
- Made the **live species panels follow GBIF when it re-indexes** onto a newer CoL release. On 10 November GBIF re-filed its records against COL26.10, and the American wigeon's 3.4M records moved from `3Y3C6` to `VJFB9`, so its map, photos and breakdown came up empty. The live routes now ask GBIF for records under both our id and the id GBIF's matcher gives our name in the newer release, but only when that answer really is our name: exact, or respelt by the same authors, never a fuzzy or genus-only answer. GBIF ORs repeated taxon ids, so nothing is counted twice. The release GBIF runs is checked hourly, and each species' answer is cached for a day
- Reworked **how assessed species are linked to CoL**, so that a record counts for a species only on direct evidence that it is the same organism:
  - The 2,016 frozen answers left from the retired hand-written matching passes are dropped. They had never been reviewed, and new rules let the matcher take back what they did correctly.
  - A synonym match, or a lumped species' same-spelled synonym, whose author citation is clearly another author's no longer counts. *Ilex wallichii* Hook.f. had also been counting Steudel's *I. wallichii*.
  - The rule that treated a same-epithet, same-author species in another genus of the same family as one organism is removed. An agent audit found it wrong for 7 of its 20 sampled links (*Atractus collaris* had been counting *Apostolepis collaris*, another snake). Removing it cost 353 species 540,986 records in all and added 330 CoL species to the NE list. The snowy plover went from 201,704 records to 4,971.
  - Respelled twins that CoL holds under two spellings now count together, so the yellow-billed magpie went from 570 to 122,333 records.
  - Only 3 human overrides remain. Each records the Red List and CoL versions it was decided against, and it is asked again when those no longer hold.
  - End state: 174,728 species linked by GBIF's matcher, 3 by overrides, and 1,178 waiting for a person.
- Showed a **dash instead of 0** in Total, New and % New for assessed species that await a link decision or have none, on the GBIF Records card and in the CSV export, with the reason on hover. A 0 read as "GBIF has no records" when the real answer was that none had been counted yet
- Fixed **Specialist Group membership disagreeing between lists and counts**. The sync now decides once which SSC Specialist Group each species belongs to, and the app reads that answer (`specialist_group`) instead of applying the group remits again in the browser. The browser's copy had none of the IUCN/CoL class and order aliases. So the Conifer SG's Awaiting 1st Assessment list goes from 46 to 90 species (CoL files the rest under Cupressales and Araucariales), and Fishes → Actinopterygii goes from 0 to 7,802. Described-species counts under Pinales, Caprimulgiformes and Artiodactyla now match the server's (714 / 608 / 486)
- Reworked the **CoL tab** to show the CoL taxon an assessed species actually is. When that is a subspecies or synonym, the tab names the species it belongs to ("*Fringilla teydea polatzeki* (Hartert, 1905), a subspecies of *Fringilla teydea*") and lists that taxon's own synonyms. Before, it showed *F. teydea*'s, as if the Red List's two blue chaffinches were one bird
- Made a **searched species show its own values** instead of group charts. The family header card and its Assessed / Awaiting toggle are hidden. Years Since Assessed shows the exact time ("1.5 years"), and GBIF Records shows the abbreviated count ("20.3K") instead of "10K+". The More Filters cards list the species' own criteria, number of assessments, realm/movement/trend, coded habitats and threats, and its CoL flag, instead of single bars at "1 · 100%"
- Put the app's **small controls on one standard**: compact 11px / 20px controls inside cards, and toolbar-size controls for page-level search and paging. Each "on" state is a solid fill in its card's own colour. One chevron `ChartPager` replaces seven hand-written Prev/Next variants, and there is one neutral focus ring. Several heavy elements are lighter: the Assessed / Awaiting toggle is now a raised white card on a grey track instead of a solid black block, the chart hover is a small light tooltip, bar value labels stay on one line ("3,871 · 64%"), and the species table's GBIF counts are no longer a grid of blue links
- Opened the **occurrence viewer with nothing filtered out**: all 9 basis-of-record types are on for every taxon, including living, fossil and preserved specimens, and "Flagged by GBIF" is off like the other checks, so it opens on "Applied 0 of 12" with flagged points shown in amber. The dashboard's GBIF counts are unchanged
- Kept **All Species selected when switching to Awaiting 1st Assessment**, instead of clearing it. The page shows the count and offers the eight groups as buttons
- Fixed the **photo preview** briefly showing the previously hovered species before the new photo loaded
- Made the **photo-credit ©** smaller and fainter on touch devices, where there's no hover to hide it. Desktop is unchanged
- Restructured the **sync** without changing any number:
  - Its stages are now inputs → sources → link → count → lists → precomputed → checks, with one builder per table.
  - The counting rule is now a table (`usage_owner`), and every human decision is a seed with its reason.
  - Its SQL stages run as dbt models (`dbt-oss` 2.0.11), with `npm run sync:lineage` to browse them.
  - The build lives in `.sync/` (`working/`, `publish/`, `review/`).
  - Every link records why it is what it is (`match_reason`, `col_treatment`, `counts`, `match_description`, `to_review`), and `.sync/review/links.parquet` holds all links in readable form.
  - `npm run sync:trace -- "<name or SIS id>"` prints a species' whole chain from name to count.
  - Every link rule must have a named fixture species, or the build stops.
  - `docs/sync.md` went from 1,434 lines to about 270.
- Refreshed the GBIF/CoL data sync

## [v2.27.0] — 2026-11-05 – 2026-11-06 — Monthly Sync, All-Records GBIF Counts & Taxon Header

- Reworked the **data sync** from first principles, and it now runs **monthly** instead of weekly. The 20-step, API-driven sync and its weekly GitHub workflow are gone. In their place is one local run, about five minutes long, that builds every number from the Catalogue of Life XR release GBIF indexes, the Red List database and GBIF's monthly snapshot. Each GBIF usage now counts towards one species at most, once. A species counts its synonyms, subspecies and BOLD BINs, minus any usage another assessed species owns. The sync stops if that rule breaks, if 50 named matching cases fail, or if the snapshot is incomplete. Comparing the new build field by field with production turned up several bugs that had been live, now fixed: every date in British Summer Time had slipped a day early (104,891 species). Latest credits had come from the wrong assessment (1,401 fields). Species IUCN assesses separately but CoL files as subspecies were counted twice (2,404; *Zosterops japonicus* showed 870,598 records, 571k of them *Z. simplex*'s). Organisms CoL holds twice were undercounted (1,308; *Accipiter cooperii* showed 86k of Cooper's hawk's 4M records). Nematodes, bryozoans and sea squirts had never been counted at all. CoL species were hidden from the Not Evaluated list by an ambiguous synonym (493, including *Vicia cracca* with 871k records). And two codes GBIF's `hasGeospatialIssue` doesn't act on were treated as flagged (`CONTINENT_COORDINATE_MISMATCH`, `COORDINATE_REPROJECTION_FAILED`), which cost the honey buzzard 89,732 records and painted trusted records as flagged in the occurrence viewer. The sync also refuses to pair a snapshot with a CoL release it wasn't indexed against: after GBIF moved to COL26.10 XR, about 52 million of the 1 November snapshot's records would otherwise have counted for nothing
- Reworked **name matching** so a Red List name is matched by GBIF's own matcher (matching-ws), the service GBIF uses to interpret occurrence records. A name therefore lands where GBIF filed that name's records. The matcher's answer is taken only under one strict rule: an exact species-rank match, confidence of at least 99, an accepted species, and no same-spelled rival the author citation doesn't settle. Every other species is decided in a reviewed decisions file. 173,627 species come straight from the matcher. No species loses records, and some gain records they never had (*Piptadenia flava* 0 → 1,117, *Ixobrychus exilis* +2,527)
- Reworked **GBIF counts** into two modes, **All records** (the default, matching what gbif.org shows) and **Georeferenced** (records with coordinates and no geospatial issue). Every record type now counts for every kingdom. Before, zoo and garden, fossil and literature records were left out, and so were museum specimens for animals, so 16,801 assessed animals showed no records at all. 450,190 Not Evaluated species now show GBIF records for the first time. **New** now counts records dated after the assessment *date* rather than from the following 1 January (*Accipiter gundlachi*: 5 → 186). The GBIF Records chart gains two dropdowns (Total / New / % New, and All records / Georeferenced). Each of the six combinations keeps its own buckets, pill and URL param (`gbifTotal`, `gbifTotalGeo`, `gbifNew`, `gbifNewGeo`, `gbifPctNew`, `gbifPctNewGeo`; `obsRanges` is gone), and they combine. The assessed and Not Evaluated tables each get a **GBIF Records** heading with their own toggle, kept in the URL as `records=georeferenced`. Switching modes is instant, with no refetch or spinner, and the filter charts no longer animate, an animation that blanked their counts for half a second on every change. The CSV export carries four explicitly named GBIF columns in place of the old two
- Added a **taxon header** between the summary table and the filter charts. It shows the selected taxon's photo, name and rank, and a two-part toggle with counts for **Species Assessed** and **Awaiting 1st Assessment**, restoring a prominent view switch where there had been a small toggle that was easy to miss. The photo is iNaturalist's default for the taxon, or for a group that isn't one clade (Fishes) its most-recorded species. The view now stays put while browsing to another taxon. The summary table keeps the same columns in both views, and a deep drill-down that overflows scrolls to keep the numbers whole. In the Not Evaluated view an **Awaiting 1st assessment** pill leads the filter pills, and its × or Clear all switches back to Assessed. Live drill-down rows show their own or their nearest ancestor's icon (Rodentia → rat, Primates → gorilla) instead of a generic leaf
- Added **photo credits** wherever a third-party photo appears. A © on the taxon header, species header, species-table and nearby-species photos opens iNaturalist's own attribution line, e.g. "(c) <photographer>, some rights reserved (CC BY-NC)". GBIF occurrence photos now name the creator (or the rights holder) plus the licence. Most of these photos are Creative Commons licensed, which requires naming the author and the licence, and the iNat default photos had carried no credit at all
- Removed **Comparison Mode** (`/compare`), the **Realm view**, and the agent surface: the **MCP server** (`/api/mcp`), **/browse** and **/llms.txt**. All three were little used, and removing them simplifies the app. `/compare` redirects to `/` and `?layout=realm` opens the default view. The Realm filter under More Filters (`systems=`) stays. The URL-only bounds `minObs`/`maxObs`, `min/maxAssessmentYear` and `min/maxDescribedYear` went with /browse, because no on-screen control ever set them. Old links carrying them still open, and the bounds are ignored
- Made **dashforlife.org the one domain**. dashoflife.org, red.cst.cam.ac.uk, en.ki, red-list-dashboard.vercel.app and the `www.` variants now permanently redirect there with the path and query string intact, so a shared filtered link still lands on the same view. Running five copies of the site meant a sign-in on one didn't carry to another and search engines split the site's ranking between them. The per-domain "Dash of Life" and "Red List Dashboard" titles are gone with it, and so is the sign-in workaround for red.cst and en.ki, which reached the app through a Cambridge proxy that hid their real address (#416): no sign-in comes through that proxy any more
- Removed the remembered chart views (credit chart role, Suggested Experts role, Years Range/Year, Country Map/List), so every visitor opens every chart on the same default and two people opening one link see the same thing. Links that name a view still win
- Fixed **"described species"** having several definitions with different domestic-species lists. Goat, sheep, yak, dromedary and guinea pig were listed and counted as Not Evaluated, and now they aren't: Mammals' Not Evaluated count goes from 498 to 493
- Fixed Not Evaluated species that share a common name (e.g. "A bird flea") being findable under it only once. 4,870 more species-name pairs are now searchable
- Fixed the **iNaturalist Observations panel** going missing, or showing an empty column, when a GBIF request failed in production. A failed or throttled request had been read as zero records and cached for an hour. Those requests now go through GBIF's backoff, a failure is reported rather than read as zero, and the panel offers "Couldn't load iNaturalist observations. Try again"
- Fixed bursts of near-identical requests: the world map's GBIF counts are one request instead of eight, the SSC groups table is one instead of six, and species-table thumbnails load at most four at a time. A failed GBIF call no longer silently drops a group from the map's totals
- Fixed the ⚑ Catalogue of Life flag tooltip opening without its source until a second hover. It also no longer links to dead World Plants pages, and it now names the CoL release it describes (COL26.6 XR), since catalogueoflife.org always shows the newest release
- Updated four country names to their current official forms: Türkiye, Naoero, and the Hong Kong and Macao Special Administrative Regions of China. The old spellings still find them in search

## [v2.26.0] — 2026-11-02 – 2026-11-04 — Instant Lists and Search, Common Names & Reptile SSC Groups

- Reworked **species lists to load from pre-built static files** instead of a live DuckDB query over R2 on every request. A first visit to a big group drops from 10–22s to 1–2.5s (Plants 13.0s → 2.5s, Plants → Not Evaluated 22.2s → 1.8s, Fabales → Not Evaluated 10.9s → 0.26s), and drilling down within a group is near-instant. Lists over Vercel's 10MB cacheable-response limit were never edge-cached before, so every visit paid the full query again. A build step now writes each of the 29 taxon groups' Assessed and Not Evaluated rows as brotli-compressed column files (37MB for 2.03M rows). The browser downloads only the groups a view needs, shares each download across views and compare-mode panels, and filters deeper levels itself. The live route still answers anything the files can't. The all-species prefetch on mount is gone, since it no longer earned its ~7MB download
- Loaded every Not Evaluated **insect (909,938 species) and invertebrate (1,300,158)** in full. The "too many, drill into a sub-group" prompt is gone: it existed only because the live route couldn't build a response over 400k rows, a limit the static files don't have. All 1.3M invertebrates open in about 4s, chart-bar filters take ~0.1s and paging is instant
- Reworked **search to answer from static prefix shards in the browser**: ~0.1s per keystroke instead of 2–6s (*panthera le* 2.4s → 0.12s, first cold search for *lion* 5.9s → 0.77s), with no server calls when a name starts with the query. Each keystroke used to read `name-index.parquet` from R2 over several round trips, after a 250ms debounce. Now a prefix's shard is fetched once and every later keystroke under it filters and ranks locally, using the same ranking as the server route. The debounce drops to 60ms. Substring matches, CoL-only names and synonyms still go to `/api/search`
- Pre-built the **taxonomy tree expands** too, so drilling down is fast on a fresh deployment rather than only after someone has warmed the edge cache. Every weekly-sync deploy used to start cold, with each node its own DuckDB-over-R2 request: 10.5s for Fabales, 17.5s for Stylommatophora, 20s to open Molluscs. Now one file per drill-down root (37 roots, 20,747 nodes, 4.6MB) answers every unscoped expand under it, at ~0.5–0.7s per level
- Made **search match every English common name the Catalogue of Life gives a species**, and offer higher taxa by their common names, so "baobab" offers *Browse Adansonia (Baobabs)* alongside every baobab. The sync used to keep only the shortest English name per species; for *Adansonia digitata* that was "Boabab", a misspelling. The dropdown shows which name matched (also "Perrier's baobab"). iNaturalist's names are searchable alongside CoL's
- Reworked **display common names** to come from a source that actually ranks them: IUCN's name first, then iNaturalist's preferred English name, then a CoL pick. CoL never marks a preferred English name, so every CoL-only display name was a guess. *A. digitata* now shows **African baobab**. The 18,636 assessed species IUCN gives no common name get iNaturalist's, and 31k species gain their first common name; no species loses one. This also replaces misspellings, placeholders ("Othonna Sp. A") and offensive names listed as common names. iNaturalist's taxonomy export is fetched in a new best-effort sync phase, matched by scientific name within a kingdom
- Aligned the **reptile SSC Specialist Groups** (`?layout=ssc`) with the remits in the IUCN Global Reptile Assessment master list. Boa and Python SG becomes the **Snake SG**: every snake except Viperidae and the marine elapids. The **Sea Snake SG** is defined by genus, as the GRA defines it, so mud and file snakes move to the Snake SG. Snake and Lizard RLA becomes the **Lizard and Tuatara RLA**, defined by its GRA families instead of "every reptile no other group claims". **Anoline SG** also matches the genera *Anolis* was split into. Every one of the 12,851 CoL reptile species still lands in exactly one group. The old ids `ssc-boa-python` and `ssc-snake-lizard-rla` are gone without aliases
- Linked **every taxonomy-tree name in the # Described tooltip** to CoL. 56 names CoL doesn't accept as written used to show as plain text; they now resolve through CoL's own synonym record or a hand-written equivalent with its reason. They are shown as e.g. "Calamariidae (Calamariinae on CoL)", or "(a parvphylum on CoL)" when only the rank differs. Each SSC section now shows its top two groups and a "Show N more" row, and the "Suggest a correction" link opens a short email draft listing the group's names rather than GitHub's new-issue form, since specialist group members may not have a GitHub account
- Fixed **"No 1:1 CoL Match"** in SSC popovers flagging species whose CoL counterpart sits under a different family in the same group, for example all 740 Dipsadidae in the Snake SG, which CoL holds under Colubridae. The counterpart may now be anywhere in the group, which clears 1,211 false flags. Also fixed CoL family and genus links opening on an empty search for sources that leave `extinct` blank, the Reptile Database among them (`extinct=0&extinct=_NULL`)
- Moved the **Country map and Assessors/Reviewers chart into More Filters** in the reassessments view, so only the first chart row and the toggle stay always visible. The More Filters badge now counts Country selections, so an active country filter still shows while the panel is collapsed (moved back onto the main page in v2.29.0)
- Fixed **clicking a protected area showing nothing**: UNEP-WCMC republished the WDPA service with lower-case, alias-keyed fields, and the parser silently dropped every result. Each site in the popup also gains an **All fields (N)** toggle listing the full WDPA record (governance, management authority, verification, no-take, OECM fields and more), keeping "Not Reported" values, which are themselves informative
- Upgraded dependencies: Next.js 16.0.7 → 16.4.4 (about 30 advisories, several critical remote-code-execution bugs among them), maplibre-gl 6, Sentry 11 (its new defaults that would send cookies and request bodies are switched off), ESLint 10, vitest 5, TypeScript 6, react-simple-maps 5 and MCP 2, taking production advisories from 50 to 0. CI and the weekly sync now run on Node 24
- Refreshed the GBIF/CoL data sync

## [v2.25.0] — 2026-09-21 – 2026-10-26 — Place Map, GPS Uncertainty & Narrative Search by Group

- Moved **/near-me to `/mapping`** and gave it the species map's overlays, so the place map and the species map are now the same map, one with a species' records and one without. `/mapping/<species key>` is still the species map; `/near-me` permanently redirects (308) to `/mapping` with the query string intact, so a shared `?lat=&lng=&r=` search still opens, and the page is now titled **Map**. Protected areas, tree cover loss and its drivers, IUCN habitat types, terrestrial ecoregions and GBIF sampling effort are now shared code that both maps draw, from the same **Overlays** dropdown in a toolbar above the map, with the same legend and click callout. That means a click on a protected area opens the same answer on either map, and a fix to one fixes both. Searching now starts from a click, the way clicking a GBIF record does on the species map: clicking anywhere opens a callout with the coordinates, the elevation, what each overlay that's on says about the spot, and **Show nearby threatened species** with the radius it will use. A click inside a protected area is treated as a question about the area and offers **Show threatened species in here**, which searches inside its boundary. Nothing is searched until one of those is chosen, and a place search or the new locate button (top right, under the basemap control) opens the same callout where it lands instead of searching straight away. The "Find threatened species near me" pill, the radius row under it and "Search here instead" are gone, since clicking the map now does their job; the radius is still in the results panel and on the draggable ring
- Reworked the occurrence map so **habitat and sampling effort answer a single left click**, in the same callout as the other overlays. The habitat callout used to anchor to the right-click point, which a left click clears, so on its own it opened at 0°, 0°, off screen. Sampling effort has moved out of the right-click popup into its own "Sampling effort" section, with the same snapshot count, live GBIF count by basis of record and "Inspect these records on GBIF" link. The right-click popup now covers only the spot itself: coordinates, elevation, pin/measure and nearby species
- Added a **GPS uncertainty** toggle to the occurrence map's tools, under "Measure a distance", drawing each record's stated `coordinateUncertaintyInMeters` as a dashed circle on the ground at its true scale. The figure was already in the record panel and in a filter, which is enough to read one record at a time and no use for the question it's actually asked for: forest elephants apparently swimming in the ocean off Gabon, whose records carry a 35 km radius that reaches the coast from well inland. Off by default — a few thousand overlapping rings is noise when you're reading a distribution, and the whole answer when you're weighing a single point. Under the toggle it says how many of the drawn records state a radius at all, because a point with no ring isn't a precise one, it's one whose precision nobody recorded; a radius over 500 km gets no ring and is counted there instead, since a circle spanning a continent is a shape over the whole map rather than a fact about one record
- Added a **taxonomic group filter to the narrative search**. Searching every current global assessment at once is the right default for a phrase nobody has a code for, and the wrong one the moment the phrase belongs to a group: looking for a place name turns up dragonflies, crickets and a nutmeg tree when the species being written up is a yam. The dropdown sits beside the search box and offers every Table 1a group, plus the whole of invertebrates, plants and fungi & protists. It narrows inside the ranking query rather than filtering what the ranking returned, so the count, the order and the paging are all the group's own — a filter applied to a page of ten already chosen from everything would be a different, and much worse, feature. The group rides in the URL as the dashboard's own `taxa=` token, so a narrowed search is a link that can be sent, and it now travels the other way too: choosing "By Assessment Text (search)" with a single taxon selected on the dashboard arrives already filtered to it, including a live-drilldown one like `flowering_plants~dioscoreales~dioscoreaceae` — deeper than the dropdown itself goes, and kept selectable for the session once it arrives. An assessment the current sync holds no species row for cannot be shown to belong to a group, so it leaves a filtered search rather than being guessed into one
- Fixed the mapping tool's **duplicate links** depending on the wording of their reason. A duplicate's link to the record it duplicates was read back out of the sentence "Duplicate of GBIF N", so typing that sentence by hand as an ordinary reason silently created a duplicate, and any change to the wording would have unlinked every duplicate already saved. The link is now a field of its own (`duplicateOf`). The reason still reads the same, so a file saved now still restores as duplicates in an older build, and duplicates saved earlier, in either old spelling, are converted once when they load. Rewording a duplicate's reason no longer breaks the link
- Refreshed the GBIF/CoL data sync

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
