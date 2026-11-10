/**
 * The curated checklist the sync reads is the release its XR was built from
 * (COL26.6 XR → COL26.6), never CoL's newest: a newer one brought CoL's later
 * taxonomy into links and counts that otherwise follow GBIF's XR.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("child_process", () => ({ execFileSync: execFileSyncMock }));

import { resolveChecklistDataset, fetchChecklist } from "../sync/inputs/col-checklist";

/** The curated releases as ChecklistBank lists them (unsorted, as the live API answers). */
const RELEASES = [
  { key: 315149, alias: "COL26.5", issued: "2026-05-11" },
  { key: 316595, alias: "COL26.10", issued: "2026-10-14" },
  { key: 315448, alias: "COL26.6", issued: "2026-06-12" },
  { key: 315777, alias: "COL26.7", issued: "2026-07-14" },
];

let requested: string[] = [];

/** ChecklistBank, with `built` naming the release keys whose archive exists. */
function stubChecklistBank(built: number[]) {
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    requested.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/export.zip")) {
      const key = Number(url.match(/\/dataset\/(\d+)\/export\.zip/)![1]);
      return { ok: built.includes(key), status: built.includes(key) ? 200 : 404 };
    }
    if (url.includes("/dataset?")) return { ok: true, json: async () => ({ result: RELEASES }) };
    throw new Error(`unexpected request: ${url}`);
  });
}

beforeEach(() => {
  requested = [];
  execFileSyncMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveChecklistDataset", () => {
  it("takes the curated release the XR was built from, not the newest", async () => {
    stubChecklistBank([315448, 316595]);
    expect(await resolveChecklistDataset({ alias: "COL26.6 XR" })).toEqual({ key: "315448", alias: "COL26.6", issued: "2026-06-12" });
  });

  it("follows the XR when GBIF moves on", async () => {
    stubChecklistBank([315448, 316595]);
    expect((await resolveChecklistDataset({ alias: "COL26.10 XR" })).key).toBe("316595");
  });

  it("stops when the XR's release isn't listed, rather than falling back to another", async () => {
    stubChecklistBank([316595]);
    await expect(resolveChecklistDataset({ alias: "COL26.11 XR" })).rejects.toThrow(/no curated release COL26.11 .*COL26.11 XR/);
  });

  it("stops when the release has no archive to download", async () => {
    stubChecklistBank([]);
    await expect(resolveChecklistDataset({ alias: "COL26.6 XR" })).rejects.toThrow(/COL26.6 \(315448\) has no archive/);
  });
});

describe("fetchChecklist", () => {
  it("downloads the release it was handed", async () => {
    stubChecklistBank([315448]);
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "checklist-test-"));
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "unzip") fs.writeFileSync(path.join(destDir, "NameUsage.tsv"), "col:ID\n");
      return Buffer.from("");
    });
    try {
      fetchChecklist(await resolveChecklistDataset({ alias: "COL26.6 XR" }), destDir);
      const curl = execFileSyncMock.mock.calls.find(([cmd]) => cmd === "curl")!;
      expect(curl[1].join(" ")).toContain("/dataset/315448/export.zip");
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });
});
