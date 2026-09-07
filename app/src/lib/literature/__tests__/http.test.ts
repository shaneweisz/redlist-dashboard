import { describe, it, expect, vi, afterEach } from "vitest";
import { MinIntervalLimiter, failed, unconfigured, quotedOrQuery } from "../sources/http";

afterEach(() => {
  vi.useRealTimers();
});

describe("MinIntervalLimiter", () => {
  it("lets the first call through immediately", async () => {
    const limiter = new MinIntervalLimiter(1_000);
    const started = Date.now();
    await limiter.acquire();
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("spaces subsequent calls by the interval", async () => {
    vi.useFakeTimers();
    const limiter = new MinIntervalLimiter(1_000);

    await limiter.acquire();

    const order: string[] = [];
    const second = limiter.acquire().then(() => order.push("second"));
    const third = limiter.acquire().then(() => order.push("third"));

    // Neither may proceed yet.
    await vi.advanceTimersByTimeAsync(900);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(200); // t = 1100
    await second;
    expect(order).toEqual(["second"]);

    await vi.advanceTimersByTimeAsync(1_000); // t = 2100
    await third;
    expect(order).toEqual(["second", "third"]);
  });

  it("rejects with an AbortError when the signal fires while waiting", async () => {
    const limiter = new MinIntervalLimiter(10_000);
    await limiter.acquire();

    const controller = new AbortController();
    const pending = limiter.acquire(controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const limiter = new MinIntervalLimiter(10_000);
    await limiter.acquire();
    await expect(limiter.acquire(AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("does not wait once the interval has already elapsed", async () => {
    const limiter = new MinIntervalLimiter(5);
    await limiter.acquire();
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await limiter.acquire();
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("failed", () => {
  it("reports a timeout distinctly from other errors", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(failed(abort)).toMatchObject({ status: "error", note: "Timed out" });
    expect(failed(new Error("socket hang up"))).toMatchObject({
      status: "error",
      note: "socket hang up",
    });
  });

  it("always returns an empty result rather than throwing", () => {
    expect(failed("something odd")).toMatchObject({ works: [], upstreamTotal: null });
  });
});

describe("unconfigured", () => {
  it("names the environment variable that would enable the source", () => {
    expect(unconfigured("BHL_API_KEY")).toMatchObject({
      status: "unconfigured",
      note: "Set BHL_API_KEY to enable this source",
    });
  });
});

describe("quotedOrQuery", () => {
  it("builds a phrase-OR query", () => {
    expect(quotedOrQuery(["Aloe vera", "Aloe verum"])).toBe('"Aloe vera" OR "Aloe verum"');
    expect(quotedOrQuery(["Panthera leo"])).toBe('"Panthera leo"');
  });
});
