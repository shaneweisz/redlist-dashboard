import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";

// Runtime deps every DuckDB-backed route needs traced in: the dlopen'd
// libduckdb.so (file-tracing misses dlopen deps), the sync pointer used to build
// the R2 path, and the vendored httpfs extension (LOAD'd by path).
const DUCKDB_TRACE = [
  "./node_modules/@duckdb/node-bindings-linux-x64/**",
  "./latest-sync.txt",
  "./duckdb-ext/**",
];

// What a route that reads only the sync's small JSON summaries leaves out of its
// bundle: every sync parquet (read from R2 over httpfs; and bundling one flips
// USE_R2 off, since species-duckdb keys it on assessed.parquet NOT existing
// locally), the species/ partitions, the narratives and the map overlays.
// taxa.parquet alone is ~130MB against Vercel's 250MB function cap.
const ONLY_SUMMARIES = ["**/data/sync/**/*.parquet", "**/data/sync/lists/species/**", "**/data/sync/sync.log", "**/data/narratives/**", "**/data/overlays/**"];
// …and, for routes that never open them, the two children summaries (~2.5MB).
const ONLY_SMALL_SUMMARIES = [...ONLY_SUMMARIES,
  "**/data/sync/summaries/table1a-children-summaries.json", "**/data/sync/summaries/ssc-group-children-summaries.json"];

// The sync the pre-built files belong to (public/prebuilt/<sync>/,
// written by scripts/build/build-species-lists.ts). Baked into the client bundle so a page
// asks for exactly the files its own deployment was built with.
const SPECIES_LISTS_SYNC = fs.readFileSync(path.join(process.cwd(), "latest-sync.txt"), "utf-8").trim();

// The releases the data comes from, for the footer's source credits: read from
// the sync's own record (data/sync/sync.json, fetched with the rest of the sync
// in prebuild), so the footer always names the data this deployment serves.
function dataVersions(): string {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "sync", "sync.json"), "utf-8"));
    return JSON.stringify({ redlist: s.redlist?.database, gbifSnapshot: s.gbif?.snapshot, col: s.col?.xr?.alias });
  } catch {
    return "{}";
  }
}

const nextConfig: NextConfig = {
  // CI's typecheck job checks the types on every PR,
  // so the deploy build doesn't check them again (24 of its 41 seconds).
  typescript: { ignoreBuildErrors: true },
  env: {
    NEXT_PUBLIC_SPECIES_LISTS_SYNC: SPECIES_LISTS_SYNC,
    NEXT_PUBLIC_DATA_VERSIONS: dataVersions(),
  },
  // The species-list files are stored brotli-compressed. Without these headers Vercel
  // serves them as application/octet-stream and compresses the already-compressed
  // bytes again, so the browser gets brotli bytes instead of JSON (verified on a
  // preview). The path carries the sync timestamp, so a year's immutable cache is safe.
  async headers() {
    return [
      {
        // Everything the build pre-builds: species lists, search shards, tree
        // (public/prebuilt/<sync>/, written by scripts/build/).
        source: "/prebuilt/:path*.json.br",
        headers: [
          { key: "Content-Encoding", value: "br" },
          { key: "Content-Type", value: "application/json" },
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
  // Don't have `next dev` write app/AGENTS.md (its "read the bundled docs"
  // block for AI agents) — kept out of the repo deliberately.
  agentRules: false,
  // Proxy PostHog through our own origin so ad/tracking blockers (which match the
  // posthog.com domain directly) can't drop analytics for the academic audience.
  // /static + /array hit the asset host (it keeps cache-control headers the main
  // API strips); the catch-all must come last. EU cloud destinations.
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://eu-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
    ];
  },
  // /near-me became /mapping when it took on the species map's overlays — the
  // same map as /mapping/<species key>, with no species in the address. Permanent,
  // so a link someone saved or sent keeps working and search engines move with
  // it; the query string (a shared search's ?lat=&lng=&r=) is carried across.
  async redirects() {
    return [
      // dashforlife.org is the one canonical domain; every other host the
      // production deployment answers on sends visitors there, path and query
      // string intact. red.cst.cam.ac.uk and en.ki never appear here by name:
      // the Caddy proxy in front of them rewrites Host to
      // red-list-dashboard.vercel.app (the issue behind #416), so
      // matching that host catches them too. With every request now on
      // dashforlife.org (or a preview / localhost, which talk to Vercel
      // directly), the app can trust its own Host header again. Next anchors `has` values as a
      // full-string regex. Preview deployments use other hostnames and are
      // untouched.
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value:
              "(?:www\\.)?dashoflife\\.org|www\\.dashforlife\\.org|red-list-dashboard\\.vercel\\.app",
          },
        ],
        destination: "https://dashforlife.org/:path*",
        permanent: true,
      },
      { source: "/near-me", destination: "/mapping", permanent: true },
      // Comparison Mode (two dashboards side by side) was removed; a saved link
      // opens the dashboard, its first panel's taxa=/filters carried across.
      { source: "/compare", destination: "/", permanent: true },
    ];
  },
  // PostHog's API relies on trailing slashes; without this Next.js redirects them
  // and breaks event capture through the proxy.
  skipTrailingSlashRedirect: true,

  // #261: DuckDB-backed read routes query Parquet in R2. Keep the native addon
  // out of the bundler, and force-include the 68MB libduckdb.so it dlopens at
  // runtime (file-tracing misses dlopen deps). Scoped to the v2 routes so the
  // .so isn't bundled into every function. Vercel runs linux-x64.
  serverExternalPackages: ["@duckdb/node-api"],
  outputFileTracingIncludes: {
    // libduckdb.so (dlopen'd) + the version pointer used to build the R2 path +
    // the vendored httpfs extension (LOAD'd by path, avoiding a cold-start INSTALL).
    // Applies to every DuckDB-backed route: species list + history + search.
    "/api/redlist/species": DUCKDB_TRACE,
    "/api/redlist/species/history": DUCKDB_TRACE,
    "/api/literature-link": DUCKDB_TRACE,
    "/api/search": DUCKDB_TRACE,
    "/api/search/warm": DUCKDB_TRACE,
    "/api/taxa/species": DUCKDB_TRACE,
    "/api/redlist/synonyms": DUCKDB_TRACE,
    // The standalone mapping page resolves its species server-side with the
    // same DuckDB-over-R2 query (getSpeciesByGbifKey), so it needs the addon's
    // dlopen'd .so and the sync pointer like every route above. Written with a
    // wildcard because these keys are globs: "[key]" would be read as a
    // character class matching /mapping/m, /mapping/a, /mapping/p… —
    // and silently match nothing real. Every other entry here is bracket-free,
    // so this is the first route where it bites.
    "/mapping/*": DUCKDB_TRACE,
    // ?country= on these two routes queries assessed.parquet live via DuckDB
    // (country-taxa-summary-duckdb.ts) — same native addon as every route above,
    // so it needs the same trace. Without this the addon's dlopen'd libduckdb.so
    // is missing on Vercel and importing the module throws at load time, failing
    // EVERY request to the route (even a plain landing-page load with no
    // ?country=, since the throw happens before GET() ever runs).
    "/api/redlist/taxa-summary": DUCKDB_TRACE,
    "/api/redlist/taxa-subgroups": DUCKDB_TRACE,
    // Reads assessed.parquet + assessments.parquet over R2 (getCreditSource).
    "/api/redlist/credit-candidates": DUCKDB_TRACE,
    // "What else is assessed near here" joins a GBIF radius facet against
    // assessed.parquet in R2 (getAssessedByGbifKeys) — the same DuckDB-over-R2
    // query as every route above, so it needs the dlopen'd .so and the sync
    // pointer too.
    "/api/nearby-species": DUCKDB_TRACE,
    // Free-text search across assessment narratives — reads the narrative
    // index, word list and prose from R2 over the same DuckDB connection
    // (the [assessmentId] route expands one result), so both need
    // the dlopen'd .so and the sync pointer like every route above.
    "/api/narrative-search": DUCKDB_TRACE,
    "/api/narrative-search/[assessmentId]": DUCKDB_TRACE,
    // Live no-match diagnostic breakdown for dynamic taxonomic-drilldown nodes
    // (live-breakdown.ts) — queries assessed/assessment_link/species/taxa
    // parquets in R2 via the same DuckDB connection, needs the same trace.
    "/api/redlist/taxa-breakdown-live": DUCKDB_TRACE,
    // Live CoL-taxon-id lookup for a dynamic node's ancestor chain
    // (live-breakdown.ts's getLiveColTaxonIds) — same taxa.parquet-via-R2
    // DuckDB query as taxa-breakdown-live above, needs the same trace.
    "/api/redlist/col-taxon-ids-live": DUCKDB_TRACE,
    // Queries the committed (not R2) wcvp-native-countries.parquet directly via
    // DuckDB read_parquet() — a raw file path, not a JS import, so Next's tracer
    // needs telling explicitly (same class of miss as the dlopen'd libduckdb.so).
    "/api/wcvp-native-range": [
      "./node_modules/@duckdb/node-bindings-linux-x64/**",
      "./src/lib/native-range-refdata/wcvp-native-countries.parquet",
    ],
  },

  // The API routes import a shared species-store module that references the
  // sync's files under data/, so Next would trace the whole sync into every
  // serverless function, past Vercel's 250MB uncompressed limit. Prune per route
  // to what each actually reads at runtime. Globs use **/ so they match whether
  // the tracing root is app/ (local) or the repo root (Vercel, app/data/…).
  outputFileTracingExcludes: {
    // Search now queries the parquets in R2 (httpfs) — no local data bundled.
    "/api/search": ["**/data/**"],
    "/api/search/warm": ["**/data/**"],
    // Species list queries the parquets in R2 (httpfs); it also reads the small
    // taxa-summary.json for the instant tooLarge check.
    "/api/redlist/species": ONLY_SMALL_SUMMARIES,
    "/api/redlist/species/history": ["**/data/**"],
    // Reads literature-works.parquet in R2 (httpfs) — no local data.
    "/api/literature-link": ["**/data/**"],
    // Queries taxa.parquet + assessment_link in R2 (httpfs) — no local data.
    "/api/redlist/synonyms": ["**/data/**"],
    // These keys are ROUTE PATHS, so renaming a route silently drops its pruning
    // and the function balloons to the whole dataset (the credit lines' merge
    // behind one endpoint once took this one from ~80MB to 494MB).
    // Reads its rows over R2 since the sync rewrite; it bundles no data at all.
    "/api/redlist/credit-candidates": ["**/data/**"],
    // Read the small precomputed summary JSONs by default, or query
    // assessed.parquet in R2 (httpfs) when ?country= is set — same CRITICAL
    // note as /api/redlist/species: keep ALL parquets out, since USE_R2 is
    // gated on assessed.parquet NOT existing locally.
    "/api/redlist/taxa-summary": ONLY_SUMMARIES,
    "/api/redlist/taxa-subgroups": ONLY_SUMMARIES,
    // Reads only the small precomputed country-stats.json (no DuckDB — this is
    // a static aggregate, not a live query, see species-store.ts's getCountryStats).
    "/api/redlist/country-stats": ONLY_SMALL_SUMMARIES,
    // Backbone tree navigation queries taxa.parquet in R2 (httpfs) — no local data.
    "/api/taxa/species": ["**/data/**"],
    // Reads assessed/assessment_link/species/taxa entirely from R2 (httpfs) — no
    // local data, same as /api/redlist/synonyms and /api/taxa/species above.
    "/api/redlist/taxa-breakdown-live": ["**/data/**"],
    // Reads only taxa.parquet, entirely from R2 (httpfs) — no local data,
    // same as taxa-breakdown-live above (without this, Next traces the whole
    // dataset into the function via the shared live-breakdown.ts import,
    // blowing well past Vercel's 250MB uncompressed function-size limit).
    "/api/redlist/col-taxon-ids-live": ["**/data/**"],
    // Reads assessed.parquet entirely from R2 (httpfs) and otherwise talks only
    // to GBIF, so nothing under data/ belongs in the bundle. Without this the
    // shared species-duckdb import traced the whole sync in and the function
    // came out at 627MB — 2.5x Vercel's cap. It reaches filter-vocab (for the
    // threat labels), which can read data/vernacular-names.json, but only lazily
    // from taxonLabel() and behind a try/catch that degrades to the curated
    // names; threatDisplay() reads a static const and never opens the file.
    "/api/nearby-species": ["**/data/**"],
    // Same bargain: every byte it reads comes from R2, and the narrative
    // parquets are 170 MB between them — bundling either would put the function
    // straight past Vercel's cap, and flip USE_R2 off into the bargain.
    "/api/narrative-search": ["**/data/**"],
    "/api/narrative-search/[assessmentId]": ["**/data/**"],
    // Same shape as /api/redlist/species/history: one DuckDB query answered
    // entirely from R2 (httpfs), so nothing under data/ belongs in the bundle.
    // Without this the shared species-store import drags the whole sync —
    // taxa.parquet alone is ~130MB — into the page's function and the
    // deployment fails the 250MB uncompressed limit. It builds fine locally,
    // where no such limit applies, so the only symptom is a failed deploy.
    // Wildcard, not "[key]" — see the note on the include above.
    "/mapping/*": ["**/data/**"],
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "shane-weisz",

  project: "redlist-dashboard",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  }
});
