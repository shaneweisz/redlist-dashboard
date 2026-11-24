import { afterEach, describe, expect, it, vi } from "vitest";
import { currentWorks } from "../current-works";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("currentWorks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("swaps a merged record for the one it became, drops a gone one, and keeps the order", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("filter=")) return json({ results: [{ id: "https://openalex.org/W1" }, { id: "https://openalex.org/W3" }] });
      if (url.includes("/W2?")) return json({ id: "https://openalex.org/W20" });
      return json({ error: "not found" }, 404);
    }));
    expect(await currentWorks([BigInt(1), BigInt(2), BigInt(3), BigInt(4)])).toEqual([BigInt(1), BigInt(20), BigInt(3)]);
  });

  it("lists a record once when a merged one became another that's already listed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("filter=")
      ? json({ results: [{ id: "https://openalex.org/W1" }] })
      : json({ id: "https://openalex.org/W1" }))));
    expect(await currentWorks([BigInt(1), BigInt(2)])).toEqual([BigInt(1)]);
  });

  it("gives the ids back unchanged if OpenAlex can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await currentWorks([BigInt(5), BigInt(6)])).toEqual([BigInt(5), BigInt(6)]);
  });
});
