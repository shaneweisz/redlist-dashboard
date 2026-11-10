/**
 * The ids the live GBIF routes ask with (src/lib/gbif-live-keys.ts): ours, the
 * live release's, both, or none, with GBIF and ChecklistBank stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearLiveKeyCache, liveGbifKeys, setKeys, takeMatch } from "@/lib/gbif-live-keys";

const OURS = "315557";
const LIVE = "316691";

interface World {
  release?: string;
  usages?: Record<string, { name: string; authorship?: string; rank?: string }>;
  match?: { key?: string; name?: string; authorship?: string; status?: string; matchType: string };
  fail?: boolean;
}

function stub(w: World) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (w.fail) throw new Error("offline");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes("/match/metadata")) return json({ mainIndex: { clbDatasetKey: w.release ?? OURS } });
    const u = url.match(/dataset\/(\d+)\/nameusage\/([^/?]+)/);
    if (u) {
      const hit = w.usages?.[`${u[1]}/${u[2]}`];
      return hit ? json({ name: { scientificName: hit.name, authorship: hit.authorship ?? "", rank: hit.rank ?? "species" } }) : json({}, 404);
    }
    if (url.includes("/v2/species/match")) {
      const m = w.match ?? { matchType: "NONE" };
      return json({ usage: m.key ? { key: m.key, canonicalName: m.name, authorship: m.authorship, status: m.status ?? "ACCEPTED" } : undefined,
        diagnostics: { matchType: m.matchType } });
    }
    throw new Error(`unexpected ${url}`);
  }));
  return calls;
}

const wigeon = { name: "Mareca americana", authorship: "(J. F. Gmelin, 1789)" };

beforeEach(() => clearLiveKeyCache());
afterEach(() => vi.unstubAllGlobals());

describe("liveGbifKeys", () => {
  it("asks with our id alone while GBIF runs our release", async () => {
    const calls = stub({ release: OURS });
    expect(await liveGbifKeys("3Y3C6", OURS)).toEqual(["3Y3C6"]);
    expect(calls).toHaveLength(1);
  });

  it("asks with both ids once GBIF moves: its records can sit under either while it re-files", async () => {
    stub({ release: LIVE, usages: { [`${OURS}/3Y3C6`]: wigeon }, match: { key: "VJFB9", name: "Mareca americana", authorship: "(J. F. Gmelin, 1789)", matchType: "EXACT" } });
    expect(await liveGbifKeys("3Y3C6", OURS)).toEqual(["3Y3C6", "VJFB9"]);
  });

  it("takes a same-named synonym whoever's it is: GBIF files records by name (meadow foxtail)", async () => {
    stub({ release: LIVE, usages: { [`${OURS}/K1`]: { name: "Alopecurus pratensis", authorship: "L." } },
      match: { key: "C56P", name: "Alopecurus pratensis", authorship: "Bourg. ex Lange", status: "AMBIGUOUS_SYNONYM", matchType: "EXACT" } });
    expect(await liveGbifKeys("K1", OURS)).toEqual(["K1", "C56P"]);
  });

  const ours = (name: string, authorship: string) => ({ name, authorship, rank: "species" });
  const answer = (name: string, authorship: string, matchType: string, status = "ACCEPTED") =>
    ({ usage: { key: "X", canonicalName: name, authorship, status }, diagnostics: { matchType } });

  it("takes an answer only when it is our name, allowing a respelling", () => {
    // A gender ending, a dropped subgenus, one letter by the same authors.
    expect(takeMatch(ours("Machilus obovatifolia", "(Hayata) Kaneh. & Sasaki"), answer("Machilus obovatifolius", "(Hayata) Kaneh. & Sasaki", "VARIANT"))).toBe("X");
    expect(takeMatch(ours("Copris (Copris) warneri", "Mccleve & Kohlmann, 2005"), answer("Copris warneri", "Mccleve & Kohlmann, 2005", "EXACT"))).toBe("X");
    expect(takeMatch(ours("Magnolia argyrotricha", "(Lozano) Govaerts"), answer("Magnolia argyrothricha", "(Lozano) Govaerts", "VARIANT"))).toBe("X");
    // Another word, even by the same author: Tritoma bipustulata answered with T. bipustula, a Mycetophagus synonym.
    expect(takeMatch(ours("Tritoma bipustulata", "Fabricius, 1775"), answer("Tritoma bipustula", "Fabricius", "VARIANT", "SYNONYM"))).toBeNull();
    expect(takeMatch(ours("Acacia koaia", "Hillebr."), answer("Acacia koa", "A.Gray", "VARIANT"))).toBeNull();
    // A one-letter difference by unknown authors, a fuzzy or genus-only answer, another rank.
    expect(takeMatch(ours("Magnolia argyrotricha", ""), answer("Magnolia argyrothricha", "(Lozano) Govaerts", "VARIANT"))).toBeNull();
    expect(takeMatch(ours("Copris warneri", ""), answer("Copris warneri", "", "FUZZY"))).toBeNull();
    expect(takeMatch(ours("Vachellia quiterajoensis", "Timberlake & Lötter"), answer("Vachellia", "Wight & Arn.", "HIGHERRANK"))).toBeNull();
    expect(takeMatch(ours("Corvus corone cornix", ""), answer("Corvus corone", "", "EXACT"))).toBeNull();
  });

  it("refuses an accepted species of the same name by other authors, which has records of its own", () => {
    expect(takeMatch(ours("Hepatus pudibundus", "(Herbst, 1785)"), answer("Hepatus pudibundus", "Gronow, 1763", "EXACT"))).toBeNull();
    expect(takeMatch(ours("Hepatus pudibundus", "(Herbst, 1785)"), answer("Hepatus pudibundus", "(Herbst, 1785)", "EXACT"))).toBe("X");
  });

  it("keeps our id alone when the matcher answers with it, or its answer can't be taken", async () => {
    stub({ release: LIVE, usages: { [`${OURS}/3BXGS`]: { name: "Euconulus (Euconulus) trochiformis", authorship: "(Montagu, 1803)" } },
      match: { key: "3BXGS", name: "Euconulus trochiformis", authorship: "(Montagu, 1803)", status: "SYNONYM", matchType: "EXACT" } });
    expect(await liveGbifKeys("3BXGS", OURS)).toEqual(["3BXGS"]);
    clearLiveKeyCache();
    stub({ release: LIVE, usages: { [`${OURS}/V1`]: { name: "Vachellia quiterajoensis", authorship: "Timberlake & Lötter" } },
      match: { key: "G", name: "Vachellia", matchType: "HIGHERRANK" } });
    expect(await liveGbifKeys("V1", OURS)).toEqual(["V1"]);
  });

  it("falls back to our id when GBIF or ChecklistBank can't be reached, or our id isn't in our release", async () => {
    stub({ fail: true });
    expect(await liveGbifKeys("3Y3C6", OURS)).toEqual(["3Y3C6"]);
    clearLiveKeyCache();
    stub({ release: LIVE, usages: {} });
    expect(await liveGbifKeys("B8TXJ", OURS)).toEqual(["B8TXJ"]);
  });

  it("answers from its cache the second time", async () => {
    const calls = stub({ release: LIVE, usages: { [`${OURS}/3Y3C6`]: wigeon }, match: { key: "VJFB9", name: "Mareca americana", authorship: "(J. F. Gmelin, 1789)", matchType: "EXACT" } });
    await liveGbifKeys("3Y3C6", OURS);
    const n = calls.length;
    expect(await liveGbifKeys("3Y3C6", OURS)).toEqual(["3Y3C6", "VJFB9"]);
    expect(calls).toHaveLength(n);
  });
});

describe("setKeys", () => {
  it("repeats the parameter once per id", () => {
    expect(setKeys(new URLSearchParams({ taxonKey: "x", limit: "0" }), "taxonKey", ["A", "B"]).toString()).toBe("limit=0&taxonKey=A&taxonKey=B");
  });
});
