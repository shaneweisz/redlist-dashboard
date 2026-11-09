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

async function load(map: Record<string, string>) {
  files.map = JSON.stringify(map);
  vi.resetModules();
  return import("../gbif-live-keys");
}

beforeEach(() => gbifJson.mockReset());

describe("gbif-live-keys", () => {
  // Mareca americana: 3Y3C6 in COL26.6 XR, VJFB9 in COL26.10 XR.
  const map = { "3Y3C6": "VJFB9" };

  it("asks with the key itself, and makes no request, when the live index uses the same one", async () => {
    const { liveGbifKey } = await load(map);
    expect(await liveGbifKey("4CGXP")).toBe("4CGXP");
    expect(gbifJson).not.toHaveBeenCalled();
  });

  it("asks with the live key once GBIF has re-filed the records under it", async () => {
    const { liveGbifKey } = await load(map);
    gbifJson.mockResolvedValue({ count: 3_248_445 });
    expect(await liveGbifKey("3Y3C6")).toBe("VJFB9");
    expect(gbifJson.mock.calls[0][0]).toContain("taxonKey=VJFB9");
  });

  it("keeps the app's key while the live key still finds nothing (GBIF mid-reprocess)", async () => {
    const { liveGbifKey } = await load(map);
    gbifJson.mockResolvedValue({ count: 0 });
    expect(await liveGbifKey("3Y3C6")).toBe("3Y3C6");
  });

  it("asks GBIF once per species within the hour", async () => {
    const { liveGbifKey } = await load(map);
    gbifJson.mockResolvedValue({ count: 5 });
    await liveGbifKey("3Y3C6");
    await liveGbifKey("3Y3C6");
    expect(gbifJson).toHaveBeenCalledTimes(1);
  });

  it("maps a key GBIF returns back to the one the lists use", async () => {
    const { liveKeys, appKey } = await load(map);
    const keys = await liveKeys();
    expect(appKey(keys, "VJFB9")).toBe("3Y3C6");
    expect(appKey(keys, "4CGXP")).toBe("4CGXP");
  });
});
