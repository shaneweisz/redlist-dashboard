/**
 * When assessment-link.ts takes GBIF's matcher's answer without review
 * (scripts/sync/link/accept-match.ts). Cases are real answers from matching-ws
 * against COL26.6 XR, trimmed to the fields the rule reads.
 */
import { describe, it, expect } from "vitest";
import { acceptMatch, type MatchAnswer } from "../sync/link/accept-match";

const answer = (over: Partial<MatchAnswer>): MatchAnswer => ({
  matcher_col_id: "U1", matcher_name: "Puma concolor", matcher_authorship: "(Linnaeus, 1771)", matcher_rank: "SPECIES",
  matcher_status: "ACCEPTED", match_type: "EXACT", confidence: 100, alternatives: [], ...over,
});
const speciesOf = (ids: Record<string, string | null>) => (id: string) => (id in ids ? ids[id] : id);
const puma = { name: "Puma concolor", authority: "(Linnaeus, 1771)" };

describe("acceptMatch", () => {
  it("takes an exact, certain, unique species", () => {
    expect(acceptMatch(puma, answer({}), speciesOf({}))).toEqual({ accepted: true, why: "unique name" });
  });

  it("takes a synonym that leads to an accepted species", () => {
    expect(acceptMatch(puma, answer({ matcher_status: "SYNONYM" }), speciesOf({ U1: "S1" })).accepted).toBe(true);
  });

  it.each([
    [{ match_type: "VARIANT", matcher_name: "Puma concolar" }, "spelling variant"],
    [{ match_type: "HIGHERRANK", matcher_rank: "GENUS" }, "no species match"],
    [{ matcher_col_id: null }, "no species match"],
    [{ matcher_status: "PROVISIONALLY_ACCEPTED" }, "provisional name"],
    [{ matcher_status: "AMBIGUOUS_SYNONYM" }, "ambiguous synonym"],
    [{ matcher_status: "MISAPPLIED" }, "misapplied name"],
    [{ matcher_rank: "SUBSPECIES" }, "matched another rank"],
    [{ confidence: 95 }, "lower confidence"],
  ] as [Partial<MatchAnswer>, string][])("queues %o as %s", (over, reason) => {
    expect(acceptMatch(puma, answer(over), speciesOf({}))).toEqual({ accepted: false, reason });
  });

  it("takes a spelling variant the codes' rules make the same name, whatever its confidence (Pseudechis pailsi / pailsei)", () => {
    const m = answer({ match_type: "VARIANT", confidence: 92, matcher_name: "Pseudechis pailsei", matcher_authorship: "(Hoser, 1998)" });
    expect(acceptMatch({ name: "Pseudechis pailsi", authority: "(Hoser, 1998)" }, m, speciesOf({}))).toEqual({ accepted: true, why: "unique name", variant: true });
  });

  it("queues a spelling variant by other authors, or one the rules don't make the same name", () => {
    const other = answer({ match_type: "VARIANT", matcher_name: "Pseudechis pailsei", matcher_authorship: "Smith, 1900" });
    expect(acceptMatch({ name: "Pseudechis pailsi", authority: "(Hoser, 1998)" }, other, speciesOf({}))).toEqual({ accepted: false, reason: "spelling variant" });
    const sabine = answer({ match_type: "FUZZY", matcher_name: "Agrotis sabura", matcher_authorship: null });
    expect(acceptMatch({ name: "Agrotis sabine", authority: null }, sabine, speciesOf({}))).toEqual({ accepted: false, reason: "spelling variant" });
  });

  it("queues a synonym by other authors: the species CoL dropped (Tritoma bipustulata)", () => {
    const m = answer({ matcher_status: "SYNONYM", matcher_name: "Tritoma bipustulata", matcher_authorship: "Schilsky, 1888" });
    expect(acceptMatch({ name: "Tritoma bipustulata", authority: "Fabricius, 1775" }, m, speciesOf({ U1: "Mycetophagus" })))
      .toEqual({ accepted: false, reason: "synonym by other authors" });
    // The same authors written differently, or an authority missing on either side, still count as a rename.
    expect(acceptMatch({ name: "Tritoma bipustulata", authority: "(Fabr., 1775)" }, answer({ matcher_status: "SYNONYM",
      matcher_authorship: "Fabricius, 1775" }), speciesOf({ U1: "S1" })).accepted).toBe(true);
    expect(acceptMatch({ name: "Tritoma bipustulata", authority: null }, m, speciesOf({ U1: "S1" })).accepted).toBe(true);
    // A year out, a misspelling, or a bare "L.": not evidence of another author.
    const syn = (au: string) => answer({ matcher_status: "SYNONYM", matcher_authorship: au });
    expect(acceptMatch({ name: "Drepanis coccinea", authority: "(Forster, 1781)" }, syn("(Forster, 1780)"), speciesOf({ U1: "S1" })).accepted).toBe(true);
    expect(acceptMatch({ name: "Meandrina danae", authority: "Milen-Edwards & Haime, 1948" }, syn("(Milne Edwards & Haime, 1848)"), speciesOf({ U1: "S1" })).accepted).toBe(true);
    expect(acceptMatch({ name: "Epilobium angustifolium", authority: "L." }, syn("L."), speciesOf({ U1: "S1" })).accepted).toBe(true);
  });

  it("queues a synonym that leads nowhere (Vestia roschitzi)", () => {
    expect(acceptMatch(puma, answer({ matcher_status: "SYNONYM" }), speciesOf({ U1: null })))
      .toEqual({ accepted: false, reason: "synonym of no species" });
  });

  it("queues names the Red List marks as unsettled (Heliotropium aff. wagneri, [non Vierh.])", () => {
    const m = answer({ matcher_name: "Heliotropium wagneri", matcher_authorship: "Vierh." });
    expect(acceptMatch({ name: "Heliotropium aff. wagneri", authority: null }, m, speciesOf({})).accepted).toBe(false);
    expect(acceptMatch({ name: "Heliotropium wagneri", authority: "[non Vierh.]" }, m, speciesOf({})).accepted).toBe(false);
    expect(acceptMatch({ name: "Begonia sp. nov.", authority: null }, m, speciesOf({})).accepted).toBe(false);
  });

  it("takes a bracketed year in the authority: a publication date, not a doubt", () => {
    expect(acceptMatch({ name: "Puma concolor", authority: "(Linnaeus, [1771])" }, answer({}), speciesOf({})).accepted).toBe(true);
  });

  describe("a same-name rival leading to another species", () => {
    const plant = { col_id: "R1", name: "Centropogon australis", authorship: "Gleason", rank: "SPECIES", status: "ACCEPTED" };
    const fish = answer({ matcher_name: "Centropogon australis", matcher_authorship: "(White, 1790)", alternatives: [plant] });

    it("is taken when the Red List's authors pick the match", () => {
      expect(acceptMatch({ name: "Centropogon australis", authority: "(White, 1790)" }, fish, speciesOf({})))
        .toEqual({ accepted: true, why: "authors pick it" });
    });

    it("is queued when the authors don't decide", () => {
      expect(acceptMatch({ name: "Centropogon australis", authority: null }, fish, speciesOf({})))
        .toEqual({ accepted: false, reason: "homonym the authors don't decide" });
    });

    it("is taken when the rival has the match's own authors: CoL holding it twice", () => {
      const twin = answer({ alternatives: [{ ...plant, name: "Puma concolor", authorship: "(Linnaeus, 1771)" }] });
      expect(acceptMatch(puma, twin, speciesOf({}))).toEqual({ accepted: true, why: "CoL holds it twice" });
    });

    it("is queued when the twin is accepted and the match a synonym (Sipyloidea brevicerci)", () => {
      const m = answer({ matcher_status: "SYNONYM", matcher_name: "Sipyloidea brevicerci", matcher_authorship: "Hasenpusch & Brock, 2007",
        alternatives: [{ col_id: "R1", name: "Sipyloidea brevicerci", authorship: "Hasenpusch & Brock, 2007", rank: "SPECIES", status: "ACCEPTED" }] });
      expect(acceptMatch({ name: "Sipyloidea brevicerci", authority: "Hasenpusch & Brock, 2007" }, m, speciesOf({ U1: "Tersomia" })))
        .toEqual({ accepted: false, reason: "accepted and a synonym in CoL" });
    });

    it("is queued when the Red List cites a rival's authors exactly, not the twins' (Sambucus nigra Lour.)", () => {
      const m = answer({ matcher_name: "Sambucus nigra", matcher_authorship: "L.", alternatives: [
        { col_id: "R1", name: "Sambucus nigra", authorship: "L.", rank: "SPECIES", status: "SYNONYM" },
        { col_id: "R2", name: "Sambucus nigra", authorship: "Lour.", rank: "SPECIES", status: "SYNONYM" }] });
      expect(acceptMatch({ name: "Sambucus nigra", authority: "Lour." }, m, speciesOf({ R1: "S1", R2: "ebulus" })))
        .toEqual({ accepted: false, reason: "authors point to another record" });
    });

    it("doesn't take one author in two roles as twins (Malaxis brachystachys)", () => {
      const m = answer({ matcher_status: "SYNONYM", matcher_name: "Malaxis brachystachys", matcher_authorship: "(Lindl.) Rchb.fil.", alternatives: [
        { col_id: "R1", name: "Malaxis brachystachys", authorship: "(Rchb.f.) Kuntze", rank: "SPECIES", status: "SYNONYM" },
        { col_id: "R2", name: "Malaxis brachystachys", authorship: "(Rchb.f.) Kuntze", rank: "SPECIES", status: "SYNONYM" }] });
      expect(acceptMatch({ name: "Malaxis brachystachys", authority: "(Rchb.f.) Kuntze" }, m, speciesOf({ U1: "Oberonia", R1: "realdelmontensis", R2: "realdelmontensis" })))
        .toEqual({ accepted: false, reason: "homonym the authors don't decide" });
    });

    it("takes an accepted match beside CoL's provisional copy of it (Cygnus buccinator)", () => {
      const m = answer({ matcher_name: "Cygnus buccinator", matcher_authorship: "Richardson, 1831",
        alternatives: [{ col_id: "VN748", name: "Cygnus buccinator", authorship: "Richardson, 1832", rank: "SPECIES", status: "PROVISIONALLY_ACCEPTED" }] });
      expect(acceptMatch({ name: "Cygnus buccinator", authority: "Richardson, 1832" }, m, speciesOf({})))
        .toEqual({ accepted: true, why: "CoL holds it twice" });
    });

    it("but not a provisional name by other authors", () => {
      const m = answer({ matcher_name: "Cygnus buccinator", matcher_authorship: "Richardson, 1831",
        alternatives: [{ col_id: "VN748", name: "Cygnus buccinator", authorship: "Gould, 1850", rank: "SPECIES", status: "PROVISIONALLY_ACCEPTED" }] });
      expect(acceptMatch({ name: "Cygnus buccinator", authority: "Richardson, 1832" }, m, speciesOf({})).accepted).toBe(false);
    });

    it("takes a Linnaean name its citation picks (Urtica dioica L., beside Vell. and Thunb.)", () => {
      const m = answer({ matcher_name: "Urtica dioica", matcher_authorship: "L.", alternatives: [
        { col_id: "R1", name: "Urtica dioica", authorship: "Vell.", rank: "SPECIES", status: "AMBIGUOUS_SYNONYM" },
        { col_id: "R2", name: "Urtica dioica", authorship: "Thunb.", rank: "SPECIES", status: "AMBIGUOUS_SYNONYM" }] });
      expect(acceptMatch({ name: "Urtica dioica", authority: "L." }, m, speciesOf({ R1: "spatulata", R2: "thunbergiana" })))
        .toEqual({ accepted: true, why: "authors pick it" });
    });

    it("ignores misapplied names and rivals leading to the same species", () => {
      const m = answer({ alternatives: [{ ...plant, status: "MISAPPLIED" }, { ...plant, col_id: "R2", status: "SYNONYM" }] });
      expect(acceptMatch({ name: "Centropogon australis", authority: null }, { ...m, matcher_name: "Centropogon australis" },
        speciesOf({ R2: "U1" })).accepted).toBe(true);
    });
  });
});
