# Coordinate-cleaning reference data

Point gazetteers and polygon layers used by `../coordinate-cleaning.ts`'s `cc_cap`/`cc_cen`/`cc_inst`/`cc_sea`/`cc_urb`/`cc_aohi`/`cc_coun` ports. Sourced independently of CoordinateCleaner's own bundled `countryref`/`institutions`/`landmass`/`urban_areas`/`aohi` R data objects rather than extracting and redistributing those GPL-3 R data objects verbatim — each section below documents its own independent source.

All of this data is imported only by `coordinate-cleaning.ts`, which is used both server-side (`/api/occurrences`) and by a couple of client components for just their label/description exports (`QUALITY_FLAG_LABELS`/`QUALITY_FLAG_DESCRIPTIONS`). Verified via a production build that the bundler tree-shakes the actual point/polygon data out of the client bundle — only the flag label strings ship to the browser.

## `capitals.json` (200 points)

Country political capitals. Extracted from Natural Earth's 1:50m populated places layer (public domain, no attribution required), via the [martynafford/natural-earth-geojson](https://github.com/martynafford/natural-earth-geojson) GeoJSON mirror (`50m/cultural/ne_50m_populated_places.json`), filtered to `ADM0CAP === 1`. Extracted by hand once (2026-07); capitals essentially never change, so no refresh script.

## `centroids.json` (250 points)

Country geographic centroids. Extracted from [mledoze/countries](https://github.com/mledoze/countries) (MIT licensed) `dist/countries.json`, each country's `latlng` field. Extracted by hand once (2026-07); same rationale as capitals.

## `institutions.json` (6,062 points)

Biodiversity institutions (museums, herbaria, zoos, universities, etc.) with known coordinates. Sourced live from GBIF's own [GRSciColl](https://www.gbif.org/grscicoll) registry (`api.gbif.org/v1/grscicoll/institution`), not CoordinateCleaner's bundled table — keeps this pipeline entirely GBIF-sourced and sidesteps the licensing question. Unlike capitals/centroids, GRSciColl actively grows, so regenerate periodically with:

```
npx tsx scripts/maps/fetch-coordinate-cleaning-refdata.ts
```

## `land-polygons.json` (1,420 polygons)

Land/ocean mask. Extracted from Natural Earth's 1:50m land layer (public domain), via the martynafford mirror (`50m/physical/ne_50m_land.json`), stripped to bare `{type, coordinates}` geometries and coordinates rounded to 3 decimal places (~110m precision) to cut file size (2.76MB → 1.07MB). Originally shipped at Natural Earth's coarsest 110m scale (matching CoordinateCleaner's own `cc_sea` default), but upgraded to 50m after a real GBIF record (a coastal-dwelling desert frog species, *Breviceps macrops*) showed 110m was too coarse for a species that lives right at the shoreline: several genuinely-offshore points (confirmed by satellite imagery, several km out in open water) went undetected because the 110m coastline was simplified out to sea at that location — verified 50m correctly resolves those same points as ocean. Extracted by hand once (2026-07); coastlines don't change on any timescale this matters for, so no refresh script.

## `urban-areas.json` (2,143 polygons)

Urban area footprints. Extracted from Natural Earth's 1:50m urban areas layer (public domain), via the martynafford mirror (`50m/cultural/ne_50m_urban_areas.json`), same stripping/rounding treatment (4 decimal places, ~11m precision; 1.97MB → 730KB). Extracted by hand once (2026-07); no refresh script, same rationale as land polygons.

## `countries.json` (1,612 polygon parts, 236 country codes)

Country border polygons, keyed by ISO 3166-1 alpha-2 code (matching GBIF's own `countryCode` field). Extracted from Natural Earth's 1:50m admin-0 countries layer (public domain), via the martynafford mirror (`50m/cultural/ne_50m_admin_0_countries.json`), same stripping/rounding treatment as the land mask (3 decimal places, ~110m precision; 4.68MB → 1.7MB). MultiPolygon countries (islands, exclaves) are split into individual same-code Polygon parts, matching the pattern already used for land/urban polygons.

**Known data quirk, patched during extraction**: this Natural Earth layer has a long-standing bug where a handful of features carry `ISO_A2 = "-99"` instead of a real code. Most are genuinely uncoded disputed territories (Somaliland, Northern Cyprus, Siachen Glacier, two small Australian dependencies) and are simply excluded — no GBIF record would report their non-standard codes anyway. But **France and Norway are also affected**, despite being real, heavily-GBIF-represented countries — without a fix, every French/Norwegian occurrence would fail to match any reference polygon and get flagged as a false "country mismatch". Patched via each feature's stable `ADM0_A3` code (`FRA` → `FR`, `NOR` → `NO`) rather than its display name. Verified against live GBIF data (France- and Norway-filtered `Vulpes vulpes` queries) that this fixes the mass-false-positive case, leaving only a small, plausible fraction flagged — coastal/border points where the 50m coastline simplification clips a genuinely in-country point (e.g. deep in a Norwegian fjord), the same caveat CoordinateCleaner's own docs give for this check. Extracted by hand once (2026-07); no refresh script, same rationale as land polygons.

## `aohi.json` (231 points)

Artificial Hotspot Occurrence Inventory (AHOI) — recurring coordinates independently confirmed by [Park et al. (2023)](https://onlinelibrary.wiley.com/doi/10.1111/jbi.14543) as artificial aggregation points (geopolitical/grid centroids and similar geo-referencing defaults), not genuine observation sites. Sourced from the authors' own [Dryad](https://datadryad.org/dataset/doi:10.5061/dryad.v41ns1s0p) / [Zenodo](https://zenodo.org/records/7268229) deposit (**CC0**, public domain) — independent of CoordinateCleaner's bundled `aohi` R data object (GPL-3), despite backing the same `cc_aohi` check. The deposit ships 4 CSVs (birds/insects/mammals/plants, Oct 2022 snapshot) with a `determination` column (`TRUE` = confirmed genuine site, `FALSE` = confirmed artificial); kept only the `FALSE` rows across all four taxa, matching upstream `cc_aohi`'s own default `taxa` argument (all four). Extracted by hand once (2026-07) — this is a frozen dataset snapshot (fixed DOI), not a live API, so no refresh script; re-derive by hand from the same Zenodo/Dryad deposit if a future AHOI version ships.
