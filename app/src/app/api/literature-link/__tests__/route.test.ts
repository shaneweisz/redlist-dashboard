import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getLiteratureWorks = vi.fn();
vi.mock("@/lib/data/literature-works", () => ({ getLiteratureWorks: (...a: unknown[]) => getLiteratureWorks(...a) }));
// No network in tests: the ids come back as they went in.
vi.mock("@/lib/literature/current-works", () => ({ currentWorks: async (w: bigint[]) => w }));

const { GET } = await import("../route");
const call = (qs: string) => GET(new NextRequest(`http://localhost/api/literature-link?${qs}`));

describe("/api/literature-link", () => {
  it("redirects to OpenAlex filtered to the species' works", async () => {
    getLiteratureWorks.mockResolvedValue({ works: [BigInt(7), BigInt(3)], total: 2 });
    const res = await call("sis=42&name=Panthera%20leo&since=2016-09-12");
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location")!)).toBe("https://openalex.org/works?filter=openalex:W7|W3");
    expect(getLiteratureWorks).toHaveBeenCalledWith({ sisTaxonId: 42, colId: undefined, since: "2016-09-12", limit: 100 });
  });

  it("looks an unassessed species up by its col id", async () => {
    getLiteratureWorks.mockResolvedValue({ works: [BigInt(5)], total: 1 });
    await call("col=ABC12&name=Eumops%20chiribaya");
    expect(getLiteratureWorks).toHaveBeenCalledWith({ sisTaxonId: undefined, colId: "ABC12", since: undefined, limit: 100 });
  });

  it("falls back to OpenAlex's search for the name when the works can't be read", async () => {
    getLiteratureWorks.mockImplementation(async () => { throw new Error("no such file"); });
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a); };
    try {
      const res = await call("sis=42&name=Panthera%20leo");
      expect(res.status).toBe(302);
      expect(decodeURIComponent(res.headers.get("location")!)).toContain('title_and_abstract.search:"Panthera leo"');
      expect(logged).toHaveLength(1);
    } finally {
      console.error = orig;
    }
  });

  it("refuses a request with no species, or a malformed date", async () => {
    expect((await call("name=Panthera%20leo")).status).toBe(400);
    expect((await call("sis=42&since=last-year")).status).toBe(400);
    expect((await call("col=bad%20id")).status).toBe(400);
  });
});
