/**
 * Remote MCP server for the Red List dashboard — structured tool access to the same
 * data the /browse endpoint exposes, for agents (Claude Code, claude.ai connectors,
 * ChatGPT). MCP tool calls bypass the two walls that break direct fetching from an
 * agent sandbox: they're not subject to web_fetch's verbatim-URL allowlist, and they
 * originate off the sandbox (no egress allowlist). Tools call runBrowseQuery directly
 * — the same logic /browse uses, so results are identical.
 *
 * Served at /api/mcp (streamable HTTP). mcp-handler 2 serves whatever route it's
 * mounted at rather than matching the pathname, so this static `api/mcp` route is all
 * that's needed — no dynamic `[transport]` segment (its brackets are a glob char-class
 * that breaks the next.config tracing keys, bundling all of data/ and blowing the
 * function-size cap).
 *
 * Unauthenticated — the same read-only data is already public via /browse, so a token
 * would guard nothing it doesn't, while blocking claude.ai web connectors (which speak
 * OAuth, not static bearers). If abuse becomes a concern, rate-limit instead.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { runBrowseQuery, type BrowseInput } from "@/lib/browse-query";
import { browseInputToDashboardUrl } from "@/lib/dashboard-url";
import { SHARED_FILTER_SCHEMA } from "@/lib/shared-filters";
import { buildVocabulary } from "@/lib/browse-help";

export const maxDuration = 60;

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

// Per-request origin (e.g. https://host), captured from the incoming request so
// the dashboard links we emit point at THIS deployment — same approach as the
// /browse and /llms.txt routes.
const originStore = new AsyncLocalStorage<string>();
const getOrigin = () => originStore.getStore() ?? "";

// Standing instruction attached to every queryable result: the deterministic
// dashboard link plus a nudge to surface it and have the user verify. We compute
// it server-side (not via tool-prompt) so it can't be skipped by the agent.
const VERIFY_NOTE =
  "Always show `dashboard_url` to the user and encourage them to open it to inspect and verify the data themselves. It is the interactive dashboard pre-filtered to this exact query, so it reproduces the same species set you see here.";

// Wrap a queryable result with the dashboard link + verify nudge for `input`.
const withDashboard = (input: BrowseInput, data: object) =>
  asText({ ...data, dashboard_url: browseInputToDashboardUrl(getOrigin(), input), verify_note: VERIFY_NOTE });

// Optional-filter schema for browse_taxon. The categorical filters
// (categories, threats, systems, trends, movement, growthForms,
// endemic) come from the shared-filter registry — the single source of truth
// shared with the dashboard URL, the predicate, and the dashboard-link builder,
// so they can't drift. The fields here are the bespoke ones.
const FILTERS = {
  ...SHARED_FILTER_SCHEMA,
  countries: z.array(z.string()).optional().describe("ISO alpha-2 codes or country names."),
  region: z.string().optional().describe("An IUCN region (expands to its countries), e.g. 'Sub-Saharan Africa'."),
  assessors: z.array(z.string()).optional().describe("Latest-assessment assessor name (substring match)."),
  reviewers: z.array(z.string()).optional().describe("Latest-assessment reviewer name (substring match)."),
  facilitators: z.array(z.string()).optional().describe("Latest-assessment facilitator name (substring match). The individual who ran the assessment when the credited assessor is an organisation — e.g. every bird assessment is assessed by 'BirdLife International', and only the facilitator names a person."),
  contributors: z.array(z.string()).optional().describe("Latest-assessment contributor name (substring match). Credited for supplying data or expertise without being assessor or reviewer — workshop participants, data providers."),
  institutions: z.array(z.string()).optional().describe("Latest-assessment institution (substring match). The organisation behind the assessment, e.g. 'BirdLife International', 'Royal Botanic Gardens, Kew', 'Botanic Gardens Conservation International', 'NatureServe'."),
  outdated: z.enum(["yes", "no"]).optional().describe("Assessment older than 10 years."),
  minObs: z.number().optional(), maxObs: z.number().optional(),
  minAssessmentYear: z.number().optional(), maxAssessmentYear: z.number().optional(),
  minDescribedYear: z.number().optional(), maxDescribedYear: z.number().optional(),
};

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "browse_taxon",
      {
        title: "Browse a taxon",
        description:
          "List/aggregate IUCN Red List species under a taxon, with GBIF + Catalogue of Life data. `taxa` works at ANY rank: a curated group (birds, corals), a sub-group (sharks-rays, flatworms), or a scientific class/order/family/genus name (felidae, odonata, panthera). Returns total + by-category breakdown + an `outdated`/`stats` block (use it for percentage questions like '% of mammals needing updating') + a capped species list. Combine optional filters (AND across filters; OR within a list).",
        inputSchema: z.object({ taxa: z.string().describe("A taxonomic group, sub-group, or scientific name (any rank)."), ...FILTERS }),
      },
      async (args) => {
        const { taxa, region, ...rest } = args as { taxa: string; region?: string } & Record<string, unknown>;
        const input: BrowseInput = { ...(rest as BrowseInput), taxa: [taxa], region: region ? [region] : [] };
        return withDashboard(input, await runBrowseQuery(input));
      },
    );

    server.registerTool(
      "find_species",
      {
        title: "Look up a species by name",
        description: "Find a species by scientific or common name, including synonyms / old names (they resolve to the accepted species). Returns the matching species with IUCN category, GBIF/CoL info, and (if matched via an old name) the matched synonym.",
        inputSchema: z.object({ name: z.string().describe("Scientific or common name, e.g. 'tiger' or 'Felis jubata'.") }),
      },
      async (args) => {
        const { name } = args as { name: string };
        return withDashboard({ search: name }, await runBrowseQuery({ search: name }));
      },
    );

    server.registerTool(
      "get_vocabulary",
      {
        title: "Get the valid filter vocabulary",
        description: "Returns the valid values for browse_taxon: featured taxon groups, IUCN threat categories, status categories, IUCN regions, systems, population trends, movement patterns, growth forms, and the endemic flag. Call this first if unsure what values to pass.",
        // An explicit empty object, not an omitted schema: without one the SDK
        // passes the request context as the callback's first argument.
        inputSchema: z.object({}),
      },
      async () => asText(buildVocabulary()),
    );
  },
);

// Run the MCP handler inside the origin context so tool callbacks can build
// absolute dashboard links from this request's host.
const withOrigin = (h: (req: Request) => Promise<Response> | Response) => (req: Request) => {
  let origin = "";
  try { origin = new URL(req.url).origin; } catch { /* leave empty → relative link */ }
  return originStore.run(origin, () => h(req));
};

const GET = withOrigin(handler);
const POST = withOrigin(handler);
const DELETE = withOrigin(handler);

export { GET, POST, DELETE };
