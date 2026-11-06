"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { FaGlobeAmericas } from "react-icons/fa";
import { SpeciesSearchBar } from "../components/SpeciesSearchBar";
import { ThemeToggle } from "../components/ThemeToggle";
import { AuthStatus } from "../components/AuthStatus";
import { useBrand } from "../components/BrandProvider";
import { parseParams, type ViewMode } from "../hooks/useFilterParams";
import { prettifyQs } from "../lib/query-string";
import { buildGeneralIssueUrl } from "../lib/github-issue";
import { SpeciesCacheProvider } from "../contexts/SpeciesCacheContext";

// Dynamically import view component
const RedListView = dynamic(
  () => import("../components/redlist/RedListView"),
  {
    loading: () => (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="animate-spin h-10 w-10 border-4 border-zinc-400 border-t-transparent rounded-full" />
        <p className="mt-4 text-zinc-500 dark:text-zinc-400">
          Loading view...
        </p>
      </div>
    ),
  }
);

export default function RedListPage() {
  const brand = useBrand();
  const [viewMode, setViewMode] = useState<ViewMode>("reassessments");

  // Hydrate viewMode from URL on mount + sync on popstate (back/forward)
  useEffect(() => {
    const syncFromUrl = () => {
      const parsed = parseParams(window.location.search);
      setViewMode(parsed.viewMode);
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  // Shared taxa/subgroup state that persists across view switches
  const [sharedTaxa, setSharedTaxa] = useState<Set<string>>(new Set());
  const [sharedSubgroups, setSharedSubgroups] = useState<Set<string>>(new Set());

  // View-mode switch. RedListView renders the control itself (the wide
  // Reassessments / First Assessments toggle above its filter charts) and
  // calls back here.
  const handleViewModeChange = (mode: ViewMode) => {
    if (viewMode === mode) return;
    setViewMode(mode);
    // Preserve the current taxa/subgroup/layout selection (and any other
    // URL-only filters) across the switch — only the `view` param changes.
    const params = new URLSearchParams(window.location.search);
    if (mode === "reassessments") params.delete("view");
    else params.set("view", "new-assessments");
    // Re-serializing the whole query here would re-encode the taxa token's `~`/`:`
    // that buildQs deliberately leaves bare, so the toggle briefly pushes an uglier
    // URL than the one it replaced. Same treatment keeps it stable.
    const qs = prettifyQs(params.toString());
    window.history.pushState(null, "", qs ? `/?${qs}` : "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="flex flex-col bg-zinc-50 dark:bg-zinc-950">
      {/* This inner region is pinned to min-h-screen (not just min-h-screen on
          the outer wrapper) so that when page content is short — e.g. Country
          View's map-only landing state — it's forced to fill exactly one
          viewport, with flex-1 letting the tallest child (the map, in that
          case) absorb the slack. Only the "Questions, feedback, or feature
          requests" line lives
          inside it as the footer; everything after that (the source-credits
          paragraph, the privacy policy link) is a separate sibling below,
          OUTSIDE this min-h-screen box, so it always starts exactly at the
          one-viewport mark and needs a scroll to reach — flex-grow alone
          can't produce that, since it only redistributes slack that already
          exists within a fixed-height box, it can never make that box taller
          than the viewport. Tall pages (e.g. a long species table) aren't
          affected: min-height (not height) lets the box grow past 100vh to
          fit real content, exactly as before. */}
      <div className="min-h-screen flex flex-col px-4 sm:px-6 pt-4 md:px-16 md:pt-8">
        <main className="max-w-5xl w-full min-w-0 mx-auto flex-1 flex flex-col min-h-0">
          {/* Header: two aligned rows (title | controls, subtitle | search).
              Globe sits inline with the title so the subtitle, controls and
              search bar share the same flush-left edge as the table below.
              Title and controls (theme toggle, sign-in) share a row even on
              mobile — only subtitle and search drop to their own full-width
              rows below that on narrow screens. */}
          <div className="mb-[0.9rem] md:mb-[1.35rem]">
            <div className="min-w-0 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:gap-y-3 [grid-template-areas:'title_controls'_'subtitle_subtitle'_'search_search'] sm:[grid-template-areas:'title_controls'_'subtitle_search']">
              <button
                type="button"
                onClick={() => {
                  // "Go home": drop every filter/selection AND reset back to the
                  // default Assessed view (dropping any First Assessments choice),
                  // but keep the layout (Standard/Table 1a/SSC/Country) choice —
                  // same fields clearAllFiltersAndTaxa preserves minus `view`,
                  // replicated here via raw URL params since this click lives
                  // outside RedListView's useFilterParams instance. Falls back to
                  // `origin` when `layout` itself is absent — a taxon drill-down
                  // out of Country View clears `layout` but leaves
                  // `origin=country` behind (see useFilterParams.ts's
                  // originLayout), so Home still lands back on that view instead
                  // of the generic default.
                  const params = new URLSearchParams(window.location.search);
                  const kept = new URLSearchParams();
                  const layout = params.get("layout") || params.get("origin");
                  if (layout) kept.set("layout", layout);
                  const qs = kept.toString();
                  window.history.pushState(null, "", qs ? `/?${qs}` : "/");
                  window.dispatchEvent(new PopStateEvent("popstate"));
                }}
                className="[grid-area:title] flex items-center gap-2 min-w-0 text-left cursor-pointer hover:opacity-80 transition-opacity"
                title="Back to home"
              >
                {brand.showGlobe && (
                  <FaGlobeAmericas className="shrink-0 text-2xl sm:text-3xl md:text-[2rem] text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                )}
                <h1 className="text-2xl sm:text-3xl md:text-[2rem] font-bold text-zinc-900 dark:text-zinc-100 truncate">{brand.title}</h1>
              </button>
              {brand.subtitle && (
                <p className="[grid-area:subtitle] text-[15px] md:text-[1.375rem] text-zinc-500 dark:text-zinc-400">{brand.subtitle}</p>
              )}
              <div className="[grid-area:controls] flex items-center gap-2 justify-end sm:justify-self-end">
                <ThemeToggle />
                <AuthStatus />
              </div>
              <div className="[grid-area:search] sm:justify-self-end">
                <SpeciesSearchBar />
              </div>
            </div>
          </div>

          {/* Content — single component instance stays mounted on viewMode switch */}
          <SpeciesCacheProvider>
            <RedListView
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              sharedTaxa={sharedTaxa}
              sharedSubgroups={sharedSubgroups}
              onTaxaChange={setSharedTaxa}
              onSubgroupsChange={setSharedSubgroups}
            />
          </SpeciesCacheProvider>
        </main>

        <footer className="max-w-xl mx-auto w-full shrink-0 mt-2 pb-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">
            Questions, feedback, or feature requests? Contact{" "}
            <a
              href="https://www.shaneweisz.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              Shane
            </a>
            {" "}at{" "}
            <a
              href="mailto:sw984@cam.ac.uk"
              className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              sw984@cam.ac.uk
            </a>
            . Or better yet,{" "}
            {/* href carries the plain draft so this is a real link — middle-click,
                "copy link address" and a JS-less load all still work. The click
                handler re-builds it with the URL the reader is actually on, which
                can't go in the href itself: this component server-renders, and a
                href that differs between server and client is a hydration
                mismatch. Reading location at click time also means it reflects
                the current filters rather than whatever was in the bar at mount. */}
            <a
              href={buildGeneralIssueUrl()}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                window.open(
                  buildGeneralIssueUrl({ pageUrl: window.location.href }),
                  "_blank",
                  "noopener,noreferrer"
                );
              }}
              className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              create a GitHub Issue
            </a>
            . I&apos;ll take a look as soon as I can.
          </p>
        </footer>
      </div>
      {/* Continuation of the footer (source credits, privacy policy) — a
          plain sibling below the min-h-screen box above, not part of its
          flex distribution, so it always starts exactly at the one-viewport
          mark and only comes into view on scroll when that box is short. */}
      <div className="max-w-xl mx-auto w-full px-4 sm:px-6 md:px-16 pb-4 md:pb-8">
        <p className="text-center text-xs text-zinc-400 dark:text-zinc-500 mt-3">
          This dashboard is part of a{" "}
          <a
            href="https://anil.recoil.org/ideas/living-iucn-redlist"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            PhD research project
          </a>
          {" "}at the University of Cambridge. The data is sourced from{" "}
          <a
            href="https://www.iucnredlist.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            IUCN Red List
          </a>
          {" "}(version 2026-1),{" "}
          <a
            href="https://www.gbif.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            GBIF
          </a>
          ,{" "}
          <a
            href="https://www.inaturalist.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            iNaturalist
          </a>
          ,{" "}
          <a
            href="https://openalex.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            OpenAlex
          </a>
          ,{" "}
          <a
            href="https://cites.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            CITES
          </a>
          ,{" "}
          <a
            href="https://speciesplus.net"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            Species+
          </a>
          , and{" "}
          <a
            href="https://www.catalogueoflife.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            Catalogue of Life
          </a>
          {" "}data. This is a free, non-commercial research tool; commercial users should obtain IUCN Red List data via{" "}
          <a
            href="https://www.ibat-alliance.org/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            IBAT
          </a>
          . Any errors in aggregation or presentation are my own. Please verify against the primary sources before use, and do get in touch if you notice any issues.
        </p>
        <p className="text-center text-xs text-zinc-400 dark:text-zinc-500 mt-4">
          <Link
            href="/privacy"
            className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            Privacy policy
          </Link>
        </p>
      </div>
    </div>
  );
}
