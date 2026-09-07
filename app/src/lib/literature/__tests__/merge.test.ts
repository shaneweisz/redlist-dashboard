import { describe, it, expect } from "vitest";
import { dedupeWorks, mergeWorks, sortNewestFirst } from "../merge";
import { toSortStamp } from "../normalize";
import type { LiteratureWork, SourceId } from "../types";

const LABELS: Record<SourceId, string> = {
  openalex: "OpenAlex",
  zenodo: "Zenodo",
  core: "CORE",
  bhl: "Biodiversity Heritage Library",
  googlebooks: "Google Books",
  redlist: "Red List assessment",
};

function work(
  source: SourceId,
  overrides: Partial<LiteratureWork> & { title: string },
): LiteratureWork {
  const date = overrides.date ?? null;
  const precision = overrides.datePrecision ?? (date ? "day" : null);
  return {
    key: `${source}:${overrides.title}`,
    url: `https://example.org/${source}`,
    doi: null,
    date,
    datePrecision: precision,
    year: date ? Number(date.slice(0, 4)) : null,
    sortStamp: toSortStamp(date, precision),
    authors: null,
    venue: null,
    citations: null,
    type: "other",
    openAccessUrl: null,
    abstract: null,
    sources: [{ id: source, label: LABELS[source], url: `https://example.org/${source}` }],
    ...overrides,
  };
}

describe("mergeWorks", () => {
  it("keeps the best field from each source rather than picking a winner", () => {
    const openalex = work("openalex", {
      title: "Status of Panthera leo",
      doi: "10.1234/abc",
      citations: 12,
      date: "2020-05-01",
      venue: "Oryx",
    });
    const europepmc = work("zenodo", {
      title: "Status of Panthera leo",
      doi: "10.1234/abc",
      citations: 15,
      date: "2020-05-01",
      abstract: "A long and useful abstract about lions.",
      openAccessUrl: "https://example.org/oa.pdf",
    });

    const merged = mergeWorks(openalex, europepmc);

    // Citation counts are floors: take the highest anyone reports.
    expect(merged.citations).toBe(15);
    // Only Zenodo had these.
    expect(merged.abstract).toBe("A long and useful abstract about lions.");
    expect(merged.openAccessUrl).toBe("https://example.org/oa.pdf");
    // OpenAlex outranks Zenodo for scalars both supply.
    expect(merged.venue).toBe("Oryx");
    // A DOI outranks any landing page as the reader's link.
    expect(merged.url).toBe("https://doi.org/10.1234/abc");
  });

  it("records every contributing source, in priority order", () => {
    const merged = mergeWorks(
      work("redlist", { title: "T", doi: "10.1/x" }),
      work("openalex", { title: "T", doi: "10.1/x" }),
    );
    expect(merged.sources.map((s) => s.id)).toEqual(["openalex", "redlist"]);
  });

  it("keeps the most precise date whichever source supplied it", () => {
    const vague = work("openalex", { title: "T", date: "2020", datePrecision: "year" });
    const precise = work("googlebooks", { title: "T", date: "2020-04-17", datePrecision: "day" });

    const merged = mergeWorks(vague, precise);
    expect(merged.date).toBe("2020-04-17");
    expect(merged.datePrecision).toBe("day");
    expect(merged.sortStamp).toBe("2020-04-17");
  });

  it("prefers a real work type over the 'other' fallback", () => {
    const merged = mergeWorks(
      work("openalex", { title: "T", type: "other" }),
      work("bhl", { title: "T", type: "book" }),
    );
    expect(merged.type).toBe("book");
  });

  it("keeps the longer of two titles and the longer abstract", () => {
    const merged = mergeWorks(
      work("openalex", { title: "Lions", abstract: "Short." }),
      work("zenodo", { title: "Lions of the Serengeti", abstract: "A rather longer abstract." }),
    );
    expect(merged.title).toBe("Lions of the Serengeti");
    expect(merged.abstract).toBe("A rather longer abstract.");
  });
});

describe("dedupeWorks", () => {
  it("collapses records that share a DOI, whatever the title says", () => {
    const merged = dedupeWorks([
      [work("openalex", { title: "Lions of Kenya", doi: "10.1234/abc", date: "2020-01-01" })],
      [work("zenodo", { title: "LIONS OF KENYA.", doi: "https://doi.org/10.1234/ABC", date: "2020-01-01" })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources.map((s) => s.id)).toEqual(["openalex", "zenodo"]);
  });

  it("collapses records that share a title within a year of each other", () => {
    // Sources routinely disagree on print vs online year.
    const merged = dedupeWorks([
      [work("openalex", { title: "A revision of Aloe", date: "2019-11-02" })],
      [work("googlebooks", { title: "A revision of Aloe.", date: "2020-02-01" })],
    ]);
    expect(merged).toHaveLength(1);
  });

  it("keeps same-title records more than a year apart as separate works", () => {
    const merged = dedupeWorks([
      [work("openalex", { title: "Annual report", date: "2015-01-01" })],
      [work("openalex", { title: "Annual report", date: "2020-01-01" })],
    ]);
    expect(merged).toHaveLength(2);
  });

  it("merges a preprint with its published version, keeping the journal's record", () => {
    // Same work, two DOIs and two venues — the reader wants the version of
    // record, not both rows.
    const merged = dedupeWorks([
      [
        work("openalex", {
          title: "Chromosomal Evolution of the Talpinae",
          doi: "10.3390/genes14071472",
          date: "2023-07-19",
          venue: "Genes",
          type: "article",
        }),
      ],
      [
        work("openalex", {
          title: "Chromosomal Evolution of the Talpinae",
          doi: "10.20944/preprints202306.1428.v1",
          date: "2023-06-20",
          venue: "Preprints.org",
          type: "preprint",
        }),
      ],
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      doi: "10.3390/genes14071472",
      url: "https://doi.org/10.3390/genes14071472",
      venue: "Genes",
      type: "article",
    });
  });

  it("merges them whichever order they arrive in", () => {
    const preprint = work("openalex", {
      title: "A paper",
      doi: "10.20944/preprint",
      date: "2023-06-20",
      venue: "Preprints.org",
      type: "preprint",
    });
    const published = work("openalex", {
      title: "A paper",
      doi: "10.3390/published",
      date: "2023-07-19",
      venue: "Genes",
      type: "article",
    });

    for (const pools of [[[preprint], [published]], [[published], [preprint]]]) {
      const merged = dedupeWorks(pools);
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({ doi: "10.3390/published", venue: "Genes", type: "article" });
    }
  });

  it("keeps same-title records with conflicting DOIs apart", () => {
    // An article and its erratum can carry the same title in the same year.
    const merged = dedupeWorks([
      [work("openalex", { title: "Corrigendum", doi: "10.1234/aaa", date: "2020-01-01" })],
      [work("zenodo", { title: "Corrigendum", doi: "10.1234/bbb", date: "2020-01-01" })],
    ]);
    expect(merged).toHaveLength(2);
  });

  it("matches a third source that only has the DOI a merge supplied", () => {
    const merged = dedupeWorks([
      // No DOI here, so the first match has to be on title...
      [work("bhl", { title: "Flora of Somewhere", date: "2001-01-01" })],
      // ...which then contributes a DOI...
      [work("zenodo", { title: "Flora of Somewhere", doi: "10.1234/flora", date: "2001-01-01" })],
      // ...that this differently-titled record can match on.
      [work("googlebooks", { title: "Flora of Somewhere (2nd ed.)", doi: "10.1234/flora", date: "2001-01-01" })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources.map((s) => s.id)).toEqual(["zenodo", "bhl", "googlebooks"]);
  });

  it("does not merge unrelated works", () => {
    const merged = dedupeWorks([
      [
        work("openalex", { title: "Lions of Kenya", date: "2020-01-01" }),
        work("openalex", { title: "Lions of Tanzania", date: "2020-01-01" }),
      ],
    ]);
    expect(merged).toHaveLength(2);
  });

  it("returns the pool newest first with undated works last", () => {
    const merged = dedupeWorks([
      [
        work("openalex", { title: "Old", date: "1998-04-01" }),
        work("openalex", { title: "Undated" }),
        work("openalex", { title: "New", date: "2024-06-01" }),
      ],
    ]);
    expect(merged.map((w) => w.title)).toEqual(["New", "Old", "Undated"]);
  });

  it("handles empty pools", () => {
    expect(dedupeWorks([])).toEqual([]);
    expect(dedupeWorks([[], []])).toEqual([]);
  });
});

describe("sortNewestFirst", () => {
  it("breaks ties on title so the order is stable across requests", () => {
    const sorted = sortNewestFirst([
      work("openalex", { title: "Zebra", date: "2020-01-01" }),
      work("openalex", { title: "Aardvark", date: "2020-01-01" }),
    ]);
    expect(sorted.map((w) => w.title)).toEqual(["Aardvark", "Zebra"]);
  });

  it("interleaves year-only works mid-year against fully dated ones", () => {
    const sorted = sortNewestFirst([
      work("openalex", { title: "January", date: "2020-01-04" }),
      work("bhl", { title: "Year only", date: "2020", datePrecision: "year" }),
      work("openalex", { title: "December", date: "2020-12-20" }),
    ]);
    expect(sorted.map((w) => w.title)).toEqual(["December", "Year only", "January"]);
  });
});
