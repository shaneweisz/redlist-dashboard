import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";

// Cache for assessment details (1 hour)
const assessmentCache = new Map<
  number,
  { data: object; timestamp: number }
>();
const CACHE_DURATION = 60 * 60 * 1000;

async function fetchWithAuth(url: string): Promise<Response> {
  const apiKey = process.env.RED_LIST_API_KEY;
  if (!apiKey) {
    throw new Error("RED_LIST_API_KEY environment variable not set");
  }
  return fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

// IUCN API v4 uses { en: "text" } for description fields
function getLocalizedText(
  desc: { en?: string } | string | null | undefined
): string | null {
  if (!desc) return null;
  if (typeof desc === "string") return desc;
  return desc.en || null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const assessmentId = parseInt(id, 10);

  if (isNaN(assessmentId)) {
    return NextResponse.json(
      { error: "Invalid assessment ID" },
      { status: 400 }
    );
  }

  // Check cache
  const cached = assessmentCache.get(assessmentId);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return NextResponse.json({ ...cached.data, cached: true }, { headers: CACHE_1H });
  }

  try {
    const response = await fetchWithAuth(
      `https://api.iucnredlist.org/api/v4/assessment/${assessmentId}`
    );

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json(
          { error: "Assessment not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: `IUCN API error: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    const doc = data.documentation || {};

    // Extract the fields we need, normalizing the IUCN API v4 structure
    const result = {
      assessment_id: data.assessment_id,
      sis_taxon_id: data.sis_taxon_id,
      url: data.url,
      // Category & criteria - normalize { code, description: { en } } to { code, description }
      red_list_category: data.red_list_category
        ? {
            code: data.red_list_category.code,
            description: getLocalizedText(data.red_list_category.description),
          }
        : null,
      criteria: data.criteria || null,
      assessment_date: data.assessment_date || null,
      year_published: data.year_published || null,
      possibly_extinct: data.possibly_extinct || false,
      possibly_extinct_in_the_wild: data.possibly_extinct_in_the_wild || false,
      // Narratives are under documentation.*
      rationale: doc.rationale || null,
      population: doc.population || null,
      habitat: doc.habitats || null,
      threats: doc.threats || null,
      /**
       * The assessment's bibliography, so the in-text citations in those
       * narratives can be resolved to what they cite. Passed through as the API
       * gives it (citation, author, year, title) — the matching is the reader's
       * side of the problem, in lib/mapping/nearby-citations.
       */
      references: Array.isArray(data.references)
        ? data.references.map((r: { citation?: string; author?: string; year?: string; title?: string }) => ({
            citation: r.citation ?? "",
            author: r.author ?? null,
            year: r.year ?? null,
            title: r.title ?? null,
          }))
        : [],
      conservation_actions: doc.measures || null,
      use_trade: doc.use_trade || null,
      range: doc.range || null,
      // Population trend - normalize { code, description: { en } }
      population_trend: data.population_trend
        ? {
            code: data.population_trend.code,
            description: getLocalizedText(data.population_trend.description),
          }
        : null,
      // Structured data: habitats array
      habitats: Array.isArray(data.habitats)
        ? data.habitats.map(
            (h: {
              code?: string;
              description?: { en?: string } | string;
              suitability?: string;
              majorImportance?: string;
              season?: string | null;
            }) => ({
              code: h.code || "",
              name: getLocalizedText(h.description) || h.code || "",
              suitability: h.suitability || null,
              major_importance: h.majorImportance === "Yes",
              season: h.season || null,
            })
          )
        : null,
      // Structured data: threats array
      // IUCN v4: threats have `title` (threat name) and `description` (classification level)
      threat_classification: Array.isArray(data.threats)
        ? data.threats.map(
            (t: {
              code?: string;
              title?: { en?: string } | string;
              description?: { en?: string } | string;
              timing?: string;
              scope?: string;
              severity?: string;
              score?: string;
              ias?: string;
              virus?: string;
              stresses?: { code?: string; description?: { en?: string } | string }[];
            }) => ({
              code: t.code || "",
              name:
                getLocalizedText(t.title) ||
                getLocalizedText(t.description) ||
                t.code ||
                "",
              timing: t.timing || null,
              scope: t.scope || null,
              severity: t.severity || null,
              score: t.score || null,
              // The species or pathogen named on an invasive-species threat —
              // "Hymenoscyphus fraxineus" on an ash. Only 8.1/8.2 carry one.
              named: t.ias || t.virus || null,
              stresses: Array.isArray(t.stresses)
                ? t.stresses
                    .map(
                      (s) => getLocalizedText(s.description) || s.code || ""
                    )
                    .filter(Boolean)
                : null,
            })
          )
        : null,
      // Structured data: conservation actions array
      // IUCN v4: conservation actions may use `title` or `description`
      conservation_actions_classification: Array.isArray(
        data.conservation_actions
      )
        ? data.conservation_actions.map(
            (c: {
              code?: string;
              title?: { en?: string } | string;
              description?: { en?: string } | string;
            }) => ({
              code: c.code || "",
              name:
                getLocalizedText(c.title) ||
                getLocalizedText(c.description) ||
                c.code ||
                "",
            })
          )
        : null,
      // Systems (terrestrial, marine, freshwater)
      systems: Array.isArray(data.systems)
        ? data.systems.map(
            (s: {
              code?: string;
              description?: { en?: string } | string;
            }) => ({
              code: s.code || "",
              description: getLocalizedText(s.description) || s.code || "",
            })
          )
        : null,
      // Scopes
      scopes: Array.isArray(data.scopes)
        ? data.scopes.map(
            (s: {
              code?: string;
              description?: { en?: string } | string;
            }) => ({
              code: s.code || "",
              description: getLocalizedText(s.description) || s.code || "",
            })
          )
        : null,
      /**
       * The assessment's parameters (EOO, AOO, population size, generation
       * length, ...), as the API gives them: flat strings keyed by name. The
       * in-place conservation actions it also carries are lifted out below.
       */
      supplementary_info: data.supplementary_info
        ? Object.fromEntries(
            Object.entries(data.supplementary_info as Record<string, unknown>).filter(
              ([k, v]) => k !== "conservation_actions_in_place" && v != null && v !== "" && typeof v !== "object"
            )
          )
        : null,
      /** "In-place research and monitoring": [{ name, value }], as on the website. */
      conservation_in_place: Array.isArray(data.supplementary_info?.conservation_actions_in_place)
        ? data.supplementary_info.conservation_actions_in_place.map(
            (g: { name?: string; actions?: { name?: string; value?: string }[] }) => ({
              name: g.name ?? "",
              actions: (g.actions ?? []).map((a) => ({ name: a.name ?? "", value: a.value ?? "" })),
            })
          )
        : null,
      research_needed: Array.isArray(data.researches)
        ? data.researches.map((r: { code?: string; description?: { en?: string } | string }) => ({
            code: r.code || "",
            name: getLocalizedText(r.description) || r.code || "",
          }))
        : null,
      use_trade_classification: Array.isArray(data.use_and_trade)
        ? data.use_and_trade.map(
            (u: {
              code?: string;
              description?: { en?: string } | string;
              subsistence?: boolean | null;
              national?: boolean | null;
              international?: boolean | null;
              other?: boolean | null;
            }) => ({
              code: u.code || "",
              name: getLocalizedText(u.description) || u.code || "",
              subsistence: u.subsistence ?? null,
              national: u.national ?? null,
              international: u.international ?? null,
            })
          )
        : null,
      /** Countries and other areas, with how the species occurs there. */
      locations: Array.isArray(data.locations)
        ? data.locations.map(
            (l: {
              code?: string;
              description?: { en?: string } | string;
              presence?: string;
              origin?: string;
              seasonality?: string[] | string | null;
            }) => ({
              code: l.code || "",
              name: getLocalizedText(l.description) || l.code || "",
              presence: l.presence || null,
              origin: l.origin || null,
              seasonality: Array.isArray(l.seasonality) ? l.seasonality.join(", ") || null : l.seasonality || null,
            })
          )
        : null,
      realms: Array.isArray(data.biogeographical_realms)
        ? data.biogeographical_realms
            .map((r: { description?: { en?: string } | string }) => getLocalizedText(r.description))
            .filter(Boolean)
        : null,
      trend_justification: doc.trend_justification || null,
      /** The taxon as the Red List files it: lineage, names, notes, SSC group. */
      taxonomy: data.taxon
        ? {
            kingdom: data.taxon.kingdom_name ?? null,
            phylum: data.taxon.phylum_name ?? null,
            class: data.taxon.class_name ?? null,
            order: data.taxon.order_name ?? null,
            family: data.taxon.family_name ?? null,
            genus: data.taxon.genus_name ?? null,
            scientific_name: data.taxon.scientific_name ?? null,
            authority: data.taxon.authority ?? null,
            common_names: Array.isArray(data.taxon.common_names)
              ? data.taxon.common_names.map((c: { name?: string; language?: string; main?: boolean }) => ({
                  name: c.name ?? "",
                  language: c.language ?? null,
                  main: !!c.main,
                }))
              : [],
            synonyms: Array.isArray(data.taxon.synonyms)
              ? data.taxon.synonyms.map((x: { name?: string }) => x.name ?? "").filter(Boolean)
              : [],
            notes: doc.taxonomic_notes || null,
            ssc_groups: Array.isArray(data.taxon.ssc_groups)
              ? data.taxon.ssc_groups.map((g: { name?: string; url?: string }) => ({
                  name: g.name ?? "",
                  url: g.url ?? null,
                }))
              : [],
          }
        : null,
    };

    // Cache the result
    assessmentCache.set(assessmentId, {
      data: result,
      timestamp: Date.now(),
    });

    return NextResponse.json(result, { headers: CACHE_1H });
  } catch (error) {
    console.error("Error fetching assessment:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
