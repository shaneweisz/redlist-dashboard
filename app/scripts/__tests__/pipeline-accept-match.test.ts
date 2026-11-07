/**
 * When assessment-link.ts takes GBIF's matcher's answer without review
 * (scripts/sync/link/accept-match.ts). Cases are real answers from matching-ws
 * against COL26.6 XR, trimmed to the fields the rule reads.
 */
import { describe, it, expect } from "vitest";
import { acceptMatch, sameAuthors, type MatchAnswer } from "../sync/link/accept-match";

const answer = (over: Partial<MatchAnswer>): MatchAnswer => ({
  usage_id: "U1", usage_name: "Puma concolor", usage_authorship: "(Linnaeus, 1771)", usage_rank: "SPECIES",
  usage_status: "ACCEPTED", match_type: "EXACT", confidence: 100, alternatives: [], ...over,
});
const speciesOf = (ids: Record<string, string | null>) => (id: string) => (id in ids ? ids[id] : id);
const puma = { name: "Puma concolor", authority: "(Linnaeus, 1771)" };

describe("acceptMatch", () => {
  it("takes an exact, certain, unique species", () => {
    expect(acceptMatch(puma, answer({}), speciesOf({}))).toEqual({ accepted: true, why: "unique name" });
  });

  it("takes a synonym that leads to an accepted species", () => {
    expect(acceptMatch(puma, answer({ usage_status: "SYNONYM" }), speciesOf({ U1: "S1" })).accepted).toBe(true);
  });

  it.each([
    [{ match_type: "VARIANT" }, "spelling variant"],
    [{ match_type: "HIGHERRANK", usage_rank: "GENUS" }, "no species match"],
    [{ usage_id: null }, "no species match"],
    [{ usage_status: "PROVISIONALLY_ACCEPTED" }, "provisional name"],
    [{ usage_status: "AMBIGUOUS_SYNONYM" }, "ambiguous synonym"],
    [{ usage_status: "MISAPPLIED" }, "misapplied name"],
    [{ usage_rank: "SUBSPECIES" }, "matched another rank"],
    [{ confidence: 95 }, "lower confidence"],
  ] as [Partial<MatchAnswer>, string][])("queues %o as %s", (over, reason) => {
    expect(acceptMatch(puma, answer(over), speciesOf({}))).toEqual({ accepted: false, reason });
  });

  it("queues a synonym that leads nowhere (Vestia roschitzi)", () => {
    expect(acceptMatch(puma, answer({ usage_status: "SYNONYM" }), speciesOf({ U1: null })))
      .toEqual({ accepted: false, reason: "synonym of no species" });
  });

  it("queues names the Red List marks as unsettled (Heliotropium aff. wagneri, [non Vierh.])", () => {
    const m = answer({ usage_name: "Heliotropium wagneri", usage_authorship: "Vierh." });
    expect(acceptMatch({ name: "Heliotropium aff. wagneri", authority: null }, m, speciesOf({})).accepted).toBe(false);
    expect(acceptMatch({ name: "Heliotropium wagneri", authority: "[non Vierh.]" }, m, speciesOf({})).accepted).toBe(false);
    expect(acceptMatch({ name: "Begonia sp. nov.", authority: null }, m, speciesOf({})).accepted).toBe(false);
  });

  it("takes a bracketed year in the authority: a publication date, not a doubt", () => {
    expect(acceptMatch({ name: "Puma concolor", authority: "(Linnaeus, [1771])" }, answer({}), speciesOf({})).accepted).toBe(true);
  });

  describe("a same-name rival leading to another species", () => {
    const plant = { usage_id: "R1", name: "Centropogon australis", authorship: "Gleason", rank: "SPECIES", status: "ACCEPTED" };
    const fish = answer({ usage_name: "Centropogon australis", usage_authorship: "(White, 1790)", alternatives: [plant] });

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
      const m = answer({ usage_status: "SYNONYM", usage_name: "Sipyloidea brevicerci", usage_authorship: "Hasenpusch & Brock, 2007",
        alternatives: [{ usage_id: "R1", name: "Sipyloidea brevicerci", authorship: "Hasenpusch & Brock, 2007", rank: "SPECIES", status: "ACCEPTED" }] });
      expect(acceptMatch({ name: "Sipyloidea brevicerci", authority: "Hasenpusch & Brock, 2007" }, m, speciesOf({ U1: "Tersomia" })))
        .toEqual({ accepted: false, reason: "accepted and a synonym in CoL" });
    });

    it("ignores misapplied names and rivals leading to the same species", () => {
      const m = answer({ alternatives: [{ ...plant, status: "MISAPPLIED" }, { ...plant, usage_id: "R2", status: "SYNONYM" }] });
      expect(acceptMatch({ name: "Centropogon australis", authority: null }, { ...m, usage_name: "Centropogon australis" },
        speciesOf({ R2: "U1" })).accepted).toBe(true);
    });
  });
});

describe("sameAuthors", () => {
  it.each([
    ["Hook.f.", "Hook.fil."], ["Pitard", "Pit."], ["A.Shaw", "Airy Shaw"], ["Silhavy, 1937", "Šilhavý, 1937"],
  ])("accepts %s / %s", (a, b) => expect(sameAuthors(a, b)).toBe(true));
  it.each([["(Férussac, 1921)", "(A. Férussac, 1821)"], ["Macfarlane", "Hemsl."]])("refuses %s / %s", (a, b) => expect(sameAuthors(a, b)).toBe(false));
});
