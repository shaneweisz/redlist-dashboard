import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  activeFilters,
  newlyApplied,
  primeFilterBaseline,
  reportFilterUsage,
  resetFilterBaselines,
  captureSearchResultSelected,
  captureSearchNoResults,
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

describe("search events", () => {
  // These fire before the SPA writes the new URL, so stand up a location that
  // has NOT been navigated yet — the state PostHog would auto-capture from.
  beforeEach(() => {
    vi.stubGlobal("window", { location: { href: "https://dashforlife.org/?taxa=mammals" } });
  });

  describe("captureSearchResultSelected", () => {
    const args = {
      query: "acrocephalus",
      resultName: "Acrocephalus sechellensis",
      resultType: "species" as const,
      resultCategory: "NT",
      rank: 0,
    };

    it("captures the entered query as a property", () => {
      captureSearchResultSelected(args);
      expect(posthog.capture).toHaveBeenCalledWith(
        "search_result_selected",
        expect.objectContaining({ query: "acrocephalus", result_name: "Acrocephalus sechellensis" })
      );
    });

    it("overrides $current_url with the search term added to the current URL", () => {
      captureSearchResultSelected(args);
      const props = posthog.capture.mock.calls[0][1];
      expect(new URL(props.$current_url).searchParams.get("search")).toBe("acrocephalus");
      // Existing params on the page are preserved.
      expect(new URL(props.$current_url).searchParams.get("taxa")).toBe("mammals");
    });

    it("truncates an over-long query in the property", () => {
      captureSearchResultSelected({ ...args, query: "x".repeat(500) });
      expect(posthog.capture.mock.calls[0][1].query).toHaveLength(100);
    });

    it("omits $current_url and captures nothing extra when there is no location", () => {
      vi.stubGlobal("window", {});
      captureSearchResultSelected(args);
      expect(posthog.capture.mock.calls[0][1]).not.toHaveProperty("$current_url");
    });

    it("captures nothing when PostHog is not configured", () => {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
      captureSearchResultSelected(args);
      expect(posthog.capture).not.toHaveBeenCalled();
    });
  });

  describe("captureSearchNoResults", () => {
    it("captures the query and a search-aware $current_url", () => {
      captureSearchNoResults("notaspecies");
      expect(posthog.capture).toHaveBeenCalledWith(
        "search_no_results",
        expect.objectContaining({ query: "notaspecies" })
      );
      const props = posthog.capture.mock.calls[0][1];
      expect(new URL(props.$current_url).searchParams.get("search")).toBe("notaspecies");
    });

    it("captures nothing when PostHog is not configured", () => {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
      captureSearchNoResults("notaspecies");
      expect(posthog.capture).not.toHaveBeenCalled();
    });
  });
});
