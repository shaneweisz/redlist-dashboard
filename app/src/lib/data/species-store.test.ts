import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs and csv modules before importing the module under test
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
}));

import * as fs from "fs";
import { getCreditCandidates, getColRevisions, _resetCaches, type CreditSource } from "./species-store";
import type { CandidateRank } from "@/lib/credit-candidates";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestRedlistRow {
  sis_taxon_id: number;
  assessment_id: number;
  scientific_name: string;
  common_name: string | null;
  class_name: string | null;
  order_name: string | null;
  family: string | null;
  category: string;
  assessment_date: string | null;
  year_published: string;
  population_trend: string | null;
  countries: string[];
  taxon_group_table1a: string;
}

interface TestAssessment {
  id: number;
  year: string;
  category: string;
  date: string | null;
  assessors: string | null;
  reviewers: string | null;
  /** Optional in the files too — see PreviousAssessment. */
  facilitators?: string | null;
}

type HistoryMap = Record<string, TestAssessment[]>;

let nextId = 1;
function makeRow(overrides: Partial<TestRedlistRow> = {}): TestRedlistRow {
  const id = nextId++;
  return {
    sis_taxon_id: id,
    assessment_id: id * 100,
    scientific_name: "Testus species",
    common_name: null,
    class_name: "Mammalia",
    order_name: "Carnivora",
    family: "Felidae",
    category: "VU",
    assessment_date: "2020-01-01",
    year_published: "2020",
    population_trend: null,
    countries: [],
    taxon_group_table1a: "mammals",
    ...overrides,
  };
}

let groupCounter = 0;
function uniqueGroup(): string {
  return `test_group_${groupCounter++}`;
}

let source: CreditSource = { rows: [], history: {} };
function setup(rows: TestRedlistRow[], history: HistoryMap = {}) {
  source = { rows, history };
}

beforeEach(() => {
  nextId = 1;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** The target species every test below ranks candidates for, unless overridden. */
const LION = {
  scientificName: "Panthera leo",
  className: "Mammalia",
  orderName: "Carnivora",
  family: "Felidae",
};

function target(group: string, overrides: Partial<typeof LION> = {}) {
  return { taxonGroup: group, ...LION, ...overrides };
}

/** Every candidate's counts at one rank, keyed by name. */
function tiersAt(result: ReturnType<typeof getCreditCandidates>, rank: CandidateRank) {
  return Object.fromEntries(result.candidates.map((c) => [c.name, c.tiers[rank]]));
}

describe("getCreditCandidates", () => {
  it("returns no candidates when nothing has been assessed", () => {
    const group = uniqueGroup();
    setup([]);
    expect(getCreditCandidates("assessors", target(group), ["ZA"], source).candidates).toEqual([]);
  });

  it("returns no candidates when assessed species share no country with the target", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["BR"], scientific_name: "Panthera onca" });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Brazil", reviewers: null },
      ],
    });
    expect(getCreditCandidates("assessors", target(group), ["ZA"], source).candidates).toEqual([]);
  });

  // ── rank tiering ──────────────────────────────────────────────────────────

  it("credits a species at the deepest rank it shares with the target", () => {
    const group = uniqueGroup();
    const sameGenus = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    const sameFamily = makeRow({ countries: ["ZA"], scientific_name: "Acinonyx jubatus", family: "Felidae" });
    const sameOrder = makeRow({ countries: ["ZA"], scientific_name: "Canis mesomelas", family: "Canidae" });
    const sameClassOnly = makeRow({ countries: ["ZA"], scientific_name: "Otomys irroratus", family: "Muridae", order_name: "Rodentia" });
    const rows = [sameGenus, sameFamily, sameOrder, sameClassOnly];
    setup(rows, Object.fromEntries(rows.map((r, i) => [String(r.sis_taxon_id), [
      { id: i, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Everywhere", reviewers: null },
    ]])));

    const result = getCreditCandidates("assessors", target(group), ["ZA"], source);
    const [candidate] = result.candidates;
    // Each rank counts everything at or below it: genus 1, family 2, order 3, group 4.
    expect(candidate.tiers.genus?.total).toBe(1);
    expect(candidate.tiers.family?.total).toBe(2);
    expect(candidate.tiers.order?.total).toBe(3);
    expect(candidate.tiers.group?.total).toBe(4);
  });

  it("rolls a deeper match up past a rank the row has no value for", () => {
    const group = uniqueGroup();
    // Same genus, but this row records no family or order at all — it must still
    // count toward the target's family and order, not fall out of them.
    const row = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus", family: null, order_name: null });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Cat", reviewers: null },
      ],
    });

    const tiers = getCreditCandidates("assessors", target(group), ["ZA"], source).candidates[0].tiers;
    expect(tiers.genus?.total).toBe(1);
    expect(tiers.family?.total).toBe(1);
    expect(tiers.order?.total).toBe(1);
    expect(tiers.group?.total).toBe(1);
  });

  it("counts a species once per person however many assessments credit them", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2008", category: "LC", date: "2008-01-01", assessors: "Dr. Cat", reviewers: null },
        { id: 2, year: "2016", category: "VU", date: "2016-01-01", assessors: "Dr. Cat", reviewers: null },
      ],
    });
    expect(getCreditCandidates("assessors", target(group), ["ZA"], source).candidates[0].tiers.genus?.total).toBe(1);
  });

  it("matches lineage case-insensitively", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["ZA"], scientific_name: "Acinonyx jubatus", family: "FELIDAE" });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Cat", reviewers: null },
      ],
    });
    const t = target(group, { family: "felidae" });
    expect(getCreditCandidates("assessors", t, ["ZA"], source).candidates[0].tiers.family?.total).toBe(1);
  });

  // ── countries and regions ─────────────────────────────────────────────────

  it("separates species in the target's countries from the rest of the rank", () => {
    const group = uniqueGroup();
    const here = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    const elsewhere = makeRow({ countries: ["IN"], scientific_name: "Panthera tigris" });
    setup([here, elsewhere], {
      [String(here.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Cat", reviewers: null },
      ],
      [String(elsewhere.sis_taxon_id)]: [
        { id: 2, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Cat", reviewers: null },
      ],
    });

    const tiers = getCreditCandidates("assessors", target(group), ["ZA"], source).candidates[0].tiers;
    expect(tiers.genus?.total).toBe(2);
    expect(tiers.genus?.inRegion).toBe(1);
  });

  it("aggregates per-region and per-country counts within the rank", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["ZA", "KE", "BR"], scientific_name: "Panthera pardus" });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Cat", reviewers: null },
      ],
    });

    const tier = getCreditCandidates("assessors", target(group), ["ZA", "KE"], source).candidates[0].tiers.genus!;
    expect(tier.countryCounts).toEqual({ ZA: 1, KE: 1 });
    // Only the target's own countries are aggregated — BR isn't one of them.
    expect(Object.values(tier.regionCounts).reduce((a, b) => a + b, 0)).toBe(2);
  });

  // ── dates ─────────────────────────────────────────────────────────────────

  it("dates a person by their own latest assessment, not the species'", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2009", category: "LC", date: "2009-01-01", assessors: "Dr. Old", reviewers: null },
        { id: 2, year: "2023", category: "VU", date: "2023-01-01", assessors: "Dr. New", reviewers: null },
      ],
    });

    const tiers = tiersAt(getCreditCandidates("assessors", target(group), ["ZA"], source), "genus");
    expect(tiers["Dr. Old"]?.latestDate).toBe("2009-01-01");
    expect(tiers["Dr. New"]?.latestDate).toBe("2023-01-01");
  });

  it("carries the deepest tier's date up to the broader ranks", () => {
    const group = uniqueGroup();
    const genusRow = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    const orderRow = makeRow({ countries: ["ZA"], scientific_name: "Canis mesomelas", family: "Canidae" });
    setup([genusRow, orderRow], {
      [String(genusRow.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Cat", reviewers: null },
      ],
      [String(orderRow.sis_taxon_id)]: [
        { id: 2, year: "2014", category: "LC", date: "2014-01-01", assessors: "Dr. Cat", reviewers: null },
      ],
    });

    const tiers = getCreditCandidates("assessors", target(group), ["ZA"], source).candidates[0].tiers;
    expect(tiers.genus?.latestDate).toBe("2020-01-01");
    expect(tiers.order?.latestDate).toBe("2020-01-01");
  });

  // ── names ─────────────────────────────────────────────────────────────────

  it("splits a multi-name credit string into one candidate per person", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Bauer, H., Packer, C. & Durant, S.", reviewers: null },
      ],
    });
    const names = getCreditCandidates("assessors", target(group), ["ZA"], source).candidates.map((c) => c.name).sort();
    expect(names).toEqual(["Bauer, H.", "Durant, S.", "Packer, C."]);
  });

  it("drops a credit too short to be a name", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Ab", reviewers: null },
      ],
    });
    expect(getCreditCandidates("assessors", target(group), ["ZA"], source).candidates).toEqual([]);
  });

  it("strips parenthetical affiliations and merges them under one candidate", () => {
    const group = uniqueGroup();
    const row1 = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    const row2 = makeRow({ countries: ["ZA"], scientific_name: "Panthera tigris" });
    setup([row1, row2], {
      [String(row1.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Amori, G. (Small Nonvolant Mammal Red List Authority)", reviewers: null },
      ],
      [String(row2.sis_taxon_id)]: [
        { id: 2, year: "2021", category: "LC", date: "2021-01-01", assessors: "Amori, G.", reviewers: null },
      ],
    });

    const result = getCreditCandidates("assessors", target(group), ["ZA"], source);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].name).toBe("Amori, G.");
    expect(result.candidates[0].tiers.genus?.total).toBe(2);
  });

  // ── roles ─────────────────────────────────────────────────────────────────

  it("reads each role off its own credit column", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Assessor", reviewers: "Dr. Reviewer", facilitators: "Dr. Facilitator" },
      ],
    });

    expect(getCreditCandidates("assessors", target(group), ["ZA"], source).candidates.map((c) => c.name)).toEqual(["Dr. Assessor"]);
    expect(getCreditCandidates("reviewers", target(group), ["ZA"], source).candidates.map((c) => c.name)).toEqual(["Dr. Reviewer"]);
    expect(getCreditCandidates("facilitators", target(group), ["ZA"], source).candidates.map((c) => c.name)).toEqual(["Dr. Facilitator"]);
  });

  // The facilitator line is the whole point for organisationally-assessed groups:
  // every bird assessment credits "BirdLife International" as the assessor, so
  // only this role can name a person.
  it("tiers facilitators by lineage like any other role", () => {
    const group = uniqueGroup();
    const sameFamily = makeRow({ countries: ["ZA"], scientific_name: "Acinonyx jubatus", family: "Felidae" });
    const sameOrder = makeRow({ countries: ["ZA"], scientific_name: "Canis mesomelas", family: "Canidae" });
    setup([sameFamily, sameOrder], {
      [String(sameFamily.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "BirdLife International", reviewers: null, facilitators: "Symes, A." },
      ],
      [String(sameOrder.sis_taxon_id)]: [
        { id: 2, year: "2019", category: "LC", date: "2019-01-01", assessors: "BirdLife International", reviewers: null, facilitators: "Symes, A." },
      ],
    });

    const tiers = getCreditCandidates("facilitators", target(group), ["ZA"], source).candidates[0].tiers;
    expect(tiers.family?.total).toBe(1);
    expect(tiers.order?.total).toBe(2);
  });

  it("returns no facilitators when the history predates the field", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    // History JSON written before sources/assessments.ts emitted facilitators has
    // no such key at all — that must read as "nobody", never throw.
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Assessor", reviewers: null },
      ],
    });
    expect(getCreditCandidates("facilitators", target(group), ["ZA"], source).candidates).toEqual([]);
  });

  it("returns no reviewers when species carry assessors only", () => {
    const group = uniqueGroup();
    const row = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    setup([row], {
      [String(row.sis_taxon_id)]: [
        { id: 1, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Assessor", reviewers: null },
      ],
    });
    expect(getCreditCandidates("reviewers", target(group), ["ZA"], source).candidates).toEqual([]);
  });

  // ── which ranks are offered ───────────────────────────────────────────────

  it("offers every rank the target has a value for", () => {
    const group = uniqueGroup();
    const rodent = makeRow({ countries: ["ZA"], scientific_name: "Otomys irroratus", order_name: "Rodentia", family: "Muridae" });
    setup([rodent, makeRow({ countries: ["ZA"], scientific_name: "Panthera leo" })]);
    // class_name is Mammalia on both rows, so the class rank would just restate
    // the group and is left out; the rest of the lineage is present.
    expect(getCreditCandidates("assessors", target(group), ["ZA"], source).ranks).toEqual(["group", "order", "family", "genus"]);
  });

  it("offers a class rank only when the class is narrower than the group", () => {
    const group = uniqueGroup();
    const mammal = makeRow({ countries: ["ZA"], scientific_name: "Panthera leo", class_name: "Mammalia" });
    const bird = makeRow({ countries: ["ZA"], scientific_name: "Struthio camelus", class_name: "Aves", order_name: "Struthioniformes", family: "Struthionidae" });
    setup([mammal, bird]);
    expect(getCreditCandidates("assessors", target(group), ["ZA"], source).ranks).toContain("class");
  });

  it("omits ranks the target has no lineage value for", () => {
    const group = uniqueGroup();
    setup([makeRow({ countries: ["ZA"] })]);
    const t = { taxonGroup: group, scientificName: "Incertae sedis", className: null, orderName: null, family: null };
    expect(getCreditCandidates("assessors", t, ["ZA"], source).ranks).toEqual(["group", "genus"]);
  });

  // ── which rank the tab opens on ───────────────────────────────────────────

  it("opens on the finest rank with enough people to compare", () => {
    const group = uniqueGroup();
    // Three people share the target's family; only one shares its genus, which is
    // too thin a list to open on.
    const genusRow = makeRow({ countries: ["ZA"], scientific_name: "Panthera pardus" });
    const familyRows = [1, 2, 3].map((n) => makeRow({ countries: ["ZA"], scientific_name: `Felis number${n}`, family: "Felidae" }));
    setup([genusRow, ...familyRows], {
      [String(genusRow.sis_taxon_id)]: [
        { id: 0, year: "2020", category: "LC", date: "2020-01-01", assessors: "Dr. Alone", reviewers: null },
      ],
      ...Object.fromEntries(familyRows.map((r, i) => [String(r.sis_taxon_id), [
        { id: i + 1, year: "2020", category: "LC", date: "2020-01-01", assessors: `Dr. Number${i}`, reviewers: null },
      ]])),
    });

    expect(getCreditCandidates("assessors", target(group), ["ZA"], source).defaultRank).toBe("family");
  });

  it("falls back to the taxon group when no finer rank has candidates", () => {
    const group = uniqueGroup();
    const rows = [1, 2, 3].map((n) => makeRow({ countries: ["ZA"], scientific_name: `Otomys number${n}`, order_name: "Rodentia", family: "Muridae" }));
    setup(rows, Object.fromEntries(rows.map((r, i) => [String(r.sis_taxon_id), [
      { id: i, year: "2020", category: "LC", date: "2020-01-01", assessors: `Dr. Number${i}`, reviewers: null },
    ]])));
    // Nobody has worked on a cat, so only the group-wide ranking has anyone in it.
    expect(getCreditCandidates("assessors", target(group), ["ZA"], source).defaultRank).toBe("group");
  });
});

// ---------------------------------------------------------------------------
// getColRevisions — the on-disk encoding is deliberately terse (short keys,
// omitted fields), so the decoder is exactly the kind of thing that breaks
// silently: a wrong key name yields a flag with everything undefined, and the
// UI just stops flagging rather than throwing. These pin the wire format.
// ---------------------------------------------------------------------------
describe("getColRevisions", () => {
  beforeEach(() => {
    _resetCaches();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
  });

  const load = (file: unknown) => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(file));
    return getColRevisions();
  };

  it("expands every short key onto its long name", () => {
    const map = load({ species: { "41775": { r: "lumped", d: "Sus scrofa", i: 123, dc: "SUSSC", c: "7PST9", n: "Sus x", s: [["Sus y", "SUSY1"]] } } });
    expect(map.get(41775)).toEqual({
      reason: "lumped", detail: "Sus scrofa", detailId: 123, detailColId: "SUSSC",
      colId: "7PST9", colName: "Sus x", splitInto: [{ name: "Sus y", colId: "SUSY1" }],
    });
  });

  it("expands the accepted-name signal, including its boolean", () => {
    // gd ships as 1 rather than true to keep the file small; a decoder that
    // passed it through would put `genusDiffers: 1` on the flag and silently send
    // every genus transfer to the wrong bar.
    const map = load({ species: { "7": { an: "Sibirenauta elongata", ac: "ABC12", gd: 1 } } });
    expect(map.get(7)).toEqual({
      acceptedName: "Sibirenauta elongata", acceptedColId: "ABC12", genusDiffers: true,
    });
  });

  it("leaves genusDiffers off a plain rename rather than setting it false", () => {
    const map = load({ species: { "8": { an: "Dalbergia emirnensis", ac: "XYZ99" } } });
    expect(map.get(8)).toEqual({ acceptedName: "Dalbergia emirnensis", acceptedColId: "XYZ99" });
    expect("genusDiffers" in map.get(8)!).toBe(false);
  });

  it("keeps a split name with no CoL record as plain text rather than a dead link", () => {
    const map = load({ species: { "1": { s: [["Sus y", ""], ["Sus z", "SUSZ1"]] } } });
    expect(map.get(1)!.splitInto).toEqual([{ name: "Sus y" }, { name: "Sus z", colId: "SUSZ1" }]);
  });

  it("keys by number, not by the string the JSON object uses", () => {
    const map = load({ species: { "811": { s: [["Alcelaphus cokii", "L7YRS"]] } } });
    expect(map.get(811)).toBeTruthy();
    expect(map.has(811)).toBe(true);
  });

  it("omits absent fields rather than setting them undefined", () => {
    const map = load({ species: { "811": { s: [["Alcelaphus cokii", "L7YRS"]], c: "BHBY" } } });
    // A split-only flag has no no-match reason at all.
    expect(map.get(811)).toEqual({ colId: "BHBY", splitInto: [{ name: "Alcelaphus cokii", colId: "L7YRS" }] });
    expect("reason" in map.get(811)!).toBe(false);
  });

  it("drops an empty split list instead of carrying a flag that means nothing", () => {
    const map = load({ species: { "1": { r: "no_link" }, "2": { s: [] } } });
    expect(map.get(1)).toEqual({ reason: "no_link" });
    expect(map.get(2)).toEqual({});
  });

  it("returns an empty map when the file is missing, so a stale sync still serves species", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(getColRevisions().size).toBe(0);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it("tolerates a file with no species key", () => {
    expect(load({ counts: {}, total: 0 }).size).toBe(0);
  });

  it("reads the file once and caches it for the process", () => {
    load({ species: { "1": { r: "no_link" } } });
    getColRevisions();
    getColRevisions();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });
});
