import { describe, expect, it, vi, beforeEach } from "vitest";

const files: Record<string, string> = {};
vi.mock("fs", () => {
  const fs = {
    existsSync: (p: string) => p.endsWith("gbif-live-keys.json") && "map" in files,
    readFileSync: (p: string) => (p.endsWith("gbif-live-keys.json") ? files.map : ""),
  };
  return { default: fs, ...fs };
});
const gbifJson = vi.fn();
vi.mock("@/lib/gbif-fetch", () => ({ gbifJson: (url: string) => gbifJson(url) }));

async function load(map: Record<string, string[]>) {
  files.map = JSON.stringify(map);
  vi.resetModules();
  return import("../gbif-live-keys");
}

beforeEach(() => gbifJson.mockReset());

describe("gbif-live-keys", () => {
  // Mareca americana: VJFB9 in COL26.10 XR (the taxonomy's, and GBIF's live
  // index's), 3Y3C6 in COL26.6 XR (the snapshot's), where GBIF's records sat
  // until it finished re-indexing.
  const map = { VJFB9: ["VJFB9", "3Y3C6"] };
  const counts = (byKey: Record<string, number>) =>
    gbifJson.mockImplementation(async (url?: string) => ({ count: byKey[/taxonKey=([^&]+)/.exec(url ?? "")?.[1] ?? ""] ?? 0 }));

  it("asks with the key itself, and makes no request, when nothing differs", async () => {
    const { liveGbifKey } = await load(map);
    expect(await liveGbifKey("4CGXP")).toBe("4CGXP");
    expect(gbifJson).not.toHaveBeenCalled();
  });

  it("asks with the first id GBIF has re-filed the records under", async () => {
    const { liveGbifKey } = await load(map);
    counts({ VJFB9: 3_248_445, "3Y3C6": 0 });
    expect(await liveGbifKey("VJFB9")).toBe("VJFB9");
    expect(gbifJson).toHaveBeenCalledTimes(1);
  });

  it("falls back to the snapshot's id while GBIF is still re-filing", async () => {
    const { liveGbifKey } = await load(map);
    counts({ VJFB9: 0, "3Y3C6": 3_248_445 });
    expect(await liveGbifKey("VJFB9")).toBe("3Y3C6");
  });

  it("asks GBIF once per species within the hour", async () => {
    const { liveGbifKey } = await load(map);
    counts({ VJFB9: 5 });
    await liveGbifKey("VJFB9");
    await liveGbifKey("VJFB9");
    expect(gbifJson).toHaveBeenCalledTimes(1);
  });

  it("maps a key GBIF returns back to the one the lists use", async () => {
    const { liveKeys, appKey } = await load(map);
    const keys = await liveKeys();
    expect(appKey(keys, "3Y3C6")).toBe("VJFB9");
    expect(appKey(keys, "VJFB9")).toBe("VJFB9");
    expect(appKey(keys, "4CGXP")).toBe("4CGXP");
  });

  it("reads a sync's file from before the list: { key: live id } means the live id, then the key", async () => {
    const { liveKeys, queryKeys } = await load({ "3Y3C6": "VJFB9" } as unknown as Record<string, string[]>);
    expect(queryKeys(await liveKeys(), "3Y3C6")).toEqual(["VJFB9", "3Y3C6"]);
  });
});
