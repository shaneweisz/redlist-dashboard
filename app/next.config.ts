import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

// Runtime deps every DuckDB-backed route needs traced in: the dlopen'd
// libduckdb.so (file-tracing misses dlopen deps), the sync pointer used to build
// the R2 path, and the vendored httpfs extension (LOAD'd by path).
const DUCKDB_TRACE = [
  "./node_modules/@duckdb/node-bindings-linux-x64/**",
  "./latest-sync.txt",
  "./duckdb-ext/**",
];

// The CoL backbone artifacts (#271) are read ONLY from R2 via httpfs at runtime —
// no serverless function bundles them. But fetch-data-from-r2 pulls the whole
// sync into app/data/ at build time, so any function that traces data/ would bundle
// backbone.parquet (~170MB) and blow Vercel's 250MB function cap. Exclude them from
// the species-store routes (the DuckDB routes already exclude all of data/).
const COL_ARTIFACTS = [
  "**/data/backbone.parquet",
  "**/data/species/**",
  "**/data/species_link.parquet",
  "**/data/synonym-index.parquet",
];

const nextConfig: NextConfig = {
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
  // PostHog's API relies on trailing slashes; without this Next.js redirects them
  // and breaks event capture through the proxy.
  skipTrailingSlashRedirect: true,

  // Server Actions (e.g. the GitHub sign-in form in /login) reject any request
  // whose Origin header doesn't match the request's own host, as CSRF
  // protection — by default only the exact same origin is trusted. This app is
  // served on multiple custom domains (see src/config/brand.ts), and two of them
  // (red.cst.cam.ac.uk and en.ki) reach Vercel through a Caddy reverse proxy on
  // a Cambridge VM that rewrites Host to red-list-dashboard.vercel.app, so the
  // Origin the browser sends never matches the Host Next.js sees and sign-in
  // 500s without an explicit entry — list every domain this app answers on,
  // plus a wildcard for Vercel's own preview deployments (both URL shapes: the
  // stable git-branch alias and the per-deployment hash that changes on every
  // push). Keep in step with src/config/public-origin.ts.
  experimental: {
    serverActions: {
      allowedOrigins: [
        "dashforlife.org",
        "dashoflife.org",
        "red-list-dashboard.vercel.app",
        "red.cst.cam.ac.uk",
        "en.ki",
        "*-shaneweiszs-projects.vercel.app",
      ],
    },
  },

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
    "/api/search": DUCKDB_TRACE,
    "/api/search/warm": DUCKDB_TRACE,
    "/api/taxa/species": DUCKDB_TRACE,
    "/api/redlist/synonyms": DUCKDB_TRACE,
    // /browse runs querySpecies/searchSpecies (DuckDB over R2) at request time.
    "/browse": DUCKDB_TRACE,
    // /api/mcp runs the same query layer for the MCP tools.
    "/api/mcp": DUCKDB_TRACE,
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
    // "What else is assessed near here" joins a GBIF radius facet against
    // assessed.parquet in R2 (getAssessedByGbifKeys) — the same DuckDB-over-R2
    // query as every route above, so it needs the dlopen'd .so and the sync
    // pointer too.
    "/api/nearby-species": DUCKDB_TRACE,
    // Live no-match diagnostic breakdown for dynamic taxonomic-drilldown nodes
    // (live-breakdown.ts) — queries assessed/species_link/species/backbone
    // parquets in R2 via the same DuckDB connection, needs the same trace.
    "/api/redlist/taxa-breakdown-live": DUCKDB_TRACE,
    // Live CoL-taxon-id lookup for a dynamic node's ancestor chain
    // (live-breakdown.ts's getLiveColTaxonIds) — same backbone.parquet-via-R2
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

  // The API routes import a shared species-store module that references every
  // file under data/ (search-index.json ~95MB, redlist/ ~82MB, gbif/ ~62MB),
  // so Next traces the whole dataset into every serverless function — ~248MB,
  // over Vercel's 250MB uncompressed limit. Prune per route to what each
  // actually reads at runtime. Globs use **/ so they match whether the tracing
  // root is app/ (local) or the repo root (Vercel, where paths are app/data/…).
  // NOTE: search-index.json is now legacy (no code reads it; live search queries
  // Parquet over R2) and is excluded from new syncs (upload-data-to-r2.ts). The
  // search-index.json entries below are retained only because the active sync still
  // ships the file into data/ at build time; drop them once a sync without it reaches
  // production.
  outputFileTracingExcludes: {
    // Search now queries the parquets in R2 (httpfs) — no local data bundled.
    "/api/search": ["**/data/**"],
    "/api/search/warm": ["**/data/**"],
    // Species list queries the parquets in R2 (httpfs); it also reads the small
    // taxa-summary.json for the instant tooLarge check, so exclude the heavy data but
    // keep that one file. CRITICAL: keep ALL parquets out — USE_R2 is gated on
    // assessed.parquet NOT existing locally, so bundling any parquet flips the route to
    // local mode and the R2-only files (species_link) then 404.
    "/api/redlist/species": ["**/data/search-index.json", "**/data/redlist/**", "**/data/gbif/**", "**/data/mapping.csv", "**/data/table1a-children-summaries.json", "**/data/ssc-group-children-summaries.json", "**/data/*.parquet", ...COL_ARTIFACTS],
    "/api/redlist/species/history": ["**/data/**"],
    // Queries backbone.parquet + species_link in R2 (httpfs) — no local data.
    "/api/redlist/synonyms": ["**/data/**"],
    // Reads the Red List / GBIF CSVs (+ mapping) but never the search index or
    // the R2-only CoL artifacts. These keys are ROUTE PATHS, so renaming a route
    // silently drops its pruning and the function balloons to the whole dataset:
    // this one was /api/redlist/{assessor,reviewer}-candidates-by-country before
    // the three credit lines merged behind one endpoint, and the rename alone took
    // the function from ~80MB to 494MB — over Vercel's 250MB cap — with no local
    // signal, since app/data/ is only fully populated at build time on Vercel.
    // It reads exactly two things — data/redlist/<group>.csv and
    // data/redlist/history/<group>.json (loadRedlistForGroup +
    // loadHistoryForGroup) — and never opens a parquet or touches DuckDB, so
    // everything else in data/ was dead weight. It had been pruned only of the
    // search index and the CoL artifacts, which left it ~236MB: close enough to
    // the 250MB cap that adding two credit fields to the history files (+23MB)
    // tipped it to 258.86MB and failed the deploy. Pruning to what it actually
    // opens drops it well clear, so the next sync's growth has somewhere to go.
    "/api/redlist/credit-candidates": [
      "**/data/search-index.json",
      "**/data/*.parquet",
      "**/data/gbif/**",
      "**/data/overlays/**",
      "**/data/mapping.csv",
      ...COL_ARTIFACTS,
    ],
    // Read the small precomputed summary JSONs by default, or query
    // assessed.parquet in R2 (httpfs) when ?country= is set — same CRITICAL
    // note as /api/redlist/species: keep ALL parquets out, since USE_R2 is
    // gated on assessed.parquet NOT existing locally.
    "/api/redlist/taxa-summary": ["**/data/search-index.json", "**/data/redlist/**", "**/data/gbif/**", "**/data/mapping.csv", "**/data/*.parquet", ...COL_ARTIFACTS],
    "/api/redlist/taxa-subgroups": ["**/data/search-index.json", "**/data/redlist/**", "**/data/gbif/**", "**/data/mapping.csv", "**/data/*.parquet", ...COL_ARTIFACTS],
    // Reads only the small precomputed country-stats.json (no DuckDB — this is
    // a static aggregate, not a live query, see species-store.ts's getCountryStats).
    "/api/redlist/country-stats": ["**/data/search-index.json", "**/data/redlist/**", "**/data/gbif/**", "**/data/mapping.csv", "**/data/table1a-children-summaries.json", "**/data/ssc-group-children-summaries.json", "**/data/*.parquet", ...COL_ARTIFACTS],
    // Backbone tree navigation queries backbone.parquet in R2 (httpfs) — no local data.
    "/api/taxa/species": ["**/data/**"],
    // Reads assessed/species_link/species/backbone entirely from R2 (httpfs) — no
    // local data, same as /api/redlist/synonyms and /api/taxa/species above.
    "/api/redlist/taxa-breakdown-live": ["**/data/**"],
    // Reads only backbone.parquet, entirely from R2 (httpfs) — no local data,
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
    // /browse mirrors /api/redlist/species (same querySpecies): keep taxa-summary.json
    // for the instant NE tooLarge check, drop the heavy data + ALL parquets (the USE_R2
    // gate keys on assessed.parquet being absent locally). /llms.txt reads no data.
    "/browse": ["**/data/search-index.json", "**/data/redlist/**", "**/data/gbif/**", "**/data/mapping.csv", "**/data/table1a-children-summaries.json", "**/data/ssc-group-children-summaries.json", "**/data/*.parquet", ...COL_ARTIFACTS],
    "/api/mcp": ["**/data/search-index.json", "**/data/redlist/**", "**/data/gbif/**", "**/data/mapping.csv", "**/data/table1a-children-summaries.json", "**/data/ssc-group-children-summaries.json", "**/data/*.parquet", ...COL_ARTIFACTS],
    "/llms.txt": ["**/data/**"],
    // Same shape as /api/redlist/species/history: one DuckDB query answered
    // entirely from R2 (httpfs), so nothing under data/ belongs in the bundle.
    // Without this the shared species-store import drags the whole sync —
    // backbone.parquet alone is ~170MB — into the page's function and the
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
