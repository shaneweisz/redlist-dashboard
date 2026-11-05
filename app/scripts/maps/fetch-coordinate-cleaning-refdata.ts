/**
 * fetch-coordinate-cleaning-refdata: regenerate the institutions gazetteer used by
 * cc_inst (src/lib/coordinate-cleaning.ts) from GBIF's own GRSciColl registry.
 *
 * Institutions get added/moved in GRSciColl over time, so this is worth re-running
 * occasionally (not on every sync — it's not part of the taxonomic data pipeline).
 * Capitals/centroids/land/urban-areas/aohi/countries (src/lib/mapping/coordinate-cleaning-refdata/
 * {capitals,centroids,land-polygons,urban-areas,aohi,countries}.json) are sourced from
 * Natural Earth, mledoze/countries, and a frozen Zenodo/Dryad deposit instead, all
 * essentially static, so there's no fetch script for those — they were extracted once
 * by hand; re-derive the same way if ever needed:
 *   - capitals.json: https://github.com/martynafford/natural-earth-geojson
 *     50m/cultural/ne_50m_populated_places.json, filtered to ADM0CAP === 1
 *   - centroids.json: https://github.com/mledoze/countries dist/countries.json,
 *     each country's `latlng` field
 *   - land-polygons.json / urban-areas.json: same natural-earth-geojson mirror,
 *     50m/physical/ne_50m_land.json and 50m/cultural/ne_50m_urban_areas.json
 *   - aohi.json: https://zenodo.org/records/7268229 (CC0), the 4 taxon CSVs
 *     (birds/insects/mammals/plants), kept only rows where determination === "FALSE"
 *     (confirmed artificial, not a genuine site) — see coordinate-cleaning-refdata/README.md
 *   - countries.json: same natural-earth-geojson mirror,
 *     50m/cultural/ne_50m_admin_0_countries.json, keyed by ISO_A2 (patched for France/
 *     Norway's -99 data quirk via ADM0_A3 — see coordinate-cleaning-refdata/README.md)
 *
 * Usage:
 *   npx tsx scripts/maps/fetch-coordinate-cleaning-refdata.ts
 */

import * as fs from "fs";
import * as path from "path";

const OUT_PATH = path.join(__dirname, "..", "..", "src", "lib", "mapping", "coordinate-cleaning-refdata", "institutions.json");
const PAGE_LIMIT = 1000;

interface Institution {
  name: string;
  lat: number;
  lon: number;
}

async function fetchAllInstitutions(): Promise<Institution[]> {
  const out: Institution[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`https://api.gbif.org/v1/grscicoll/institution?limit=${PAGE_LIMIT}&offset=${offset}`);
    if (!res.ok) throw new Error(`GRSciColl API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    for (const r of data.results as { name?: string; latitude?: number; longitude?: number }[]) {
      if (r.latitude == null || r.longitude == null) continue;
      out.push({ name: r.name ?? "", lat: Math.round(r.latitude * 1e5) / 1e5, lon: Math.round(r.longitude * 1e5) / 1e5 });
    }
    console.log(`offset=${offset} total_so_far=${out.length} endOfRecords=${data.endOfRecords}`);
    if (data.endOfRecords) break;
    offset += PAGE_LIMIT;
  }
  return out;
}

async function run() {
  const institutions = await fetchAllInstitutions();
  fs.writeFileSync(OUT_PATH, JSON.stringify(institutions));
  console.log(`Wrote ${institutions.length} institutions to ${OUT_PATH}`);
}

run();
