import { describe, it, expect } from "vitest";
import {
  REVISION_REASONS,
  UNFLAGGED_REASONS,
  REVISION_REASON_SHORT,
  REVISION_BARS,
  REVISION_REASON_SUMMARY,
  SPLIT_REASON,
  isFlagged,
  revisionReasons,
  matchesRevisionFilter,
  noMatchSentence,
  noMatchExplanation,
  canonicalReason,
  reasonComposition,
  displayReason,
  neSynonymSentence,
  neSplitSentence,
  NE_SPLIT_EVIDENCE,
  splitSentence,
  splitSummary,
  lumpSentence,
  flattenLump,
  revisionSentences,
  colTaxonUrl,
  type ColRevision,
  newRevisionTally,
  tallyRevision,
  barTotal,
  visibleBars,
  acceptedNameSentence,
  GENUS_DIFFERS_REASON,
  RENAMED_REASON,
} from "@/lib/col-revision";

// The no-match reason codes come from classifyNoMatch (lib/data/col-breakdown);
// this file is the UI's side of that contract. A new reason added there with no
// wording here would render as a bare snake_case code, which is what these catch.
// Signals that sit alongside the no-match reasons as bars and filter values but
// are NOT produced by classifyNoMatch, so noMatchSentence has no case for them.
const PSEUDO_REASONS = new Set<string>([SPLIT_REASON, GENUS_DIFFERS_REASON, RENAMED_REASON]);

describe("revision vocabulary", () => {
  // Wording must cover the reasons the dashboard flags AND the ones it only
  // diagnoses — the SSC group view still renders those.
  const ALL_REASONS = [...REVISION_REASONS, ...UNFLAGGED_REASONS];

  it("gives every reason a short label, a summary, and both sentence framings", () => {
    for (const reason of ALL_REASONS) {
      expect(REVISION_REASON_SHORT[reason], `short label for ${reason}`).toBeTruthy();
      expect(REVISION_REASON_SUMMARY[reason], `summary for ${reason}`).toBeTruthy();
      // The pseudo-reasons are signals in their own right, not classifyNoMatch
      // verdicts, so each has its own sentence function instead.
      if (PSEUDO_REASONS.has(reason)) continue;
      for (const subject of ["Panthera leo", null]) {
        const sentence = noMatchSentence({ reason, detail: "Panthera tigris" }, subject);
        expect(sentence.before, `${reason} / subject=${subject}`).toBeTruthy();
        expect(sentence.before).not.toBe(reason); // a bare code = no case in the switch
      }
    }
  });

  it("has no label without a reason code behind it", () => {
    const codes = new Set<string>(ALL_REASONS);
    for (const key of Object.keys(REVISION_REASON_SHORT)) expect(codes.has(key)).toBe(true);
    for (const key of Object.keys(REVISION_REASON_SUMMARY)) expect(codes.has(key)).toBe(true);
  });

  it("keeps short labels short enough for a chart axis", () => {
    // The axis is 180px at 11px type — about 21 characters before it wraps to a
    // second line. The cap here is 28, not 21: synonym_of deliberately spends a
    // second line on "CoL's accepted name differs", because dropping "accepted"
    // to fit would make the label trivially true (every species has other names
    // in CoL). The cap exists to stop labels growing without anyone deciding to,
    // so it sits just above the one label that made that trade on purpose.
    for (const reason of ALL_REASONS) {
      expect(REVISION_REASON_SHORT[reason].length, reason).toBeLessThanOrEqual(28);
    }
  });

  it("keeps every BAR LABEL on a single line", () => {
    // The bars sit on the 180px axis; reason labels are rendered by the SSC panel
    // in a table cell, which has room, so only bar labels are constrained.
    //
    // 22, not the 21 this started at: "Different genus on CoL" is 22 and was
    // checked in a real browser at the real axis width, where it renders on one
    // line. The cap exists to stop labels growing without anyone deciding to,
    // so it sits at the longest label anyone has deliberately chosen.
    expect(REVISION_BARS.filter((b) => b.label.length > 22)).toEqual([]);
  });

  it("draws every reason under exactly one bar", () => {
    // A reason drawn under no bar is diagnosed and then silently dropped; one
    // drawn under two would be counted twice in the totals.
    for (const reason of REVISION_REASONS) {
      const bars = REVISION_BARS.filter((b) => b.reasons.includes(reason));
      expect(bars.map((b) => b.key), reason).toHaveLength(1);
    }
  });
});

describe("visibleBars", () => {
  const counts = { split: 160, lumped: 128, infraspecific: 42, unmatched: 5 };
  const labels = (c: Record<string, number>, sel: string[] = []) =>
    visibleBars(c, new Set(sel)).map((b) => b.bar.label);

  it("drops empty bars when nothing is selected", () => {
    // missing_from_backbone and classified_elsewhere are zero in every sync so
    // far. They must not appear just because they have a bar defined.
    expect(labels(counts)).toEqual([
      "Split on CoL", "Lumped on CoL", "Below species on CoL", "No CoL match",
    ]);
  });

  it("still drops empty bars when a DIFFERENT bar is selected", () => {
    // The regression: `count > 0 || anythingSelected` drew every empty bar as
    // soon as one filter was applied, putting "Dangling link" and "Reclassified"
    // on the card at zero.
    expect(labels(counts, ["lumped"])).not.toContain("Dangling link");
    expect(labels(counts, ["lumped"])).not.toContain("Reclassified");
  });

  it("keeps a SELECTED bar that cross-filtering has driven to zero", () => {
    // The rule the clause exists for: drop it and there is nothing left on the
    // card to click to undo the filter.
    expect(labels({ ...counts, unmatched: 0 }, ["unmatched"])).toContain("No CoL match");
    expect(labels({ ...counts, unmatched: 0 })).not.toContain("No CoL match");
  });

  it("orders by count, commonest first", () => {
    expect(visibleBars(counts, new Set()).map((b) => b.count)).toEqual([160, 128, 42, 5]);
  });
});

describe("UNFLAGGED_REASONS", () => {
  it("keeps extinct_unconfirmed out of the dashboard's bars", () => {
    // Not a taxonomic revision, and mostly a CoL data error — 25 of the 60 it
    // caught were Least Concern or Near Threatened. See UNFLAGGED_REASONS.
    expect(UNFLAGGED_REASONS).toContain("extinct_unconfirmed");
    expect(REVISION_REASONS as readonly string[]).not.toContain("extinct_unconfirmed");
  });

  it("keeps CoL's own editorial state off the card entirely", () => {
    // not_in_base and provisional describe which CoL product carries the record
    // and how sure its editors are — not whether WE can map the assessment. CoL
    // holds each exactly once, GBIF's index is built on that same extended
    // release, and 10.6M occurrence records already reach the dashboard through
    // those links. Flagging them denies a match we are actively using.
    for (const reason of ["not_in_base", "provisional", "synonym_of"]) {
      expect(UNFLAGGED_REASONS as readonly string[], reason).toContain(reason);
      expect(REVISION_REASONS as readonly string[], reason).not.toContain(reason);
      expect(REVISION_BARS.some((b) => b.reasons.includes(reason)), reason).toBe(false);
    }
  });

  it("leaves only the one reason that fails on arity", () => {
    // "No CoL match" must be literally true of everything under it: CoL holds no
    // record of the name at any status, in any release. Zero candidates. A reason
    // where CoL holds exactly one record does not belong there, however that one
    // record is filed — which is what put not_in_base, provisional and
    // synonym_of back out of the card.
    const bar = REVISION_BARS.find((b) => b.label === "No CoL match")!;
    expect(bar.reasons).toEqual(["unmatched"]);
  });

  it("still gives it wording, since the SSC group view reports it", () => {
    expect(noMatchExplanation({ reason: "extinct_unconfirmed" }, "Columba arquatrix"))
      .toContain("marks Columba arquatrix extinct");
  });
});

describe("the accepted-name signal", () => {
  const moved: ColRevision = { acceptedName: "Sibirenauta elongata", acceptedColId: "ABC12", genusDiffers: true };
  const renamed: ColRevision = { acceptedName: "Dalbergia emirnensis", acceptedColId: "XYZ99" };

  it("flags a species whose ONLY signal is a different accepted name", () => {
    // These match CoL cleanly — no reason, no split, no lump. Before this signal
    // nothing on the card caught them, which is the whole point of adding it.
    expect(isFlagged(moved)).toBe(true);
    expect(isFlagged({})).toBe(false);
  });

  it("routes each to its own bar", () => {
    expect(revisionReasons(moved)).toEqual([GENUS_DIFFERS_REASON]);
    expect(revisionReasons(renamed)).toEqual([RENAMED_REASON]);
    // A genus move and a plain rename must never both fire for one species.
    expect(revisionReasons(moved)).toHaveLength(1);
  });

  it("counts alongside the other signals rather than replacing them", () => {
    // A species can be split AND renamed; both bars must return it.
    const both: ColRevision = { ...renamed, splitInto: [{ name: "X y", colId: "Q" }] };
    expect(revisionReasons(both).sort()).toEqual([RENAMED_REASON, SPLIT_REASON].sort());
  });

  it("keeps CoL's name as its own part, so it can be linked", () => {
    const s = acceptedNameSentence(renamed, "Dalbergia campenonii")!;
    expect(s.detail).toBe("Dalbergia emirnensis");
    expect(s.before).not.toContain("Dalbergia emirnensis");
  });

  it("states it as CoL's position, never as the correct name", () => {
    for (const flag of [moved, renamed]) {
      const s = acceptedNameSentence(flag, "Aplexa elongata")!;
      const full = `${s.before}${s.detail}${s.after}`;
      expect(full).toContain("Catalogue of Life");
      // "correct", "should be" and friends would make the card an accusation.
      expect(full).not.toMatch(/correct|should be|wrong|actually/i);
    }
  });

  it("says where the difference falls", () => {
    expect(acceptedNameSentence(moved, "Aplexa elongata")!.before).toMatch(/genus/i);
    expect(acceptedNameSentence(renamed, "Dalbergia campenonii")!.before).not.toMatch(/genus/i);
  });

  it("has a terse framing for the SSC panel, which names the species already", () => {
    const s = acceptedNameSentence(renamed, null)!;
    expect(s.before).not.toContain("Dalbergia campenonii");
    expect(s.detail).toBe("Dalbergia emirnensis");
  });

  it("is null when there is no accepted-name difference", () => {
    expect(acceptedNameSentence({ reason: "unmatched" }, "Bufo bufo")).toBeNull();
  });
});

describe("isFlagged / revisionReasons", () => {
  it("treats the two signals as independent, and a species with both as belonging to both bars", () => {
    expect(revisionReasons({ reason: "lumped" })).toEqual(["lumped"]);
    expect(revisionReasons({ splitInto: [{ name: "Aepyceros petersi" }] })).toEqual([SPLIT_REASON]);
    expect(revisionReasons({ reason: "lumped", splitInto: [{ name: "Leptoxis coosaensis" }] }))
      .toEqual([SPLIT_REASON, "lumped"]);
    // Derived from the group as well, which is how the dashboard ships it.
    expect(revisionReasons({ lumpedWith: [{ name: "Dasycercus hillieri" }] })).toEqual(["lumped"]);
  });

  it("is unflagged for no flag, and for a flag carrying neither signal", () => {
    expect(isFlagged(null)).toBe(false);
    expect(isFlagged(undefined)).toBe(false);
    // An empty splitInto must not flag a species — build-col-revisions omits the
    // key entirely, but a hand-written or future-encoded entry might not.
    expect(isFlagged({ splitInto: [] })).toBe(false);
    expect(isFlagged({ colId: "ABC" })).toBe(false);
    expect(isFlagged({ reason: "unmatched" })).toBe(true);
    expect(isFlagged({ splitInto: [{ name: "Aepyceros petersi" }] })).toBe(true);
  });
});

describe("matchesRevisionFilter", () => {
  const lumped = { reason: "lumped", detail: "Sus scrofa" };
  const split = { splitInto: [{ name: "Aepyceros petersi" }] };
  const both = { reason: "lumped", splitInto: [{ name: "Leptoxis coosaensis" }] };
  const none = null;
  const no = new Set<string>();

  it("passes everything when nothing is selected", () => {
    for (const f of [lumped, split, both, none]) expect(matchesRevisionFilter(f, null, no)).toBe(true);
  });

  it("splits the world in two on the coarse toggle", () => {
    for (const f of [lumped, split, both]) {
      expect(matchesRevisionFilter(f, "flagged", no)).toBe(true);
      expect(matchesRevisionFilter(f, "clean", no)).toBe(false);
    }
    expect(matchesRevisionFilter(none, "flagged", no)).toBe(false);
    expect(matchesRevisionFilter(none, "clean", no)).toBe(true);
  });

  it("matches a species under every reason it carries", () => {
    expect(matchesRevisionFilter(both, null, new Set(["lumped"]))).toBe(true);
    expect(matchesRevisionFilter(both, null, new Set([SPLIT_REASON]))).toBe(true);
    expect(matchesRevisionFilter(split, null, new Set(["lumped"]))).toBe(false);
    expect(matchesRevisionFilter(lumped, null, new Set([SPLIT_REASON]))).toBe(false);
  });

  it("ORs multiple selected reasons", () => {
    const sel = new Set(["lumped", "unmatched"]);
    expect(matchesRevisionFilter(lumped, null, sel)).toBe(true);
    expect(matchesRevisionFilter({ reason: "unmatched" }, null, sel)).toBe(true);
    expect(matchesRevisionFilter({ reason: "provisional" }, null, sel)).toBe(false);
  });

  it("lets a reason selection win over the coarse toggle rather than contradicting it", () => {
    // A reason implies flagged, so "clean" + a reason must not cancel out to
    // "nothing matches" — the UI clears reasons when leaving flagged, and this
    // is the belt-and-braces half of that.
    expect(matchesRevisionFilter(lumped, "clean", new Set(["lumped"]))).toBe(true);
    expect(matchesRevisionFilter(none, "clean", new Set(["lumped"]))).toBe(false);
  });
});

describe("displayReason", () => {
  it("reports an accepted-name difference the way the dashboard's card does", () => {
    // Sorbus greenii / Aria greenii: same epithet, another genus.
    expect(displayReason({ reason: "synonym_of", name: "Sorbus greenii", detail: "Aria greenii" }))
      .toBe(GENUS_DIFFERS_REASON);
    // Anolis wattsi / Norops wattsii: the epithet agrees with the new genus, so
    // still a transfer — this is why the comparison canonicalises the endings.
    expect(displayReason({ reason: "synonym_of", name: "Anolis wattsi", detail: "Norops wattsii" }))
      .toBe(GENUS_DIFFERS_REASON);
    // Dalbergia campenonii / Dalbergia emirnensis: a different species, not a move.
    expect(displayReason({ reason: "synonym_of", name: "Dalbergia campenonii", detail: "Dalbergia emirnensis" }))
      .toBe(RENAMED_REASON);
    // Both parts differ — a different name, not a genus transfer.
    expect(displayReason({ reason: "synonym_of", name: "Sorbus minima", detail: "Karpatiosorbus devoniensis" }))
      .toBe(RENAMED_REASON);
    // Nothing to compare against: stays the raw reason rather than guessing.
    expect(displayReason({ reason: "synonym_of", name: "Sorbus greenii" })).toBe("synonym_of");
  });

  it("leaves every other reason alone", () => {
    expect(displayReason({ reason: "lumped", name: "A b", detail: "C d" })).toBe("lumped");
    expect(displayReason({ reason: "no_link" })).toBe("unmatched");
    expect(displayReason({})).toBeUndefined();
  });
});

describe("reasonComposition", () => {
  it("breaks one no-match number into the chart's own labels, commonest first", () => {
    const details = [
      { reason: "lumped" }, { reason: "lumped" }, { reason: "lumped" },
      { reason: "not_in_base" }, { reason: "not_in_base" },
      { reason: "provisional" },
    ];
    expect(reasonComposition(details)).toEqual([
      { reason: "lumped", label: "Lumped on CoL", count: 3 },
      { reason: "not_in_base", label: "In XR, not Base", count: 2 },
      { reason: "provisional", label: "Provisionally accepted", count: 1 },
    ]);
  });

  it("counts an accepted-name difference under the bar it is drawn in", () => {
    expect(reasonComposition([
      { reason: "synonym_of", name: "Sorbus greenii", detail: "Aria greenii" },
      { reason: "synonym_of", name: "Sus bucculentus", detail: "Sus scrofa" },
    ])).toEqual([
      { reason: GENUS_DIFFERS_REASON, label: "Different genus on CoL", count: 1 },
      { reason: RENAMED_REASON, label: "Different name on CoL", count: 1 },
    ]);
  });

  it("counts a retired code under the reason it became", () => {
    // Otherwise a shipped summaries artifact splits one reason across two
    // entries, one of them labelled with a raw code.
    expect(canonicalReason("no_link")).toBe("unmatched");
    expect(reasonComposition([{ reason: "no_link" }, { reason: "unmatched" }]))
      .toEqual([{ reason: "unmatched", label: "No CoL match", count: 2 }]);
  });

  it("skips rows with no reason rather than inventing a bucket for them", () => {
    expect(reasonComposition([{ reason: undefined }, { reason: "lumped" }]))
      .toEqual([{ reason: "lumped", label: "Lumped on CoL", count: 1 }]);
  });
});

describe("Not Evaluated explanations", () => {
  it("names the assessed species behind each, and keeps the heuristic hedged", () => {
    const syn = neSynonymSentence("Epidendrum paniculatum");
    expect(`${syn.before}${syn.detail}${syn.after}`)
      .toBe("CoL lists the assessed Epidendrum paniculatum as a synonym of this species.");
    // The linkable name stays in its own part, same rule as noMatchSentence's.
    expect(syn.detail).toBe("Epidendrum paniculatum");
    expect(syn.before).not.toContain("Epidendrum");

    const split = neSplitSentence("Giraffa camelopardalis");
    expect(`${split.before}${split.detail}${split.after}`)
      .toBe("Likely split from the assessed Giraffa camelopardalis.");
    // A name-pattern heuristic, so it may not state the split as fact.
    expect(split.before).toContain("Likely");
    // ...and the evidence a reader would check sits alongside it.
    expect(NE_SPLIT_EVIDENCE).toContain("Synonyms");
    expect(NE_SPLIT_EVIDENCE).toContain("Heuristic");
  });
});

describe("noMatchSentence", () => {
  it("names the species when it stands alone, and drops it when the UI already does", () => {
    const flag = { reason: "lumped", detail: "Sus scrofa", detailId: 41775 };
    expect(noMatchExplanation(flag, "Sus bucculentus"))
      .toBe("According to Catalogue of Life, Sus bucculentus is the same species as Sus scrofa.");
    expect(noMatchExplanation(flag, null)).toBe("CoL lists this and Sus scrofa as one species.");
  });

  it("names the third species two lumped names merged into, when there is one", () => {
    const flag = { reason: "lumped", detail: "Epimyrma ravouxi", colName: "Temnothorax ravouxi" };
    expect(noMatchExplanation(flag, "Epimyrma bernardi")).toBe(
      "According to Catalogue of Life, Epimyrma bernardi is the same species as Epimyrma ravouxi" +
      " — both are now called Temnothorax ravouxi."
    );
  });

  it("doesn't repeat the winner's name back as the merged name", () => {
    // CoL's accepted name usually IS the winner's, which read as "The same
    // species as Acer oblongum — both are now called Acer oblongum".
    const flag = { reason: "lumped", detail: "Acer oblongum", colName: "Acer oblongum" };
    expect(noMatchExplanation(flag, null)).toBe("CoL lists this and Acer oblongum as one species.");
    expect(noMatchExplanation(flag, "Acer albopurpurascens"))
      .toBe("According to Catalogue of Life, Acer albopurpurascens is the same species as Acer oblongum.");
  });

  it("keeps the linkable species in its own part, never inlined into the text", () => {
    const s = noMatchSentence({ reason: "infraspecific", detail: "Muntiacus muntjak" }, "Muntiacus montanus");
    expect(s.detail).toBe("Muntiacus muntjak");
    expect(s.before).not.toContain("Muntiacus muntjak");
    expect(s.before).toContain("Muntiacus montanus");
  });

  it("reads as a complete sentence for reasons with no second species", () => {
    expect(noMatchExplanation({ reason: "unmatched" }, "Bufo bufo"))
      .toBe("No Catalogue of Life species matches Bufo bufo, so there is nothing there to check this assessment against.");
  });

  it("explains more than it labels — the standalone sentence says more than the table one", () => {
    // The dashboard's framing argues — finding, then what follows from it. The
    // panel's states a checkable fact about CoL's own record and leaves the
    // reader to draw the rest, with a link to that record beside it.
    // Deliberately not asserting a particular word: an earlier version of this
    // test required a literal "so", which the provisional wording then dropped
    // for a better sentence.
    for (const reason of REVISION_REASONS) {
      if (PSEUDO_REASONS.has(reason) || reason === "lumped") continue; // their own summaries
      const flag = { reason, detail: "Panthera tigris" };
      const full = noMatchExplanation(flag, "Panthera leo").split(" ").length;
      const terse = noMatchExplanation(flag, null).split(" ").length;
      // Beyond simply inserting the two-word subject name.
      expect(full, reason).toBeGreaterThan(terse + 2);
    }
  });

  it("keeps the SSC panel's framing terse — it renders in a table column", () => {
    // The column is ~240px, so past about a dozen words a row runs to a third
    // and fourth line. The cap is also what keeps the panel's statement of what
    // CoL records from growing into the tooltip's argument about what it means.
    for (const reason of REVISION_REASONS) {
      if (reason === SPLIT_REASON) continue;
      const terse = noMatchExplanation({ reason, detail: "Panthera tigris" }, null);
      expect(terse.split(" ").length, reason).toBeLessThanOrEqual(12);
    }
  });

  it("leads with the accepted name when a reclassified record differs in name", () => {
    // 186 of genus Sorbus's 187 rows: CoL accepts the species under another
    // genus in the SAME family, so naming the family said nothing ("CoL files
    // this record under Rosaceae (Rosales)", under Rosaceae).
    expect(noMatchExplanation({ reason: "classified_elsewhere", name: "Sorbus greenii", colName: "Aria greenii" }, null))
      .toBe("CoL uses another genus, accepting Aria greenii.");
    expect(noMatchExplanation({ reason: "classified_elsewhere", name: "Sorbus greenii", colName: "Aria greenii" }, "Sorbus greenii"))
      .toBe("Catalogue of Life uses a different genus for Sorbus greenii, accepting Aria greenii.");
    // Genus AND family differ (Sapindaceae -> Rosaceae, epithet kept): the name
    // first, the placement after it, since both are true and one is the finding.
    expect(noMatchExplanation({ reason: "classified_elsewhere", name: "Nephelium topengii", colName: "Prunus topengii", colGroup: "Rosaceae (Rosales)" }, null))
      .toBe("CoL uses another genus, accepting Prunus topengii, in Rosaceae (Rosales).");
    // A different species entirely, in a different family.
    expect(noMatchExplanation({ reason: "classified_elsewhere", name: "Aa mandonii", colName: "Myrosmodes nubigenum", colGroup: "Orchidaceae (Asparagales)" }, null))
      .toBe("CoL accepts a different name: Myrosmodes nubigenum, in Orchidaceae (Asparagales).");
    // Counted under the bar the dashboard would draw it in, not as "Reclassified".
    expect(displayReason({ reason: "classified_elsewhere", name: "Sorbus greenii", colName: "Aria greenii" }))
      .toBe(GENUS_DIFFERS_REASON);
  });

  it("says WHICH group CoL files a reclassified record under", () => {
    // "A different group" is the entire finding; without the group there is
    // nothing to check and nothing to act on. 708 rows in the current SSC
    // summaries carry this reason.
    expect(noMatchExplanation({ reason: "classified_elsewhere", colGroup: "Valloniidae (Stylommatophora)" }, null))
      .toBe("CoL files this record under Valloniidae (Stylommatophora).");
    expect(noMatchExplanation({ reason: "classified_elsewhere", colGroup: "Valloniidae (Stylommatophora)" }, "Vallonia costata"))
      .toContain("under Valloniidae (Stylommatophora)");
    // No placement recorded at all — say the little that is true, not a blank.
    expect(noMatchExplanation({ reason: "classified_elsewhere" }, null))
      .toBe("CoL files this record under a different group.");
    // Same name, different placement: the placement is the whole finding.
    expect(noMatchExplanation({ reason: "classified_elsewhere", name: "Vallonia costata", colName: "Vallonia costata", colGroup: "Valloniidae (Stylommatophora)" }, null))
      .toBe("CoL files this record under Valloniidae (Stylommatophora).");
  });

  it("names the CoL id behind a dangling link", () => {
    // The id is the actionable part: it is what a reader pastes into CoL, and
    // what makes "no longer resolves" a claim they can falsify.
    expect(noMatchExplanation({ reason: "missing_from_backbone", colId: "7FDLW" }, null))
      .toBe("Links to CoL id 7FDLW, which this release doesn't hold.");
  });

  it("renders a retired reason code as words, not as the code", () => {
    // 322 rows in the shipped ssc-group-children-summaries.json still carry
    // "no_link", the pre-rename name for "unmatched" — which the panel was
    // printing verbatim into its Explanation column.
    expect(noMatchExplanation({ reason: "no_link" }, null))
      .toBe(noMatchExplanation({ reason: "unmatched" }, null));
    // And anything else unrecognised says what the row is, not what the code is.
    expect(noMatchExplanation({ reason: "some_future_code" }, null))
      .toBe("No 1:1 Catalogue of Life match for this name.");
  });

  it("does not promise the checklist will add a name it has declined", () => {
    // "hasn't added it yet" implied a backlog; most of these are old names in
    // genera the checklist covers thoroughly. See noMatchSentence's not_in_base.
    const sentence = noMatchExplanation({ reason: "not_in_base" }, "Euphorbia ankarensis");
    expect(sentence).not.toContain("yet");
    expect(sentence).toContain("extended release");
  });

  it("falls back to words rather than to the raw code", () => {
    // It used to render the code itself, on the reasoning that a code beats
    // "undefined". It does, but only just: a sync built before "no_link" was
    // renamed to "unmatched" is still shipping that code, and the panel printed
    // the string "no_link" into its Explanation column for 322 species. Both
    // halves are covered above, in "renders a retired reason code as words".
    expect(noMatchExplanation({ reason: "some_future_reason" }, "Bufo bufo"))
      .toBe("No 1:1 Catalogue of Life match for this name.");
  });
});

describe("splitSummary", () => {
  const vallonia = {
    colId: "7FDLW",
    splitInto: [
      { name: "Vallonia gracilicosta", colId: "7FDMB", previousName: "Vallonia costata var. montana Sterki, 1893", previousColId: "7V9Y8" },
      { name: "Vallonia parvula", colId: "7TKP7", previousName: "Vallonia costata var. minor Sterki, 1893", previousColId: "7V9Y7" },
      { name: "Vallonia patens", colId: "7TKP8", previousName: "Vallonia costata var. amurensis Sterki in Pilsbry, 1893", previousColId: "7V9Y5" },
    ],
  };

  it("is null when there are no splits", () => {
    expect(splitSummary({ reason: "lumped" }, "Sus scrofa")).toBeNull();
    expect(splitSummary({ splitInto: [] }, "Sus scrofa")).toBeNull();
  });

  it("leads with what the split means for the assessment", () => {
    expect(splitSummary(vallonia, "Vallonia costata")!.lead).toBe(
      "Catalogue of Life suggests Vallonia costata is split into 4 separate species," +
      " so this assessment may cover populations now assigned to the others:"
    );
  });

  it("says 'the other species' when there is only one", () => {
    const lead = splitSummary({ splitInto: [{ name: "Aepyceros petersi" }] }, "Aepyceros melampus")!.lead;
    expect(lead).toContain("split into 2 separate species");
    expect(lead.endsWith("now assigned to the other species:")).toBe(true);
  });

  it("counts the species the old concept split into, but lists only the others", () => {
    // "split into 4" while listing 3 is right — the assessed species is the
    // fourth, and "the others" at the end of the lead is what says so.
    const entries = splitSummary(vallonia, "Vallonia costata")!.entries;
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.name)).toEqual(["Vallonia gracilicosta", "Vallonia parvula", "Vallonia patens"]);
  });

  it("carries the old name behind each split in full, with its own CoL record", () => {
    // This is the evidence, and CoL only shows it from the NEW species' page —
    // so the tooltip has to carry it or the claim can't be checked by hand.
    const first = splitSummary(vallonia, "Vallonia costata")!.entries[0];
    expect(first.previousName).toBe("Vallonia costata var. montana Sterki, 1893");
    expect(first.previousColId).toBe("7V9Y8");
  });

  it("lists every split-off species, however long the tail", () => {
    // Rubus fruticosus has 73. The tooltip pages through them rather than the
    // list standing in for names it doesn't show.
    const names = Array.from({ length: 73 }, (_, i) => ({ name: `Rubus sp${i}` }));
    const summary = splitSummary({ splitInto: names }, "Rubus fruticosus")!;
    expect(summary.lead).toContain("split into 74 separate species");
    expect(summary.entries).toHaveLength(73);
  });

  it("hedges both the heuristic and its consequence", () => {
    const lead = splitSummary(vallonia, "Vallonia costata")!.lead;
    expect(lead).toContain("suggests");
    expect(lead).toContain("may cover");
  });

  it("flattens to a single string for contexts that can't hold links", () => {
    const flat = splitSentence(vallonia, "Vallonia costata")!;
    expect(flat).toContain("Vallonia gracilicosta (previously Vallonia costata var. montana Sterki, 1893)");
    expect(flat).not.toContain("unchanged");
  });
});

describe("lumpSentence", () => {
  const sus = {
    reason: "lumped", colId: "53HGR", lumpedUnder: "Sus scrofa",
    lumpedWith: [{ name: "Sus scrofa", category: "LC" }],
  };
  const limonium = {
    colId: "72FJ7", lumpedUnder: "Limonium roridum",
    lumpedWith: [
      { name: "Limonium dolihiense", colId: "72DMW", category: "EN" },
      { name: "Limonium helenae", colId: "72DP8", category: "EN" },
    ],
  };

  it("is null unless the group is known", () => {
    expect(lumpSentence({ splitInto: [{ name: "A" }] }, "X")).toBeNull();
    // The SSC panel's data carries only the tie-break winner, so callers there
    // fall back to noMatchSentence rather than rendering an empty sentence.
    expect(lumpSentence({ reason: "lumped", detail: "Sus scrofa" }, "Sus bucculentus")).toBeNull();
  });

  it("keeps CoL's name as its own part, so it can be linked", () => {
    const c = { colId: "347N2", lumpedUnder: "Dasycercus cristicauda",
      lumpedWith: [{ name: "Dasycercus hillieri", category: "LC" }] };
    const l = lumpSentence(c, "Dasycercus cristicauda", "EX")!;
    expect(l.under).toEqual({ name: "Dasycercus cristicauda", colId: "347N2" });
    expect(l.mid).not.toContain("Dasycercus");
    expect(l.after).toBe(".");
  });

  it("gives every member a link target, falling back to the shared record", () => {
    // Including the subject: the assessment that won the tie-break has no
    // no-match detail, so its col_id comes from the group.
    const l = lumpSentence(limonium, "Limonium crateriforme", "EN")!;
    expect(l.members.every((m) => m.colId)).toBe(true);
    expect(l.members[0].colId).toBe("72FJ7");
  });

  it("reads as one sentence naming every assessment and CoL's name for them", () => {
    const c = { colId: "347N2", lumpedUnder: "Dasycercus cristicauda",
      lumpedWith: [{ name: "Dasycercus hillieri", category: "LC" }] };
    expect(flattenLump(lumpSentence(c, "Dasycercus cristicauda", "EX"))).toBe(
      "Catalogue of Life treats Dasycercus cristicauda (EX) and Dasycercus hillieri (LC)" +
      " as a single species, Dasycercus cristicauda."
    );
  });

  it("puts the subject first, and includes it — the sentence is about the group", () => {
    const members = lumpSentence(limonium, "Limonium crateriforme", "EN")!.members;
    expect(members.map((m) => m.name)).toEqual([
      "Limonium crateriforme", "Limonium dolihiense", "Limonium helenae",
    ]);
    expect(members[0].category).toBe("EN");
  });

  it("joins several with commas and a final 'and'", () => {
    expect(flattenLump(lumpSentence(limonium, "Limonium crateriforme", "EN")))
      .toContain("Limonium crateriforme (EN), Limonium dolihiense (EN) and Limonium helenae (EN)");
  });

  it("carries each member's own CoL record, falling back to the shared one", () => {
    const members = lumpSentence(limonium, "Limonium crateriforme", "EN")!.members;
    expect(members[1].colId).toBe("72DMW");
    // Sus scrofa is the accepted name, so it has no synonym record of its own.
    expect(lumpSentence(sus, "Sus bucculentus", "EX")!.members[1].colId).toBe("53HGR");
  });

  it("copes with no category for the subject", () => {
    expect(flattenLump(lumpSentence(limonium, "Limonium crateriforme")))
      .toContain("treats Limonium crateriforme, Limonium dolihiense (EN)");
  });
});

describe("revisionSentences", () => {
  it("shows a sentence for EVERY bar the flag is selectable by", () => {
    // Reported from the dashboard: filtered to "Below species on CoL", the row
    // for sis 111933779 opened a tooltip that only said "Lumped on CoL". A lump
    // and a no-match reason are independent, 69 species carry both, and a bar
    // must never return a row whose own tooltip withholds the finding.
    const flag = {
      reason: "infraspecific", detail: "Cryptomys hottentotus", rank: "subspecies",
      lumpedWith: [{ name: "Cryptomys natalensis", category: "LC" }],
      lumpedUnder: "Cryptomys natalensis",
    };
    const sentences = revisionSentences(flag, "Fukomys damarensis");
    expect(sentences).toHaveLength(2);
    expect(sentences.some((x) => x.includes("Cryptomys natalensis"))).toBe(true);
    expect(sentences.some((x) => x.includes("as a subspecies of Cryptomys hottentotus"))).toBe(true);
    // Every code revisionReasons offers must be answered by a sentence.
    expect(revisionReasons(flag)).toEqual(["lumped", "infraspecific"]);
  });

  it("does not repeat the lump when the group sentence already said it", () => {
    const withGroup = revisionSentences(
      { reason: "lumped", lumpedUnder: "Leptoxis picta",
        lumpedWith: [{ name: "Leptoxis picta", category: "EX" }] },
      "Leptoxis foremani",
    );
    expect(withGroup).toHaveLength(1);
  });

  it("returns one sentence per signal, no-match first", () => {
    expect(revisionSentences({ reason: "unmatched" }, "Bufo bufo")).toHaveLength(1);
    expect(revisionSentences({ splitInto: [{ name: "Bufo spinosus" }] }, "Bufo bufo")).toHaveLength(1);
    const both = revisionSentences(
      { reason: "lumped", detail: "Leptoxis picta", splitInto: [{ name: "Leptoxis coosaensis" }] },
      "Leptoxis foremani",
    );
    expect(both).toHaveLength(2);
    expect(both[0]).toContain("is the same species as Leptoxis picta");
    // With the group known, the lump half becomes the richer list instead.
    const withGroup = revisionSentences(
      { reason: "lumped", detail: "Leptoxis picta", lumpedUnder: "Leptoxis picta",
        lumpedWith: [{ name: "Leptoxis picta", category: "EX" }] },
      "Leptoxis foremani",
    );
    expect(withGroup[0]).toBe(
      "Catalogue of Life treats Leptoxis foremani and Leptoxis picta (EX)" +
      " as a single species, Leptoxis picta."
    );
    expect(both[1]).toContain("Leptoxis coosaensis");
    expect(both[1]).toContain("is split into");
  });

  it("returns nothing for a flag carrying neither signal", () => {
    expect(revisionSentences({ colId: "ABC" }, "Bufo bufo")).toEqual([]);
  });
});

describe("colTaxonUrl", () => {
  it("deep-links to the CoL record the flag is about", () => {
    expect(colTaxonUrl({ reason: "lumped", colId: "7PST9" }, "Achatinella lila"))
      .toBe("https://www.catalogueoflife.org/data/taxon/7PST9");
    expect(colTaxonUrl({ splitInto: [{ name: "Aepyceros petersi" }], colId: "64ZMM" }, "Aepyceros melampus"))
      .toBe("https://www.catalogueoflife.org/data/taxon/64ZMM");
  });

  it("falls back to a name search for the one reason with no CoL record", () => {
    expect(colTaxonUrl({ reason: "unmatched" }, "Achatinella lila"))
      .toBe("https://www.catalogueoflife.org/data/search?q=Achatinella%20lila");
  });
});

// The bars deliberately do not partition the flagged set (see RevisionTally).
// That's only defensible if the arithmetic the card prints is exactly right, so
// the identity is pinned here rather than trusted.
describe("RevisionTally", () => {
  const tally = (flags: Parameters<typeof tallyRevision>[1][]) => {
    const t = newRevisionTally();
    for (const f of flags) tallyRevision(t, f);
    return t;
  };

  it("partitions species into flagged and clean, with nothing lost", () => {
    const flags = [
      { reason: "unmatched" },
      { splitInto: [{ name: "A" }] },
      { lumpedWith: [{ name: "B" }] },
      null,
      { splitInto: [] },
    ];
    const t = tally(flags);
    expect(t.flagged + t.clean).toBe(flags.length);
    expect(t.flagged).toBe(3);
  });

  it("counts a species in every bar it belongs to, over-totalling by exactly multiSignal", () => {
    const t = tally([
      { reason: "unmatched" },
      { lumpedWith: [{ name: "B" }] },
      { lumpedWith: [{ name: "B" }], splitInto: [{ name: "C" }] }, // two signals
      { reason: "not_in_base", splitInto: [{ name: "D" }] },       // two signals
    ]);
    expect(t.counts).toEqual({ unmatched: 1, lumped: 2, split: 2, not_in_base: 1 });
    expect(t.multiSignal).toBe(2);
    expect(barTotal(t)).toBe(t.flagged + t.multiSignal);
  });

  it("makes each bar's count equal what selecting that reason returns", () => {
    // The invariant a strict partition would have broken.
    const flags = [
      { reason: "unmatched" },
      { lumpedWith: [{ name: "B" }] },
      { lumpedWith: [{ name: "B" }], splitInto: [{ name: "C" }] },
      null,
    ];
    const t = tally(flags);
    for (const reason of Object.keys(t.counts)) {
      const selected = flags.filter((f) => matchesRevisionFilter(f, null, new Set([reason])));
      expect(selected.length, `bar "${reason}" must select exactly what it counts`).toBe(t.counts[reason]);
    }
  });

  it("counts nothing for an all-clean set", () => {
    const t = tally([null, undefined, { colId: "X" }]);
    expect(t).toEqual({ counts: {}, flagged: 0, clean: 3, multiSignal: 0 });
  });
});

describe("lumping is symmetric", () => {
  // CoL's 347N2 is both Dasycercus cristicauda (EX) and Dasycercus hillieri
  // (LC). Only hillieri used to be flagged, because it matched by synonym while
  // cristicauda matched by accepted name — a tie-break, not a taxonomic fact.
  const cristicauda: ColRevision = { colId: "347N2", lumpedUnder: "Dasycercus cristicauda",
    lumpedWith: [{ name: "Dasycercus hillieri", category: "LC" }] };
  const hillieri: ColRevision = { colId: "347N2", lumpedUnder: "Dasycercus cristicauda",
    lumpedWith: [{ name: "Dasycercus cristicauda", category: "EX" }] };

  it("flags both members, not just the one that lost the tie-break", () => {
    expect(isFlagged(cristicauda)).toBe(true);
    expect(isFlagged(hillieri)).toBe(true);
  });

  it("puts both in the lumped bar without either carrying a no-match reason", () => {
    expect(revisionReasons(cristicauda)).toEqual(["lumped"]);
    expect(revisionReasons(hillieri)).toEqual(["lumped"]);
    expect(cristicauda.reason).toBeUndefined();
  });

  it("selects both when the lumped bar is clicked", () => {
    const sel = new Set(["lumped"]);
    expect(matchesRevisionFilter(cristicauda, null, sel)).toBe(true);
    expect(matchesRevisionFilter(hillieri, null, sel)).toBe(true);
  });

  it("describes each from its own side", () => {
    expect(lumpSentence(cristicauda, "Dasycercus cristicauda")!.members.map((m) => m.name))
      .toEqual(["Dasycercus cristicauda", "Dasycercus hillieri"]);
    expect(lumpSentence(hillieri, "Dasycercus hillieri")!.members.map((m) => m.name))
      .toEqual(["Dasycercus hillieri", "Dasycercus cristicauda"]);
  });
});
