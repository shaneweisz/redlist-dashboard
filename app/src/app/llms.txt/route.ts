/**
 * /llms.txt — a short, machine-readable guide so an agent can answer questions
 * from the dashboard via /browse. The categorical filters are generated from the
 * shared-filter registry (the same source /browse + get_vocabulary use), so this
 * can't advertise a different filter set. The base URL is taken from the request
 * origin, so pasted example links always point at this same deployment.
 */

import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";
import { FEATURED_TAXA, taxonLabel } from "@/lib/filter-vocab";
import { SHARED_FILTER_VOCAB, type FilterVocab } from "@/lib/shared-filters";
import { IUCN_REGION_ORDER } from "@/lib/regions";

export const revalidate = 3600;

/** Render one registry filter as an llms.txt parameter block. Coded vocab
 *  (categories, threats) becomes a header + one line per code; the rest a
 *  one-liner of values and/or a note — so every registry filter is listed. */
function paramBlock(v: FilterVocab): string {
  const coded = v.values.length > 0 && typeof v.values[0] !== "string";
  if (coded) {
    const lines = (v.values as { code: string; label: string }[])
      .map((x) => `  - ${x.code} = ${x.label}`).join("\n");
    return `${v.key}${v.note ? ` (${v.note})` : ""}:\n${lines}`;
  }
  const vals = (v.values as string[]).join(", ");
  return `${v.key}: ${vals}${v.note ? ` (${v.note})` : ""}`;
}

export function GET(req: NextRequest) {
  const base = new URL(req.url).origin;
  const taxa = FEATURED_TAXA.map((id) => `  - ${id} (${taxonLabel(id)})`).join("\n");
  const filters = SHARED_FILTER_VOCAB.map(paramBlock).join("\n");

  const body = `# Red List Dashboard

> IUCN Red List assessments linked to GBIF occurrences and the Catalogue of Life
> tree of life. The main site is a browser app (empty HTML to a fetcher). To read
> data or answer questions, use /browse below — it returns server-rendered HTML,
> or JSON with &format=json.

## Two ways to query

1. Browse a taxon:   ${base}/browse?taxa=<name>[&filters]
2. Look up a species: ${base}/browse?search=<name>

\`taxa\` works at ANY taxonomic rank — a curated group (birds, corals), a
sub-group (sharks-rays, flatworms), or a scientific name for a class/order/family/genus
(felidae, odonata, carnivora, panthera). \`search\` matches scientific OR common names,
including synonyms / old names (they resolve to the accepted species).

## Rules
- Browsing needs one \`taxa\` value; looking up a species needs \`search\`.
- **Prefer \`&format=json\`** — it's the machine-readable response; the HTML view is
  for humans. The JSON always includes the query you sent (\`query\`) and an
  \`interpreted\` list, so you can confirm the result matches your request.
- The first request after a quiet period may take a few seconds (cold start). If a
  request times out, retry once. A genuine failure returns a **non-200 status with an
  \`error\` field — never another species' data**, so trust the status code.
- Within one filter, comma-separated values are OR; across filters they are AND.
- Threats match by prefix: threats=11 covers 11.1, 11.4, ... ("Climate change").
- Results cap at 200 rows; the total + a by-category breakdown are always shown.
- Every response has a "stats" object (assessed / outdated / outdated_pct, the %
  of assessments older than 10 years) — use it for percentage questions directly.
- Every response includes a "dashboard_url" — the interactive dashboard pre-filtered
  to this same query. Show it to the user and encourage them to open it to inspect
  and verify the data themselves.

## Parameters (values may be codes OR plain-English names)

taxa — any rank; featured groups:
${taxa}

${filters}
countries: ISO alpha-2 code or name (e.g. IN or India)
region (IUCN region — expands to its countries): ${IUCN_REGION_ORDER.join(", ")}
assessors / reviewers: name of the latest-assessment assessor/reviewer (substring, e.g. assessors=Smith)
facilitators: name of the latest-assessment facilitator (substring, e.g. facilitators=Rutherford) — the person who ran
  the assessment where the credited assessor is an organisation. Bird assessments are all assessed by "BirdLife
  International", so facilitators is the only way to find the individual who worked on one.
contributors: name of a latest-assessment contributor (substring, e.g. contributors=Hines) — credited for data or
  expertise without being assessor or reviewer.
institutions: latest-assessment institution (substring, e.g. institutions=Kew) — the organisation behind the
  assessment, e.g. BirdLife International, Botanic Gardens Conservation International, NatureServe.
search:  scientific or common name (incl. synonyms)
outdated: yes | no  (assessment more than 10 years old)
minObs / maxObs: GBIF record-count bounds (all records, or georeferenced ones with records=georeferenced)
records: georeferenced = count only records with coordinates and no geospatial issue, of wild record types (default: all records)
minAssessmentYear / maxAssessmentYear: assessment-year bounds
minDescribedYear / maxDescribedYear: year-described bounds (NE species)

## Examples
- ${base}/browse?taxa=corals&threats=climate-change
    Coral species threatened by climate change
- ${base}/browse?taxa=mammals
    All mammals — read stats.outdated_pct for % of assessments needing updating
- ${base}/browse?taxa=felidae&categories=threatened
    Threatened cats (arbitrary rank: a family name)
- ${base}/browse?taxa=amphibians&region=Sub-Saharan+Africa&categories=threatened
    Threatened amphibians in a region (IUCN region expands to its countries)
- ${base}/browse?search=tiger
    Look up a species by name
- ${base}/browse?search=Felis+jubata
    Look up by an old name — resolves to the accepted species (Acinonyx jubatus)
`;

  return new NextResponse(body, {
    // Unlisted: keep it out of crawler indexes; it's meant to be fetched only when
    // a user points an agent at this URL, not auto-discovered.
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_1H, "X-Robots-Tag": "noindex, nofollow" },
  });
}
