/**
 * Which XR a GBIF snapshot is filed under, which the sync then uses, found by testing its keys
 * (inputs/snapshot-xr.ts): snapshots don't say, and GBIF re-indexes between them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";

const { ensureXrMock, xreleasesMock } = vi.hoisted(() => ({ ensureXrMock: vi.fn(), xreleasesMock: vi.fn() }));
vi.mock("../sync/inputs/col", () => ({ ensureXr: ensureXrMock }));
vi.mock("../sync/inputs/col-xr", () => ({ xreleases: xreleasesMock }));

import { resolveSnapshotXr } from "../sync/inputs/snapshot-xr";

const xr = (key: string, alias: string) => ({ key, alias, doi: null, issued: null });
const OLD = xr("315557", "COL26.6 XR");
const NEW = xr("316691", "COL26.10 XR");

let tmp: string;
let snap: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-xr-"));
  snap = path.join(tmp, "snap");
  fs.mkdirSync(snap);
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  // 1,000 records on A, 990 on B: B is renumbered in the newer XR.
  await conn.run(`COPY (SELECT * FROM (VALUES ('A', 1000::BIGINT), ('B', 990::BIGINT)) t(usage_key, n))
    TO '${path.join(snap, "counts-0.parquet")}' (FORMAT parquet)`);
  const usages = (ids: string[]) => {
    const file = path.join(tmp, `${ids.join("")}.tsv`);
    fs.writeFileSync(file, ["col:ID\tcol:scientificName", ...ids.map((id) => `${id}\tX`)].join("\n") + "\n");
    return file;
  };
  const byKey: Record<string, string> = { [OLD.key]: usages(["A", "B"]), [NEW.key]: usages(["A", "C"]) };
  ensureXrMock.mockReset().mockImplementation(async (x: { key: string }) => byKey[x.key]);
  xreleasesMock.mockReset().mockResolvedValue([NEW, OLD]);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveSnapshotXr", () => {
  it("passes over an XR that leaves out a slice of the records, for the one that holds them", async () => {
    expect(await resolveSnapshotXr(snap, [NEW])).toEqual(OLD);
    expect(ensureXrMock).toHaveBeenCalledTimes(2);
  });

  it("tests the likely candidates first and stops at the first fit", async () => {
    expect(await resolveSnapshotXr(snap, [OLD, NEW])).toEqual(OLD);
    expect(ensureXrMock).toHaveBeenCalledTimes(1);
  });

  it("remembers the answer beside the snapshot's counts", async () => {
    await resolveSnapshotXr(snap, [OLD]);
    ensureXrMock.mockClear();
    expect(await resolveSnapshotXr(snap, [NEW])).toEqual(OLD);
    expect(ensureXrMock).not.toHaveBeenCalled();
  });

  it("takes COL_XR_DATASET, and refuses one that doesn't fit", async () => {
    vi.stubEnv("COL_XR_DATASET", "COL26.10 XR");
    await expect(resolveSnapshotXr(snap, [OLD])).rejects.toThrow(/COL_XR_DATASET names one that doesn't/);
  });

  it("takes COL_XR_DATASET when it fits, without caching it as the snapshot's answer", async () => {
    vi.stubEnv("COL_XR_DATASET", "315557");
    expect(await resolveSnapshotXr(snap, [NEW])).toEqual(OLD);
    expect(fs.existsSync(path.join(snap, "xr.json"))).toBe(false);
  });

  it("stops when no XR fits", async () => {
    xreleasesMock.mockResolvedValue([NEW]);
    await expect(resolveSnapshotXr(snap, [])).rejects.toThrow(/no XR holds the snapshot's keys \(tried 316691\)/);
  });
});
