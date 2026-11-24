/**
 * The judge (scripts/sync/checks/judge.ts) with `claude` stubbed: which species
 * are easy, the facts it is given, how its answer is scored, the cache, and Goal 2.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { isEasy, score, ourAnswer, judge, goal2, outcome, change, ANSWER_SCHEMA, PROMPT, facts, type Answer } from "../sync/checks/judge";
import { claudeArgs, resultOf, toolUse, type ClaudeRun } from "../sync/checks/claude-run";
import { leaks, secretsToScanFor, summarise, transcriptPath } from "../sync/checks/judge-transcripts";
import type { ColRecord, ColSpecies, Selection, SpeciesInput } from "../sync/link/select";

const spc: ColSpecies = { id: "S", name: "Panthera leo", authorship: "(Linnaeus, 1758)", class: "mammalia", kingdom: "animalia", phylum: "chordata" };
const rec = (id: string, over: Partial<ColRecord> = {}): ColRecord => ({ id, name: "Panthera leo", authorship: "(Linnaeus, 1758)", rank: "SPECIES", status: "ACCEPTED", species: spc, ...over });
const sel = (over: Partial<Selection> = {}): Selection => ({ sis: 1, step: 4, reason: null, doubts: [], groups: 1, untakenSpecies: [], decision: null, candidateSpecies: [],
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
    expect(score(ourAnswer(s), [{ id: "S", relation: "part of" }], look)).toBe("wrong");
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
    const inputs = { species: [sp], decisions: new Map(), confirmations: new Map(), release: {
      assessedNames: new Set(["panthera leo", "panthera tigris"]), byId: () => undefined, occurrencesUnder: (id: string) => (id === "FL" ? 7 : 0),
      recordsNamed: (n: string) => (n === "Felis leo" ? [rec("FL", { name: "Felis leo", status: "SYNONYM", species: tigris })] : []) } };
    const f = facts(sp, { class: "Mammalia" }, inputs);
    expect(f.col_records.map((r) => [r.id, r.gbif_records_under, r.col_species_assessed_separately])).toEqual([["FL", 7, true], ["S", 0, false]]);
    expect(JSON.stringify(f)).not.toMatch(/relation|doubt|step/);
    expect(f).not.toHaveProperty("notes_from_people");
    const noted = facts(sp, { class: "Mammalia" }, inputs, [{ sis: 1, redlistName: "Panthera leo", note: "Felis leo is meant only in part", by: "someone", date: "2026-11-24" }]);
    expect(noted.notes_from_people).toEqual([{ note: "Felis leo is meant only in part", by: "someone", date: "2026-11-24" }]);
  });
});

describe("outcome (decide)", () => {
  const look = { speciesOf: (id: string) => ({ S: "S", S2: "S", P: "O", O: "O" } as Record<string, string>)[id], under: () => 10 };
  const known = new Set(["S", "S2", "P", "O"]);
  const ans = (records: Answer["records"]): Answer => ({ sis_taxon_id: 1, records, reason: "r", sources: ["https://x"] });
  const ours = [{ id: "S", relation: "is" }];
  it("confirms when every run counts what the rules count, even naming other records of the same species", () => {
    expect(outcome([ans([{ id: "S", relation: "is" }]), ans([{ id: "S2", relation: "is" }])], ours, look, known)).toEqual({ kind: "confirm" });
  });
  it("decides when every run agrees and the rules don't", () => {
    const o = outcome([ans([{ id: "P", relation: "part of" }]), ans([{ id: "P", relation: "part of" }])], ours, look, known);
    expect(o).toMatchObject({ kind: "decide", answer: { records: [{ id: "P", relation: "part of" }] } });
  });
  it("splits when runs differ, one can't tell or is missing, or a record isn't in the facts", () => {
    expect(outcome([ans([{ id: "P", relation: "part of" }]), ans([{ id: "S", relation: "is" }])], ours, look, known).kind).toBe("split");
    expect(outcome([ans([{ id: "P", relation: "part of" }]), ans("can't tell")], ours, look, known).kind).toBe("split");
    expect(outcome([ans([{ id: "P", relation: "part of" }]), undefined], ours, look, known).kind).toBe("split");
    expect(outcome([ans([{ id: "NOPE", relation: "is" }]), ans([{ id: "NOPE", relation: "is" }])], ours, look, known).kind).toBe("split");
  });
  it("says how a decision changes the counts", () => {
    expect(change(ours, [{ id: "P", relation: "part of" }], look)).toBe("adds part + drops whole");
    expect(change(ours, [...ours, { id: "O", relation: "split into" }], look)).toBe("adds whole");
  });
});

describe("judge", () => {
  it("asks in batches with the spec's flags, and answers a rerun from the cache", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-test-"));
    const calls: ClaudeRun[] = [];
    const runner = async (r: ClaudeRun) => {
      calls.push(r);
      const batch = JSON.parse(r.stdin!) as { sis_taxon_id: number }[];
      return { code: 0, stderr: "", stdout: JSON.stringify({ structured_output: { answers: batch.map((b) => ({ sis_taxon_id: b.sis_taxon_id, records: "can't tell", reason: "r", sources: [] })) } }) };
    };
    const many = Array.from({ length: 25 }, (_, i) => ({ sis_taxon_id: i + 1 })) as never[];
    const a = await judge(many, { cacheDir, runner });
    expect(a.size).toBe(25);
    // Each call's transcript is kept, and each answer names the call it came from.
    const t = a.get(1)!.transcript!;
    expect(fs.existsSync(transcriptPath(cacheDir, t))).toBe(true);
    expect(a.get(21)!.transcript).not.toBe(t);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ tools: ["WebSearch", "WebFetch"], outputFormat: "stream-json", schema: ANSWER_SCHEMA, prompt: PROMPT });
    expect(calls[0].disallowed).toEqual(["WebFetch(domain:dashforlife.org)", "WebFetch(domain:vercel.app)"]);
    await judge(many, { cacheDir, runner });
    expect(calls).toHaveLength(2);
    // A second run asks again, in another order (other batch-mates), and is cached apart.
    const b = await judge(many, { cacheDir, runner, run: 2 });
    expect(b.size).toBe(25);
    expect(calls).toHaveLength(4);
    expect(calls[2].stdin).not.toBe(calls[0].stdin);
    await judge(many, { cacheDir, runner, run: 2 });
    expect(calls).toHaveLength(4);
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
  });
});
