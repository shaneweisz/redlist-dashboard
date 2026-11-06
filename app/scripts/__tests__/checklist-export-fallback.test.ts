/**
 * The sync surviving the monthly window where `3LR` names a release nobody can
 * download yet.
 *
 * ChecklistBank points `3LR` at a new curated release the day CoL publishes it,
 * but building that release's ColDP export is a separate job on its own schedule
 * — one day behind for COL26.8, three for COL26.7, and still nothing four days
 * after COL26.9, which failed the 2026-09-13 sync on a bare 404, over a file
 * CoL simply had not written yet.
 *
 * So resolveChecklistDataset() probes the archive and steps back to the newest
 * release that has one. These cover the stepping-back, the guards on how far it
 * may go and what it may land on, and that the download then follows the release
 * it settled on rather than re-following the alias.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("child_process", () => ({ execFileSync: execFileSyncMock }));

import { resolveChecklistDataset, fetchChecklist } from "../sync/inputs/col-checklist";

/** The curated releases, newest first — as ChecklistBank listed them on 2026-09-14. */
const RELEASES = [
  { key: 316321, alias: "COL26.9", issued: "2026-09-11" },
  { key: 316115, alias: "COL26.8", issued: "2026-08-20" },
  { key: 315777, alias: "COL26.7", issued: "2026-07-14" },
  { key: 315448, alias: "COL26.6", issued: "2026-06-12" },
  { key: 315149, alias: "COL26.5", issued: "2026-05-11" },
  { key: 314909, alias: "COL26.4", issued: "2026-04-15" },
];

/** Every request the resolver made, so the tests can assert what it asked for. */
let requested: string[] = [];

/**
 * ChecklistBank, with `built` naming the release keys whose archive exists.
 *
 * The listing is returned UNSORTED (the live API ignores sortBy on this query and
 * answers oldest-first), so the tests exercise the resolver's own ordering rather
 * than a fixture that happens to arrive in the right order.
 */
function stubChecklistBank(built: number[]) {
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    requested.push(`${init?.method ?? "GET"} ${url}`);
    const alias = url.match(/\/dataset\/(3LR)$/)?.[1];
    if (alias) {
      const latest = RELEASES[0];
      return { ok: true, json: async () => ({ ...latest, version: latest.issued }) };
    }
    if (url.includes("/export.zip")) {
      const key = Number(url.match(/\/dataset\/(\d+)\/export\.zip/)![1]);
      return { ok: built.includes(key), status: built.includes(key) ? 200 : 404 };
    }
    if (url.includes("/dataset?")) {
      return { ok: true, json: async () => ({ result: [...RELEASES].reverse() }) };
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

beforeEach(() => {
  requested = [];
  execFileSyncMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveChecklistDataset", () => {
  it("uses the alias's own release when its archive is built", async () => {
    stubChecklistBank([316321, 316115]);
    expect(await resolveChecklistDataset()).toEqual({ key: "316321", alias: "COL26.9", issued: "2026-09-11" });
    // The common case must not pay for the fallback: one metadata call, one probe,
    // and no listing of every release CoL has ever published.
    expect(requested.some((r) => r.includes("/dataset?"))).toBe(false);
  });

  it("steps back to the newest release that has one", async () => {
    // The COL26.9 rollover exactly: the alias has moved, the export has not been
    // built, and last month's release is still downloadable.
    stubChecklistBank([316115, 315777]);
    expect(await resolveChecklistDataset()).toEqual({ key: "316115", alias: "COL26.8", issued: "2026-08-20" });
  });

  it("skips over intermediate releases that are also unbuilt", async () => {
    stubChecklistBank([315777]);
    expect((await resolveChecklistDataset()).alias).toBe("COL26.7");
  });

  it("probes the extended archive — the exact URL the download uses", async () => {
    stubChecklistBank([316321]);
    await resolveChecklistDataset();
    const probe = requested.find((r) => r.includes("/export.zip"));
    expect(probe).toBe(
      "HEAD https://api.checklistbank.org/dataset/316321/export.zip?format=ColDP&extended=true"
    );
  });

  it("only ever considers curated releases, never an XR", async () => {
    // An XR is the unreconciled taxonomy this overlay exists to CORRECT, so
    // falling back onto one would demote nothing and silently turn the overlay into a
    // no-op. origin=release is what keeps them out of the candidate list.
    stubChecklistBank([316115]);
    await resolveChecklistDataset();
    const listing = requested.find((r) => r.includes("/dataset?"))!;
    expect(listing).toContain("origin=release");
  });

  it("fails rather than walking back indefinitely", async () => {
    // Nothing built at all. Riding this out on a spring overlay would be worse
    // than a red run: the gap has never exceeded days, so a longer one is a CoL
    // problem to look at, not one to paper over.
    stubChecklistBank([]);
    await expect(resolveChecklistDataset()).rejects.toThrow(/no archive/);
    // Three candidates probed after the alias's own release, and no further.
    expect(requested.filter((r) => r.includes("/export.zip"))).toHaveLength(4);
  });
});

describe("fetchChecklist", () => {
  it("downloads the release it was handed, not the alias", async () => {
    // The fallback is only worth anything if the download follows it. Re-resolving
    // `3LR` here would land straight back on the release the resolver stepped away
    // from — and 404 again, which is the bug.
    stubChecklistBank([316115]);
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "checklist-test-"));
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "unzip") fs.writeFileSync(path.join(destDir, "NameUsage.tsv"), "col:ID\n");
      return Buffer.from("");
    });
    try {
      const dataset = await resolveChecklistDataset();
      fetchChecklist(dataset, destDir);
      const curl = execFileSyncMock.mock.calls.find(([cmd]) => cmd === "curl")!;
      expect(curl[1].join(" ")).toContain("/dataset/316115/export.zip");
      expect(curl[1].join(" ")).not.toContain("3LR");
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });
});
