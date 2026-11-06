/**
 * /browse — server-rendered, agent- and human-readable view of the dashboard's
 * data. The SPA is client-rendered (empty HTML to a crawler), so this returns real
 * content for a pasted URL. Query logic lives in @/lib/browse-query (shared with the
 * /api/mcp tools, so both surfaces return identical results).
 *
 * Two modes: browse a taxon (?taxa=<name>[&filters], any rank) or look up a species
 * (?search=<name>, synonym-aware). Add ?format=json for agentic clients. Unlisted
 * (noindex) — see below.
 */
import { NextRequest, NextResponse } from "next/server";
import { runBrowseQuery, type BrowseInput, type BrowseResult, type BrowseSpecies } from "@/lib/browse-query";
import { browseInputToDashboardUrl } from "@/lib/dashboard-url";
import { readSharedInput } from "@/lib/shared-filters";
import { buildVocabulary, type Vocabulary } from "@/lib/browse-help";
import { CATEGORY_ORDER } from "@/config/taxa";
import { CACHE_1H } from "@/lib/cache-headers";
import { categoryLabel } from "@/lib/filter-vocab";

export const revalidate = 3600;

const BASE = "/browse";
// Unlisted, not gated: agents fetch it fine when given the URL, but crawlers don't
// index it (and there are no inbound links to it from the app).
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow" };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseList(sp: URLSearchParams, key: string): string[] {
  return (sp.getAll(key).join(",") || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── route ───────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const format = sp.get("format");

  const intParam = (k: string): number | undefined => {
    const v = sp.get(k);
    if (v == null) return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  const outdatedRaw = sp.get("outdated");
  const input: BrowseInput = {
    // Categorical filters (categories…endemic) are read from the URL by the
    // shared registry, so /browse parses every registry filter automatically.
    ...readSharedInput(sp),
    taxa: parseList(sp, "taxa"),
    search: (sp.get("search") ?? "").trim(),
    countries: parseList(sp, "countries"),
    region: parseList(sp, "region"),
    outdated: outdatedRaw === "yes" ? "yes" : outdatedRaw === "no" ? "no" : null,
    assessors: parseList(sp, "assessors"),
    reviewers: parseList(sp, "reviewers"),
    facilitators: parseList(sp, "facilitators"),
    contributors: parseList(sp, "contributors"),
    institutions: parseList(sp, "institutions"),
    minObs: intParam("minObs"), maxObs: intParam("maxObs"),
    records: sp.get("records") === "georeferenced" ? "georeferenced" : undefined,
    minAssessmentYear: intParam("minAssessmentYear"), maxAssessmentYear: intParam("maxAssessmentYear"),
    minDescribedYear: intParam("minDescribedYear"), maxDescribedYear: intParam("maxDescribedYear"),
  };

  let result: BrowseResult;
  try {
    result = await runBrowseQuery(input);
  } catch {
    // Fail loudly: a query error/timeout (e.g. cold DuckDB container still warming)
    // returns 503 with a clear message — never a 200 with unrelated data.
    const msg = "The data service failed or timed out (it may be warming up on a cold start). Please retry shortly — this is a real failure, not a result.";
    return format === "json"
      ? NextResponse.json({ error: msg, retryable: true }, { status: 503, headers: { ...NOINDEX } })
      : new NextResponse(`<!doctype html><meta charset="utf-8"><title>Temporarily unavailable</title><h1>Temporarily unavailable</h1><p>${msg}</p>`,
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", ...NOINDEX } });
  }

  // No taxon/search resolved. Distinguish a bare request (legit "what can I do here?"
  // → 200 self-describing index) from an attempted query (params sent, nothing
  // resolved → loud 400, so a client can't mistake the help page for a result or
  // auto-follow one of its example links as the answer).
  if (result.noSelector) {
    const attempted = [...sp.keys()].some((k) => k !== "format");
    if (attempted) {
      const msg = "No taxon or search term resolved from this query. Provide ?taxa=<group, sub-group, or scientific name> or ?search=<species name>. See /llms.txt for the vocabulary.";
      return format === "json"
        ? NextResponse.json({ error: msg, unresolved: result.unresolved, vocabulary: "/llms.txt" }, { status: 400, headers: { ...NOINDEX } })
        : new NextResponse(`<!doctype html><meta charset="utf-8"><title>No valid query</title><h1>No valid query</h1><p>${msg}</p>`,
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", ...NOINDEX } });
    }
    return format === "json"
      ? NextResponse.json(indexData(result.unresolved), { headers: { ...CACHE_1H, ...NOINDEX } })
      : html(indexHtml(result.unresolved));
  }

  if (format === "json") {
    return NextResponse.json(
      {
        query: req.nextUrl.search,
        interpreted: result.interpreted,
        unresolved: result.unresolved,
        too_large: result.tooLarge,
        total: result.total,
        shown: result.shown,
        capped: result.capped,
        breakdown: result.breakdown,
        stats: result.stats,
        species: result.species,
        // The interactive dashboard, pre-filtered to this same query — share it so
        // a human can inspect and verify these results for themselves.
        dashboard_url: browseInputToDashboardUrl(req.nextUrl.origin, input),
      },
      { headers: { ...CACHE_1H, ...NOINDEX } },
    );
  }
  return html(resultsHtml(result, input.records ?? "all"));
}

// ─── rendering ─────────────────────────────────────────────────────────────

function html(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/html; charset=utf-8", ...CACHE_1H, ...NOINDEX } });
}

const PAGE_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Red List Dashboard — Browse</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid #ddd;padding:.35rem .55rem;text-align:left;font-size:.9rem;vertical-align:top}
th{background:#f5f5f5}
code{background:#f0f0f0;padding:0 .25rem;border-radius:3px}
.summary{font-size:1.05rem}
.warn{color:#a33;background:#fee;padding:.5rem .75rem;border-radius:4px}
a{color:#0b6}
footer{margin-top:2rem;font-size:.85rem;color:#666}
</style></head><body>`;
const PAGE_FOOT = `<footer>Data: IUCN Red List + GBIF + Catalogue of Life. See <a href="/llms.txt">/llms.txt</a> for the full query vocabulary. Results are capped; this view is for browsing, not bulk download.</footer></body></html>`;

function unresolvedBlock(unresolved: string[]): string {
  if (!unresolved.length) return "";
  return `<p class="warn">Couldn't interpret: ${unresolved.map((u) => `<code>${esc(u)}</code>`).join(", ")}. See <a href="/llms.txt">/llms.txt</a> for valid values.</p>`;
}

function resultsHtml(r: BrowseResult, records: "all" | "georeferenced"): string {
  const filterDesc = r.interpreted.length ? esc(r.interpreted.join("; ")) : "no filters";
  const breakdownStr = Object.entries(r.breakdown)
    .sort((x, y) => (CATEGORY_ORDER[x[0]] ?? 99) - (CATEGORY_ORDER[y[0]] ?? 99))
    .map(([c, n]) => `${esc(categoryLabel(c))}: ${n}`)
    .join(" · ");

  let summary: string;
  if (r.tooLarge && r.total === 0) {
    summary = `<p class="summary">That group is too large to list at once — ${filterDesc}.</p>
      <p>Open a narrower sub-group (e.g. a class, order, family, or genus). See <a href="/llms.txt">/llms.txt</a>.</p>`;
  } else if (r.total === 0) {
    summary = `<p class="summary"><strong>No species match</strong> — ${filterDesc}.</p>
      <p>Try removing a filter, or see <a href="/llms.txt">/llms.txt</a> for valid values.</p>`;
  } else {
    summary = `<p class="summary"><strong>${r.total.toLocaleString()}</strong> species match — ${filterDesc}.${r.total > r.shown ? ` Showing the first ${r.shown}.` : ""}</p>`;
    if (breakdownStr) summary += `<p>By category: ${breakdownStr}</p>`;
    if (r.stats.assessed > 0 && r.stats.outdated_pct != null) {
      summary += `<p>Assessments needing updating (>10 yrs old): <strong>${r.stats.outdated.toLocaleString()}</strong> of ${r.stats.assessed.toLocaleString()} (<strong>${r.stats.outdated_pct}%</strong>).</p>`;
    }
  }

  const rows = r.species
    .map((s: BrowseSpecies) => {
      const name = s.matched_synonym
        ? `<em>${esc(s.scientific_name)}</em> <span style="color:#888">(syn. ${esc(s.matched_synonym)})</span>`
        : `<em>${esc(s.scientific_name)}</em>`;
      const threats = [...new Set(s.threats.map((t) => t.label))].map(esc).join(", ");
      const year = s.assessment_date ? esc(s.assessment_date.slice(0, 4)) : "—";
      const n = records === "all" ? s.gbif_all_records_count : s.gbif_georeferenced_records_count;
      const obs = n != null ? n.toLocaleString() : "—";
      return `<tr><td>${name}</td><td>${esc(s.common_name ?? "")}</td><td>${esc(s.category_label)}</td><td>${year}</td><td>${obs}</td><td>${threats}</td></tr>`;
    })
    .join("");
  const table = r.species.length
    ? `<table><thead><tr><th>Scientific name</th><th>Common name</th><th>IUCN category</th><th>Assessed</th><th>${records === "all" ? "GBIF records" : "GBIF georeferenced records"}</th><th>Threats</th></tr></thead><tbody>${rows}</tbody></table>`
    : "";

  return `${PAGE_HEAD}<h1>Red List — filtered species</h1>${unresolvedBlock(r.unresolved)}${summary}${table}${PAGE_FOOT}`;
}

const EXAMPLES: { url: string; desc: string }[] = [
  { url: `${BASE}?taxa=corals&threats=climate-change`, desc: "Coral species threatened by climate change" },
  { url: `${BASE}?taxa=mammals`, desc: "All mammals — read stats.outdated_pct for % of assessments needing updating" },
  { url: `${BASE}?taxa=felidae&categories=threatened`, desc: "Threatened cats (arbitrary rank: a family name)" },
  { url: `${BASE}?taxa=panthera`, desc: "Big cats of the genus Panthera (arbitrary rank: a genus name)" },
  { url: `${BASE}?taxa=amphibians&region=Sub-Saharan+Africa&categories=threatened`, desc: "Threatened amphibians in Sub-Saharan Africa (IUCN region)" },
  { url: `${BASE}?search=tiger`, desc: "Look up a species by name" },
];

function indexData(unresolved: string[]) {
  return { ...buildVocabulary(), unresolved, examples: EXAMPLES };
}

/** Render one filter's enumerable values for the HTML help (coded vocab → `code` label). */
function vocabValuesHtml(v: Vocabulary["filters"][number]): string {
  const vals = v.values
    .map((x) => (typeof x === "string" ? `<code>${esc(x)}</code>` : `<code>${esc(x.code)}</code> ${esc(x.label)}`))
    .join(", ");
  return `<strong>${esc(v.key)}</strong>: ${vals}${v.note ? ` — ${esc(v.note)}` : ""}`;
}

function indexHtml(unresolved: string[]): string {
  const vocab = buildVocabulary();
  const taxaList = vocab.taxa.map((t) => `<code>${esc(t.id)}</code> (${esc(t.label)})`).join(", ");
  const filterLines = vocab.filters.map((v) => `<p>${vocabValuesHtml(v)}</p>`).join("\n");
  const paramLines = Object.entries(vocab.params)
    .map(([k, desc]) => `<strong>${esc(k)}</strong>: ${esc(desc)}`)
    .join(" ");
  const examples = EXAMPLES.map((e) => `<li><a href="${esc(e.url)}">${esc(e.url)}</a> — ${esc(e.desc)}</li>`).join("");

  return `${PAGE_HEAD}<h1>Red List Dashboard — Browse</h1>
${unresolvedBlock(unresolved)}
<p>Answer questions about IUCN Red List species (with GBIF + Catalogue of Life data) from a single URL. Two ways in:</p>
<ul>
<li><strong>Browse a taxon</strong>: <code>?taxa=&lt;name&gt;</code> + optional filters. <code>taxa</code> works at <em>any rank</em> — a group (<code>birds</code>, <code>corals</code>), a sub-group (<code>sharks-rays</code>, <code>flatworms</code>), or a scientific name down to genus (<code>felidae</code>, <code>odonata</code>, <code>panthera</code>).</li>
<li><strong>Look up a species</strong>: <code>?search=&lt;name&gt;</code> — scientific or common name, including <em>synonyms / old names</em>.</li>
</ul>
<p>Values can be codes <em>or</em> plain-English names. Add <code>&amp;format=json</code> for JSON. Within one filter, comma-separated values are OR; across filters they are AND.</p>
<h2>Filters (combine with <code>taxa</code>)</h2>
<p><strong>taxa</strong>: ${taxaList} — ${esc(vocab.taxaNote)}</p>
${filterLines}
<p><strong>region</strong> (IUCN): ${vocab.region.map((r) => `<code>${esc(r)}</code>`).join(", ")}.</p>
<p>${paramLines}</p>
<p>Every response leads with a total, a by-category breakdown, and a needs-updating count + % (<code>stats.outdated</code> / <code>stats.outdated_pct</code>), so percentage questions are answered in one request.</p>
<h2>Examples</h2><ul>${examples}</ul>
${PAGE_FOOT}`;
}
