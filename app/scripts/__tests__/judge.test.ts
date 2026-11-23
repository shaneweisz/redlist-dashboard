/**
 * The judge (scripts/sync/checks/judge.ts) with `claude` stubbed: which species
 * are easy, the facts it is given, how its answer is scored, the cache, and Goal 2.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { isEasy, score, ourAnswer, judge, goal2, ANSWER_SCHEMA, PROMPT, facts } from "../sync/checks/judge";
import { claudeArgs, toolUse, type ClaudeRun } from "../sync/checks/claude-run";
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
  it("right: the same records and relations, refused counting as not taken", () => {
    const s = sel({ selected: [...sel().selected, { record: rec("R"), relation: "refused", relationStep: 5, basis: "citation" }] });
    expect(score(ourAnswer(s), [{ id: "S", relation: "is" }])).toBe("right");
    expect(score(ourAnswer(s), [{ id: "S", relation: "part of" }])).toBe("wrong");
    expect(score(ourAnswer(s), [])).toBe("wrong");
    expect(score(ourAnswer(s), "can't tell")).toBe("can't tell");
  });
});

describe("facts", () => {
  it("names every record of the species' names, with its species and whether that is assessed separately, but not our selection", () => {
    const tigris = { ...spc, id: "T", name: "Panthera tigris" };
    const sp: SpeciesInput = { sis: 1, name: "Panthera leo", authority: "(Linnaeus, 1758)", kingdom: "Animalia", phylum: "Chordata",
      synonyms: [{ name: "Felis leo", authors: ["Linnaeus, 1758"] }], match: { matchType: "EXACT", answerName: "Panthera leo", answer: rec("S"), alternatives: [] } };
    const inputs = { species: [sp], decisions: new Map(), release: {
      assessedNames: new Set(["panthera leo", "panthera tigris"]), byId: () => undefined, occurrencesUnder: (id: string) => (id === "FL" ? 7 : 0),
      recordsNamed: (n: string) => (n === "Felis leo" ? [rec("FL", { name: "Felis leo", status: "SYNONYM", species: tigris })] : []) } };
    const f = facts(sp, { class: "Mammalia" }, inputs);
    expect(f.col_records.map((r) => [r.id, r.gbif_records_under, r.col_species_assessed_separately])).toEqual([["FL", 7, true], ["S", 0, false]]);
    expect(JSON.stringify(f)).not.toMatch(/relation|doubt|step/);
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
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ tools: ["WebSearch", "WebFetch"], outputFormat: "json", schema: ANSWER_SCHEMA, prompt: PROMPT });
    expect(calls[0].disallowed).toEqual(["WebFetch(domain:dashforlife.org)", "WebFetch(domain:vercel.app)"]);
    await judge(many, { cacheDir, runner });
    expect(calls).toHaveLength(2);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe("goal2", () => {
  it("counts, per group, the species the old and the new rules have right", () => {
    const answers = new Map([[1, { sis_taxon_id: 1, records: [{ id: "S", relation: "is" }], reason: "", sources: [] }]]);
    const g = goal2([sel()], new Map([[1, [{ id: "X", relation: "is" }]]]), answers, new Map([[1, "mammalia"]]));
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
