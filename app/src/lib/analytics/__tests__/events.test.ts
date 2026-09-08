import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  activeFilters,
  newlyApplied,
  primeFilterBaseline,
  reportFilterUsage,
  resetFilterBaselines,
  FILTER_PARAMS,
} from "../events";
import { OWN_PARAM_NAMES } from "@/hooks/useFilterParams";

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));
const posthog = (await import("posthog-js")).default as unknown as {
  capture: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  resetFilterBaselines();
  posthog.capture.mockClear();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  // These helpers are client-only and guard on `window` so an accidental
  // server-side import is inert. The suite runs in node (the project has no DOM
  // environment installed), so stand one up rather than pull in jsdom for a
  // single typeof check.
  vi.stubGlobal("window", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activeFilters", () => {
  it("ignores view state that isn't a filter", () => {
    // sort/tab/species/layout say nothing about filter popularity.
    expect(activeFilters("?sort=year&tab=gbif&species=sis-123&layout=wide")).toEqual({});
  });

  it("reports a set filter with its value", () => {
    expect(activeFilters("?categories=CR,EN")).toEqual({ risk_category: "CR,EN" });
  });

  it("reports a person-valued filter WITHOUT its value", () => {
    // Third parties' names are not captured — only that the filter was used.
    expect(activeFilters("?assessors=Jane%20Doe")).toEqual({ assessor: null });
    expect(activeFilters("?institutions=Some%20University")).toEqual({ institution: null });
  });

  it("treats endemics=0 as not filtering", () => {
    expect(activeFilters("?endemics=0")).toEqual({});
    expect(activeFilters("?endemics=1")).toEqual({ endemics_only: "1" });
  });

  it("ignores an empty param value", () => {
    expect(activeFilters("?categories=")).toEqual({});
  });

  it("reads the suffixed params of a compare-mode panel", () => {
    const search = "?categories=CR&categories_b=EN";
    expect(activeFilters(search, "_b")).toEqual({ risk_category: "EN" });
    expect(activeFilters(search)).toEqual({ risk_category: "CR" });
  });

  it("truncates an over-long value", () => {
    const long = "x".repeat(500);
    expect(activeFilters(`?categories=${long}`).risk_category).toHaveLength(100);
  });

  // Guards the decoupling claim in the module doc: every param we count must
  // still be a param the filter hook actually owns.
  it("only names params that useFilterParams owns", () => {
    for (const param of Object.keys(FILTER_PARAMS)) {
      expect(OWN_PARAM_NAMES).toContain(param);
    }
  });
});

describe("newlyApplied", () => {
  it("reports a filter that just appeared", () => {
    expect(newlyApplied({}, { risk_category: "CR" })).toEqual([
      { filter: "risk_category", value: "CR" },
    ]);
  });

  it("reports a changed value on an already-active filter", () => {
    expect(newlyApplied({ risk_category: "CR" }, { risk_category: "CR,EN" })).toEqual([
      { filter: "risk_category", value: "CR,EN" },
    ]);
  });

  it("stays silent when nothing changed", () => {
    const same = { risk_category: "CR", taxon: "mammals" };
    expect(newlyApplied(same, { ...same })).toEqual([]);
  });

  it("does not report a filter being removed", () => {
    expect(newlyApplied({ risk_category: "CR" }, {})).toEqual([]);
  });
});

describe("reportFilterUsage", () => {
  it("captures one event per newly applied filter", () => {
    primeFilterBaseline("");
    reportFilterUsage("?categories=CR&taxa=mammals");
    expect(posthog.capture).toHaveBeenCalledTimes(2);
    expect(posthog.capture).toHaveBeenCalledWith("filter_applied", {
      filter: "risk_category",
      value: "CR",
    });
  });

  it("omits the value key entirely for a person-valued filter", () => {
    primeFilterBaseline("");
    reportFilterUsage("?assessors=Jane%20Doe");
    expect(posthog.capture).toHaveBeenCalledWith("filter_applied", { filter: "assessor" });
  });

  // A shared filtered link reflects whoever built it, not whoever opened it.
  it("does not count filters that arrived in the landing URL", () => {
    primeFilterBaseline("?categories=CR");
    reportFilterUsage("?categories=CR");
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("counts a filter added on top of a shared link", () => {
    primeFilterBaseline("?categories=CR");
    reportFilterUsage("?categories=CR&taxa=birds");
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("filter_applied", {
      filter: "taxon",
      value: "birds",
    });
  });

  it("does not re-count a filter left untouched across many URL writes", () => {
    primeFilterBaseline("");
    reportFilterUsage("?categories=CR");
    reportFilterUsage("?categories=CR&sort=year");
    reportFilterUsage("?categories=CR&sort=year&tab=gbif");
    expect(posthog.capture).toHaveBeenCalledTimes(1);
  });

  it("tracks compare-mode panels independently", () => {
    primeFilterBaseline("", "");
    primeFilterBaseline("", "_b");
    reportFilterUsage("?categories=CR&categories_b=EN", "_b");
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("filter_applied", {
      filter: "risk_category",
      value: "EN",
      panel: "_b",
    });
  });

  it("captures nothing when PostHog is not configured", () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    primeFilterBaseline("");
    reportFilterUsage("?categories=CR");
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  // The baseline must advance even with PostHog off, or enabling it later would
  // replay every filter already on screen as freshly applied.
  it("still advances the baseline when PostHog is not configured", () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    primeFilterBaseline("");
    reportFilterUsage("?categories=CR");
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    reportFilterUsage("?categories=CR");
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
