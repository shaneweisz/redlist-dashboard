/**
 * The AI taxonomic reviewers (scripts/sync/checks/ai-review.ts) with `claude` stubbed: which
 * species are easy, the facts they are given, how an answer is scored and becomes a review,
 * the cache, and Goal 2.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { isEasy, score, ourAnswer, askReviewer, goal2, findingOf, reviewRows, change, asCounted, counted, ANSWER_SCHEMA, PROMPT, facts,
  type Answer, type FactRecord } from "../sync/checks/ai-review";
import { claudeArgs, resultOf, toolUse, type ClaudeRun } from "../sync/checks/claude-run";
import { leaks, secretsToScanFor, summarise, transcriptPath } from "../sync/checks/ai-review-transcripts";
import type { ColRecord, ColSpecies, Selection, SpeciesInput } from "../sync/link/select";

const spc: ColSpecies = { id: "S", name: "Panthera leo", authorship: "(Linnaeus, 1758)", class: "mammalia", kingdom: "animalia", phylum: "chordata" };
const rec = (id: string, over: Partial<ColRecord> = {}): ColRecord => ({ id, name: "Panthera leo", authorship: "(Linnaeus, 1758)", rank: "SPECIES", status: "ACCEPTED", species: spc, ...over });
const sel = (over: Partial<Selection> = {}): Selection => ({ sis: 1, step: 3, reason: null, doubts: [], groups: 1, untakenSpecies: [], candidateSpecies: [],
  toReview: null, selected: [{ record: rec("S"), relation: "is", relationStep: 3, basis: "matcher" }], ...over });

describe("isEasy", () => {
  it("one group, no doubt, no reason, every step record is, no synonym record but refused", () => {
    expect(isEasy(sel())).toBe(true);
    expect(isEasy(sel({ doubts: ["homonym"] }))).toBe(false);
    expect(isEasy(sel({ groups: 2 }))).toBe(false);
    expect(isEasy(sel({ reason: "no candidate", selected: [] }))).toBe(false);
    expect(isEasy(sel({ selected: [{ record: rec("X"), relation: "part of", relationStep: 4, basis: "matcher" }] }))).toBe(false);
    expect(isEasy(sel({ selected: [...sel().selected, { record: rec("Y"), relation: "split into", relationStep: 2, basis: "synonym" }] }))).toBe(false);
    expect(isEasy(sel({ selected: [...sel().selected, { record: rec("Y"), relation: "refused", relationStep: 2, basis: "synonym" }] }))).toBe(true);
  });
});

describe("score", () => {
  // S is the species; S2 a synonym record under it; P a record under another species O; Z a record with no occurrences.
  const look = { speciesOf: (id: string) => ({ S: "S", S2: "S", P: "O", Z: "O", O: "O" } as Record<string, string>)[id], under: (id: string) => (id === "Z" ? 0 : 10) };
  it("right: the same records and relations, refused counting as not taken", () => {
    const s = sel({ selected: [...sel().selected, { record: rec("R"), relation: "refused", relationStep: 5, basis: "citation" }] });
    expect(score(ourAnswer(s), [{ id: "S", relation: "is" }], look)).toBe("right");
    // part of on the species' own record counts as is (count/usage_owner.sql); on a synonym record, only that record.
    expect(score(ourAnswer(s), [{ id: "S", relation: "part of" }], look)).toBe("right");
    expect(score(ourAnswer(s), [{ id: "S2", relation: "part of" }], look)).toBe("wrong");
    expect(score(ourAnswer(s), [], look)).toBe("wrong");
    expect(score(ourAnswer(s), "can't tell", look)).toBe("can't tell");
  });
  it("right when the answers count the same occurrences: a record under a species counted whole, or with none, changes nothing", () => {
    const ours = [{ id: "S", relation: "is" }];
    expect(score(ours, [{ id: "S", relation: "is" }, { id: "S2", relation: "is" }], look)).toBe("right");
    expect(score(ours, [{ id: "S", relation: "is" }, { id: "S2", relation: "part of" }], look)).toBe("right");
    expect(score(ours, [{ id: "S", relation: "is" }, { id: "Z", relation: "part of" }], look)).toBe("right");
    expect(score(ours, [{ id: "S", relation: "is" }, { id: "P", relation: "part of" }], look)).toBe("wrong");
    expect(score(ours, [{ id: "S", relation: "is" }, { id: "P", relation: "split into" }], look)).toBe("wrong");
  });
});

describe("facts", () => {
  it("names every record of the species' names, with its species and whether that is assessed separately, but not our selection", () => {
    const tigris = { ...spc, id: "T", name: "Panthera tigris" };
    const sp: SpeciesInput = { sis: 1, name: "Panthera leo", authority: "(Linnaeus, 1758)", kingdom: "Animalia", phylum: "Chordata",
      synonyms: [{ name: "Felis leo", authors: ["Linnaeus, 1758"] }], match: { matchType: "EXACT", answerName: "Panthera leo", answer: rec("S"), alternatives: [] } };
    const inputs = { species: [sp], reviews: new Map(), release: {
      assessedNames: new Set(["panthera leo", "panthera tigris"]), byId: () => undefined, occurrencesUnder: (id: string) => (id === "FL" ? 7 : 0),
      recordsNamed: (n: string) => (n === "Felis leo" ? [rec("FL", { name: "Felis leo", status: "SYNONYM", species: tigris })] : []) } };
    const f = facts(sp, { class: "Mammalia" }, inputs);
    expect(f.col_records.map((r) => [r.id, r.gbif_records_under, r.col_species_assessed_as, r.name_assessed_separately])).toEqual([["FL", 7, "Panthera tigris", false], ["S", 0, null, false]]);
    expect(f.red_list).not.toHaveProperty("taxonomic_notes");
    const extra = facts(sp, { class: "Mammalia" }, inputs, { taxonomicNotes: "x".repeat(2500), holders: new Map([["T", ["Panthera tigris", "Panthera leo"]]]) });
    expect(extra.red_list.taxonomic_notes).toHaveLength(2001);
    expect(extra.col_records[0].col_species_holds_assessed).toEqual(["Panthera tigris"]);
    expect(JSON.stringify(f)).not.toMatch(/relation|doubt|step/);
  });
});

describe("findingOf and reviewRows (review)", () => {
  // S is the species; S2 a synonym record under it; P a record under another species O, which counts whole.
  const look = { speciesOf: (id: string) => ({ S: "S", S2: "S", P: "O", O: "O" } as Record<string, string>)[id], under: () => 10 };
  const fr = (id: string, name: string, species: string, gbif: number, status = "ACCEPTED"): FactRecord => ({ id, name, authorship: "L.", status,
    col_species: { id: species, name: species === "S" ? "Panthera leo" : "Other one", authorship: null, class: null, gbif_records: gbif },
    gbif_records_under: 10, name_assessed_separately: false, col_species_assessed_as: null, col_species_holds_assessed: [], col_species_counted_whole_by: [] });
  const recs = new Map([["S", fr("S", "Panthera leo", "S", 100)], ["S2", fr("S2", "Felis leo", "S", 100, "SYNONYM")], ["P", fr("P", "Leo pardus", "O", 50, "SYNONYM")],
    ["O", fr("O", "Other one", "O", 50)]]);
  const ans = (records: Answer["records"], sources = ["https://x"]): Answer => ({ sis_taxon_id: 1, records, reason: "r", sources, transcript: "t" });
  const ours = [{ id: "S", relation: "is" }];
  it("agrees when it counts what the rules count, even naming other records of the same species", () => {
    expect(findingOf(ans([{ id: "S2", relation: "is" }]), ours, look, recs)).toEqual({ finding: "agrees", records: [] });
  });
  it("suggests other records as counting reads them: one per species counted whole, then part-of records outside those", () => {
    expect(findingOf(ans([{ id: "S", relation: "is" }, { id: "S2", relation: "is" }, { id: "O", relation: "split into" }]), ours, look, recs)).toEqual({ finding: "other records", records: [
      { id: "S", relation: "is", label: "Panthera leo", status: "accepted", species: "Panthera leo", records: 100 },
      { id: "O", relation: "split into", label: "Other one", status: "accepted", species: "Other one", records: 50 }] });
    expect(findingOf(ans([{ id: "P", relation: "part of" }]), ours, look, recs).records).toEqual([
      { id: "P", relation: "part of", label: "Leo pardus L.", status: "synonym", species: "Other one", records: 10 }]);
  });
  it("can't tell when it says so, gives no answer, names a record it wasn't given, or changes the count without a source", () => {
    expect(findingOf(ans("can't tell"), ours, look, recs).finding).toBe("can't tell");
    expect(findingOf(undefined, ours, look, recs).finding).toBe("can't tell");
    expect(findingOf(ans([{ id: "NOPE", relation: "is" }]), ours, look, recs).finding).toBe("can't tell");
    expect(findingOf(ans([{ id: "P", relation: "part of" }], []), ours, look, recs).finding).toBe("can't tell");
    expect(findingOf(ans([{ id: "S", relation: "is" }], []), ours, look, recs).finding).toBe("agrees");
  });
  it("writes one row per reviewer, with the rules' answer and basis they were given", () => {
    const sp: SpeciesInput = { sis: 1, name: "Panthera leo", authority: "(Linnaeus, 1758)", kingdom: null, phylum: null, synonyms: [], match: null };
    const rows = reviewRows(sp, sel(), [ans([{ id: "S", relation: "is" }]), ans([{ id: "P", relation: "part of" }])], look, recs, { model: "m", date: "2026-11-26", context: "c" });
    expect(rows.map((r) => [r.reviewer, r.finding, r.transcript])).toEqual([[1, "agrees", "t"], [2, "other records", "t"]]);
    expect(rows[0].rulesAnswer).toBe("Panthera leo linnaeus 1758 [accepted, of Panthera leo]: is");
    expect(rows[0].basis).toBe(rows[1].basis);
  });
  it("counts a CoL species counted whole even with no records: naming it hides it from the Not Evaluated list", () => {
    const lk = { speciesOf: (id: string) => ({ S: "S", X: "X" } as Record<string, string>)[id], under: (id: string) => (id === "X" ? 0 : 10) };
    expect(counted([{ id: "S", relation: "is" }], lk)).not.toBe(counted([{ id: "S", relation: "is" }, { id: "X", relation: "split into" }], lk));
  });
  it("reads relations as counting does: part of on a record that is its species is is, anything on a record leading nowhere is part of", () => {
    const lk = { speciesOf: (id: string) => ({ S: "S", P: "O" } as Record<string, string>)[id], under: () => 10 };
    expect(asCounted([{ id: "S", relation: "part of" }, { id: "N", relation: "is" }, { id: "P", relation: "part of" }], lk))
      .toEqual([{ id: "S", relation: "is" }, { id: "N", relation: "part of" }, { id: "P", relation: "part of" }]);
    expect(counted([{ id: "S", relation: "part of" }], lk)).toBe(counted([{ id: "S", relation: "is" }], lk));
  });
  it("says how a suggestion changes the counts", () => {
    expect(change(ours, [{ id: "P", relation: "part of" }], look)).toBe("adds part + drops whole");
    expect(change(ours, [...ours, { id: "O", relation: "split into" }], look)).toBe("adds whole");
  });
});

describe("askReviewer", () => {
  it("asks in batches with the spec's flags, and answers a rerun from the cache", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-test-"));
    const calls: ClaudeRun[] = [];
    const runner = async (r: ClaudeRun) => {
      calls.push(r);
      const batch = JSON.parse(r.stdin!) as { sis_taxon_id: number }[];
      return { code: 0, stderr: "", stdout: JSON.stringify({ structured_output: { answers: batch.map((b) => ({ sis_taxon_id: b.sis_taxon_id, records: "can't tell", reason: "r", sources: [] })) } }) };
    };
    const many = Array.from({ length: 25 }, (_, i) => ({ sis_taxon_id: i + 1 })) as never[];
    const a = await askReviewer(many, { cacheDir, runner });
    expect(a.size).toBe(25);
    // Each call's transcript is kept, and each answer names the call it came from.
    const t = a.get(1)!.transcript!;
    expect(fs.existsSync(transcriptPath(cacheDir, t))).toBe(true);
    expect(a.get(11)!.transcript).not.toBe(t);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ tools: ["WebSearch", "WebFetch"], outputFormat: "stream-json", schema: ANSWER_SCHEMA, prompt: PROMPT });
    expect(calls[0].disallowed).toEqual(["WebFetch(domain:dashforlife.org)", "WebFetch(domain:vercel.app)"]);
    await askReviewer(many, { cacheDir, runner });
    expect(calls).toHaveLength(3);
    // A second run asks again, in another order (other batch-mates), and is cached apart.
    const b = await askReviewer(many, { cacheDir, runner, run: 2 });
    expect(b.size).toBe(25);
    expect(calls).toHaveLength(6);
    expect(calls[3].stdin).not.toBe(calls[0].stdin);
    await askReviewer(many, { cacheDir, runner, run: 2 });
    expect(calls).toHaveLength(6);
    // Each species is cached apart: one more species is one more call, and new counts ask nothing again.
    await askReviewer([...many, { sis_taxon_id: 99 }] as never[], { cacheDir, runner });
    expect(calls).toHaveLength(7);
    expect(JSON.parse(calls[6].stdin!).map((f: { sis_taxon_id: number }) => f.sis_taxon_id)).toEqual([99]);
    await askReviewer(many.map((f: { sis_taxon_id: number }) => ({ ...f, col_records: [{ id: "R", gbif_records_under: 5 }] })).slice(0, 1) as never[], { cacheDir, runner });
    expect(calls).toHaveLength(8);
    await askReviewer(many.map((f: { sis_taxon_id: number }) => ({ ...f, col_records: [{ id: "R", gbif_records_under: 9 }] })).slice(0, 1) as never[], { cacheDir, runner });
    expect(calls).toHaveLength(8);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("runs up to `parallel` calls at once", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-test-"));
    let now = 0, most = 0;
    const runner = async (r: ClaudeRun) => {
      now++; most = Math.max(most, now); await new Promise((res) => setTimeout(res, 20)); now--;
      const batch = JSON.parse(r.stdin!) as { sis_taxon_id: number }[];
      return { code: 0, stderr: "", stdout: JSON.stringify({ structured_output: { answers: batch.map((b) => ({ sis_taxon_id: b.sis_taxon_id, records: "can't tell", reason: "r", sources: [] })) } }) };
    };
    const many = Array.from({ length: 55 }, (_, i) => ({ sis_taxon_id: i + 1 })) as never[];
    expect((await askReviewer(many, { cacheDir, runner, parallel: 3 })).size).toBe(55);
    expect(most).toBe(3);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("tries a failed call twice more before giving up", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-test-"));
    const two = [{ sis_taxon_id: 1 }, { sis_taxon_id: 2 }] as never[];
    let calls = 0;
    const runner = async (r: ClaudeRun) => {
      if (++calls < 3) return { code: 1, stderr: "", stdout: "" };
      const batch = JSON.parse(r.stdin!) as { sis_taxon_id: number }[];
      return { code: 0, stderr: "", stdout: JSON.stringify({ structured_output: { answers: batch.map((b) => ({ sis_taxon_id: b.sis_taxon_id, records: "can't tell", reason: "r", sources: [] })) } }) };
    };
    expect((await askReviewer(two, { cacheDir, runner, retryWaitMs: 0 })).size).toBe(2);
    expect(calls).toBe(3);
    calls = -10;
    fs.rmSync(cacheDir, { recursive: true, force: true }); fs.mkdirSync(cacheDir);
    await expect(askReviewer(two, { cacheDir, runner, retryWaitMs: 0 })).rejects.toThrow(/exited 1/);
    expect(calls).toBe(-7);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("caches nothing from a failed call or one that answers none of its batch, and keeps only the batch's own ids", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-test-"));
    const two = [{ sis_taxon_id: 1 }, { sis_taxon_id: 2 }] as never[];
    const say = (o: unknown) => async () => ({ code: 0, stderr: "", stdout: JSON.stringify(o) });
    const answer = (sis: number) => ({ sis_taxon_id: sis, records: "can't tell", reason: "r", sources: [] });
    await expect(askReviewer(two, { cacheDir, retryWaitMs: 0, runner: say({ is_error: true, result: "usage limit" }) })).rejects.toThrow(/failed/);
    await expect(askReviewer(two, { cacheDir, retryWaitMs: 0, runner: say({ result: "not json" }) })).rejects.toThrow(/none of its 2/);
    await expect(askReviewer(two, { cacheDir, retryWaitMs: 0, runner: say({ structured_output: { answers: [answer(99)] } }) })).rejects.toThrow(/none of its 2/);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json"))).toEqual([]);
    const a = await askReviewer(two, { cacheDir, retryWaitMs: 0, runner: say({ structured_output: { answers: [answer(1), answer(99)] } }) });
    expect([...a.keys()]).toEqual([1]);
    fs.rmSync(cacheDir, { recursive: true, force: true }); fs.mkdirSync(cacheDir);
    // An id answered twice, or under another name, is dropped; a record named otherwise than its id's becomes an unknown record.
    const named = [{ sis_taxon_id: 1, red_list: { name: "Aa" }, col_records: [{ id: "R", name: "Aa" }] }, { sis_taxon_id: 2, red_list: { name: "Bb" }, col_records: [] }] as never[];
    const b = await askReviewer(named, { cacheDir, retryWaitMs: 0, runner: say({ structured_output: { answers: [
      { ...answer(1), name: "Aa", records: [{ id: "R", name: "Zz", relation: "is" }] }, { ...answer(2), name: "Cc" }] } }) });
    expect([...b.keys()]).toEqual([1]);
    expect(b.get(1)!.records).toEqual([{ id: "R?named Zz", name: "Zz", relation: "is" }]);
    fs.rmSync(cacheDir, { recursive: true, force: true }); fs.mkdirSync(cacheDir);
    await expect(askReviewer(named, { cacheDir, retryWaitMs: 0, runner: say({ structured_output: { answers: [answer(1), answer(1)] } }) })).rejects.toThrow(/none of its 2/);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe("goal2", () => {
  it("counts, per group, the species the old and the new rules have right", () => {
    const answers = new Map([[1, { sis_taxon_id: 1, records: [{ id: "S", relation: "is" }], reason: "", sources: [] }]]);
    const g = goal2([sel()], new Map([[1, [{ id: "X", relation: "is" }]]]), answers, new Map([[1, "mammalia"]]),
      { speciesOf: (id) => id, under: () => 10 });
    expect(g).toEqual({ mammalia: { old: 0, new: 1, species: 1 } });
  });
});

describe("claude-run", () => {
  it("runs with no settings or MCP servers and only the tools named", () => {
    const args = claudeArgs({ prompt: "p", cwd: "/x", tools: ["Read", "Bash"], outputFormat: "stream-json" });
    expect(args).toEqual(expect.arrayContaining(["--setting-sources", "", "--strict-mcp-config", "--tools", "Read,Bash", "--verbose"]));
  });
  it("lists what a transcript read, wrote and ran", () => {
    const line = (name: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
    expect(toolUse([line("Read", { file_path: "/w/spec.md" }), line("Bash", { command: "node x.mjs" }), line("Write", { file_path: "/w/out.json" })].join("\n")))
      .toEqual({ reads: ["/w/spec.md"], writes: ["/w/out.json"], commands: ["node x.mjs"] });
  });
});

describe("transcripts", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "Copella arnoldi Catalog of Fishes" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebFetch", input: { url: "https://example.org/copella" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "Turdus rubrocanus Hodgson" } }] } }),
    JSON.stringify({ type: "result", total_cost_usd: 0.5, structured_output: { answers: [{ sis_taxon_id: 7, records: [], reason: "r", sources: [] }] } }),
  ].join("\n");
  it("reads the result from stream-json and from json", () => {
    expect(resultOf(stream)).toMatchObject({ total_cost_usd: 0.5 });
    expect(resultOf(JSON.stringify({ total_cost_usd: 1 }))).toMatchObject({ total_cost_usd: 1 });
  });
  it("summarises one species' searches and pages, counting the batch's others", () => {
    expect(summarise(stream, 7, "Copella arnoldi")).toEqual({ searches: ["Copella arnoldi Catalog of Fishes"], fetches: ["https://example.org/copella"], others: 1,
      answer: { sis_taxon_id: 7, records: [], reason: "r", sources: [] } });
  });
  it("finds a secret-named variable's value, the home folder or the git email, and reports only which", () => {
    const secrets = secretsToScanFor({ SOME_TOKEN: "tok_abcdefghijklmnop", SHORT_KEY: "x", PLAIN: "not-a-secret-value-here" });
    expect(secrets).toContain("tok_abcdefghijklmnop");
    expect(secrets).not.toContain("not-a-secret-value-here");
    expect(secrets).toContain(os.homedir());
    expect(leaks("a page mentioning tok_abcdefghijklmnop", secrets)).toEqual([secrets.indexOf("tok_abcdefghijklmnop")]);
    expect(leaks(stream, secrets)).toEqual([]);
    // An email in any variable, and a value as it reads inside a JSON string.
    expect(secretsToScanFor({ GBIF_EMAIL: "someone@example.org" })).toContain("someone@example.org");
    const quoted = secretsToScanFor({ A_SECRET: 'abc"defghijklmn' });
    expect(leaks(JSON.stringify({ text: 'abc"defghijklmn' }), quoted).length).toBeGreaterThan(0);
  });
});
