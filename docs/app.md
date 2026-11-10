# The app: where each view gets its data

How the running dashboard reads its data: the API routes, what each reads, and what calls it. The sync that produces the data is [sync.md](sync.md); the deploy build that packages it is [build.md](build.md). This is a map of what is there and why, kept alongside the simplifications it points to.

## Four ways a view gets data

1. **Prebuilt files from the CDN.** The species lists, the search dropdown's first answers and the taxonomy tree's expands are static files under `public/prebuilt/<sync>/`, fetched straight by the browser (`src/lib/species-lists`, `search-shards`, `tree-children`). No function runs. See [build.md](build.md).
2. **API routes over the sync's parquets.** A route queries the sync with DuckDB (`src/lib/data/species-duckdb.ts`). Locally that is `app/data/sync/`; on Vercel the parquets aren't bundled, so `parquetUri()` points DuckDB at `syncs/<latest-sync.txt>/` in R2 over httpfs.
3. **API routes over the sync's JSON.** The small summaries (`summaries/*.json`, `col-revisions.json`, `vernacular-names.json`) are bundled into the functions that need them and read from disk (`src/lib/data/species-store.ts`).
4. **API routes over a live external API.** GBIF, iNaturalist, the IUCN Red List API, CITES, ChecklistBank and the literature sources, each behind a route so the key stays server-side and the answer is cached at the edge (`s-maxage`, usually an hour).

No route reads the Red List database: that only happens in the sync. Supabase holds sign-in and the `user_roles` table behind the admin-only map layers.

## The routes

42 handlers under `app/src/app`. "Parquet" and "JSON" are the sync's files (see [sync.md](sync.md#what-the-app-reads)).

### Species lists and summaries

| Route | Reads | Called by |
|---|---|---|
| `/api/redlist/species` | parquet: assessed, species/, ne, assessment_link; JSON: taxa-summary, col-revisions | the species table, through `SpeciesCacheContext`, **only when the prebuilt species list can't answer** (an arbitrary rank, or a failed file load) |
| `/api/redlist/species/history` | parquet: assessments | the detail panel's history |
| `/api/redlist/synonyms` | parquet: assessment_link, taxa | the detail panel's CoL tab |
| `/api/redlist/taxa-summary` | JSON: taxa-summary; parquet (assessed) when scoped to a country | the summary table |
| `/api/redlist/taxa-subgroups` | JSON: the children summaries; parquet when scoped, or for live drill-down | the summary table's expands, **when the prebuilt tree can't** (a country scope) |
| `/api/redlist/country-stats` | JSON: country-stats | the country view |
| `/api/redlist/credit-candidates` | parquet: assessed, assessments; JSON: vernacular-names | the candidate assessors table |
| `/api/data-sync-date` | `latest-sync.txt` | the "data as of" line |

### CoL differences

| Route | Reads | Called by |
|---|---|---|
| `/api/redlist/taxa-breakdown-live` | parquet: the three col-*, species/, assessed, assessment_link, taxa | the breakdown popover on a live drill-down node |
| `/api/redlist/col-taxon-ids-live` | parquet: taxa | the popover's CoL links (split out so the breakdown doesn't wait on it) |
| `/api/col/provenance` | ChecklistBank | a species' CoL source line |

### Search and agents

| Route | Reads | Called by |
|---|---|---|
| `/api/search`, `/api/search/warm` | parquet: name-index, rank-index, synonym-index, assessed, ne, species/ | the search bar, **after the prebuilt shards** (substring, CoL-only and old-name queries); warm primes it |
| `/api/narrative-search`, `/[assessmentId]` | narratives parquets (R2 `narratives/<release>/`, per Red List release) | the narrative search page |

### Live data in the detail panel and maps

These routes ask GBIF's live API, which re-indexes against a newer CoL release a few times a year, between our syncs. So each asks with `liveGbifKeys(key)` (`src/lib/gbif-live-keys.ts`): when GBIF's matcher runs a newer release than our data, both our id and the id GBIF's matcher gives our name there, if that answer really is our name (a respelling allowed; another author's accepted species not). GBIF ORs the two, so a species' records are found while GBIF is still re-filing them, and after. Links to gbif.org go through `/api/gbif-link` for the same reason. Nothing in the sync is involved.

An assessed species linked to no CoL species yet (waiting in the sync's match queue) carries `count_note = 'unlinked'` in `assessed.parquet`: nothing is counted, so Total and New GBIF show a dash with the reason on hover (`src/lib/count-note.ts`), not a 0 that reads as "no records exist".

| Route | Reads | Called by |
|---|---|---|
| `/api/occurrences` | GBIF | the occurrence map |
| `/api/species/[key]/breakdown` | GBIF | the map's record-type breakdown and iNat count |
| `/api/species/[key]/inat-photos` | GBIF (iNat dataset) | the map's photo strip |
| `/api/country/stats` | GBIF | the world map's GBIF layer |
| `/api/nearby-species`, `/points` | GBIF, then parquet (assessed, ne) | the nearby-species panel and map |
| `/api/inat/observations`, `/api/inat/thumbnail` | iNaturalist | the iNat tab; table thumbnails |
| `/api/species/[key]/inat-top-observers` | iNaturalist | the iNat tab's contributors chart |
| `/api/redlist/assessment/[id]` | IUCN Red List API v4 | the Red List tab, nearby panel, narrative search |
| `/api/literature` | OpenAlex, Zenodo, CORE, BHL, Google Books, IUCN API | the literature timeline |
| `/api/cites`, `/api/cites/trade` | CITES Species+, trade.cites.org | the CITES tab |
| `/api/wcvp-native-range` | a bundled WCVP parquet | the map's native-range layer (plants) |
| `/api/species/[key]/range-map`, `/aoh`, `/aoh/metadata` | R2 maps bucket; Supabase `user_roles` | the map's range and AOH layers, **admins only** |
| `/api/overlays/[asset]` | R2 maps bucket | the ecoregion and sampling-effort overlays |

### Sign-in

`/api/auth/me` (who is signed in, and whether they're an admin) and `/auth/callback` (the OAuth return). Both use Supabase.

## What could be simpler

Found while mapping the routes, checked against the code. Nothing here is changed yet.

**Nothing calls these.**
- `/api/taxa/species`: no caller in `src/`, and `getSpeciesUnder` behind it is used nowhere else.
- `/api/eol` and `/api/eol/traits`: the EOL tab is switched off (`SHOW_EOL_TAB = false` in `RedListView.tsx`).

**Work nobody reads.**
- `/api/species/[key]/breakdown` makes a third GBIF request for recent iNat observations (`recentInatObservations`), which no component reads.
- `/api/species/[key]/inat-top-observers` has a GBIF name lookup for when no name is passed, but its one caller always passes the name, and `[key]` is always 0.

**Fallbacks the prebuilt files now mostly answer.** `/api/redlist/species`, `/api/search` (and `/warm`, which primes it) and unscoped `/api/redlist/taxa-subgroups` sit behind the prebuilt files. They are still needed for what the files don't cover (arbitrary ranks, substring search, country scopes),; but `/warm` now primes a path few searches reach.

**Thin wrappers.** `/api/data-sync-date` returns `latest-sync.txt`, which the client bundle already carries (`NEXT_PUBLIC_SPECIES_LISTS_SYNC`). `/api/redlist/country-stats` returns a static JSON file.

**The same thing written several times.**
- Four routes build their own R2 client (`overlays/[asset]`, `range-map`, `aoh`, `aoh/metadata`); `aoh` and `aoh/metadata` repeat the same key lookup ("Mirror of findAohPngKey") and admin check.
- Three iNat routes repeat the same exact-name taxon lookup, and two (`/api/inat/observations`, `/api/species/[key]/inat-photos`) return the same observation shape from different upstreams.
- `/api/wcvp-native-range` opens its own DuckDB instance; `/api/occurrences` has its own GBIF retry loop instead of `gbifJson`.
- `/api/auth/me` is fetched by both `MeProvider` and `OccurrenceMapRow`.

**Names that mislead.** `/api/country/stats` (GBIF counts) beside `/api/redlist/country-stats` (assessment totals). Under `/api/species/[key]/`, `[key]` is an assessment id (`range-map`), a SIS id (`aoh`), a GBIF/CoL key (`breakdown`, `inat-photos`), or always 0 (`inat-top-observers`).
