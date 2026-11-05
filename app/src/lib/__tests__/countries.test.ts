/**
 * The country lookup tables used to exist twice — once in WorldMap.tsx for the
 * choropleth and once here for server-side callers (/browse, filter-vocab) —
 * and they drifted: the map learned about Curaçao, Hong Kong, Aruba and ~40
 * other territories, and learned that the 50m shapes spell it "Macedonia", while
 * the server-side copy kept the older, thinner list. So `?country=Curaçao`
 * resolved on the map and nowhere else. There is one copy now; these tests pin
 * the properties that made the drift invisible.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NAME_TO_ALPHA2, ALPHA2_TO_NAME, resolveCountryToAlpha2 } from "../countries";
import { EMBEDDED_TERRITORIES } from "../map-territories";

describe("country lookup tables", () => {
  it("resolves every name the map can draw", () => {
    for (const [name, code] of Object.entries(NAME_TO_ALPHA2)) {
      expect(resolveCountryToAlpha2(name), name).toBe(code);
    }
  });

  it("displays a full country name for every code, never a shape's abbreviation", () => {
    // The TopoJSON spells them "St. Vin. and Gren.", "Faeroe Is.", "Cabo Verde";
    // ALPHA2_TO_NAME is what the tooltip, the list view and the filter chips
    // show, so it has to override each of those back to the long form.
    for (const [code, name] of Object.entries(ALPHA2_TO_NAME)) {
      // "U.S." is the country's actual name, not a shortening of one.
      expect(name.replace("U.S.", "US"), `${code} is showing an abbreviated shape name`)
        .not.toMatch(/\b(Is|Rep|Terr?|Ter|Herz|Gren|Vin|Geo|Fr|N|S|W|St|Eq)\.\s|\bIs\.$/);
    }
  });

  it("round-trips each code through its own display name", () => {
    for (const code of Object.keys(ALPHA2_TO_NAME)) {
      expect(resolveCountryToAlpha2(ALPHA2_TO_NAME[code]), code).toBe(code);
    }
  });

  it("knows every territory the map splits out of a parent shape", () => {
    // splitEmbeddedTerritories labels each piece with these names, and the map
    // resolves a shape to a country purely by name — an entry missing here
    // would render the territory grey and unclickable instead of fixing it.
    for (const territory of Object.values(EMBEDDED_TERRITORIES).flat()) {
      expect(NAME_TO_ALPHA2[territory.name], territory.name).toBe(territory.code);
    }
  });

  it("puts French Guiana in South America, where the Red List does", () => {
    expect(resolveCountryToAlpha2("French Guiana")).toBe("GF");
    expect(resolveCountryToAlpha2("Guyane")).toBeNull(); // not an IUCN spelling
  });

  // Checks a sync's output, so it needs the data (see taxonomy-tree.test.ts's summaries block).
  const statsPath = path.join(process.env.PIPELINE_DATA_DIR ?? fileURLToPath(new URL("../../../data", import.meta.url)), "country-stats.json");
  it.skipIf(!existsSync(statsPath))("can name every country that carries Red List data", () => {
    // The map's country search offers one entry per ALPHA2_TO_NAME code, so a
    // code with data and no display name is a country nobody can search for.
    // Antarctica, Gibraltar, Bouvet Island, the U.S. Minor Outlying Islands
    // and DT are exactly that case — they have no shape at 50m, so a list
    // built from shape names skipped them entirely.
    const stats = JSON.parse(
      readFileSync(statsPath, "utf8"),
    ) as Record<string, { species: number }>;
    const unnamed = Object.keys(stats).filter((c) => stats[c].species > 0 && !ALPHA2_TO_NAME[c]);
    expect(unnamed, "codes with assessed species but no display name").toEqual([]);
  });

  it("names DT, which is IUCN's own code rather than an ISO one", () => {
    // 1,808 assessed species carry it; without a name it renders as a bare
    // "DT" row in the country list and an unresolvable ?country= value.
    expect(ALPHA2_TO_NAME["DT"]).toBe("Disputed Territory");
    expect(resolveCountryToAlpha2("DT")).toBe("DT");
  });
});
