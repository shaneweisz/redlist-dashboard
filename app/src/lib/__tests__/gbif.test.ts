import { describe, it, expect } from "vitest";
import {
  gbifTaxonKeysForGroup,
  GBIF_CHECKLIST_KEY,
  COL_XR_CHECKLIST_KEY,
  gbifOccurrenceParams,
  includedBasisOfRecord,
  kingdomCountsPreservedSpecimens,
  taxonGroupCountsPreservedSpecimens,
  GBIF_GEOSPATIAL_ISSUES,
  GBIF_COORDINATE_NOTES,
} from "../gbif";
import { TAXA } from "@/config/taxa";
import { TAXA_DEFINITIONS } from "../../../scripts/taxa";
import DERIVED_TAXON_KEYS from "@/config/gbif-taxon-keys.json";

describe("gbifTaxonKeysForGroup", () => {
  // The failure this guards against produced no error at all: src/config/taxa.ts
  // kept its own list of GBIF Backbone integer keys, the pipeline moved to
  // Catalogue of Life, and country statistics went on sending integers while
  // naming the CoL checklist. GBIF answers that with an empty result set, so the
  // world map's occurrence layer went blank and every request still returned 200.
  it("returns keys for every dashboard group that has occurrence data", () => {
    const groups = TAXA.map((t) => t.id).filter((id) => id !== "all");
    for (const id of groups) {
      expect(gbifTaxonKeysForGroup(id), `no GBIF keys for "${id}"`).not.toHaveLength(0);
    }
  });

  it("draws every key from the generated config, never a second list", () => {
    // The keys cannot be checked by shape — Catalogue of Life ids are alphanumeric
    // but plenty are all digits (Testudines is "477"), so "looks like an integer"
    // says nothing. What matters is provenance: a key that is not in the generated
    // config came from somewhere else, and somewhere else is what went stale.
    const derived = new Set(
      Object.values(DERIVED_TAXON_KEYS as Record<string, Array<{ taxonKey: string | null }>>)
        .flat()
        .map((e) => e.taxonKey)
        .filter((k): k is string => Boolean(k))
    );
    for (const id of TAXA.map((t) => t.id)) {
      for (const key of gbifTaxonKeysForGroup(id)) {
        expect(derived.has(key), `"${key}" in "${id}" is not in gbif-taxon-keys.json`).toBe(true);
      }
    }
  });

  it("rolls the fine-grained Table 1a groups up into dashboard groups", () => {
    // Invertebrates spans beetles through corals, so it must carry more keys than
    // any single constituent group.
    expect(gbifTaxonKeysForGroup("invertebrates").length).toBeGreaterThan(5);
    expect(gbifTaxonKeysForGroup("mammals")).toEqual(["6224G"]);
  });

  it("is unknown-group safe", () => {
    expect(gbifTaxonKeysForGroup("not-a-group")).toEqual([]);
  });
});

describe("gbifOccurrenceParams", () => {
  it("names the checklist on every query", () => {
    // Leaving it unset means the result depends on which default GBIF happens to
    // be serving, and the two taxonomies answer each other with silence.
    expect(gbifOccurrenceParams().get("checklistKey")).toBe(GBIF_CHECKLIST_KEY);
    expect(GBIF_CHECKLIST_KEY).toBe(COL_XR_CHECKLIST_KEY);
  });

  it("counts preserved specimens only when asked to", () => {
    expect(gbifOccurrenceParams().getAll("basisOfRecord")).not.toContain("PRESERVED_SPECIMEN");
    expect(
      gbifOccurrenceParams({}, { includePreservedSpecimens: true }).getAll("basisOfRecord"),
    ).toContain("PRESERVED_SPECIMEN");
  });
});

describe("preserved specimens", () => {
  it("adds them to the animal set rather than replacing it", () => {
    // A plant's total has to stay a superset of what it was: the change is meant
    // to add herbarium material, not swap one universe of records for another.
    const animals = includedBasisOfRecord(false);
    const plants = includedBasisOfRecord(true);
    for (const bor of animals) expect(plants).toContain(bor);
    expect(plants).toContain("PRESERVED_SPECIMEN");
    expect(plants).toHaveLength(animals.length + 1);
  });

  it("is off for animals and on for plants, fungi and algae", () => {
    expect(taxonGroupCountsPreservedSpecimens("mammals")).toBe(false);
    expect(taxonGroupCountsPreservedSpecimens("beetles")).toBe(false);
    expect(taxonGroupCountsPreservedSpecimens("flowering_plants")).toBe(true);
    expect(taxonGroupCountsPreservedSpecimens("mushrooms")).toBe(true);
    expect(taxonGroupCountsPreservedSpecimens("brown_algae")).toBe(true);
    // Dashboard taxon ids, which is what the country-stats route is given.
    expect(taxonGroupCountsPreservedSpecimens("plantae")).toBe(true);
    expect(taxonGroupCountsPreservedSpecimens("fungi")).toBe(true);
    expect(taxonGroupCountsPreservedSpecimens("invertebrates")).toBe(false);
    expect(taxonGroupCountsPreservedSpecimens(undefined)).toBe(false);
  });

  it("says the same thing by kingdom as by group, for every Table 1a group", () => {
    // The sync scripts decide by kingdom (they query GBIF per group and know the
    // kingdom); the runtime decides by group (it knows a species' group, not its
    // kingdom). Two expressions of one rule, so a group that answers differently
    // depending on which side asks is a plant whose count and whose map disagree.
    for (const taxon of TAXA_DEFINITIONS) {
      expect(
        kingdomCountsPreservedSpecimens(taxon.kingdomKey),
        `"${taxon.id}" (kingdom ${taxon.kingdomKey}) disagrees between the kingdom and group rules`,
      ).toBe(taxonGroupCountsPreservedSpecimens(taxon.id));
    }
  });
});

describe("GBIF_GEOSPATIAL_ISSUES", () => {
  /**
   * The viewer fetches the two sides of GBIF's `hasGeospatialIssue` filter
   * separately and in order: everything it returns for `false`, then the
   * records it excludes. This set is how the response is read back, so it has
   * to be exactly what GBIF acts on — anything extra puts records the trusted
   * query already returned into the flagged bucket, where they are painted as
   * suspect and hidden by a check nobody aimed at them.
   *
   * Verified against the live API, not the docs, with
   * `issue=<code>&hasGeospatialIssue=false`: nothing comes back for any code in
   * the set, and records come back for both of the notes.
   */
  it("holds no code GBIF reports without excluding the record over", () => {
    for (const note of GBIF_COORDINATE_NOTES) {
      expect(GBIF_GEOSPATIAL_ISSUES.has(note), `${note} is a note, not a flag`).toBe(false);
    }
  });

  it("names the two that GBIF reports but does not act on", () => {
    expect([...GBIF_COORDINATE_NOTES].sort()).toEqual([
      "COORDINATE_REPROJECTION_SUSPICIOUS",
      "GEODETIC_DATUM_INVALID",
    ]);
  });

  it("keeps the ones GBIF does exclude records over", () => {
    for (const code of [
      "ZERO_COORDINATE",
      "COORDINATE_INVALID",
      "COUNTRY_COORDINATE_MISMATCH",
      "CONTINENT_COORDINATE_MISMATCH",
      "PRESUMED_SWAPPED_COORDINATE",
    ]) {
      expect(GBIF_GEOSPATIAL_ISSUES.has(code), `${code} should be a flag`).toBe(true);
    }
  });
});
